import fs from 'node:fs/promises'
import path from 'node:path'
import { assertNoSymlinkPath, atomicWrite, hasErrorCode } from './shared.ts'
import { isSafeSupportPath } from './store-validation.ts'
import type { Proposal, SectionOperation, SupportingFile } from './types.ts'

export function applyOperations(markdown: string, operations: SectionOperation[]): string {
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

export function bumpVersion(text: string): string {
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

export function yamlScalar(value: unknown): string {
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

export function safePending(root: string, id: string): string {
  if (!/^[\w\u{2D}.]+$/v.test(id)) {
    throw new Error('invalid pending id')
  }

  const dir = path.join(root, id)
  if (!dir.startsWith(root + path.sep)) {
    throw new Error('invalid pending path')
  }

  return dir
}

export function supportPath(skillDir: string, relative: string): string {
  if (!isSafeSupportPath(relative)) {
    throw new Error(`invalid supporting file path: ${relative}`)
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

export async function listSupportingFiles(
  skillDir: string
): Promise<Array<{ path: string; bytes: number }>> {
  const out: Array<{ path: string; bytes: number }> = []
  await walk(skillDir, skillDir, out)
  return out.filter((item) => item.path !== 'SKILL.md').slice(0, 100)
}

export async function reserveDirectory(dir: string, message: string): Promise<void> {
  await assertNoSymlinkPath(dir)
  await fs.mkdir(path.dirname(dir), { recursive: true })
  try {
    await fs.mkdir(dir)
  } catch (error: unknown) {
    if (hasErrorCode(error, 'EEXIST')) {
      throw new Error(message, { cause: error })
    }

    throw error
  }
}

export async function ensureSupportingFilesAbsent(
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

export async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return undefined
    }

    throw error
  }
}
