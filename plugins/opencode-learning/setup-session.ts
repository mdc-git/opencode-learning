import type { InternalMailbox } from './mailbox.ts'
import { isRecord } from './shared.ts'
import type { SessionInfo } from './sdk.ts'

export function runtimeSkillId(event: { tool: string; input: unknown }): string | undefined {
  if (event.tool !== 'skill' || !isRecord(event.input)) {
    return undefined
  }

  return [event.input.name, event.input.id, event.input.skill].find(
    (value): value is string => typeof value === 'string'
  )
}

export function isSessionEventUnavailable(
  sessionID: string | undefined,
  isStopped: boolean
): sessionID is undefined {
  return sessionID === undefined || sessionID.length === 0 || isStopped
}

export async function enqueueEvent(
  chains: Map<string, Promise<void>>,
  sessionID: string,
  task: () => Promise<void> | void
): Promise<void> {
  const previous = chains.get(sessionID) ?? Promise.resolve()
  const next = previous
    .catch((error: unknown) => {
      console.error('[opencode-learning] session event failed', error)
    })
    .then(task)
  chains.set(sessionID, next)
  const clear = () => {
    if (chains.get(sessionID) === next) {
      chains.delete(sessionID)
    }
  }

  void next.then(clear).catch(clear)

  await next
}

export function sessionInfoGeneration(generations: Map<string, number>, sessionID: string): number {
  return generations.get(sessionID) ?? 0
}

export function isSessionInfoStale(
  generations: Map<string, number>,
  sessionID: string,
  generation: number
): boolean {
  return generation !== sessionInfoGeneration(generations, sessionID)
}

export function isUnavailableForegroundSession(
  sessionID: string | undefined,
  mailbox: InternalMailbox
): sessionID is undefined {
  return sessionID === undefined || sessionID.length === 0 || mailbox.isInternalSession(sessionID)
}

export function isRootSession(session: SessionInfo): boolean {
  return session.parentID === undefined || session.parentID.length === 0
}
