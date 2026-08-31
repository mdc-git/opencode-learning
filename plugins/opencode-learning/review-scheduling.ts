import { SESSION_ID_KEY } from './shared.ts'
import {
  canStartReview,
  evaluateAutomaticReview,
  isReviewSessionUnavailable,
  queuePendingReview,
  shouldReviewAfterExecution
} from './review-trigger.ts'
import type { InternalMailbox } from './mailbox.ts'
import type { ExperienceRecorder } from './recorder.ts'
import type { OpenCodeContext } from './sdk.ts'
import type { Telemetry } from './telemetry.ts'
import type { ExperienceSnapshot, LearningConfig } from './types.ts'
import type { TriggerDecision } from './scoring.ts'
import type {
  PreparedReview,
  ReviewOptions,
  ReviewOutcome,
  ReviewPipelineOptions,
  ReviewRequest
} from './review-types.ts'

export abstract class ReviewScheduling {
  protected readonly ctx: OpenCodeContext
  protected readonly recorder: ExperienceRecorder
  protected readonly store: ReviewPipelineOptions['store']
  protected readonly telemetry: Telemetry
  protected readonly mailbox: InternalMailbox
  protected readonly config: LearningConfig
  protected readonly inFlight = new Set<string>()
  protected readonly requests = new Map<string, ReviewRequest>()
  protected readonly pending = new Map<string, ReviewRequest>()
  protected disposed = false
  protected readonly lastAutomaticReviewTurn = new Map<string, number>()
  protected readonly successfulTurns = new Map<string, number>()
  protected readonly reviewedFingerprints = new Map<string, Map<string, string>>()
  protected readonly lastSuppressedFingerprint = new Map<string, string>()
  protected readonly activeReviews = new Set<Promise<unknown>>()

  constructor({ ctx, recorder, store, telemetry, mailbox, config }: ReviewPipelineOptions) {
    this.ctx = ctx
    this.recorder = recorder
    this.store = store
    this.telemetry = telemetry
    this.mailbox = mailbox
    this.config = config
  }

  protected abstract reviewWithRetry(
    sessionID: string,
    exp: ExperienceSnapshot,
    options?: ReviewOptions
  ): Promise<ReviewOutcome>

  captureReview(sessionID: string, isForced: boolean): PreparedReview | undefined {
    const exp = this.recorder.snapshot(sessionID)
    if (exp === undefined) {
      return undefined
    }

    if (isForced) {
      return this.takeReviewBatch(sessionID, undefined)
    }

    const candidate = this.automaticCandidate(sessionID, exp)
    if (candidate === undefined) {
      return undefined
    }

    return this.takeReviewBatch(sessionID, candidate)
  }

  automaticCandidate(sessionID: string, exp: ExperienceSnapshot): TriggerDecision | undefined {
    return evaluateAutomaticReview({
      [SESSION_ID_KEY]: sessionID,
      exp,
      scoreThreshold: this.config.scoreThreshold,
      workflowCooldownTurns: this.config.workflowCooldownTurns,
      successfulTurns: this.successfulTurns,
      lastAutomaticReviewTurn: this.lastAutomaticReviewTurn,
      reviewedFingerprints: this.reviewedFingerprints,
      lastSuppressedFingerprint: this.lastSuppressedFingerprint,
      telemetry: this.telemetry
    })
  }

  takeReviewBatch(
    sessionID: string,
    candidate: TriggerDecision | undefined
  ): PreparedReview | undefined {
    const batch = this.recorder.take(sessionID)
    return batch === undefined ? undefined : { batch, candidate }
  }

  schedule(
    sessionID: string,
    { force = false }: { force?: boolean } = {}
  ): Record<string, unknown> {
    if (!this.isSchedulable(sessionID)) {
      return { scheduled: false, force, reason: 'session is not eligible for review' }
    }

    return scheduleRequest(this.requests, sessionID, force)
  }

  isSchedulable(sessionID: string): boolean {
    return sessionID.length > 0 && !this.disposed && !this.mailbox.isInternalSession(sessionID)
  }

  executionFinished(sessionID: string, options?: { terminalType?: string }): void {
    if (isReviewSessionUnavailable(sessionID, this.disposed, this.mailbox)) {
      return
    }

    const terminalType = executionTerminalType(options)
    const isSucceeded = terminalType === 'session.execution.succeeded'
    this.recordSuccessfulTurn(sessionID, isSucceeded)
    const isForced = this.consumeReviewRequest(sessionID)
    if (!shouldReviewAfterExecution(isForced, isSucceeded)) {
      return
    }

    this.dispatchReview(sessionID, terminalType, isForced)
  }

  consumeReviewRequest(sessionID: string): boolean {
    const request = this.requests.get(sessionID)
    this.requests.delete(sessionID)
    return Boolean(request?.force)
  }

  dispatchReview(sessionID: string, terminalType: string, isForced: boolean): void {
    if (this.inFlight.has(sessionID)) {
      queuePendingReview(this.pending, sessionID, isForced, terminalType)
      return
    }

    this.start(sessionID, { force: isForced, terminalType })
  }

  recordSuccessfulTurn(sessionID: string, isSucceeded: boolean): void {
    if (!isSucceeded) {
      return
    }

    this.successfulTurns.set(sessionID, (this.successfulTurns.get(sessionID) ?? 0) + 1)
    void this.telemetry.recordSuccessfulTurn().catch((error: unknown) => {
      console.error('[opencode-learning] successful-turn telemetry failed', error)
    })
  }

  start(sessionID: string, options: ReviewOptions = {}): void {
    const { force, terminalType } = normalizedReviewOptions(options)
    if (
      !canStartReview({
        [SESSION_ID_KEY]: sessionID,
        isDisposed: this.disposed,
        isEnabled: this.config.enabled,
        inFlight: this.inFlight,
        mailbox: this.mailbox
      })
    ) {
      return
    }

    const prepared = this.captureReview(sessionID, force)
    if (prepared === undefined) {
      return
    }

    this.inFlight.add(sessionID)
    this.markAutomaticReview(sessionID, force)
    const review = this.reviewWithRetry(sessionID, prepared.batch, {
      force,
      terminalType,
      triggerDecision: prepared.candidate
    })
      .catch((error: unknown) => {
        console.error('[opencode-learning] review failed', error)
      })
      .finally(() => {
        this.inFlight.delete(sessionID)
        this.drain(sessionID)
      })
    this.activeReviews.add(review)
    void review
      .then(() => {
        this.activeReviews.delete(review)
      })
      .catch(() => {
        this.activeReviews.delete(review)
      })
  }

  markAutomaticReview(sessionID: string, isForced: boolean): void {
    if (!isForced) {
      this.lastAutomaticReviewTurn.set(sessionID, this.successfulTurns.get(sessionID) ?? 0)
    }
  }

  drain(sessionID: string): void {
    if (this.disposed || this.inFlight.has(sessionID)) {
      return
    }

    const pending = this.pending.get(sessionID)
    if (!pending) {
      return
    }

    this.pending.delete(sessionID)
    this.start(sessionID, pending)
  }
}

function scheduleRequest(
  requests: Map<string, ReviewRequest>,
  sessionID: string,
  isForced: boolean
): Record<string, unknown> {
  const request = requests.get(sessionID) ?? { force: false }
  request.force ||= isForced
  requests.set(sessionID, request)
  return { scheduled: true, force: request.force }
}

function executionTerminalType(options: { terminalType?: string } | undefined): string {
  return options?.terminalType ?? 'session.execution.succeeded'
}

function normalizedReviewOptions(options: ReviewOptions): {
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
