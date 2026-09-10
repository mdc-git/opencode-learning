import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { addOwnership, hasOwnership, skillDescription } from './skill-markdown.ts'

const FILE_LIMIT = 25 * 1024 * 1024
const TREE_LIMIT = 100 * 1024 * 1024
const GENERATED_FILE_LIMIT = 1024 * 1024
const GENERATED_TOTAL_LIMIT = 10 * 1024 * 1024
const encoder = new TextEncoder()

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

type ProposedFile =
  | { path: string; content: string; executable: boolean }
  | { path: string; source: { from: 'project' | 'candidate'; path: string } }

type ProposedSkillFiles = { skillMd: string; files: readonly ProposedFile[] }

type MaterializeOptions = {
  project: string
  temporary: string
  id: string
  skill: ProposedSkillFiles
  authorizedPaths: string[]
  candidate?: { root: string; manifest: FileManifest[] }
}

export function safeChild(root: string, child: string): string {
  const target = path.resolve(root, child)
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error('path escapes root')
  }

  return target
}

function isExecutable(mode: number): boolean {
  const owner = Math.floor(mode / 64) % 2
  const group = Math.floor(mode / 8) % 2
  const other = mode % 2
  return owner === 1 || group === 1 || other === 1
}

async function scanFile(
  root: string,
  full: string,
  size: number,
  mode: number
): Promise<FileManifest> {
  if (size > FILE_LIMIT) {
    throw new Error(`file exceeds 25 MiB: ${full}`)
  }

  const bytes = await fs.readFile(full)
  return {
    path: path.relative(root, full).split(path.sep).join('/'),
    size,
    executable: isExecutable(mode),
    hash: crypto.createHash('sha256').update(bytes).digest('hex')
  }
}

async function scanEntry(root: string, current: string, name: string): Promise<FileManifest[]> {
  const full = path.join(current, name)
  const stat = await fs.lstat(full)
  if (stat.isSymbolicLink()) {
    throw new Error(`symlink is not allowed: ${full}`)
  }

  if (stat.isDirectory()) {
    return scanDirectory(root, full)
  }

  if (!stat.isFile()) {
    throw new Error(`unsupported filesystem entry: ${full}`)
  }

  return [await scanFile(root, full, stat.size, stat.mode)]
}

async function scanDirectory(root: string, current: string): Promise<FileManifest[]> {
  const entries = await fs.readdir(current, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => scanEntry(root, current, entry.name))
  )
  return nested.flat()
}

async function assertSkillRoot(root: string): Promise<void> {
  const stat = await fs.lstat(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('skill root must be a real directory')
  }
}

function treeSize(files: FileManifest[]): number {
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > TREE_LIMIT) {
    throw new Error('skill tree exceeds 100 MiB')
  }

  return total
}

async function treeRevision(root: string, files: FileManifest[]): Promise<string> {
  const contents = await Promise.all(
    files.map(async (file) => fs.readFile(path.join(root, file.path)))
  )
  const revision = crypto.createHash('sha256')
  for (const [index, file] of files.entries()) {
    revision.update(file.path).update('\0')
    revision.update(file.executable ? '1' : '0').update('\0')
    revision.update(contents[index] ?? new Uint8Array()).update('\0')
  }

  return revision.digest('hex')
}

export async function scanSkillTree(root: string): Promise<TreeScan> {
  await assertSkillRoot(root)
  const scanned = await scanDirectory(root, root)
  const files = scanned.toSorted((left, right) => left.path.localeCompare(right.path))
  const totalSize = treeSize(files)
  const revision = await treeRevision(root, files)
  return { files, totalSize, revision }
}

export async function validateSkillTree(root: string, isOwned: boolean): Promise<TreeScan> {
  const scan = await scanSkillTree(root)
  if (scan.files.every((file) => file.path !== 'SKILL.md')) {
    throw new Error('skill tree requires SKILL.md')
  }

  const markdown = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8')
  skillDescription(markdown)
  if (isOwned && !hasOwnership(markdown)) {
    throw new Error('skill is not owned by opencode-learning')
  }

  return scan
}

async function atomicWrite(file: string, bytes: Uint8Array | string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  await fs.writeFile(temporary, bytes, { mode })
  await fs.rename(temporary, file)
}

