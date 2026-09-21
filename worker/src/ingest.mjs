/**
 * The external prober's ingest endpoint.
 *
 * Why this exists: a Worker subrequest to a hostname in the SAME zone that proxies to a
 * real origin times out. Measured from D1 (source = 'local'), site_overseas -- which
 * Cloudflare answers itself -- was the only row that came back, while hrt_web, hrt_api,
 * hrt_mcp and comments_api all recorded `timeout after 4000ms`. The owner refused a
 * grey-cloud record (it would publish the origin IP), so the inbound probe cannot run
 * from here at all. A prober outside the zone measures those hostnames and reports the
 * verdict here, and the cron no longer manufactures the same reds every ten minutes
 * (worker/src/index.mjs).
 *
 * The trust boundary is the heartbeat's, plus one field. A bearer token, a closed schema,
 * a byte cap, and a single length-capped free-text field. A stolen token can put at most
 * MAX_ERROR_LEN characters of `error` on the page, against a closed set of component ids;
 * it cannot invent a component, write a sentence of unbounded length, or set a numeric
 * field outside its range.
 */
import { COMPONENTS } from '../../lib/components.mjs'
import { timingSafeEqual } from './access.mjs'
import { json } from './http.mjs'

/** The prober sends five rows; ten times that is not a round, it is a payload. */
const MAX_ROWS = 50
const MAX_BODY_BYTES = 32 * 1024
/** The page has an error line; this keeps a stolen token from writing an essay on it. */
const MAX_ERROR_LEN = 200
const MAX_LATENCY_MS = 120_000

/**
 * The register's own ids: nothing off-list can enter the table.
 *
 * This is the whole register, not just the local probe loop's targets. `site_cn` has no
 * local target -- it is measured by boce's mainland nodes, which the out-of-zone prober
 * runs (a Worker cron cannot hold the adapter's async poll) and reports here. The
 * guarantee is unchanged: still a closed set of registered ids, so a stolen token cannot
 * invent a component, only report one that already exists on the page.
 */
const COMPONENT_IDS = new Set(COMPONENTS.map((c) => c.id))

const ALLOWED_ROW = new Set(['component', 'ok', 'status_code', 'latency_ms', 'error'])

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v)

/** Exactly "Bearer <token>", the same shape the heartbeat accepts. */
function bearer(request) {
  const header = request.headers.get('Authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1] : null
}

function reject(status, error) {
  return json(status, { ok: false, error }, { 'Cache-Control': 'no-store' })
}

/**
 * The round a probe belongs to, as the interval boundary.
 *
 * The prober has no field to say "this is a retry", so the timestamp is derived here
 * rather than taken from the body: quantising to the cadence makes every POST in one
 * ten-minute window address the same round, which is what makes a retry idempotent
 * (db.replaceExternalProbes deletes that `at` before inserting). ponytail: a retry that
 * straddles a boundary lands in the next round; with one prober on a ten-minute cadence
 * that costs one extra round, not a duplicated one.
 */
function roundAt(now, intervalMinutes) {
  const step = intervalMinutes * 60_000
  return Math.floor(now / step) * step
}

/** The first problem with one row, or null. Ranges are the probe contract's own bounds. */
function rowError(row, index) {
  const where = `row ${index}`
  if (!row || typeof row !== 'object' || Array.isArray(row)) return `${where}: must be an object`
  for (const key of Object.keys(row)) if (!ALLOWED_ROW.has(key)) return `${where}: unknown field: ${key}`
  if (typeof row.component !== 'string' || !COMPONENT_IDS.has(row.component)) return `${where}: unknown component`
  if (typeof row.ok !== 'boolean') return `${where}: ok must be a boolean`
  if (row.status_code !== undefined && row.status_code !== null
    && !(Number.isInteger(row.status_code) && row.status_code >= 100 && row.status_code <= 599)) {
    return `${where}: status_code out of range`
  }
  if (row.latency_ms !== undefined && row.latency_ms !== null
    && !(isFiniteNumber(row.latency_ms) && row.latency_ms >= 0 && row.latency_ms <= MAX_LATENCY_MS)) {
    return `${where}: latency_ms out of range`
  }
  if (row.error !== undefined && row.error !== null
    && (typeof row.error !== 'string' || row.error.length > MAX_ERROR_LEN)) {
    return `${where}: error must be a string of at most ${MAX_ERROR_LEN} characters`
  }
  return null
}

export async function handleProbeIngest(request, env, store, config, { now = Date.now() } = {}) {
  const expected = String(env.PROBE_TOKEN ?? '')
  // Fail closed, exactly like the heartbeat: an unconfigured token is a 503, not an open
  // endpoint. A wrong or missing token is a 401 response -- never a redirect.
  if (!expected) return reject(503, 'PROBE_TOKEN not configured')
  if (!timingSafeEqual(bearer(request), expected)) return reject(401, 'unauthorized')

  const raw = await request.text()
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return reject(413, 'body too large')

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return reject(400, 'body must be JSON')
  }
  if (!Array.isArray(body)) return reject(400, 'body must be an array of rows')
  if (body.length === 0) return reject(400, 'at least one row is required')
  if (body.length > MAX_ROWS) return reject(413, `too many rows (max ${MAX_ROWS})`)

  const rows = []
  for (let i = 0; i < body.length; i++) {
    const problem = rowError(body[i], i)
    if (problem) return reject(400, problem)
    rows.push({
      component: body[i].component,
      ok: body[i].ok,
      statusCode: body[i].status_code ?? null,
      latencyMs: body[i].latency_ms ?? null,
      error: body[i].error ?? null,
    })
  }

  const interval = Number(config?.probeIntervalMinutes)
  const at = roundAt(now, Number.isFinite(interval) && interval > 0 ? interval : 10)
  // One timestamp and one source for the whole round, so the day counts, the newest
  // round and the incident runs see a round rather than five unrelated readings.
  await store.replaceExternalProbes(at, rows)
  return json(200, { ok: true, at, count: rows.length }, { 'Cache-Control': 'no-store' })
}
