/**
 * The snapshot, assembled from D1 aggregates.
 *
 * lib/snapshot.mjs is still the Node service's assembler and is unchanged. This is the
 * Worker's, and it exists only because the storage read is a different shape: it takes
 * day counts, the newest round, collapsed runs and the metrics instead of raw probe
 * arrays. Every *rule* is imported, not re-implemented -- mergeDay/stateFromCounts/
 * overallState from lib/aggregate.mjs, incidentsFromRuns from lib/incidents.mjs, the
 * component register from lib/components.mjs -- and worker/test/port.test.mjs feeds the
 * same seeded database through both assemblers and asserts they agree field for field.
 */
import {
  DEFAULT_TOLERATED_FAILURE_RATIO, measuredWindowDays, mergeDay, overallState, stateFromCounts,
  STATUS_UTC_OFFSET_MS,
} from '../../lib/aggregate.mjs'
import { incidentsFromRuns } from '../../lib/incidents.mjs'
import { COMPONENTS } from '../../lib/components.mjs'
import { overlayManual } from './manual.mjs'

export { COMPONENTS }

const DAY_MS = 24 * 60 * 60 * 1000

/** The component whose freshness the health check reports on. Same choice as lib/snapshot.mjs. */
export const HEALTH_COMPONENT = 'site_overseas'

const STALE_AFTER_ROUNDS = 3
const GAP_ROUNDS = 3
const FLAP_ROUNDS = 4

const dayIndexOf = (atMs) => Math.floor((atMs + STATUS_UTC_OFFSET_MS) / DAY_MS)
const dayKeyOfIndex = (i) => new Date(i * DAY_MS).toISOString().slice(0, 10)

/** The same per-component tolerated failure rate lib/snapshot.mjs derives. */
function toleratedFor(component, config) {
  const base = DEFAULT_TOLERATED_FAILURE_RATIO[component.source] ?? 0
  if (component.source !== 'boce') return base
  const override = Number(config.cnToleratedFailureRatio)
  return Number.isFinite(override) && override >= 0 && override <= 1 ? override : base
}

/** Rounds per component: a daily row and a 10-minute row do not go stale on the same clock. */
const cadenceFor = (component, config) => (component.source === 'boce'
  ? config.boce.intervalHours * 60
  : config.probeIntervalMinutes)

/**
 * Read everything the snapshot needs, in parallel, bounded.
 *
 * Six queries, one of which (failedProbes) is empty on a healthy window. Nothing here
 * is proportional to the full history.
 */
export async function loadSnapshotData(store, config, { now = Date.now() } = {}) {
  const since = now - config.historyDays * DAY_MS
  const [dayCounts, rounds, runs, failed, metrics, events] = await Promise.all([
    store.dayCounts(since, STATUS_UTC_OFFSET_MS),
    store.newestRounds(since),
    store.runs(since),
    store.failedProbes(since),
    store.latestMetrics(),
    store.listEvents(50),
  ])
  return {
    since, dayCounts, rounds, runs, failed, metrics, events,
  }
}

export async function buildWorkerSnapshot(store, config, opts = {}) {
  return assembleSnapshot(await loadSnapshotData(store, config, opts), config, opts)
}

