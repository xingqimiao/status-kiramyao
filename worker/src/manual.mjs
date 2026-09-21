/**
 * The manual declaration, and the one rule that makes it safe.
 *
 * A human declaration may RAISE severity freely -- an operator seeing something the
 * probes have not caught yet is exactly who a status page is for. It may never LOWER
 * it. Concretely:
 *
 *   - the banner state is `worse(probeState, manualState)`, and "no active manual
 *     declaration" maps to `grey`; `worse` ranks grey below green, so an absent or
 *     resolved declaration cannot pull a red probe down to green;
 *   - the probe verdict is always carried separately (`probeState`) and the page
 *     renders it whenever it disagrees with the manual one.
 *
 * The bug this exists to prevent: an operator declares "recovered" after a deploy
 * restores one component while another is still down, and the page turns green over a
 * failing probe. That is the page lying at the exact moment it is being trusted.
 */
import { worse } from '../../lib/aggregate.mjs'

/** Severity -> the state it contributes. Maintenance is degraded, not healthy. */
export const MANUAL_SEVERITY = { partial: 'amber', full: 'red', maintenance: 'amber' }

/** Severity -> the words the banner uses. */
export const MANUAL_LABEL = {
  partial: '部分服务异常',
  full: '服务中断',
  maintenance: '维护中',
}

/** A "declared recovered but probes still fail" note is only relevant while it is recent. */
const RESOLVED_NOTE_WINDOW_MS = 24 * 60 * 60 * 1000

const RANK = { grey: 0, green: 1, amber: 2, red: 3 }

export function overlayManual(probeState, activeEvent, lastResolvedEvent, { now, probeNewestAt } = {}) {
  const manualState = activeEvent ? (MANUAL_SEVERITY[activeEvent.severity] ?? 'grey') : 'grey'
  const overall = worse(probeState, manualState)

  let mismatch = null
  if (activeEvent && probeState !== 'grey' && RANK[manualState] < RANK[probeState]) {
    // The human called it less severe than the probes did (e.g. "maintenance" while a
    // probe is red). Show both.
    mismatch = { kind: 'manual-lower', manualState, probeState }
  } else if (
    !activeEvent
    && lastResolvedEvent
    && (probeState === 'red' || probeState === 'amber')
    && probeNewestAt !== null
    && probeNewestAt !== undefined
    // The probes failed *after* the declaration, and recently enough that the note is
    // about this recovery rather than about an unrelated outage months later.
    && probeNewestAt >= lastResolvedEvent.resolvedAt
    && now - lastResolvedEvent.resolvedAt <= RESOLVED_NOTE_WINDOW_MS
  ) {
    mismatch = { kind: 'resolved-but-failing', manualState: 'grey', probeState }
  }

  return { overall, manualState, mismatch }
}
