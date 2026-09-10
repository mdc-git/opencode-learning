import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { parseDocument } from 'yaml'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/v
const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/v
const OWNER_KEY = 'opencode-learning/owner'
const FILE_LIMIT = 25 * 1024 * 1024
const TREE_LIMIT = 100 * 1024 * 1024
export const PENDING_LIMIT = 20

export type FileManifest = {
  path: string
  size: number
  executable: boolean
  hash: string
}

export type TreeScan = {
  files: FileManifest[]
  revision: string
  totalSize: number
}

export type ProposalMetadata = {
  kind: 'create' | 'patch'
  skillId: string
  reason: string
  evidence: unknown
  expectedRevision?: string
}

export type PendingProposal = ProposalMetadata & {
  id: string
  invalid?: boolean
}

export type Store = ReturnType<typeof createStore>

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file)
    return true
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

function safeChild(root: string, child: string): string {
  const target = path.resolve(root, child)
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('path escapes root')
  return target
}

function hashFile(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

async function walk(root: string, current: string, out: FileManifest[]): Promise<void> {
  const entries = await fs.readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    const full = path.join(current, entry.name)
    const stat = await fs.lstat(full)
    if (stat.isSymbolicLink()) throw new Error(`symlink is not allowed: ${full}`)
    if (stat.isDirectory()) {
      await walk(root, full, out)
      continue
    }
    if (!stat.isFile()) throw new Error(`unsupported filesystem entry: ${full}`)
    if (stat.size > FILE_LIMIT) throw new Error(`file exceeds 25 MiB: ${full}`)
    const bytes = await fs.readFile(full)
    out.push({
      path: path.relative(root, full).split(path.sep).join('/'),
      size: stat.size,
      executable: (stat.mode & 0o111) !== 0,
      hash: hashFile(bytes)
    })
  }
}

export async function scanSkillTree(root: string): Promise<TreeScan> {
  const stat = await fs.lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('skill root must be a real directory')
  const files: FileManifest[] = []
  await walk(root, root, files)
  files.sort((a, b) => a.path.localeCompare(b.path))
  const totalSize = files.reduce((sum, file) => sum + file.size, 0)
  if (totalSize > TREE_LIMIT) throw new Error('skill tree exceeds 100 MiB')
  const revision = crypto.createHash('sha256')
  for (const file of files) {
    revision.update(file.path).update('\0').update(file.executable ? '1' : '0').update('\0')
    revision.update(await fs.readFile(path.join(root, file.path))).update('\0')
  }
  return { files, totalSize, revision: revision.digest('hex') }
}

function splitSkillMarkdown(text: string): { yaml: string; body: string } {
  const match = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---\r?\n(?<body>[\s\S]*)$/v.exec(text)
  if (!match?.groups) throw new Error('SKILL.md requires YAML frontmatter')
  return { yaml: match.groups.yaml ?? '', body: match.groups.body ?? '' }
}

function parseSkillMarkdown(text: string): { document: ReturnType<typeof parseDocument>; body: string } {
  const { yaml, body } = splitSkillMarkdown(text)
  const document = parseDocument(yaml)
  if (document.errors.length > 0) throw new Error(`invalid SKILL.md frontmatter: ${document.errors[0]?.message}`)
  const data = document.toJS() as unknown
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error('skill frontmatter must be a mapping')
  const description = (data as Record<string, unknown>).description
  if (typeof description !== 'string' || description.trim() === '') throw new Error('skill description is required')
  return { document, body }
}

export function addOwnership(text: string): string {
  const { document, body } = parseSkillMarkdown(text)
  const data = document.toJS() as Record<string, unknown>
  const current = data.metadata
  const metadata = typeof current === 'object' && current !== null && !Array.isArray(current) ? (current as Record<string, unknown>) : {}
  document.set('metadata', { ...metadata, [OWNER_KEY]: 'true' })
  return `---\n${String(document).trimEnd()}\n---\n${body}`
}

