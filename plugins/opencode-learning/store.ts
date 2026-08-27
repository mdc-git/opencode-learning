import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { atomicWrite, hasErrorCode, isRecord, isSafeId, nowIso, sha256 } from './shared.ts'
import type {
  OwnedSkill,
  PendingDetails,
  PendingProposal,
  Proposal,
  SectionOperation,
  SupportingFile,
  UnknownRecord,
  Validation
} from './types.ts'

const SECRET_PATTERNS = [
  /-----begin (?:rsa |ec |openssh )?private key-----/iv,
  /\b(?:sk|ghp|github_pat|xox[abprs])-[\w\u{2D}]{16,}\b/v,
  /\bAKIA[0-9A-Z]{16}\b/v,
  /\b(?:password|passwd|api(?:-|_)?key|secret|token)\s*[:=]\s*\S{8,}/iv
]
const TRANSIENT_PATTERNS = [
  /\/tmp\//v,
  /\/var\/tmp\//v,
  /\/home\/[\w\u{2D}.]+\//v,
  /\b20\d\d(?:-|\/)\d\d(?:-|\/)\d\d[ T]\d\d:/v,
  /\bpid\s*(?:[:=]\s*)?\d{2,}\b/iv
]

export function validateProposal(
  proposal: unknown,
  { confidenceThreshold = 0.72 }: { confidenceThreshold?: number } = {}
): Validation {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isRecord(proposal)) {
    return { ok: false, errors: ['proposal must be an object'], warnings }
  }

  const candidate = proposal as Proposal
  validateProposalBasics(candidate, errors)
  if (candidate.decision === 'none') {
    return { ok: errors.length === 0, errors, warnings }
  }

  validateNonEmptyProposal(candidate, confidenceThreshold, errors)
  validateProposalSafety(candidate, warnings, errors)
  if (candidate.decision === 'create') {
    validateCreateProposal(candidate, errors)
  } else if (candidate.decision === 'patch') {
    validatePatchProposal(candidate, errors)
  }

  return { ok: errors.length === 0, errors, warnings }
}

function validateProposalBasics(candidate: Proposal, errors: string[]): void {
  if (!['none', 'create', 'patch'].includes(candidate.decision ?? '')) {
    errors.push('decision must be none, create, or patch')
  }

  if (typeof candidate.reason !== 'string' || candidate.reason.trim().length < 12) {
    errors.push('reason is required')
  }

  if (!Array.isArray(candidate.evidence)) {
    errors.push('evidence must be an array')
  }

  if (
    typeof candidate.confidence !== 'number' ||
    candidate.confidence < 0 ||
    candidate.confidence > 1
  ) {
    errors.push('confidence must be 0..1')
  }
}

function validateNonEmptyProposal(
  candidate: Proposal,
  confidenceThreshold: number,
  errors: string[]
): void {
  if (!isSafeId(candidate.skillId ?? '')) {
    errors.push('skillId must be lowercase kebab-case, 1-64 chars')
  }

  if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) {
    errors.push('at least one evidence item is required')
  }

  if (typeof candidate.confidence === 'number' && candidate.confidence < confidenceThreshold) {
    errors.push(`confidence below threshold ${confidenceThreshold}`)
  }

  if (candidate.scope !== undefined && !['project', 'global'].includes(candidate.scope)) {
    errors.push('scope must be project or global')
  }

  if (candidate.scope === 'global') {
    errors.push('global skill writes are disabled')
  }
}

function validateProposalSafety(candidate: Proposal, warnings: string[], errors: string[]): void {
  const serialized = JSON.stringify(candidate)
  if (SECRET_PATTERNS.some((re) => re.test(serialized))) {
    errors.push('proposal appears to contain a credential or secret')
  }

  if (TRANSIENT_PATTERNS.some((re) => re.test(serialized))) {
    warnings.push('proposal contains machine- or run-specific data; inspect before applying')
  }
}

function validateCreateProposal(candidate: Proposal, errors: string[]): void {
  const { skill } = candidate
  if (skill === undefined) {
    errors.push('create requires skill')
    return
  }

  if (typeof skill.name !== 'string' || skill.name.trim().length === 0) {
    errors.push('skill.name is required')
  }

  if (typeof skill.description !== 'string' || skill.description.trim().length < 12) {
    errors.push('skill.description is required')
  }

  if (typeof skill.body !== 'string' || skill.body.trim().length < 40) {
    errors.push('skill.body is too short')
  }

  validateSupportingFiles(skill.files, errors, 'skill.files')
}

