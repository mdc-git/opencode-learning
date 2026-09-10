import fs from 'node:fs/promises'
import path from 'node:path'
import { addOwnership } from './skill-markdown.ts'
import { isExecutable, safeChild, validateSkillTree, type FileManifest } from './skill-tree.ts'

const GENERATED_FILE_LIMIT = 1024 * 1024
const GENERATED_TOTAL_LIMIT = 10 * 1024 * 1024
const encoder = new TextEncoder()

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
  const total =
    encoder.encode(skill.skillMd).byteLength + sizes.reduce((sum, size) => sum + size, 0)
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
  return 'content' in file ? writeGenerated(target, file) : writeSource(options, target, file)
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
