/**
 * The HTTP surface, end to end, against a real server on an ephemeral port.
 *
 * The page and the JSON are asserted over real requests rather than by calling the
 * render functions, because the routing is where the interesting mistakes live: the
 * mount prefix, the `Accept`-based content negotiation, and the health check's
 * staleness rule. None of those exist when you call `renderPage` directly.
 *
 * A stub upstream stands in for the API and the comment service, so the probes and
 * the metric reads exercise the whole path without touching the network.
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { COMPONENTS } from '../lib/components.mjs'

const ROOT = resolve(import.meta.dirname, '..')

let stub
let stubBase
let service
let serviceBase
let dir

/** What the stub answers, keyed by path. Tests can rewrite it mid-run. */
let stubRoutes = {}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kira-status-test-'))

  // --- a stub upstream ------------------------------------------------------
  stub = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname
    const route = stubRoutes[path]
    if (!route) {
      res.writeHead(404).end('no stub for ' + path)
      return
    }
    res.writeHead(route.status ?? 200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(route.body ?? {}))
  })
  await new Promise((r) => stub.listen(0, '127.0.0.1', r))
  stubBase = `http://127.0.0.1:${stub.address().port}`

  stubRoutes = {
    '/health': { body: { ok: true } },
    '/stats': { body: { ok: true, users: { total: 5 }, records: { doses: 9, labs: 1 }, deletions: { self: 2 } } },
    '/comments/stats': { body: { users: 3, comments: 11 } },
    '/catalog.json': { body: { resources: [{ kind: 'stories' }, { kind: 'stories' }, { kind: 'posts' }] } },
  }

  // --- the service under test ----------------------------------------------
  // A child process rather than an import: `server.mjs` starts its timers and its
  // initial probe round at import time, and a test that imported it twice would get
  // two servers fighting over one port. Spawning it also proves it starts the way
  // systemd will start it.
  //
  // The port is chosen first by asking the OS for a free one, because the service
  // needs a concrete number to bind: `PORT=0` would have it bind an ephemeral port
  // that the test cannot discover.
  const port = await freePort()
  service = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      BASE_PATH: '/status',
      DATA_FILE: join(dir, 'status.sqlite'),
      PROBE_INTERVAL_MINUTES: '30',
      HISTORY_DAYS: '90',
      BOCE_ENABLED: 'false',
      COMMENTS_HEALTH_URL: `${stubBase}/health`,
      HRT_HEALTH_URL: `${stubBase}/health`,
      HRT_MCP_HEALTH_URL: `${stubBase}/health`,
      HRT_WEB_URL: `${stubBase}/health`,
      SITE_URL: `${stubBase}/health`,
      HRT_STATS_URL: `${stubBase}/stats`,
      COMMENTS_STATS_URL: `${stubBase}/comments/stats`,
      STORIES_CATALOG_URL: `${stubBase}/catalog.json`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  serviceBase = `http://127.0.0.1:${port}`

  // Surface the child's stderr if it dies, so a startup failure is readable rather
  // than a bare timeout.
  let childErr = ''
  service.stderr.on('data', (chunk) => { childErr += chunk.toString() })

  // Wait for it to answer, rather than sleeping a guessed amount.
  const deadline = Date.now() + 20_000
  for (;;) {
    try {
      await fetch(`${serviceBase}/status/health`)
      break
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`the service did not start in 20s. stderr:\n${childErr}`)
      }
      await new Promise((r) => setTimeout(r, 200))
    }
  }
}, { timeout: 60_000 })

after(async () => {
  // Kill the child and *wait for it to exit* before touching its data directory.
  // On Windows the SQLite handle is released only when the process is gone, so an
  // immediate `rmSync` fails with EPERM — which presented as the whole test file
  // failing after every assertion had passed.
  if (service && service.exitCode === null) {
    const exited = new Promise((r) => service.once('exit', r))
    service.kill()
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))])
  }
  await new Promise((r) => stub.close(r))
  rmSync(dir, { recursive: true, force: true })
})

async function freePort() {
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const { port } = probe.address()
  await new Promise((r) => probe.close(r))
  return port
}

// --- tests ------------------------------------------------------------------

