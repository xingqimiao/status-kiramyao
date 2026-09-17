/**
 * Assemble the snapshot the page renders.
 *
 * One function, called on a request and again by the probe loop, reading only from
 * storage. No network here — that separation is what keeps a page view from ever
 * costing money, and it is the reason the boce adapter lives in `probe.mjs` and is
 * reachable only from the loop.
 */
import {
  buildDays, currentState, overallState, uptime,
} from './aggregate.mjs'
import { allIncidents } from './incidents.mjs'
import { COMPONENTS } from './components.mjs'

export { COMPONENTS }

/**
 * The component whose freshness the health check reports on.
 *
 * A local probe, chosen because it is the one that runs on every round — reusing
 * the CN row would make health depend on a daily paid call and report a false
 * outage for 23.5 hours of every day.
 */
export const HEALTH_COMPONENT = 'site_overseas'

/**
 * How long a reading stays current.
 *
 * Three missed rounds at the default cadence. Shorter would flap the page to grey
 * on one slow round; longer would keep showing a green from before the probe loop
 * died, which is the failure this exists to prevent.
 */
const STALE_AFTER_ROUNDS = 3

/**
 * A silence longer than this many probe intervals means we lost the loop, so a later
 * failure is a new incident rather than a continuation.
 */
const GAP_ROUNDS = 3

/**
 * A success run this short, between failures, is a flap rather than a recovery.
 * Four rounds at a 30-minute cadence is two hours.
 */
const FLAP_ROUNDS = 4

export function buildSnapshot(store, config, { now = Date.now() } = {}) {
  const windowMs = config.historyDays * 24 * 60 * 60 * 1000
  const since = now - windowMs
  const staleAfterMs = config.probeIntervalMinutes * 60_000 * STALE_AFTER_ROUNDS

  const allProbes = store.allProbes(since)
  const byComponent = new Map()
  for (const probe of allProbes) {
    if (!byComponent.has(probe.component)) byComponent.set(probe.component, [])
    byComponent.get(probe.component).push(probe)
  }

  const cnExpected = config.boce.enabled

  const components = COMPONENTS.map(({ id, label, note }) => {
    // The CN row is driven by the boce probes; every other row by the local ones.
    const probes = byComponent.get(id) ?? []
    const days = buildDays({
      overseasProbes: id === 'site_cn' ? [] : probes,
      cnProbes: id === 'site_cn' ? probes : [],
      now,
      days: config.historyDays,
      cnExpected: id === 'site_cn' ? cnExpected : false,
    })
    return {
      id,
      label,
      note,
      state: currentState(probes, { now, staleAfterMs }),
      uptime: uptime(probes),
      windowDays: config.historyDays,
      days,
    }
  })

  // The merged "is the site reachable" cell, which is what the reader actually
  // wants and what `mergeDay` exists for: a day China could not reach is not a
  // green day even if Singapore could.
  const mergedDays = buildDays({
    overseasProbes: byComponent.get('site_overseas') ?? [],
    cnProbes: byComponent.get('site_cn') ?? [],
    now,
    days: config.historyDays,
    cnExpected,
  })

  const incidents = allIncidents(
    Object.fromEntries(byComponent),
    {
      // Expressed in missed rounds rather than absolute time, so the bound means the
      // same thing whatever cadence the operator sets: three missed probes is a gap
      // in our watching, whatever "three probes" happens to be worth in minutes.
      gapMs: config.probeIntervalMinutes * 60_000 * GAP_ROUNDS,
      flapMs: config.probeIntervalMinutes * 60_000 * FLAP_ROUNDS,
    },
  ).map((i) => ({
    ...i,
    label: COMPONENTS.find((c) => c.id === i.component)?.label ?? i.component,
  }))

  return {
    generatedAt: now,
    overall: overallState(components.map((c) => c.state)),
    components,
    mergedDays,
    incidents,
    guardian: buildGuardian(store, config, { now }),
  }
}

/**
 * The data-guardian figures.
 *
 * `availability` is derived from this service's own probe history rather than from
 * an uptime counter, so a redeploy does not reset it to zero — the handoff calls
 * that out, and a counter in memory would be exactly that bug. It answers "was this
 * service reachable", which is the promise the page is making.
 */
function buildGuardian(store, config, { now }) {
  const accounts = store.latestMetric('hrt.accounts')
  const selfDeletions = store.latestMetric('hrt.self_deletions')
  const commentUsers = store.latestMetric('comments.users')
  const comments = store.latestMetric('comments.comments')
  const stories = store.latestMetric('stories.preserved')

  // Continuous availability, from our own probe history. It answers "was this
  // service reachable", which is the promise the page makes — and because it is
  // computed from stored probes rather than an in-memory counter, a redeploy does
  // not reset it to zero.
  const windowMs = config.historyDays * 24 * 60 * 60 * 1000
  const own = store.probesFor(HEALTH_COMPONENT, now - windowMs)
  const availability = uptime(own)

  return {
    accounts: asNumber(accounts),
    selfDeletions: asNumber(selfDeletions),
    commentUsers: asNumber(commentUsers),
    comments: asNumber(comments),
    stories: asNumber(stories),
    availability: availability === null ? null : `${(availability * 100).toFixed(3)}%`,
    availabilityHint: availability === null
      ? '尚无足够的探测记录'
      : `最近 ${config.historyDays} 天本页探测成功率`,
  }
}

/**
 * A metric's value, or null.
 *
 * Null rather than 0 for a missing metric, and the page renders "—": the difference
 * between "zero users" and "we could not read the number" is the difference between
 * a fact and a fabrication, and only one of them belongs on a status page.
 */
function asNumber(entry) {
  if (!entry || entry.value === null || entry.value === undefined) return null
  const n = Number(entry.value)
  return Number.isFinite(n) ? n : null
}
