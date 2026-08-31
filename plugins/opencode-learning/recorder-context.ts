import { isExplicitCorrection } from './scoring.ts'
import { isRecord, sha256, trimText } from './shared.ts'
import type { ContextEvent } from './sdk.ts'
import type { ContextTailItem, ExperienceState, SessionHistory, UnknownRecord } from './types.ts'

export function extractText(value: unknown, depth = 0): string {
  if (isUnextractableText(value, depth)) {
    return ''
  }

  return scalarText(value) ?? extractStructuredText(value, depth)
}

function scalarText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function extractStructuredText(value: unknown, depth: number): string {
  if (Array.isArray(value)) {
    return extractTextArray(value, depth)
  }

  if (!isRecord(value)) {
    return ''
  }

  return extractRecordText(value, depth)
}

function isUnextractableText(value: unknown, depth: number): boolean {
  return value === null || value === undefined || depth > 8
}

function extractTextArray(value: unknown[], depth: number): string {
  return value
    .map((item) => extractText(item, depth + 1))
    .filter(Boolean)
    .join('\n')
}

function extractRecordText(value: UnknownRecord, depth: number): string {
  const typed = extractTypedText(value, depth)
  if (typed !== undefined) {
    return typed
  }

  if (Array.isArray(value.content)) {
    return extractText(value.content, depth + 1)
  }

  return extractRecordTextFallback(value, depth)
}

function extractTypedText(value: UnknownRecord, depth: number): string | undefined {
  const { type } = value
  if (typeof type !== 'string') {
    return undefined
  }

  const directText = extractDirectTypedText(value, type)
  if (directText !== undefined) {
    return directText
  }

  return nestedTypedText(value, type, depth)
}

function nestedTypedText(value: UnknownRecord, type: string, depth: number): string | undefined {
  if (type === 'tool-result') {
    return extractToolResultText(value.result, depth)
  }

  if (type === 'tool-call') {
    return extractToolCallText(value.input, depth)
  }

  return undefined
}

function extractDirectTypedText(value: UnknownRecord, type: string): string | undefined {
  return (type === 'text' || type === 'reasoning') && typeof value.text === 'string'
    ? value.text
    : undefined
}

function extractToolResultText(value: unknown, depth: number): string | undefined {
  const resultValue = toolResultValue(value)
  if (resultValue === undefined) {
    return undefined
  }

  return typeof resultValue === 'string' ? resultValue : extractText(resultValue, depth + 1)
}

function toolResultValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return undefined
  }

  return value.value ?? undefined
}

function extractToolCallText(value: unknown, depth: number): string | undefined {
  return value === null || value === undefined ? undefined : extractText(value, depth + 1)
}

function extractRecordTextFallback(value: UnknownRecord, depth: number): string {
  return (
    ['text', 'content', 'message', 'output']
      .map((key) => fallbackText(value, key, depth))
      .find((text) => text.length > 0) ?? ''
  )
}

function fallbackText(value: UnknownRecord, key: string, depth: number): string {
  return Object.hasOwn(value, key) ? extractText(value[key], depth + 1) : ''
}

function messageRole(message: unknown): string | undefined {
  if (!isRecord(message) || typeof message.role !== 'string') {
    return undefined
  }

  return message.role
}

export function contextSessionId(event: ContextEvent): string {
  const context = event as unknown as { sessionID?: unknown }
  const sessionId = context.sessionID
  return typeof sessionId === 'string' ? sessionId : ''
}

export function contextMessages(event: ContextEvent): unknown[] {
  const context = event as unknown as { messages?: unknown }
  const { messages } = context
  return Array.isArray(messages) ? messages : []
}

export function normalizeContextMessages(messages: unknown[]): ContextTailItem[] {
  let previousRole: string | undefined
  const normalized: ContextTailItem[] = []
  for (const message of messages) {
    const role = messageRole(message)
    const text = trimText(extractText(message), 1800)
    if (text.length > 0) {
      normalized.push({
        role,
        text,
        followsAssistant: role === 'user' && previousRole === 'assistant'
      })
    }

    previousRole = role
  }

  return normalized
}

export function updateExperienceGoal(
  exp: ExperienceState,
  sessionID: string,
  users: ContextTailItem[],
  history: Map<string, SessionHistory>
): void {
  if (exp.goal.length > 0) {
    return
  }

  const lastUser = users.at(-1)
  if (lastUser === undefined) {
    return
  }

  exp.goal = lastUser.text
  const sessionHistory = history.get(sessionID)
  if (sessionHistory !== undefined) {
    sessionHistory.goal = exp.goal
  }
}

export function recordContextCorrections(exp: ExperienceState, users: ContextTailItem[]): void {
  for (const item of users) {
    recordContextCorrection(exp, item)
  }

  exp.corrections = exp.corrections.slice(-12)
}

function recordContextCorrection(exp: ExperienceState, item: ContextTailItem): void {
  const userFingerprint = item.text.slice(0, 1200)
  if (exp.seenUserMessages.has(userFingerprint)) {
    return
  }

  exp.seenUserMessages.add(userFingerprint)
  if (item.followsAssistant && isExplicitCorrection(item.text)) {
    exp.corrections.push(item.text)
    exp.correctionSignals.push({ turn: exp.turn, fingerprint: sha256(userFingerprint) })
  }
}
