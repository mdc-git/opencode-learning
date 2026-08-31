import { EventBus } from './events.ts'
import { InternalMailbox } from './mailbox.ts'
import { cleanupSetup } from './setup-cleanup.ts'
import { canonicalDirectory, createRuntime, terminalDirectory } from './setup-runtime.ts'
import { registerAgents } from './setup-agents.ts'
import { registerCommands } from './setup-commands.ts'
import { isLearningTool, registerTools } from './setup-tools.ts'
import { SESSION_ID_KEY } from './shared.ts'
import {
  enqueueEvent,
  isRootSession,
  isSessionEventUnavailable,
  isSessionInfoStale,
  isUnavailableForegroundSession,
  runtimeSkillId,
  sessionInfoGeneration
} from './setup-session.ts'
import type { OpenCodeContext, SessionInfo, SessionMovedEvent, TerminalEvent } from './sdk.ts'
import type { LearningConfig } from './types.ts'
import type { Runtime } from './setup-types.ts'

export class LearningSetup {
  readonly ctx: OpenCodeContext
  readonly config: LearningConfig
  readonly mailbox = new InternalMailbox()
  readonly eventBus: EventBus
  readonly runtimes = new Map<string, Runtime>()
  readonly sessionRuntimes = new Map<string, Runtime>()
  readonly sessionDirectories = new Map<string, string>()
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
    this.eventBus = new EventBus(ctx)
  }

  async setup(): Promise<() => Promise<void>> {
    await registerAgents(this.ctx, this.config)
    await registerTools(this.ctx, {
      config: this.config,
      mailbox: this.mailbox,
      runtimeForSession: async (sessionID, session) => this.runtimeForSession(sessionID, session),
      foregroundSessionFor: async (sessionID) => this.foregroundSessionFor(sessionID)
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
    await this.registerHooks()
    this.startCuratorTimer()
    return async () => this.cleanup()
  }

  async registerHooks(): Promise<void> {
    await this.registerContextHook()
    await this.registerToolBeforeHook()
    await this.registerToolAfterHook()
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
      if (event.sessionID.length === 0 || isLearningTool(event.tool)) {
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
      if (event.sessionID.length === 0 || isLearningTool(event.tool)) {
        return
      }

      await this.enqueueSessionEvent(event.sessionID, async () => {
        const session = await this.foregroundSessionFor(event.sessionID)
        if (session === undefined) {
          return
        }

        const runtime = await this.runtimeForSession(event.sessionID, session)
        if (runtime.recorder.toolAfter(event) !== undefined) {
          this.recordRuntimeSkillUse(runtime, event)
        }
      })
    })
  }

  recordRuntimeSkillUse(runtime: Runtime, event: { tool: string; input: unknown }): void {
    const skillId = runtimeSkillId(event)
    if (skillId === undefined) {
      return
    }

    void runtime.telemetry.recordUse(skillId).catch(console.error)
  }

  async enqueueSessionEvent(
    sessionID: string | undefined,
    task: () => Promise<void> | void
  ): Promise<void> {
    if (isSessionEventUnavailable(sessionID, this.isSessionEventsStopped)) {
      return
    }

    return enqueueEvent(this.sessionEventChains, sessionID, task)
  }

  async sessionInfoFor(sessionID: string): Promise<SessionInfo> {
    const cached = this.sessionInfo.get(sessionID)
    if (cached !== undefined) {
      return cached
    }

    const generation = sessionInfoGeneration(this.sessionInfoGenerations, sessionID)
    const session = await this.ctx.session.get({ [SESSION_ID_KEY]: sessionID })
    if (isSessionInfoStale(this.sessionInfoGenerations, sessionID, generation)) {
      return this.sessionInfoFor(sessionID)
    }

    this.sessionInfo.set(sessionID, session)
    return session
  }

  async foregroundSessionFor(sessionID: string | undefined): Promise<SessionInfo | undefined> {
    if (isUnavailableForegroundSession(sessionID, this.mailbox)) {
      return undefined
    }

    const session = await this.sessionInfoFor(sessionID)
    return isRootSession(session) ? session : undefined
  }

  async runtimeForSession(sessionID: string, session?: SessionInfo): Promise<Runtime> {
    const existing = this.sessionRuntimes.get(sessionID)
    if (existing !== undefined) {
      await existing.ready
      return existing
    }

    session ??= await this.sessionInfoFor(sessionID)
    const directory = await this.resolveSessionDirectory(sessionID, session)
    let runtime = this.runtimes.get(directory)
    if (runtime === undefined) {
      runtime = createRuntime({
        ctx: this.ctx,
        directory,
        config: this.config,
        mailbox: this.mailbox
      })
      this.runtimes.set(directory, runtime)
    }

    this.sessionDirectories.set(sessionID, directory)
    this.sessionRuntimes.set(sessionID, runtime)
    await runtime.ready
    return runtime
  }

  async resolveSessionDirectory(sessionID: string, session: SessionInfo): Promise<string> {
    const directory = this.sessionDirectories.get(sessionID) ?? session.location.directory
    if (directory === undefined || directory.length === 0) {
      throw new Error(`session ${sessionID} has no project directory`)
    }

    return canonicalDirectory(directory)
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
        runtime.pipeline.executionFinished(sessionId, { terminalType: event.type })
      }
    })
  }

  async handleSessionMoved(event: SessionMovedEvent): Promise<void> {
    const { sessionID: sessionId } = event.data
    await this.enqueueSessionEvent(sessionId, async () => {
      const directory = await canonicalDirectory(event.data.location.directory)
      this.sessionInfoGenerations.set(
        sessionId,
        (this.sessionInfoGenerations.get(sessionId) ?? 0) + 1
      )
      this.sessionInfo.delete(sessionId)
      this.sessionRuntimes.delete(sessionId)
      this.sessionDirectories.set(sessionId, directory)
    })
  }

  async runtimeForTerminal(event: TerminalEvent): Promise<Runtime | undefined> {
    const { sessionID: sessionId } = event.data
    const existing = this.sessionRuntimes.get(sessionId)
    if (existing !== undefined) {
      return existing
    }

    const session = await this.foregroundSessionFor(sessionId)
    if (session === undefined) {
      return undefined
    }

    const eventDirectory = terminalDirectory(event, sessionId, session, this.sessionDirectories)
    if (eventDirectory === undefined) {
      return undefined
    }

    const directory = await canonicalDirectory(eventDirectory)
    const runtime = this.runtimes.get(directory)
    this.cacheTerminalRuntime(sessionId, directory, runtime)

    return runtime
  }

  cacheTerminalRuntime(sessionID: string, directory: string, runtime: Runtime | undefined): void {
    if (runtime === undefined) {
      return
    }

    this.sessionDirectories.set(sessionID, directory)
    this.sessionRuntimes.set(sessionID, runtime)
  }

  startCuratorTimer(): void {
    this.curatorTimer = setInterval(
      () => {
        for (const runtime of this.runtimes.values()) {
          void runtime.curator.maybeRun().catch((error: unknown) => {
            console.error('[opencode-learning] curator failed', error)
          })
        }
      },
      Math.max(1, this.config.curator.checkEveryHours) * 36e5
    )
    this.curatorTimer.unref?.()
  }

  async cleanup(): Promise<void> {
    await cleanupSetup(this)
  }
}
