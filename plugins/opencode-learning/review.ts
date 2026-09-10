import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { Plugin } from '@opencode/plugin/effect'
import { Effect, Schema } from 'effect'
import {
  addOwnership,
  hasOwnership,
  scanSkillTree,
  skillDescription,
  type FileManifest,
  type ProposalMetadata,
  PENDING_LIMIT,
  type Store
} from './store.ts'

const GeneratedFile = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
  executable: Schema.Boolean
})
const SourceFile = Schema.Struct({
  path: Schema.String,
  source: Schema.Union([
    Schema.Struct({ from: Schema.Literals(['project']), path: Schema.String }),
    Schema.Struct({ from: Schema.Literals(['candidate']), path: Schema.String })
  ])
})
const ProposedSkill = Schema.Struct({ skillMd: Schema.String, files: Schema.Array(Schema.Union([GeneratedFile, SourceFile])) })
const Reflection = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(['none']), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literals(['create']), skillId: Schema.String, reason: Schema.String, skill: ProposedSkill }),
  Schema.Struct({ kind: Schema.Literals(['patch']), skillId: Schema.String, reason: Schema.String, skill: ProposedSkill })
])
const Validation = Schema.Struct({ accept: Schema.Boolean, reason: Schema.String })

type Reflection = typeof Reflection.Type
type ProposedSkill = typeof ProposedSkill.Type
type Candidate = {
  id: string
  description: string
  markdown: string
  manifest: FileManifest[]
  revision: string
}
type Evidence = { records: unknown[]; omitted: number; authorizedPaths: string[]; endCursor?: string }
export type ReviewResult =
  | { kind: 'none'; reason: string; endCursor?: string }
  | { kind: 'rejected'; reason: string; endCursor?: string }
  | { kind: 'cap'; endCursor?: string }
  | { kind: 'staged'; id: string; proposal: ProposalMetadata; endCursor?: string }

const CONTROL = /^\/learn(?:\s|$|-)/v
const MAX_GENERATED_FILE = 1024 * 1024
const MAX_GENERATED_TOTAL = 10 * 1024 * 1024

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/v).filter((item) => item.length > 2))
}

function compactAssistant(message: Record<string, unknown>): unknown {
  const content = Array.isArray(message.content) ? message.content : []
  return {
    type: 'assistant',
    content: content.flatMap((part) => {
      if (typeof part !== 'object' || part === null) return []
      const item = part as Record<string, unknown>
      if (item.type === 'text') return [{ type: 'text', text: item.text }]
      if (item.type !== 'tool') return []
      const state = typeof item.state === 'object' && item.state !== null ? (item.state as Record<string, unknown>) : {}
      return [{ tool: item.name, outcome: state.status, relevantInput: state.input, metadata: state.metadata }]
    })
  }
}

function compactMessage(message: unknown): unknown | undefined {
  if (typeof message !== 'object' || message === null) return undefined
  const item = message as Record<string, unknown>
  if (item.type === 'user') {
    const text = typeof item.text === 'string' ? item.text : ''
    if (CONTROL.test(text)) return undefined
    return { type: 'user', text, files: item.files }
  }
  if (item.type === 'assistant') return compactAssistant(item)
  if (item.type === 'shell') return { type: 'shell', status: item.status, exit: item.exit }
  return undefined
}

function collectAuthorizedPaths(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectAuthorizedPaths(item, out)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const [key, item] of Object.entries(value)) {
    if (['path', 'target', 'file'].includes(key) && typeof item === 'string') out.add(item)
    else if (key === 'metadata' || key === 'content') collectAuthorizedPaths(item, out)
  }
}

function evidenceFrom(messages: readonly unknown[], startAfter?: string): Evidence {
  const start = startAfter ? messages.findIndex((message) => (message as { id?: string }).id === startAfter) + 1 : 0
  const selected = messages.slice(Math.max(0, start))
  const records = selected.flatMap((message) => {
    const compacted = compactMessage(message)
    return compacted === undefined ? [] : [compacted]
  })
  const authorized = new Set<string>()
  for (const record of records) collectAuthorizedPaths(record, authorized)
  const end = selected.at(-1) as { id?: string } | undefined
  return { records, omitted: 0, authorizedPaths: [...authorized], endCursor: end?.id }
}

