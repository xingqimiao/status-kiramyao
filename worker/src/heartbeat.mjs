/**
 * The origin heartbeat.
 *
 * The origin pushes the two facts no outside probe can see -- whether Postgres is
 * answering and how full the disk is -- authenticated with a Worker secret.
 *
 * The security property that matters: it is NOT a content channel. There is no free
 * text in the accepted body at all. The schema is a closed set of numeric/boolean
 * fields, unknown keys are rejected, values are range-checked, the body is size-capped,
 * and the only thing that reaches storage is a fixed set of metric keys. A stolen token
 * can therefore distort two numbers and the heartbeat timestamp; it cannot put a
 * sentence on the page. (The free-text field on the page, an incident reason, is
 * authored only through the Access-gated /admin.)
 */
import { timingSafeEqual } from './access.mjs'

const MAX_BODY_BYTES = 4096
/** A timestamp this far from the Worker's clock is a bug, not a reading. */
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000

const ALLOWED_TOP = new Set(['ts', 'postgres', 'disk'])
const ALLOWED_POSTGRES = new Set(['ok', 'latency_ms'])
const ALLOWED_DISK = new Set(['used_pct', 'free_gb'])

const isNumber = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max

function bearer(request) {
  const header = request.headers.get('Authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1] : request.headers.get('X-Heartbeat-Token')
}

function reject(status, error) {
  return Response.json({ ok: false, error }, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function handleHeartbeat(request, env, config, store, { now = Date.now() } = {}) {
  const expected = String(env.HEARTBEAT_TOKEN ?? '')
  // Fail closed: an unconfigured token is a 503, not an open endpoint.
  if (!expected) return reject(503, 'HEARTBEAT_TOKEN not configured')
  if (!timingSafeEqual(bearer(request), expected)) return reject(401, 'unauthorized')

  const raw = await request.text()
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return reject(413, 'body too large')

  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return reject(400, 'body must be JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reject(400, 'body must be an object')
  for (const key of Object.keys(body)) if (!ALLOWED_TOP.has(key)) return reject(400, `unknown field: ${key}`)

  if (body.ts !== undefined && (typeof body.ts !== 'number' || Math.abs(now - body.ts) > MAX_CLOCK_SKEW_MS)) {
    return reject(400, 'ts is outside the allowed clock skew')
  }

  if (body.postgres !== undefined) {
    const pg = body.postgres
    if (!pg || typeof pg !== 'object' || Array.isArray(pg)) return reject(400, 'postgres must be an object')
    for (const key of Object.keys(pg)) if (!ALLOWED_POSTGRES.has(key)) return reject(400, `unknown postgres field: ${key}`)
    if (typeof pg.ok !== 'boolean') return reject(400, 'postgres.ok must be a boolean')
    if (pg.latency_ms !== undefined && !isNumber(pg.latency_ms, 0, 60_000)) return reject(400, 'postgres.latency_ms out of range')
  }

  if (body.disk !== undefined) {
    const disk = body.disk
    if (!disk || typeof disk !== 'object' || Array.isArray(disk)) return reject(400, 'disk must be an object')
    for (const key of Object.keys(disk)) if (!ALLOWED_DISK.has(key)) return reject(400, `unknown disk field: ${key}`)
    if (disk.used_pct !== undefined && !isNumber(disk.used_pct, 0, 100)) return reject(400, 'disk.used_pct out of range')
    if (disk.free_gb !== undefined && !isNumber(disk.free_gb, 0, 1e6)) return reject(400, 'disk.free_gb out of range')
  }

  if (body.postgres === undefined && body.disk === undefined) return reject(400, 'nothing to record')

  if (body.postgres) {
    await store.addMetric('origin.postgres_ok', body.postgres.ok ? 1 : 0, now)
    if (body.postgres.latency_ms !== undefined) await store.addMetric('origin.postgres_latency_ms', body.postgres.latency_ms, now)
  }
  if (body.disk) {
    if (body.disk.used_pct !== undefined) await store.addMetric('origin.disk_used_pct', body.disk.used_pct, now)
    if (body.disk.free_gb !== undefined) await store.addMetric('origin.disk_free_gb', body.disk.free_gb, now)
  }
  await store.addMetric('origin.heartbeat_at', now, now)

  return Response.json({ ok: true, at: now }, { headers: { 'Cache-Control': 'no-store' } })
}
