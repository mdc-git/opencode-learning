import { deriveTriggerFeatures, scoreReviewCandidate, type TriggerDecision } from './scoring.ts'
import { SESSION_ID_KEY } from './shared.ts'
import type { InternalMailbox } from './mailbox.ts'
import type { ExperienceSnapshot } from './types.ts'
import type { Telemetry } from './telemetry.ts'
import type { ReviewRequest, TriggerEvaluation } from './review-types.ts'

export function isReviewSessionUnavailable(
  sessionID: string,
  isDisposed: boolean,
  mailbox: InternalMailbox
): boolean {
  return sessionID.length === 0 || isDisposed || mailbox.isInternalSession(sessionID)
}

export function shouldReviewAfterExecution(isForced: boolean, isSucceeded: boolean): boolean {
  return isForced || isSucceeded
}

export function queuePendingReview(
  pendingReviews: Map<string, ReviewRequest>,
  sessionID: string,
  isForced: boolean,
  terminalType: string
): void {
  const pending = pendingReviews.get(sessionID) ?? { force: false, terminalType }
  pending.force ||= isForced
  pending.terminalType = terminalType
  pendingReviews.set(sessionID, pending)
}

export function canStartReview({
  sessionID,
  isDisposed,
  isEnabled,
  inFlight,
  mailbox
}: {
  sessionID: string
  isDisposed: boolean
  isEnabled: boolean
  inFlight: Set<string>
  mailbox: InternalMailbox
}): boolean {
  return (
    !isReviewSessionUnavailable(sessionID, isDisposed, mailbox) &&
    isEnabled &&
    !inFlight.has(sessionID)
  )
}

function recordTriggerEvaluationSafely(telemetry: Telemetry, evaluation: TriggerEvaluation): void {
  void telemetry.recordTriggerEvaluation(evaluation).catch((error: unknown) => {
    console.error('[opencode-learning] trigger telemetry failed', error)
  })
}

function isDuplicateFingerprint({
  sessionID,
  candidate,
  reviewedFingerprints,
  lastSuppressedFingerprint,
  telemetry
}: {
  sessionID: string
  candidate: TriggerDecision
  reviewedFingerprints: Map<string, Map<string, string>>
  lastSuppressedFingerprint: Map<string, string>
  telemetry: Telemetry
}): boolean {
  const reviewed = reviewedFingerprints.get(sessionID)
  if (!reviewed?.has(candidate.fingerprint)) {
    return false
  }

  if (lastSuppressedFingerprint.get(sessionID) !== candidate.fingerprint) {
    lastSuppressedFingerprint.set(sessionID, candidate.fingerprint)
    recordTriggerEvaluationSafely(telemetry, {
      decision: 'duplicate-fingerprint',
      score: candidate.score,
      strongSignals: candidate.strongSignals
    })
  }

  return true
}

function isWorkflowOnCooldown(
  sessionID: string,
  successfulTurns: Map<string, number>,
  lastAutomaticReviewTurn: Map<string, number>,
  cooldownTurns: number
): boolean {
  const turnsSinceReview =
    (successfulTurns.get(sessionID) ?? 0) - (lastAutomaticReviewTurn.get(sessionID) ?? 0)
  return turnsSinceReview < cooldownTurns
}

function shouldDeferWorkflowReview({
  sessionID,
  candidate,
  successfulTurns,
  lastAutomaticReviewTurn,
  workflowCooldownTurns,
  telemetry
}: {
  sessionID: string
  candidate: TriggerDecision
  successfulTurns: Map<string, number>
  lastAutomaticReviewTurn: Map<string, number>
  workflowCooldownTurns: number
  telemetry: Telemetry
}): boolean {
  if (
    !candidate.workflowOnly ||
    !isWorkflowOnCooldown(
      sessionID,
      successfulTurns,
      lastAutomaticReviewTurn,
      workflowCooldownTurns
    )
  ) {
    return false
  }

  recordTriggerEvaluationSafely(telemetry, {
    decision: 'workflow-cooldown',
    score: candidate.score,
    strongSignals: candidate.strongSignals
  })
  return true
}

function isIneligibleCandidate(candidate: TriggerDecision, telemetry: Telemetry): boolean {
  if (candidate.eligible) {
    return false
  }

  recordTriggerEvaluationSafely(telemetry, {
    decision: candidate.score < candidate.threshold ? 'below-threshold' : 'missing-strong-signal',
    score: candidate.score,
    strongSignals: candidate.strongSignals
  })
  return true
}

type AutomaticReviewContext = {
  sessionID: string
  candidate: TriggerDecision
  successfulTurns: Map<string, number>
  lastAutomaticReviewTurn: Map<string, number>
  reviewedFingerprints: Map<string, Map<string, string>>
  lastSuppressedFingerprint: Map<string, string>
  workflowCooldownTurns: number
  telemetry: Telemetry
}

function completeAutomaticReview(context: AutomaticReviewContext): TriggerDecision | undefined {
  const {
    sessionID: sessionId,
    candidate,
    successfulTurns,
    lastAutomaticReviewTurn,
    reviewedFingerprints,
    lastSuppressedFingerprint,
    workflowCooldownTurns,
    telemetry
  } = context
  if (
    isDuplicateFingerprint({
      [SESSION_ID_KEY]: sessionId,
      candidate,
      reviewedFingerprints,
      lastSuppressedFingerprint,
      telemetry
    })
  ) {
    return undefined
  }

  lastSuppressedFingerprint.delete(sessionId)
  if (
    shouldDeferWorkflowReview({
      [SESSION_ID_KEY]: sessionId,
      candidate,
      successfulTurns,
      lastAutomaticReviewTurn,
      workflowCooldownTurns,
      telemetry
    })
  ) {
    return undefined
  }

  recordTriggerEvaluationSafely(telemetry, {
    decision: 'review',
    score: candidate.score,
    strongSignals: candidate.strongSignals
  })
  return candidate
}

export function evaluateAutomaticReview({
  sessionID,
  exp,
  scoreThreshold,
  workflowCooldownTurns,
  successfulTurns,
  lastAutomaticReviewTurn,
  reviewedFingerprints,
  lastSuppressedFingerprint,
  telemetry
}: {
  sessionID: string
  exp: ExperienceSnapshot
  scoreThreshold: number
  workflowCooldownTurns: number
  successfulTurns: Map<string, number>
  lastAutomaticReviewTurn: Map<string, number>
  reviewedFingerprints: Map<string, Map<string, string>>
  lastSuppressedFingerprint: Map<string, string>
  telemetry: Telemetry
}): TriggerDecision | undefined {
  const features = deriveTriggerFeatures(exp)
  const candidate = scoreReviewCandidate(features, scoreThreshold)
  if (isIneligibleCandidate(candidate, telemetry)) {
    return undefined
  }

  return completeAutomaticReview({
    [SESSION_ID_KEY]: sessionID,
    candidate,
    successfulTurns,
    lastAutomaticReviewTurn,
    reviewedFingerprints,
    lastSuppressedFingerprint,
    workflowCooldownTurns,
    telemetry
  })
}
