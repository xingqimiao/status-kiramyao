/**
 * The service.
 *
 * Two loops and a request handler:
 *
 *   - the **probe loop** runs every `PROBE_INTERVAL_MINUTES` and writes rows
 *   - the **metrics loop** reads the public aggregates and writes them too
 *   - the **handler** renders from storage and never reaches the network
 *
 * A third, much slower loop owns boce (`BOCE_INTERVAL_HOURS`, daily by default),
 * kept separate because it is the only thing here that costs money and an operator
 * needs to be able to see and stop it without stopping the page.
 */
import { createServer } from 'node:http'

import { loadConfig } from './lib/config.mjs'
import { openDb, createStore } from './lib/db.mjs'
import { runLocalProbes, runBoceProbe, readHrtStats, readCommentsStats, readStoryCount } from './lib/probe.mjs'
import { buildSnapshot, HEALTH_COMPONENT } from './lib/snapshot.mjs'
import { renderPage, renderHistory } from './lib/view.mjs'

const config = loadConfig()
const db = openDb(config.dataFile)
const store = createStore(db)

let currentSnapshot = buildSnapshot(store, config)

/**
 * Note that nothing here is `await`ed by a request.
 *
 * Each loop is independently guarded: a throw in the boce adapter must not stop the
 * local probes, and a throw in either must not stop the page rendering. The
 * alternative — one big try around everything — is how a status service ends up
 * silently frozen during exactly the incident it was built to report.
 */
async function localProbeRound() {
  try {
    await runLocalProbes(store, config.targets)
    currentSnapshot = buildSnapshot(store, config)
  } catch (error) {
    process.stderr.write(`local probe round failed: ${error?.message ?? error}\n`)
  }
}

async function metricsRound() {
  const now = Date.now()
  try {
    const [hrt, comments, stories] = await Promise.all([
      readHrtStats(config.stats.hrt),
      readCommentsStats(config.stats.comments),
      readStoryCount(config.stats.stories),
    ])
    // Only write a metric that was actually read. Writing a stale value forward, or
    // a zero, would make the page assert something nobody measured.
    if (hrt.ok) {
      store.addMetric('hrt.accounts', hrt.accounts, now)
      store.addMetric('hrt.self_deletions', hrt.selfDeletions, now)
    } else {
      process.stderr.write(`hrt stats unavailable: ${hrt.error}\n`)
    }
    if (comments.ok) {
      store.addMetric('comments.users', comments.users, now)
      store.addMetric('comments.comments', comments.comments, now)
    } else {
      process.stderr.write(`comments stats unavailable: ${comments.error}\n`)
    }
    if (stories.ok) {
      store.addMetric('stories.preserved', stories.stories, now)
    } else {
      process.stderr.write(`story catalogue unavailable: ${stories.error}\n`)
    }
    currentSnapshot = buildSnapshot(store, config)
  } catch (error) {
    process.stderr.write(`metrics round failed: ${error?.message ?? error}\n`)
  }
}

async function boceRound() {
  if (!config.boce.enabled) return
  try {
    const result = await runBoceProbe(store, config.boce)
    if (result.ran) {
      process.stdout.write(`boce: ${result.ok}/${result.nodes} nodes ok, ${result.failed} failed, ${result.skipped} skipped\n`)
    } else {
      // Recorded, not just logged. A day with no CN sample must read as "no
      // data" and cap at amber — see `mergeDay` — rather than quietly vanishing.
      process.stderr.write(`boce did not run: ${result.reason}\n`)
    }
    currentSnapshot = buildSnapshot(store, config)
  } catch (error) {
    process.stderr.write(`boce round failed: ${error?.message ?? error}\n`)
  }
}

function prune() {
  try {
    const cutoff = Date.now() - config.historyDays * 24 * 60 * 60 * 1000
    store.prune(cutoff)
  } catch (error) {
    process.stderr.write(`prune failed: ${error?.message ?? error}\n`)
  }
}

/**
 * The request handler.
 *
 * Paths, relative to the mount:
 *   GET /              the page
 *   GET /history.json  the machine-readable window
 *   GET /health        liveness, for the reverse proxy and for this service's own
 *                      probe to have something to ask
 */
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = stripBasePath(url.pathname)
  if (path === null) return send(res, 404, 'not found')

  // A human asking for HTML gets the page; anything else gets JSON, so a probe or a
  // curl does not have to ask for a specific path to get a usable answer.
  if (path === '/') {
    const wantsHtml = (req.headers.accept ?? '').includes('text/html')
    if (!wantsHtml) return sendJson(res, 200, currentSnapshot)
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // A minute of caching is safe and keeps a traffic spike off SQLite. The probe
      // cadence is 30 minutes, so this only ever serves a snapshot that is at most
      // a minute staler than the probe loop's.
      'Cache-Control': 'public, max-age=60',
      ...SECURITY_HEADERS,
    })
    res.end(renderPage(currentSnapshot, config))
    return
  }

  if (path === '/history.json') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      ...SECURITY_HEADERS,
    })
    res.end(renderHistory(currentSnapshot, config))
    return
  }

  if (path === '/health') {
    // Reports the age of the newest probe rather than just "ok": a process that is
    // alive but whose probe loop died is not healthy, and a bare 200 would say it
    // was.
    const newest = store.latestFor(HEALTH_COMPONENT)
    const ageMs = newest ? Date.now() - newest.at : null
    const healthy = ageMs !== null && ageMs < config.probeIntervalMinutes * 60_000 * 3
    sendJson(res, healthy ? 200 : 503, {
      ok: healthy,
      service: 'status',
      newest_probe_age_ms: ageMs,
      boce_enabled: config.boce.enabled,
    })
    return
  }

  send(res, 404, 'not found')
})

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  // The page is self-contained: one inline stylesheet, no scripts, no fonts, no
  // third-party anything. That makes the policy trivially strict, and strictness is
  // worth having on the one page whose whole claim is that it does not talk to
  // anyone it should not.
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
}

function stripBasePath(pathname) {
  if (!config.basePath) return pathname
  if (pathname === config.basePath) return '/'
  if (pathname.startsWith(`${config.basePath}/`)) return pathname.slice(config.basePath.length)
  return null
}

function send(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
  res.end(text)
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS })
  res.end(JSON.stringify(body))
}

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `kira-status listening on ${config.host}:${config.port}${config.basePath || '/'}`
    + ` (probe every ${config.probeIntervalMinutes}m, boce ${config.boce.enabled ? 'on' : 'off'})\n`,
  )
  // Probe immediately on boot: a fresh deploy should show something other than a
  // page of grey within seconds, not in half an hour.
  void localProbeRound()
  void metricsRound()
  void boceRound()
})

const probeTimer = setInterval(localProbeRound, config.probeIntervalMinutes * 60_000)
const metricsTimer = setInterval(metricsRound, config.probeIntervalMinutes * 60_000)
const boceTimer = config.boce.enabled
  ? setInterval(boceRound, config.boce.intervalHours * 60 * 60 * 1000)
  : null
// Daily, at a time nothing else is happening.
const pruneTimer = setInterval(prune, 24 * 60 * 60 * 1000)

for (const timer of [probeTimer, metricsTimer, boceTimer, pruneTimer]) {
  if (timer) timer.unref?.()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close()
    store.close()
    process.exit(0)
  })
}

export { server, config }
