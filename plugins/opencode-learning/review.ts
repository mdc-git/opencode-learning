import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin/effect'
import { Effect, Schema } from 'effect'
import {
  boundPacket,
  candidatePacket,
  captureEvidence,
  catalog,
  ownedCandidates,
  packetBytes,
  selectCandidates,
  type Candidate,
  type Evidence
} from './evidence.ts'
import { materializeSkill, scanSkillTree } from './skill-files.ts'
import { PENDING_LIMIT, type ProposalMetadata, type Store } from './store.ts'

const {
  Array: arraySchema,
  Boolean: booleanSchema,
  Literals: literals,
  String: stringSchema,
  Struct: struct,
  Union: union
} = Schema
const generatedFileSchema = struct({
  path: stringSchema,
  content: stringSchema,
  executable: booleanSchema
})
const projectSourceSchema = struct({ from: literals(['project']), path: stringSchema })
const candidateSourceSchema = struct({ from: literals(['candidate']), path: stringSchema })
const sourceFileSchema = struct({
  path: stringSchema,
  source: union([projectSourceSchema, candidateSourceSchema])
})
const proposedSkillSchema = struct({
  skillMd: stringSchema,
  files: arraySchema(union([generatedFileSchema, sourceFileSchema]))
})
const reflectionSchema = union([
  struct({ kind: literals(['none']), reason: stringSchema }),
  struct({
    kind: literals(['create']),
    skillId: stringSchema,
    reason: stringSchema,
    skill: proposedSkillSchema
  }),
  struct({
    kind: literals(['patch']),
    skillId: stringSchema,
    reason: stringSchema,
    skill: proposedSkillSchema
  })
])
const validationSchema = struct({ accept: booleanSchema, reason: stringSchema })
const SKILL_ID = /^[0-9a-z]+(?:-[0-9a-z]+)*$/v
const REFLECTOR =
  'Return exactly one JSON reflection. Choose only a reusable procedure supported by evidence; return none when none is justified.'
const VALIDATOR =
  'Return exactly {"accept":boolean,"reason":string}. Validate evidence support, usefulness, non-duplication, conservative generalization, consistency, and safety.'
const encoder = new TextEncoder()

type SessionId = Parameters<Plugin.Context['session']['get']>[0]['sessionID']
type Reflection = typeof reflectionSchema.Type
type ActiveReflection = Extract<Reflection, { kind: 'create' | 'patch' }>
type GenerateResult = { text: string; model: string }
type CatalogModel = {
  id: unknown
  providerID: unknown
  limit: { input?: number; context: number; output: number }
}
type ReflectionResult = {
  reflection: Reflection
  evidence: Evidence
  candidates: Candidate[]
  all: Candidate[]
  model: string
}

export type ReviewResult =
  | { kind: 'none'; reason: string; endCursor?: string }
  | { kind: 'rejected'; reason: string; endCursor?: string }
  | { kind: 'cap'; endCursor?: string }
  | { kind: 'staged'; id: string; proposal: ProposalMetadata; endCursor?: string }

function reviewerPrompt(instruction: string, packet: unknown): string {
  return `${instruction}\n\n${JSON.stringify(packet)}`
}

function modelKey(model: { id: unknown; providerID: unknown; variant?: unknown }): string {
  return JSON.stringify({ providerID: model.providerID, id: model.id, variant: model.variant })
}

function modelInputLimit(
  models: readonly CatalogModel[],
  model: { id: unknown; providerID: unknown }
): number {
  const found = models.find((item) => item.id === model.id && item.providerID === model.providerID)
  if (found === undefined) {
    throw new Error('selected model is absent from the current catalog')
  }

  return found.limit.input ?? Math.max(1, found.limit.context - found.limit.output)
}

function isolatedGenerate(
  ctx: Plugin.Context,
  sessionId: SessionId,
  prepare: (messages: readonly unknown[], maxBytes: number) => string
): Effect.Effect<GenerateResult, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const marker = `opencode-learning:${crypto.randomUUID()}`
      const models = yield* ctx.catalog.model.list()
      let capturedModel = ''
      const registration = yield* ctx.session.hook('context', (request) => {
        if (!JSON.stringify(request.messages).includes(marker)) {
          return Effect.void
        }

        return ctx.session.context({ sessionID: sessionId }).pipe(
          Effect.map((messages) => {
            const maxBytes = modelInputLimit(models.data, request.model)
            const prompt = prepare(messages, maxBytes)
            capturedModel = modelKey(request.model)
            request.system = []
            request.tools = {}
            request.messages = [{ role: 'user', content: prompt }]
          }),
          Effect.orDie
        )
      })
      const generated = yield* ctx.session.generate({ sessionID: sessionId, prompt: marker })
      yield* registration.dispose
      if (capturedModel === '') {
        return yield* Effect.fail(new Error('review context hook did not capture generation'))
      }

      return { text: generated.text, model: capturedModel }
    })
  )
}

