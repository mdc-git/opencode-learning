import { Buffer } from 'node:buffer'
import { candidatePacket, catalog, selectCandidates, type Candidate } from './candidates.ts'
import { compactMessages, record } from './evidence-records.ts'
import type { PendingProposal } from './proposal.ts'

export type Evidence = {
  records: unknown[]
  omitted: number
  authorizedPaths: string[]
  freshStart: number
  skipped: number
  deferred: number
  endCursor?: string
}

type ReviewCatalog = { all: Candidate[]; pending: PendingProposal[] }
type EvidenceOptions = { startAfter?: string; lookbackTurns?: number }
type Turn = { messages: readonly unknown[]; cursor?: string; complete: boolean }
type FreshBatch = { evidence: Evidence; messages: unknown[] }

function messageId(message: unknown): string | undefined {
  const id = record(message)?.id
  return typeof id === 'string' ? id : undefined
}

function indexAfterCursor(messages: readonly unknown[], cursor?: string): number {
  const found = messages.findIndex((message) => messageId(message) === cursor)
  return cursor === undefined ? 0 : found + 1
}

function userIndexes(messages: readonly unknown[]): number[] {
  return messages.flatMap((message, index) => (record(message)?.type === 'user' ? [index] : []))
}

function turns(messages: readonly unknown[]): Turn[] {
  const boundaries = [...new Set([0, ...userIndexes(messages), messages.length])]
  return boundaries.slice(0, -1).map((start, index) => {
    const batch = messages.slice(start, boundaries[index + 1])
    return {
      messages: batch,
      cursor: messageId(batch.at(-1)),
      complete: index < boundaries.length - 2 || isTurnComplete(batch)
    }
  })
}

function isTurnComplete(messages: readonly unknown[]): boolean {
  const terminal = messages.findLast((message) =>
    ['assistant', 'shell', 'user'].includes(String(record(message)?.type))
  )
  const item = record(terminal) ?? {}
  return [
    'stop',
    'length',
    'content-filter',
    'error',
    'unknown',
    'exited',
    'timeout',
    'killed'
  ].includes(String(item.finish ?? item.status))
}

export function packetBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

export function pendingCatalog(pending: PendingProposal[]) {
  return pending.map(({ skillId, kind, reason }) => ({ skillId, kind, reason }))
}

function packet(evidence: Evidence, skills: ReviewCatalog, candidates: Candidate[]) {
  return {
    evidence,
    ownedSkills: catalog(skills.all),
    pendingSkills: pendingCatalog(skills.pending),
    candidates: candidatePacket(candidates)
  }
}

function evidenceFor(context: readonly unknown[], fresh: readonly unknown[]): Evidence {
  const overlap = compactMessages(context)
  const captured = compactMessages(fresh)
  return {
    records: [...overlap.records, ...captured.records],
    omitted: 0,
    authorizedPaths: [...new Set([...overlap.authorizedPaths, ...captured.authorizedPaths])],
    freshStart: overlap.records.length,
    skipped: 0,
    deferred: 0,
    endCursor: messageId(fresh.at(-1))
  }
}

function didAppendTurn(
  batch: FreshBatch,
  turn: Turn,
  skills: ReviewCatalog,
  maxBytes: number
): boolean {
  if (!turn.complete) {
    return false
  }

  const next = evidenceFor([], [...batch.messages, ...turn.messages])
  next.skipped = batch.evidence.skipped
  next.deferred = batch.evidence.deferred - 1
  if (packetBytes(packet(next, skills, [])) <= maxBytes) {
    batch.messages = [...batch.messages, ...turn.messages]
    batch.evidence = next
    return true
  }

  if (batch.messages.length > 0) {
    return false
  }

  batch.evidence = {
    ...batch.evidence,
    skipped: batch.evidence.skipped + 1,
    deferred: next.deferred,
    endCursor: turn.cursor
  }
  return true
}

function freshBatch(
  fresh: readonly unknown[],
  skills: ReviewCatalog,
  maxBytes: number
): FreshBatch {
  const batches = turns(fresh)
  const batch = { evidence: evidenceFor([], []), messages: [] as unknown[] }
  batch.evidence.deferred = batches.length
  for (const turn of batches) {
    if (!didAppendTurn(batch, turn, skills, maxBytes)) {
      break
    }
  }

  return batch
}

function fitContext(
  context: readonly unknown[],
  fresh: FreshBatch,
  skills: ReviewCatalog,
  maxBytes: number
) {
  const boundaries = [...new Set([0, ...userIndexes(context), context.length])]
  for (const start of boundaries) {
    const evidence = {
      ...evidenceFor(context.slice(start), fresh.messages),
      skipped: fresh.evidence.skipped,
      deferred: fresh.evidence.deferred,
      endCursor: fresh.evidence.endCursor,
      omitted: compactMessages(context.slice(0, start)).records.length
    }
    const candidates = selectCandidates(skills.all, evidence)
    if (packetBytes(packet(evidence, skills, candidates)) <= maxBytes) {
      return { evidence, candidates }
    }
  }

  const candidates = selectCandidates(skills.all, fresh.evidence)
  while (packetBytes(packet(fresh.evidence, skills, candidates)) > maxBytes) {
    candidates.pop()
  }

  return { evidence: fresh.evidence, candidates }
}

function contextStart(previous: readonly unknown[], lookback = 0): number {
  return lookback > 0 ? (userIndexes(previous).at(-lookback) ?? 0) : previous.length
}

export function boundPacket(
  messages: readonly unknown[],
  skills: ReviewCatalog,
  options: EvidenceOptions,
  maxBytes: number
): { evidence: Evidence; candidates: Candidate[] } {
  if (packetBytes(packet(evidenceFor([], []), skills, [])) > maxBytes) {
    throw new Error('skill catalogs exceed model input limit')
  }

  const fresh = indexAfterCursor(messages, options.startAfter)
  const previous = messages.slice(0, fresh)
  const start = contextStart(previous, options.lookbackTurns)
  const batch = freshBatch(messages.slice(fresh), skills, maxBytes)
  if (batch.messages.length === 0) {
    return { evidence: batch.evidence, candidates: [] }
  }

  return fitContext(messages.slice(start, fresh), batch, skills, maxBytes)
}
