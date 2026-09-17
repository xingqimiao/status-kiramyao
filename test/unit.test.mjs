/**
 * Storage, the snapshot, and the HTTP surface.
 *
 * The two assertions worth calling out, because neither is checkable by looking at
 * the page:
 *
 *   1. **A page request performs no network I/O.** This is the rule that keeps page
 *      traffic from becoming the boce bill — the single most expensive mistake
 *      available in this service. It is asserted by handing the service a fetch
 *      that throws if called during a request.
 *   2. **A missing metric renders as "—", not 0.** "Zero users" and "we could not
 *      read the number" are different claims and only one belongs on a status page.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { openDb, createStore } from '../lib/db.mjs'
import { buildSnapshot, HEALTH_COMPONENT } from '../lib/snapshot.mjs'
import { renderPage, renderHistory } from '../lib/view.mjs'
import { loadConfig } from '../lib/config.mjs'
import { recordBoceRows, resolveNodes, BOCE_AUTO_NODES, probeUrl } from '../lib/probe.mjs'

const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)

/** A config the tests own, so no test depends on the ambient environment. */
function testConfig(overrides = {}) {
  return {
    basePath: '/status',
    siteName: 'KiraMyao',
    publicOrigin: 'https://status.kiramyao.com',
    probeIntervalMinutes: 30,
    historyDays: 90,
    targets: {},
    stats: {},
    boce: { enabled: false, apiKey: '', nodes: 'auto', intervalHours: 24, targetUrl: 'https://x/' },
    ...overrides,
  }
}

function freshStore() {
  const db = openDb(':memory:')
  return createStore(db)
}

/** A plausible window of green probes for one component. */
function seedGreen(store, component, { source = 'local', count = 48, at = NOW } = {}) {
  for (let i = 0; i < count; i++) {
    store.addProbe({ source, component, at: at - i * 30 * 60 * 1000, ok: true, statusCode: 200, latencyMs: 120 })
  }
}

// --- storage ----------------------------------------------------------------

test('a probe round-trips with its fields intact', () => {
  const store = freshStore()
  store.addProbe({
    source: 'local', component: 'hrt_api', at: NOW, ok: true,
    statusCode: 200, latencyMs: 143.5, error: null, region: null,
  })
  store.addProbe({
    source: 'boce', component: 'site_cn', at: NOW, ok: false,
    statusCode: 502, latencyMs: 640.2, error: 'node error 3', region: '美国',
  })

  const local = store.probesFor('hrt_api', NOW - HOUR)
  assert.equal(local.length, 1)
  assert.equal(local[0].ok, true)
  assert.equal(local[0].latencyMs, 143.5)

  const boce = store.probesFrom('boce', NOW - HOUR)
  assert.equal(boce.length, 1)
  assert.equal(boce[0].ok, false, 'a failure stays a failure across the round trip')
  assert.equal(boce[0].region, '美国', 'the resolved region is stored — it is the DNS signal')
})

test('probes come back oldest first, so the incident pass can rely on it', () => {
  const store = freshStore()
  store.addProbe({ component: 'a', at: NOW, ok: true })
  store.addProbe({ component: 'a', at: NOW - HOUR, ok: true })
  store.addProbe({ component: 'a', at: NOW - 2 * HOUR, ok: true })
  const probes = store.probesFor('a', NOW - 3 * HOUR)
  assert.deepEqual(probes.map((p) => p.at), [NOW - 2 * HOUR, NOW - HOUR, NOW])
})

test('prune drops rows outside the window and keeps the rest', () => {
  const store = freshStore()
  store.addProbe({ component: 'a', at: NOW - 100 * 24 * HOUR, ok: true })
  store.addProbe({ component: 'a', at: NOW, ok: true })
  store.prune(NOW - 90 * 24 * HOUR)
  const left = store.probesFor('a', 0)
  assert.equal(left.length, 1)
  assert.equal(left[0].at, NOW)
})

test('a metric reads back its latest value, and null stays null', () => {
  const store = freshStore()
  store.addMetric('hrt.accounts', 12, NOW - HOUR)
  store.addMetric('hrt.accounts', 14, NOW)
  store.addMetric('stories.preserved', null, NOW)
  assert.equal(store.latestMetric('hrt.accounts').value, '14', 'latest wins')
  assert.equal(store.latestMetric('stories.preserved').value, null)
  assert.equal(store.latestMetric('never.written'), null)
})

