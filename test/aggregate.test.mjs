/**
 * The aggregation and the incident pass.
 *
 * This file exists because both are invisible. A strip of 90 coloured cells cannot
 * be reviewed by looking at it: a green cell looks identical whether it means "every
 * probe passed" or "no probe ran and we defaulted to fine", and an incident list
 * that has merged two outages into one reads the same as one that has not. So the
 * rules are asserted here, on the same functions the page renders from.
 *
 *   node --test test/aggregate.test.mjs
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildDays, currentState, dayKey, mergeDay, overallState, stateForProbes, uptime, worse,
} from '../lib/aggregate.mjs'
import { deriveIncidents } from '../lib/incidents.mjs'

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

/** A fixed "now", so nothing here depends on when it runs. */
const NOW = Date.UTC(2026, 8, 17, 12, 0, 0)

const ok = (at) => ({ at, ok: true })
const bad = (at) => ({ at, ok: false, error: 'boom' })

// --- states -----------------------------------------------------------------

test('one state per set of probes, and an empty set is unknown rather than fine', () => {
  assert.equal(stateForProbes([]), 'grey')
  assert.equal(stateForProbes(undefined), 'grey')
  assert.equal(stateForProbes([ok(NOW), ok(NOW)]), 'green')
  // No tolerance by default: for a local probe any failure is a failure.
  assert.equal(stateForProbes([ok(NOW), bad(NOW)]), 'amber')
  assert.equal(stateForProbes([bad(NOW), bad(NOW)]), 'red')
})

test('a component tolerates its own normal failure rate', () => {
  // The CN row is sampled across ~28 nodes on three carriers, from a country whose
  // routes to a Cloudflare-fronted site vary by province. A couple of nodes failing is
  // the ordinary state of the network, so with a 20% tolerance it stays green — which
  // is what stops the page reading amber every single day until nobody looks at it.
  const round = (okCount, badCount) => [
    ...Array.from({ length: okCount }, () => ok(NOW)),
    ...Array.from({ length: badCount }, () => bad(NOW)),
  ]
  const TOL = 0.2

  assert.equal(stateForProbes(round(28, 0), TOL), 'green', 'a clean round')
  assert.equal(stateForProbes(round(26, 2), TOL), 'green', '2 of 28 is within normal')
  assert.equal(stateForProbes(round(24, 4), TOL), 'green', '4 of 28 is 14%, still within')
  assert.equal(stateForProbes(round(22, 6), TOL), 'amber', '6 of 28 is 21%, past the line')
  assert.equal(stateForProbes(round(15, 13), TOL), 'amber', 'just under half')
  assert.equal(stateForProbes(round(13, 15), TOL), 'red', 'a majority unreachable is an outage')

  // And the tolerance is genuinely per component: the same 2-of-28 round is a failure
  // for a local probe, where there is no normal failure rate.
  assert.equal(stateForProbes(round(26, 2), 0), 'amber')
})

test('severity orders the four states, and grey never worsens a reading', () => {
  // grey is *below* green because it is an absence; the case where "we could not
  // ask" must cap a day is handled explicitly by mergeDay, not by severity.
  assert.equal(worse('green', 'grey'), 'green')
  assert.equal(worse('green', 'amber'), 'amber')
  assert.equal(worse('amber', 'red'), 'red')
  assert.equal(worse('red', 'green'), 'red')
})

// --- the CN / overseas merge ------------------------------------------------

test('a day China could not reach is amber even though Singapore could', () => {
  // The whole reason the two readings are one component rather than two columns.
  assert.equal(mergeDay({ overseas: 'green', cn: 'red', cnExpected: true }), 'red')
  assert.equal(mergeDay({ overseas: 'green', cn: 'amber', cnExpected: true }), 'amber')
  assert.equal(mergeDay({ overseas: 'green', cn: 'green', cnExpected: true }), 'green')
})

