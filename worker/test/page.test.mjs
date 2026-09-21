/**
 * The public page with the heartbeat facts on it, and the config parser.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { renderPage } from '../../lib/view.mjs'
import { workerConfig } from '../src/config.mjs'
import { createD1Store } from '../src/db.mjs'
import { buildWorkerSnapshot } from '../src/snapshot.mjs'
import { handleHeartbeat } from '../src/heartbeat.mjs'
import { openMigratedDb, fakeD1 } from './helpers.mjs'

const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)
const MIN = 60 * 1000
const CONFIG = {
  basePath: '', siteName: 'KiraMyao', publicOrigin: 'https://status.kiramyao.com',
  probeIntervalMinutes: 10, historyDays: 90, boce: { enabled: false, intervalHours: 24 },
  cnToleratedFailureRatio: 0, heartbeatStaleMs: 15 * MIN, cloudflare: null,
}

async function heartbeat(store, body, now = NOW) {
  const request = new Request('https://status.kiramyao.com/heartbeat', {
    method: 'POST', headers: { Authorization: 'Bearer s3cret' }, body: JSON.stringify(body),
  })
  return handleHeartbeat(request, { HEARTBEAT_TOKEN: 's3cret' }, CONFIG, store, { now })
}

test('a fresh heartbeat puts the disk reading on the page', async () => {
  const store = createD1Store(fakeD1(openMigratedDb()))
  await heartbeat(store, { postgres: { ok: true, latency_ms: 12 }, disk: { used_pct: 63.4, free_gb: 41.2 } })
  const snapshot = await buildWorkerSnapshot(store, CONFIG, { now: NOW })
  const html = renderPage(snapshot, CONFIG)
  assert.ok(html.includes('磁盘占用'))
  assert.ok(html.includes('63.4%'))
  assert.ok(html.includes('剩余 41.2 GB'))
  // The heartbeat still records the Postgres facts -- the closed schema is unchanged --
  // but neither they nor the comment-user count have a tile. The comment *count* stays,
  // and the slot the comment-user count used to occupy is left empty rather than filled.
  assert.equal(snapshot.guardian.origin.postgresOk, true, 'the snapshot still carries it')
  assert.ok(!html.includes('数据库'), 'no database tile')
  assert.ok(!html.includes('评论用户'), 'no comment-user tile')
  assert.ok(html.includes('评论条数'), 'the comment count tile stays')
})

test('a stale heartbeat renders "—", never a stale value', async () => {
  const store = createD1Store(fakeD1(openMigratedDb()))
  await heartbeat(store, { postgres: { ok: true }, disk: { used_pct: 63.4 } })
  const snapshot = await buildWorkerSnapshot(store, CONFIG, { now: NOW + 60 * MIN })
  assert.equal(snapshot.guardian.origin.postgresOk, null)
  assert.equal(snapshot.guardian.origin.diskUsedPct, null)
  const html = renderPage(snapshot, CONFIG)
  assert.ok(html.includes('磁盘占用'), 'the disk tile is still there')
  assert.ok(!html.includes('63.4%'), 'the old number is gone')
})

test('the window copy follows the data span, not HISTORY_DAYS', async () => {
  const store = createD1Store(fakeD1(openMigratedDb()))
  // Four Beijing days of readings (NOW is 20:00 Beijing on the 17th), well short of the
  // 90-day window. Every span-stating string must say four.
  for (let i = 0; i < 4; i++) {
    await store.addProbe({
      source: 'external', component: 'site_overseas', at: NOW - i * 24 * 60 * 60 * 1000, ok: true, statusCode: 200,
    })
  }
  const snapshot = await buildWorkerSnapshot(store, CONFIG, { now: NOW })
  const overseas = snapshot.components.find((c) => c.id === 'site_overseas')
  assert.equal(snapshot.windowDays, 4, 'the page span is the data span')
  assert.equal(snapshot.guardian.availabilityDays, 4)
  assert.equal(snapshot.guardian.availabilityHint, '最近 4 天本页探测成功率')
  assert.equal(overseas.windowDays, 4, 'the row states its own span')
  assert.equal(overseas.days.length, 90, 'the strip still draws the whole window')
  assert.equal(snapshot.components.find((c) => c.id === 'hrt_api').windowDays, 0, 'never probed')

  const html = renderPage(snapshot, CONFIG)
  assert.ok(html.includes('最近 4 天本页探测成功率'), 'the availability hint names the real span')
  assert.ok(!html.includes('最近 90 天本页探测成功率'))
  assert.ok(html.includes('uptime 4d'), 'the row unit names the real span')
  assert.ok(!html.includes('uptime 0d'), 'a row with no readings claims no span')
  assert.ok(html.includes('最近 4 天可用性'), 'the description names the same span as the figure')
  assert.ok(html.includes('<span class="window">最近 4 天</span>'), 'the section header too')
  assert.ok(html.includes('最近 4 天没有记录到故障'), 'and the incident window')
})

test('workerConfig parses the env the way the Worker routes with', () => {
  const config = workerConfig({
    BASE_PATH: '/', HISTORY_DAYS: '90', PROBE_INTERVAL_MINUTES: '10',
    ACCESS_TEAM_DOMAIN: 'https://team.cloudflareaccess.com/',
  })
  assert.equal(config.basePath, '', '/ mounts at the root')
  assert.equal(config.probeIntervalMinutes, 10)
  assert.equal(config.echoNonce.hrt_api, true, 'app endpoints must echo the nonce')
  assert.equal(config.echoNonce.site_overseas, false, 'static hosts cannot')
  assert.equal(config.boce.enabled, false, 'unset BOCE_ENABLED means no CN dimension')
  assert.equal(config.access.teamDomain, 'team.cloudflareaccess.com', 'the team domain is normalised')
})

test('BOCE_ENABLED turns the CN dimension on; cadence and tolerance come with it', () => {
  assert.equal(workerConfig({}).cnToleratedFailureRatio, undefined,
    'unset tolerance falls back to DEFAULT_TOLERATED_FAILURE_RATIO.boce')
  const on = workerConfig({
    BOCE_ENABLED: 'true', BOCE_INTERVAL_HOURS: '24', CN_TOLERATED_FAILURE_RATIO: '0.15',
  })
  assert.equal(on.boce.enabled, true)
  assert.equal(on.boce.intervalHours, 24)
  assert.equal(on.cnToleratedFailureRatio, 0.15)
})
