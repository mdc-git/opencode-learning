import { interruptSession, type EventBus } from './events.ts'
import type { InternalMailbox } from './mailbox.ts'
import type { OpenCodeContext, SessionInfo } from './sdk.ts'
import type { Runtime } from './setup-types.ts'

type CleanupContext = {
  readonly ctx: OpenCodeContext
  readonly eventBus: EventBus
  readonly mailbox: InternalMailbox
  readonly runtimes: Map<string, Runtime>
  readonly sessionRuntimes: Map<string, Runtime>
  readonly sessionDirectories: Map<string, string>
  readonly sessionInfo: Map<string, SessionInfo>
  readonly sessionEventChains: Map<string, Promise<void>>
  readonly sessionInfoGenerations: Map<string, number>
  curatorTimer: ReturnType<typeof setInterval> | undefined
  isSessionEventsStopped: boolean
  removeTerminalListener: (() => boolean) | undefined
  removeSessionMovedListener: (() => boolean) | undefined
}

async function cleanupRuntime(runtime: Runtime): Promise<void> {
  await runtime.ready
  await runtime.pipeline.cleanup()
}

export async function cleanupSetup(context: CleanupContext): Promise<void> {
  if (context.curatorTimer !== undefined) {
    clearInterval(context.curatorTimer)
  }

  context.removeTerminalListener?.()
  context.removeSessionMovedListener?.()
  context.isSessionEventsStopped = true
  await Promise.allSettled(context.sessionEventChains.values())
  context.sessionEventChains.clear()

  const runtimeCleanups = Array.from(context.runtimes.values(), cleanupRuntime)
  await Promise.allSettled(runtimeCleanups)
  context.mailbox.close()
  await Promise.allSettled(
    context.mailbox.sessionIds().map(async (sessionID) => interruptSession(context.ctx, sessionID))
  )
  context.mailbox.clear()
  await Promise.allSettled(
    Array.from(context.runtimes.values(), async (runtime) => {
      await runtime.ready
      await runtime.pipeline.waitForReviews()
    })
  )
  context.sessionRuntimes.clear()
  context.sessionDirectories.clear()
  context.sessionInfo.clear()
  context.sessionInfoGenerations.clear()
  for (const runtime of context.runtimes.values()) {
    runtime.recorder.clear()
  }

  context.runtimes.clear()
  await context.eventBus.dispose()
}