test('a missing CN sample caps the day at amber — never green', () => {
  // The "never a fake green" rule. Green would assert reachability from China;
  // with no sample the honest statement is "we do not know".
  assert.equal(mergeDay({ overseas: 'green', cn: 'grey', cnExpected: true }), 'amber')
  assert.equal(mergeDay({ overseas: 'red', cn: 'grey', cnExpected: true }), 'red', 'a worse overseas reading still wins')
})

test('with CN off, the day is whatever overseas says — not capped', () => {
  // An operator who turned CN off chose not to ask, which is not the same as asking
  // and getting no answer. Capping here would make every day amber forever.
  assert.equal(mergeDay({ overseas: 'green', cn: 'grey', cnExpected: false }), 'green')
  assert.equal(mergeDay({ overseas: 'red', cn: 'grey', cnExpected: false }), 'red')
})

test('a day with no data at all stays grey, not amber', () => {
  // Nothing ran — that is an absence on both axes, and it must not read as "we
  // looked and China was unreachable".
  assert.equal(mergeDay({ overseas: 'grey', cn: 'grey', cnExpected: true }), 'grey')
})

// --- the window -------------------------------------------------------------

test('the window is exactly N days, oldest first, today last', () => {
  const days = buildDays({
    overseasProbes: [], cnProbes: [], now: NOW, days: 90, cnExpected: false,
  })
  assert.equal(days.length, 90)
  assert.equal(days[0].day, '2026-06-20')
  assert.equal(days[89].day, '2026-09-17')
  // Every day present, including the empty ones: a gap must keep its cell or the
  // strip silently compresses and a long outage looks like a short one.
  assert.ok(days.every((d) => d.state === 'grey'))
})

test('probes land on the right day, and the state follows from them', () => {
  const days = buildDays({
    overseasProbes: [ok(NOW - 1 * DAY), ok(NOW - 1 * DAY + HOUR), bad(NOW)],
    cnProbes: [],
    now: NOW,
    days: 3,
    cnExpected: false,
  })
  assert.deepEqual(days.map((d) => d.state), ['grey', 'green', 'red'])
})

test('a probe at either end of a day belongs to that day', () => {
  const midnightUtc = Date.UTC(2026, 8, 17, 0, 0, 0)
  const days = buildDays({
    overseasProbes: [ok(midnightUtc), ok(midnightUtc + DAY - 1)],
    cnProbes: [],
    now: NOW,
    days: 2,
    cnExpected: false,
  })
  assert.equal(days[1].state, 'green', 'both probes of 09-17 are on 09-17')
  assert.equal(days[1].day, '2026-09-17')
})

test('dayKey is UTC, so a day boundary is not the host timezone’s', () => {
  assert.equal(dayKey(Date.UTC(2026, 8, 17, 23, 59, 59)), '2026-09-17')
  assert.equal(dayKey(Date.UTC(2026, 8, 18, 0, 0, 0)), '2026-09-18')
})

// --- uptime -----------------------------------------------------------------

test('uptime is probe-level, so a day of near-misses is not rounded to fine', () => {
  // 48 probes a day is a real measurement; collapsing to "the day was fine" first
  // would make 99.9% and 97% indistinguishable.
  const probes = [ok(NOW), ok(NOW), ok(NOW), bad(NOW)]
  assert.equal(uptime(probes), 0.75)
})

test('no probes is an unknown uptime, not zero', () => {
  // 0% would claim an outage; the page shows "—".
  assert.equal(uptime([]), null)
  assert.equal(uptime(null), null)
})

// --- current state ----------------------------------------------------------

test('the live state comes from the newest probe, not the majority', () => {
  // Newest is a success and inside the window, so the component is green even
  // though most of its recorded history is failures.
  const probes = [bad(NOW - 90 * 60 * 1000), bad(NOW - 60 * 60 * 1000), ok(NOW - 5 * 60 * 1000)]
  assert.equal(currentState(probes, { now: NOW, staleAfterMs: 2 * HOUR }), 'green')
})

test('a stale reading goes grey rather than keeping a green it stopped checking', () => {
  // The bug this prevents: the probe loop dies, and the page keeps reporting the
  // last thing it saw as though it were current.
  const old = [ok(NOW - 6 * HOUR)]
  assert.equal(currentState(old, { now: NOW, staleAfterMs: 90 * 60 * 1000 }), 'grey')
})

