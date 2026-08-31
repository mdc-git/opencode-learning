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
  if (id.length === 0) {
    throw new Error('OpenCode did not return a reflector session id')
  }

  let isRegistered = false
  try {
    mailbox.register(id, 'proposal')
    isRegistered = true
    onReflectorStart?.()
    const callback = mailbox.wait<Proposal>(id, config.reviewerTimeoutMs)
    void callback.catch(() => undefined)
    await promptSession(ctx, id, buildReviewPrompt({ exp, candidates, triggerDecision }))
    const proposal = await callback
    if (!mailbox.hasSubmitted(id)) {
      throw new Error('reflector finished without submitting a proposal')
    }

    return proposal
  } finally {
    if (isRegistered) {
      mailbox.release(id)
    }

    await interruptSession(ctx, id)
  }
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
  if (id.length === 0) {
    throw new Error('OpenCode did not return a validator session id')
  }

  let isRegistered = false
  try {
    mailbox.register(id, 'validation')
    isRegistered = true
    const callback = mailbox.wait<ValidationSubmission>(id, config.reviewerTimeoutMs)
    void callback.catch(() => undefined)
    await promptSession(
      ctx,
      id,
      buildValidationPrompt({ exp, candidates, proposal, deterministicValidation: deterministic })
    )
    const validation = await callback
    if (!mailbox.hasSubmitted(id)) {
      throw new Error('validator finished without submitting a validation')
    }

    return validation
  } finally {
    if (isRegistered) {
      mailbox.release(id)
    }

    await interruptSession(ctx, id)
  }
}
