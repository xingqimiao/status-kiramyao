/**
 * The manual declaration: it may raise severity, it may never lower it, and the page
 * always shows the probe fact beside it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createStore } from '../../lib/db.mjs'
import { renderPage } from '../../lib/view.mjs'
import { createD1Store } from '../src/db.mjs'
import { buildWorkerSnapshot } from '../src/snapshot.mjs'
import { overlayManual } from '../src/manual.mjs'
import { openMigratedDb, fakeD1 } from './helpers.mjs'

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)
const MIN = 60 * 1000
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

function overlay(probeState, active, resolved) {
  return overlayManual(probeState, active ?? null, resolved ?? null, { now: NOW, probeNewestAt: NOW - MIN })
}

test('a manual declaration raises severity and cannot lower it', () => {
  const active = { severity: 'full', resolvedAt: null }
  assert.equal(overlay('green', active).overall, 'red', 'human says outage over a green probe')
  // "No active declaration" is grey, which is below green: it can never pull a red down.
  assert.equal(overlay('red', null, { severity: 'full', resolvedAt: NOW - MIN }).overall, 'red')
})

test('a resolved declaration over failing probes is flagged as a mismatch', () => {
  const resolved = { severity: 'full', resolvedAt: NOW - 5 * MIN }
  const result = overlay('red', null, resolved)
  assert.equal(result.overall, 'red', 'the probe verdict stands')
  assert.equal(result.mismatch.kind, 'resolved-but-failing')
})

test('a manual declaration below the probe verdict is flagged, not used to hide it', () => {
  const result = overlay('red', { severity: 'maintenance', resolvedAt: null })
  assert.equal(result.overall, 'red')
  assert.equal(result.mismatch.kind, 'manual-lower')
})

test('an old resolved declaration does not keep blaming a later outage', () => {
  const resolved = { severity: 'full', resolvedAt: NOW - 48 * 60 * MIN }
  assert.equal(overlay('red', null, resolved).mismatch, null)
})

test('the page shows the reason, the GMT+8 start time, and both verdicts', async () => {
  const db = openMigratedDb()
  const seeder = createStore(db)
  for (let i = 0; i < 4; i++) seeder.addProbe({ component: 'hrt_web', at: NOW - i * MIN, ok: true, statusCode: 200 })

  const store = createD1Store(fakeD1(db))
  await store.createEvent({ severity: 'full', reason: '数据库主库故障，正在切换', startedAt: NOW - 20 * MIN, createdAt: NOW - 20 * MIN, createdBy: 'ops@example.com' })

  const snapshot = await buildWorkerSnapshot(store, CONFIG, { now: NOW })
  assert.equal(snapshot.overall, 'red', 'the human declaration is the banner')
  assert.equal(snapshot.manual.active.severity, 'full')

  const html = renderPage(snapshot, CONFIG)
  assert.ok(html.includes('数据库主库故障，正在切换'), 'the reason is shown verbatim')
  assert.ok(html.includes('服务中断'), 'the severity is named')
  assert.ok(html.includes('GMT+8'), 'the start time is stated in GMT+8')
  assert.ok(html.includes('自动探测：'), 'and the probe verdict is shown beside it, not hidden')
  assert.ok(html.includes('所有系统正常运行'), 'which here says the probes saw nothing')
})

test('a resolved declaration does not turn a failing probe green, and the page says so', async () => {
  const db = openMigratedDb()
  const seeder = createStore(db)
  seeder.addProbe({ component: 'hrt_api', at: NOW - MIN, ok: false, error: 'HTTP 502' })
  seeder.addProbe({ component: 'hrt_api', at: NOW - 2 * MIN, ok: false, error: 'HTTP 502' })

  const store = createD1Store(fakeD1(db))
  const event = await store.createEvent({ severity: 'full', reason: '故障', startedAt: NOW - 30 * MIN, createdAt: NOW - 30 * MIN, createdBy: 'ops@example.com' })
  await store.resolveEvent(event.id, { resolvedAt: NOW - 10 * MIN, resolvedBy: 'ops@example.com' })

  const snapshot = await buildWorkerSnapshot(store, CONFIG, { now: NOW })
  assert.equal(snapshot.overall, 'red', 'manual recovery must not hide a red probe')
  assert.equal(snapshot.manual.active, null)
  assert.equal(snapshot.manual.mismatch.kind, 'resolved-but-failing')

  const html = renderPage(snapshot, CONFIG)
  assert.ok(html.includes('运维已宣判恢复，但自动探测仍显示'), 'the disagreement is stated explicitly')
})

test('an already-resolved event is not rewritten by a second resolve', async () => {
  const db = openMigratedDb()
  const store = createD1Store(fakeD1(db))
  const event = await store.createEvent({ severity: 'partial', reason: 'x', startedAt: NOW, createdAt: NOW, createdBy: 'a@b' })
  const first = await store.resolveEvent(event.id, { resolvedAt: NOW + MIN, resolvedBy: 'a@b' })
  const second = await store.resolveEvent(event.id, { resolvedAt: NOW + 2 * MIN, resolvedBy: 'c@d' })
  assert.equal(first.resolvedAt, NOW + MIN)
  assert.equal(second, null, 'the audit trail is not rewritten')
})
