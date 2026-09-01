import { deriveTriggerFeatures, scoreReviewCandidate, type TriggerDecision } from './scoring.ts'
import type { InternalMailbox } from './mailbox.ts'
import type { ExperienceSnapshot } from './types.ts'
import type { Telemetry } from './telemetry.ts'

type TriggerEvaluation = { decision: string; score: number; strongSignals: string[] }

export function isReviewSessionUnavailable(
  sessionId: string,
  isDisposed: boolean,
  mailbox: InternalMailbox
): boolean {
  return isDisposed || mailbox.isInternalSession(sessionId)
}

export function canStartReview({
  sessionId,
  isDisposed,
  isEnabled,
  inFlight,
  mailbox
}: {
  sessionId: string
  isDisposed: boolean
  isEnabled: boolean
  inFlight: Set<string>
  mailbox: InternalMailbox
}): boolean {
  return (
    !isReviewSessionUnavailable(sessionId, isDisposed, mailbox) &&
    isEnabled &&
    !inFlight.has(sessionId)
  )
}

function recordTriggerEvaluationSafely(telemetry: Telemetry, evaluation: TriggerEvaluation): void {
  void telemetry.recordTriggerEvaluation(evaluation).catch((error: unknown) => {
    console.error('[opencode-learning] trigger telemetry failed', error)
  })
}

function isDuplicateFingerprint({
  sessionId,
  candidate,
  reviewedFingerprints,
  lastSuppressedFingerprint,
  telemetry
}: {
  sessionId: string
  candidate: TriggerDecision
  reviewedFingerprints: Map<string, Map<string, string>>
  lastSuppressedFingerprint: Map<string, string>
  telemetry: Telemetry
}): boolean {
  const reviewed = reviewedFingerprints.get(sessionId)
  if (!reviewed?.has(candidate.fingerprint)) {
    return false
  }

  if (lastSuppressedFingerprint.get(sessionId) !== candidate.fingerprint) {
    lastSuppressedFingerprint.set(sessionId, candidate.fingerprint)
    recordTriggerEvaluationSafely(telemetry, {
      decision: 'duplicate-fingerprint',
      score: candidate.score,
      strongSignals: candidate.strongSignals
    })
  }

  return true
}

function isWorkflowOnCooldown(
  sessionId: string,
  successfulTurns: Map<string, number>,
  lastAutomaticReviewTurn: Map<string, number>,
  cooldownTurns: number
): boolean {
  const turnsSinceReview =
    (successfulTurns.get(sessionId) ?? 0) - (lastAutomaticReviewTurn.get(sessionId) ?? 0)
  return turnsSinceReview < cooldownTurns
}

function shouldDeferWorkflowReview({
  sessionId,
  candidate,
  successfulTurns,
  lastAutomaticReviewTurn,
  workflowCooldownTurns,
  telemetry
}: {
  sessionId: string
  candidate: TriggerDecision
  successfulTurns: Map<string, number>
  lastAutomaticReviewTurn: Map<string, number>
  workflowCooldownTurns: number
  telemetry: Telemetry
}): boolean {
  if (
    !candidate.workflowOnly ||
    !isWorkflowOnCooldown(
      sessionId,
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
  sessionId: string
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
    sessionId,
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
      sessionId,
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
      sessionId,
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
  sessionId,
  exp,
  scoreThreshold,
  workflowCooldownTurns,
  successfulTurns,
  lastAutomaticReviewTurn,
  reviewedFingerprints,
  lastSuppressedFingerprint,
  telemetry
}: {
  sessionId: string
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
    sessionId,
    candidate,
    successfulTurns,
    lastAutomaticReviewTurn,
    reviewedFingerprints,
    lastSuppressedFingerprint,
    workflowCooldownTurns,
    telemetry
  })
}
