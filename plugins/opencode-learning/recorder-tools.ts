import { classifyToolCall } from './scoring.ts'
import { extractText } from './recorder-context.ts'
import { hasCallId, isRecord, SESSION_ID_KEY, trimText } from './shared.ts'
import type { ToolAfterEvent, ToolBeforeEvent } from './sdk.ts'
import type { ExperienceState, PendingTool, ToolCall } from './types.ts'

function toolEventKey(event: { sessionID?: string; id?: string }): string | undefined {
  if (event.sessionID === undefined || event.sessionID.length === 0 || !hasCallId(event.id)) {
    return undefined
  }

  return `${event.sessionID}:${event.id}`
}

function toolResult(event: ToolAfterEvent): unknown {
  return event.status === 'error' ? event.error : event.result
}

export function createToolCall({
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
    result: trimText(toolResult(event), 3e3),
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

export function skillIdForEvent(event: { tool?: string; input: unknown }): string | undefined {
  if (event.tool !== 'skill' || !isRecord(event.input)) {
    return undefined
  }

  return [event.input.name, event.input.id, event.input.skill].find(
    (value): value is string => typeof value === 'string'
  )
}

function isRecovery(exp: ExperienceState, record: ToolCall): boolean {
  const previous = exp.toolCalls.at(-2)
  return (
    previous?.status === 'error' && record.status === 'success' && previous.tool === record.tool
  )
}

type ToolTarget = { key: string; sessionId: string; tool?: string }

export function toolBeforeTarget(event: ToolBeforeEvent): ToolTarget | undefined {
  if (nonEmptyToolName(event.tool) === undefined) {
    return undefined
  }

  return toolTarget(event, toolEventKey(event))
}

function nonEmptyToolName(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function toolTarget(
  event: { sessionID?: string; tool?: string },
  key: string | undefined
): ToolTarget | undefined {
  if (key === undefined || event.sessionID === undefined) {
    return undefined
  }

  return { key, sessionId: event.sessionID, tool: event.tool }
}

export function toolAfterTarget(event: ToolAfterEvent): ToolTarget | undefined {
  return toolTarget(event, toolEventKey(event))
}

type PendingToolLookup = { pending: PendingTool | undefined; isIgnored: boolean }

export function consumePendingTool(
  pendingTools: Map<string, PendingTool>,
  tombstones: Set<string> | undefined,
  key: string
): PendingToolLookup {
  const pending = pendingTools.get(key)
  if (pending !== undefined) {
    pendingTools.delete(key)
    return { pending, isIgnored: false }
  }

  return { pending: undefined, isIgnored: tombstones?.has(key) ?? false }
}

export function pendingToolInput(lookup: PendingToolLookup, event: ToolAfterEvent): string {
  return lookup.pending?.input ?? trimText(extractText(event.input), 2500)
}

export function pendingKeysForSession(
  pendingTools: Map<string, PendingTool>,
  sessionID: string
): string[] {
  const keys: string[] = []
  for (const [key, pending] of pendingTools) {
    if (pending.sessionID === sessionID) {
      keys.push(key)
    }
  }

  return keys
}

export function isNewTerminalEvent(
  terminalEventIds: Map<string, Set<string>>,
  sessionID: string,
  eventID: string | undefined
): boolean {
  if (!isTerminalEventId(eventID)) {
    return true
  }

  const seen = terminalEventIds.get(sessionID)
  if (seen?.has(eventID)) {
    return false
  }

  return hasRecordedTerminalEvent(terminalEventIds, sessionID, seen, eventID)
}

function isTerminalEventId(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0
}

function hasRecordedTerminalEvent(
  terminalEventIds: Map<string, Set<string>>,
  sessionID: string,
  seen: Set<string> | undefined,
  eventID: string
): boolean {
  const next = seen ?? new Set<string>()
  next.add(eventID)
  terminalEventIds.set(sessionID, next)
  return true
}

export function toolStatus(status: unknown): ToolCall['status'] {
  if (status === 'completed' || status === 'success') {
    return 'success'
  }

  return status === 'error' ? 'error' : 'unknown'
}