export function skillDescription(text: string): string {
  const { document } = parseSkillMarkdown(text)
  const data = document.toJS() as Record<string, unknown>
  return String(data.description)
}

export function hasOwnership(text: string): boolean {
  const { document } = parseSkillMarkdown(text)
  const data = document.toJS() as Record<string, unknown>
  const metadata = data.metadata
  return typeof metadata === 'object' && metadata !== null && (metadata as Record<string, unknown>)[OWNER_KEY] === 'true'
}

async function validateTree(root: string, owned: boolean): Promise<TreeScan> {
  const scan = await scanSkillTree(root)
  const skillFile = scan.files.find((file) => file.path === 'SKILL.md')
  if (!skillFile) throw new Error('skill tree requires SKILL.md')
  const markdown = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8')
  parseSkillMarkdown(markdown)
  if (owned && !hasOwnership(markdown)) throw new Error('skill is not owned by opencode-learning')
  return scan
}

function decodeProposal(value: unknown): ProposalMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid proposal metadata')
  const input = value as Record<string, unknown>
  const allowed = new Set(['kind', 'skillId', 'reason', 'evidence', 'expectedRevision'])
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error('proposal metadata contains unsupported fields')
  if (input.kind !== 'create' && input.kind !== 'patch') throw new Error('invalid proposal kind')
  if (typeof input.skillId !== 'string' || !SKILL_ID.test(input.skillId)) throw new Error('invalid skill id')
  if (typeof input.reason !== 'string') throw new Error('invalid proposal reason')
  if (!('evidence' in input)) throw new Error('proposal evidence is required')
  if (input.kind === 'create' && 'expectedRevision' in input) throw new Error('create proposal must not have expectedRevision')
  if (input.kind === 'patch' && (typeof input.expectedRevision !== 'string' || !/^[0-9a-f]{64}$/v.test(input.expectedRevision))) {
    throw new Error('patch expectedRevision is required')
  }
  const proposal: ProposalMetadata = {
    kind: input.kind,
    skillId: input.skillId,
    reason: input.reason,
    evidence: input.evidence
  }
  if (input.kind === 'patch') proposal.expectedRevision = input.expectedRevision as string
  return proposal
}

async function atomicWrite(file: string, bytes: Buffer | string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  await fs.writeFile(temporary, bytes, { mode })
  await fs.rename(temporary, file)
}

async function copyTree(source: string, destination: string): Promise<void> {
  const scan = await scanSkillTree(source)
  await fs.mkdir(destination, { recursive: true })
  for (const file of scan.files) {
    const target = safeChild(destination, file.path)
    await atomicWrite(target, await fs.readFile(path.join(source, file.path)), file.executable ? 0o755 : 0o644)
  }
  const wanted = new Set(scan.files.map((file) => file.path))
  const current = (await scanSkillTree(destination)).files
  for (const file of current.toReversed()) {
    if (!wanted.has(file.path)) await fs.rm(path.join(destination, file.path), { force: true })
  }
}

function globalSkillsRoot(): string {
  const config = process.env.XDG_CONFIG_HOME
  if (config) return path.join(config, 'opencode', 'skills')
  const home = process.env.HOME
  if (!home) throw new Error('HOME is required when XDG_CONFIG_HOME is unset')
  return path.join(home, '.config', 'opencode', 'skills')
}

