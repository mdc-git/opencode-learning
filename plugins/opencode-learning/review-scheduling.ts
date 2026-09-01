import {
  canStartReview,
  evaluateAutomaticReview,
  isReviewSessionUnavailable
} from './review-trigger.ts'
import type { InternalMailbox } from './mailbox.ts'
import type { ExperienceRecorder } from './recorder.ts'
import { runReview, type ReviewOptions } from './review.ts'
import type { ReviewOutcome } from './review-results.ts'
import {
  createClaimGuard,
  markAutomaticReview,
  waitForPreviousOwner,
  type ReviewState
} from './review-state.ts'
import type { OpenCodeContext } from './sdk.ts'
import type { SkillStore } from './store.ts'
import type { Telemetry } from './telemetry.ts'
import type { ExperienceSnapshot, LearningConfig } from './types.ts'
import type { TriggerDecision } from './scoring.ts'

type PreparedReview = { batch: ExperienceSnapshot; candidate: TriggerDecision | undefined }
type ReviewPipelineOptions = {
  ctx: OpenCodeContext
  recorder: ExperienceRecorder
  store: SkillStore
  telemetry: Telemetry
  mailbox: InternalMailbox
  config: LearningConfig
  state: ReviewState
}

export class ReviewPipeline {
  private readonly state: ReviewState
  private readonly recorder: ExperienceRecorder
  private readonly canClaimSession: ReturnType<typeof createClaimGuard>
  private disposed = false
  private readonly invalidatedSessions = new Set<string>()
  private readonly activeReviews = new Set<Promise<unknown>>()
  private readonly activeReviewsBySession = new Map<string, Set<Promise<unknown>>>()
  readonly ctx: OpenCodeContext
  readonly store: SkillStore
  readonly telemetry: Telemetry
  readonly mailbox: InternalMailbox
  readonly config: LearningConfig

  constructor({ ctx, recorder, store, telemetry, mailbox, config, state }: ReviewPipelineOptions) {
    this.ctx = ctx
    this.recorder = recorder
    this.store = store
    this.telemetry = telemetry
    this.mailbox = mailbox
    this.config = config
    this.state = state
    this.canClaimSession = createClaimGuard(
      state,
      this,
      this.invalidatedSessions,
      () => this.disposed
    )
  }

  private recordFingerprint(
    sessionID: string,
    triggerDecision: TriggerDecision | undefined,
    outcome: string
  ): void {
    if (triggerDecision === undefined || triggerDecision.fingerprint.length === 0) {
      return
    }

    const reviewed = this.state.reviewedFingerprints.get(sessionID) ?? new Map<string, string>()
    reviewed.set(triggerDecision.fingerprint, outcome)
    this.state.reviewedFingerprints.set(sessionID, reviewed)
  }

  private recordReviewOutcome(
    sessionID: string,
    candidate: TriggerDecision | undefined,
    outcome: ReviewOutcome
  ): ReviewOutcome {
    if (['no-change', 'staged', 'applied'].includes(outcome.status)) {
      this.recordFingerprint(
        sessionID,
        candidate,
        outcome.status === 'no-change' ? 'no-change' : 'accepted'
      )
    }

    return outcome
  }

  private canDrain(sessionID: string): boolean {
    return this.isActive(sessionID) && !this.state.inFlight.has(sessionID)
  }

  private isUnavailable(sessionID: string): boolean {
    return isReviewSessionUnavailable(sessionID, !this.isActive(sessionID), this.mailbox)
  }

  private captureAutomaticReview(
    sessionID: string,
    exp: ExperienceSnapshot
  ): PreparedReview | undefined {
    const candidate = evaluateAutomaticReview({
      sessionId: sessionID,
      exp,
      scoreThreshold: this.config.scoreThreshold,
      workflowCooldownTurns: this.config.workflowCooldownTurns,
      successfulTurns: this.state.successfulTurns,
      lastAutomaticReviewTurn: this.state.lastAutomaticReviewTurn,
      reviewedFingerprints: this.state.reviewedFingerprints,
      lastSuppressedFingerprint: this.state.lastSuppressedFingerprint,
      telemetry: this.telemetry
    })
    if (candidate === undefined) {
      return undefined
    }

    const batch = this.recorder.take(sessionID)
    return batch === undefined ? undefined : { batch, candidate }
  }

  isActive(sessionID: string): boolean {
    return this.canClaimSession(sessionID, false)
  }

  invalidateSession(sessionID: string): void {
    this.invalidatedSessions.add(sessionID)
  }

