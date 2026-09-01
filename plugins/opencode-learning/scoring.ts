import { safeSignalHash, stableHash } from './scoring-hash.ts'
import type {
  FeatureSignal,
  SignalKind,
  TriggerDecision,
  TriggerFeatures
} from './scoring-types.ts'

export type { Experience, TriggerDecision, TriggerFeatures } from './scoring-types.ts'
export { classifyToolCall, operationFingerprint } from './scoring-calls.ts'
export { deriveTriggerFeatures } from './scoring-features.ts'

export const DEFAULT_SCORE_THRESHOLD = 12
export const WORKFLOW_COOLDOWN_TURNS = 3

function stripQuotedContent(text: string): string {
  return (
    text
      .replaceAll(/```[\s\S]*?(?:```|$)/gv, ' ')
      .replaceAll(/~~~[\s\S]*?(?:~~~|$)/gv, ' ')
      .replaceAll(/^[\t ]*>.*$/gmv, ' ')
      .replaceAll(/`[^`]*`/gv, ' ')
      .replaceAll(/"(?:\\[\s\S]|[^"\\])*"/gv, ' ')
      .replaceAll(
        // eslint-disable-next-line regexp/no-useless-non-capturing-group, regexp/prefer-character-class
        /(?<=^|(?:\s|\(|,|:|;|\[|\{))'(?:\\[\s\S]|[^'\\])*'/gv,
        ' '
      )
      // eslint-disable-next-line regexp/no-super-linear-move
      .replaceAll(/\u{201C}[^\u{201D}]*\u{201D}/gv, ' ')
      // eslint-disable-next-line regexp/no-super-linear-move
      .replaceAll(/\u{2018}[^\u{2019}]*\u{2019}/gv, ' ')
  )
}

const EXPLICIT_CORRECTION_RE =
  /^\s*(?:no\b|nope\b|not\s+quite\b|that(?:'s|\s+is)\s+(?:not\s+right|wrong)\b|wrong\b|correction\b|actually[ ,:]\s*|instead[ ,:]\s*|you\s+(?:missed|should|shouldn't|need\s+to)\b)/iv

export function isExplicitCorrection(text: unknown): boolean {
  return typeof text === 'string' && EXPLICIT_CORRECTION_RE.test(stripQuotedContent(text))
}

const STRONG_SIGNAL_KINDS = new Set(['correction', 'recovery', 'workflow'])
type ScorePoints = {
  score: number
  correction: number
  recovery: number
  workflow: number
}

function strongSignalEntries(features: Pick<TriggerFeatures, 'signalFingerprints'>): string[] {
  return features.signalFingerprints
    .map((entry) => strongSignalEntry(entry))
    .filter((entry): entry is string => entry !== undefined)
}

function recordSignalEntry(entry: FeatureSignal): string | undefined {
  if (!STRONG_SIGNAL_KINDS.has(entry.kind)) {
    return undefined
  }

  return `${entry.kind}:${safeSignalHash(entry.fingerprint)}`
}

function strongSignalEntry(entry: FeatureSignal | string): string | undefined {
  if (typeof entry === 'string') {
    return entry.length > 0 ? entry : undefined
  }

  return recordSignalEntry(entry)
}

export function candidateFingerprint(
  features: Pick<TriggerFeatures, 'signalFingerprints'>
): string {
  return stableHash(strongSignalEntries(features).toSorted())
}

export function scoreReviewCandidate(
  features: TriggerFeatures,
  threshold = DEFAULT_SCORE_THRESHOLD
): TriggerDecision {
  const points = scorePoints(features)
  return {
    eligible: isEligibleScore(points.score, threshold, points.strongSignals),
    score: points.score,
    threshold,
    strongSignals: points.strongSignals,
    workflowOnly: isWorkflowOnly(points),
    fingerprint: candidateFingerprint(features),
    reasons: {
      incorporatedCorrections: features.incorporatedCorrections,
      confirmedRecoveries: features.confirmedRecoveries,
      repeatedVerifiedWorkflows: features.repeatedVerifiedWorkflows,
      successfulVerificationsAfterMutation: features.successfulVerificationsAfterMutation,
      unresolvedFailures: features.unresolvedFailures,
      distinctCategories: features.distinctCategories
    }
  }
}

function isEligibleScore(score: number, threshold: number, signals: SignalKind[]): boolean {
  return score >= threshold && signals.length > 0
}

function isWorkflowOnly(points: ScorePoints): boolean {
  return points.workflow > 0 && points.correction === 0 && points.recovery === 0
}

function scorePoints(features: TriggerFeatures): ScorePoints & { strongSignals: SignalKind[] } {
  const correction = Math.min(features.incorporatedCorrections, 1)
  const recovery = Math.min(features.confirmedRecoveries, 2)
  const workflow = Math.min(features.repeatedVerifiedWorkflows, 1)
  const correctionPoints = correction * 12
  const recoveryPoints = recovery * 8
  const workflowPoints = workflow * 8
  const verification = Math.min(features.successfulVerificationsAfterMutation, 2) * 2
  const failure = Math.min(features.unresolvedFailures, 2)
  const category = Math.min(features.distinctCategories, 3)
  return {
    score: correctionPoints + recoveryPoints + workflowPoints + verification + failure + category,
    correction,
    recovery,
    workflow,
    strongSignals: [
      correction > 0 ? 'correction' : undefined,
      recovery > 0 ? 'recovery' : undefined,
      workflow > 0 ? 'workflow' : undefined
    ].filter((kind): kind is SignalKind => kind !== undefined)
  }
}
