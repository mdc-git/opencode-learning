import { isExplicitCorrection, classifyToolCall } from './scoring.ts'
import { hasCallId, isRecord, SESSION_ID_KEY, sha256, trimText } from './shared.ts'
import type {
  ContextEvent,
  ContextTailItem,
  ExperienceState,
  ExperienceSnapshot,
  PendingTool,
  SessionHistory,
  ToolAfterEvent,
  ToolBeforeEvent,
  ToolCall,
  UnknownRecord
} from './types.ts'

function extractText(value: unknown, depth = 0): string {
  if (value === null || value === undefined || depth > 8) {
    return ''
  }

  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return extractTextArray(value, depth)
  }

  if (!isRecord(value)) {
    return ''
  }

  return extractRecordText(value, depth)
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

  if ((type === 'text' || type === 'reasoning') && typeof value.text === 'string') {
    return value.text
  }

  if (type === 'tool-result') {
    return extractToolResultText(value.result, depth)
  }

  if (type === 'tool-call') {
    return extractToolCallText(value.input, depth)
  }

  return undefined
}

function extractToolResultText(value: unknown, depth: number): string | undefined {
  if (!isRecord(value) || value.value === null || value.value === undefined) {
    return undefined
  }

  const { value: resultValue } = value
  return typeof resultValue === 'string' ? resultValue : extractText(resultValue, depth + 1)
}

function extractToolCallText(value: unknown, depth: number): string | undefined {
  return value === null || value === undefined ? undefined : extractText(value, depth + 1)
}

function extractRecordTextFallback(value: UnknownRecord, depth: number): string {
  for (const key of ['text', 'content', 'message', 'output']) {
    if (!Object.hasOwn(value, key)) {
      continue
    }

    const text = extractText(value[key], depth + 1)
    if (text.length > 0) {
      return text
    }
  }

  return ''
}

function messageRole(message: unknown): string | undefined {
  if (!isRecord(message) || typeof message.role !== 'string') {
    return undefined
  }

  return message.role
}

function normalizeContextMessages(messages: unknown[]): ContextTailItem[] {
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
    const userFingerprint = item.text.slice(0, 1200)
    if (exp.seenUserMessages.has(userFingerprint)) {
      continue
    }

    exp.seenUserMessages.add(userFingerprint)
    if (item.followsAssistant && isExplicitCorrection(item.text)) {
      exp.corrections.push(item.text)
      exp.correctionSignals.push({ turn: exp.turn, fingerprint: sha256(userFingerprint) })
    }
  }

  exp.corrections = exp.corrections.slice(-12)
}

function toolEventKey(event: { sessionID?: string; id?: string }): string | undefined {
  if (event.sessionID === undefined || event.sessionID.length === 0 || !hasCallId(event.id)) {
    return undefined
  }

  return `${event.sessionID}:${event.id}`
}

function createToolCall({
  event,
  turn,
  input,
  status,
  pending
}: {
  event: ToolAfterEvent
  turn: number
  input: string
  status: ToolCall['status']
  pending: PendingTool | undefined
}): ToolCall {
  return {
    tool: event.tool ?? '',
    turn,
    input,
    status,
    result: trimText(status === 'error' ? event.error : event.result, 3e3),
    durationMs: pending === undefined ? undefined : Date.now() - pending.startedAt,
    at: Date.now()
  }
}

function appendToolCall(exp: ExperienceState, record: ToolCall, maxEvents: number): void {
  exp.toolCalls.push(record)
  if (exp.toolCalls.length > maxEvents) {
    exp.toolCalls.shift()
  }
}

function observeToolCall(exp: ExperienceState, event: ToolAfterEvent, record: ToolCall): void {
  recordSkillUse(exp, event)
  if (isRecovery(exp, record)) {
    exp.recoveries += 1
  }

  if (classifyToolCall(record) === 'verify') {
    exp.verificationSteps += 1
  }
}

function recordSkillUse(exp: ExperienceState, event: ToolAfterEvent): void {
  if (event.tool !== 'skill' || !isRecord(event.input)) {
    return
  }

  const skillId = event.input.name ?? event.input.id ?? event.input.skill
  if (typeof skillId === 'string') {
    exp.skillsUsed.add(skillId)
  }
}

function isRecovery(exp: ExperienceState, record: ToolCall): boolean {
  const previous = exp.toolCalls.at(-2)
  return (
    previous?.status === 'error' && record.status === 'success' && previous.tool === record.tool
  )
}

export class ExperienceRecorder {
  private readonly maxEventsPerSession: number
  private readonly sessions = new Map<string, ExperienceState>()
  private readonly history = new Map<string, SessionHistory>()
  private readonly pendingTools = new Map<string, PendingTool>()
  private readonly pendingToolTombstones = new Map<string, Set<string>>()
  private readonly terminalEventIds = new Map<string, Set<string>>()

  constructor({ maxEventsPerSession = 120 }: { maxEventsPerSession?: number } = {}) {
    this.maxEventsPerSession = maxEventsPerSession
  }

  get(sessionID: string): ExperienceState {
    if (!this.sessions.has(sessionID)) {
      const history = this.history.get(sessionID) ?? { goal: '', seenUserMessages: new Set() }
      this.history.set(sessionID, history)
      this.sessions.set(sessionID, {
        [SESSION_ID_KEY]: sessionID,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        goal: history.goal,
        contextTail: [],
        corrections: [],
        correctionSignals: [],
        seenUserMessages: history.seenUserMessages,
        toolCalls: [],
        skillsUsed: new Set(),
        recoveries: 0,
        verificationSteps: 0,
        turn: 0,
        turns: []
      })
    }

    return this.sessions.get(sessionID)!
  }

