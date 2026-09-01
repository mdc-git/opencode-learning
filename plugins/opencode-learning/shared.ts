import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { pid } from 'node:process'
import type { Proposal, UnknownRecord } from './types.ts'

export const SESSION_ID_KEY = 'sessionID'

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function isSafeId(value: unknown): boolean {
  return (
    typeof value === 'string' && /^[0-9a-z]+(?:-[0-9a-z]+)*$/v.test(value) && value.length <= 64
  )
}

function canonicalSkillId(value: unknown): string {
  if (typeof value !== 'string') {
    return ''
  }

  return value
    .normalize('NFKD')
    .replaceAll(/(?<=[0-9a-z])(?=[A-Z])/gv, '-')
    .toLowerCase()
    .replaceAll(/[^0-9a-z]/gv, '-')
    .split('-')
    .filter((part) => part.length > 0)
    .join('-')
    .slice(0, 64)
    .replaceAll(/-$/gv, '')
}

export function normalizeCreateProposal(proposal: Proposal): Proposal {
  if (proposal.decision !== 'create') {
    return proposal
  }

  return { ...proposal, skillId: normalizedProposalSkillId(proposal) }
}

function normalizedProposalSkillId(proposal: Proposal): string {
  const requestedId = canonicalSkillId(proposal.skillId)
  return requestedId.length > 0 ? requestedId : canonicalSkillId(proposal.skill?.name)
}

export async function assertNoSymlinkPath(file: string): Promise<void> {
  const absolute = path.resolve(file)
  const { root } = path.parse(absolute)
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean)
  await assertNoSymlinkComponents(root, parts)
}

async function assertNoSymlinkComponents(current: string, parts: string[]): Promise<void> {
  const [part, ...remaining] = parts
  if (part === undefined) {
    return
  }

  const next = path.join(current, part)
  const isExisting = await isExistingNonSymlinkComponent(next)
  if (!isExisting) {
    return
  }

  await assertNoSymlinkComponents(next, remaining)
}

async function isExistingNonSymlinkComponent(file: string): Promise<boolean> {
  try {
    const stat = await fs.lstat(file)
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing symlink path component: ${file}`)
    }
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return false
    }

    throw error
  }

  return true
}

export async function atomicWrite(file: string, text: string): Promise<void> {
  await assertNoSymlinkPath(file)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await assertNoSymlinkPath(file)
  const temporary = `${file}.tmp-${pid}-${crypto.randomUUID()}`
  await fs.writeFile(temporary, text, { encoding: 'utf8', mode: 384 })
  await fs.rename(temporary, file)
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return structuredClone(fallback)
    }

    throw error
  }
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`)
}

export function trimText(value: unknown, max: number): string {
  if (value === null) {
    return ''
  }

  if (value === undefined) {
    return ''
  }

  const text = stringifyText(value)
  if (text.length <= max) {
    return text
  }

  return truncateText(text, max)
}

function stringifyText(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? primitiveText(value))
}

function truncateText(text: string, max: number): string {
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`
}

export function daysSince(epochMs: number, now = Date.now()): number {
  return (now - epochMs) / 864e5
}

export function redactError(error: unknown): string {
  if (error === null || error === undefined) {
    return 'unknown error'
  }

  return trimText(error instanceof Error ? error.message : error, 800)
}

function primitiveText(value: unknown): string {
  return PRIMITIVE_TEXT_TYPES.has(typeof value) ? String(value) : ''
}

const PRIMITIVE_TEXT_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'bigint',
  'symbol',
  'function'
])