  async claimSession(sessionID: string, isExpectedOwner: boolean): Promise<void> {
    if (!this.canClaimSession(sessionID, isExpectedOwner)) {
      return
    }

    const claim = Symbol('review-session-claim')
    this.state.claims.set(sessionID, claim)
    await waitForPreviousOwner(this.state, this, sessionID)

    if (this.state.claims.get(sessionID) !== claim) {
      return
    }

    if (!this.canClaimSession(sessionID, isExpectedOwner)) {
      return
    }

    this.invalidatedSessions.delete(sessionID)
    this.state.owners.set(sessionID, this)
    this.state.claims.delete(sessionID)
    this.drain(sessionID)
  }

  captureReview(sessionID: string, isForced: boolean): PreparedReview | undefined {
    const exp = this.recorder.snapshot(sessionID)
    if (exp === undefined) {
      return undefined
    }

    if (isForced) {
      const batch = this.recorder.take(sessionID)
      return batch === undefined ? undefined : { batch, candidate: undefined }
    }

    return this.captureAutomaticReview(sessionID, exp)
  }

  schedule(sessionID: string, options: { force?: boolean }): Record<string, unknown> {
    const isForcedRequest = options.force === true
    if (this.isUnavailable(sessionID)) {
      return {
        scheduled: false,
        force: isForcedRequest,
        reason: 'session is not eligible for review'
      }
    }

    const isForced = isForcedRequest || this.state.requests.get(sessionID) === true
    this.state.requests.set(sessionID, isForced)
    return { scheduled: true, force: isForced }
  }

  executionFinished(sessionID: string, terminalType: string): void {
    if (this.isUnavailable(sessionID)) {
      return
    }

    const isSucceeded = terminalType === 'session.execution.succeeded'
    this.recordSuccessfulTurn(sessionID, isSucceeded)
    const isForced = this.state.requests.get(sessionID) === true
    this.state.requests.delete(sessionID)
    if (!isForced && !isSucceeded) {
      return
    }

    this.dispatchReview(sessionID, terminalType, isForced)
  }

  dispatchReview(sessionID: string, terminalType: string, isForced: boolean): void {
    if (this.state.inFlight.has(sessionID)) {
      const pending = this.state.pending.get(sessionID) ?? { force: false, terminalType }
      pending.force ||= isForced
      pending.terminalType = terminalType
      this.state.pending.set(sessionID, pending)
      return
    }

    this.start(sessionID, { force: isForced, terminalType })
  }

  recordSuccessfulTurn(sessionID: string, isSucceeded: boolean): void {
    if (!isSucceeded) {
      return
    }

    this.state.successfulTurns.set(sessionID, (this.state.successfulTurns.get(sessionID) ?? 0) + 1)
    void this.telemetry.recordSuccessfulTurn().catch((error: unknown) => {
      console.error('[opencode-learning] successful-turn telemetry failed', error)
    })
  }

  start(sessionID: string, { force, terminalType }: ReviewOptions): void {
    if (
      !canStartReview({
        sessionId: sessionID,
        isDisposed: this.isUnavailable(sessionID),
        isEnabled: this.config.enabled,
        inFlight: this.state.inFlight,
        mailbox: this.mailbox
      })
    ) {
      return
    }

    const prepared = this.captureReview(sessionID, force)
    if (prepared === undefined) {
      return
    }

    this.state.inFlight.add(sessionID)
    markAutomaticReview(this.state, sessionID, force)
    const review = runReview(this, sessionID, prepared.batch, {
      force,
      terminalType,
      triggerDecision: prepared.candidate
    })
      .then((outcome) => this.recordReviewOutcome(sessionID, prepared.candidate, outcome))
      .catch((error: unknown) => {
        console.error('[opencode-learning] review failed', error)
      })
      .finally(() => {
        this.state.inFlight.delete(sessionID)
        this.drain(sessionID)
      })
    this.activeReviews.add(review)
    const sessionReviews = this.activeReviewsBySession.get(sessionID) ?? new Set<Promise<unknown>>()
    sessionReviews.add(review)
    this.activeReviewsBySession.set(sessionID, sessionReviews)
    void review.finally(() => {
      this.activeReviews.delete(review)
      sessionReviews.delete(review)
      if (sessionReviews.size === 0) {
        this.activeReviewsBySession.delete(sessionID)
      }
    })
  }

  drain(sessionID: string): void {
    if (!this.canDrain(sessionID)) {
      return
    }

    const pending = this.state.pending.get(sessionID)
    if (!pending) {
      return
    }

    this.state.pending.delete(sessionID)
    const owner = this.state.owners.get(sessionID) ?? this
    owner.start(sessionID, pending)
  }

  cleanup(): void {
    this.disposed = true
  }

  async waitForReviews(): Promise<void> {
    await Promise.allSettled(this.activeReviews)
  }

  async waitForSession(sessionID: string): Promise<void> {
    const activeReviews = this.activeReviewsBySession.get(sessionID)
    if (activeReviews === undefined) {
      return
    }

    await Promise.allSettled(activeReviews)
  }
}
