import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { COMPONENTS } from './components.mjs'

/**
 * Configuration comes from the environment only. `.env` is loaded when present so
 * the systemd unit can ship secrets separately from the code — same convention as
 * the comment service next door, deliberately, because these two are deployed to
 * the same box by the same operator.
 */
export function loadConfig(env = process.env, { rootDir = process.cwd() } = {}) {
  const envFile = resolve(rootDir, '.env')
  if (existsSync(envFile) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envFile)
    } catch {
      // Fall through: the defaults below are all usable without a .env, and a
      // malformed file should not stop the service from rendering what history
      // it already has.
    }
  }

  const read = (key) => (env[key] ?? process.env[key] ?? '').trim()
  const num = (key, fallback) => {
    const value = Number(read(key))
    return Number.isFinite(value) && value > 0 ? value : fallback
  }

  // The service mounts under its own prefix so other services on the shared origin
  // can take their own namespaces. Set BASE_PATH=/ to mount at the root.
  const rawBase = read('BASE_PATH') || 'status'
  const basePath = rawBase === '/' ? '' : `/${rawBase.replace(/^\/+|\/+$/g, '')}`

  const siteUrl = (read('SITE_URL') || 'https://kiramyao.com').replace(/\/+$/, '')

  // boce is the only paid component, so it has its own switch rather than being
  // implied by whether a key happens to be present: an operator has to be able to
  // turn the CN column off without deleting the key.
  const boceEnabled = read('BOCE_ENABLED').toLowerCase() === 'true'
  const boceKey = read('BOCE_API_KEY')

  return {
    // 8787 is the comment service and 8788 is the HRT Core, both on this box. The
    // default has to avoid both — it did not at first, and the collision only
    // showed up when the service was started next to a running Core.
    port: num('PORT', 8789),
    host: read('HOST') || '127.0.0.1',
    basePath,
    siteName: read('SITE_NAME') || 'Kira Status',
    publicOrigin: (read('PUBLIC_ORIGIN') || 'https://status.kiramyao.com').replace(/\/+$/, ''),
    dataFile: resolve(rootDir, read('DATA_FILE') || 'data/status.sqlite'),

    /**
     * The local probe targets, keyed by *component id* — the same ids the snapshot
     * renders, taken from the shared register so the two cannot drift.
     */
    targets: Object.fromEntries(
      COMPONENTS.filter((c) => c.local).map((c) => [c.id, read(c.envKey) || c.fallback]),
    ),

    /** Where the data-guardian figures come from. */
    stats: {
      hrt: read('HRT_STATS_URL') || 'https://api.kiramyao.com/hrt/stats',
      comments: read('COMMENTS_STATS_URL') || 'https://api.kiramyao.com/comments/stats',
      stories: read('STORIES_CATALOG_URL') || `${siteUrl}/.well-known/api-catalog.json`,
    },

    probeIntervalMinutes: num('PROBE_INTERVAL_MINUTES', 30),
    historyDays: num('HISTORY_DAYS', 90),

    boce: {
      enabled: boceEnabled && boceKey !== '',
      apiKey: boceKey,
      apiUrl: (read('BOCE_API_URL') || 'https://api.boce.com/v3').replace(/\/+$/, ''),
      targetUrl: read('BOCE_TARGET_URL') || `${siteUrl}/`,
      // `auto` means "let the adapter pick a spread across the three carriers".
      nodes: read('BOCE_NODES') || 'auto',
      intervalHours: num('BOCE_INTERVAL_HOURS', 24),
      // Polling an async task. The docs suggest 10s up to 2 minutes.
      pollIntervalMs: num('BOCE_POLL_INTERVAL_MS', 5_000),
      pollTimeoutMs: num('BOCE_POLL_TIMEOUT_MS', 120_000),
    },
  }
}
