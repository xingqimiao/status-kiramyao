/**
 * The heartbeat's trust boundary: a closed schema, authenticated, and no free text.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createD1Store } from '../src/db.mjs'
import { handleHeartbeat } from '../src/heartbeat.mjs'
import { openMigratedDb, fakeD1 } from './helpers.mjs'

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)
const ENV = { HEARTBEAT_TOKEN: 's3cret' }
const CONFIG = { heartbeatStaleMs: 15 * 60 * 1000 }

function post(body, { token = 's3cret', env = ENV } = {}) {
  const db = openMigratedDb()
  const store = createD1Store(fakeD1(db))
  const request = new Request('https://status.kiramyao.com/heartbeat', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return handleHeartbeat(request, env, CONFIG, store, { now: NOW }).then((response) => ({ response, db, store }))
}

test('a valid heartbeat records the fixed metric keys', async () => {
  const { response, store } = await post({ postgres: { ok: true, latency_ms: 12.5 }, disk: { used_pct: 63.4, free_gb: 41.2 } })
  assert.equal(response.status, 200)
  const metrics = await store.latestMetrics()
  assert.equal(metrics.get('origin.postgres_ok').value, '1')
  assert.equal(metrics.get('origin.disk_used_pct').value, '63.4')
  assert.equal(metrics.get('origin.heartbeat_at').value, String(NOW))
})

test('a wrong token is refused before the body is read', async () => {
  const { response } = await post({ postgres: { ok: true } }, { token: 'wrong' })
  assert.equal(response.status, 401)
})

test('an unconfigured token fails closed', async () => {
  const { response } = await post({ postgres: { ok: true } }, { env: {} })
  assert.equal(response.status, 503)
})

test('free text is rejected: an unknown field is a 400', async () => {
  const { response, store } = await post({ postgres: { ok: true }, message: '<script>alert(1)</script>' })
  assert.equal(response.status, 400)
  assert.equal((await store.latestMetrics()).size, 0, 'nothing was written')
})

test('a wrongly typed or out-of-range value is rejected', async () => {
  for (const body of [
    { postgres: { ok: 'yes' } },
    { postgres: { ok: true, latency_ms: -1 } },
    { disk: { used_pct: 101 } },
    { disk: { free_gb: 'lots' } },
    { disk: { note: 'hello' } },
    {},
  ]) {
    const { response } = await post(body)
    assert.equal(response.status, 400, JSON.stringify(body))
  }
})

test('a body asserting a far-future timestamp is rejected', async () => {
  const { response } = await post({ ts: NOW + 60 * 60 * 1000, postgres: { ok: true } })
  assert.equal(response.status, 400)
})
