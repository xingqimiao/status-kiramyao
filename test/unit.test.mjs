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
import {
  recordBoceRows, resolveNodes, BOCE_AUTO_NODES, probeUrl, readCloudflareVisits,
  nextBoceDelayMs,
} from '../lib/probe.mjs'

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

test('the CN row stays current for its own cadence, not the local one', () => {
  // The CN row is sampled daily while everything else is sampled every 30 minutes.
  // One window derived from `probeIntervalMinutes` gave it 90 minutes to be current
  // in, so a daily probe was stale by definition and the row read grey 23.5 hours a
  // day. Twelve hours after a sample it must still be showing what it saw.
  const store = freshStore()
  seedGreen(store, 'site_overseas')
  seedGreen(store, 'site_cn', { source: 'boce', count: 1, at: NOW - 12 * HOUR })

  const snapshot = buildSnapshot(store, testConfig({
    boce: { enabled: true, apiKey: 'k', nodes: 'auto', intervalHours: 24, targetUrl: 'https://x/' },
  }), { now: NOW })

  const cn = snapshot.components.find((c) => c.id === 'site_cn')
  assert.equal(cn.state, 'green', 'a daily probe is still current 12h later')

  // But it must not stay current forever: three missed daily rounds is three days.
  const stale = buildSnapshot(store, testConfig({
    boce: { enabled: true, apiKey: 'k', nodes: 'auto', intervalHours: 24, targetUrl: 'https://x/' },
  }), { now: NOW + 4 * 24 * HOUR })
  assert.equal(
    stale.components.find((c) => c.id === 'site_cn').state,
    'grey',
    'and goes grey once the loop has missed rounds',
  )
})

test('ordinary CN node failures do not become a fault on the page', () => {
  // The behaviour the operator asked for: a handful of unreachable nodes is the normal
  // state of routes into mainland China, and a page that calls every such day amber is
  // a page nobody reads. 26 of 28 reachable is green; it also opens no incident.
  const store = freshStore()
  seedGreen(store, 'site_overseas')
  const at = NOW - HOUR
  for (let i = 0; i < 28; i++) {
    store.addProbe({ source: 'boce', component: 'site_cn', at, ok: i >= 2, error: i < 2 ? 'curl: (28) operation timed out' : null })
  }

  const config = testConfig({
    boce: { enabled: true, apiKey: 'k', nodes: 'auto', intervalHours: 24, targetUrl: 'https://x/' },
  })
  const snapshot = buildSnapshot(store, config, { now: NOW })
  const cn = snapshot.components.find((c) => c.id === 'site_cn')
  assert.equal(cn.state, 'green', '2 of 28 nodes failing is within the tolerated rate')
  assert.equal(cn.uptime, 26 / 28, 'but uptime still counts the failures — it is a measurement')
  assert.equal(
    snapshot.incidents.filter((i) => i.component === 'site_cn').length, 0,
    'and a tolerated round does not open an incident',
  )

  // Past the tolerated rate it must still speak up, or the tolerance has swallowed the
  // signal it was supposed to leave alone.
  const store2 = freshStore()
  seedGreen(store2, 'site_overseas')
  const at2 = NOW - HOUR
  for (let i = 0; i < 28; i++) {
    store2.addProbe({ source: 'boce', component: 'site_cn', at: at2, ok: i >= 10, error: i < 10 ? 'x' : null })
  }
  const snap2 = buildSnapshot(store2, config, { now: NOW })
  assert.equal(snap2.components.find((c) => c.id === 'site_cn').state, 'amber', '10 of 28 is past it')
  assert.equal(snap2.incidents.filter((i) => i.component === 'site_cn').length, 1, 'so it is reported')
})

