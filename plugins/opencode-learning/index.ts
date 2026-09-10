import { Plugin } from '@opencode/plugin/effect'
import { Effect, Fiber, Stream } from 'effect'
import { registerCommands } from './commands.ts'
import { runReview, type ReviewResult } from './review.ts'
import { createStore, PENDING_LIMIT, type Store } from './store.ts'

const SUCCESSFUL_TURNS_PER_REVIEW = 3

type SessionId = Parameters<Plugin.Context['session']['get']>[0]['sessionID']
type ReviewFiber = Fiber.Fiber<ReviewResult, unknown>
type SessionState = {
  reviewCursor?: string
  successfulTurnsSinceReview: number
  pendingLimitNotified: boolean
  reviewFiber?: ReviewFiber
}

type Runtime = {
  ctx: Plugin.Context
  store: Store
  states: Map<SessionId, SessionState>
}

function stateFor(states: Map<SessionId, SessionState>, sessionId: SessionId): SessionState {
  const existing = states.get(sessionId)
  if (existing !== undefined) {
    return existing
  }
  const created = { successfulTurnsSinceReview: 0, pendingLimitNotified: false }
  states.set(sessionId, created)
  return created
}

function record(message: unknown): Record<string, unknown> | undefined {
  return typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : undefined
}

function cursorBeforeLatestUser(messages: readonly unknown[]): string | undefined {
  const index = messages.findLastIndex((message) => record(message)?.type === 'user')
  if (index <= 0) {
    return undefined
  }
  const previous = record(messages[index - 1])
  return typeof previous?.id === 'string' ? previous.id : undefined
}

function latestUserText(messages: readonly unknown[]): string {
  const message = messages.findLast((item) => record(item)?.type === 'user')
  const text = record(message)?.text
  return typeof text === 'string' ? text : ''
}

function isLearningCommand(text: string): boolean {
  return /^\/learn(?:\s|$|-)/v.test(text.trim())
}

function passive(ctx: Plugin.Context, sessionId: SessionId, text: string): Effect.Effect<void, never> {
  return ctx.session
    .synthetic({ ['sessionID']: sessionId, text, resume: false })
    .pipe(Effect.asVoid, Effect.catchAll(() => Effect.void))
}

function capWarning(runtime: Runtime, sessionId: SessionId, state: SessionState): Effect.Effect<void, never> {
  if (state.pendingLimitNotified) {
    return Effect.void
  }
  state.pendingLimitNotified = true
  return passive(runtime.ctx, sessionId, 'pending proposal limit reached')
}

function finishAutomatic(
  runtime: Runtime,
  sessionId: SessionId,
  state: SessionState,
  result: ReviewResult
): Effect.Effect<void, never> {
  if (result.endCursor !== undefined) {
    state.reviewCursor = result.endCursor
  }
  if (result.kind === 'cap') {
    return capWarning(runtime, sessionId, state)
  }
  if (result.kind !== 'staged') {
    return Effect.void
  }
  const text = `${result.id} ${result.proposal.kind} ${result.proposal.skillId}\n/learn-pending ${result.id}`
  return passive(runtime.ctx, sessionId, text)
}

function automaticReview(runtime: Runtime, sessionId: SessionId, state: SessionState): Effect.Effect<void, never> {
  return runReview(runtime.ctx, runtime.store, sessionId, state.reviewCursor).pipe(
    Effect.flatMap((result) => finishAutomatic(runtime, sessionId, state, result)),
    Effect.catchAll(() => Effect.void),
    Effect.ensuring(
      Effect.sync(() => {
        state.reviewFiber = undefined
      })
    )
  )
}

function startAutomatic(runtime: Runtime, sessionId: SessionId, state: SessionState): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    state.successfulTurnsSinceReview = 0
    const pending = yield* Effect.promise(async () => runtime.store.pendingCount()).pipe(Effect.orDie)
    if (pending < PENDING_LIMIT) {
      state.pendingLimitNotified = false
    }
    if (pending >= PENDING_LIMIT) {
      yield* capWarning(runtime, sessionId, state)
      return
    }
    const fiber = yield* Effect.forkScoped(automaticReview(runtime, sessionId, state))
    state.reviewFiber = fiber
  })
}

