import type { SessionContext } from '@opencode-ai/plugin/promise/session'
import { isExplicitCorrection } from './scoring.ts'
import { isRecord, sha256, trimText } from './shared.ts'
import type { ContextTailItem, ExperienceState, SessionHistory, UnknownRecord } from './types.ts'

function extractText(value: unknown, depth = 0): string {
  if (isUnextractableText(value, depth)) {
    return ''
  }

  return typeof value === 'string' ? value : extractStructuredText(value, depth)
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

  return ''
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

  return value.value
}

function extractToolCallText(value: unknown, depth: number): string | undefined {
  return value === null || value === undefined ? undefined : extractText(value, depth + 1)
}

function normalizeContextMessages(messages: SessionContext['messages']): ContextTailItem[] {
  let previousRole: string | undefined
  const normalized: ContextTailItem[] = []
  for (const message of messages) {
    const { role } = message
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

function updateExperienceGoal(
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

function recordContextCorrections(exp: ExperienceState, users: ContextTailItem[]): void {
  for (const item of users) {
    recordContextCorrection(exp, item)
  }

  exp.corrections = exp.corrections.slice(-12)
}

export function observeContext(
  exp: ExperienceState,
  event: SessionContext,
  history: Map<string, SessionHistory>
): void {
  exp.updatedAt = Date.now()
  const tail = normalizeContextMessages(event.messages).slice(-8)
  exp.contextTail = tail
  const users = tail.filter((item) => item.role === 'user')
  updateExperienceGoal(exp, event.sessionID, users, history)
  recordContextCorrections(exp, users)
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