export function assembleSnapshot(data, config, { now = Date.now() } = {}) {
  const {
    dayCounts = [], rounds = [], runs = [], failed = [], events = [],
  } = data
  const metrics = data.metrics instanceof Map ? data.metrics : new Map()

  // component -> dayIndex -> {total, ok}, plus the earliest day each one was probed:
  // the span a figure covers is computed from that, never from the configured window.
  const daysBy = new Map()
  const totalsBy = new Map()
  const firstIndexBy = new Map()
  for (const row of dayCounts) {
    if (!daysBy.has(row.component)) daysBy.set(row.component, new Map())
    const idx = Number(row.day_index)
    daysBy.get(row.component).set(idx, { total: Number(row.total), ok: Number(row.ok) })
    const first = firstIndexBy.get(row.component)
    if (first === undefined || idx < first) firstIndexBy.set(row.component, idx)
    const t = totalsBy.get(row.component) ?? { total: 0, ok: 0 }
    t.total += Number(row.total)
    t.ok += Number(row.ok)
    totalsBy.set(row.component, t)
  }
  const todayIndex = dayIndexOf(now)
  const roundBy = new Map(rounds.map((r) => [r.component, r]))
  const runsBy = new Map()
  for (const r of runs) {
    if (!runsBy.has(r.component)) runsBy.set(r.component, [])
    runsBy.get(r.component).push(r)
  }
  const failedBy = new Map()
  for (const f of failed) {
    if (!failedBy.has(f.component)) failedBy.set(f.component, [])
    failedBy.get(f.component).push(f)
  }

  const cnExpected = config.boce.enabled

  const components = COMPONENTS.map((component) => {
    const { id, label, note } = component
    const tolerance = toleratedFor(component, config)
    const isCn = id === 'site_cn'
    const staleAfterMs = cadenceFor(component, config) * 60_000 * STALE_AFTER_ROUNDS
    const dayMap = daysBy.get(id)
    const totals = totalsBy.get(id)

    const days = []
    for (let i = config.historyDays - 1; i >= 0; i--) {
      const idx = dayIndexOf(now - i * DAY_MS)
      const cnt = dayMap?.get(idx)
      // Same wiring as lib/snapshot.mjs: the CN row is driven by CN probes and has no
      // overseas reading; every other row is the reverse.
      const overseas = isCn ? 'grey' : (cnt ? stateFromCounts(cnt.ok, cnt.total, tolerance) : 'grey')
      const cn = isCn ? (cnt ? stateFromCounts(cnt.ok, cnt.total, tolerance) : 'grey') : 'grey'
      days.push({
        day: dayKeyOfIndex(idx),
        state: mergeDay({ overseas, cn, cnExpected: isCn ? cnExpected : false }),
        overseas,
        cn,
      })
    }

    const round = roundBy.get(id)
    let state = 'grey'
    if (round && !(staleAfterMs && now - Number(round.at) > staleAfterMs)) {
      state = stateFromCounts(Number(round.ok), Number(round.total), tolerance)
    }

    return {
      id,
      label,
      note,
      state,
      uptime: totals && totals.total > 0 ? totals.ok / totals.total : null,
      // How much of the window this row actually covers -- a row that started later
      // than the page says its own span, not the page's.
      windowDays: measuredWindowDays(firstIndexBy.get(id), todayIndex, config.historyDays),
      days,
    }
  })

  // The merged strip: the overseas reading capped by the CN sample. When no CN sample is
  // expected (BOCE_ENABLED unset) cnExpected is false and this is the overseas reading
  // alone -- an operator who chose not to ask, not a "no data". When it is expected, a
  // day with no sample is capped at amber rather than read green.
  const mergedDays = []
  const overseasDays = daysBy.get('site_overseas')
  const cnDays = daysBy.get('site_cn')
  for (let i = config.historyDays - 1; i >= 0; i--) {
    const idx = dayIndexOf(now - i * DAY_MS)
    const o = overseasDays?.get(idx)
    const c = cnDays?.get(idx)
    const overseas = o ? stateFromCounts(o.ok, o.total, 0) : 'grey'
    const cn = c ? stateFromCounts(c.ok, c.total, DEFAULT_TOLERATED_FAILURE_RATIO.boce) : 'grey'
    mergedDays.push({ day: dayKeyOfIndex(idx), state: mergeDay({ overseas, cn, cnExpected }), overseas, cn })
  }

  // Incidents, per component, over runs collapsed in SQL. Rebuild the run objects the
  // shared rule expects (probes carry the failures' errors; successes only need a count).
  const incidents = COMPONENTS.flatMap((component) => {
    const compRuns = runsBy.get(component.id) ?? []
    if (compRuns.length === 0) return []
    const cadenceMinutes = cadenceFor(component, config)
    const compFailed = failedBy.get(component.id) ?? []
    let cursor = 0
    const runsWithProbes = compRuns.map((r) => {
      const n = Number(r.n)
      if (r.ok) {
        return { ok: true, from: Number(r.from_at), lastAt: Number(r.last_at), probes: Array.from({ length: n }, () => ({ ok: true })) }
      }
      const probes = compFailed.slice(cursor, cursor + n)
        .map((p) => ({ at: Number(p.at), ok: false, error: p.error ?? null }))
      cursor += n
      return { ok: false, from: Number(r.from_at), lastAt: Number(r.last_at), probes }
    })
    return incidentsFromRuns(runsWithProbes, {
      component: component.id,
      gapMs: cadenceMinutes * 60_000 * GAP_ROUNDS,
      flapMs: cadenceMinutes * 60_000 * FLAP_ROUNDS,
    })
  }).map((i) => {
    const component = COMPONENTS.find((c) => c.id === i.component)
    return {
      ...i,
      label: component?.label ?? i.component,
      intervalMinutes: component ? cadenceFor(component, config) : config.probeIntervalMinutes,
    }
  }).sort((a, b) => b.startedAt - a.startedAt)

  const probeOverall = overallState(components.map((c) => c.state))
  const active = events.find((e) => e.resolvedAt == null) ?? null
  const lastResolved = events.find((e) => e.resolvedAt != null) ?? null
  const probeNewestAt = rounds.length > 0 ? Math.max(...rounds.map((r) => Number(r.at))) : null
  const { overall, manualState, mismatch } = overlayManual(probeOverall, active, lastResolved, { now, probeNewestAt })

  // The page's own span: the earliest reading any row has. The section header and the
  // incident window describe the period the page actually covers; a row that started
  // later still reports its own, shorter span.
  const allFirstIndexes = [...firstIndexBy.values()]
  const windowDays = allFirstIndexes.length > 0
    ? measuredWindowDays(Math.min(...allFirstIndexes), todayIndex, config.historyDays)
    : 0

  return {
    generatedAt: now,
    overall,
    // The probe verdict is always carried, even when a manual declaration outranks it.
    probeOverall,
    windowDays,
    manual: {
      active: active
        ? {
          id: active.id,
          severity: active.severity,
          state: manualState,
          reason: active.reason,
          startedAt: active.startedAt,
          createdBy: active.createdBy,
        }
        : null,
      state: manualState,
      mismatch,
      probeState: probeOverall,
    },
    components,
    mergedDays,
    incidents,
    guardian: buildGuardian(metrics, totalsBy.get(HEALTH_COMPONENT), config, {
      now,
      // The same day counts `availability` is computed from, so the number and its
      // label cannot cover different periods.
      availabilityDays: measuredWindowDays(
        firstIndexBy.get(HEALTH_COMPONENT), todayIndex, config.historyDays,
      ),
    }),
  }
}

