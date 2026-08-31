import { notifySession } from './events.ts'
import { redactError, SESSION_ID_KEY } from './shared.ts'
import type { OpenCodeContext, SessionInfo } from './sdk.ts'
import type { SkillStore } from './store.ts'
import type {
  Candidate,
  ExperienceSnapshot,
  Proposal,
  Validation,
  ValidationSubmission
} from './types.ts'
import type { TriggerDecision } from './scoring.ts'
import type { Telemetry } from './telemetry.ts'
import type {
  ReviewAttempt,
  ReviewFailureOptions,
  ReviewOutcome,
  ReviewResultOptions,
  ReviewScore,
  ReviewValidation
} from './review-types.ts'
import { recordReviewResult, summarizeNoChange } from './review-result-details.ts'

export async function maybeValidateProposal({
  enabled,
  deterministic,
  proposal,
  directory,
  model,
  exp,
  candidates,
  validate
}: {
  enabled: boolean
  deterministic: Validation
  proposal: Proposal
  directory: string
  model: SessionInfo['model'] | undefined
  exp: ExperienceSnapshot
  candidates: Candidate[]
  validate: (options: {
    directory: string
    model: SessionInfo['model'] | undefined
    exp: ExperienceSnapshot
    candidates: Candidate[]
    proposal: Proposal
    deterministic: Validation
  }) => Promise<ValidationSubmission>
}): Promise<ValidationSubmission> {
  if (!enabled || !deterministic.ok || proposal.decision === 'none') {
    return {
      decision: 'accept',
      reason: 'agent validation disabled',
      warnings: []
    }
  }

  return validate({ directory, model, exp, candidates, proposal, deterministic })
}

export function reviewValidation(
  deterministic: Validation,
  proposal: Proposal,
  agent: ValidationSubmission
): ReviewValidation {
  return {
    deterministic,
    agent,
    ok: deterministic.ok && (proposal.decision === 'none' || agent.decision === 'accept')
  }
}

export function reviewScore(triggerDecision: TriggerDecision | undefined): ReviewScore {
  if (triggerDecision === undefined) {
    return undefined
  }

  return {
    score: triggerDecision.score,
    threshold: triggerDecision.threshold,
    reasons: triggerDecision.reasons,
    signals: triggerDecision.strongSignals
  }
}

export async function retryReviewAttempt(
  run: () => Promise<ReviewAttempt>,
  shouldStop: () => boolean
): Promise<ReviewAttempt> {
  try {
    return await run()
  } catch (error) {
    if (shouldStop()) {
      throw error
    }

    return run()
  }
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

export async function recordReviewFailure({
  telemetry,
  ctx,
  sessionID,
  terminalType,
  force,
  score,
  error,
  notify
}: ReviewFailureOptions): Promise<void> {
  await telemetry
    .recordReview({
      [SESSION_ID_KEY]: sessionID,
      trigger: force ? 'forced' : 'automatic',
      terminalType,
      score,
      decision: 'error',
      error: redactError(error)
    })
    .catch(() => undefined)
  if (!force) {
    await telemetry.recordTriggerOutcome('error').catch(console.error)
  }

  if (force && notify) {
    await notifySession(ctx, sessionID, `[opencode-learning] Review failed: ${redactError(error)}`)
  }
}

export async function finishReview(options: ReviewResultOptions): Promise<ReviewOutcome> {
  const { proposal, validation } = options
  await recordReviewResult(options)
  if (!validation.ok || proposal.decision === 'none') {
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
  triggerDecision,
  proposal,
  validation,
  recordFingerprint
}: ReviewResultOptions): Promise<ReviewOutcome> {
  if (force && config.notify) {
    await notifySession(
      ctx,
      sessionID,
      `[opencode-learning] Review completed with no applied change: ${summarizeNoChange(proposal, validation)}`
    )
  }

  recordFingerprint(sessionID, triggerDecision, 'no-change')
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
  triggerDecision,
  proposal,
  validation,
  store,
  recordFingerprint
}: ReviewResultOptions): Promise<ReviewOutcome> {
  const staged = await store.stage(proposal, validation)
  if (force && config.notify) {
    await notifySession(
      ctx,
      sessionID,
      `[opencode-learning] Staged ${proposal.decision} proposal ${staged.id} for ${proposal.skillId}. Inspect with /learn-show ${staged.id} or /learn-pending.`
    )
  }

  recordFingerprint(sessionID, triggerDecision, 'accepted')
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
  triggerDecision,
  proposal,
  validation,
  store,
  recordFingerprint
}: ReviewResultOptions): Promise<ReviewOutcome> {
  const applied = await applyProposal(store, proposal)
  await recordAppliedSkill(telemetry, proposal)
  await ctx.skill.reload()
  await notifyAppliedReview({
    ctx,
    [SESSION_ID_KEY]: sessionID,
    isForced: force,
    shouldNotify: config.notify,
    proposal
  })
  recordFingerprint(sessionID, triggerDecision, 'accepted')
  await recordAcceptedReviewOutcome(telemetry, force)

  return { status: 'applied', applied, proposal, validation, score }
}

async function applyProposal(store: SkillStore, proposal: Proposal): Promise<unknown> {
  if (proposal.decision === 'create') {
    return store.create(proposal, { scope: proposal.scope })
  }

  return store.patch(proposal, { scope: proposal.scope })
}

async function recordAppliedSkill(telemetry: Telemetry, proposal: Proposal): Promise<void> {
  const skillId = proposal.skillId ?? ''
  if (proposal.decision === 'create') {
    await telemetry.recordCreated(skillId)
    return
  }

  await telemetry.recordPatched(skillId)
}

async function notifyAppliedReview({
  ctx,
  sessionID,
  isForced,
  shouldNotify,
  proposal
}: {
  ctx: OpenCodeContext
  sessionID: string
  isForced: boolean
  shouldNotify: boolean
  proposal: Proposal
}): Promise<void> {
  if (isForced && shouldNotify) {
    await notifySession(
      ctx,
      sessionID,
      `[opencode-learning] Applied ${proposal.decision} for learned skill ${proposal.skillId} and reloaded skills.`
    )
  }
}

async function recordAcceptedReviewOutcome(telemetry: Telemetry, isForced: boolean): Promise<void> {
  if (!isForced) {
    await telemetry.recordTriggerOutcome('applied').catch(console.error)
  }
}