test('a CN outage is measured in days, not in 30-minute rounds', () => {
  // The bug this pins: with a 30-minute-derived gap, the next daily probe (24h later)
  // arrived "after a silence", so the incident was closed at its last failure and then
  // a fresh one opened — reporting a routine daily failure as a two-day ongoing outage.
  const store = freshStore()
  seedGreen(store, 'site_overseas')
  const dayMs = 24 * HOUR
  // Day 1: the CN round fails. Day 2: it fails again. Day 3: it recovers.
  store.addProbe({ source: 'boce', component: 'site_cn', at: NOW - 2 * dayMs, ok: false, error: 'x' })
  store.addProbe({ source: 'boce', component: 'site_cn', at: NOW - 1 * dayMs, ok: false, error: 'x' })
  store.addProbe({ source: 'boce', component: 'site_cn', at: NOW - 1 * HOUR, ok: true })

  const snapshot = buildSnapshot(store, testConfig({
    boce: { enabled: true, apiKey: 'k', nodes: 'auto', intervalHours: 24, targetUrl: 'https://x/' },
  }), { now: NOW })

  const cnIncidents = snapshot.incidents.filter((i) => i.component === 'site_cn')
  assert.equal(cnIncidents.length, 1, 'two consecutive failing days are one incident')
  assert.equal(cnIncidents[0].ongoing, false, 'and it is closed by the recovery')
  // Two days of failure, not two minutes.
  assert.ok(
    cnIncidents[0].durationMs >= dayMs,
    `a two-day CN failure should last about two days, got ${cnIncidents[0].durationMs}ms`,
  )
})

test('a node that cannot read its own CA bundle is not reported as our cert problem', () => {
  // mbedTLS failing to read /etc/ssl/certs on the probe node says nothing about our
  // site, and it fires intermittently on nodes that answer 200 seconds later. Surfacing
  // it as the outage reason sends a reader hunting for a certificate fault we do not
  // have. A genuine reason in the same report must still win.
  // Both forms below are verbatim from live probe reports. Note they differ: curl
  // prefixes `curl: (28)` when the attempt failed, and leaves a bare `* ` verbose line
  // when it succeeded anyway. The failing form is the one that reaches `curlReason`.
  const store = freshStore()
  const noisy = {
    node_id: 12, node_name: '陕西电信', error_code: 0, error: '', http_code: 0,
    time_total: 10, ip_region: '美国',
    report_source: 'curl: (28) Error reading ca cert file /etc/ssl/certs/ca-certificates.crt - mbedTLS: (-0x3E00) PK - Read/write of file failed\n\nhttp_code:0\n',
  }
  const withReason = {
    node_id: 55, node_name: '云南移动', error_code: 0, error: '', http_code: 0,
    time_total: 10, ip_region: '美国',
    report_source: '> GET / HTTP/1.1\ncurl: (28) operation timed out\n\nhttp_code:0\n',
  }
  recordBoceRows(store, [noisy, withReason], NOW)
  const probes = store.probesFrom('boce', NOW - 1000)
  const noisyProbe = probes.find((p) => p.statusCode === null && /CA 证书/.test(p.error ?? ''))
  assert.ok(noisyProbe, 'the CA-bundle failure is summarised as the node failing its own check')
  assert.ok(
    !/ca cert file/i.test(noisyProbe.error),
    'and does not repeat the node-local mbedTLS text as if it were the cause',
  )
  const realProbe = probes.find((p) => /timed out/.test(p.error ?? ''))
  assert.ok(realProbe, 'a real connect failure is still reported verbatim')
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
  // And the round context leads, because that is the question the row answers. A bare
  // "operation timed out" reads as our site failing; "2 of 28 nodes" reads correctly.
  assert.match(dead.error, /该轮 3 个节点中 2 个无法连接/, 'the stored error says how many of how many')
  assert.match(dead.error, /福建联通|河北移动/, 'and names the nodes that could not connect')
})

