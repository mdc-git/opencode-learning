import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin/effect'
import { Effect } from 'effect'
import type { ReviewResult } from './review.ts'
import { LearningRpc } from './rpc.ts'
import type { Store } from './store.ts'

type SessionRef = Parameters<Plugin.Context['session']['get']>[0]
type Learn = (sessionRef: SessionRef) => Effect.Effect<ReviewResult, unknown>

function assertRoot(ctx: Plugin.Context, sessionId: string) {
  const sessionRef: SessionRef = { sessionID: sessionId }
  return ctx.session.get(sessionRef).pipe(
    Effect.flatMap((session) =>
      session.parentID === undefined
        ? Effect.succeed(sessionRef)
        : Effect.fail(new Error('learning commands are root-session-only'))
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

function registerMethods(ctx: Plugin.Context, store: Store, learn: Learn) {
  return {
    review: ({ sessionId }: { sessionId: string }) =>
      assertRoot(ctx, sessionId).pipe(
        Effect.flatMap((sessionRef) => learn(sessionRef)),
        Effect.map(reviewResponse)
      ),
    pending: ({ sessionId }: { sessionId: string }) =>
      assertRoot(ctx, sessionId).pipe(Effect.flatMap(() => pendingSummary(store))),
    proposal: ({ sessionId, id }: { sessionId: string; id: string }) =>
      assertRoot(ctx, sessionId).pipe(Effect.flatMap(() => proposalDetail(store, id))),
    approve: ({ sessionId, id }: { sessionId: string; id: string }) =>
      assertRoot(ctx, sessionId).pipe(
        Effect.flatMap(() => Effect.promise(async () => store.approve(id))),
        Effect.flatMap((skillId) => ctx.skill.reload().pipe(Effect.as({ skillId })))
      ),
    reject: ({ sessionId, id }: { sessionId: string; id: string }) =>
      assertRoot(ctx, sessionId).pipe(
        Effect.flatMap(() => Effect.promise(async () => store.reject(id))),
        Effect.as({})
      ),
    promote: ({ sessionId, skillId }: { sessionId: string; skillId: string }) =>
      assertRoot(ctx, sessionId).pipe(
        Effect.flatMap(() => Effect.promise(async () => store.promote(skillId))),
        Effect.flatMap(() => ctx.skill.reload()),
        Effect.as({})
      )
  }
}

export function registerLearningRpc(ctx: Plugin.Context, store: Store, learn: Learn) {
  return ctx.rpc.register(LearningRpc, registerMethods(ctx, store, learn))
}
