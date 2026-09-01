import { EventBus } from './events.ts'
import { InternalMailbox } from './mailbox.ts'
import { ExperienceRecorder } from './recorder.ts'
import {
  canonicalDirectory,
  createRuntime,
  runCuratorWhenReady,
  type Runtime
} from './setup-runtime.ts'
import { registerAgents } from './setup-agents.ts'
import { registerCommands } from './setup-commands.ts'
import { isLearningTool, registerTools } from './setup-tools.ts'
import { clearReviewState, createReviewState } from './review-state.ts'
import { SESSION_ID_KEY } from './shared.ts'
import { skillIdForEvent } from './recorder-tools.ts'
import { interruptSession } from './review-sessions.ts'
import type { OpenCodeContext, SessionInfo, SessionMovedEvent, TerminalEvent } from './sdk.ts'
import type { LearningConfig } from './types.ts'

export class LearningSetup {
  readonly ctx: OpenCodeContext
  readonly config: LearningConfig
  readonly mailbox = new InternalMailbox()
  readonly eventBus: EventBus
  readonly recorder: ExperienceRecorder
  readonly reviewState = createReviewState()
  readonly runtimes = new Map<string, Runtime>()
  readonly sessionRuntimes = new Map<string, Runtime>()
  readonly sessionInfo = new Map<string, SessionInfo>()
  readonly sessionEventChains = new Map<string, Promise<void>>()
  isSessionEventsStopped = false
  curatorTimer: ReturnType<typeof setInterval> | undefined
  removeTerminalListener: (() => boolean) | undefined
  removeSessionMovedListener: (() => boolean) | undefined
  readonly sessionInfoGenerations = new Map<string, number>()

  constructor(ctx: OpenCodeContext, config: LearningConfig) {
    this.ctx = ctx
    this.config = config
    this.recorder = new ExperienceRecorder({ maxEventsPerSession: config.maxEventsPerSession })
    this.eventBus = new EventBus(ctx)
  }

  async setup(): Promise<() => Promise<void>> {
    await registerAgents(this.ctx, this.config)
    await registerTools(this.ctx, {
      config: this.config,
      mailbox: this.mailbox,
      runtimeForSession: this.runtimeForSession.bind(this),
      foregroundSessionFor: this.foregroundSessionFor.bind(this)
    })
    await registerCommands(this.ctx)
    this.removeTerminalListener = this.eventBus.onTerminal((event) => {
      void this.handleTerminal(event).catch((error: unknown) => {
        console.error('[opencode-learning] terminal event routing failed', error)
      })
    })
    this.removeSessionMovedListener = this.eventBus.onSessionMoved((event) => {
      void this.handleSessionMoved(event).catch((error: unknown) => {
        console.error('[opencode-learning] session move routing failed', error)
      })
    })
    this.eventBus.start()
    await this.registerContextHook()
    await this.registerToolBeforeHook()
    await this.registerToolAfterHook()
    this.startCuratorTimer()
    return this.cleanup.bind(this)
  }

  async registerContextHook(): Promise<void> {
    await this.ctx.session.hook('context', async (event) => {
      await this.enqueueSessionEvent(event.sessionID, async () => {
        const session = await this.foregroundSessionFor(event.sessionID)
        if (session === undefined) {
          return
        }

        const runtime = await this.runtimeForSession(event.sessionID, session)
        runtime.recorder.observeContext(event)
      })
    })
  }

  async registerToolBeforeHook(): Promise<void> {
    await this.ctx.tool.hook('execute.before', async (event) => {
      if (isLearningTool(event.tool)) {
        return
      }

      await this.enqueueSessionEvent(event.sessionID, async () => {
        const session = await this.foregroundSessionFor(event.sessionID)
        if (session === undefined) {
          return
        }

        const runtime = await this.runtimeForSession(event.sessionID, session)
        runtime.recorder.toolBefore(event)
      })
    })
  }

  async registerToolAfterHook(): Promise<void> {
    await this.ctx.tool.hook('execute.after', async (event) => {
      if (isLearningTool(event.tool)) {
        return
      }

      await this.enqueueSessionEvent(event.sessionID, async () => {
        const session = await this.foregroundSessionFor(event.sessionID)
        if (session === undefined) {
          return
        }

        const runtime = await this.runtimeForSession(event.sessionID, session)
        if (runtime.recorder.toolAfter(event) !== undefined) {
          const skillId = skillIdForEvent(event)
          if (skillId !== undefined) {
            void runtime.telemetry.recordUse(skillId).catch(console.error)
          }
        }
      })
    })
  }

  async enqueueSessionEvent(sessionID: string, task: () => Promise<void> | void): Promise<void> {
    if (this.isSessionEventsStopped) {
      return
    }

    const previous = this.sessionEventChains.get(sessionID) ?? Promise.resolve()
    const next = previous
      .catch((error: unknown) => {
        console.error('[opencode-learning] session event failed', error)
      })
      .then(task)
    this.sessionEventChains.set(sessionID, next)
    const clear = () => {
      if (this.sessionEventChains.get(sessionID) === next) {
        this.sessionEventChains.delete(sessionID)
      }
    }

    void next.then(clear).catch(clear)
    await next
  }

