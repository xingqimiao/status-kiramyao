/**
 * Probing: the local checks, the boce adapter, and the data-guardian reads.
 *
 * Everything network-facing lives here, and it is all written to fail softly. A
 * status page whose own probe loop throws is a status page that stops updating, and
 * the failure would be invisible — which is the exact class of bug this service
 * exists to catch in other people's services.
 */

/**
 * How our own probes identify themselves, and the string the analytics filter excludes.
 *
 * One constant for both. The filter has to match this byte for byte, and two copies
 * would drift the first time the version number changed — quietly, with the visits
 * creeping back up by ~29 a day.
 */
export const CF_PROBE_USER_AGENT = 'KiraStatus/1.0 (+https://status.kiramyao.com)'

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
      headers: { 'User-Agent': CF_PROBE_USER_AGENT },
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

/**
 * The milliseconds until the next occurrence of `hourOfDay` local time.
 *
 * A wall-clock target rather than an interval, and the difference is the whole point.
 * The CN sample used to run on `setInterval(boceRound, 24h)` from whenever the process
 * booted, protected by a boot-time skip guard. Together those had a hole big enough to
 * lose a day: a restart at 06:12 found the newest sample 656 minutes old, which sailed
 * under the guard's 720-minute ceiling, so the round was skipped — and the fresh
 * 24-hour timer then did not fire until 06:12 the next morning. Nothing sampled the
 * site for ~35 hours and the CN row read grey, which a reader takes for an outage,
 * because a skipped round writes no row to say otherwise.
 *
 * Anchoring to a time of day makes the schedule independent of process lifetime, which
 * is what an operator asking for "每天0点跑一次" means: a restart can neither move it
 * nor skip it, and the budget is protected by the caller's same-day check rather than
 * by a heuristic about staleness.
 *
 * `now` is a `Date` in local time, which is what `setHours` reads.
 */
