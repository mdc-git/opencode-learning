import { classifyToolCall } from './scoring.ts'
import { isRecord, trimText } from './shared.ts'
import type { ToolAfterEvent } from './sdk.ts'
import type { ExperienceState, PendingTool, ToolCall } from './types.ts'

export function createToolCall({
  event,
  turn,
  input,
  pending
}: {
  event: ToolAfterEvent
  turn: number
  input: string
  pending: PendingTool | undefined
}): ToolCall {
  return {
    tool: event.tool,
    turn,
    input,
    status: event.status === 'completed' ? 'success' : 'error',
    result: trimText(event.status === 'error' ? event.error : event.result, 3e3),
    durationMs: pending === undefined ? undefined : Date.now() - pending.startedAt,
    at: Date.now()
  }
}

export function appendToolCall(exp: ExperienceState, record: ToolCall, maxEvents: number): void {
  exp.toolCalls.push(record)
  if (exp.toolCalls.length > maxEvents) {
    exp.toolCalls.shift()
  }
}

export function observeToolCall(
  exp: ExperienceState,
  event: ToolAfterEvent,
  record: ToolCall
): void {
  const skillId = skillIdForEvent(event)
  if (skillId !== undefined) {
    exp.skillsUsed.add(skillId)
  }

  if (isRecovery(exp, record)) {
    exp.recoveries += 1
  }

  if (classifyToolCall(record) === 'verify') {
    exp.verificationSteps += 1
  }
}

export function skillIdForEvent(event: { tool: string; input: unknown }): string | undefined {
  if (event.tool !== 'skill' || !isRecord(event.input)) {
    return undefined
  }

  return typeof event.input.id === 'string' ? event.input.id : undefined
}

function isRecovery(exp: ExperienceState, record: ToolCall): boolean {
  const previous = exp.toolCalls.at(-2)
  return (
    previous?.status === 'error' && record.status === 'success' && previous.tool === record.tool
  )
}

type ToolTarget = { key: string; sessionId: string }

export function toolTarget(event: { sessionID: string; id: string }): ToolTarget {
  return { key: `${event.sessionID}:${event.id}`, sessionId: event.sessionID }
}

export function consumePendingTool(
  pendingTools: Map<string, PendingTool[]>,
  key: string,
  tool: string,
  input: string
): PendingTool | undefined {
  const pending = pendingTools.get(key)
  if (pending === undefined) {
    return undefined
  }

  const index = pendingToolIndex(pending, tool, input)

  const current = pending.splice(index, 1)[0]
  if (pending.length === 0) {
    pendingTools.delete(key)
  }

  return current
}

function pendingToolIndex(pending: PendingTool[], tool: string, input: string): number {
  const exact = pending.findIndex((item) => item.tool === tool && item.input === input)
  if (exact !== -1) {
    return exact
  }

  const matchingTool = pending.findIndex((item) => item.tool === tool)
  return matchingTool === -1 ? 0 : matchingTool
}

export function pendingKeysForSession(
  pendingTools: Map<string, PendingTool[]>,
  sessionID: string
): string[] {
  const keys: string[] = []
  for (const [key, pending] of pendingTools) {
    if (pending.some((item) => item.sessionID === sessionID)) {
      keys.push(key)
    }
  }

  return keys
}

export function isNewTerminalEvent(
  terminalEventIds: Map<string, Set<string>>,
  sessionID: string,
  eventID: string
): boolean {
  const seen = terminalEventIds.get(sessionID)
  if (seen?.has(eventID)) {
    return false
  }

  const next = seen ?? new Set<string>()
  next.add(eventID)
  terminalEventIds.set(sessionID, next)
  return true
}
