import { safeSignalHash, stableHash } from './scoring-hash.ts'
import type {
  FeatureSignal,
  SignalKind,
  TriggerDecision,
  TriggerFeatures
} from './scoring-types.ts'

export type { Experience, TriggerDecision, TriggerFeatures } from './scoring-types.ts'
export { classifyToolCall, operationFingerprint } from './scoring-calls.ts'
export { isExplicitCorrection } from './scoring-corrections.ts'
export { deriveTriggerFeatures } from './scoring-features.ts'

export const DEFAULT_SCORE_THRESHOLD = 12
export const WORKFLOW_COOLDOWN_TURNS = 3

const STRONG_SIGNAL_KINDS = new Set(['correction', 'recovery', 'workflow'])

function finiteString(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined
  }

  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }

  return finiteString(value)
}

function normalizedCount(value: unknown): number {
  const number = finiteNumber(value)
  return number !== undefined && number > 0 ? Math.floor(number) : 0
}

function normalizedThreshold(value: unknown): number {
  return finiteNumber(value) ?? DEFAULT_SCORE_THRESHOLD
}

function strongSignalEntries(features: Partial<TriggerFeatures> | undefined): string[] {
  const entries = Array.isArray(features?.signalFingerprints) ? features.signalFingerprints : []
  return entries
    .map((entry) => strongSignalEntry(entry))
    .filter((entry): entry is string => entry !== undefined)
}

function stringSignalEntry(entry: string): string | undefined {
  return entry.length > 0 ? entry : undefined
}

function recordSignalEntry(entry: FeatureSignal): string | undefined {
  const kind = typeof entry.kind === 'string' ? entry.kind : ''
  if (!STRONG_SIGNAL_KINDS.has(kind) || entry.fingerprint === undefined) {
    return undefined
  }

  return `${kind}:${safeSignalHash(entry.fingerprint)}`
}

function strongSignalEntry(entry: FeatureSignal | string): string | undefined {
  if (typeof entry === 'string') {
    return stringSignalEntry(entry)
  }

  return recordSignalEntry(entry)
}

export function candidateFingerprint(features: Partial<TriggerFeatures> | undefined): string {
  return stableHash(strongSignalEntries(features).toSorted())
}

export function scoreReviewCandidate(
  features: Partial<TriggerFeatures> | undefined,
  threshold: unknown = DEFAULT_SCORE_THRESHOLD
): TriggerDecision {
  const counts = scoreCounts(features)
  const points = scorePoints(counts)
  const strongSignals = signalKinds(points)

  const normalized = normalizedThreshold(threshold)
  return {
    eligible: isEligibleScore(points.score, normalized, strongSignals),
    score: points.score,
    threshold: normalized,
    strongSignals,
    workflowOnly: isWorkflowOnly(points),
    fingerprint: candidateFingerprint(features),
    reasons: counts
  }
}

function isEligibleScore(score: number, threshold: number, signals: string[]): boolean {
  return score >= threshold && signals.length > 0
}

function isWorkflowOnly(points: {
  workflow: number
  correction: number
  recovery: number
}): boolean {
  return points.workflow > 0 && points.correction === 0 && points.recovery === 0
}

type ScoreCountKey = keyof TriggerDecision['reasons']

function scoreCount(features: Partial<TriggerFeatures> | undefined, key: ScoreCountKey): number {
  return normalizedCount(features?.[key])
}

function scoreCounts(features: Partial<TriggerFeatures> | undefined): TriggerDecision['reasons'] {
  return {
    incorporatedCorrections: scoreCount(features, 'incorporatedCorrections'),
    confirmedRecoveries: scoreCount(features, 'confirmedRecoveries'),
    repeatedVerifiedWorkflows: scoreCount(features, 'repeatedVerifiedWorkflows'),
    successfulVerificationsAfterMutation: scoreCount(
      features,
      'successfulVerificationsAfterMutation'
    ),
    unresolvedFailures: scoreCount(features, 'unresolvedFailures'),
    distinctCategories: scoreCount(features, 'distinctCategories')
  }
}

function scorePoints(counts: TriggerDecision['reasons']): {
  score: number
  correction: number
  recovery: number
  workflow: number
} {
  const correction = Math.min(counts.incorporatedCorrections, 1) * 12
  const recovery = Math.min(counts.confirmedRecoveries, 2) * 8
  const workflow = Math.min(counts.repeatedVerifiedWorkflows, 1) * 8
  const verification = Math.min(counts.successfulVerificationsAfterMutation, 2) * 2
  const failure = Math.min(counts.unresolvedFailures, 2)
  const category = Math.min(counts.distinctCategories, 3)
  return {
    score: correction + recovery + workflow + verification + failure + category,
    correction,
    recovery,
    workflow
  }
}

function signalKinds(points: {
  correction: number
  recovery: number
  workflow: number
}): SignalKind[] {
  return [
    points.correction > 0 ? 'correction' : undefined,
    points.recovery > 0 ? 'recovery' : undefined,
    points.workflow > 0 ? 'workflow' : undefined
  ].filter((kind): kind is SignalKind => kind !== undefined)
}
