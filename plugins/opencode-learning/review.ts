import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin/effect'
import { Effect } from 'effect'
import { ownedCandidates, patchCandidate, type Candidate } from './candidates.ts'
import { packetBytes, type Evidence } from './evidence.ts'
import { isSkillId, type PendingProposal, type ProposalMetadata } from './proposal.ts'
import { isolatedGenerate } from './review-generate.ts'
import { reflectionCapture, proposalFor, validatorPacket } from './review-packet.ts'
import { VALIDATOR } from './review-prompts.ts'
import {
  decodeReflection,
  decodeValidation,
  type ActiveReflection,
  type Reflection,
  type Validation
} from './review-schema.ts'
import type { LearningActivity } from './rpc.ts'
import { materializeSkill } from './skill-files.ts'
import { PENDING_LIMIT, type Store } from './store.ts'

type SessionRef = Parameters<Plugin.Context['session']['get']>[0]
type ReflectionResult = {
  reflection: Reflection
  evidence: Evidence
  candidates: Candidate[]
  all: Candidate[]
  pending: PendingProposal[]
  model: string
  options: ReviewOptions
}
export type ReviewActivity = (event: LearningActivity) => Effect.Effect<void, unknown>
export type ReviewOptions = {
  startAfter?: string
  lookbackTurns?: number
  messages?: readonly unknown[]
  activity: ReviewActivity
}
type FinalizeInput = {
  ctx: Plugin.Context
  store: Store
  sessionRef: SessionRef
  result: ReflectionResult
  reflection: ActiveReflection
  candidate?: Candidate
  id: string
  materialized: Awaited<ReturnType<typeof materializeSkill>>
}

export type ReviewResult = (
  | { kind: 'none'; reason: string }
  | { kind: 'rejected'; reason: string }
  | { kind: 'cap' }
  | { kind: 'staged'; id: string; proposal: ProposalMetadata }
) & { endCursor?: string; deferred: number }

function reviewerPrompt(instruction: string, packet: unknown): string {
  return `${instruction}\n\n${JSON.stringify(packet)}`
}

function activity(
  options: ReviewOptions,
  ref: SessionRef,
  event: Omit<LearningActivity, 'sessionId'>
) {
  return options.activity({ ...event, sessionId: ref.sessionID })
}

function reflect(
  ctx: Plugin.Context,
  store: Store,
  sessionRef: SessionRef,
  options: ReviewOptions
): Effect.Effect<ReflectionResult, unknown> {
  return Effect.gen(function* () {
    yield* activity(options, sessionRef, {
      kind: 'reviewer-started',
      message: 'learning reviewer started'
    })
    const all = yield* Effect.promise(async () => ownedCandidates(store))
    const pending = yield* Effect.promise(async () => store.listPending())
    const capture = reflectionCapture(all, pending, options)
    const generated = yield* isolatedGenerate(ctx, sessionRef, capture.prepare, options.messages)
    const { evidence, candidates } = capture.result()
    if (evidence.skipped > 0) {
      yield* activity(options, sessionRef, {
        kind: 'review-skipped',
        message: `excluded ${evidence.skipped} oversized learning turn(s) from this review`
      })
    }

    const reflection: Reflection =
      evidence.records.length === evidence.freshStart
        ? { kind: 'none', reason: 'no reviewable fresh evidence' }
        : decodeReflection(generated.text)
    yield* activity(options, sessionRef, {
      kind: 'reviewer-result',
      message:
        reflection.kind === 'none' ? reflection.reason : `${reflection.kind} ${reflection.skillId}`
    })
    return { reflection, evidence, candidates, all, pending, model: generated.model, options }
  })
}

function validateMaterialized(input: FinalizeInput): Effect.Effect<Validation, unknown> {
  const packet = validatorPacket(input.reflection, input.result, input.materialized.scan.files)
  return Effect.gen(function* () {
    yield* activity(input.result.options, input.sessionRef, {
      kind: 'validator-started',
      message: `validating ${input.reflection.skillId}`
    })
    const generated = yield* isolatedGenerate(input.ctx, input.sessionRef, (_, maxBytes) => {
      const prompt = reviewerPrompt(VALIDATOR, packet)
      if (packetBytes(prompt) > maxBytes) {
        throw new Error('validator request exceeds model input limit')
      }

      return prompt
    })
    if (generated.model !== input.result.model) {
      return yield* Effect.fail(new Error('validator model differs from reflector model'))
    }

    const validation = decodeValidation(generated.text)
    yield* activity(input.result.options, input.sessionRef, {
      kind: 'validator-result',
      message: `${validation.accept ? 'accepted' : 'rejected'}: ${validation.reason}`
    })
    return validation
  })
}

