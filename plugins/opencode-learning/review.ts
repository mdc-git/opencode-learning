import { normalizeCreateProposal, SESSION_ID_KEY } from './shared.ts'
import {
  createAutomaticReviewStart,
  finishReview,
  maybeValidateProposal,
  recordReviewFailure,
  reviewScore,
  reviewValidation,
  retryReviewAttempt
} from './review-results.ts'
import { retrieveCandidates } from './review-candidates.ts'
import { recordReviewFingerprint } from './review-fingerprints.ts'
import {
  type ReflectorOptions,
  runReflector as runReflectorSession,
  runValidator as runValidatorSession,
  type ValidatorOptions
} from './review-sessions.ts'
import { validateProposal } from './store.ts'
import type { TriggerDecision } from './scoring.ts'
import type { ExperienceSnapshot, Proposal, ValidationSubmission } from './types.ts'
import type { OpenCodeContext, SessionInfo } from './sdk.ts'
import type {
  ReviewAttempt,
  ReviewAttemptOptions,
  ReviewErrorOptions,
  ReviewOptions,
  ReviewOutcome,
  ReviewPreparation,
  ReviewScore
} from './review-types.ts'
import { ReviewScheduling } from './review-scheduling.ts'

export { Curator } from './review-curator.ts'

export class ReviewPipeline extends ReviewScheduling {
  async reviewAttempt(
    sessionID: string,
    exp: ExperienceSnapshot,
    { triggerDecision, onReflectorStart }: ReviewAttemptOptions = {}
  ): Promise<ReviewAttempt> {
    const prepared = await this.prepareReview(sessionID, exp, triggerDecision, onReflectorStart)
    const { proposal } = prepared
    const deterministic = validateProposal(proposal, {
      confidenceThreshold: this.config.confidenceThreshold
    })
    const agentValidation = await maybeValidateProposal({
      enabled: this.config.agentValidation,
      deterministic,
      proposal,
      directory: prepared.directory,
      model: prepared.model,
      exp,
      candidates: prepared.candidates,
      validate: async (options) => this.runValidator(options)
    })

    this.assertReviewActive()
    return { proposal, validation: reviewValidation(deterministic, proposal, agentValidation) }
  }