function validatePatchProposal(candidate: Proposal, errors: string[]): void {
  if (
    typeof candidate.expectedSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/iv.test(candidate.expectedSha256)
  ) {
    errors.push('patch requires expectedSha256')
  }

  if (!Array.isArray(candidate.operations) || candidate.operations.length === 0) {
    errors.push('patch requires operations')
  }

  for (const op of candidate.operations ?? []) {
    validateSectionOperation(op, errors)
  }

  validateSupportingFiles(candidate.addFiles, errors, 'addFiles')
}

function validateSectionOperation(op: SectionOperation, errors: string[]): void {
  if (!['replace_section', 'append_section'].includes(op.kind)) {
    errors.push(`unsupported operation ${op.kind}`)
  }

  if (typeof op.heading !== 'string' || op.heading.trim().length === 0) {
    errors.push('operation heading is required')
  }

  if (typeof op.body !== 'string' || op.body.trim().length === 0) {
    errors.push('operation body is required')
  }
}

function validateSupportingFiles(files: unknown, errors: string[], label: string): void {
  if (files === null || files === undefined) {
    return
  }

  if (!Array.isArray(files)) {
    errors.push(`${label} must be an array`)
    return
  }

  for (const file of files) {
    if (!isRecord(file)) {
      errors.push(`${label} entries must be objects`)
      continue
    }

    if (!isSafeSupportPath(file.path)) {
      errors.push(`${label} path must be a safe relative path outside SKILL.md`)
    }

    if (typeof file.content !== 'string' || file.content.trim().length === 0) {
      errors.push(`${label} content is required`)
    }
  }
}

function isSafeSupportPath(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 180) {
    return false
  }

  if (value === 'SKILL.md' || value.startsWith('/') || value.includes('\\')) {
    return false
  }

  const parts = value.split('/')
  return parts.every(
    (part) => part.length > 0 && part !== '.' && part !== '..' && !part.startsWith('.')
  )
}

export const proposalInputSchema = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['none', 'create', 'patch'] },
    skillId: {
      type: 'string',
      description:
        'Lowercase kebab-case skill ID, 1-64 characters. Required for create and patch decisions.'
    },
    scope: { type: 'string', enum: ['project', 'global'] },
    reason: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence: { type: 'array', items: { type: 'string' } },
    expectedSha256: { type: 'string' },
    skill: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['replace_section', 'append_section'] },
          heading: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['kind', 'heading', 'body'],
        additionalProperties: false
      }
    },
    addFiles: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  required: ['decision', 'reason', 'confidence', 'evidence'],
  additionalProperties: false
}

export const validationInputSchema = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['accept', 'reject'] },
    reason: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } }
  },
  required: ['decision', 'reason', 'warnings'],
  additionalProperties: false
}
const OWNER_MARKER = 'learning/owner: "opencode-learning"'

export class SkillStore {
  readonly projectRoot: string
  readonly projectRootSkills: string
  readonly globalRootSkills: string
  readonly stateRoot: string
  readonly pendingRoot: string
  readonly archiveRoot: string

  constructor({
    projectRoot,
    projectSkillDir,
    globalSkillDir,
    stateDir
  }: {
    projectRoot: string
    projectSkillDir: string
    globalSkillDir: string
    stateDir: string
  }) {
    this.projectRoot = projectRoot
    this.projectRootSkills = path.resolve(projectRoot, projectSkillDir)
    this.globalRootSkills = path.resolve(globalSkillDir)
    this.stateRoot = path.resolve(projectRoot, stateDir)
    this.pendingRoot = path.join(this.stateRoot, 'pending')
    this.archiveRoot = path.join(this.stateRoot, 'archive')
  }

  private async stageCreate(dir: string, proposal: Proposal): Promise<void> {
    const files = proposal.skill?.files ?? []
    await Promise.all([
      atomicWrite(path.join(dir, 'SKILL.preview.md'), this.renderCreated(proposal)),
      ...files.map(async (file) => atomicWrite(path.join(dir, 'FILES', file.path), file.content))
    ])
  }

  private async stagePatch(dir: string, proposal: Proposal): Promise<void> {
    const current = await this.getOwned(proposal.skillId ?? 'none', proposal.scope ?? 'project')
    if (current === undefined) {
      return
    }

    const text = applyOperations(current.text, proposal.operations ?? [])
    const next = bumpVersion(text)
    const writes = [
      atomicWrite(path.join(dir, 'BEFORE.md'), current.text),
      atomicWrite(path.join(dir, 'AFTER.md'), next),
      ...(proposal.addFiles ?? []).map(async (file) =>
        atomicWrite(path.join(dir, 'FILES', file.path), file.content)
      )
    ]
    await Promise.all(writes)
  }