function finalizeProposal(input: FinalizeInput): Effect.Effect<ReviewResult, unknown> {
  return Effect.gen(function* () {
    const validation = yield* validateMaterialized(input)
    if (!validation.accept) {
      return {
        kind: 'rejected',
        reason: validation.reason,
        deferred: input.result.evidence.deferred,
        endCursor: input.result.evidence.endCursor
      }
    }

    const pending = yield* Effect.promise(async () => input.store.pendingCount())
    if (pending >= PENDING_LIMIT) {
      yield* activity(input.result.options, input.sessionRef, {
        kind: 'pending-limit',
        message: 'pending proposal limit reached'
      })
      return {
        kind: 'cap',
        endCursor: input.result.evidence.endCursor,
        deferred: input.result.evidence.deferred
      }
    }

    const proposal = proposalFor(input.reflection, input.result.evidence, input.candidate)
    const { root } = input.materialized
    yield* Effect.promise(async () => input.store.stage(proposal, root, input.id)).pipe(
      Effect.uninterruptible
    )
    yield* activity(input.result.options, input.sessionRef, {
      kind: 'proposal-staged',
      message: `new ${proposal.kind} proposal for ${proposal.skillId}`
    })
    return {
      kind: 'staged',
      id: input.id,
      proposal,
      deferred: input.result.evidence.deferred,
      endCursor: input.result.evidence.endCursor
    }
  })
}

function materializeProposal(
  store: Store,
  reflection: ActiveReflection,
  result: ReflectionResult,
  candidate?: Candidate
) {
  const id = crypto.randomUUID()
  return Effect.promise(async () =>
    materializeSkill({
      project: store.project,
      temporary: store.temporary,
      id,
      skill: reflection.skill,
      authorizedPaths: result.evidence.authorizedPaths,
      ...(candidate !== undefined && {
        candidate: {
          root: path.join(store.projectSkills, candidate.id),
          manifest: candidate.manifest
        }
      })
    })
  ).pipe(Effect.map((materialized) => ({ id, materialized })))
}

function activeReflection(
  ctx: Plugin.Context,
  store: Store,
  sessionRef: SessionRef,
  result: ReflectionResult
): Effect.Effect<ReviewResult, unknown> {
  const { reflection } = result
  if (reflection.kind === 'none') {
    return Effect.succeed({
      kind: 'none',
      reason: reflection.reason,
      deferred: result.evidence.deferred,
      endCursor: result.evidence.endCursor
    })
  }

  return Effect.gen(function* () {
    if (!isSkillId(reflection.skillId)) {
      throw new Error('invalid reflected skill id')
    }

    const candidate = yield* Effect.promise(async () =>
      patchCandidate(
        store,
        result.candidates,
        reflection.kind === 'patch' ? reflection.skillId : undefined
      )
    )
    if (reflection.kind === 'create') {
      yield* Effect.promise(async () => store.assertCreateAvailable(reflection.skillId))
    }

    return yield* Effect.acquireUseRelease(
      materializeProposal(store, reflection, result, candidate),
      ({ id, materialized }) =>
        finalizeProposal({
          ctx,
          store,
          sessionRef,
          result,
          reflection,
          candidate,
          id,
          materialized
        }),
      ({ materialized }) =>
        Effect.promise(async () => fs.rm(materialized.root, { recursive: true, force: true }))
    )
  })
}

export function runReview(
  ctx: Plugin.Context,
  store: Store,
  sessionRef: SessionRef,
  options: ReviewOptions
): Effect.Effect<ReviewResult, unknown> {
  return Effect.gen(function* () {
    const pending = yield* Effect.promise(async () => store.pendingCount())
    if (pending >= PENDING_LIMIT) {
      yield* activity(options, sessionRef, {
        kind: 'pending-limit',
        message: 'pending proposal limit reached'
      })
      return { kind: 'cap', endCursor: options.startAfter, deferred: 0 }
    }

    const result = yield* reflect(ctx, store, sessionRef, options)
    if (result.evidence.deferred > 0) {
      yield* activity(options, sessionRef, {
        kind: 'reviewer-result',
        message: `${result.evidence.deferred} turn(s) remain for a subsequent learning batch`
      })
    }

    return yield* activeReflection(ctx, store, sessionRef, result)
  })
}
