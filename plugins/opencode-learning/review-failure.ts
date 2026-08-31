import { notifySession } from './events.ts'
import { redactError, SESSION_ID_KEY } from './shared.ts'
import type { OpenCodeContext } from './sdk.ts'
import type { Telemetry } from './telemetry.ts'
import type { ReviewFailureOptions, ReviewScore } from './review-types.ts'

type FailureTelemetryOptions = {
  telemetry: Telemetry
  sessionId: string
  terminalType: string
  isForced: boolean
  score: ReviewScore
  error: unknown
}

export async function recordReviewFailure(options: ReviewFailureOptions): Promise<void> {
  const {
    telemetry,
    ctx,
    sessionID: sessionId,
    terminalType,
    force: isForced,
    score,
    error,
    notify: shouldNotify
  } = options
  await recordFailureTelemetry({ telemetry, sessionId, terminalType, isForced, score, error })
  await recordAutomaticFailure(telemetry, isForced)
  await notifyFailure({ ctx, sessionId, isForced, shouldNotify, error })
}

async function recordFailureTelemetry({
  telemetry,
  sessionId,
  terminalType,
  isForced,
  score,
  error
}: FailureTelemetryOptions): Promise<void> {
  await telemetry
    .recordReview({
      [SESSION_ID_KEY]: sessionId,
      trigger: isForced ? 'forced' : 'automatic',
      terminalType,
      score,
      decision: 'error',
      error: redactError(error)
    })
    .catch(() => undefined)
}

async function recordAutomaticFailure(telemetry: Telemetry, isForced: boolean): Promise<void> {
  if (!isForced) {
    await telemetry.recordTriggerOutcome('error').catch(console.error)
  }
}

async function notifyFailure({
  ctx,
  sessionId,
  isForced,
  shouldNotify,
  error
}: {
  ctx: OpenCodeContext
  sessionId: string
  isForced: boolean
  shouldNotify: boolean
  error: unknown
}): Promise<void> {
  if (isForced && shouldNotify) {
    await notifySession(ctx, sessionId, `[opencode-learning] Review failed: ${redactError(error)}`)
  }
}
