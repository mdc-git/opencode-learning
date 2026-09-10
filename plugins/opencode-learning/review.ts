import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin/effect'
import { Effect } from 'effect'
import {
  candidatePacket,
  catalog,
  ownedCandidates,
  selectCandidates,
  type Candidate
} from './candidates.ts'
import { boundPacket, captureEvidence, packetBytes, type Evidence } from './evidence.ts'
import { isSkillId, type ProposalMetadata } from './proposal.ts'
import { isolatedGenerate } from './review-generate.ts'
import { proposalFor, validatorPacket } from './review-packet.ts'
import { REFLECTOR, VALIDATOR } from './review-prompts.ts'
import {
  decodeReflection,
  decodeValidation,
  type ActiveReflection,
  type Reflection,
  type Validation
} from './review-schema.ts'
import type { LearningActivity } from './rpc.ts'
import { materializeSkill } from './skill-files.ts'
import { scanSkillTree } from './skill-tree.ts'
import { PENDING_LIMIT, type Store } from './store.ts'

const encoder = new TextEncoder()

type SessionRef = Parameters<Plugin.Context['session']['get']>[0]
type ReflectionResult = {
  reflection: Reflection
  evidence: Evidence
  candidates: Candidate[]
  all: Candidate[]
  model: string
  options: ReviewOptions
}
export type ReviewActivity = (event: LearningActivity) => Effect.Effect<void, unknown>
export type ReviewOptions = {
  startAfter?: string
  lookbackTurns?: number
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

export type ReviewResult =
  | { kind: 'none'; reason: string; endCursor?: string }
  | { kind: 'rejected'; reason: string; endCursor?: string }
  | { kind: 'cap'; endCursor?: string }
  | { kind: 'staged'; id: string; proposal: ProposalMetadata; endCursor?: string }

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

function reflectionCapture(all: Candidate[], options: ReviewOptions) {
  let evidence: Evidence = { records: [], omitted: 0, authorizedPaths: [], freshStart: 0 }
  let candidates: Candidate[] = []
  return {
    prepare(messages: readonly unknown[], maxBytes: number): string {
      const captured = captureEvidence(messages, options.startAfter, options.lookbackTurns)
      const selected = selectCandidates(all, captured)
      const overhead = encoder.encode(`${REFLECTOR}\n\n`).byteLength + 64
      const bounded = boundPacket(captured, all, selected, Math.max(1, maxBytes - overhead))
      evidence = bounded.evidence
      candidates = bounded.candidates
      return reviewerPrompt(REFLECTOR, {
        evidence,
        ownedSkills: catalog(all),
        candidates: candidatePacket(candidates)
      })
    },
    result: () => ({ evidence, candidates })
  }
}

function patchCandidate(reflection: Reflection, candidates: Candidate[]): Candidate | undefined {
  if (reflection.kind !== 'patch') {
    return undefined
  }

  const candidate = candidates.find((item) => item.id === reflection.skillId)
  if (candidate === undefined) {
    throw new Error('patch target was not a full candidate')
  }

  return candidate
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
    const capture = reflectionCapture(all, options)
    const generated = yield* isolatedGenerate(ctx, sessionRef, capture.prepare)
    const { evidence, candidates } = capture.result()
    const reflection = decodeReflection(generated.text)
    yield* activity(options, sessionRef, {
      kind: 'reviewer-result',
      message:
        reflection.kind === 'none' ? reflection.reason : `${reflection.kind} ${reflection.skillId}`
    })
    return { reflection, evidence, candidates, all, model: generated.model, options }
  })
}

async function assertCandidateUnchanged(store: Store, candidate?: Candidate): Promise<void> {
  if (candidate === undefined) {
    return
  }

  const current = await scanSkillTree(path.join(store.projectSkills, candidate.id))
  if (current.revision !== candidate.revision) {
    throw new Error('patch target changed during review')
  }
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
        endCursor: input.result.evidence.endCursor
      }
    }

    const pending = yield* Effect.promise(async () => input.store.pendingCount())
    if (pending >= PENDING_LIMIT) {
      yield* activity(input.result.options, input.sessionRef, {
        kind: 'pending-limit',
        message: 'pending proposal limit reached'
      })
      return { kind: 'cap', endCursor: input.result.evidence.endCursor }
    }

    const proposal = proposalFor(input.reflection, input.result.evidence, input.candidate)
    const { root } = input.materialized
    yield* Effect.promise(async () => input.store.stage(proposal, root, input.id))
    yield* activity(input.result.options, input.sessionRef, {
      kind: 'proposal-staged',
      message: `new ${proposal.kind} proposal for ${proposal.skillId}`
    })
    return {
      kind: 'staged',
      id: input.id,
      proposal,
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
      endCursor: result.evidence.endCursor
    })
  }

  return Effect.gen(function* () {
    if (!isSkillId(reflection.skillId)) {
      throw new Error('invalid reflected skill id')
    }

    const candidate = patchCandidate(reflection, result.candidates)
    if (reflection.kind === 'create') {
      yield* Effect.promise(async () => store.assertCreateAvailable(reflection.skillId))
    }

    yield* Effect.promise(async () => assertCandidateUnchanged(store, candidate))
    const { id, materialized } = yield* materializeProposal(store, reflection, result, candidate)
    const finalize = finalizeProposal({
      ctx,
      store,
      sessionRef,
      result,
      reflection,
      candidate,
      id,
      materialized
    })
    const cleanup = Effect.promise(async () =>
      fs.rm(materialized.root, { recursive: true, force: true })
    )
    return yield* finalize.pipe(Effect.ensuring(cleanup))
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
      return { kind: 'cap', endCursor: options.startAfter }
    }

    const result = yield* reflect(ctx, store, sessionRef, options)
    return yield* activeReflection(ctx, store, sessionRef, result)
  })
}
