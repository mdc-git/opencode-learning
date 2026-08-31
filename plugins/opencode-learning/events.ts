import { redactError, SESSION_ID_KEY } from './shared.ts'
import type {
  OpenCodeContext,
  OpenCodeEvent,
  SessionCreateInput,
  SessionInfo,
  SessionMovedEvent,
  TerminalEvent
} from './sdk.ts'

const TERMINAL_EVENT_TYPES = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted'
])

export class EventBus {
  private readonly ctx: OpenCodeContext
  private readonly listeners = new Set<(event: TerminalEvent) => void>()
  private readonly moveListeners = new Set<(event: SessionMovedEvent) => void>()
  private controller: AbortController | undefined
  private task: Promise<void> | undefined
  private iterator: AsyncIterator<OpenCodeEvent> | undefined
  private disposed = false

  constructor(ctx: OpenCodeContext) {
    this.ctx = ctx
  }

  async #closeIterator(): Promise<void> {
    try {
      await this.iterator?.return?.()
    } catch {}
  }

  async #run(): Promise<void> {
    const { controller } = this
    if (controller === undefined) {
      return
    }

    await runEventLoop({
      subscribe: () => this.ctx.event.subscribe({ signal: controller.signal }),
      shouldStop: () => this.disposed || controller.signal.aborted,
      signal: controller.signal,
      setIterator: (iterator) => {
        this.iterator = iterator
      },
      clearIterator: (iterator) => {
        if (this.iterator === iterator) {
          this.iterator = undefined
        }
      },
      onEvent: (event) => {
        emitTerminalEvent(event, this.listeners)
        emitSessionMovedEvent(event, this.moveListeners)
      }
    })

    this.task = undefined
  }

  start(): void {
    if (this.task !== undefined || this.disposed) {
      return
    }

    this.controller = new AbortController()
    this.task = this.#run()
  }

  onTerminal(listener: (event: TerminalEvent) => void): () => boolean {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onSessionMoved(listener: (event: SessionMovedEvent) => void): () => boolean {
    this.moveListeners.add(listener)
    return () => this.moveListeners.delete(listener)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.controller?.abort()
    await this.#closeIterator()
    await this.task
  }
}

type EventLoopOptions = {
  subscribe: () => AsyncIterable<OpenCodeEvent>
  shouldStop: () => boolean
  signal: AbortSignal
  setIterator: (iterator: AsyncIterator<OpenCodeEvent>) => void
  clearIterator: (iterator: AsyncIterator<OpenCodeEvent>) => void
  onEvent: (event: OpenCodeEvent) => void
}

async function runEventLoop(options: EventLoopOptions): Promise<void> {
  if (options.shouldStop()) {
    return
  }

  let cycle: Promise<void>
  try {
    cycle = consumeEventStream(options.subscribe(), options)
  } catch (error) {
    cycle = Promise.reject(
      error instanceof Error ? error : new Error(`event stream failed: ${redactError(error)}`)
    )
  }

  return cycle
    .catch((error: unknown) => {
      if (!options.shouldStop()) {
        console.error('[opencode-learning] event stream failed', error)
      }
    })
    .then(async () => continueEventLoop(options))
}

async function continueEventLoop(options: EventLoopOptions): Promise<void> {
  if (options.shouldStop()) {
    return
  }

  return delay(1e3, options.signal).then(async () => runEventLoop(options))
}

async function consumeEventStream(
  stream: AsyncIterable<OpenCodeEvent>,
  options: EventLoopOptions
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]()
  options.setIterator(iterator)
  return consumeEventItem(iterator, options).finally(() => {
    options.clearIterator(iterator)
  })
}

async function consumeEventItem(
  iterator: AsyncIterator<OpenCodeEvent>,
  options: EventLoopOptions
): Promise<void> {
  return iterator.next().then(async (iteration) => {
    if (iteration.done === true || options.shouldStop()) {
      return
    }

    options.onEvent(iteration.value)
    return consumeEventItem(iterator, options)
  })
}

function emitTerminalEvent(
  event: OpenCodeEvent,
  listeners: Set<(event: TerminalEvent) => void>
): void {
  if (!isTerminalEvent(event)) {
    return
  }

  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      console.error('[opencode-learning] terminal event listener failed', error)
    }
  }
}

function emitSessionMovedEvent(
  event: OpenCodeEvent,
  listeners: Set<(event: SessionMovedEvent) => void>
): void {
  if (event.type !== 'session.moved') {
    return
  }

  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      console.error('[opencode-learning] session-move listener failed', error)
    }
  }
}

function isTerminalEvent(event: OpenCodeEvent): event is TerminalEvent {
  return TERMINAL_EVENT_TYPES.has(event.type)
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true }
    )
  })
}

export async function createReviewSession(
  ctx: OpenCodeContext,
  {
    directory,
    agent,
    title,
    model
  }: { directory: string; agent: string; title: string; model?: SessionInfo['model'] }
): Promise<SessionInfo> {
  const input: SessionCreateInput =
    model === undefined || model.id.length === 0 || model.providerID.length === 0
      ? { title, agent, location: { directory } }
      : { title, agent, location: { directory }, model }

  return ctx.session.create(input)
}

export async function promptSession(
  ctx: OpenCodeContext,
  sessionID: string,
  text: string
): Promise<unknown> {
  return ctx.session.prompt({ [SESSION_ID_KEY]: sessionID, text, delivery: 'queue', resume: true })
}

export async function interruptSession(ctx: OpenCodeContext, sessionID: string): Promise<void> {
  try {
    await ctx.session.interrupt({ [SESSION_ID_KEY]: sessionID })
  } catch {}
}

export async function notifySession(
  ctx: OpenCodeContext,
  sessionID: string,
  text: string
): Promise<void> {
  try {
    await ctx.session.synthetic({
      [SESSION_ID_KEY]: sessionID,
      text,
      description: 'opencode-learning',
      metadata: { source: 'opencode-learning' },
      delivery: 'queue',
      resume: false
    })
  } catch {}
}