test('an unresolved incident on a daily row does not claim to be live', () => {
  // 「持续中」 asserts we are watching right now. For a once-a-day sample the newest
  // reading can be 24 hours old, so the honest label is that the last sample failed.
  const store = freshStore()
  seedGreen(store, 'site_overseas')
  store.addProbe({ source: 'boce', component: 'site_cn', at: NOW - HOUR, ok: false, error: 'x' })

  const config = testConfig({
    boce: { enabled: true, apiKey: 'k', nodes: 'auto', intervalHours: 24, targetUrl: 'https://x/' },
  })
  const snapshot = buildSnapshot(store, config, { now: NOW })
  const incident = snapshot.incidents.find((i) => i.component === 'site_cn')
  assert.equal(incident.ongoing, true, 'the newest CN reading is a failure')
  assert.equal(incident.intervalMinutes, 24 * 60, 'the cadence travels with the incident')
  const html = renderPage(snapshot, config)
  assert.ok(html.includes('最近一次采样失败'), 'and the daily row says only that the sample failed')
  assert.ok(!html.includes('持续中'), 'never 「持续中」 for a daily sample')

  // A fine-grained component keeps the live wording, because there it is true.
  const store2 = freshStore()
  seedGreen(store2, 'site_overseas')
  store2.addProbe({ component: 'hrt_api', at: NOW - 5 * 60_000, ok: false })
  const html2 = renderPage(buildSnapshot(store2, testConfig(), { now: NOW }), testConfig())
  assert.ok(html2.includes('持续中'), 'a 30-minute row is still described as ongoing')
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

// --- Cloudflare edge analytics ------------------------------------------------

test('edge visits are summed per hostname, with the port stripped', () => {
  // Two things this pins, both found by inspecting real responses first:
  //
  //   * The zone reports the same hostname across ports (`kiramyao.com:8443`,
  //     `hrt.kiramyao.com:80`), so an exact match on the hostname would silently
  //     undercount. Everything for a host must be summed.
  //   * Hosts with no traffic are omitted by Cloudflare entirely, so a host that is
  //     absent is a real zero — but *no* known host at all means the query was wrong,
  //     and that is a failure rather than a zero. Reporting 0 for it would be the
  //     fabrication this whole service avoids.
  const body = {
    data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [
      { count: 4137, sum: { visits: 756 }, dimensions: { clientRequestHTTPHost: 'kiramyao.com' } },
      { count: 134, sum: { visits: 7 }, dimensions: { clientRequestHTTPHost: 'kiramyao.com:8443' } },
      { count: 1622, sum: { visits: 260 }, dimensions: { clientRequestHTTPHost: 'hrt.kiramyao.com' } },
      { count: 56, sum: { visits: 23 }, dimensions: { clientRequestHTTPHost: 'hrt.kiramyao.com:443' } },
      { count: 3988, sum: { visits: 3 }, dimensions: { clientRequestHTTPHost: 'api.kiramyao.com' } },
    ] }] } },
  }
  const fetchImpl = async () => ({ ok: true, json: async () => body })

  return readCloudflareVisits({ apiToken: 't', zoneTag: 'z' }, { fetchImpl }).then((r) => {
    assert.equal(r.ok, true)
    assert.equal(r.site, 763, 'kiramyao.com plus its :8443 traffic')
    assert.equal(r.tracker, 283, 'hrt.kiramyao.com plus its :443 traffic')
  })
})

test('the visits query excludes crawlers and command-line clients', () => {
  // The accuracy decision, pinned so it cannot be dropped by accident. Both terms were
  // chosen from what the zone actually recorded: 73 visits in a 20h window came from
  // classified crawlers, and 81 of hrt's 286 visits were `curl` — including our own
  // verification traffic, which hit /privacy 38 times. A page that counts its own health
  // checks as visitors flatters itself.
  let sent = null
  const fetchImpl = async (_url, init) => {
    sent = JSON.parse(init.body).query
    return { ok: true, json: async () => ({ data: { viewer: { zones: [{ httpRequestsAdaptiveGroups: [
      { count: 1, sum: { visits: 5 }, dimensions: { clientRequestHTTPHost: 'kiramyao.com' } },
    ] }] } } }) }
  }
  return readCloudflareVisits({ apiToken: 't', zoneTag: 'z' }, { fetchImpl }).then((r) => {
    assert.equal(r.ok, true)
    assert.match(sent, /verifiedBotCategory: ""/, 'classified crawlers are excluded')
    assert.match(sent, /userAgentBrowser_neq: "Curl"/, 'command-line clients are excluded')
    // And the result says what it is, so the page cannot claim these are people.
    assert.equal(r.hours, 24)
  })
})

test('a GraphQL error is a failure, not a zero', () => {
  // A bad token answers HTTP 200 with an `errors` array, so the status code alone is
  // not a verdict.
  const fetchImpl = async () => ({ ok: true, json: async () => ({ errors: [{ message: 'not authorized' }] }) })
  return readCloudflareVisits({ apiToken: 'bad', zoneTag: 'z' }, { fetchImpl }).then((r) => {
    assert.equal(r.ok, false)
    assert.match(r.error, /not authorized/)
  })
})