test('a failed probe inside the staleness window reads red', () => {
  assert.equal(currentState([bad(NOW - 5 * 60 * 1000)], { now: NOW, staleAfterMs: HOUR }), 'red')
})

test('no probes at all is grey', () => {
  assert.equal(currentState([], { now: NOW, staleAfterMs: HOUR }), 'grey')
})

test('a CN round is judged on all its nodes, not on whichever one sorts last', () => {
  // A CN round writes one probe per node at the same timestamp. Judging on the
  // newest single probe made the row's state depend on ordering: the same 12-of-14
  // healthy round could read green or red. Partial is amber, and it must not move
  // when the failing node changes position in the array.
  const at = NOW - 5 * 60 * 1000
  const healthy = Array.from({ length: 12 }, () => ok(at))
  const round = [...Array.from({ length: 2 }, () => bad(at)), ...healthy]
  const reversed = [...round].reverse()
  const opts = { now: NOW, staleAfterMs: HOUR }

  assert.equal(currentState(round, opts), 'amber', 'some nodes failing is amber')
  assert.equal(currentState(reversed, opts), 'amber', 'and does not depend on order')

  assert.equal(currentState(healthy, opts), 'green', 'every node up is green')
  assert.equal(currentState(Array.from({ length: 14 }, () => bad(at)), opts), 'red', 'no node up is red')

  // A later round supersedes an earlier one rather than blending with it.
  assert.equal(
    currentState([...Array.from({ length: 14 }, () => bad(at)), ...healthy.map(() => ok(NOW - 60_000))], opts),
    'green',
    'only the newest round decides',
  )
})

// --- overall ----------------------------------------------------------------

test('the overall verdict is the worst live component, ignoring unknowns', () => {
  assert.equal(overallState(['green', 'green']), 'green')
  assert.equal(overallState(['green', 'amber']), 'amber')
  assert.equal(overallState(['green', 'red']), 'red')
  // A component we have no reading for must not drag the banner down — the page
  // already shows its own grey, and the banner speaks for what is known.
  assert.equal(overallState(['green', 'grey']), 'green')
  assert.equal(overallState(['grey', 'grey']), 'grey')
})

// --- incidents --------------------------------------------------------------

test('a sustained failure is one incident, closed by recovery', () => {
  const incidents = deriveIncidents([
    bad(NOW), bad(NOW + HOUR), bad(NOW + 2 * HOUR), ok(NOW + 3 * HOUR), ok(NOW + 4 * HOUR),
  ], { component: 'api' })
  assert.equal(incidents.length, 1)
  const [incident] = incidents
  assert.equal(incident.startedAt, NOW)
  assert.equal(incident.endedAt, NOW + 3 * HOUR)
  assert.equal(incident.ongoing, false)
  assert.equal(incident.durationMs, 3 * HOUR)
  assert.equal(incident.failedProbes, 3)
  assert.equal(incident.lastError, 'boom')
})

test('a failure still going at the end of the log is ongoing', () => {
  const incidents = deriveIncidents([bad(NOW), bad(NOW + HOUR)], { component: 'api' })
  assert.equal(incidents.length, 1)
  assert.equal(incidents[0].ongoing, true)
  assert.equal(incidents[0].endedAt, null)
})

test('a one-probe blip does not split an incident in two', () => {
  // A service that flaps up for a single probe and straight back down is one
  // incident with a blip in it. Reporting two would make a ten-minute wobble look
  // like a bad week.
  const incidents = deriveIncidents([
    bad(NOW), bad(NOW + 20 * 60 * 1000),
    ok(NOW + 40 * 60 * 1000),                       // brief recovery
    bad(NOW + 60 * 60 * 1000), bad(NOW + 80 * 60 * 1000),
    ok(NOW + 2 * HOUR), ok(NOW + 3 * HOUR),
  ], { component: 'api' })
  assert.equal(incidents.length, 1, 'the blip did not split the run')
  assert.equal(incidents[0].startedAt, NOW)
  assert.equal(incidents[0].endedAt, NOW + 2 * HOUR)
})