function reflectionCapture(all: Candidate[], startAfter?: string) {
  let evidence: Evidence = { records: [], omitted: 0, authorizedPaths: [] }
  let candidates: Candidate[] = []
  return {
    prepare(messages: readonly unknown[], maxBytes: number): string {
      const captured = captureEvidence(messages, startAfter)
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

function decodeReflection(text: string): Reflection {
  return Schema.decodeUnknownSync(reflectionSchema)(JSON.parse(text))
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
  sessionId: SessionId,
  startAfter?: string
): Effect.Effect<ReflectionResult, unknown> {
  return Effect.gen(function* () {
    const all = yield* Effect.promise(async () => ownedCandidates(store))
    const capture = reflectionCapture(all, startAfter)
    const generated = yield* isolatedGenerate(ctx, sessionId, capture.prepare)
    const { evidence, candidates } = capture.result()
    return {
      reflection: decodeReflection(generated.text),
      evidence,
      candidates,
      all,
      model: generated.model
    }
  })
}

async function assertCandidateUnchanged(store: Store, candidate?: Candidate): Promise<void> {
  if (candidate === undefined) {
    return
  }

  const current = await scanSkillTree(path.join(store.projectSkills, candidate.id))
  if (current.revision !== candidate.revision) {
    throw new Error('patch candidate changed during review')
  }
}

function proposalFor(result: ReflectionResult, candidate?: Candidate): ProposalMetadata {
  const reflection = result.reflection as ActiveReflection
  return {
    kind: reflection.kind,
    skillId: reflection.skillId,
    reason: reflection.reason,
    evidence: result.evidence,
    ...(candidate !== undefined && { expectedRevision: candidate.revision })
  }
}

function sourceSnapshots(reflection: ActiveReflection, files: ReadonlyArray<{ path: string }>) {
  const sourcePaths = new Set(
    reflection.skill.files.filter((file) => 'source' in file).map((file) => file.path)
  )
  return files.filter((file) => sourcePaths.has(file.path))
}

function validatorPacket(result: ReflectionResult, files: ReadonlyArray<{ path: string }>) {
  const reflection = result.reflection as ActiveReflection
  return {
    evidence: result.evidence,
    ownedSkills: catalog(result.all),
    candidates: candidatePacket(result.candidates),
    proposal: { kind: reflection.kind, skillId: reflection.skillId },
    skillMd: reflection.skill.skillMd,
    generatedFiles: reflection.skill.files.filter((file) => 'content' in file),
    sourceSnapshots: sourceSnapshots(reflection, files),
    manifest: files
  }
}

function validateReflection(reflection: ActiveReflection): void {
  if (!SKILL_ID.test(reflection.skillId)) {
    throw new Error('invalid reflected skill id')
  }
}

function validateMaterialized(
  ctx: Plugin.Context,
  sessionId: SessionId,
  result: ReflectionResult,
  files: ReadonlyArray<{ path: string }>
): Effect.Effect<typeof validationSchema.Type, unknown> {
  const packet = validatorPacket(result, files)
  return isolatedGenerate(ctx, sessionId, (_messages, maxBytes) => {
    const prompt = reviewerPrompt(VALIDATOR, packet)
    if (packetBytes(prompt) > maxBytes) {
      throw new Error('validator request exceeds model input limit')
    }

    return prompt
  }).pipe(
    Effect.flatMap((generated) =>
      generated.model === result.model
        ? Effect.sync(() => Schema.decodeUnknownSync(validationSchema)(JSON.parse(generated.text)))
        : Effect.fail(new Error('validator model differs from reflector model'))
    )
  )
}

function processReflection(
  ctx: Plugin.Context,
  store: Store,
  sessionId: SessionId,
  result: ReflectionResult
): Effect.Effect<ReviewResult, unknown> {
  if (result.reflection.kind === 'none') {
    return Effect.succeed({
      kind: 'none',
      reason: result.reflection.reason,
      endCursor: result.evidence.endCursor
    })
  }

  const { reflection } = result
  return Effect.gen(function* () {
    validateReflection(reflection)
    const candidate = patchCandidate(reflection, result.candidates)
    if (reflection.kind === 'create') {
      yield* Effect.promise(async () => store.assertCreateAvailable(reflection.skillId))
    }

    yield* Effect.promise(async () => assertCandidateUnchanged(store, candidate))
    const id = crypto.randomUUID()
    const candidateRoot =
      candidate === undefined ? undefined : path.join(store.projectSkills, candidate.id)
    const materialized = yield* Effect.promise(async () =>
      materializeSkill({
        project: store.project,
        temporary: store.temporary,
        id,
        skill: reflection.skill,
        authorizedPaths: result.evidence.authorizedPaths,
        ...(candidate !== undefined && {
          candidate: { root: candidateRoot ?? '', manifest: candidate.manifest }
        })
      })
    )
    const finish = Effect.gen(function* () {
      const validation = yield* validateMaterialized(
        ctx,
        sessionId,
        result,
        materialized.scan.files
      )
      if (!validation.accept) {
        return { kind: 'rejected', reason: validation.reason, endCursor: result.evidence.endCursor }
      }

      if ((yield* Effect.promise(async () => store.pendingCount())) >= PENDING_LIMIT) {
        return { kind: 'cap', endCursor: result.evidence.endCursor }
      }

      const proposal = proposalFor(result, candidate)
      yield* Effect.promise(async () => store.stage(proposal, materialized.root, id))
      return { kind: 'staged', id, proposal, endCursor: result.evidence.endCursor }
    })
    const cleanup = Effect.promise(async () =>
      fs.rm(materialized.root, { recursive: true, force: true })
    )
    return yield* finish.pipe(Effect.ensuring(cleanup))
  })
}

export function runReview(
  ctx: Plugin.Context,
  store: Store,
  sessionId: SessionId,
  startAfter?: string
): Effect.Effect<ReviewResult, unknown> {
  return Effect.gen(function* () {
    if ((yield* Effect.promise(async () => store.pendingCount())) >= PENDING_LIMIT) {
      return { kind: 'cap', endCursor: startAfter }
    }

    const result = yield* reflect(ctx, store, sessionId, startAfter)
    return yield* processReflection(ctx, store, sessionId, result)
  })
}
