import { buildReviewPrompt, buildValidationPrompt } from './review-candidates.ts'
import { SESSION_ID_KEY } from './shared.ts'
import type { InternalMailbox } from './mailbox.ts'
import type { OpenCodeContext, SessionCreateInput, SessionInfo } from './sdk.ts'
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

type ReflectorOptions = {
  directory: string
  model?: SessionInfo['model']
  exp: ExperienceSnapshot
  candidates: Candidate[]
  triggerDecision?: TriggerDecision
  onReflectorStart?: () => void
}

type ValidatorOptions = {
  directory: string
  model?: SessionInfo['model']
  exp: ExperienceSnapshot
  candidates: Candidate[]
  proposal: Proposal
  deterministic: Validation
}

async function createReviewSession(
  ctx: OpenCodeContext,
  {
    directory,
    agent,
    title,
    model
  }: { directory: string; agent: string; title: string; model?: SessionInfo['model'] }
): Promise<SessionInfo> {
  const input: SessionCreateInput =
    model === undefined
      ? { title, agent, location: { directory } }
      : { title, agent, location: { directory }, model }

  return ctx.session.create(input)
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
    await ctx.session.prompt({
      [SESSION_ID_KEY]: id,
      text: prompt,
      delivery: 'queue',
      resume: true
    })
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

export async function notifySession(
  ctx: OpenCodeContext,
  sessionID: string,
  text: string
): Promise<void> {
  try {
    await ctx.session.synthetic({
      [SESSION_ID_KEY]: sessionID,
      text,
      description: 'opencode-learning',
      metadata: { source: 'opencode-learning' },
      delivery: 'queue',
      resume: false
    })
  } catch {}
}

export async function interruptSession(ctx: OpenCodeContext, sessionID: string): Promise<void> {
  try {
    await ctx.session.interrupt({ [SESSION_ID_KEY]: sessionID })
  } catch {}
}
