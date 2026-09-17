/**
 * Incidents, derived from the probe history.
 *
 * There is no admin UI for filing an incident in v1, and that is a deliberate
 * simplification rather than an omission: the probes already know when something
 * broke, and the honest record is the one the monitoring wrote rather than the one
 * somebody remembered to type. A manual UI can layer on top later.
 *
 * An incident is a run of failed probes for one component, closed by a recovery.
 * The implementation collapses the probes into runs first rather than carrying
 * lookahead state through the loop — "a short success between two failures is a
 * flap, not a recovery" is trivial to express over runs and error-prone over
 * individual probes, which is how the first version of this file managed to make a
 * one-probe blip end an incident.
 */

/** Silences longer than this close an incident regardless of what comes next. */
const DEFAULT_GAP_MS = 2 * 60 * 60 * 1000

/**
 * A success run shorter than this, sitting between two failures, is absorbed into
 * the incident. At a 30-minute cadence that is one probe: a service flapping once
 * is briefly up, and reporting the blip as a recovery would split one incident
 * into a pair and make a ten-minute wobble look like a bad week.
 */
const DEFAULT_FLAP_MS = 30 * 60 * 1000

/**
 * Split a time-ordered probe list into runs of the same state, broken by silences.
 *
 * The gap break is load-bearing and was missing from the first version of this
 * file: grouping on `ok` alone merges a failure now with a failure six hours later
 * into one run, and the incident then claims six hours of outage across a period
 * nobody was watching. A silence longer than `maxGapMs` ends the run whatever the
 * next probe says.
 */
function toRuns(probes, maxGapMs) {
  const sorted = [...probes].sort((a, b) => a.at - b.at)
  const runs = []
  for (const probe of sorted) {
    const last = runs[runs.length - 1]
    const continuityBroken = last && probe.at - last.lastAt > maxGapMs
    if (last && last.ok === probe.ok && !continuityBroken) {
      last.probes.push(probe)
      last.lastAt = probe.at
    } else {
      runs.push({ ok: probe.ok, from: probe.at, lastAt: probe.at, probes: [probe] })
    }
  }
  return runs
}

/**
 * Derive incidents for one component.
 *
 * `gapMs` bounds what counts as continuous: if no probe arrived for longer than
 * this, we cannot claim to have been watching across the silence, so a later
 * failure starts a new incident rather than extending the old one. That is what
 * stops a two-day outage in the probe loop from being reported as one two-day
 * service failure.
 */
export function deriveIncidents(probes, {
  component,
  gapMs = DEFAULT_GAP_MS,
  flapMs = DEFAULT_FLAP_MS,
  /** A run shorter than this is not worth an incident. */
  minDurationMs = 0,
} = {}) {
  const runs = toRuns(probes ?? [], gapMs)
  const incidents = []

  for (let i = 0; i < runs.length; i++) {
    if (runs[i].ok) continue

    const first = runs[i]
    const failedProbes = [...first.probes]
    let lastFailedAt = first.lastAt
    let j = i + 1
    /**
     * Whether the loop stopped because the *silence* was too long rather than
     * because a recovery was seen. The distinction decides what the incident's end
     * means, and getting it wrong is how a one-probe failure on a daily cadence got
     * reported as a 24-hour outage: the next day's success is in the very next run,
     * so treating it as the recovery stretches the incident across the whole gap
     * nobody was watching.
     */
    let brokeOnGap = false

    while (j < runs.length) {
      const run = runs[j]
      const gap = run.from - lastFailedAt

      // The silence check comes first and applies to *any* next run, not just a
      // failing one. A success arriving a day later is equally "we stopped watching",
      // and treating it as a recovery is what stretched a one-probe failure on a
      // daily cadence into a 24-hour outage.
      if (gap > gapMs) { brokeOnGap = true; break }

      if (!run.ok) {
        failedProbes.push(...run.probes)
        lastFailedAt = run.lastAt
        j++
        continue
      }

      // A success run. Absorb it only if it is a blip followed by more failure —
      // both conditions matter, and getting either wrong makes the incident list
      // lie: absorbing a long recovery hides an outage's end, and absorbing the
      // final success extends every incident to the end of the log.
      const next = runs[j + 1]
      const isFlap = next && !next.ok
        && (run.from - lastFailedAt) <= flapMs
        && (next.from - run.from) <= flapMs
        && (next.from - lastFailedAt) <= gapMs
      if (isFlap) {
        failedProbes.push(...run.probes)
        j++
        continue
      }

      break
    }

    const nextFailureStart = runs[j] && !runs[j].ok ? runs[j].from : null
    // Only a recovery *inside the observed window* closes the incident at a known
    // time. After a gap break we know the failure stopped being the latest reading,
    // but not when it recovered, so the incident ends at its last failure.
    const recoveredAt = !brokeOnGap && runs[j] && runs[j].ok ? runs[j].from : null
    const endedAt = recoveredAt ?? lastFailedAt
    // Ongoing only when the failure is still the newest reading — i.e. the log ends
    // on it with no gap break. An incident broken off by a silence is closed at its
    // last failure even though no recovery was seen: calling it ongoing would claim
    // it is still down hours later, so a daily-cadence failure would render as a
    // permanent outage.
    const ongoing = !brokeOnGap && recoveredAt === null && j >= runs.length

    incidents.push({
      component,
      startedAt: first.from,
      endedAt: ongoing ? null : endedAt,
      ongoing,
      durationMs: endedAt - first.from,
      failedProbes: failedProbes.length,
      lastError: failedProbes[failedProbes.length - 1].error ?? null,
      // Only used by the tests, to assert a flap did not split the run.
      _nextFailureStart: nextFailureStart,
    })

    i = j - 1
  }

  return incidents
    .filter((i) => i.durationMs >= minDurationMs)
    .map(({ _nextFailureStart, ...incident }) => incident)
}

/**
 * Roll per-component incidents into one list, newest first.
 *
 * Components stay separate even when their incidents overlap — "the API was down"
 * and "the site was down" are different facts, and merging them into one row hides
 * which one failed.
 */
export function allIncidents(byComponent, opts = {}) {
  const out = []
  for (const [component, probes] of Object.entries(byComponent)) {
    out.push(...deriveIncidents(probes, { component, ...opts }))
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}
