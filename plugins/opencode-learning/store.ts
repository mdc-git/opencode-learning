import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import {
  copySkillTree,
  safeChild,
  scanSkillTree,
  validateSkillTree,
  type FileManifest,
  type TreeScan
} from './skill-files.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/v
const SKILL_ID = /^[0-9a-z]+(?:-[0-9a-z]+)*$/v
const REVISION = /^[0-9a-f]{64}$/v
const PROPOSAL_KEYS = new Set(['kind', 'skillId', 'reason', 'evidence', 'expectedRevision'])
export const PENDING_LIMIT = 20

export type ProposalMetadata = {
  kind: 'create' | 'patch'
  skillId: string
  reason: string
  evidence: unknown
  expectedRevision?: string
}

export type PendingProposal = ProposalMetadata & { id: string; invalid?: boolean }

type ProposalBase = Pick<ProposalMetadata, 'kind' | 'skillId' | 'reason' | 'evidence'>
type StorePaths = {
  project: string
  projectSkills: string
  globalSkills: string
  pending: string
  temporary: string
}

export type Store = ReturnType<typeof createStore>

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

async function isPresent(file: string): Promise<boolean> {
  try {
    await fs.lstat(file)
    return true
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') {
      return false
    }

    throw error
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

function requiredHome(): string {
  const home = nonEmpty(process.env.HOME)
  if (home === undefined) {
    throw new Error('HOME is required when XDG_CONFIG_HOME is unset')
  }

  return home
}

function globalSkillsRoot(): string {
  const config = nonEmpty(process.env.XDG_CONFIG_HOME)
  return config === undefined
    ? path.join(requiredHome(), '.config', 'opencode', 'skills')
    : path.join(config, 'opencode', 'skills')
}

function storePaths(project: string): StorePaths {
  const learning = path.join(project, '.opencode', '.learning')
  return {
    project,
    projectSkills: path.join(project, '.opencode', 'skills'),
    globalSkills: globalSkillsRoot(),
    pending: path.join(learning, 'pending'),
    temporary: path.join(learning, 'tmp')
  }
}

async function pendingIds(paths: StorePaths): Promise<string[]> {
  await fs.mkdir(paths.pending, { recursive: true })
  const entries = await fs.readdir(paths.pending, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory() && UUID.test(entry.name))
    .map((entry) => entry.name)
}

async function pendingCount(paths: StorePaths): Promise<number> {
  const ids = await pendingIds(paths)
  return ids.length
}

function proposalRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid proposal metadata')
  }

  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !PROPOSAL_KEYS.has(key))) {
    throw new Error('proposal metadata contains unsupported fields')
  }

  return input
}

function proposalKind(value: unknown): ProposalMetadata['kind'] {
  if (value !== 'create' && value !== 'patch') {
    throw new Error('invalid proposal kind')
  }

  return value
}

function proposalSkillId(value: unknown): string {
  if (typeof value !== 'string' || !SKILL_ID.test(value)) {
    throw new Error('invalid skill id')
  }

  return value
}

function proposalReason(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('proposal reason is required')
  }

  return value
}

function proposalBase(input: Record<string, unknown>): ProposalBase {
  if (!('evidence' in input)) {
    throw new Error('proposal evidence is required')
  }

  return {
    kind: proposalKind(input.kind),
    skillId: proposalSkillId(input.skillId),
    reason: proposalReason(input.reason),
    evidence: input.evidence
  }
}

function patchRevision(input: Record<string, unknown>): string {
  if (typeof input.expectedRevision !== 'string' || !REVISION.test(input.expectedRevision)) {
    throw new Error('patch expectedRevision is required')
  }

  return input.expectedRevision
}

function decodeProposal(value: unknown): ProposalMetadata {
  const input = proposalRecord(value)
  const proposal = proposalBase(input)
  if (proposal.kind === 'create') {
    if ('expectedRevision' in input) {
      throw new Error('create proposal must not have expectedRevision')
    }

    return proposal
  }

  return { ...proposal, expectedRevision: patchRevision(input) }
}

async function readPending(paths: StorePaths, id: string): Promise<PendingProposal> {
  if (!UUID.test(id)) {
    throw new Error('proposal id must be an exact UUID')
  }

  const directory = safeChild(paths.pending, id)
  const text = await fs.readFile(path.join(directory, 'proposal.json'), 'utf8')
  return { id, ...decodeProposal(JSON.parse(text)) }
}

async function pendingEntry(paths: StorePaths, id: string) {
  const directory = safeChild(paths.pending, id)
  const stat = await fs.stat(directory)
  try {
    return { mtime: stat.mtimeMs, proposal: await readPending(paths, id) }
  } catch {
    const proposal: PendingProposal = {
      id,
      kind: 'create',
      skillId: '<invalid>',
      reason: '<invalid>',
      evidence: [],
      invalid: true
    }
    return { mtime: stat.mtimeMs, proposal }
  }
}

async function listPending(paths: StorePaths): Promise<PendingProposal[]> {
  const ids = await pendingIds(paths)
  const entries = await Promise.all(ids.map(async (id) => pendingEntry(paths, id)))
  return entries.toSorted((left, right) => right.mtime - left.mtime).map((entry) => entry.proposal)
}

