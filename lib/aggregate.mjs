/**
 * The status arithmetic: day cells, uptime, current state, and the CN/overseas merge.
 *
 * Pure functions over plain rows, and deliberately no I/O and no clock of their own
 * — a `now` and a set of probe rows go in, a rendered structure comes out. That is
 * what lets `test/aggregate.test.mjs` assert the whole 90-day window headlessly,
 * which is the only way to check it honestly: a screenshot of a green strip proves
 * nothing about the run of days behind it, and the interesting cases (a day the CN
 * sample is missing, a deploy that left a gap) are exactly the ones a screenshot
 * cannot distinguish from "fine".
 *
 * ── The four states ──────────────────────────────────────────────────────────
 *
 *   green  every probe that day succeeded
 *   amber  some did, some did not
 *   red    none did
 *   grey   no data — either we did not ask, or the probe did not run
 *
 * `grey` is not a shade of green. It is the absence of an answer, and the page
 * shows it as its own colour, because a status page that renders "unknown" as
 * "fine" is worse than one that renders nothing.
 */

export const STATES = ['green', 'amber', 'red', 'grey']

/**
 * Severity for comparisons. `grey` sits below `green` on purpose: when merging two
 * readings, "no data" must not be able to make a good reading look worse — the
 * case where it *should* is handled explicitly, by the CN cap in `mergeDay`.
 */
const SEVERITY = { grey: 0, green: 1, amber: 2, red: 3 }

/** The more severe of two states. */
export function worse(a, b) {
  return (SEVERITY[a] ?? 0) >= (SEVERITY[b] ?? 0) ? a : b
}

/** The day a timestamp belongs to, as `YYYY-MM-DD` in UTC. */
export function dayKey(atMs) {
  return new Date(atMs).toISOString().slice(0, 10)
}

/** The state implied by a set of probes from one day. */
export function stateForProbes(probes) {
  if (!probes || probes.length === 0) return 'grey'
  const ok = probes.filter((p) => p.ok).length
  if (ok === probes.length) return 'green'
  if (ok === 0) return 'red'
  return 'amber'
}

/**
 * Merge one day of overseas readings with that day's CN sample.
 *
 * This is the whole point of showing CN and overseas as one component rather than
 * two. A day where Singapore reached the site but China did not is not a green day
 * with a footnote — it is an amber day, and the reader needs to see it that way
 * without having to compare two columns themselves.
 *
 * Three cases, and the third is the one that matters:
 *
 *   1. **CN not configured.** No CN dimension exists, so the day is whatever the
 *      overseas probes say. Deliberately not treated as "CN unknown" — an operator
 *      who turned CN off chose not to ask, which is not the same as asking and
 *      getting no answer.
 *   2. **A CN sample exists.** Worse of the two wins.
 *   3. **CN was expected and there is no sample** (the boce run failed, or the
 *      quota ran out). The day is capped at amber. It cannot be green: green would
 *      assert "reachable from China", and the honest statement is "we do not know".
 *      This is the "never a fake green" rule, and it is the reason this function
 *      exists rather than a one-line `worse()`.
 */
export function mergeDay({ overseas, cn, cnExpected }) {
  if (!cnExpected) return overseas
  // Nothing at all ran that day: that is an absence, not a partial answer.
  if (overseas === 'grey' && cn === 'grey') return 'grey'
  if (cn === 'grey') return worse(overseas, 'amber')
  return worse(overseas, cn)
}

/**
 * Build the whole window.
 *
 * Returns one entry per day from `days - 1` days ago through today, oldest first,
 * so the strip reads left to right and today is the last cell. Days with no probes
 * are still emitted, as `grey` — the grid has to keep its shape or a three-week
 * outage would silently compress into three cells.
 */
export function buildDays({ overseasProbes, cnProbes, now, days, cnExpected }) {
  const overseasByDay = groupByDay(overseasProbes)
  const cnByDay = groupByDay(cnProbes)

  const out = []
  const today = new Date(now)
  for (let i = days - 1; i >= 0; i--) {
    const at = Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate() - i,
    )
    const key = dayKey(at)
    const overseas = stateForProbes(overseasByDay.get(key))
    const cn = stateForProbes(cnByDay.get(key))
    out.push({
      day: key,
      state: mergeDay({ overseas, cn, cnExpected }),
      overseas,
      cn,
    })
  }
  return out
}

function groupByDay(probes) {
  const map = new Map()
  for (const p of probes ?? []) {
    const key = dayKey(p.at)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(p)
  }
  return map
}

/**
 * Uptime over a set of probes, as a 0..1 fraction, or null when there are none.
 *
 * Probe-level rather than day-level: 48 probes a day is a real measurement, and
 * collapsing them to "the day was fine" first would make 99.9% and 97% look the
 * same. `null` rather than 0 for no data — a component with no probes has an
 * unknown uptime, not a zero one, and the page shows "—".
 */
export function uptime(probes) {
  if (!probes || probes.length === 0) return null
  return probes.filter((p) => p.ok).length / probes.length
}

/**
 * The live state of one component, from its most recent round.
 *
 * Staleness is the point. A probe loop that died six hours ago must not keep
 * reporting the green it last saw: an old reading is not a current reading, and
 * the page would be asserting something it stopped checking. Past
 * `staleAfterMs` the component reads `grey`.
 *
 * Judged on the whole newest *round*, not the newest single probe. A local round
 * writes one probe, but a CN round writes one per node, all sharing a timestamp —
 * so `newest.ok` would colour the CN row by whichever node happened to sort last.
 * With 12 of 14 nodes healthy that is a coin toss, and it flapped the row between
 * green and red. `stateForProbes` already expresses the intended rule (all up →
 * green, none up → red, otherwise amber); this applies the same rule to the round.
 */
export function currentState(probes, { now, staleAfterMs }) {
  if (!probes || probes.length === 0) return 'grey'
  const newest = probes.reduce((a, b) => (b.at > a.at ? b : a))
  if (staleAfterMs && now - newest.at > staleAfterMs) return 'grey'
  return stateForProbes(probes.filter((p) => p.at === newest.at))
}

/** The overall verdict: the worst live component, ignoring ones we have no reading for. */
export function overallState(states) {
  const known = states.filter((s) => s !== 'grey')
  if (known.length === 0) return 'grey'
  return known.reduce((acc, s) => worse(acc, s), 'green')
}
