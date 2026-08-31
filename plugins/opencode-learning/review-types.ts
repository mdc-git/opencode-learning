import type { OpenCodeContext, SessionInfo } from './sdk.ts'
import type { InternalMailbox } from './mailbox.ts'
import type { ExperienceRecorder } from './recorder.ts'
import type { TriggerDecision } from './scoring.ts'
import type { SkillStore } from './store.ts'
import type {
  Candidate,
  ExperienceSnapshot,
  LearningConfig,
  Proposal,
  UnknownRecord,
  Validation,
  ValidationSubmission
} from './types.ts'
import type { Telemetry } from './telemetry.ts'

export type ReviewRequest = { force: boolean; terminalType?: string }
export type ReviewOptions = {
  force?: boolean
  terminalType?: string
  triggerDecision?: TriggerDecision
}
export type ReviewAttemptOptions = ReviewOptions & { onReflectorStart?: () => void }
export type ReviewValidation = UnknownRecord & {
  deterministic: Validation
  agent: ValidationSubmission
  ok: boolean
}
export type ReviewAttempt = { proposal: Proposal; validation: ReviewValidation }
export type ReviewOutcome = UnknownRecord & { status: string }
export type PreparedReview = { batch: ExperienceSnapshot; candidate: TriggerDecision | undefined }
export type ReviewPreparation = {
  proposal: Proposal
  candidates: Candidate[]
  directory: string
  model: SessionInfo['model'] | undefined
}
export type CuratorResult = { stale: string[]; archived: string[] } | { skipped: string }
export type ReviewPipelineOptions = {
  ctx: OpenCodeContext
  recorder: ExperienceRecorder
  store: SkillStore
  telemetry: Telemetry
  mailbox: InternalMailbox
  config: LearningConfig
}
export type TriggerEvaluation = { decision: string; score: number; strongSignals: string[] }
export type ReviewScore =
  | {
      score: number
      threshold: number
      reasons: TriggerDecision['reasons']
      signals: TriggerDecision['strongSignals']
    }
  | undefined
export type ReviewFailureOptions = {
  telemetry: Telemetry
  ctx: OpenCodeContext
  sessionID: string
  terminalType: string
  force: boolean
  score: ReviewScore
  error: unknown
  notify: boolean
}
export type ReviewErrorOptions = {
  sessionId: string
  terminalType: string
  force: boolean
  score: ReviewScore
  error: unknown
}
export type ReviewResultOptions = {
  ctx: OpenCodeContext
  store: SkillStore
  telemetry: Telemetry
  config: LearningConfig
  sessionID: string
  terminalType: string
  force: boolean
  score: ReviewScore
  triggerDecision: TriggerDecision | undefined
  proposal: Proposal
  validation: ReviewValidation
  recordFingerprint: (
    sessionID: string,
    triggerDecision: TriggerDecision | undefined,
    outcome: string
  ) => void
}
