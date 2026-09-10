import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin/effect'
import { Effect } from 'effect'
import type { ReviewResult } from './review.ts'
import { learningRpc } from './rpc.ts'
import type { Store } from './store.ts'

type SessionRef = Parameters<Plugin.Context['session']['get']>[0]
type SessionId = SessionRef['sessionID']
type Learn = (sessionRef: SessionRef) => Effect.Effect<ReviewResult, unknown>
const sessionIdKey = 'sessionID'

function sessionRef(sessionId: string): SessionRef {
  return { [sessionIdKey]: sessionId as SessionId }
}

function assertRoot(ctx: Plugin.Context, sessionId: string) {
  const ref = sessionRef(sessionId)
  return ctx.session
    .get(ref)
    .pipe(
      Effect.flatMap((session) =>
        session.parentID === undefined
          ? Effect.succeed(ref)
          : Effect.fail(new Error('learning actions are root-session-only'))
      )
    )
}

function reviewResponse(result: ReviewResult) {
  if (result.kind === 'staged') {
    return {
      status: result.kind,
      message: `staged ${result.proposal.kind} proposal for ${result.proposal.skillId}`,
      proposalId: result.id,
      skillId: result.proposal.skillId
    }
  }

  if (result.kind === 'cap') {
    return {
      status: result.kind,
      message: 'pending proposal limit reached',
      proposalId: '',
      skillId: ''
    }
  }

  return {
    status: result.kind,
    message: result.reason,
    proposalId: '',
    skillId: ''
  }
}

function pendingSummary(store: Store) {
  return Effect.promise(async () => {
    const proposals = await store.listPending()
    return proposals.map((proposal) => ({
      id: proposal.id,
      kind: proposal.kind,
      skillId: proposal.skillId,
      reason: proposal.reason,
      invalid: proposal.invalid === true
    }))
  })
}

function proposalDetail(store: Store, id: string) {
  return Effect.promise(async () => {
    const proposal = await store.readPending(id)
    const root = path.join(store.pending, id, 'skill')
    const scan = await store.validateTree(root, false)
    const current = await store.patchStatus(proposal)
    const markdown = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8')
    return {
      id: proposal.id,
      kind: proposal.kind,
      skillId: proposal.skillId,
      reason: proposal.reason,
      invalid: proposal.invalid === true,
      stale: current.isStale,
      files: current.files,
      manifest: scan.files,
      markdown,
      evidence: JSON.stringify(proposal.evidence, null, 2)
    }
  })
}

function mapFailure<Failure>(make: (message: string) => Failure) {
  return Effect.mapError((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    return make(message)
  })
}

export function registerLearningRpc(ctx: Plugin.Context, store: Store, learn: Learn) {
  return ctx.rpc.register(learningRpc, {
    review: ({ sessionId }, context) =>
      assertRoot(ctx, sessionId).pipe(
        Effect.flatMap((ref) => learn(ref)),
        Effect.map(reviewResponse),
        mapFailure((message) => context.error('failure', message, { message }))
      ),
    pending: ({ sessionId }, context) =>
      assertRoot(ctx, sessionId).pipe(
        Effect.flatMap(() => pendingSummary(store)),
        mapFailure((message) => context.error('failure', message, { message }))
      ),
    proposal: ({ sessionId, id }, context) =>
      assertRoot(ctx, sessionId).pipe(
        Effect.flatMap(() => proposalDetail(store, id)),
        mapFailure((message) => context.error('failure', message, { message }))
      ),
    approve: ({ sessionId, id }, context) =>
      assertRoot(ctx, sessionId).pipe(
        Effect.flatMap(() => Effect.promise(async () => store.approve(id))),
        Effect.flatMap((skillId) => ctx.skill.reload().pipe(Effect.as({ skillId }))),
        mapFailure((message) => context.error('failure', message, { message }))
      ),
    reject: ({ sessionId, id }, context) =>
      assertRoot(ctx, sessionId).pipe(
        Effect.flatMap(() => Effect.promise(async () => store.reject(id))),
        Effect.as({}),
        mapFailure((message) => context.error('failure', message, { message }))
      ),
    promote: ({ sessionId, skillId }, context) =>
      assertRoot(ctx, sessionId).pipe(
        Effect.flatMap(() => Effect.promise(async () => store.promote(skillId))),
        Effect.flatMap(() => ctx.skill.reload()),
        Effect.as({}),
        mapFailure((message) => context.error('failure', message, { message }))
      )
  })
}