test('a sustained recovery does close an incident', () => {
  const incidents = deriveIncidents([
    bad(NOW), bad(NOW + 30 * 60 * 1000),
    ok(NOW + 2 * HOUR), ok(NOW + 3 * HOUR),          // a real recovery, outside the flap window
    bad(NOW + 5 * HOUR), ok(NOW + 6 * HOUR),
  ], { component: 'api' })
  assert.equal(incidents.length, 2, 'the second failure is its own incident')
  assert.equal(incidents[0].endedAt, NOW + 2 * HOUR)
})

test('a long silence starts a new incident rather than extending the old one', () => {
  // We cannot claim we were watching across a two-day gap in the probe loop, so
  // this must not be reported as one two-day service failure.
  const incidents = deriveIncidents([
    bad(NOW), bad(NOW + 30 * 60 * 1000),
    // 6 hours later: well past the gap bound.
    bad(NOW + 6 * HOUR), ok(NOW + 7 * HOUR),
  ], { component: 'api', gapMs: 2 * HOUR })
  assert.equal(incidents.length, 2)
})

test('a failure after a silence is not credited with the silence as its duration', () => {
  // The bug this pins, found by rendering a seeded window: on a daily cadence the
  // next day's success sits in the very next run, so treating it as the recovery
  // stretched a one-probe failure into a 24-hour outage. Duration must stop at the
  // last observed failure.
  const incidents = deriveIncidents([
    bad(NOW),
    ok(NOW + 24 * HOUR),
  ], { component: 'cn_site', gapMs: 2 * HOUR })
  assert.equal(incidents.length, 1)
  assert.equal(incidents[0].durationMs, 0, 'one failed probe is a zero-length incident, not a day-long one')
  assert.equal(incidents[0].endedAt, NOW)
  assert.equal(incidents[0].ongoing, false, 'a silence is not an ongoing outage')
})

test('a daily-cadence failure does not render as a permanent outage', () => {
  // Same shape as the CN probe: one reading a day. With a gap bound of hours, each
  // failure is its own incident and none of them is ongoing — the page must not show
  // "持续中" for a service that answered fine yesterday.
  const day = 24 * HOUR
  const incidents = deriveIncidents([
    bad(NOW), bad(NOW + day), ok(NOW + 2 * day), ok(NOW + 3 * day),
  ], { component: 'cn_site', gapMs: 2 * HOUR })
  assert.ok(incidents.length >= 1)
  assert.ok(incidents.every((i) => !i.ongoing), 'nothing is reported as ongoing')
  assert.ok(
    incidents.every((i) => i.durationMs < day),
    'no incident claims to span the unobserved gap',
  )
})

test('trailing successes do not extend an incident past its recovery', () => {
  // The failure mode of a naive implementation: absorbing every trailing success
  // would make an incident run to the end of the log, so a blip last week would
  // report as still ongoing. The incident ends at the *first* success.
  const incidents = deriveIncidents([
    bad(NOW), ok(NOW + 30 * 60 * 1000), ok(NOW + HOUR), ok(NOW + 2 * HOUR),
  ], { component: 'api', gapMs: 6 * HOUR })
  assert.equal(incidents.length, 1)
  assert.equal(incidents[0].endedAt, NOW + 30 * 60 * 1000, 'ends at the recovery, not the last probe')
  assert.equal(incidents[0].durationMs, 30 * 60 * 1000)
  assert.equal(incidents[0].ongoing, false)
})

test('probes may arrive out of order', () => {
  const incidents = deriveIncidents([
    bad(NOW + 30 * 60 * 1000), bad(NOW), ok(NOW + 2 * HOUR), ok(NOW + 3 * HOUR),
  ], { component: 'api' })
  assert.equal(incidents.length, 1)
  assert.equal(incidents[0].startedAt, NOW, 'sorted internally')
})

test('a clean log has no incidents', () => {
  assert.deepEqual(deriveIncidents([ok(NOW), ok(NOW + HOUR)], { component: 'api' }), [])
})