  root(scope = 'project'): string {
    return scope === 'global' ? this.globalRootSkills : this.projectRootSkills
  }

  skillDir(skillId: string, scope = 'project'): string {
    const invalidSkillId = skillId
    if (!isSafeId(skillId)) {
      throw new Error(`invalid skill id: ${invalidSkillId}`)
    }

    return path.join(this.root(scope), skillId)
  }

  skillPath(skillId: string, scope = 'project'): string {
    return path.join(this.skillDir(skillId, scope), 'SKILL.md')
  }

  async getOwned(skillId: string, scope = 'project'): Promise<OwnedSkill | undefined> {
    const file = this.skillPath(skillId, scope)
    try {
      const text = await fs.readFile(file, 'utf8')
      if (!text.includes(OWNER_MARKER)) {
        return undefined
      }

      return {
        skillId,
        scope,
        file,
        dir: path.dirname(file),
        text,
        sha256: sha256(text),
        supportingFiles: await this.listSupportingFiles(skillId, scope)
      }
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) {
        return undefined
      }

      throw error
    }
  }

  async listSupportingFiles(
    skillId: string,
    scope = 'project'
  ): Promise<Array<{ path: string; bytes: number }>> {
    const root = this.skillDir(skillId, scope)
    const out: Array<{ path: string; bytes: number }> = []
    await walk(root, root, out)
    return out.filter((item) => item.path !== 'SKILL.md').slice(0, 100)
  }

  async listOwned(scope = 'project'): Promise<OwnedSkill[]> {
    const root = this.root(scope)
    let dirs
    try {
      dirs = await fs.readdir(root, { withFileTypes: true })
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) {
        return []
      }

      throw error
    }

    const items = await Promise.all(
      dirs
        .filter((entry) => entry.isDirectory() && isSafeId(entry.name))
        .map(async (entry) => this.getOwned(entry.name, scope))
    )
    return items.filter((item): item is OwnedSkill => item !== undefined)
  }

  renderCreated(proposal: Proposal): string {
    const skill = proposal.skill!
    return `---
name: ${yamlScalar(proposal.skillId)}
description: ${yamlScalar(skill.description)}
metadata:
  opencode/slash: "false"
  opencode/autoinvoke: "true"
  ${OWNER_MARKER}
  learning/created: ${yamlScalar(nowIso())}
  learning/version: "1"
---

${skill.body.trim()}
`
  }

  async create(
    proposal: Proposal,
    { scope = 'project' }: { scope?: string } = {}
  ): Promise<{ file: string; text: string; sha256: string; supportingFiles: string[] }> {
    const skillId = proposal.skillId ?? ''
    const dir = this.skillDir(skillId, scope)
    const file = path.join(dir, 'SKILL.md')
    await ensurePathMissing(file, `skill already exists: ${proposal.skillId}`)

    const text = this.renderCreated(proposal)
    await atomicWrite(file, text)
    try {
      await this.addSupportingFiles(dir, proposal.skill?.files ?? [])
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true })
      throw error
    }

    return {
      file,
      text,
      sha256: sha256(text),
      supportingFiles: proposal.skill?.files?.map((x) => x.path) ?? []
    }
  }

  async patch(
    proposal: Proposal,
    { scope = 'project' }: { scope?: string } = {}
  ): Promise<{ file: string; text: string; sha256: string; addedFiles: string[] }> {
    const skillId = proposal.skillId ?? ''
    const current = await requireOwnedSkill(this, skillId, scope)
    assertExpectedSkillHash(current, proposal.expectedSha256, skillId)

    await ensureSupportingFilesAbsent(current.dir, proposal.addFiles ?? [])

    const text = applyOperations(current.text, proposal.operations ?? [])

    const nextText = bumpVersion(text)
    await atomicWrite(current.file, nextText)
    await this.addSupportingFiles(current.dir, proposal.addFiles ?? [])
    return {
      file: current.file,
      text: nextText,
      sha256: sha256(nextText),
      addedFiles: proposal.addFiles?.map((x) => x.path) ?? []
    }
  }

  async addSupportingFiles(skillDir: string, files: SupportingFile[]): Promise<void> {
    await Promise.all(
      files.map(async (item) => atomicWrite(supportPath(skillDir, item.path), item.content))
    )
  }

  async stage(proposal: Proposal, validation: UnknownRecord): Promise<{ id: string; dir: string }> {
    const id = `${Date.now()}-${randomUUID()}-${proposal.skillId ?? 'none'}`
    const dir = path.join(this.pendingRoot, id)
    await fs.mkdir(dir, { recursive: true })
    await atomicWrite(
      path.join(dir, 'proposal.json'),
      `${JSON.stringify({ proposal, validation }, null, 2)}\n`
    )
    if (proposal.decision === 'create') {
      await this.stageCreate(dir, proposal)
    } else if (proposal.decision === 'patch') {
      await this.stagePatch(dir, proposal)
    }

    return { id, dir }
  }

  async listPending(): Promise<PendingProposal[]> {
    let entries
    try {
      entries = await fs.readdir(this.pendingRoot, { withFileTypes: true })
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) {
        return []
      }

      throw error
    }

    const out = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            const raw = JSON.parse(
              await fs.readFile(path.join(this.pendingRoot, entry.name, 'proposal.json'), 'utf8')
            ) as { proposal: Proposal; validation: UnknownRecord }
            return { id: entry.name, ...raw }
          } catch {
            return undefined
          }
        })
    )

    return out
      .filter((item): item is PendingProposal => item !== undefined)
      .toSorted((a, b) => b.id.localeCompare(a.id))
  }

  async getPending(id: string): Promise<PendingDetails> {
    const dir = safePending(this.pendingRoot, id)
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'proposal.json'), 'utf8')) as {
      proposal: Proposal
      validation: UnknownRecord
    }
    const pendingDetails: PendingDetails = { id, ...raw, previews: {} }
    const previews = await Promise.all(
      ['SKILL.preview.md', 'BEFORE.md', 'AFTER.md'].map(async (name) => ({
        name,
        text: await readOptionalText(path.join(dir, name))
      }))
    )
    for (const preview of previews) {
      if (preview.text !== undefined) {
        pendingDetails.previews[preview.name] = preview.text
      }
    }

    return pendingDetails
  }

  async applyPending(id: string): Promise<{ result: unknown; proposal: Proposal }> {
    const dir = safePending(this.pendingRoot, id)
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'proposal.json'), 'utf8')) as {
      proposal: Proposal
    }
    const { proposal } = raw
    let appliedResult
    if (proposal.decision === 'create') {
      appliedResult = await this.create(proposal, { scope: proposal.scope ?? 'project' })
    } else if (proposal.decision === 'patch') {
      appliedResult = await this.patch(proposal, { scope: proposal.scope ?? 'project' })
    } else {
      appliedResult = { skipped: true }
    }

    await fs.rm(dir, { recursive: true, force: true })
    return { result: appliedResult, proposal }
  }

  async rejectPending(id: string): Promise<void> {
    const dir = safePending(this.pendingRoot, id)
    await fs.rm(dir, { recursive: true, force: true })
  }

  async promote(skillId: string): Promise<{ skillId: string; source: string; target: string }> {
    const source = await this.getOwned(skillId, 'project')
    if (!source) {
      throw new Error(`cannot promote non-owned or missing project skill: ${skillId}`)
    }

    if (await this.getOwned(skillId, 'global')) {
      throw new Error(`global skill already exists: ${skillId}`)
    }

    const target = this.skillDir(skillId, 'global')
    try {
      await fs.access(target)
      throw new Error(`global skill path already exists: ${skillId}`)
    } catch (error: unknown) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error
      }
    }

    await fs.mkdir(this.globalRootSkills, { recursive: true })
    let isReserved = false
    try {
      await fs.mkdir(target)
      isReserved = true
      const entries = await fs.readdir(source.dir)
      await Promise.all(
        entries.map(async (entry) =>
          fs.cp(path.join(source.dir, entry), path.join(target, entry), {
            recursive: true,
            force: false,
            errorOnExist: true
          })
        )
      )
    } catch (error) {
      if (isReserved) {
        await fs.rm(target, { recursive: true, force: true })
      }

      throw error
    }

    return { skillId, source: source.dir, target }
  }

  async archive(skillId: string, { scope = 'project' }: { scope?: string } = {}): Promise<boolean> {
    const current = await this.getOwned(skillId, scope)
    if (!current) {
      return false
    }

    const target = path.join(this.archiveRoot, scope, `${Date.now()}-${skillId}`)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.rename(current.dir, target)
    return true
  }
}

