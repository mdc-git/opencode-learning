import { notifySession } from './review-sessions.ts'
import { SESSION_ID_KEY } from './shared.ts'
import type { OpenCodeContext } from './sdk.ts'
import type { SkillStore } from './store.ts'
import { stage as stageSkill } from './store-operations.ts'
import type { Proposal, Validation, ValidationSubmission, LearningConfig } from './types.ts'
import type { TriggerDecision } from './scoring.ts'
import type { Telemetry } from './telemetry.ts'

export type ReviewValidation = {
  deterministic: Validation
  agent: ValidationSubmission
  ok: boolean
}
export type ReviewScore =
  | {
      score: number
      threshold: number
      reasons: TriggerDecision['reasons']
      signals: TriggerDecision['strongSignals']
    }
  | undefined
type CompletedReview = { proposal: Proposal; validation: ReviewValidation; score: ReviewScore }
export type ReviewOutcome =
  | (CompletedReview & { status: 'no-change' })
  | (CompletedReview & { status: 'staged'; staged: { id: string; dir: string } })
  | (CompletedReview & { status: 'applied'; applied: unknown })
  | { status: 'disposed' }
type ReviewResultOptions = {
  ctx: OpenCodeContext
  store: SkillStore
  telemetry: Telemetry
  config: LearningConfig
  sessionID: string
  terminalType: string
  force: boolean
  score: ReviewScore
  isActive: () => boolean
  proposal: Proposal
  validation: ReviewValidation
}

export function createAutomaticReviewStart(telemetry: Telemetry, isForced: boolean): () => void {
  let hasStarted = false
  return () => {
    if (isForced || hasStarted) {
      return
    }

    hasStarted = true
    void telemetry.recordAutomaticReview().catch((error: unknown) => {
      console.error('[opencode-learning] automatic-review telemetry failed', error)
    })
  }
}

export async function finishReview(options: ReviewResultOptions): Promise<ReviewOutcome> {
  const { proposal, validation } = options
  await options.telemetry
    .recordReview({
      [SESSION_ID_KEY]: options.sessionID,
      trigger: ['automatic', 'forced'][Number(options.force)],
      terminalType: options.terminalType,
      score: options.score,
      decision: proposal.decision,
      skillId: proposal.skillId,
      validation
    })
    .catch((error: unknown) => {
      console.error('[opencode-learning] telemetry recordReview failed', error)
    })
  return options.isActive() ? finishActiveReview(options) : { status: 'disposed' }
}

async function finishActiveReview(options: ReviewResultOptions): Promise<ReviewOutcome> {
  const { proposal, validation } = options
  if (proposal.decision === 'none') {
    return finishNoChange(options)
  }

  if (!validation.ok) {
    return finishNoChange(options)
  }

  if (options.config.mode === 'suggest') {
    return finishStaged(options)
  }

  return finishApplied(options)
}

async function finishNoChange({
  ctx,
  telemetry,
  sessionID,
  force,
  config,
  score,
  proposal,
  validation
}: ReviewResultOptions): Promise<ReviewOutcome> {
  if (force && config.notify) {
    await notifySession(
      ctx,
      sessionID,
      `[opencode-learning] Review completed with no applied change: ${summarizeNoChange(proposal, validation)}`
    )
  }

  if (!force) {
    await telemetry.recordTriggerOutcome('no-change').catch(console.error)
  }

  return { status: 'no-change', proposal, validation, score }
}

async function finishStaged({
  ctx,
  telemetry,
  sessionID,
  force,
  config,
  score,
  proposal,
  validation,
  store
}: ReviewResultOptions): Promise<ReviewOutcome> {
  const staged = await stageSkill(store, proposal, validation)
  if (config.notify) {
    await notifySession(
      ctx,
      sessionID,
      `[opencode-learning] Staged ${proposal.decision} proposal ${staged.id} for ${proposal.skillId}. Inspect with /learn-show ${staged.id} or /learn-pending.`,
      {
        type: 'proposal-staged',
        proposalId: staged.id,
        decision: proposal.decision,
        skillId: proposal.skillId
      }
    )
  }

  if (!force) {
    await telemetry.recordTriggerOutcome('staged').catch(console.error)
  }

  return { status: 'staged', staged, proposal, validation, score }
}

async function finishApplied({
  ctx,
  telemetry,
  sessionID,
  force,
  config,
  score,
  proposal,
  validation,
  store
}: ReviewResultOptions): Promise<ReviewOutcome> {
  const skillId = proposal.skillId!
  let applied: unknown
  if (proposal.decision === 'create') {
    applied = await store.create(proposal, { scope: proposal.scope! })
    await telemetry.recordCreated(skillId)
  } else {
    applied = await store.patch(proposal, { scope: proposal.scope! })
    await telemetry.recordPatched(skillId)
  }

  await ctx.skill.reload()
  if ([force, config.notify].every(Boolean)) {
    await notifySession(
      ctx,
      sessionID,
      `[opencode-learning] Applied ${proposal.decision} for learned skill ${proposal.skillId} and reloaded skills.`
    )
  }

  if (!force) {
    await telemetry.recordTriggerOutcome('applied').catch(console.error)
  }

  return { status: 'applied', applied, proposal, validation, score }
}

function summarizeNoChange(proposal: Proposal, validation: ReviewValidation): string {
  if (proposal.decision === 'none') {
    return noChangeProposalReason(proposal.reason)
  }

  if (!validation.deterministic.ok) {
    return validationErrors(validation)
  }

  return rejectedReason(validation)
}

function noChangeProposalReason(reason: string | undefined): string {
  return reason === undefined || reason.length === 0 ? 'nothing durable was found' : reason
}

function validationErrors(validation: ReviewValidation): string {
  return validation.deterministic.errors.join('; ')
}

function rejectedReason(validation: ReviewValidation): string {
  return validation.agent.decision === 'reject' ? validation.agent.reason : 'no durable change'
}