async function ownedCandidates(store: Store): Promise<Candidate[]> {
  await fs.mkdir(store.projectSkills, { recursive: true })
  const entries = await fs.readdir(store.projectSkills, { withFileTypes: true })
  const candidates: Candidate[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const root = path.join(store.projectSkills, entry.name)
    try {
      const markdown = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8')
      if (!hasOwnership(markdown)) continue
      const scan = await store.validateTree(root, true)
      candidates.push({ id: entry.name, description: skillDescription(markdown), markdown, manifest: scan.files, revision: scan.revision })
    } catch {
      continue
    }
  }
  return candidates.toSorted((a, b) => a.id.localeCompare(b.id))
}

function selectCandidates(all: Candidate[], evidence: Evidence): Candidate[] {
  const evidenceText = JSON.stringify(evidence.records)
  const words = tokens(evidenceText)
  return all
    .map((candidate) => ({
      candidate,
      explicit: evidenceText.includes(candidate.id),
      overlap: [...tokens(`${candidate.id} ${candidate.description}`)].filter((word) => words.has(word)).length
    }))
    .filter((item) => item.explicit || item.overlap > 0)
    .toSorted((a, b) => Number(b.explicit) - Number(a.explicit) || b.overlap - a.overlap || a.candidate.id.localeCompare(b.candidate.id))
    .slice(0, 5)
    .map((item) => item.candidate)
}

function candidatePacket(candidates: Candidate[]): unknown[] {
  return candidates.map((candidate) => ({
    id: candidate.id,
    description: candidate.description,
    skillMd: candidate.markdown,
    revision: candidate.revision,
    files: candidate.manifest.filter((file) => file.path !== 'SKILL.md')
  }))
}

function decodeReflection(text: string): Reflection {
  return Schema.decodeUnknownSync(Reflection)(JSON.parse(text))
}

function decodeValidation(text: string): typeof Validation.Type {
  return Schema.decodeUnknownSync(Validation)(JSON.parse(text))
}

function reviewerPrompt(kind: 'reflector' | 'validator', packet: unknown): string {
  const instruction =
    kind === 'reflector'
      ? 'Return exactly one JSON reflection. Choose only a reusable procedure supported by evidence; return none when none is justified.'
      : 'Return exactly {"accept":boolean,"reason":string}. Validate evidence support, usefulness, non-duplication, conservative generalization, consistency, and safety.'
  return `${instruction}\n\n${JSON.stringify(packet)}`
}

function isolatedGenerate(ctx: Plugin.Context, sessionID: string, makePrompt: () => Effect.Effect<string, unknown>) {
  return Effect.scoped(
    Effect.gen(function* () {
      const marker = `opencode-learning:${crypto.randomUUID()}`
      let model = ''
      let prompt = ''
      const registration = yield* ctx.session.hook('generate', (request) =>
        JSON.stringify(request.messages).includes(marker)
          ? Effect.gen(function* () {
              prompt = yield* makePrompt()
              model = JSON.stringify(request.model)
              request.system = []
              request.tools = {}
              request.messages = [{ role: 'user', content: prompt }]
            })
          : Effect.void
      )
      const result = yield* ctx.session.generate({ sessionID, prompt: marker })
      yield* registration.dispose
      if (!model) return yield* Effect.fail(new Error('review generate hook did not capture request'))
      return { text: result.text, model, prompt }
    })
  )
}

function safeDestination(root: string, relative: string): string {
  if (relative === 'SKILL.md' || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`invalid supporting file path: ${relative}`)
  }
  const target = path.resolve(root, relative)
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('supporting file escapes skill root')
  return target
}

async function materialize(
  store: Store,
  proposal: Extract<Reflection, { kind: 'create' | 'patch' }>,
  candidate: Candidate | undefined,
  evidence: Evidence,
  id: string
): Promise<{ root: string; scan: Awaited<ReturnType<typeof scanSkillTree>> }> {
  const root = path.join(store.temporary, id)
  const skillRoot = path.join(root, 'skill')
  await fs.mkdir(skillRoot, { recursive: true })
  let generatedTotal = Buffer.byteLength(proposal.skill.skillMd)
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), addOwnership(proposal.skill.skillMd))
  for (const file of proposal.skill.files) {
    const target = safeDestination(skillRoot, file.path)
    await fs.mkdir(path.dirname(target), { recursive: true })
    if ('content' in file) {
      const size = Buffer.byteLength(file.content)
      if (size > MAX_GENERATED_FILE) throw new Error('generated supporting file exceeds 1 MiB')
      generatedTotal += size
      if (generatedTotal > MAX_GENERATED_TOTAL) throw new Error('generated content exceeds 10 MiB')
      await fs.writeFile(target, file.content, { mode: file.executable ? 0o755 : 0o644 })
      continue
    }
    const source = file.source
    const sourceRoot = source.from === 'candidate' ? (candidate ? path.join(store.projectSkills, candidate.id) : '') : store.project
    if (source.from === 'candidate' && !candidate?.manifest.some((item) => item.path === source.path)) throw new Error('invalid candidate source')
    const sourcePath = source.from === 'project' ? path.resolve(store.project, source.path) : path.join(sourceRoot, source.path)
    if (!sourcePath.startsWith(`${path.resolve(sourceRoot)}${path.sep}`)) throw new Error('source escapes its root')
    if (source.from === 'project' && !evidence.authorizedPaths.some((item) => path.resolve(store.project, item) === sourcePath)) throw new Error('project source was not authorized by structured evidence')
    const stat = await fs.lstat(sourcePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('source must be a regular non-symlink file')
    await fs.copyFile(sourcePath, target)
    await fs.chmod(target, stat.mode & 0o111 ? 0o755 : 0o644)
  }
  const scan = await store.validateTree(skillRoot, true)
  return { root, scan }
}

