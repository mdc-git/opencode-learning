import {
  extractText,
  normalizeContextMessages,
  recordContextCorrections,
  updateExperienceGoal
} from './recorder-context.ts'
import {
  appendToolCall,
  consumePendingTool,
  createToolCall,
  isNewTerminalEvent,
  observeToolCall,
  toolAfterTarget,
  toolBeforeTarget,
  toolStatus
} from './recorder-tools.ts'
import { SESSION_ID_KEY, trimText } from './shared.ts'
import type { ContextEvent, ToolAfterEvent, ToolBeforeEvent } from './sdk.ts'
import type { ExperienceState, ExperienceSnapshot, PendingTool, SessionHistory } from './types.ts'

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
    const target = toolBeforeTarget(event)
    if (target === undefined) {
      return
    }

    const tombstones = this.pendingToolTombstones.get(target.sessionId)
    if (tombstones?.has(target.key)) {
      return
    }

    this.pendingTools.set(target.key, {
      [SESSION_ID_KEY]: target.sessionId,
      callId: event.id,
      tool: target.tool ?? '',
      input: trimText(event.input, 2500),
      startedAt: Date.now()
    })
  }

  toolAfter(event: ToolAfterEvent): ExperienceState | undefined {
    const target = toolAfterTarget(event)
    if (target === undefined) {
      return undefined
    }

    const lookup = consumePendingTool(
      this.pendingTools,
      this.pendingToolTombstones.get(target.sessionId),
      target.key
    )
    if (lookup.isIgnored) {
      return undefined
    }

    const exp = this.get(target.sessionId)
    const status = toolStatus(event.status)
    const input = lookup.pending?.input ?? trimText(extractText(event.input), 2500)
    const record = createToolCall({
      event,
      turn: exp.turn,
      input,
      status,
      pending: lookup.pending
    })
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

    if (!isNewTerminalEvent(this.terminalEventIds, sessionID, eventID)) {
      return undefined
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