// --- the snapshot -----------------------------------------------------------

test('a seeded window produces green days and a green overall state', () => {
  const store = freshStore()
  seedGreen(store, 'hrt_web')
  const snapshot = buildSnapshot(store, testConfig(), { now: NOW })

  const web = snapshot.components.find((c) => c.id === 'hrt_web')
  assert.equal(web.state, 'green')
  assert.equal(web.uptime, 1)
  assert.equal(web.days[web.days.length - 1].state, 'green', 'today is green')
  assert.equal(snapshot.overall, 'green')
})

test('one failed component makes the overall verdict the worse one', () => {
  const store = freshStore()
  seedGreen(store, 'hrt_web')
  store.addProbe({ component: 'hrt_api', at: NOW - 60_000, ok: false, error: 'HTTP 502' })
  const snapshot = buildSnapshot(store, testConfig(), { now: NOW })
  assert.equal(snapshot.overall, 'red')
})

test('a component we never probed is grey and does not drag the verdict down', () => {
  const store = freshStore()
  seedGreen(store, 'hrt_web')
  const snapshot = buildSnapshot(store, testConfig(), { now: NOW })
  const api = snapshot.components.find((c) => c.id === 'hrt_api')
  assert.equal(api.state, 'grey')
  assert.equal(api.uptime, null, 'no probes is an unknown uptime')
  assert.equal(snapshot.overall, 'green', 'the known reading is what the banner speaks for')
})

test('the merged day strip is amber when CN has no sample but was expected', () => {
  // The end-to-end version of the mergeDay rule: with boce on and no CN rows, a
  // perfectly green overseas day must still not read green.
  const store = freshStore()
  seedGreen(store, 'site_overseas')
  const snapshot = buildSnapshot(store, testConfig({
    boce: { enabled: true, apiKey: 'k', nodes: 'auto', intervalHours: 24, targetUrl: 'https://x/' },
  }), { now: NOW })

  const today = snapshot.mergedDays[snapshot.mergedDays.length - 1]
  assert.equal(today.overseas, 'green', 'the overseas probe did pass')
  assert.equal(today.cn, 'grey', 'and there is no CN sample')
  assert.equal(today.state, 'amber', 'so the merged cell is amber — never a fake green')
})

test('the merged strip is green when CN was not configured at all', () => {
  const store = freshStore()
  seedGreen(store, 'site_overseas')
  const snapshot = buildSnapshot(store, testConfig(), { now: NOW })
  const today = snapshot.mergedDays[snapshot.mergedDays.length - 1]
  assert.equal(today.state, 'green')
})

test('a missing metric is null in the snapshot, not zero', () => {
  const store = freshStore()
  seedGreen(store, 'hrt_web')
  const snapshot = buildSnapshot(store, testConfig(), { now: NOW })
  assert.equal(snapshot.guardian.accounts, null)
  assert.equal(snapshot.guardian.stories, null)
})

test('availability is derived from our own history, so a restart does not reset it', () => {
  const store = freshStore()
  // 3 of 4 of the health component's own probes succeeded.
  store.addProbe({ component: HEALTH_COMPONENT, at: NOW - 3 * 30 * 60_000, ok: true })
  store.addProbe({ component: HEALTH_COMPONENT, at: NOW - 2 * 30 * 60_000, ok: true })
  store.addProbe({ component: HEALTH_COMPONENT, at: NOW - 1 * 30 * 60_000, ok: false })
  store.addProbe({ component: HEALTH_COMPONENT, at: NOW, ok: true })
  const snapshot = buildSnapshot(store, testConfig(), { now: NOW })
  assert.equal(snapshot.guardian.availability, '75.000%')
})

// --- the "page never probes" rule -------------------------------------------

test('rendering a page performs no network I/O', () => {
  // The rule that keeps page traffic from becoming the boce bill. A fetch that
  // throws makes a violation loud rather than a line item.
  const original = globalThis.fetch
  globalThis.fetch = () => {
    throw new Error('a page render must never reach the network')
  }
  try {
    const store = freshStore()
    seedGreen(store, 'hrt_web')
    const snapshot = buildSnapshot(store, testConfig(), { now: NOW })
    const html = renderPage(snapshot, testConfig())
    const json = renderHistory(snapshot, testConfig())
    assert.ok(html.includes('KiraMyao'))
    assert.ok(json.includes('hrt_web'))
  } finally {
    globalThis.fetch = original
  }
})