test('unconfigured Cloudflare is skipped, and the metric stays absent', () => {
  const store = freshStore()
  seedGreen(store, 'hrt_web')
  const snapshot = buildSnapshot(store, testConfig(), { now: NOW })
  assert.equal(snapshot.guardian.visitsSite, null, 'no configuration means no number')
  assert.equal(snapshot.guardian.visitsTracker, null)
  const html = renderPage(snapshot, testConfig())
  assert.ok(html.includes('kiramyao.com 访问量'), 'the tiles are present')
  assert.ok(html.includes('—'), 'and show an em dash rather than a zero')
})

// --- the daily CN schedule ---------------------------------------------------
//
// The defect these pin: the CN sample ran on a 24-hour interval measured from boot,
// with a boot-time skip guard. A restart at 06:12 with a 656-minute-old sample was
// skipped (under the 720-minute ceiling), and the fresh timer then waited until 06:12
// the next morning — ~35 hours with no sample and a CN row reading grey. Anchoring to
// a time of day removes the whole class: a restart cannot move or skip it.

test('the CN schedule targets the configured hour, not an interval from boot', () => {
  // 06:12 local. Midnight has passed, so the next one is tomorrow's — this is exactly
  // the restart in the incident, and the answer must be ~17h48m, not 24h and not 0.
  // The second argument is the minute past that hour, so these pass 0 to keep talking
  // about midnight itself; the shipped default is five past.
  const at0612 = new Date(2026, 8, 18, 6, 12, 15)
  const delay = nextBoceDelayMs(0, 0, at0612)
  assert.equal(Math.round(delay / 60_000), 17 * 60 + 48, 'the remaining minutes to midnight')

  // The delay depends on the wall clock, so two different boot times converge on the
  // same target rather than each carrying its own 24-hour period.
  // 23:00 to midnight is 60 minutes less the seconds component of `now`, so round to
  // the hour rather than to the minute.
  const at2300 = new Date(2026, 8, 18, 23, 0, 0)
  assert.equal(Math.round(nextBoceDelayMs(0, 0, at2300) / HOUR), 1, 'one hour from 23:00')

  const at0001 = new Date(2026, 8, 18, 0, 1, 0)
  assert.equal(
    Math.round(nextBoceDelayMs(0, 0, at0001) / 60_000), 23 * 60 + 59,
    'a process that boots just after midnight waits for tomorrow, and cannot double-spend today',
  )
})

test('being exactly on the hour schedules tomorrow rather than firing immediately', () => {
  // A zero delay would fire at once. On a restart landing precisely at midnight that
  // would be defensible, but the same code path runs after a failed round too, and a
  // retry loop at 00:00 would spend the day's budget repeatedly.
  const exactlyMidnight = new Date(2026, 8, 18, 0, 0, 0, 0)
  assert.equal(Math.round(nextBoceDelayMs(0, 0, exactlyMidnight) / 60_000), 24 * 60)
})

test('a non-midnight hour is honoured, so the sample can be moved off the boundary', () => {
  const at1000 = new Date(2026, 8, 18, 10, 0, 0)
  assert.equal(Math.round(nextBoceDelayMs(3, 0, at1000) / 60_000), 17 * 60, '03:00 is 17h away')
  assert.equal(Math.round(nextBoceDelayMs(23, 0, at1000) / 60_000), 13 * 60, '23:00 is 13h away')
})

test('the sample sits inside the day it belongs to, not on its boundary', () => {
  // The default is 00:05 rather than 00:00, and the difference is the whole point: at
  // exactly midnight the round lands on the boundary and today's cell stays grey until
  // it does. Five minutes in, the day has a sample from its first moments.
  const at0000 = new Date(2026, 8, 18, 0, 0, 0, 0)
  assert.equal(Math.round(nextBoceDelayMs(0, 5, at0000) / 60_000), 5, 'five past midnight is five minutes away')

  const at0004 = new Date(2026, 8, 18, 0, 4, 0)
  assert.equal(Math.round(nextBoceDelayMs(0, 5, at0004) / 60_000), 1, 'and it is still ahead one minute earlier')

  const at0006 = new Date(2026, 8, 18, 0, 6, 0)
  assert.equal(
    Math.round(nextBoceDelayMs(0, 5, at0006) / 60_000), 24 * 60 - 1,
    'past it, the next one is tomorrow — the same rule the hour boundary uses',
  )
})
