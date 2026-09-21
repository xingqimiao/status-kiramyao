/**
 * The only acceptance test that means anything: stop the service and watch the page go red.
 *
 * A local HTTP origin stands in for the box: it echoes the nonce and declares no-store.
 * One probe round runs against it (green), the server is stopped, a second round runs, and
 * the snapshot must be red. The elapsed time from "stopped" to "red snapshot" is what the
 * 10-minute cron budget is measured against.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'

import { COMPONENTS } from '../../lib/components.mjs'
import { createD1Store } from '../src/db.mjs'
import { runWorkerProbeRound } from '../src/probe.mjs'
import { buildWorkerSnapshot } from '../src/snapshot.mjs'
import { openMigratedDb, fakeD1 } from './helpers.mjs'

const MIN = 60 * 1000

const baseConfig = () => ({
  historyDays: 90,
  probeIntervalMinutes: 10,
  boce: { enabled: false, intervalHours: 24 },
  cnToleratedFailureRatio: 0,
  heartbeatStaleMs: 15 * MIN,
  cloudflare: null,
})

test('stopping the service turns the page red on the next round', async () => {
  const server = createServer((req, res) => {
    const nonce = new URL(req.url, 'http://x').searchParams.get('nonce')
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      'X-Probe-Nonce': nonce ?? '',
    })
    res.end(JSON.stringify({ ok: true, nonce }))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/health`

  const config = {
    ...baseConfig(),
    targets: Object.fromEntries(COMPONENTS.filter((c) => c.local).map((c) => [c.id, url])),
    echoNonce: Object.fromEntries(COMPONENTS.map((c) => [c.id, true])),
  }
  const store = createD1Store(fakeD1(openMigratedDb()))

  const t0 = Date.now()
  const up = await runWorkerProbeRound(store, config, { now: t0 })
  assert.ok(up.every((r) => r.ok), 'the origin is up and echoing')

  const green = await buildWorkerSnapshot(store, config, { now: t0 + 1_000 })
  assert.equal(green.overall, 'green')

  // --- pull the plug ---
  const stoppedAt = Date.now()
  await new Promise((r) => server.close(r))
  const downAt = stoppedAt + 10 * MIN
  const down = await runWorkerProbeRound(store, config, { now: downAt })
  assert.ok(down.every((r) => !r.ok), 'every probe fails once the origin is gone')

  const red = await buildWorkerSnapshot(store, config, { now: downAt + 1_000 })
  const elapsed = Date.now() - stoppedAt
  console.log(`freshness acceptance: stopped -> red snapshot in ${elapsed}ms (next cron tick at +${MIN / 1000}s)`)

  assert.equal(red.overall, 'red')
  for (const c of red.components.filter((c) => c.id !== 'site_cn')) {
    assert.equal(c.state, 'red', `${c.id} is red`)
  }
})
