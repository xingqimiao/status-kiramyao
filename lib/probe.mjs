/**
 * Probing: the local checks, the boce adapter, and the data-guardian reads.
 *
 * Everything network-facing lives here, and it is all written to fail softly. A
 * status page whose own probe loop throws is a status page that stops updating, and
 * the failure would be invisible — which is the exact class of bug this service
 * exists to catch in other people's services.
 */

/**
 * One HTTP probe.
 *
 * A `HEAD` would be cheaper, but these endpoints are the ones a user's request
 * actually hits and some of them only answer `GET`; probing a different verb than
 * the traffic uses would measure something nobody does. A 4-second ceiling because
 * a status probe that hangs is worse than one that fails: it stalls the whole round
 * and turns one slow target into a page-wide gap.
 */
export async function probeUrl(url, { timeoutMs = 4_000, fetchImpl = fetch } = {}) {
  const started = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      // Identify honestly. A probe that pretends to be a browser defeats the point
      // of measuring what a browser would actually get.
      headers: { 'User-Agent': 'KiraStatus/1.0 (+https://status.kiramyao.com)' },
    })
    return {
      ok: res.status >= 200 && res.status < 400,
      statusCode: res.status,
      latencyMs: Date.now() - started,
      error: res.status >= 400 ? `HTTP ${res.status}` : null,
    }
  } catch (error) {
    return {
      ok: false,
      statusCode: null,
      latencyMs: Date.now() - started,
      // `AbortError` has a useless message; name it for what it is.
      error: error.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : (error.message || String(error)),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Run every local probe once, and record the results.
 *
 * Sequential rather than parallel on purpose. Four requests to two hosts is not
 * worth concurrency, and running them one at a time keeps the latency numbers
 * meaningful — in parallel they contend for the same socket pool and each reports
 * a little slower than it is.
 *
 * One timestamp for the whole round, so the day boundaries the aggregate builds on
 * are exact rather than smeared across however long the round took.
 */
export async function runLocalProbes(store, targets, { now = Date.now(), fetchImpl = fetch } = {}) {
  const results = []
  for (const [component, url] of Object.entries(targets)) {
    const outcome = await probeUrl(url, { fetchImpl })
    store.addProbe({ source: 'local', component, at: now, ...outcome })
    results.push({ component, ...outcome })
  }
  return results
}

// --- boce (mainland-China reachability) --------------------------------------

/**
 * A representative spread of mainland nodes across the three carriers.
 *
 * These ids come from boce's public node appendix. `auto` resolves to this list;
 * an operator can override with explicit ids in `BOCE_NODES`. Thirty nodes is the
 * settled budget — the cost is per node, so this constant *is* the monthly bill,
 * and it is named so that changing one's mind about the budget is a one-line edit
 * with the number visible.
 */
export const BOCE_AUTO_NODES = [
  // 电信 (Telecom) — ids from the appendix, spread across regions.
  6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  // 联通 (Unicom)
  31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
  // 移动 (Mobile)
  51, 52, 53, 54, 55, 56, 57, 58, 59, 60,
]

/** Resolve the configured node spec to a list of ids. */
export function resolveNodes(spec) {
  const raw = String(spec ?? 'auto').trim()
  if (raw === '' || raw.toLowerCase() === 'auto') return [...BOCE_AUTO_NODES]
  const ids = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
  return ids.length > 0 ? ids : [...BOCE_AUTO_NODES]
}

/**
 * Run one CN sample through boce, and record one probe per node.
 *
 * The two-call protocol (create, then poll until `done`) is what the calibration
 * call confirmed — see `deploy/BOCE.md`, which also records the three things the
 * docs do not say and a from-the-docs adapter gets wrong. The one that bites here:
 * **`error_code` is the verdict, not `http_code` and not the text of
 * `report_source`.** A healthy run came back with a `report_source` that began with
 * a node-local complaint about its CA bundle.
 *
 * Returns a summary rather than throwing. A boce failure must degrade to "CN sample
 * unavailable" and never to a green reading, which the aggregate enforces — so this
 * function's job is only to record what happened.
 */
export async function runBoceProbe(store, boceConfig, { now = Date.now(), fetchImpl = fetch, sleep = defaultSleep } = {}) {
  if (!boceConfig.enabled || !boceConfig.apiKey) {
    return { ran: false, reason: 'disabled' }
  }

  const nodes = resolveNodes(boceConfig.nodes)
  const createUrl = `${boceConfig.apiUrl}/task/create/curl`
    + `?key=${encodeURIComponent(boceConfig.apiKey)}`
    + `&node_ids=${encodeURIComponent(nodes.join(','))}`
    + `&host=${encodeURIComponent(boceConfig.targetUrl)}`

  let taskId
  try {
    const res = await fetchImpl(createUrl)
    const body = await res.json()
    if (body.error_code !== 0 || !body.data?.id) {
      return { ran: false, reason: `create failed: ${body.error || body.error_code}` }
    }
    taskId = body.data.id
  } catch (error) {
    return { ran: false, reason: `create threw: ${error.message || error}` }
  }

  const deadline = Date.now() + boceConfig.pollTimeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`${boceConfig.apiUrl}/task/curl/${encodeURIComponent(taskId)}?key=${encodeURIComponent(boceConfig.apiKey)}`)
      const body = await res.json()
      if (body.done) {
        const rows = Array.isArray(body.list) ? body.list : []
        if (rows.length === 0) return { ran: false, reason: 'task completed with no rows' }
        return { ran: true, taskId, ...recordBoceRows(store, rows, now) }
      }
    } catch (error) {
      return { ran: false, reason: `poll threw: ${error.message || error}` }
    }
    await sleep(boceConfig.pollIntervalMs)
  }
  return { ran: false, reason: `timed out after ${boceConfig.pollTimeoutMs}ms` }
}

