/**
 * Assemble the snapshot the page renders.
 *
 * One function, called on a request and again by the probe loop, reading only from
 * storage. No network here — that separation is what keeps a page view from ever
 * costing money, and it is the reason the boce adapter lives in `probe.mjs` and is
 * reachable only from the loop.
 */
import {
  DEFAULT_TOLERATED_FAILURE_RATIO, buildDays, currentState, overallState, uptime,
} from './aggregate.mjs'
import { deriveIncidents } from './incidents.mjs'
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
 * How long a reading stays current: three missed rounds of that component's *own*
 * cadence.
 *
 * Per component, not global. The CN row is sampled daily while everything else is
 * sampled every 30 minutes, so a single window derived from `probeIntervalMinutes`
 * gave the daily row 90 minutes to be current in — it could never be, and the row read
 * grey for 23.5 hours a day, which is the opposite of what a daily probe is for.
 */
const STALE_AFTER_ROUNDS = 3

/** The milliseconds a component may go without a reading before it reads `grey`. */
function staleAfterFor(component, config) {
  const cadenceMinutes = component.source === 'boce'
    ? config.boce.intervalHours * 60
    : config.probeIntervalMinutes
  return cadenceMinutes * 60_000 * STALE_AFTER_ROUNDS
}

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

/**
 * Drop the failures that fall inside a component's tolerated rate.
 *
 * Incidents are derived from probes, so without this a normal CN round — 2 of 28 nodes
 * failing, which is Tuesday — opens one. The nodes are still recorded and still counted
 * in uptime; what changes is that they do not become a *fault*.
 */
function incidentProbes(probes, tolerance) {
  if (tolerance === 0) return probes
  const byRound = new Map()
  for (const p of probes) {
    if (!byRound.has(p.at)) byRound.set(p.at, [])
    byRound.get(p.at).push(p)
  }
  const toleratedRounds = new Set()
  for (const [at, round] of byRound) {
    const failed = round.filter((r) => !r.ok).length
    if (failed / round.length <= tolerance) toleratedRounds.add(at)
  }
  return probes.filter((p) => p.ok || !toleratedRounds.has(p.at))
}

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

  // Env override so the tolerated CN failure rate can be tuned on the box without a
  // code change; the default is derived from the probe source, since that is what
  // decides whether failures are expected.
  const toleratedFor = (component) => {
    const base = DEFAULT_TOLERATED_FAILURE_RATIO[component.source] ?? 0
    if (component.source !== 'boce') return base
    const override = Number(config.cnToleratedFailureRatio)
    return Number.isFinite(override) && override >= 0 && override <= 1 ? override : base
  }

  const components = COMPONENTS.map((component) => {
    const { id, label, note } = component
    // The CN row is driven by the boce probes; every other row by the local ones.
    const probes = byComponent.get(id) ?? []
    const tolerance = toleratedFor(component)
    const days = buildDays({
      overseasProbes: id === 'site_cn' ? [] : probes,
      cnProbes: id === 'site_cn' ? probes : [],
      now,
      days: config.historyDays,
      cnExpected: id === 'site_cn' ? cnExpected : false,
      // For a site row the "overseas" reading *is* this component's own reading, so
      // the same tolerance applies to it.
      overseasTolerance: id === 'site_cn' ? 0 : tolerance,
      cnTolerance: id === 'site_cn' ? tolerance : 0,
    })
    return {
      id,
      label,
      note,
      state: currentState(probes, { now, staleAfterMs: staleAfterFor(component, config), toleratedRatio: tolerance }),
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
    overseasTolerance: 0,
    cnTolerance: DEFAULT_TOLERATED_FAILURE_RATIO.boce,
  })

  // Both bounds are in *missed rounds*, so third parties beyond the comment service
  // keep working whatever cadence an operator sets — and per component, because the CN
  // row runs on a daily cadence. A single 30-minute-derived window put the daily row's
  // outage cutoff at 90 minutes, so a routine CN failure was reported as a two-day
  // outage the moment the next day's probe arrived.
  const cadenceFor = (component) => (component.source === 'boce'
    ? config.boce.intervalHours * 60
    : config.probeIntervalMinutes)

  const boundsFor = (component) => {
    const cadenceMinutes = cadenceFor(component)
    return {
      gapMs: cadenceMinutes * 60_000 * GAP_ROUNDS,
      flapMs: cadenceMinutes * 60_000 * FLAP_ROUNDS,
    }
  }

  const labelled = (list) => list.map((i) => {
    const component = COMPONENTS.find((c) => c.id === i.component)
    return {
      ...i,
      label: component?.label ?? i.component,
      // The view needs the cadence to describe an unresolved incident honestly: a
      // sample taken once a day is a spot check, and rendering it as 「持续中」 claims
      // a live watch that does not exist.
      intervalMinutes: component ? cadenceFor(component) : config.probeIntervalMinutes,
    }
  })

  // Derived per component so each gets its own cadence, then merged. `allIncidents`
  // takes one options object for every component it is handed, which is what made a
  // single global bound wrong.
  const incidents = labelled(
    COMPONENTS.flatMap((component) => {
      const probes = byComponent.get(component.id)
      if (!probes || probes.length === 0) return []
      return deriveIncidents(
        incidentProbes(probes, toleratedFor(component)),
        { component: component.id, ...boundsFor(component) },
      )
    }),
  ).sort((a, b) => b.startedAt - a.startedAt)

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
  // Edge visits, last 24h, per hostname. Absent unless Cloudflare is configured,
  // and then they render as "—" — the same rule as every other metric.
  const visitsSite = store.latestMetric('visits.site')
  const visitsTracker = store.latestMetric('visits.tracker')

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
    visitsSite: asNumber(visitsSite),
    visitsTracker: asNumber(visitsTracker),
    visitsHint: config.cloudflare ? '最近 24 小时，来自 Cloudflare 边缘统计' : '',
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