export async function copySkillTree(source: string, destination: string): Promise<void> {
  const scan = await scanSkillTree(source)
  await fs.mkdir(destination, { recursive: true })
  await Promise.all(
    scan.files.map(async (file) => {
      const bytes = await fs.readFile(path.join(source, file.path))
      await atomicWrite(safeChild(destination, file.path), bytes, file.executable ? 0o755 : 0o644)
    })
  )
  const wanted = new Set(scan.files.map((file) => file.path))
  const current = await scanSkillTree(destination)
  const removed = current.files.filter((file) => !wanted.has(file.path))
  await Promise.all(
    removed.map(async (file) => fs.rm(path.join(destination, file.path), { force: true }))
  )
}

function isInvalidDestination(relative: string): boolean {
  if (relative === 'SKILL.md' || path.isAbsolute(relative) || relative.includes('\\')) {
    return true
  }

  return relative.split('/').some((part) => ['', '.', '..'].includes(part))
}

function generatedSizes(skill: ProposedSkillFiles): number[] {
  return skill.files
    .filter((file): file is Extract<ProposedFile, { content: string }> => 'content' in file)
    .map((file) => encoder.encode(file.content).byteLength)
}

function assertGeneratedFileSizes(sizes: number[]): void {
  if (sizes.some((size) => size > GENERATED_FILE_LIMIT)) {
    throw new Error('generated supporting file exceeds 1 MiB')
  }
}

function assertGeneratedTotal(skill: ProposedSkillFiles, sizes: number[]): void {
  const total = encoder.encode(skill.skillMd).byteLength + sizes.reduce((sum, size) => sum + size, 0)
  if (total > GENERATED_TOTAL_LIMIT) {
    throw new Error('generated content exceeds 10 MiB')
  }
}

function assertGeneratedPaths(skill: ProposedSkillFiles): void {
  const paths = skill.files.map((file) => file.path)
  const hasInvalidPath = paths.some((item) => isInvalidDestination(item))
  if (hasInvalidPath || new Set(paths).size !== paths.length) {
    throw new Error('supporting file paths must be unique safe relative paths')
  }
}

function validateGenerated(skill: ProposedSkillFiles): void {
  const sizes = generatedSizes(skill)
  assertGeneratedFileSizes(sizes)
  assertGeneratedTotal(skill, sizes)
  assertGeneratedPaths(skill)
}

function candidateSource(options: MaterializeOptions, source: string): string {
  const { candidate } = options
  if (candidate === undefined) {
    throw new Error('invalid candidate source')
  }

  const isKnown = candidate.manifest.some((item) => item.path === source)
  if (!isKnown) {
    throw new Error('invalid candidate source')
  }

  return safeChild(candidate.root, source)
}

function projectSource(options: MaterializeOptions, source: string): string {
  const resolved = safeChild(options.project, source)
  const isAuthorized = options.authorizedPaths.some(
    (item) => path.resolve(options.project, item) === resolved
  )
  if (!isAuthorized) {
    throw new Error('project source was not authorized by structured evidence')
  }

  return resolved
}

function sourcePath(options: MaterializeOptions, file: Extract<ProposedFile, { source: unknown }>) {
  return file.source.from === 'candidate'
    ? candidateSource(options, file.source.path)
    : projectSource(options, file.source.path)
}

async function writeGenerated(target: string, file: Extract<ProposedFile, { content: string }>) {
  await fs.writeFile(target, file.content, { mode: file.executable ? 0o755 : 0o644 })
}

async function writeSource(
  options: MaterializeOptions,
  target: string,
  file: Extract<ProposedFile, { source: unknown }>
): Promise<void> {
  const source = sourcePath(options, file)
  const stat = await fs.lstat(source)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('source must be a regular non-symlink file')
  }

  await fs.copyFile(source, target)
  await fs.chmod(target, isExecutable(stat.mode) ? 0o755 : 0o644)
}

async function writeProposedFile(
  options: MaterializeOptions,
  skillRoot: string,
  file: ProposedFile
): Promise<void> {
  const target = safeChild(skillRoot, file.path)
  await fs.mkdir(path.dirname(target), { recursive: true })
  return 'content' in file
    ? writeGenerated(target, file)
    : writeSource(options, target, file)
}

export async function materializeSkill(options: MaterializeOptions) {
  validateGenerated(options.skill)
  const root = path.join(options.temporary, options.id)
  const skillRoot = path.join(root, 'skill')
  await fs.mkdir(skillRoot, { recursive: true })
  await fs.writeFile(path.join(skillRoot, 'SKILL.md'), addOwnership(options.skill.skillMd))
  await Promise.all(
    options.skill.files.map(async (file) => writeProposedFile(options, skillRoot, file))
  )
  const scan = await validateSkillTree(skillRoot, true)
  return { root, skillRoot, scan }
}
