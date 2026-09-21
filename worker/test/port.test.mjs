/**
 * The port, asserted rather than asserted-about.
 *
 * The same seeded database is handed to the Node assembler (lib/snapshot.mjs, reading
 * raw probes) and to the Worker assembler (worker/src/snapshot.mjs, reading D1
 * aggregates) and the two snapshots are compared field for field. If the SQL grouping
 * ever stops agreeing with the JS grouping -- the failure mode that would make the ported
 * page quietly disagree with the one it replaced -- this test goes red.
 *
 * It also pins the incident-list rules onto the collapsed-run path: a flap, a silence and
 * a daily-cadence gap all have to come out the same as they do through raw probes.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createStore } from '../../lib/db.mjs'
import { buildSnapshot } from '../../lib/snapshot.mjs'
import { buildWorkerSnapshot } from '../src/snapshot.mjs'
import { createD1Store } from '../src/db.mjs'
import { openMigratedDb, fakeD1 } from './helpers.mjs'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)

const CONFIG = {
  basePath: '',
  siteName: 'KiraMyao',
  publicOrigin: 'https://status.kiramyao.com',
  probeIntervalMinutes: 30,
  historyDays: 90,
  targets: {},
  stats: {},
  boce: { enabled: false, apiKey: '', nodes: 'auto', intervalHours: 24, targetUrl: 'https://x/' },
  cnToleratedFailureRatio: 0,
  heartbeatStaleMs: 15 * 60 * 1000,
  cloudflare: null,
}

function seed(db, fn) {
  const store = createStore(db)
  fn(store)
  return store
}

function green(store, component, { source = 'local', count = 48, at = NOW } = {}) {
  for (let i = 0; i < count; i++) {
    store.addProbe({ source, component, at: at - i * 30 * 60 * 1000, ok: true, statusCode: 200, latencyMs: 120 })
  }
}

async function both(db, now = NOW) {
  const node = buildSnapshot(createStore(db), CONFIG, { now })
  const worker = await buildWorkerSnapshot(createD1Store(fakeD1(db)), CONFIG, { now })
  return { node, worker }
}

function compareShared(node, worker, now = NOW) {
  assert.equal(worker.overall, node.overall, 'the banner verdict agrees')
  assert.equal(node.components.length, worker.components.length)
  for (let i = 0; i < node.components.length; i++) {
    const a = node.components[i]
    const b = worker.components[i]
    assert.deepEqual(
      { id: b.id, label: b.label, note: b.note, state: b.state, uptime: b.uptime, days: b.days },
      { id: a.id, label: a.label, note: a.note, state: a.state, uptime: a.uptime, days: a.days },
      `component ${a.id} differs`,
    )
  }
  assert.deepEqual(worker.mergedDays, node.mergedDays, 'the merged strip agrees')
  assert.deepEqual(
    worker.incidents.map((i) => ({ ...i })),
    node.incidents.map((i) => ({ ...i })),
    'the incident list agrees',
  )
  for (const key of ['accounts', 'selfDeletions', 'commentUsers', 'comments', 'stories', 'visitsSite', 'visitsTracker', 'availability', 'availabilityHint', 'availabilityDays', 'visitsHint']) {
    assert.deepEqual(worker.guardian[key], node.guardian[key], `guardian.${key} differs`)
  }
}

test('a healthy window ports exactly', async () => {
  const db = openMigratedDb()
  seed(db, (store) => {
    green(store, 'site_overseas')
    green(store, 'hrt_web')
    green(store, 'hrt_api')
    green(store, 'hrt_mcp')
    green(store, 'comments_api')
  })
  const { node, worker } = await both(db)
  compareShared(node, worker)
  assert.equal(worker.overall, 'green')
})

test('failures, a recovery and a gap port exactly', async () => {
  const db = openMigratedDb()
  seed(db, (store) => {
    green(store, 'site_overseas')
    const c = 'hrt_api'
    for (let i = 0; i < 3; i++) store.addProbe({ component: c, at: NOW - 5 * HOUR + i * 30 * 60_000, ok: false, error: 'HTTP 502' })
    // A short success, then more failure: a flap, one incident.
    store.addProbe({ component: c, at: NOW - 3 * HOUR, ok: true, statusCode: 200 })
    for (let i = 0; i < 2; i++) store.addProbe({ component: c, at: NOW - 2.5 * HOUR + i * 30 * 60_000, ok: false, error: 'HTTP 503' })
    // A six-hour silence, then a recovery: a new run.
    store.addProbe({ component: c, at: NOW - 10 * 60_000, ok: true, statusCode: 200 })
  })
  const { node, worker } = await both(db)
  compareShared(node, worker)
})

test('a 90-day-old window with no recent probes goes grey on both', async () => {
  const db = openMigratedDb()
  seed(db, (store) => {
    green(store, 'hrt_web', { count: 4, at: NOW - 100 * DAY })
  })
  const { node, worker } = await both(db)
  compareShared(node, worker)
  assert.equal(worker.components.find((c) => c.id === 'hrt_web').state, 'grey')
})

test('the GMT+8 day cut is the same on both sides of midnight Beijing', async () => {
  const db = openMigratedDb()
  // 00:05 Beijing on the 21st is 16:05Z on the 20th. Under a UTC cut this lands in the
  // previous cell; both assemblers must call it the 21st.
  seed(db, (store) => {
    store.addProbe({ component: 'site_overseas', at: Date.UTC(2026, 8, 20, 16, 5, 0), ok: true })
  })
  const { node, worker } = await both(db, Date.UTC(2026, 8, 21, 12, 0, 0))
  compareShared(node, worker, Date.UTC(2026, 8, 21, 12, 0, 0))
  const today = worker.mergedDays[worker.mergedDays.length - 1]
  assert.equal(today.day, '2026-09-21')
  assert.equal(today.state, 'green')
})

test('a missing metric is null on both, never zero', async () => {
  const db = openMigratedDb()
  seed(db, (store) => green(store, 'hrt_web'))
  const { node, worker } = await both(db)
  compareShared(node, worker)
  assert.equal(worker.guardian.accounts, null)
  assert.equal(node.guardian.accounts, null)
})

test('metrics and visits port exactly', async () => {
  const db = openMigratedDb()
  seed(db, (store) => {
    green(store, 'site_overseas')
    store.addMetric('hrt.accounts', 12, NOW - HOUR)
    store.addMetric('hrt.accounts', 14, NOW)
    store.addMetric('hrt.self_deletions', 2, NOW)
    store.addMetric('comments.users', 3, NOW)
    store.addMetric('comments.comments', 11, NOW)
    store.addMetric('stories.preserved', 125, NOW)
    store.addMetric('visits.site', 100, NOW)
    store.addMetric('visits.tracker', 40, NOW)
    // An overridden visitsHint needs config.cloudflare truthy on both sides.
  })
  const cfgNode = { ...CONFIG, cloudflare: { apiToken: 'x', zoneTag: 'y' } }
  const node = buildSnapshot(createStore(db), cfgNode, { now: NOW })
  const worker = await buildWorkerSnapshot(createD1Store(fakeD1(db)), { ...cfgNode, heartbeatStaleMs: CONFIG.heartbeatStaleMs }, { now: NOW })
  compareShared(node, worker)
  assert.equal(worker.guardian.visitsHint, '最近 24 小时')
})

test('probes arriving out of order port exactly', async () => {
  const db = openMigratedDb()
  seed(db, (store) => {
    green(store, 'hrt_web', { count: 0 })
    store.addProbe({ component: 'hrt_web', at: NOW, ok: true })
    store.addProbe({ component: 'hrt_web', at: NOW - 2 * HOUR, ok: false, error: 'boom' })
    store.addProbe({ component: 'hrt_web', at: NOW - HOUR, ok: true })
  })
  const { node, worker } = await both(db)
  compareShared(node, worker)
})