  async sessionInfoFor(sessionID: string): Promise<SessionInfo> {
    const cached = this.sessionInfo.get(sessionID)
    if (cached !== undefined) {
      return cached
    }

    const generation = this.sessionInfoGenerations.get(sessionID)
    const session = await this.ctx.session.get({ [SESSION_ID_KEY]: sessionID })
    if (generation !== this.sessionInfoGenerations.get(sessionID)) {
      return this.sessionInfoFor(sessionID)
    }

    this.sessionInfo.set(sessionID, session)
    return session
  }

  async foregroundSessionFor(sessionID: string): Promise<SessionInfo | undefined> {
    if (this.mailbox.isInternalSession(sessionID)) {
      return undefined
    }

    const session = await this.sessionInfoFor(sessionID)
    return session.parentID === undefined || session.parentID.length === 0 ? session : undefined
  }

  async runtimeForSession(sessionID: string, session?: SessionInfo): Promise<Runtime> {
    const existing = this.sessionRuntimes.get(sessionID)
    if (existing !== undefined) {
      await existing.ready
      await existing.pipeline.claimSession(sessionID, true)
      return existing
    }

    session ??= await this.sessionInfoFor(sessionID)
    const directory = await canonicalDirectory(session.location.directory)
    let runtime = this.runtimes.get(directory)
    if (runtime === undefined) {
      runtime = createRuntime({
        ctx: this.ctx,
        directory,
        config: this.config,
        mailbox: this.mailbox,
        recorder: this.recorder,
        reviewState: this.reviewState
      })
      this.runtimes.set(directory, runtime)
    }

    this.sessionRuntimes.set(sessionID, runtime)
    await runtime.ready
    await runtime.pipeline.claimSession(sessionID, true)
    return runtime
  }

  async handleTerminal(event: TerminalEvent): Promise<void> {
    const { sessionID: sessionId } = event.data
    await this.enqueueSessionEvent(sessionId, async () => {
      const runtime = await this.runtimeForTerminal(event)
      if (runtime === undefined) {
        return
      }

      await runtime.ready
      const experience = runtime.recorder.finishTurn(sessionId, event.type, event.id)
      if (experience !== undefined) {
        runtime.pipeline.executionFinished(sessionId, event.type)
      }
    })
  }

  async handleSessionMoved(event: SessionMovedEvent): Promise<void> {
    const { sessionID: sessionId } = event.data
    await this.enqueueSessionEvent(sessionId, async () => {
      this.reviewState.owners.get(sessionId)?.invalidateSession(sessionId)
      this.sessionInfoGenerations.set(
        sessionId,
        (this.sessionInfoGenerations.get(sessionId) ?? 0) + 1
      )
      this.sessionInfo.delete(sessionId)
      this.sessionRuntimes.delete(sessionId)
    })
  }

  async runtimeForTerminal(event: TerminalEvent): Promise<Runtime | undefined> {
    const { sessionID: sessionId } = event.data
    const session = await this.foregroundSessionFor(sessionId)
    if (session === undefined) {
      return undefined
    }

    const directory =
      event.location === undefined ? session.location.directory : event.location.directory
    const canonical = await canonicalDirectory(directory)
    const runtime = this.runtimes.get(canonical)
    if (runtime !== undefined) {
      this.sessionRuntimes.set(sessionId, runtime)
      await runtime.ready
      await runtime.pipeline.claimSession(sessionId, true)
      return runtime
    }

    return this.runtimeForSession(sessionId, session)
  }

  startCuratorTimer(): void {
    this.curatorTimer = setInterval(
      () => {
        for (const runtime of this.runtimes.values()) {
          runCuratorWhenReady(runtime, this.ctx.skill.reload)
        }
      },
      Math.max(1, this.config.curator.checkEveryHours) * 36e5
    )
    this.curatorTimer.unref?.()
  }

  async cleanup(): Promise<void> {
    clearInterval(this.curatorTimer)
    this.removeTerminalListener?.()
    this.removeSessionMovedListener?.()
    this.isSessionEventsStopped = true
    await Promise.allSettled(this.sessionEventChains.values())
    this.sessionEventChains.clear()
    await Promise.allSettled(
      Array.from(this.runtimes.values(), async (runtime) => {
        await runtime.ready
        runtime.pipeline.cleanup()
      })
    )
    this.mailbox.close()
    await Promise.allSettled(
      this.mailbox.sessionIds().map(async (sessionID) => interruptSession(this.ctx, sessionID))
    )
    this.mailbox.clear()
    await Promise.allSettled(
      Array.from(this.runtimes.values(), async (runtime) => {
        await runtime.ready
        await runtime.pipeline.waitForReviews()
      })
    )
    this.sessionRuntimes.clear()
    this.sessionInfo.clear()
    this.recorder.clear()
    clearReviewState(this.reviewState)
    this.runtimes.clear()
    await this.eventBus.dispose()
  }
}
