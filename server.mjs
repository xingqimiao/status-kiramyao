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
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { loadConfig } from './lib/config.mjs'
import { openDb, createStore } from './lib/db.mjs'
import {
  runLocalProbes, runBoceProbe, readHrtStats, readCommentsStats, readStoryCount,
  readCloudflareVisits, nextBoceDelayMs,
} from './lib/probe.mjs'
import { buildSnapshot, HEALTH_COMPONENT } from './lib/snapshot.mjs'
import { renderPage, renderHistory, renderRobots, renderSitemap } from './lib/view.mjs'
// The one day boundary both the page and the spend guard use. Keeping it a single
// imported function is what stops the guard from cutting "today" differently from
// the cell the reader sees.
import { startOfStatusDay } from './lib/aggregate.mjs'

const config = loadConfig()
const db = openDb(config.dataFile)
const store = createStore(db)

let currentSnapshot = buildSnapshot(store, config)

/**
 * The only files this service serves as files.
 *
 * Everything else is inlined in the one self-contained document. A favicon cannot
 * be inlined without changing the policy to allow `data:`, so the four sizes live
 * on disk and are read once at boot: a request never touches the disk, the same
 * way it never touches the network. Missing files are simply not routed, so a
 * checkout without the assets still boots and renders.
 */
const STATIC_DIR = resolve(import.meta.dirname, 'static')
const STATIC_FILES = new Map(
  [
    ['/favicon-32.png', 'favicon-32.png'],
    ['/apple-touch-icon.png', 'apple-touch-icon.png'],
    ['/icon-192.png', 'icon-192.png'],
    ['/icon-512.png', 'icon-512.png'],
  ]
    .map(([route, name]) => [route, resolve(STATIC_DIR, name)])
    .filter(([, full]) => existsSync(full))
    .map(([route, full]) => [route, readFileSync(full)]),
)

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
      store.addMetric('hrt.doses', hrt.doses, now)
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
    // Cloudflare edge visits. Optional: with no credentials this block is skipped
    // rather than failing, and the page shows "—" because the value is absent rather
    // than zero — the same rule the other metrics follow.
    if (config.cloudflare) {
      const visits = await readCloudflareVisits(config.cloudflare, { now })
      if (visits.ok) {
        store.addMetric('visits.site', visits.site, now)
        store.addMetric('visits.tracker', visits.tracker, now)
      } else {
        process.stderr.write(`cloudflare visits unavailable: ${visits.error}\n`)
      }
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

  // The favicon set. Same-origin, so `img-src 'self'` already permits them and
  // the policy does not move. Cached hard: the bytes only change when the file
  // changes, which is a deploy.
  const icon = STATIC_FILES.get(path)
  if (icon) {
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': icon.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ...SECURITY_HEADERS,
    })
    res.end(icon)
    return
  }

  if (path === '/robots.txt') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      ...SECURITY_HEADERS,
    })
    res.end(renderRobots(config))
    return
  }

  if (path === '/sitemap.xml') {
    res.writeHead(200, {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      ...SECURITY_HEADERS,
    })
    res.end(renderSitemap(config))
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

/**
 * Schedule the CN round, chaining rather than repeating.
 *
 * `setInterval` cannot express "every day at midnight" once daylight saving or a clock
 * correction is in play: a fixed 24-hour period slides an hour twice a year and never
 * comes back. Recomputing the delay after each round keeps the target pinned to the wall
 * clock, which is what an operator asking for "0点跑一次" actually means.
 */
let boceTimer = null

/**
 * Whether a CN sample was already taken today, so a second one is not bought.
 *
 * "Today" is the same fixed GMT+8 day the page draws (`startOfStatusDay`), not the
 * host's midnight. On a host in another zone the two disagree, and the wrong one
 * either buys a second sample for a day the page already shows or skips the one it
 * is waiting for — this call is the one that costs money.
 */
function boceRanToday(now = Date.now()) {
  const startOfDay = startOfStatusDay(now)
  const newest = store.latestFor('site_cn')
  return newest !== null && newest.at >= startOfDay
}

function scheduleBoce() {
  if (!config.boce.enabled) return
  const delayMs = nextBoceDelayMs(config.boce.hourOfDay, config.boce.minuteOfHour)
  boceTimer = setTimeout(async () => {
    // Guard against a manual round (or an unusual restart) having already sampled
    // today. The schedule being wall-clock-aligned makes a double-spend unlikely
    // rather than impossible, and this is the call that costs money.
    if (boceRanToday()) {
      process.stdout.write('boce: today already has a sample, not spending another\n')
    } else {
      await boceRound()
    }
    scheduleBoce()
  }, delayMs)
  // Deliberately NOT unref'd. It was, and the daily round stopped happening: an
  // unref'd timer does not hold the event loop open, so while the process stays busy
  // with the 30-minute probe loop this one can be pushed past its hour indefinitely —
  // the journal shows the CN sample running on Sep 18 and Sep 19 and then nothing,
  // with the process up the whole time. The cost of holding the loop open is nothing
  // (the local probe loop already keeps the process alive), and the cost of losing a
  // day is a grey cell on the page.
  process.stdout.write(
    `boce: next CN sample in ${Math.round(delayMs / 60_000)}m (daily at ${String(config.boce.hourOfDay).padStart(2, '0')}:${String(config.boce.minuteOfHour).padStart(2, '0')} local)\n`,
  )
}

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `kira-status listening on ${config.host}:${config.port}${config.basePath || '/'}`
    + ` (probe every ${config.probeIntervalMinutes}m, boce ${config.boce.enabled ? 'on' : 'off'})\n`,
  )
  // Probe immediately on boot: a fresh deploy should show something other than a
  // page of grey within seconds, not in half an hour. The local probes are free, so
  // this is unconditional.
  void localProbeRound()
  void metricsRound()
  // A cold start with no CN sample at all should not wait until midnight to draw one;
  // that is the old "page of grey" problem on a brand-new deploy. A restart that
  // already has today's sample does nothing, which is what keeps the budget safe.
  if (config.boce.enabled && store.latestFor('site_cn') === null) void boceRound()
  scheduleBoce()
})

const probeTimer = setInterval(localProbeRound, config.probeIntervalMinutes * 60_000)
const metricsTimer = setInterval(metricsRound, config.probeIntervalMinutes * 60_000)
// Daily, at a time nothing else is happening.
const pruneTimer = setInterval(prune, 24 * 60 * 60 * 1000)

for (const timer of [probeTimer, metricsTimer, pruneTimer]) {
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
