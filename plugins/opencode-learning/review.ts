import { normalizeCreateProposal, redactError, SESSION_ID_KEY } from './shared.ts'
import {
  createAutomaticReviewStart,
  finishReview,
  type ReviewOutcome,
  type ReviewScore,
  type ReviewValidation
} from './review-results.ts'
import { retrieveCandidates } from './review-candidates.ts'
import {
  notifySession,
  runReflector as runReflectorSession,
  runValidator as runValidatorSession
} from './review-sessions.ts'
import { validateProposal } from './store-validation.ts'
import type { TriggerDecision } from './scoring.ts'
import type {
  Candidate,
  ExperienceSnapshot,
  LearningConfig,
  Proposal,
  ValidationSubmission
} from './types.ts'
import type { InternalMailbox } from './mailbox.ts'
import type { OpenCodeContext, SessionInfo } from './sdk.ts'
import type { SkillStore } from './store.ts'
import type { Telemetry } from './telemetry.ts'

export type ReviewOptions = {
  force: boolean
  terminalType: string
  triggerDecision?: TriggerDecision
}
type ReviewAttemptOptions = { triggerDecision?: TriggerDecision; onReflectorStart?: () => void }
type ReviewPreparation = {
  proposal: Proposal
  candidates: Candidate[]
  directory: string
  model: SessionInfo['model'] | undefined
}
type ReviewErrorOptions = Pick<ReviewOptions, 'force' | 'terminalType'> & {
  score: ReviewScore
  error: unknown
}
type CompleteReviewOptions = ReviewOptions & { score: ReviewScore; onReflectorStart: () => void }

type ReviewRunContext = {
  ctx: OpenCodeContext
  store: SkillStore
  telemetry: Telemetry
  config: LearningConfig
  mailbox: InternalMailbox
  isActive: (sessionID: string) => boolean
}

export async function runReview(
  context: ReviewRunContext,
  sessionID: string,
  exp: ExperienceSnapshot,
  options: ReviewOptions
): Promise<ReviewOutcome> {
  const { force, terminalType, triggerDecision } = options

  const score = reviewScore(triggerDecision)
  const onReflectorStart = createAutomaticReviewStart(context.telemetry, force)
  await context.telemetry.recordExperience(exp).catch((error: unknown) => {
    console.error('[opencode-learning] telemetry recordExperience failed', error)
  })
  try {
    return await completeReview(context, sessionID, exp, {
      ...options,
      score,
      onReflectorStart
    })
  } catch (error) {
    return handleReviewError(context, sessionID, { terminalType, force, score, error })
  }
}

function reviewScore(triggerDecision: TriggerDecision | undefined): ReviewScore {
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

async function reviewAttempt(
  context: ReviewRunContext,
  sessionID: string,
  exp: ExperienceSnapshot,
  options: ReviewAttemptOptions
) {
  assertReviewActive(context, sessionID)

  const prepared = await prepareReview(context, sessionID, exp, options)
  const { proposal } = prepared
  assertReviewActive(context, sessionID)
  const validation = await validateReviewProposal(context, exp, prepared, proposal)
  assertReviewActive(context, sessionID)

  return { proposal, validation }
}

function assertReviewActive(context: ReviewRunContext, sessionID: string): void {
  if (!context.isActive(sessionID)) {
    throw new Error('learning pipeline was disposed during review')
  }
}

async function prepareReview(
  context: ReviewRunContext,
  sessionID: string,
  exp: ExperienceSnapshot,
  { triggerDecision, onReflectorStart }: ReviewAttemptOptions
): Promise<ReviewPreparation> {
  const parent = await context.ctx.session.get({ [SESSION_ID_KEY]: sessionID })
  const { directory } = parent.location
  const { model } = parent
  const candidates = await retrieveCandidates({
    ctx: context.ctx,
    exp,
    store: context.store,
    maxCandidates: context.config.maxCandidates
  })
  const proposal = normalizeCreateProposal(
    await runReflectorSession({
      ctx: context.ctx,
      mailbox: context.mailbox,
      config: context.config,
      directory,
      model,
      exp,
      candidates,
      triggerDecision,
      onReflectorStart
    })
  )
  proposal.scope = 'project'
  return { proposal, candidates, directory, model }
}

async function validateReviewProposal(
  context: ReviewRunContext,
  exp: ExperienceSnapshot,
  prepared: ReviewPreparation,
  proposal: Proposal
): Promise<ReviewValidation> {
  const deterministic = validateProposal(proposal, {
    confidenceThreshold: context.config.confidenceThreshold
  })
  let agentValidation: ValidationSubmission = {
    decision: 'accept',
    reason: 'agent validation disabled',
    warnings: []
  }
  if (
    [context.config.agentValidation, deterministic.ok, proposal.decision !== 'none'].every(Boolean)
  ) {
    agentValidation = await runValidatorSession({
      ctx: context.ctx,
      mailbox: context.mailbox,
      config: context.config,
      directory: prepared.directory,
      model: prepared.model,
      exp,
      candidates: prepared.candidates,
      proposal,
      deterministic
    })
  }

  const isAccepted = proposal.decision === 'none' || agentValidation.decision === 'accept'
  return { deterministic, agent: agentValidation, ok: deterministic.ok && isAccepted }
}

async function runReviewAttempts(
  context: ReviewRunContext,
  sessionID: string,
  exp: ExperienceSnapshot,
  options: ReviewAttemptOptions
) {
  try {
    return await reviewAttempt(context, sessionID, exp, options)
  } catch (error) {
    if (!context.isActive(sessionID)) {
      throw error
    }

    return reviewAttempt(context, sessionID, exp, options)
  }
}

async function completeReview(
  context: ReviewRunContext,
  sessionID: string,
  exp: ExperienceSnapshot,
  { force, terminalType, triggerDecision, score, onReflectorStart }: CompleteReviewOptions
): Promise<ReviewOutcome> {
  if (!context.isActive(sessionID)) {
    return { status: 'disposed' }
  }

  const attempt = await runReviewAttempts(context, sessionID, exp, {
    triggerDecision,
    onReflectorStart
  })
  if (!context.isActive(sessionID)) {
    return { status: 'disposed' }
  }

  return finishReview({
    ctx: context.ctx,
    store: context.store,
    telemetry: context.telemetry,
    config: context.config,
    [SESSION_ID_KEY]: sessionID,
    terminalType,
    force,
    score,
    isActive: () => context.isActive(sessionID),
    proposal: attempt.proposal,
    validation: attempt.validation
  })
}

async function handleReviewError(
  context: ReviewRunContext,
  sessionID: string,
  { terminalType, force, score, error }: ReviewErrorOptions
): Promise<ReviewOutcome> {
  if (!context.isActive(sessionID)) {
    return { status: 'disposed' }
  }

  await context.telemetry
    .recordReview({
      [SESSION_ID_KEY]: sessionID,
      trigger: ['automatic', 'forced'][Number(force)],
      terminalType,
      score,
      decision: 'error',
      error: redactError(error)
    })
    .catch(() => undefined)

  if ([force, context.config.notify].every(Boolean)) {
    await notifySession(
      context.ctx,
      sessionID,
      `[opencode-learning] Review failed: ${redactError(error)}`
    )
  }

  if (!force) {
    await context.telemetry.recordTriggerOutcome('error').catch(console.error)
  }

  throw error
}