function applyOperations(markdown: string, operations: SectionOperation[]): string {
  let text = markdown
  for (const operation of operations) {
    text = applySectionOperation(text, operation)
  }

  return text
}

function applySectionOperation(markdown: string, op: SectionOperation): string {
  const heading = op.heading.trim().replace(/^#+\s*/v, '')
  const section = `## ${heading}\n\n${op.body.trim()}\n`
  const re = new RegExp(String.raw`^##\s+${escapeRegExp(heading)}\s*$`, 'imv')
  const match = re.exec(markdown)
  if (!match || op.kind === 'append_section') {
    return `${markdown.trimEnd()}\n\n${section}`
  }

  const start = match.index
  const afterHeading = start + match[0].length
  const rest = markdown.slice(afterHeading)
  const next =
    /^##\s+(?:\S.*|[\t\v\f \u{00A0}\u{1680}\u{2000}-\u{200A}\u{202F}\u{205F}\u{3000}\u{FEFF}])$/mv.exec(
      rest
    )
  const end = next ? afterHeading + next.index : markdown.length
  return `${markdown.slice(0, start)}${section}\n${markdown.slice(end).replace(/^\s+/v, '')}`
}

function bumpVersion(text: string): string {
  const version = /learning\/version:\s*["']?(?<number>\d+)["']?/v.exec(text)
  if (!version) {
    return text
  }

  const number = version.groups?.number
  if (number === undefined) {
    return text
  }

  const next = Number(number) + 1
  return text.replace(version[0], () => `learning/version: "${next}"`)
}

function yamlScalar(value: unknown): string {
  return JSON.stringify(String(value))
}

function escapeRegExp(value: string): string {
  const specialCharacters = new Set([
    '$',
    '(',
    ')',
    '*',
    '+',
    '.',
    '?',
    '[',
    '\\',
    ']',
    '^',
    '{',
    '|',
    '}'
  ])
  return [...value]
    .map((character) => (specialCharacters.has(character) ? `\\${character}` : character))
    .join('')
}

function safePending(root: string, id: string): string {
  if (!/^[\w\u{2D}.]+$/v.test(id)) {
    throw new Error('invalid pending id')
  }

  const dir = path.join(root, id)
  if (!dir.startsWith(root + path.sep)) {
    throw new Error('invalid pending path')
  }

  return dir
}

function supportPath(skillDir: string, relative: string): string {
  const invalidRelativePath = relative
  if (!isSafeSupportPath(relative)) {
    throw new Error(`invalid supporting file path: ${invalidRelativePath}`)
  }

  const target = path.resolve(skillDir, relative)
  if (!target.startsWith(path.resolve(skillDir) + path.sep)) {
    throw new Error(`supporting file escapes skill directory: ${relative}`)
  }

  return target
}

async function walk(
  root: string,
  current: string,
  out: Array<{ path: string; bytes: number }>
): Promise<void> {
  let entries
  try {
    entries = await fs.readdir(current, { withFileTypes: true })
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return
    }

    throw error
  }

  await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(root, full, out)
      } else if (entry.isFile()) {
        const stat = await fs.stat(full)
        out.push({ path: path.relative(root, full).split(path.sep).join('/'), bytes: stat.size })
      }
    })
  )
}

async function ensurePathMissing(file: string, message: string): Promise<void> {
  try {
    await fs.access(file)
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return
    }

    throw error
  }

  throw new Error(message)
}

async function requireOwnedSkill(
  store: SkillStore,
  skillId: string,
  scope: string
): Promise<OwnedSkill> {
  const current = await store.getOwned(skillId, scope)
  if (current === undefined) {
    throw new Error(`refusing to patch non-owned or missing skill: ${skillId}`)
  }

  return current
}

function assertExpectedSkillHash(
  current: OwnedSkill,
  expectedSha256: string | undefined,
  skillId: string
): void {
  if (current.sha256 !== expectedSha256) {
    throw new Error(`stale patch for ${skillId}; skill changed since reflection`)
  }
}

async function ensureSupportingFilesAbsent(
  skillDir: string,
  files: SupportingFile[]
): Promise<void> {
  await Promise.all(
    files.map(async (item) => {
      const target = supportPath(skillDir, item.path)
      try {
        await fs.access(target)
      } catch (error: unknown) {
        if (hasErrorCode(error, 'ENOENT')) {
          return
        }

        throw error
      }

      throw new Error(`refusing to overwrite existing supporting file: ${item.path}`)
    })
  )
}

async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined
    }

    throw error
  }
}
