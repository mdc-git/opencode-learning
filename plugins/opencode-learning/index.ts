import { Plugin } from '@opencode/plugin/effect'
import { Effect, Fiber, Stream } from 'effect'
import { registerCommands } from './commands.ts'
import { runReview, type ReviewResult } from './review.ts'
import { createStore, PENDING_LIMIT } from './store.ts'

const SUCCESSFUL_TURNS_PER_REVIEW = 3
const CONTROL = /^\/learn(?:\s|$|-)/v

type SessionState = {
  reviewCursor?: string
  successfulTurnsSinceReview: number
  pendingLimitNotified: boolean
  lastSuccessCursor?: string
  reviewFiber?: Fiber.Fiber<ReviewResult, unknown>
}

function stateFor(states: Map<string, SessionState>, sessionID: string): SessionState {
  const existing = states.get(sessionID)
  if (existing) return existing
  const state: SessionState = { successfulTurnsSinceReview: 0, pendingLimitNotified: false }
  states.set(sessionID, state)
  return state
}

function lastCursor(messages: readonly unknown[]): string | undefined {
  const message = messages.at(-1)
  return typeof message === 'object' && message !== null && 'id' in message ? String(message.id) : undefined
}

function lastUserText(messages: readonly unknown[]): string {
  for (const message of messages.toReversed()) {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'user' && 'text' in message) {
      return String(message.text)
    }
  }
  return ''
}

export default Plugin.define({
  id: 'github.learning_skills',
  effect: (ctx) =>
    Effect.gen(function* () {
      const store = createStore(ctx.location.project.directory)
      const states = new Map<string, SessionState>()
      yield* Effect.addFinalizer(() => Effect.sync(() => states.clear()))

      yield* ctx.session.hook('context', (request) =>
        Effect.gen(function* () {
          if (JSON.stringify(request.messages).includes('opencode-learning:')) return
          const session = yield* ctx.session.get({ sessionID: request.sessionID })
          if (session.parentID) return
          if (states.has(request.sessionID)) return
          const messages = yield* ctx.session.context({ sessionID: request.sessionID })
          const userIndex = messages.findLastIndex((message) => message.type === 'user')
          const before = userIndex > 0 ? messages[userIndex - 1] : undefined
          states.set(request.sessionID, {
            reviewCursor: before?.id,
            successfulTurnsSinceReview: 0,
            pendingLimitNotified: false
          })
        })
      )

      const notifyCap = (sessionID: string, state: SessionState) =>
        Effect.gen(function* () {
          const count = yield* Effect.promise(() => store.pendingCount())
          if (count < PENDING_LIMIT) {
            state.pendingLimitNotified = false
            return false
          }
          if (!state.pendingLimitNotified) {
            state.pendingLimitNotified = true
            yield* ctx.session.synthetic({ sessionID, text: `learning pending limit reached (${PENDING_LIMIT})`, resume: false })
          }
          return true
        })

      const automaticReview = (sessionID: string, state: SessionState) =>
        Effect.gen(function* () {
          const before = yield* ctx.session.context({ sessionID })
          const fallbackEnd = lastCursor(before)
          const result = yield* runReview(ctx, store, sessionID, state.reviewCursor)
          state.reviewCursor = result.endCursor ?? fallbackEnd
          if (result.kind === 'cap') {
            yield* notifyCap(sessionID, state)
          }
          if (result.kind === 'staged') {
            yield* ctx.session.synthetic({
              sessionID,
              text: `${result.id}\n${result.proposal.kind}\n${result.proposal.skillId}\n/learn-pending ${result.id}`,
              resume: false
            })
          }
          return result
        }).pipe(Effect.onExit(() => Effect.sync(() => (state.reviewFiber = undefined))))

      const maybeStartAutomatic = (sessionID: string, state: SessionState) =>
        Effect.gen(function* () {
          if (state.successfulTurnsSinceReview < SUCCESSFUL_TURNS_PER_REVIEW || state.reviewFiber) return
          state.successfulTurnsSinceReview = 0
          if (yield* notifyCap(sessionID, state)) return
          const fiber = yield* Effect.forkScoped(automaticReview(sessionID, state))
          state.reviewFiber = fiber
        })

      const onSuccess = (sessionID: string) =>
        Effect.gen(function* () {
          const session = yield* ctx.session.get({ sessionID })
          if (session.parentID) return
          const messages = yield* ctx.session.context({ sessionID })
          const cursor = lastCursor(messages)
          if (!cursor) return
          const state = stateFor(states, sessionID)
          if (state.lastSuccessCursor === cursor || CONTROL.test(lastUserText(messages))) return
          state.lastSuccessCursor = cursor
          state.successfulTurnsSinceReview += 1
          yield* maybeStartAutomatic(sessionID, state)
        })

      const onDeleted = (sessionID: string) =>
        Effect.gen(function* () {
          const state = states.get(sessionID)
          if (state?.reviewFiber) yield* Fiber.interrupt(state.reviewFiber)
          states.delete(sessionID)
        })

      yield* Stream.runForEach(ctx.event.subscribe(), (event) => {
        if (event.type === 'session.execution.succeeded') return onSuccess(event.data.sessionID)
        if (event.type === 'session.deleted') return onDeleted(event.data.sessionID)
        return Effect.void
      }).pipe(Effect.forkScoped)

      const manualLearn = (sessionID: string): Effect.Effect<ReviewResult, unknown> =>
        Effect.gen(function* () {
          const session = yield* ctx.session.get({ sessionID })
          if (session.parentID) throw new Error('learning commands are root-session-only')
          const state = stateFor(states, sessionID)
          if (state.reviewFiber) throw new Error('review already in progress')
          if ((yield* store.pendingCount()) >= PENDING_LIMIT) throw new Error('pending proposal limit reached')
          const before = yield* ctx.session.context({ sessionID })
          const fallbackEnd = lastCursor(before)
          state.successfulTurnsSinceReview = 0
          const effect = runReview(ctx, store, sessionID).pipe(
            Effect.tap((result) => Effect.sync(() => (state.reviewCursor = result.endCursor ?? fallbackEnd))),
            Effect.onError(() => Effect.sync(() => (state.reviewCursor = fallbackEnd))),
            Effect.onExit(() => Effect.sync(() => (state.reviewFiber = undefined)))
          )
          const fiber = yield* Effect.forkScoped(effect)
          state.reviewFiber = fiber
          return yield* Fiber.join(fiber)
        })

      yield* registerCommands(ctx, store, manualLearn)
    })
})
