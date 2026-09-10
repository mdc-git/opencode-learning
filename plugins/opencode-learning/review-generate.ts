import crypto from 'node:crypto'
import type { Plugin } from '@opencode/plugin/effect'
import { Effect } from 'effect'

type SessionRef = Parameters<Plugin.Context['session']['get']>[0]
type GenerateResult = { text: string; model: string }
type CatalogModel = {
  id: unknown
  providerID: unknown
  limit: { input?: number; context: number; output: number }
}

function modelKey(model: { id: unknown; providerID: unknown; variant?: unknown }): string {
  return JSON.stringify([model.providerID, model.id, model.variant])
}

function modelInputLimit(
  models: readonly CatalogModel[],
  model: { id: unknown; providerID: unknown }
): number {
  const found = models.find((item) => item.id === model.id && item.providerID === model.providerID)
  if (found === undefined) {
    throw new Error('selected model is absent from the current catalog')
  }

  return found.limit.input ?? Math.max(1, found.limit.context - found.limit.output)
}

export function isolatedGenerate(
  ctx: Plugin.Context,
  sessionRef: SessionRef,
  prepare: (messages: readonly unknown[], maxBytes: number) => string
): Effect.Effect<GenerateResult, unknown> {
  return Effect.scoped(
    Effect.gen(function* () {
      const marker = `opencode-learning:${crypto.randomUUID()}`
      const models = yield* ctx.catalog.model.list()
      let capturedModel = ''
      const registration = yield* ctx.session.hook('context', (request) => {
        if (!JSON.stringify(request.messages).includes(marker)) {
          return Effect.void
        }

        return ctx.session.context(sessionRef).pipe(
          Effect.flatMap((messages) =>
            Effect.sync(() => {
              const maxBytes = modelInputLimit(models.data, request.model)
              const prompt = prepare(messages, maxBytes)
              capturedModel = modelKey(request.model)
              request.system = []
              request.tools = {}
              request.messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
            })
          ),
          Effect.orDie
        )
      })
      const generated = yield* ctx.session.generate({ ...sessionRef, prompt: marker })
      yield* registration.dispose
      if (capturedModel === '') {
        return yield* Effect.fail(new Error('review context hook did not capture generation'))
      }

      return { text: generated.text, model: capturedModel }
    })
  )
}