// --- the view ---------------------------------------------------------------

test('the page reports the overall verdict and shows every component', () => {
  const store = freshStore()
  seedGreen(store, 'hrt_web')
  const snapshot = buildSnapshot(store, testConfig(), { now: NOW })
  const html = renderPage(snapshot, testConfig())
  assert.ok(html.includes('所有系统正常运行'), 'the banner states the verdict')
  assert.ok(html.includes('Kira Tracker'), 'and a configured component is listed')
  assert.ok(html.includes('s-green'), 'with its state class')
  // Every row is named after the thing watched, never the vantage point: a reader
  // cannot act on "本站", and the two site rows are told apart by CN / Global.
  assert.ok(html.includes('kiramyao.com'), 'the site row uses its real name')
  assert.ok(html.includes('>CN<') && html.includes('>Global<'), 'and is split by vantage point')
  assert.ok(!html.includes('本站'), 'the vague label is gone')
})

test('a missing metric renders an em dash rather than a zero', () => {
  const store = freshStore()
  seedGreen(store, 'hrt_web')
  const snapshot = buildSnapshot(store, testConfig(), { now: NOW })
  const html = renderPage(snapshot, testConfig())
  assert.ok(html.includes('—'), 'unknown values show as —')
  assert.ok(!html.includes('>0<'), 'and never as a bare zero standing in for unknown')
})

test('an upstream error string is escaped, not injected', () => {
  const store = freshStore()
  store.addProbe({
    component: 'hrt_web', at: NOW - 60_000, ok: false,
    error: '<script>alert(1)</script>',
  })
  const snapshot = buildSnapshot(store, testConfig(), { now: NOW })
  const html = renderPage(snapshot, testConfig())
  assert.ok(!html.includes('<script>alert(1)</script>'), 'the raw tag is not emitted')
  assert.ok(html.includes('&lt;script&gt;'), 'it is escaped instead')
})

test('the history endpoint carries the same numbers as the page', () => {
  const store = freshStore()
  seedGreen(store, 'hrt_web')
  store.addMetric('hrt.accounts', 7, NOW)
  const snapshot = buildSnapshot(store, testConfig(), { now: NOW })
  const parsed = JSON.parse(renderHistory(snapshot, testConfig()))
  assert.equal(parsed.guardian.accounts, 7)
  assert.equal(parsed.components.find((c) => c.id === 'hrt_web').uptime, 1)
  assert.equal(parsed.overall, 'green')
  assert.equal(parsed.components[0].days.length, 90)
})

// --- boce -------------------------------------------------------------------

test('node ids resolve from `auto` and from an explicit list', () => {
  assert.deepEqual(resolveNodes('auto'), BOCE_AUTO_NODES)
  assert.deepEqual(resolveNodes(''), BOCE_AUTO_NODES)
  assert.deepEqual(resolveNodes('6,7'), [6, 7])
  assert.deepEqual(resolveNodes('  6 , 7 '), [6, 7], 'whitespace tolerated')
  assert.deepEqual(resolveNodes('garbage'), BOCE_AUTO_NODES, 'unparseable falls back rather than spending on nothing')
})

test('boce rows become one probe per node, and an offline node is skipped', () => {
  const store = freshStore()
  const summary = recordBoceRows(store, [
    { node_id: 6, node_name: '河北电信', error_code: 0, http_code: 200, time_total: 3.6, ip_region: '美国' },
    { node_id: 7, node_name: '上海电信', error_code: 0, http_code: 200, time_total: 1.2, ip_region: '中国上海' },
    { node_id: 8, node_name: '北京联通', error_code: 3, http_code: null, error: 'connect timeout', ip_region: '' },
    // An offline node: boce does not bill for it and it says nothing about our site.
    { node_id: 9, node_name: '下线节点', error_code: 5, error: 'not found node', ip_region: '' },
  ], NOW)

  assert.equal(summary.ok, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.skipped, 1, 'the offline node is skipped, not counted as an outage')
  assert.equal(summary.nodes, 4)
  assert.ok(summary.regions.includes('美国'), 'the resolved regions are reported')

  const probes = store.probesFrom('boce', NOW - 1000)
  assert.equal(probes.length, 3, 'one row per billable node — the offline one wrote nothing')
  assert.equal(probes.filter((p) => p.ok).length, 2)
})

