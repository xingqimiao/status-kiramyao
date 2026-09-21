/**
 * The external prober's ingest, and the cron's honesty.
 *
 * The endpoint is a trust boundary: a bearer token, a closed schema and a length-capped
 * error string, and it is now the only writer of inbound probe rows -- the cron no longer
 * fabricates them (worker/src/index.mjs). Both halves are asserted here.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'

import worker from '../src/index.mjs'
import { createD1Store } from '../src/db.mjs'
import { handleProbeIngest } from '../src/ingest.mjs'
import { buildWorkerSnapshot } from '../src/snapshot.mjs'
import { openMigratedDb, fakeD1 } from './helpers.mjs'

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)
const MIN = 60 * 1000
const TOKEN = 'probe-s3cret'
const ENV = { PROBE_TOKEN: TOKEN }
const CONFIG = {
  basePath: '',
  siteName: 'KiraMyao',
  publicOrigin: 'https://status.kiramyao.com',
  probeIntervalMinutes: 10,
  historyDays: 90,
  boce: { enabled: false, intervalHours: 24 },
  cnToleratedFailureRatio: 0,
  heartbeatStaleMs: 15 * MIN,
  cloudflare: null,
}

const ROUND = [
  { component: 'site_overseas', ok: true, status_code: 200, latency_ms: 84 },
  { component: 'hrt_web', ok: true, status_code: 200, latency_ms: 91 },
  { component: 'hrt_api', ok: true, status_code: 200, latency_ms: 120 },
  { component: 'hrt_mcp', ok: true, status_code: 200, latency_ms: 133 },
  { component: 'comments_api', ok: true, status_code: 200, latency_ms: 99 },
]

const count = (db) => Number(db.prepare('SELECT COUNT(*) AS n FROM probes').all()[0].n)
const ingestUrl = 'https://status.kiramyao.com/ingest/probe'

function requestFor(body, { token = TOKEN } = {}) {
  const headers = token === null ? {} : { Authorization: `Bearer ${token}` }
  return new Request(ingestUrl, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function post(body, { token = TOKEN, env = ENV, now = NOW } = {}) {
  const db = openMigratedDb()
  const store = createD1Store(fakeD1(db))
  const response = await handleProbeIngest(requestFor(body, { token }), env, store, CONFIG, { now })
  return { response, db, store }
}

test('a valid round writes five external rows under one timestamp', async () => {
  const { response, db } = await post(ROUND)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.count, 5)

  const rows = db.prepare(
    'SELECT source, component, at, ok, status_code, latency_ms, error, region FROM probes ORDER BY component',
  ).all()
  assert.equal(rows.length, 5)
  for (const row of rows) {
    assert.equal(row.source, 'external')
    assert.equal(Number(row.at), body.at)
    assert.equal(row.ok, 1)
    assert.equal(row.region, null)
  }
  assert.equal(Number(rows.find((r) => r.component === 'hrt_api').latency_ms), 120)
})

test('a boce round may report site_cn, and a measured day is no longer grey', async () => {
  // site_cn has no local target, so the allow-list used to refuse it -- which is exactly
  // why the CN row could only ever show the imported history. It is a registered
  // component, and the prober's daily boce round reports it through this endpoint.
  const cn = Array.from({ length: 8 }, (_, i) => ({
    component: 'site_cn', ok: i > 0, status_code: i > 0 ? 200 : null, latency_ms: 40 + i,
  }))
  const { response, store } = await post([...ROUND, ...cn])
  assert.equal(response.status, 200)
  assert.equal((await response.json()).count, 13)

  // cnToleratedFailureRatio is undefined here, not CONFIG's 0: the boce default (0.2) is
  // what tolerantFor falls through to, the same as workerConfig does for an unset env.
  const cnConfig = { ...CONFIG, boce: { enabled: true, intervalHours: 24 }, cnToleratedFailureRatio: undefined }
  const snapshot = await buildWorkerSnapshot(store, cnConfig, { now: NOW + MIN })
  const row = snapshot.components.find((c) => c.id === 'site_cn')
  // 1 of 8 nodes failed: inside the boce tolerance (0.2), so it is a green reading.
  assert.equal(row.state, 'green')
  assert.equal(row.days.at(-1).cn, 'green')
  assert.equal(row.days.at(-1).state, 'green', 'a day with a CN sample is not grey')
})

test('an external round drives the live state and the incident list', async () => {
  const { store } = await post(ROUND.map((row) => (row.component === 'hrt_api'
    ? { ...row, ok: false, status_code: 502, error: 'HTTP 502' }
    : row)))
  const snapshot = await buildWorkerSnapshot(store, CONFIG, { now: NOW + MIN })
  assert.equal(snapshot.components.find((c) => c.id === 'hrt_api').state, 'red')
  assert.equal(snapshot.overall, 'red')
  assert.equal(snapshot.incidents.length, 1)
  assert.match(snapshot.incidents[0].lastError, /HTTP 502/)
})

test('the same round posted twice replaces itself; the next round adds five', async () => {
  const db = openMigratedDb()
  const store = createD1Store(fakeD1(db))
  const send = (now) => handleProbeIngest(requestFor(ROUND), ENV, store, CONFIG, { now })

  await send(NOW)
  await send(NOW + 30_000) // still inside the same ten-minute bucket
  assert.equal(count(db), 5, 'a retry is a no-op, not a second round')

  await send(NOW + 10 * MIN) // the next round
  assert.equal(count(db), 10)
})

test('a wrong or missing token is a 401, never a redirect, and writes nothing', async () => {
  const db = openMigratedDb()
  const store = createD1Store(fakeD1(db))
  for (const token of ['wrong', null]) {
    const response = await handleProbeIngest(requestFor(ROUND, { token }), ENV, store, CONFIG, { now: NOW })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('location'), null, 'no redirect loop')
  }
  assert.equal(count(db), 0)
})

test('an unconfigured token fails closed', async () => {
  const { response } = await post(ROUND, { env: {} })
  assert.equal(response.status, 503)
})

test('there is no free-text channel: an unknown key is a 400 and nothing is written', async () => {
  const { response, db } = await post([{ ...ROUND[0], message: '<script>alert(1)</script>' }])
  assert.equal(response.status, 400)
  assert.equal(count(db), 0)
})

test('a wrongly typed or out-of-range row is refused', async () => {
  const badRows = [
    { component: 'hrt_api', ok: 'yes' },
    { component: 'nope', ok: true },
    { component: 'hrt_api', ok: true, status_code: 42 },
    { component: 'hrt_api', ok: true, status_code: '200' },
    { component: 'hrt_api', ok: true, latency_ms: -1 },
    { component: 'hrt_api', ok: true, latency_ms: 'fast' },
    { component: 'hrt_api', ok: true, error: 42 },
    { component: 'hrt_api', ok: true, error: 'x'.repeat(201) },
    'not an object',
    [],
  ]
  for (const row of badRows) {
    const { response, db } = await post([row])
    assert.equal(response.status, 400, JSON.stringify(row))
    assert.equal(count(db), 0, JSON.stringify(row))
  }
})

test('the body must be a non-empty array of rows', async () => {
  for (const body of [{ rows: ROUND }, 'nope', [], null]) {
    const { response, db } = await post(body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(count(db), 0)
  }
})

test('an absurd batch is refused before it is written', async () => {
  const { response, db } = await post(Array.from({ length: 51 }, () => ROUND[0]))
  assert.equal(response.status, 413)
  assert.equal(count(db), 0)
})

test('the route is wired: GET is a 405, POST reaches the handler', async () => {
  const env = { DB: fakeD1(openMigratedDb()), PROBE_TOKEN: TOKEN, BASE_PATH: '/' }

  const wrongMethod = await worker.fetch(new Request(ingestUrl), env, {})
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.get('allow'), 'POST')

  const ok = await worker.fetch(requestFor(ROUND), env, {})
  assert.equal(ok.status, 200)
})

test('the cron records no inbound probe rows (no fabricated failures)', async () => {
  // The stats reads also point here, so the cron has real work to do and still must not
  // write a probe. If the inbound round came back, these five URLs would be probed and
  // five 500 rows would land -- which is exactly the fabricated failure this replaced.
  const server = createServer((req, res) => { res.writeHead(500); res.end('nope') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/x`

  const db = openMigratedDb()
  const env = {
    DB: fakeD1(db),
    BASE_PATH: '/',
    HISTORY_DAYS: '90',
    PROBE_INTERVAL_MINUTES: '10',
    SITE_URL: url,
    HRT_WEB_URL: url,
    HRT_HEALTH_URL: url,
    HRT_MCP_HEALTH_URL: url,
    COMMENTS_HEALTH_URL: url,
    HRT_STATS_URL: url,
    COMMENTS_STATS_URL: url,
    STORIES_CATALOG_URL: url,
  }
  try {
    await worker.scheduled({}, env, {})
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
  assert.equal(count(db), 0, 'the cron did not invent any probe reading')
})