function isSameFile(left: FileManifest, right: FileManifest): boolean {
  return left.hash === right.hash && left.executable === right.executable
}

function fileStatuses(staged: TreeScan, current?: TreeScan): string[] {
  const currentFiles = new Map(current?.files.map((file) => [file.path, file]))
  const stagedFiles = new Set(staged.files.map((file) => file.path))
  const present = staged.files.map((file) => {
    const previous = currentFiles.get(file.path)
    const status =
      previous === undefined ? 'added' : isSameFile(file, previous) ? 'unchanged' : 'changed'
    return `${status} ${file.path}`
  })
  const removed = (current?.files ?? [])
    .filter((file) => !stagedFiles.has(file.path))
    .map((file) => `removed ${file.path}`)
  return [...present, ...removed]
}

async function patchStatus(paths: StorePaths, proposal: PendingProposal) {
  const stagedRoot = path.join(safeChild(paths.pending, proposal.id), 'skill')
  const staged = await validateSkillTree(stagedRoot, false)
  if (proposal.kind === 'create') {
    return { isStale: false, files: fileStatuses(staged) }
  }

  try {
    const current = await validateSkillTree(safeChild(paths.projectSkills, proposal.skillId), true)
    return {
      isStale: current.revision !== proposal.expectedRevision,
      files: fileStatuses(staged, current)
    }
  } catch {
    return { isStale: true, files: fileStatuses(staged) }
  }
}

async function stage(
  paths: StorePaths,
  metadata: ProposalMetadata,
  temporaryRoot: string,
  id: string
): Promise<void> {
  if ((await pendingCount(paths)) >= PENDING_LIMIT) {
    throw new Error('pending proposal limit reached')
  }

  const destination = safeChild(paths.pending, id)
  if (await isPresent(destination)) {
    throw new Error('proposal id collision')
  }

  await fs.writeFile(path.join(temporaryRoot, 'proposal.json'), `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o644
  })
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.rename(temporaryRoot, destination)
}

async function assertCreateAvailable(paths: StorePaths, skillId: string): Promise<void> {
  if (!SKILL_ID.test(skillId)) {
    throw new Error('invalid skill id')
  }

  const occupied = await Promise.all([
    isPresent(safeChild(paths.projectSkills, skillId)),
    isPresent(safeChild(paths.globalSkills, skillId))
  ])
  if (occupied.some(Boolean)) {
    throw new Error('skill id already exists')
  }
}

async function approvalTarget(paths: StorePaths, proposal: PendingProposal): Promise<string> {
  const target = safeChild(paths.projectSkills, proposal.skillId)
  if (proposal.kind === 'create') {
    await assertCreateAvailable(paths, proposal.skillId)
    return target
  }

  const current = await validateSkillTree(target, true)
  if (current.revision !== proposal.expectedRevision) {
    throw new Error('patch target is stale')
  }

  return target
}

async function approve(paths: StorePaths, id: string): Promise<string> {
  const proposal = await readPending(paths, id)
  const staged = path.join(safeChild(paths.pending, id), 'skill')
  const intended = await validateSkillTree(staged, true)
  const target = await approvalTarget(paths, proposal)
  await copySkillTree(staged, target)
  const [applied, unchanged] = await Promise.all([scanSkillTree(target), scanSkillTree(staged)])
  if (applied.revision !== intended.revision || unchanged.revision !== intended.revision) {
    throw new Error('approval post-check failed')
  }

  await fs.rm(safeChild(paths.pending, id), { recursive: true })
  return proposal.skillId
}

async function removeGlobalTarget(target: string): Promise<void> {
  if (!(await isPresent(target))) {
    return
  }

  const stat = await fs.lstat(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('global destination is not a real directory')
  }

  await fs.rm(target, { recursive: true })
}

async function promote(paths: StorePaths, skillId: string): Promise<void> {
  if (!SKILL_ID.test(skillId)) {
    throw new Error('invalid skill id')
  }

  const source = safeChild(paths.projectSkills, skillId)
  const intended = await validateSkillTree(source, true)
  const target = safeChild(paths.globalSkills, skillId)
  await removeGlobalTarget(target)
  await copySkillTree(source, target)
  const [unchanged, copied] = await Promise.all([scanSkillTree(source), scanSkillTree(target)])
  if (unchanged.revision !== intended.revision || copied.revision !== intended.revision) {
    throw new Error('promotion post-check failed')
  }
}

export function createStore(project: string) {
  const paths = storePaths(project)
  return {
    ...paths,
    pendingCount: async () => pendingCount(paths),
    listPending: async () => listPending(paths),
    readPending: async (id: string) => readPending(paths, id),
    patchStatus: async (proposal: PendingProposal) => patchStatus(paths, proposal),
    stage: async (metadata: ProposalMetadata, temporaryRoot: string, id: string) =>
      stage(paths, metadata, temporaryRoot, id),
    async reject(id: string) {
      if (!UUID.test(id)) {
        throw new Error('proposal id must be an exact UUID')
      }

      await fs.rm(safeChild(paths.pending, id), { recursive: true, force: true })
    },
    approve: async (id: string) => approve(paths, id),
    promote: async (skillId: string) => promote(paths, skillId),
    validateTree: validateSkillTree,
    assertCreateAvailable: async (skillId: string) => assertCreateAvailable(paths, skillId)
  }
}