  async prepareReview(
    sessionID: string,
    exp: ExperienceSnapshot,
    triggerDecision: TriggerDecision | undefined,
    onReflectorStart: (() => void) | undefined
  ): Promise<ReviewPreparation> {
    const parent = await this.ctx.session.get({ [SESSION_ID_KEY]: sessionID })
    const { directory, model } = reviewParent(parent, this.store.projectRoot)
    const candidates = await retrieveCandidates({
      ctx: this.ctx,
      exp,
      store: this.store,
      maxCandidates: this.config.maxCandidates
    })
    const proposal = normalizeCreateProposal(
      await this.runReflector({
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

  assertReviewActive(): void {
    if (this.disposed) {
      throw new Error('learning pipeline was disposed during review')
    }
  }

  async runReviewAttempts(
    sessionID: string,
    exp: ExperienceSnapshot,
    options: ReviewAttemptOptions
  ): Promise<ReviewAttempt> {
    return retryReviewAttempt(
      async () => this.reviewAttempt(sessionID, exp, options),
      () => this.disposed
    )
  }

  async reviewWithRetry(
    sessionID: string,
    exp: ExperienceSnapshot,
    options: ReviewOptions = {}
  ): Promise<ReviewOutcome> {
    const { force, terminalType, triggerDecision } = reviewOptions(options)
    if (this.isUnavailable(sessionID)) {
      return { status: 'skipped' }
    }

    const score = reviewScore(triggerDecision)
    const onReflectorStart = createAutomaticReviewStart(this.telemetry, force)
    await this.recordReviewExperience(exp)
    try {
      return await this.completeReview({
        [SESSION_ID_KEY]: sessionID,
        exp,
        force,
        terminalType,
        triggerDecision,
        score,
        onReflectorStart
      })
    } catch (error) {
      return this.handleReviewError({ sessionId: sessionID, terminalType, force, score, error })
    }
  }

  isUnavailable(sessionID: string): boolean {
    return this.disposed || !this.config.enabled || this.mailbox.isInternalSession(sessionID)
  }

  async recordReviewExperience(exp: ExperienceSnapshot): Promise<void> {
    await this.telemetry.recordExperience(exp).catch((error: unknown) => {
      console.error('[opencode-learning] telemetry recordExperience failed', error)
    })
  }

  async completeReview({
    sessionID,
    exp,
    force,
    terminalType,
    triggerDecision,
    score,
    onReflectorStart
  }: {
    sessionID: string
    exp: ExperienceSnapshot
    force: boolean
    terminalType: string
    triggerDecision: TriggerDecision | undefined
    score: ReviewScore
    onReflectorStart: () => void
  }): Promise<ReviewOutcome> {
    const attempt = await this.runReviewAttempts(sessionID, exp, {
      force,
      terminalType,
      triggerDecision,
      onReflectorStart
    })
    if (this.disposed) {
      return { status: 'disposed' }
    }

    return finishReview({
      ctx: this.ctx,
      store: this.store,
      telemetry: this.telemetry,
      config: this.config,
      [SESSION_ID_KEY]: sessionID,
      terminalType,
      force,
      score,
      triggerDecision,
      proposal: attempt.proposal,
      validation: attempt.validation,
      recordFingerprint: (id, decision, outcome) => {
        this.recordFingerprint(id, decision, outcome)
      }
    })
  }

  async handleReviewError({
    sessionId,
    terminalType,
    force,
    score,
    error
  }: ReviewErrorOptions): Promise<ReviewOutcome> {
    if (this.disposed) {
      return { status: 'disposed' }
    }

    await recordReviewFailure({
      telemetry: this.telemetry,
      ctx: this.ctx,
      [SESSION_ID_KEY]: sessionId,
      terminalType,
      force,
      score,
      error,
      notify: this.config.notify
    })
    throw error
  }

  recordFingerprint(
    sessionID: string,
    triggerDecision: TriggerDecision | undefined,
    outcome: string
  ): void {
    recordReviewFingerprint(this.reviewedFingerprints, sessionID, triggerDecision, outcome)
  }

  async runReflector(options: ReflectorOptions): Promise<Proposal> {
    return runReflectorSession({
      ctx: this.ctx,
      mailbox: this.mailbox,
      config: this.config,
      ...options
    })
  }

  async runValidator(options: ValidatorOptions): Promise<ValidationSubmission> {
    return runValidatorSession({
      ctx: this.ctx,
      mailbox: this.mailbox,
      config: this.config,
      ...options
    })
  }

  async cleanup(): Promise<void> {
    this.disposed = true
    this.requests.clear()
    this.pending.clear()
    this.lastAutomaticReviewTurn.clear()
    this.successfulTurns.clear()
    this.reviewedFingerprints.clear()
    this.lastSuppressedFingerprint.clear()
  }

  async waitForReviews(): Promise<void> {
    await Promise.allSettled(this.activeReviews)
    this.activeReviews.clear()
  }
}

function reviewParent(
  parent: SessionInfo | undefined,
  projectRoot: string
): { directory: string; model: SessionInfo['model'] | undefined } {
  return {
    directory: reviewDirectory(parent, projectRoot),
    model: reviewModel(parent)
  }
}

function reviewDirectory(parent: SessionInfo | undefined, projectRoot: string): string {
  if (parent === undefined) {
    return projectRoot
  }

  return parent.location?.directory ?? projectRoot
}

function reviewModel(parent: SessionInfo | undefined): SessionInfo['model'] | undefined {
  return parent?.model
}

function reviewOptions(options: ReviewOptions): {
  force: boolean
  terminalType: string
  triggerDecision: TriggerDecision | undefined
} {
  return {
    force: options.force ?? false,
    terminalType: options.terminalType ?? 'session.execution.succeeded',
    triggerDecision: options.triggerDecision
  }
}