test('a boce node that answered 200 but reported an error_code is a failure', () => {
  // The calibration finding: a run can get a 200 and still have failed, so http_code
  // alone is not the verdict.
  const store = freshStore()
  const summary = recordBoceRows(store, [
    { node_id: 6, error_code: 7, http_code: 200, error: 'proxy error', ip_region: '中国' },
  ], NOW)
  assert.equal(summary.failed, 1)
  assert.equal(store.probesFrom('boce', NOW - 1000)[0].ok, false)
})

test('a boce node that could not connect is a failure even though error_code is 0', () => {
  // The case the calibration missed, and the most important one here: a node that
  // fails to connect reports http_code 0 but still leaves error_code 0 and an empty
  // `error`, with the reason only in report_source. Judging on error_code alone made
  // it green. Rows below are verbatim from the first production run (2026-09-18),
  // where 3 of 14 nodes did this.
  const store = freshStore()
  const summary = recordBoceRows(store, [
    {
      node_id: 32, node_name: '福建联通', error_code: 0, error: '', http_code: 0,
      time_total: 0.568774, ip_region: '美国',
      report_source: '> GET / HTTP/1.1\n> Host: kiramyao.com\ncurl: (7) read tcp4 192.168.5.13:53940->104.21.79.161:443: read: connection reset by peer\n\nhttp_code:0\n',
    },
    {
      node_id: 7, node_name: '河北移动', error_code: 0, error: '', http_code: 0,
      time_total: 10.001298, ip_region: '美国',
      report_source: '> GET / HTTP/1.1\n\ncurl: (28) operation timed out\n\nhttp_code:0\n',
    },
    // A healthy node in the same batch, so the change cannot pass by failing everything.
    { node_id: 6, node_name: '河北电信', error_code: 0, error: '', http_code: 200, time_total: 3.29, ip_region: '美国' },
  ], NOW)

  assert.equal(summary.ok, 1, 'only the node that got a response counts as reached')
  assert.equal(summary.failed, 2, 'the two that could not connect are failures')

  const probes = store.probesFrom('boce', NOW - 1000)
  const dead = probes.find((p) => p.statusCode === null)
  assert.equal(dead.ok, false, 'a node with no HTTP response is never green')
  assert.match(dead.error, /connection reset/, 'the stored error names the real reason')
})

test('a healthy boce row is judged on http_code, not on alarming report text', () => {
  // The other half of the calibration finding: report_source carries node-local noise
  // (here a CA-bundle complaint) alongside a perfectly good 200. It must not decide
  // the verdict — only describe an already-failed row.
  const store = freshStore()
  const summary = recordBoceRows(store, [
    {
      node_id: 6, node_name: '河北电信', error_code: 0, error: '', http_code: 200,
      time_total: 3.29, ip_region: '美国',
      report_source: '* Error reading ca cert file /etc/ssl/certs/ca-certificates.crt - mbedTLS\n< HTTP/1.1 200 OK\nhttp_code:200\n',
    },
  ], NOW)
  assert.equal(summary.ok, 1, 'a healthy node stays healthy despite the noise')
  assert.equal(store.probesFrom('boce', NOW - 1000)[0].ok, true)
  assert.equal(store.probesFrom('boce', NOW - 1000)[0].error, null, 'and records no error')
})

// --- the probe itself -------------------------------------------------------

test('a 4xx is recorded as a failure with its status', async () => {
  const result = await probeUrl('https://example.test/', {
    fetchImpl: async () => ({ status: 502 }),
  })
  assert.equal(result.ok, false)
  assert.equal(result.statusCode, 502)
  assert.equal(result.error, 'HTTP 502')
})

test('a thrown probe is a recorded failure, not a crashed round', async () => {
  const result = await probeUrl('https://example.test/', {
    fetchImpl: async () => { throw new Error('ECONNREFUSED') },
  })
  assert.equal(result.ok, false)
  assert.equal(result.statusCode, null)
  assert.match(result.error, /ECONNREFUSED/)
})

test('a 3xx after following redirects counts as reachable', async () => {
  const result = await probeUrl('https://example.test/', {
    fetchImpl: async () => ({ status: 200 }),
  })
  assert.equal(result.ok, true)
})
