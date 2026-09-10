import fs from 'node:fs/promises'
import path from 'node:path'
import { hasOwnership, skillDescription } from './skill-files.ts'
import type { FileManifest } from './skill-files.ts'
import type { Store } from './store.ts'

const CONTROL = /^\/learn(?:\s|$|-)/v
const encoder = new TextEncoder()

export type Candidate = {
  id: string
  description: string
  markdown: string
  manifest: FileManifest[]
  revision: string
}

export type Evidence = {
  records: unknown[]
  omitted: number
  authorizedPaths: string[]
  endCursor?: string
}

function messageRecord(message: unknown): Record<string, unknown> | undefined {
  return typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : undefined
}

function compactTool(part: Record<string, unknown>): unknown {
  const state = messageRecord(part.state) ?? {}
  return {
    type: 'tool',
    tool: part.name,
    outcome: state.status,
    relevantInput: state.input,
    metadata: state.metadata
  }
}

function compactAssistant(message: Record<string, unknown>): unknown {
  const content = Array.isArray(message.content) ? message.content : []
  const records = content.flatMap((part) => {
    const item = messageRecord(part)
    if (item === undefined || (item.type !== 'text' && item.type !== 'tool')) {
      return []
    }
    return [item.type === 'text' ? { type: 'text', text: item.text } : compactTool(item)]
  })
  return { type: 'assistant', content: records }
}

function compactMessage(message: unknown): unknown | undefined {
  const item = messageRecord(message)
  if (item === undefined) {
    return undefined
  }
  if (item.type === 'user') {
    const text = typeof item.text === 'string' ? item.text : ''
    return CONTROL.test(text) ? undefined : { type: 'user', text, files: item.files }
  }
  if (item.type === 'assistant') {
    return compactAssistant(item)
  }
  if (item.type === 'shell') {
    return { type: 'shell', status: item.status, exit: item.exit }
  }
  return undefined
}

function collectPathFields(value: Record<string, unknown>, output: Set<string>): void {
  Object.entries(value).forEach(([key, item]) => {
    if ((key === 'path' || key === 'target' || key === 'file') && typeof item === 'string') {
      output.add(item)
    } else if ((key === 'metadata' || key === 'relevantInput') && item !== undefined) {
      collectAuthorizedPaths(item, output)
    }
  })
}

function collectAuthorizedPaths(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectAuthorizedPaths(item, output))
    return
  }
  const record = messageRecord(value)
  if (record !== undefined) {
    collectPathFields(record, output)
  }
}

function messageId(message: unknown): string | undefined {
  const item = messageRecord(message)
  return typeof item?.id === 'string' ? item.id : undefined
}

export function captureEvidence(messages: readonly unknown[], startAfter?: string): Evidence {
  const found = startAfter === undefined ? -1 : messages.findIndex((message) => messageId(message) === startAfter)
  const start = startAfter === undefined ? 0 : Math.max(0, found + 1)
  const selected = messages.slice(start)
  const records = selected.flatMap((message) => {
    const compacted = compactMessage(message)
    return compacted === undefined ? [] : [compacted]
  })
  const authorized = new Set<string>()
  records.forEach((record) => collectAuthorizedPaths(record, authorized))
  return {
    records,
    omitted: 0,
    authorizedPaths: [...authorized].toSorted((left, right) => left.localeCompare(right)),
    endCursor: messageId(selected.at(-1))
  }
}

async function candidateFor(store: Store, name: string): Promise<Candidate | undefined> {
  const root = path.join(store.projectSkills, name)
  try {
    const markdown = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8')
    if (!hasOwnership(markdown)) {
      return undefined
    }
    const scan = await store.validateTree(root, true)
    return {
      id: name,
      description: skillDescription(markdown),
      markdown,
      manifest: scan.files,
      revision: scan.revision
    }
  } catch {
    return undefined
  }
}

export async function ownedCandidates(store: Store): Promise<Candidate[]> {
  await fs.mkdir(store.projectSkills, { recursive: true })
  const entries = await fs.readdir(store.projectSkills, { withFileTypes: true })
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const candidates = await Promise.all(names.map(async (name) => candidateFor(store, name)))
  return candidates
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .toSorted((left, right) => left.id.localeCompare(right.id))
}

function tokens(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^0-9a-z]+/v).filter((item) => item.length > 2)
  return new Set(words)
}

export function selectCandidates(all: Candidate[], evidence: Evidence): Candidate[] {
  const text = JSON.stringify(evidence.records)
  const words = tokens(text)
  return all
    .map((candidate) => ({
      candidate,
      explicit: text.includes(candidate.id),
      overlap: [...tokens(`${candidate.id} ${candidate.description}`)].filter((word) => words.has(word)).length
    }))
    .filter((item) => item.explicit || item.overlap > 0)
    .toSorted(
      (left, right) =>
        Number(right.explicit) - Number(left.explicit) ||
        right.overlap - left.overlap ||
        left.candidate.id.localeCompare(right.candidate.id)
    )
    .slice(0, 5)
    .map((item) => item.candidate)
}

export function catalog(candidates: Candidate[]) {
  return candidates.map(({ id, description }) => ({ id, description }))
}

export function candidatePacket(candidates: Candidate[]) {
  return candidates.map((candidate) => ({
    id: candidate.id,
    description: candidate.description,
    skillMd: candidate.markdown,
    revision: candidate.revision,
    files: candidate.manifest.filter((file) => file.path !== 'SKILL.md')
  }))
}

export function packetBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength
}

function boundedEvidence(evidence: Evidence, keep: number): Evidence {
  const omitted = evidence.records.length - keep
  return { ...evidence, records: evidence.records.slice(omitted), omitted: evidence.omitted + omitted }
}

function fitEvidence(
  evidence: Evidence,
  ownedSkills: unknown[],
  candidates: Candidate[],
  maxBytes: number
): Evidence | undefined {
  const counts = Array.from({ length: evidence.records.length + 1 }, (_, index) => evidence.records.length - index)
  return counts
    .map((count) => boundedEvidence(evidence, count))
    .find((bounded) => packetBytes({ evidence: bounded, ownedSkills, candidates: candidatePacket(candidates) }) <= maxBytes)
}

export function boundPacket(
  evidence: Evidence,
  all: Candidate[],
  selected: Candidate[],
  maxBytes: number
): { evidence: Evidence; candidates: Candidate[] } {
  const ownedSkills = catalog(all)
  if (packetBytes({ ownedSkills }) > maxBytes) {
    throw new Error('owned skill catalog exceeds model input limit')
  }
  const counts = Array.from({ length: selected.length + 1 }, (_, index) => selected.length - index)
  const match = counts
    .map((count) => selected.slice(0, count))
    .map((candidates) => ({ candidates, evidence: fitEvidence(evidence, ownedSkills, candidates, maxBytes) }))
    .find((item) => item.evidence !== undefined)
  if (match?.evidence === undefined) {
    throw new Error('review packet exceeds model input limit')
  }
  return { evidence: match.evidence, candidates: match.candidates }
}
