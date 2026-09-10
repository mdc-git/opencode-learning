import { Plugin } from '@opencode/plugin/effect'
import { Effect, Fiber, Stream } from 'effect'
import { runReview, type ReviewActivity, type ReviewResult } from './review.ts'
import { registerLearningRpc } from './rpc-server.ts'
import { createStore, PENDING_LIMIT, type Store } from './store.ts'

const SUCCESSFUL_TURNS_PER_REVIEW = 3
const REVIEW_LOOKBACK_TURNS = 2

type SessionRef = Parameters<Plugin.Context['session']['get']>[0]
type SessionId = SessionRef['sessionID']
type ReviewFiber = Fiber.Fiber<unknown, unknown>
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
  activity: ReviewActivity
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
  return typeof message === 'object' && message !== null
    ? (message as Record<string, unknown>)
    : undefined
}

function cursorBeforeLatestUser(messages: readonly unknown[]): string | undefined {
  const index = messages.findLastIndex((message) => record(message)?.type === 'user')
  if (index <= 0) {
    return undefined
  }

  const previous = record(messages[index - 1])
  return typeof previous?.id === 'string' ? previous.id : undefined
}

function pendingLimit(runtime: Runtime, sessionRef: SessionRef, state: SessionState) {
  if (state.pendingLimitNotified) {
    return Effect.void
  }

  state.pendingLimitNotified = true
  return runtime.activity({
    kind: 'pending-limit',
    sessionId: sessionRef.sessionID,
    message: 'pending proposal limit reached'
  })
}

function finishAutomatic(state: SessionState, result: ReviewResult) {
  if (result.endCursor !== undefined) {
    state.reviewCursor = result.endCursor
  }

  return Effect.void
}

function automaticReview(runtime: Runtime, sessionRef: SessionRef, state: SessionState) {
  return runReview(runtime.ctx, runtime.store, sessionRef, {
    startAfter: state.reviewCursor,
    lookbackTurns: REVIEW_LOOKBACK_TURNS,
    activity: runtime.activity
  }).pipe(
    Effect.flatMap((result) => finishAutomatic(state, result)),
    Effect.catch(() => Effect.void),
    Effect.ensuring(
      Effect.sync(() => {
        state.reviewFiber = undefined
      })
    )
  )
}

function startAutomatic(runtime: Runtime, sessionRef: SessionRef, state: SessionState) {
  return Effect.gen(function* () {
    state.successfulTurnsSinceReview = 0
    const pending = yield* Effect.promise(async () => runtime.store.pendingCount()).pipe(
      Effect.orDie
    )
    if (pending < PENDING_LIMIT) {
      state.pendingLimitNotified = false
    }

    if (pending >= PENDING_LIMIT) {
      yield* pendingLimit(runtime, sessionRef, state)
      return
    }

    state.reviewFiber = yield* Effect.forkDetach(automaticReview(runtime, sessionRef, state))
  })
}

function eligibleContext(runtime: Runtime, sessionRef: SessionRef) {
  return runtime.ctx.session
    .get(sessionRef)
    .pipe(
      Effect.flatMap((session) =>
        session.parentID === undefined
          ? runtime.ctx.session.context(sessionRef)
          : Effect.succeed(undefined)
      )
    )
}

function primarySuccess(runtime: Runtime, sessionRef: SessionRef) {
  return eligibleContext(runtime, sessionRef).pipe(
    Effect.flatMap((messages) => {
      if (messages === undefined) {
        return Effect.void
      }

      const state = stateFor(runtime.states, sessionRef.sessionID)
      state.successfulTurnsSinceReview += 1
      const isDue = state.successfulTurnsSinceReview >= SUCCESSFUL_TURNS_PER_REVIEW
      return isDue && state.reviewFiber === undefined
        ? startAutomatic(runtime, sessionRef, state)
        : Effect.void
    }),
    Effect.catchCause(() => Effect.void)
  )
}

function deleteSession(runtime: Runtime, sessionId: SessionId) {
  const state = runtime.states.get(sessionId)
  runtime.states.delete(sessionId)
  return state?.reviewFiber === undefined
    ? Effect.void
    : Fiber.interrupt(state.reviewFiber).pipe(Effect.asVoid)
}

function baseline(runtime: Runtime) {
  return runtime.ctx.session.hook('context', (request) => {
    if (runtime.states.has(request.sessionID)) {
      return Effect.void
    }

    return runtime.ctx.session.get(request).pipe(
      Effect.flatMap((session) =>
        session.parentID === undefined ? runtime.ctx.session.context(request) : Effect.succeed([])
      ),
      Effect.tap((messages) =>
        Effect.sync(() => {
          if (messages.length > 0) {
            stateFor(runtime.states, request.sessionID).reviewCursor =
              cursorBeforeLatestUser(messages)
          }
        })
      ),
      Effect.asVoid,
      Effect.catch(() => Effect.void)
    )
  })
}

function manualReview(
  runtime: Runtime,
  sessionRef: SessionRef
): Effect.Effect<ReviewResult, unknown> {
  const state = stateFor(runtime.states, sessionRef.sessionID)
  if (state.reviewFiber !== undefined) {
    return Effect.succeed({ kind: 'rejected', reason: 'review already in progress' })
  }

  return Effect.gen(function* () {
    state.pendingLimitNotified = false
    state.successfulTurnsSinceReview = 0
    const review = runReview(runtime.ctx, runtime.store, sessionRef, {
      activity: runtime.activity
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          state.reviewFiber = undefined
        })
      )
    )
    const fiber = yield* Effect.forkDetach(review)
    state.reviewFiber = fiber
    const result = yield* Fiber.join(fiber)
    if (result.endCursor !== undefined) {
      state.reviewCursor = result.endCursor
    }

    return result
  })
}

function reviewFibers(states: Map<SessionId, SessionState>): ReviewFiber[] {
  const fibers: ReviewFiber[] = []
  for (const state of states.values()) {
    if (state.reviewFiber !== undefined) {
      fibers.push(state.reviewFiber)
    }
  }

  return fibers
}

function shutdown(states: Map<SessionId, SessionState>) {
  return Fiber.interruptAll(reviewFibers(states)).pipe(
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
      const runtime: Runtime = {
        ctx,
        store: createStore(ctx.location.directory),
        states: new Map(),
        activity: () => Effect.void
      }
      yield* baseline(runtime)
      const rpc = yield* registerLearningRpc(ctx, runtime.store, (sessionRef) =>
        manualReview(runtime, sessionRef)
      ).pipe(Effect.orDie)
      runtime.activity = (event) =>
        rpc.events.emit('activity', event).pipe(Effect.catch(() => Effect.void))
      yield* ctx.event.subscribe().pipe(
        Stream.runForEach((event) => {
          if (event.type === 'session.execution.succeeded') {
            return primarySuccess(runtime, event.data)
          }

          if (event.type === 'session.deleted') {
            return deleteSession(runtime, event.data.sessionID)
          }

          return Effect.void
        }),
        Effect.forkScoped
      )
      yield* Effect.addFinalizer(() => rpc.dispose)
      yield* Effect.addFinalizer(() => shutdown(runtime.states))
    })
})
