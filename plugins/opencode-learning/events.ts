import { EVENT_ID_KEY, isRecord, redactError, SESSION_ID_KEY } from './shared.ts'
import type { OpenCodeContext, SessionInfo, TerminalEvent } from './types.ts'

const TERMINAL_EVENTS = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted'
])

export class EventBus {
  private readonly ctx: OpenCodeContext
  private readonly listeners = new Set<(event: TerminalEvent) => void>()
  private controller: AbortController | undefined
  private task: Promise<void> | undefined
  private iterator: AsyncIterator<unknown> | undefined
  private disposed = false

  constructor(ctx: OpenCodeContext) {
    this.ctx = ctx
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

  async dispose(): Promise<void> {
    this.disposed = true
    this.controller?.abort()
    try {
      await this.iterator?.return?.()
    } catch {}

    await this.task
  }
}

type EventLoopOptions = {
  subscribe: () => AsyncIterable<unknown>
  shouldStop: () => boolean
  signal: AbortSignal
  setIterator: (iterator: AsyncIterator<unknown>) => void
  clearIterator: (iterator: AsyncIterator<unknown>) => void
  onEvent: (event: unknown) => void
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
  stream: AsyncIterable<unknown>,
  options: EventLoopOptions
): Promise<void> {
  const iterator = stream[Symbol.asyncIterator]()
  options.setIterator(iterator)
  return consumeEventItem(iterator, options).finally(() => {
    options.clearIterator(iterator)
  })
}

async function consumeEventItem(
  iterator: AsyncIterator<unknown>,
  options: EventLoopOptions
): Promise<void> {
  return iterator.next().then(async (iteration) => {
    if (iteration.done === true || options.shouldStop()) {
      return
    }

    options.onEvent(iteration.value)
    return continueConsumingEvents(iterator, options)
  })
}

async function continueConsumingEvents(
  iterator: AsyncIterator<unknown>,
  options: EventLoopOptions
): Promise<void> {
  return consumeEventItem(iterator, options)
}

function emitTerminalEvent(event: unknown, listeners: Set<(event: TerminalEvent) => void>): void {
  const terminalEvent = terminalEventFrom(event)
  if (terminalEvent === undefined) {
    return
  }

  for (const listener of listeners) {
    try {
      listener(terminalEvent)
    } catch (error) {
      console.error('[opencode-learning] terminal event listener failed', error)
    }
  }
}

function terminalEventFrom(event: unknown): TerminalEvent | undefined {
  if (!isRecord(event) || typeof event.type !== 'string' || !TERMINAL_EVENTS.has(event.type)) {
    return undefined
  }

  const eventData = isRecord(event.data) ? event.data : {}
  const sessionId = typeof eventData.sessionID === 'string' ? eventData.sessionID : undefined
  if (sessionId === undefined || sessionId.length === 0) {
    return undefined
  }

  const eventId = [event.id, event.eventID, eventData.eventID, eventData.id].find(
    (value): value is string => typeof value === 'string'
  )
  return {
    type: event.type,
    [SESSION_ID_KEY]: sessionId,
    [EVENT_ID_KEY]: eventId,
    location: eventLocation(event.location)
  }
}

function eventLocation(value: unknown): { directory?: string } | undefined {
  if (!isRecord(value) || typeof value.directory !== 'string') {
    return undefined
  }

  return { directory: value.directory }
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
  const input: {
    title: string
    agent: string
    location: { directory: string }
    model?: SessionInfo['model']
  } = { title, agent, location: { directory } }
  if (model !== undefined && model.id.length > 0 && model.providerID.length > 0) {
    input.model = model
  }

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
