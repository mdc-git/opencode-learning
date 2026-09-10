import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { hasOwnership, skillDescription } from './skill-markdown.ts'

const FILE_LIMIT = 25 * 1024 * 1024
const TREE_LIMIT = 100 * 1024 * 1024

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

export function safeChild(root: string, child: string): string {
  const target = path.resolve(root, child)
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error('path escapes root')
  }

  return target
}

export function isExecutable(mode: number): boolean {
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

async function atomicWrite(
  file: string,
  bytes: Uint8Array | string,
  mode: number
): Promise<void> {
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
      await atomicWrite(
        safeChild(destination, file.path),
        bytes,
        file.executable ? 0o755 : 0o644
      )
    })
  )
  const wanted = new Set(scan.files.map((file) => file.path))
  const current = await scanSkillTree(destination)
  const removed = current.files.filter((file) => !wanted.has(file.path))
  await Promise.all(
    removed.map(async (file) => fs.rm(path.join(destination, file.path), { force: true }))
  )
}