export function createStore(project: string) {
  const projectSkills = path.join(project, '.opencode', 'skills')
  const learning = path.join(project, '.opencode', '.learning')
  const pending = path.join(learning, 'pending')
  const temporary = path.join(learning, 'tmp')
  const globalSkills = globalSkillsRoot()

  async function pendingIds(): Promise<string[]> {
    await fs.mkdir(pending, { recursive: true })
    return (await fs.readdir(pending, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && UUID.test(entry.name))
      .map((entry) => entry.name)
  }

  async function pendingCount(): Promise<number> {
    return (await pendingIds()).length
  }

  async function readPending(id: string): Promise<PendingProposal> {
    if (!UUID.test(id)) throw new Error('proposal id must be an exact UUID')
    const dir = safeChild(pending, id)
    const metadata = decodeProposal(JSON.parse(await fs.readFile(path.join(dir, 'proposal.json'), 'utf8')))
    return { id, ...metadata }
  }

  async function listPending(): Promise<PendingProposal[]> {
    const entries = await Promise.all(
      (await pendingIds()).map(async (id) => {
        const dir = safeChild(pending, id)
        const mtime = (await fs.stat(dir)).mtimeMs
        try {
          return { mtime, proposal: await readPending(id) }
        } catch {
          return { mtime, proposal: { id, kind: 'create' as const, skillId: '<invalid>', reason: '<invalid>', evidence: [], invalid: true } }
        }
      })
    )
    return entries.toSorted((a, b) => b.mtime - a.mtime).map((entry) => entry.proposal)
  }

  async function stage(metadata: ProposalMetadata, tempRoot: string, id: string): Promise<void> {
    if ((await pendingCount()) >= PENDING_LIMIT) throw new Error('pending proposal limit reached')
    const destination = safeChild(pending, id)
    if (await exists(destination)) throw new Error('proposal id collision')
    await fs.mkdir(path.dirname(destination), { recursive: true })
    await atomicWrite(path.join(tempRoot, 'proposal.json'), `${JSON.stringify(metadata, null, 2)}\n`, 0o644)
    await fs.rename(tempRoot, destination)
  }

  async function reject(id: string): Promise<void> {
    if (!UUID.test(id)) throw new Error('proposal id must be an exact UUID')
    await fs.rm(safeChild(pending, id), { recursive: true, force: true })
  }

  async function approve(id: string): Promise<string> {
    const proposal = await readPending(id)
    const staged = path.join(safeChild(pending, id), 'skill')
    const intended = await validateTree(staged, true)
    const target = safeChild(projectSkills, proposal.skillId)
    if (proposal.kind === 'create') {
      if ((await exists(target)) || (await exists(safeChild(globalSkills, proposal.skillId)))) throw new Error('skill id already exists')
    } else {
      if (!(await exists(target))) throw new Error('patch target does not exist')
      const current = await validateTree(target, true)
      if (current.revision !== proposal.expectedRevision) throw new Error('patch target is stale')
    }
    await copyTree(staged, target)
    if ((await scanSkillTree(target)).revision !== intended.revision) throw new Error('project skill post-check failed')
    if ((await scanSkillTree(staged)).revision !== intended.revision) throw new Error('staged skill changed during approval')
    await fs.rm(safeChild(pending, id), { recursive: true })
    return proposal.skillId
  }

  async function promote(skillId: string): Promise<void> {
    if (!SKILL_ID.test(skillId)) throw new Error('invalid skill id')
    const source = safeChild(projectSkills, skillId)
    const intended = await validateTree(source, true)
    const target = safeChild(globalSkills, skillId)
    if (await exists(target)) {
      const stat = await fs.lstat(target)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('global destination is not a real directory')
      await fs.rm(target, { recursive: true })
    }
    await copyTree(source, target)
    if ((await scanSkillTree(source)).revision !== intended.revision) throw new Error('project skill changed during promotion')
    if ((await scanSkillTree(target)).revision !== intended.revision) throw new Error('global skill post-check failed')
  }

  async function assertCreateAvailable(skillId: string): Promise<void> {
    if (!SKILL_ID.test(skillId)) throw new Error('invalid skill id')
    if ((await exists(safeChild(projectSkills, skillId))) || (await exists(safeChild(globalSkills, skillId)))) {
      throw new Error('skill id already exists')
    }
  }

  return { project, projectSkills, globalSkills, pending, temporary, pendingCount, listPending, readPending, stage, reject, approve, promote, validateTree, assertCreateAvailable }
}