export function nextBoceDelayMs(hourOfDay, now = new Date()) {
  const next = new Date(now)
  next.setHours(hourOfDay, 0, 0, 0)
  // Past today's hour, or exactly on it — aim at tomorrow. Returning 0 here would fire
  // immediately and, on a process that restarted just after midnight, could buy a second
  // round for the same day.
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

// --- boce (mainland-China reachability) --------------------------------------

/**
 * A representative spread of mainland nodes across the three carriers.
 *
 * These ids are **verified against the live API**, not copied from documentation.
 * The first list here was not: boce retires nodes, and a retired id makes the whole
 * create call answer `{"error_code":1,"error":"no task to do"}`. Sixteen of the
 * thirty ids in that list were dead, so asking for 30 nodes silently billed for 14 —
 * the budget constant said 30 while the probe cost and coverage were both lower.
 *
 * Re-verify by probing ids one at a time (a bad id carries the error per node, so a
 * single-node call is the honest test) — see `deploy/BOCE.md`.
 * `auto` resolves to this list; an operator can override with explicit ids in
 * `BOCE_NODES`. Cost is per node, so this constant *is* the monthly bill, and it is
 * named so that changing one's mind about the budget is a one-line edit.
 */
export const BOCE_AUTO_NODES = [
  // 电信 (Telecom)
  6, 7, 8, 12, 13, 14, 19, 24, 30,
  // 联通 (Unicom)
  20, 25, 26, 31, 32, 36, 42, 48,
  // 移动 (Mobile)
  37, 38, 43, 49, 54, 55, 60,
  // The remaining verified ids, kept in reserve so the list stays at the settled
  // budget while covering all three carriers evenly.
  61, 62, 66, 67,
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

  // Two passes, because the summary a reader needs is a fact about the *round* — "2
  // of 28 nodes" — and it cannot be known while writing the first row. A per-row error
  // alone reads as though the site timed out for everyone, when it was one carrier in
  // one province.
  const billable = []
  for (const row of rows) {
    const error = String(row.error ?? '')
    if (error.includes('not found node')) {
      skipped++
      continue
    }
    // A node reached our site only if **both** hold:
    //
    //   * `error_code === 0` — boce's verdict on the task, and
    //   * `http_code > 0`    — an HTTP response actually came back.
    //
    // The calibration taught the first half and missed the second, because every node
    // in that run had answered. A node that cannot connect reports `http_code: 0`
    // while still leaving `error_code: 0` and `error: ""`, with the real reason only
    // inside `report_source` (`curl: (7) connection reset by peer`, `curl: (28)
    // operation timed out`, `Recv failure: Connection`). Reading `error_code` alone
    // therefore records an unreachable node as **green** — the one output this page
    // must never produce, precisely because the CN row exists to answer "can
    // mainland China reach us". Three of the first fourteen nodes did this.
    //
    // `report_source` is still not what decides pass/fail: the calibration found it
    // full of node-local noise (a CA-bundle complaint on a perfectly healthy 200). It
    // is read only to *describe* a row already judged failed, which cannot turn a
    // good reading bad.
    const errorCode = Number(row.error_code ?? 1)
    const httpCode = Number(row.http_code)
    const gotResponse = Number.isFinite(httpCode) && httpCode > 0
    const nodeOk = errorCode === 0 && gotResponse
    if (nodeOk) ok++
    else failed++
    if (row.ip_region) regions.add(row.ip_region)
    billable.push({ row, nodeOk, gotResponse, httpCode, error, errorCode })
  }

  const round = { ok, failed, total: billable.length }
  // The failing node names, so a reader can see whether it is one carrier in one
  // province or the whole country. Truncated: a total failure does not need 28 names.
  const failedNames = billable
    .filter((b) => !b.nodeOk)
    .map((b) => b.row.node_name ?? `#${b.row.node_id}`)
    .slice(0, 4)

  for (const { row, nodeOk, gotResponse, httpCode, error, errorCode } of billable) {
    store.addProbe({
      source: 'boce',
      component: 'site_cn',
      at: now,
      ok: nodeOk,
      statusCode: gotResponse ? httpCode : null,
      latencyMs: Number.isFinite(Number(row.time_total)) ? Number(row.time_total) * 1000 : null,
      // The round summary leads, because that is the question the row answers. The
      // node's own reason follows it rather than standing in for it.
      error: nodeOk ? null : roundSummary(round, failedNames, error, row, errorCode),
      region: row.ip_region ?? null,
    })
  }

  return { ok, failed, skipped, nodes: rows.length, regions: [...regions] }
}

/**
 * One failing node's `error` text: how many failed out of how many, who they were, and
 * why this one did.
 *
 * Ordered this way deliberately. "curl: (28) operation timed out" on its own is what
 * sent someone looking for a fault in our own service; the same fact prefixed with
 * "2 of 28 nodes" reads as what it is — two carriers in one province, not an outage.
 */
function roundSummary(round, failedNames, error, row, errorCode) {
  const who = failedNames.length > 0 ? `（${failedNames.join('、')}${round.failed > failedNames.length ? ' 等' : ''}）` : ''
  const head = `该轮 ${round.total} 个节点中 ${round.failed} 个无法连接${who}`
  const reason = error || curlReason(row) || `node error ${errorCode}`
  return `${head}：${reason}`.slice(0, 300)
}

/**
 * The reason a node could not reach the site, from its report.
 *
 * Only ever called for a row already judged failed, and only to make the stored
 * `error` say something a reader can act on. A node that cannot connect leaves `error`
 * empty, so without this the page would show a bare "unknown" for the most interesting
 * case there is — a carrier that can't reach the site.
 *
 * Deliberately shaped to *find* a reason, never to decide one: `report_source` carries
 * node-local noise on healthy responses too (see `NOISE_PATTERNS`).
 *
 * Two kinds of reason, checked in this order:
 *
 *  1. `curl: (28) operation timed out` — curl's own exit reason. This is the one that
 *     says *why*, so it wins.
 *  2. `curl: (28) Error reading ca cert file …` — curl exits 28 for this too, but it
 *     is mbedTLS failing to read the **node's own** CA bundle, which says nothing about
 *     our site. It fires intermittently on nodes that answer 200 seconds later, so
 *     presenting it as the reason for an outage is misleading: the reader concludes we
 *     have a certificate problem when the node could not read its own trust store.
 *     Reported as a connect/certificate failure on that node instead, which is what it
 *     is. The raw text stays in `report_source` and is never rewritten, so this only
 *     affects the one-line summary.
 */
function curlReason(row) {
  const report = String(row.report_source ?? '')
  const lines = report.match(/^\s*curl:\s*\(\d+\)[^\n]*/gm) ?? []

  for (const line of lines) {
    if (NOISE_PATTERNS.some((p) => p.test(line))) continue
    // Trim the multi-line noise curl can append after the reason.
    return line.replace(/\s+/g, ' ').trim().slice(0, 160)
  }

  if (lines.length > 0) {
    return '该节点无法读取自身的 CA 证书集，未能完成连接检查'
  }
  return null
}

/**
 * `curl:` lines that are about the probe node's environment rather than our site.
 *
 * Kept as whole-line matches so a line carrying both noise *and* a real reason is
 * still reported — the loop above skips only lines matching every one of these.
 */
const NOISE_PATTERNS = [
  /Error reading ca cert file/i,
  /mbedTLS/i,
]

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

// --- Cloudflare edge analytics -------------------------------------------------
//
// Visitor counts for the two public hostnames, read from Cloudflare rather than from a
// script in the page. The reason is not only privacy: `kiramyao.com` is served by
// Cloudflare Pages, so there is **no origin and no origin log**. The edge is the only
// place that sees the request, which makes its aggregate the only honest source.
//
// `clientRequestHTTPHost` and `visits` were both verified against the live API before
// this was written. Two limits, found the same way, and they shape what the page says:
//
//   * **`uniq { uniques }` is not available on this plan** — the field is rejected —
//     so "how many people" cannot be answered. `visits` is, and it is the closest
//     honest equivalent; the page must not label it 访客.
//   * **The zone mixes in odd ports.** Real responses carried `kiramyao.com:8443`,
//     `hrt.kiramyao.com:80` and so on, so a naive exact match on the hostname misses
//     traffic. Hosts are normalised by stripping the port.

/**
 * Restricts the count to things a person plausibly did, which is the difference between
 * a number worth showing and one that is mostly noise. Every term comes from inspecting
 * what this zone actually recorded, not from a guess.
 *
 *   - **`verifiedBotCategory: ""`** drops Cloudflare-classified crawlers. A 20-hour
 *     window logged 73 visits from "Search Engine Crawler", plus AI crawlers and SEO
 *     tools. A crawl is not a reader.
 *   - **`userAgentBrowser_neq: "Curl"`** drops command-line clients. This mattered more
 *     than expected: 81 of hrt.kiramyao.com's 286 visits arrived that way, and
 *     inspecting them showed `curl/8.21.0` fetching /privacy 38 times — **the
 *     verification traffic from the session that built this**, not visitors at all.
 *   - **`userAgent_neq`** on our own probe, listed below. The status page fetches
 *     kiramyao.com every 30 minutes to watch it, and that traffic was counting as 29
 *     visits a day. A status page whose own uptime checks appear in its visitor figures
 *     is measuring itself.
 *
 * `ChromeHeadless` is deliberately kept: it is automated, but it is a real rendering
 * engine and could be a legitimate preview or screenshot service. 52 requests is not
 * worth guessing about in either direction.
 *
 * Deliberately NOT a whitelist of browser names. The zone's largest `userAgentBrowser`
 * bucket is **"Unknown" — 5669 requests against Chrome's 1512** — and a whitelist drops
 * all of it. Inspecting that bucket found mostly-real traffic (a Firefox UA with 140
 * visits, Chrome variants) mixed with self-inflicted noise, so a whitelist would
 * undercount far more than this overcounts. It also contained CMS and vulnerability
 * probes (`/wp-admin/install.php`, `/Alvin9999/https/…`) — which recorded **zero
 * visits** anyway, so they never inflated anything.
 */
const CF_HUMAN_FILTER = [
  'verifiedBotCategory: ""',
  'userAgentBrowser_neq: "Curl"',
  `userAgent_neq: ${JSON.stringify(CF_PROBE_USER_AGENT)}`,
].join(', ')

/**
 * The API endpoint. Fixed rather than configurable: it is Cloudflare's, and a wrong
 * value here would be a silent zero rather than a failure worth debugging.
 */
const CF_GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql'

/** Hostnames the page reports on. Anything else in the zone is not our business here. */
export const CF_HOSTS = {
  site: 'kiramyao.com',
  tracker: 'hrt.kiramyao.com',
}

/**
 * Visitor counts per hostname for the last `hours`.
 *
 * `fetchImpl` is an injection point so a test can drive it without the network, the
 * same shape the other readers use. Returns `{ ok: false }` rather than throwing, and
 * the snapshot turns that into `null` — a metric we could not read renders "—", never a
 * zero standing in for "we did not ask".
 */
export async function readCloudflareVisits(config, { fetchImpl = fetch, now = Date.now() } = {}) {
  const { apiToken, zoneTag } = config
  if (!apiToken || !zoneTag) return { ok: false, error: 'not configured' }

  const since = new Date(now - 24 * 60 * 60 * 1000).toISOString()
  const until = new Date(now).toISOString()

  // Hosts carry a port in this zone, so the suffix is what actually matches; the two
  // filter terms, and why each is there, are documented on CF_HUMAN_FILTER below.
  const query = `query {
    viewer {
      zones(filter: { zoneTag: ${JSON.stringify(zoneTag)} }) {
        httpRequestsAdaptiveGroups(
          limit: 200
          filter: {
            datetime_geq: ${JSON.stringify(since)}
            datetime_leq: ${JSON.stringify(until)}
            ${CF_HUMAN_FILTER}
          }
          orderBy: [count_DESC]
        ) {
          count
          sum { visits }
          dimensions { clientRequestHTTPHost }
        }
      }
    }
  }`

  try {
    const res = await fetchImpl(CF_GRAPHQL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const body = await res.json()
    // GraphQL answers 200 with an `errors` array for a bad query or an expired token,
    // so the status code alone is not a verdict here.
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      return { ok: false, error: String(body.errors[0]?.message ?? 'graphql error').slice(0, 120) }
    }
    const rows = body?.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups
    if (!Array.isArray(rows)) return { ok: false, error: 'no rows in the response' }

    const normalise = (host) => String(host ?? '').replace(/:\d+$/, '').toLowerCase()
    const totals = { site: null, tracker: null }
    const seen = new Set()
    for (const row of rows) {
      const host = normalise(row.dimensions?.clientRequestHTTPHost)
      const key = host === CF_HOSTS.site ? 'site' : host === CF_HOSTS.tracker ? 'tracker' : null
      if (!key) continue
      // Sum rather than take: one hostname can appear across several rows when ports
      // differ, and stopping at the first would undercount.
      totals[key] = (totals[key] ?? 0) + (Number(row.sum?.visits) || 0)
      seen.add(host)
    }
    // A host we expect but did not see is a real zero, not a failure: Cloudflare omits
    // hosts with no traffic. That is different from having read nothing at all.
    if (seen.size === 0) return { ok: false, error: 'no rows matched a known hostname' }
    if (totals.site === null) totals.site = 0
    if (totals.tracker === null) totals.tracker = 0

    return { ok: true, hours: 24, site: totals.site, tracker: totals.tracker }
  } catch (error) {
    return { ok: false, error: error.message || String(error) }
  }
}