test('health reports live rather than merely alive', async () => {
  const res = await fetch(`${serviceBase}/status/health`)
  const body = await res.json()
  assert.equal(res.status, 200, 'a fresh instance has just probed, so it is healthy')
  assert.equal(body.ok, true)
  assert.equal(body.service, 'status')
  assert.equal(body.boce_enabled, false)
  assert.ok(typeof body.newest_probe_age_ms === 'number', 'the age is reported, not just a boolean')
})

test('the page renders as HTML when a browser asks for it', async () => {
  const res = await fetch(`${serviceBase}/status/`, { headers: { Accept: 'text/html' } })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  const html = await res.text()
  assert.ok(html.includes('KiraMyao'), 'the site name is on the page')
  assert.ok(html.includes('系统状态'), 'and the system section')
  assert.ok(html.includes('数据守护'), 'and the data-guardian section')
})

test('the root serves JSON to anything that is not a browser', async () => {
  const res = await fetch(`${serviceBase}/status/`, { headers: { Accept: 'application/json' } })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /application\/json/)
  const body = await res.json()
  assert.ok(body.generatedAt)
  assert.ok(Array.isArray(body.components))
})

test('the page sends an escaping-friendly, script-free CSP', async () => {
  const res = await fetch(`${serviceBase}/status/`, { headers: { Accept: 'text/html' } })
  const csp = res.headers.get('content-security-policy')
  assert.match(csp, /default-src 'none'/, 'nothing loads by default')
  assert.ok(!csp.includes('script-src'), 'there is no script policy to allow, because there are no scripts')
})

test('history.json carries 90 days for each component', async () => {
  const res = await fetch(`${serviceBase}/status/history.json`)
  assert.equal(res.status, 200)
  const body = await res.json()
  // Every row the register declares, so a component added to `components.mjs` without
  // a probe target fails here rather than showing up as a permanently grey row.
  assert.equal(body.components.length, COMPONENTS.length)
  assert.ok(COMPONENTS.length >= 5, 'the five originals are still there')
  for (const c of body.components) {
    assert.equal(c.days.length, 90, `${c.id} has a full window`)
  }
})

test('the data guardian reads the stubbed upstreams', async () => {
  // The metric loop runs at boot; give it a moment to have written.
  const deadline = Date.now() + 10_000
  let body
  for (;;) {
    body = await (await fetch(`${serviceBase}/status/history.json`)).json()
    if (body.guardian.accounts !== null) break
    if (Date.now() > deadline) break
    await new Promise((r) => setTimeout(r, 250))
  }
  assert.equal(body.guardian.accounts, 5, 'the account count came from the aggregate')
  assert.equal(body.guardian.selfDeletions, 2)
  assert.equal(body.guardian.commentUsers, 3)
  assert.equal(body.guardian.comments, 11)
  assert.equal(body.guardian.stories, 2, 'two of the three catalogue resources are stories')
})

test('the mount prefix is enforced: the same paths outside it are not served', async () => {
  for (const outside of ['/health', '/history.json', '/']) {
    const res = await fetch(`${serviceBase}${outside}`, { headers: { Accept: 'text/html' } })
    assert.equal(res.status, 404, `${outside} must not be served`)
  }
})

test('a near-miss prefix is refused', async () => {
  for (const near of ['/statusx/health', '/stat/health']) {
    const res = await fetch(`${serviceBase}${near}`)
    assert.equal(res.status, 404, `${near} must not match /status`)
  }
})

test('an unknown path inside the mount is a 404', async () => {
  const res = await fetch(`${serviceBase}/status/nope`)
  assert.equal(res.status, 404)
})

test('the probes actually probed the stub, and recorded successes', async () => {
  const body = await (await fetch(`${serviceBase}/status/history.json`)).json()
  const by = Object.fromEntries(body.components.map((c) => [c.id, c]))
  // The stub answers 200 for every probe target, so these are green.
  assert.equal(by.hrt_web.state, 'green')
  assert.equal(by.hrt_api.state, 'green')
  assert.equal(by.hrt_mcp.state, 'green', 'the MCP readiness route is probed like any other local target')
  assert.equal(by.comments_api.state, 'green')
  assert.equal(by.site_overseas.state, 'green')
  // boce is disabled in this run, so the CN row has nothing — grey, and it must not
  // have dragged the overall verdict to amber or red.
  assert.equal(by.site_cn.state, 'grey')
  assert.equal(body.overall, 'green')
})