/**
 * Turn boce's per-node rows into probes.
 *
 * One probe row per node rather than one aggregate row, because the interesting
 * signal is *which* nodes failed: "2 of 30 nodes in China cannot reach this site"
 * is a different statement from "China cannot reach this site", and only the
 * per-node rows can tell them apart.
 *
 * An offline node (`error` containing `not found node`) is **skipped rather than
 * recorded as a failure** — boce does not bill for it and it says nothing about our
 * site. Recording it would invent an outage out of a node's maintenance window.
 */
export function recordBoceRows(store, rows, now) {
  let ok = 0, failed = 0, skipped = 0
  const regions = new Set()

  for (const row of rows) {
    const error = String(row.error ?? '')
    if (error.includes('not found node')) {
      skipped++
      continue
    }
    // `error_code` is boce's verdict. See the note above on why this is not
    // `http_code` and not a scan of `report_source`.
    const nodeOk = Number(row.error_code ?? 1) === 0
    if (nodeOk) ok++
    else failed++
    if (row.ip_region) regions.add(row.ip_region)

    store.addProbe({
      source: 'boce',
      component: 'site_cn',
      at: now,
      ok: nodeOk,
      statusCode: Number.isFinite(Number(row.http_code)) ? Number(row.http_code) : null,
      latencyMs: Number.isFinite(Number(row.time_total)) ? Number(row.time_total) * 1000 : null,
      error: nodeOk ? null : (error || `node error ${row.error_code}`),
      region: row.ip_region ?? null,
    })
  }

  return { ok, failed, skipped, nodes: rows.length, regions: [...regions] }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- data-guardian metrics ---------------------------------------------------

/**
 * Read the HRT Core's public aggregate.
 *
 * Read defensively and never throw: the status page must render even when the
 * service it is reporting on is down — that is precisely the moment it is being
 * looked at. A field that is absent becomes `null` and the page shows "—", which is
 * honest; defaulting to 0 would claim the service holds no records.
 */
export async function readHrtStats(url, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.json()
    if (body?.ok !== true) return { ok: false, error: 'unexpected body' }
    return {
      ok: true,
      accounts: body.users?.total ?? null,
      records: (body.records?.doses ?? 0) + (body.records?.labs ?? 0),
      selfDeletions: body.deletions?.self ?? null,
    }
  } catch (error) {
    return { ok: false, error: error.message || String(error) }
  }
}

/** Read the comment service's counts. Same defensive contract as above. */
export async function readCommentsStats(url, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.json()
    return { ok: true, users: body.users ?? null, comments: body.comments ?? null }
  } catch (error) {
    return { ok: false, error: error.message || String(error) }
  }
}

/**
 * Count the published stories.
 *
 * The site publishes a machine-readable catalogue, so this is a count over plain
 * HTTP rather than a walk of 125 Markdown files. Degrades to `null` if the shape
 * changes — the handoff calls that out explicitly, and a wrong number here would be
 * a quiet lie about preservation.
 */
export async function readStoryCount(url, { fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(url)
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.json()
    const resources = Array.isArray(body?.resources)
      ? body.resources
      : Array.isArray(body)
        ? body
        : null
    if (!resources) return { ok: false, error: 'no resources array in the catalogue' }
    const stories = resources.filter((r) => r?.kind === 'stories').length
    // A catalogue that parses but lists no stories at all is a shape change, not a
    // site that deleted everything: refuse to report zero.
    if (stories === 0) return { ok: false, error: 'catalogue parsed but lists no stories' }
    return { ok: true, stories }
  } catch (error) {
    return { ok: false, error: error.message || String(error) }
  }
}
