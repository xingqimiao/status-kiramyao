/**
 * The Worker entry point: the public page, the admin, the heartbeat, and the cron.
 *
 * The Node service stays untouched and running; this is the parallel implementation the
 * origin swaps onto once verified. The page render is the same lib/view.mjs the Node
 * service uses, so the rows, wording and footer cannot drift.
 */
import { workerConfig } from './config.mjs'
import { createD1Store } from './db.mjs'
import { buildWorkerSnapshot, HEALTH_COMPONENT } from './snapshot.mjs'
import { runWorkerMetricsRound } from './probe.mjs'
import { handleAdmin } from './admin.mjs'
import { handleHeartbeat } from './heartbeat.mjs'
import { handleProbeIngest } from './ingest.mjs'
import {
  SECURITY_HEADERS, json, text, html, stripBasePath,
} from './http.mjs'
import {
  renderPage, renderHistory, renderRobots, renderSitemap,
} from '../../lib/view.mjs'

const DAY_MS = 24 * 60 * 60 * 1000

/** Served by the [assets] binding; listed so a checkout without it still 404s cleanly. */
const ICON_PATHS = new Set([
  '/favicon-32.png', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png',
])

export default {
  async fetch(request, env, ctx) {
    const config = workerConfig(env)
    const store = createD1Store(env.DB)
    const url = new URL(request.url)
    const path = stripBasePath(url.pathname, config)
    if (path === null) return text(404, 'not found')

    // Admin first, and only ever through the verified handler. No redirect here: a
    // failed assertion is a 403.
    if (path === '/admin' || path.startsWith('/admin/')) {
      return handleAdmin(request, env, config, store)
    }

    if (path === '/heartbeat') {
      if (request.method !== 'POST') return text(405, 'method not allowed', { Allow: 'POST' })
      return handleHeartbeat(request, env, config, store)
    }

    // The out-of-zone prober's report. Its own bearer token and its own closed schema;
    // a bad token is a 401 response, never a redirect.
    if (path === '/ingest/probe') {
      if (request.method !== 'POST') return text(405, 'method not allowed', { Allow: 'POST' })
      return handleProbeIngest(request, env, store, config)
    }

    if (path === '/health') return health(config, store)

    if (path === '/') {
      const snapshot = await buildWorkerSnapshot(store, config)
      const wantsHtml = (request.headers.get('Accept') ?? '').includes('text/html')
      const cache = { 'Cache-Control': 'public, max-age=60' }
      if (!wantsHtml) return json(200, snapshot, cache)
      return html(200, renderPage(snapshot, config), cache)
    }

    if (path === '/history.json') {
      const snapshot = await buildWorkerSnapshot(store, config)
      return new Response(renderHistory(snapshot, config), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60', ...SECURITY_HEADERS },
      })
    }

    if (path === '/robots.txt') return text(200, renderRobots(config), { 'Cache-Control': 'public, max-age=3600' })
    if (path === '/sitemap.xml') {
      return new Response(renderSitemap(config), {
        status: 200,
        headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600', ...SECURITY_HEADERS },
      })
    }

    if (ICON_PATHS.has(path)) {
      if (env.ASSETS) return env.ASSETS.fetch(request)
      return text(404, 'not found')
    }

    return text(404, 'not found')
  },

  /**
   * Every ten minutes. Each job is independently guarded, the same way server.mjs
   * guards its loops: a failing job must not stop the others, and nothing here blocks
   * the page rendering (which happens per request and never here).
   *
   * There is deliberately NO inbound probe round. A Worker subrequest to a hostname in
   * its own zone that proxies to a real origin times out, so every run recorded a fixed
   * set of false reds -- fabricated failures accumulating in D1 every ten minutes. The
   * measurement now comes from an out-of-zone prober through POST /ingest/probe
   * (worker/src/ingest.mjs); the cron records only what it can actually observe.
   * runWorkerProbeRound is kept for the freshness tests, which run against a local
   * origin and never against the zone.
   */
  async scheduled(controller, env, ctx) {
    const config = workerConfig(env)
    const store = createD1Store(env.DB)
    const now = Date.now()

    try {
      await runWorkerMetricsRound(store, config, { now })
    } catch (error) {
      console.error('metrics round failed: ' + (error?.message ?? error))
    }

    try {
      await store.prune(now - config.historyDays * DAY_MS)
    } catch (error) {
      console.error('prune failed: ' + (error?.message ?? error))
    }
  },
}

/**
 * Liveness, reporting the age of the newest probe rather than just "ok" -- a Worker
 * that is up but whose cron stopped is not healthy. Same shape as the Node route.
 */
async function health(config, store, now = Date.now()) {
  const newest = await store.latestProbe(HEALTH_COMPONENT)
  const ageMs = newest ? now - Number(newest.at) : null
  const healthy = ageMs !== null && ageMs < config.probeIntervalMinutes * 60_000 * 3
  return json(healthy ? 200 : 503, {
    ok: healthy,
    service: 'status',
    newest_probe_age_ms: ageMs,
    boce_enabled: config.boce.enabled,
  })
}