function primarySuccess(runtime: Runtime, sessionId: SessionId): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const session = yield* runtime.ctx.session.get({ ['sessionID']: sessionId }).pipe(Effect.orDie)
    if (session.parentID !== undefined) {
      return
    }
    const messages = yield* runtime.ctx.session.context({ ['sessionID']: sessionId }).pipe(Effect.orDie)
    if (isLearningCommand(latestUserText(messages))) {
      return
    }
    const state = stateFor(runtime.states, sessionId)
    state.successfulTurnsSinceReview += 1
    if (state.successfulTurnsSinceReview < SUCCESSFUL_TURNS_PER_REVIEW || state.reviewFiber !== undefined) {
      return
    }
    yield* startAutomatic(runtime, sessionId, state)
  }).pipe(Effect.catchAllCause(() => Effect.void))
}

function deleteSession(runtime: Runtime, sessionId: SessionId): Effect.Effect<void, never> {
  const state = runtime.states.get(sessionId)
  runtime.states.delete(sessionId)
  return state?.reviewFiber === undefined ? Effect.void : Fiber.interrupt(state.reviewFiber).pipe(Effect.asVoid)
}

function handleEvent(runtime: Runtime, event: { type: string; data?: { sessionID?: SessionId } }): Effect.Effect<void, never> {
  const sessionId = event.data?.sessionID
  if (sessionId === undefined) {
    return Effect.void
  }
  if (event.type === 'session.execution.succeeded') {
    return primarySuccess(runtime, sessionId)
  }
  return event.type === 'session.deleted' ? deleteSession(runtime, sessionId) : Effect.void
}

function baseline(runtime: Runtime): Effect.Effect<void, never, unknown> {
  return runtime.ctx.session.hook('context', (request) => {
    if (runtime.states.has(request.sessionID)) {
      return Effect.void
    }
    return runtime.ctx.session.get({ ['sessionID']: request.sessionID }).pipe(
      Effect.flatMap((session) =>
        session.parentID === undefined
          ? runtime.ctx.session.context({ ['sessionID']: request.sessionID })
          : Effect.succeed([])
      ),
      Effect.tap((messages) => {
        if (messages.length > 0) {
          stateFor(runtime.states, request.sessionID).reviewCursor = cursorBeforeLatestUser(messages)
        }
      }),
      Effect.asVoid,
      Effect.catchAll(() => Effect.void)
    )
  })
}

function manualReview(runtime: Runtime, sessionId: SessionId): Effect.Effect<ReviewResult, unknown> {
  const state = stateFor(runtime.states, sessionId)
  if (state.reviewFiber !== undefined) {
    return Effect.succeed({ kind: 'rejected', reason: 'review already in progress' })
  }
  return Effect.gen(function* () {
    const pending = yield* Effect.promise(async () => runtime.store.pendingCount())
    if (pending >= PENDING_LIMIT) {
      return { kind: 'cap' } as ReviewResult
    }
    state.pendingLimitNotified = false
    state.successfulTurnsSinceReview = 0
    const review = runReview(runtime.ctx, runtime.store, sessionId).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          state.reviewFiber = undefined
        })
      )
    )
    const fiber = yield* Effect.forkScoped(review)
    state.reviewFiber = fiber
    const result = yield* Fiber.join(fiber)
    if (result.endCursor !== undefined) {
      state.reviewCursor = result.endCursor
    }
    return result
  })
}

function shutdown(states: Map<SessionId, SessionState>): Effect.Effect<void> {
  const fibers = [...states.values()].flatMap((state) =>
    state.reviewFiber === undefined ? [] : [state.reviewFiber]
  )
  return Fiber.interruptAll(fibers).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        states.clear()
      })
    )
  )
}

export default Plugin.define({
  id: 'github.learning_skills',
  effect: (ctx) =>
    Effect.gen(function* () {
      const runtime: Runtime = { ctx, store: createStore(ctx.location.directory), states: new Map() }
      yield* baseline(runtime)
      yield* registerCommands(ctx, runtime.store, (sessionId) => manualReview(runtime, sessionId)).pipe(Effect.orDie)
      yield* ctx.event
        .subscribe()
        .pipe(Stream.runForEach((event) => handleEvent(runtime, event)), Effect.forkScoped)
      yield* Effect.addFinalizer(() => shutdown(runtime.states))
    })
})
