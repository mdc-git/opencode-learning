import { candidatePacket, catalog, type Candidate } from './candidates.ts'

const CONTROL = /^\/learn(?:\s|$|-)/v
const PATH_KEYS = new Set(['path', 'target', 'file'])
const NESTED_KEYS = new Set(['metadata', 'relevantInput'])
const encoder = new TextEncoder()

export type Evidence = {
  records: unknown[]
  omitted: number
  authorizedPaths: string[]
  endCursor?: string
}

function messageRecord(message: unknown): Record<string, unknown> | undefined {
  return typeof message === 'object' && message !== null
    ? (message as Record<string, unknown>)
    : undefined
}

function compactText(part: Record<string, unknown>): unknown {
  return { type: 'text', text: part.text }
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

const PART_COMPACTERS: Record<string, (part: Record<string, unknown>) => unknown> = {
  text: compactText,
  tool: compactTool
}

function compactPart(part: unknown): unknown[] {
  const item = messageRecord(part)
  if (item === undefined) {
    return []
  }

  if (typeof item.type !== 'string') {
    return []
  }

  const compacter = PART_COMPACTERS[item.type]
  if (compacter === undefined) {
    return []
  }

  return [compacter(item)]
}

function compactAssistant(message: Record<string, unknown>): unknown {
  const content = Array.isArray(message.content) ? message.content : []
  return {
    type: 'assistant',
    content: content.flatMap((part) => compactPart(part))
  }
}

function compactUser(item: Record<string, unknown>): unknown | undefined {
  const text = typeof item.text === 'string' ? item.text : ''
  return CONTROL.test(text) ? undefined : { type: 'user', text, files: item.files }
}

function compactShell(item: Record<string, unknown>): unknown {
  return { type: 'shell', status: item.status, exit: item.exit }
}

const MESSAGE_COMPACTERS: Record<
  string,
  (message: Record<string, unknown>) => unknown | undefined
> = {
  user: compactUser,
  assistant: compactAssistant,
  shell: compactShell
}

function compactMessage(message: unknown): unknown | undefined {
  const item = messageRecord(message)
  if (item === undefined) {
    return undefined
  }

  if (typeof item.type !== 'string') {
    return undefined
  }

  const compacter = MESSAGE_COMPACTERS[item.type]
  if (compacter === undefined) {
    return undefined
  }

  return compacter(item)
}

function hasCollectedPath(key: string, item: unknown, output: Set<string>): boolean {
  if (typeof item !== 'string') {
    return false
  }

  if (!PATH_KEYS.has(key)) {
    return false
  }

  output.add(item)
  return true
}

function collectPathEntry(key: string, item: unknown, output: Set<string>): void {
  if (hasCollectedPath(key, item, output)) {
    return
  }

  if (item === undefined) {
    return
  }

  if (NESTED_KEYS.has(key)) {
    collectAuthorizedPaths(item, output)
  }
}

function collectPathFields(value: Record<string, unknown>, output: Set<string>): void {
  for (const [key, item] of Object.entries(value)) {
    collectPathEntry(key, item, output)
  }
}

function collectAuthorizedPaths(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAuthorizedPaths(item, output)
    }

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
  const found =
    startAfter === undefined
      ? -1
      : messages.findIndex((message) => messageId(message) === startAfter)
  const start = startAfter === undefined ? 0 : Math.max(0, found + 1)
  const selected = messages.slice(start)
  const records = selected.flatMap((message) => {
    const compacted = compactMessage(message)
    return compacted === undefined ? [] : [compacted]
  })
  const authorized = new Set<string>()
  for (const record of records) {
    collectAuthorizedPaths(record, authorized)
  }

  return {
    records,
    omitted: 0,
    authorizedPaths: [...authorized].toSorted((left, right) => left.localeCompare(right)),
    endCursor: messageId(selected.at(-1))
  }
}

export function packetBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength
}

function boundedEvidence(evidence: Evidence, keep: number): Evidence {
  const omitted = evidence.records.length - keep
  return {
    ...evidence,
    records: evidence.records.slice(omitted),
    omitted: evidence.omitted + omitted
  }
}

function fitEvidence(
  evidence: Evidence,
  ownedSkills: unknown[],
  candidates: Candidate[],
  maxBytes: number
): Evidence | undefined {
  const counts = Array.from(
    { length: evidence.records.length + 1 },
    (_, index) => evidence.records.length - index
  )
  return counts
    .map((count) => boundedEvidence(evidence, count))
    .find(
      (bounded) =>
        packetBytes({ evidence: bounded, ownedSkills, candidates: candidatePacket(candidates) }) <=
        maxBytes
    )
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
    .map((candidates) => ({
      candidates,
      evidence: fitEvidence(evidence, ownedSkills, candidates, maxBytes)
    }))
    .find((item) => item.evidence !== undefined)
  if (match?.evidence === undefined) {
    throw new Error('review packet exceeds model input limit')
  }

  return { evidence: match.evidence, candidates: match.candidates }
}