  observeContext(event: ContextEvent): ExperienceState | undefined {
    const sessionId = event?.sessionID
    if (sessionId === undefined || sessionId.length === 0) {
      return undefined
    }

    const exp = this.get(sessionId)
    exp.updatedAt = Date.now()
    const messages = Array.isArray(event.messages) ? event.messages : []
    const tail = normalizeContextMessages(messages).slice(-8)
    exp.contextTail = tail
    const users = tail.filter((x) => x.role === 'user')
    updateExperienceGoal(exp, sessionId, users, this.history)
    recordContextCorrections(exp, users)
    return exp
  }

  toolBefore(event: ToolBeforeEvent): void {
    if (event.tool === undefined || event.tool.length === 0) {
      return
    }

    const key = toolEventKey(event)
    if (key === undefined || event.sessionID === undefined) {
      return
    }

    const tombstones = this.pendingToolTombstones.get(event.sessionID)
    if (tombstones?.has(key)) {
      return
    }

    this.pendingTools.set(key, {
      [SESSION_ID_KEY]: event.sessionID,
      callId: event.id!,
      tool: event.tool,
      input: trimText(event.input, 2500),
      startedAt: Date.now()
    })
  }

  toolAfter(event: ToolAfterEvent): ExperienceState | undefined {
    const key = toolEventKey(event)
    if (key === undefined || event.sessionID === undefined || event.tool === undefined) {
      return undefined
    }

    const pending = this.pendingTools.get(key)
    if (pending) {
      this.pendingTools.delete(key)
    } else {
      const tombstones = this.pendingToolTombstones.get(event.sessionID)
      if (tombstones?.has(key)) {
        return undefined
      }
    }

    const exp = this.get(event.sessionID)
    const status = toolStatus(event.status)
    const input = pending?.input ?? trimText(extractText(event.input), 2500)
    const record = createToolCall({ event, turn: exp.turn, input, status, pending })
    appendToolCall(exp, record, this.maxEventsPerSession)
    exp.updatedAt = Date.now()
    observeToolCall(exp, event, record)

    return exp
  }

  finishTurn(
    sessionID: string,
    terminalType: string,
    eventID?: string
  ): ExperienceSnapshot | undefined {
    if (sessionID.length === 0) {
      return undefined
    }

    if (eventID !== undefined && eventID !== null && eventID !== '') {
      let seen = this.terminalEventIds.get(sessionID)
      if (seen?.has(eventID)) {
        return undefined
      }

      seen ??= new Set()
      seen.add(eventID)
      this.terminalEventIds.set(sessionID, seen)
    }

    const exp = this.get(sessionID)
    exp.turns.push({
      turn: exp.turn,
      terminalType,
      succeeded: terminalType === 'session.execution.succeeded'
    })
    exp.turn += 1
    exp.updatedAt = Date.now()
    return this.snapshot(sessionID)
  }

  snapshot(sessionID: string): ExperienceSnapshot | undefined {
    const exp = this.sessions.get(sessionID)
    if (!exp) {
      return undefined
    }

    return {
      ...exp,
      skillsUsed: [...exp.skillsUsed],
      seenUserMessages: undefined,
      toolCalls: exp.toolCalls.map((x) => ({ ...x })),
      corrections: [...exp.corrections],
      correctionSignals: exp.correctionSignals.map((x) => ({ ...x })),
      turns: exp.turns.map((x) => ({ ...x })),
      contextTail: exp.contextTail.map((x) => ({ ...x }))
    }
  }

  clear(sessionID?: string): void {
    if (sessionID === undefined || sessionID.length === 0) {
      this.sessions.clear()
      this.history.clear()
      this.pendingTools.clear()
      this.pendingToolTombstones.clear()
      this.terminalEventIds.clear()
      return
    }

    this.sessions.delete(sessionID)
    this.history.delete(sessionID)
    this.terminalEventIds.delete(sessionID)
    this.pendingToolTombstones.delete(sessionID)
    for (const [key, pending] of this.pendingTools) {
      if (pending.sessionID === sessionID) {
        this.pendingTools.delete(key)
      }
    }
  }

  take(sessionID: string): ExperienceSnapshot | undefined {
    const snapshot = this.snapshot(sessionID)
    if (snapshot) {
      this.tombstonePendingTools(sessionID)
      this.sessions.delete(sessionID)
    }

    return snapshot
  }

  tombstonePendingTools(sessionID: string): void {
    let tombstones = this.pendingToolTombstones.get(sessionID)
    for (const [key, pending] of this.pendingTools) {
      if (pending.sessionID !== sessionID) {
        continue
      }

      this.pendingTools.delete(key)
      tombstones ??= new Set()
      tombstones.add(key)
    }

    if (tombstones === undefined || tombstones.size === 0) {
      return
    }

    this.pendingToolTombstones.set(sessionID, tombstones)
  }
}

function toolStatus(status: unknown): ToolCall['status'] {
  if (status === 'completed' || status === 'success') {
    return 'success'
  }

  return status === 'error' ? 'error' : 'unknown'
}
