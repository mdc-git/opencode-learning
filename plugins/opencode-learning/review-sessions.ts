import { createReviewSession, interruptSession, promptSession } from './events.ts'
import { buildReviewPrompt, buildValidationPrompt } from './review-candidates.ts'
import type { InternalMailbox } from './mailbox.ts'
import type { OpenCodeContext, SessionInfo } from './sdk.ts'
import type {
  Candidate,
  ExperienceSnapshot,
  LearningConfig,
  Proposal,
  Validation,
  ValidationSubmission
} from './types.ts'
import type { TriggerDecision } from './scoring.ts'

type ReviewSessionContext = {
  ctx: OpenCodeContext
  mailbox: InternalMailbox
  config: LearningConfig
}

export type ReflectorOptions = {
  directory: string
  model?: SessionInfo['model']
  exp: ExperienceSnapshot
  candidates: Candidate[]
  triggerDecision?: TriggerDecision
  onReflectorStart?: () => void
}

export type ValidatorOptions = {
  directory: string
  model?: SessionInfo['model']
  exp: ExperienceSnapshot
  candidates: Candidate[]
  proposal: Proposal
  deterministic: Validation
}

export async function runReflector({
  ctx,
  mailbox,
  config,
  directory,
  model,
  exp,
  candidates,
  triggerDecision,
  onReflectorStart
}: ReviewSessionContext & ReflectorOptions): Promise<Proposal> {
  const session = await createReviewSession(ctx, {
    directory,
    model,
    agent: config.reflectorAgent,
    title: 'Procedural skill reflection'
  })
  const { id } = session
  assertReviewSessionId(id, 'reflector')
  onReflectorStart?.()
  return runReviewSession({
    ctx,
    mailbox,
    id,
    role: 'proposal',
    timeout: config.reviewerTimeoutMs,
    prompt: buildReviewPrompt({ exp, candidates, triggerDecision }),
    missingSubmission: 'reflector finished without submitting a proposal'
  })
}

export async function runValidator({
  ctx,
  mailbox,
  config,
  directory,
  model,
  exp,
  candidates,
  proposal,
  deterministic
}: ReviewSessionContext & ValidatorOptions): Promise<ValidationSubmission> {
  const session = await createReviewSession(ctx, {
    directory,
    model,
    agent: config.validatorAgent,
    title: 'Procedural skill validation'
  })
  const { id } = session
  assertReviewSessionId(id, 'validator')
  return runReviewSession({
    ctx,
    mailbox,
    id,
    role: 'validation',
    timeout: config.reviewerTimeoutMs,
    prompt: buildValidationPrompt({
      exp,
      candidates,
      proposal,
      deterministicValidation: deterministic
    }),
    missingSubmission: 'validator finished without submitting a validation'
  })
}

function assertReviewSessionId(id: string, role: string): void {
  if (id.length === 0) {
    throw new Error(`OpenCode did not return a ${role} session id`)
  }
}

async function runReviewSession<T>({
  ctx,
  mailbox,
  id,
  role,
  timeout,
  prompt,
  missingSubmission
}: {
  ctx: OpenCodeContext
  mailbox: InternalMailbox
  id: string
  role: 'proposal' | 'validation'
  timeout: number
  prompt: string
  missingSubmission: string
}): Promise<T> {
  let isRegistered = false
  try {
    mailbox.register(id, role)
    isRegistered = true
    const callback = mailbox.wait<T>(id, timeout)
    void callback.catch(() => undefined)
    await promptSession(ctx, id, prompt)
    const result = await callback
    if (!mailbox.hasSubmitted(id)) {
      throw new Error(missingSubmission)
    }

    return result
  } finally {
    if (isRegistered) {
      mailbox.release(id)
    }

    await interruptSession(ctx, id)
  }
}
