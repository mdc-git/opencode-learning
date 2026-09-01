import type { SessionContext } from '@opencode-ai/plugin/promise/session'
import { observeContext } from './recorder-context.ts'
import {
  appendToolCall,
  consumePendingTool,
  createToolCall,
  isNewTerminalEvent,
  observeToolCall,
  pendingKeysForSession,
  toolTarget
} from './recorder-tools.ts'
import { SESSION_ID_KEY, trimText } from './shared.ts'
import type { ToolAfterEvent, ToolBeforeEvent } from './sdk.ts'
import type { ExperienceState, ExperienceSnapshot, PendingTool, SessionHistory } from './types.ts'

export class ExperienceRecorder {
  private readonly maxEventsPerSession: number
  private readonly sessions = new Map<string, ExperienceState>()
  private readonly history = new Map<string, SessionHistory>()
  private readonly pendingTools = new Map<string, PendingTool[]>()
  private readonly pendingToolTombstones = new Map<string, Set<string>>()
  private readonly terminalEventIds = new Map<string, Set<string>>()

  constructor({ maxEventsPerSession = 120 }: { maxEventsPerSession?: number } = {}) {
    this.maxEventsPerSession = maxEventsPerSession
  }

  private pendingTombstonesFor(sessionID: string): Set<string> {
    const existing = this.pendingToolTombstones.get(sessionID)
    if (existing !== undefined) {
      return existing
    }

    const created = new Set<string>()
    this.pendingToolTombstones.set(sessionID, created)
    return created
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

  observeContext(event: SessionContext): void {
    const exp = this.get(event.sessionID)
    observeContext(exp, event, this.history)
  }

  toolBefore(event: ToolBeforeEvent): void {
    const target = toolTarget(event)
    const tombstones = this.pendingToolTombstones.get(target.sessionId) ?? new Set<string>()
    if (tombstones.has(target.key)) {
      return
    }

    const pending = this.pendingTools.get(target.key)
    const current = {
      [SESSION_ID_KEY]: target.sessionId,
      tool: event.tool,
      input: trimText(event.input, 2500),
      startedAt: Date.now()
    }
    if (pending === undefined) {
      this.pendingTools.set(target.key, [current])
      return
    }

    pending.push(current)
  }

  toolAfter(event: ToolAfterEvent): ExperienceState | undefined {
    const target = toolTarget(event)
    const input = trimText(event.input, 2500)
    const pending = consumePendingTool(this.pendingTools, target.key, event.tool, input)
    if (
      pending === undefined &&
      this.pendingToolTombstones.get(target.sessionId)?.has(target.key) === true
    ) {
      return undefined
    }

    const exp = this.get(target.sessionId)
    const record = createToolCall({
      event,
      turn: exp.turn,
      input,
      pending
    })
    appendToolCall(exp, record, this.maxEventsPerSession)
    exp.updatedAt = Date.now()
    observeToolCall(exp, event, record)

    return exp
  }

  finishTurn(
    sessionID: string,
    terminalType: string,
    eventID: string
  ): ExperienceSnapshot | undefined {
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

  clear(): void {
    this.sessions.clear()
    this.history.clear()
    this.pendingTools.clear()
    this.pendingToolTombstones.clear()
    this.terminalEventIds.clear()
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
    const keys = pendingKeysForSession(this.pendingTools, sessionID)
    if (keys.length === 0) {
      return
    }

    const tombstones = this.pendingTombstonesFor(sessionID)
    for (const key of keys) {
      this.pendingTools.delete(key)
      tombstones.add(key)
    }
  }
}