export function runReview(ctx: Plugin.Context, store: Store, sessionID: string, startAfter?: string): Effect.Effect<ReviewResult, unknown> {
  return Effect.gen(function* () {
    let captured: Evidence = { records: [], omitted: 0, authorizedPaths: [] }
    let chosen: Candidate[] = []
    const all = yield* Effect.promise(() => ownedCandidates(store))
    const reflectionCall = yield* isolatedGenerate(ctx, sessionID, () =>
      Effect.gen(function* () {
        const messages = yield* ctx.session.context({ sessionID })
        captured = evidenceFrom(messages, startAfter)
        chosen = selectCandidates(all, captured)
        return reviewerPrompt('reflector', {
          evidence: captured,
          ownedSkills: all.map(({ id, description }) => ({ id, description })),
          candidates: candidatePacket(chosen)
        })
      })
    )
    const reflection = decodeReflection(reflectionCall.text)
    if (reflection.kind === 'none') return { kind: 'none', reason: reflection.reason, endCursor: captured.endCursor }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/v.test(reflection.skillId)) throw new Error('invalid reflected skill id')
    const candidate = reflection.kind === 'patch' ? chosen.find((item) => item.id === reflection.skillId) : undefined
    if (reflection.kind === 'create') yield* Effect.promise(() => store.assertCreateAvailable(reflection.skillId))
    if (reflection.kind === 'patch' && !candidate) throw new Error('patch target was not a full candidate')
    if (candidate && (await Effect.promise(() => scanSkillTree(path.join(store.projectSkills, candidate.id)))).revision !== candidate.revision) throw new Error('patch candidate changed during review')
    const id = crypto.randomUUID()
    const materialized = yield* Effect.promise(() => materialize(store, reflection, candidate, captured, id))
    const proposal: ProposalMetadata = {
      kind: reflection.kind,
      skillId: reflection.skillId,
      reason: reflection.reason,
      evidence: captured,
      ...(candidate ? { expectedRevision: candidate.revision } : {})
    }
    const validationCall = yield* isolatedGenerate(ctx, sessionID, () =>
      Effect.gen(function* () {
        const skillMd = yield* Effect.promise(() => fs.readFile(path.join(materialized.root, 'skill', 'SKILL.md'), 'utf8'))
        return reviewerPrompt('validator', {
          evidence: captured,
          ownedSkills: all.map(({ id: skillId, description }) => ({ id: skillId, description })),
          candidates: candidatePacket(chosen),
          proposal: { kind: reflection.kind, skillId: reflection.skillId },
          skillMd,
          manifest: materialized.scan.files
        })
      })
    )
    if (validationCall.model !== reflectionCall.model) throw new Error('validator model differs from reflector model')
    const validation = decodeValidation(validationCall.text)
    if (!validation.accept) {
      yield* Effect.promise(() => fs.rm(materialized.root, { recursive: true, force: true }))
      return { kind: 'rejected', reason: validation.reason, endCursor: captured.endCursor }
    }
    if ((yield* Effect.promise(() => store.pendingCount())) >= PENDING_LIMIT) {
      yield* Effect.promise(() => fs.rm(materialized.root, { recursive: true, force: true }))
      return { kind: 'cap', endCursor: captured.endCursor }
    }
    yield* Effect.promise(() => store.stage(proposal, materialized.root, id)).pipe(
      Effect.tapError(() => Effect.promise(() => fs.rm(materialized.root, { recursive: true, force: true })))
    )
    return { kind: 'staged', id, proposal, endCursor: captured.endCursor }
  })
}
