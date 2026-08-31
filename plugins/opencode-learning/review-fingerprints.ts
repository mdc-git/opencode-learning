import type { TriggerDecision } from './scoring.ts'

export function recordReviewFingerprint(
  reviewedFingerprints: Map<string, Map<string, string>>,
  sessionID: string,
  triggerDecision: TriggerDecision | undefined,
  outcome: string
): void {
  if (triggerDecision === undefined || triggerDecision.fingerprint.length === 0) {
    return
  }

  let reviewed = reviewedFingerprints.get(sessionID)
  if (!reviewed) {
    reviewed = new Map()
    reviewedFingerprints.set(sessionID, reviewed)
  }

  reviewed.set(triggerDecision.fingerprint, outcome)
}