/**
 * The data-guardian figures, from the newest metric row per key.
 *
 * The origin heartbeat is folded in here rather than given its own table: it writes
 * fixed metric keys, so it can never become a second content channel, and a stale
 * heartbeat renders "—" like every other unreadable number.
 */
function buildGuardian(metrics, healthTotals, config, { now, availabilityDays = 0 }) {
  const value = (key) => (metrics.get(key) ? metrics.get(key).value : null)

  const availability = healthTotals && healthTotals.total > 0
    ? healthTotals.ok / healthTotals.total
    : null

  const heartbeatAt = asNumber(value('origin.heartbeat_at'))
  const fresh = heartbeatAt !== null && now - heartbeatAt <= config.heartbeatStaleMs
  const postgresOk = fresh ? asNumber(value('origin.postgres_ok')) : null
  const postgresLatency = fresh ? asNumber(value('origin.postgres_latency_ms')) : null
  const diskUsed = fresh ? asNumber(value('origin.disk_used_pct')) : null
  const diskFree = fresh ? asNumber(value('origin.disk_free_gb')) : null

  return {
    accounts: asNumber(value('hrt.accounts')),
    selfDeletions: asNumber(value('hrt.self_deletions')),
    commentUsers: asNumber(value('comments.users')),
    comments: asNumber(value('comments.comments')),
    stories: asNumber(value('stories.preserved')),
    visitsSite: asNumber(value('visits.site')),
    visitsTracker: asNumber(value('visits.tracker')),
    visitsHint: config.cloudflare ? '最近 24 小时' : '',
    availability: availability === null ? null : `${(availability * 100).toFixed(3)}%`,
    // Carried as a number too, so copy that names the figure (the page description)
    // states the same span as the hint rather than a different one.
    availabilityDays,
    // The span comes from the days behind the figure, not from the configured window:
    // a service four days old must not print "最近 90 天".
    availabilityHint: availability === null
      ? '尚无足够的探测记录'
      : `最近 ${availabilityDays} 天本页探测成功率`,
    // Facts only the origin can see. null when the heartbeat is absent or stale.
    origin: {
      stale: !fresh,
      postgresOk: postgresOk === null ? null : postgresOk === 1,
      postgresLatencyMs: postgresLatency,
      diskUsedPct: diskUsed,
      diskFreeGb: diskFree,
    },
  }
}

function asNumber(entry) {
  if (entry === null || entry === undefined) return null
  const n = Number(entry)
  return Number.isFinite(n) ? n : null
}
