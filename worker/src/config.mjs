/**
 * Worker configuration. Environment only, like lib/config.mjs, but with no
 * node:fs / node:path -- a Worker has no filesystem. The one thing it cannot express is
 * the boce adapter itself: a Worker on Cloudflare's network cannot run the mainland
 * sample, so boce runs on the out-of-zone prober and reports through POST
 * /ingest/probe. What the Worker needs from it is only the *dimension* -- whether a CN
 * sample is expected, and on what cadence -- and that is the `boce` config below.
 */
import { COMPONENTS } from '../../lib/components.mjs'

export function workerConfig(env = {}) {
  const read = (key, fallback = '') => String(env[key] ?? fallback).trim()
  const num = (key, fallback) => {
    const n = Number(read(key))
    return Number.isFinite(n) && n > 0 ? n : fallback
  }

  const rawBase = read('BASE_PATH') || 'status'
  const basePath = rawBase === '/' ? '' : `/${rawBase.replace(/^\/+|\/+$/g, '')}`
  const siteUrl = (read('SITE_URL') || 'https://kiramyao.com').replace(/\/+$/, '')

  return {
    basePath,
    siteName: read('SITE_NAME') || 'KiraMyao',
    publicOrigin: (read('PUBLIC_ORIGIN') || 'https://status.kiramyao.com').replace(/\/+$/, ''),
    historyDays: num('HISTORY_DAYS', 90),
    probeIntervalMinutes: num('PROBE_INTERVAL_MINUTES', 10),

    targets: Object.fromEntries(
      COMPONENTS.filter((c) => c.local).map((c) => [c.id, read(c.envKey) || c.fallback]),
    ),
    /**
     * Per-component: must the response echo the probe nonce? True for app endpoints we
     * own; false for pure static files (Pages, Caddy file serving) that cannot reflect a
     * query parameter. This is the difference between the hard freshness proof and the
     * weaker unique-URL-plus-no-store one, so it is declared per row, not guessed.
     */
    echoNonce: Object.fromEntries(COMPONENTS.map((c) => [c.id, !!c.echoNonce])),

    stats: {
      hrt: read('HRT_STATS_URL') || 'https://api.kiramyao.com/hrt/stats',
      comments: read('COMMENTS_STATS_URL') || 'https://api.kiramyao.com/comments/stats',
      stories: read('STORIES_CATALOG_URL') || `${siteUrl}/.well-known/api-catalog.json`,
    },

    cloudflare: (() => {
      const apiToken = read('CF_ANALYTICS_TOKEN')
      const zoneTag = read('CF_ZONE_TAG')
      if (!apiToken && !zoneTag) return null
      return { apiToken, zoneTag }
    })(),

    /**
     * The CN dimension. site_cn is measured by boce's mainland nodes and arrives
     * through POST /ingest/probe, so this switch is what tells the snapshot a CN sample
     * is expected: on, it caps a day with no CN reading at amber (never a green nobody
     * measured) and gives the row the daily cadence's staleness window rather than the
     * ten-minute one. It is the same BOCE_ENABLED switch the Node service reads.
     */
    boce: {
      enabled: read('BOCE_ENABLED').toLowerCase() === 'true',
      intervalHours: num('BOCE_INTERVAL_HOURS', 24),
    },
    /**
     * The CN failure rate that counts as normal, 0..1. Unset means "use the built-in
     * default" (0.2, DEFAULT_TOLERATED_FAILURE_RATIO.boce in lib/aggregate.mjs) -- the
     * same rule lib/config.mjs applies. A hard 0 here made every routine round with one
     * unreachable province read amber, which is the crying-wolf failure the tolerance
     * exists to prevent.
     */
    cnToleratedFailureRatio: (() => {
      const raw = read('CN_TOLERATED_FAILURE_RATIO')
      if (raw === '') return undefined
      const n = Number(raw)
      return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined
    })(),

    heartbeatStaleMs: num('HEARTBEAT_STALE_MINUTES', 15) * 60_000,

    access: {
      teamDomain: read('ACCESS_TEAM_DOMAIN').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      aud: read('ACCESS_AUD'),
    },
  }
}
