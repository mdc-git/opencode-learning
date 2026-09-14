import crypto from 'node:crypto'
import type { Plugin } from '@opencode/plugin/effect'
import { Effect } from 'effect'

type SessionRef = Parameters<Plugin.Context['session']['get']>[0]
export type ModelRef = NonNullable<Parameters<Plugin.Context['generate']['text']>[0]['model']>
type GenerateResult = { text: string; model: string }
type IsolatedGenerateInput = {
  ctx: Plugin.Context
  sessionRef: SessionRef
  prepare: (messages: readonly unknown[], maxBytes: number) => string
  model?: ModelRef
  captured?: readonly unknown[]
}
type CatalogModel = {
  id: unknown
  providerID: unknown
  limit: { input?: number; context: number; output: number }
}
type ModelReferenceParts = { providerId: string; id: string; variant?: string }

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

function modelReferenceParts(value: unknown, option: string): ModelReferenceParts {
  if (typeof value !== 'string') {
    throw new TypeError(`${option} must be a model reference such as provider/model`)
  }

  const [reference = '', variant, ...extra] = value.split('#')
  const slash = reference.indexOf('/')
  const providerId = reference.slice(0, slash)
  const id = reference.slice(slash + 1)
  const isInvalid = [slash <= 0, id.length === 0, extra.length > 0, variant === ''].some(Boolean)
  if (isInvalid) {
    throw new TypeError(`${option} must be a valid model reference such as provider/model`)
  }

  return { providerId, id, variant }
}

export function parseModelReference(value: unknown, option: string): ModelRef | undefined {
  if (value === undefined) {
    return undefined
  }

  const { providerId, id, variant } = modelReferenceParts(value, option)
  return Object.fromEntries([
    ['providerID', providerId as ModelRef['providerID']],
    ['id', id as ModelRef['id']],
    ['variant', variant as ModelRef['variant']]
  ]) as ModelRef
}

export function isolatedGenerate(
  input: IsolatedGenerateInput
): Effect.Effect<GenerateResult, unknown> {
  const { ctx, sessionRef, prepare, model, captured } = input
  return Effect.scoped(
    Effect.gen(function* () {
      if (model !== undefined) {
        const models = yield* ctx.catalog.model.list()
        const prompt = prepare([], modelInputLimit(models.data, model))
        const generated = yield* ctx.generate.text({ model, prompt })
        return { text: generated.text, model: modelKey(model) }
      }

      const marker = `opencode-learning:${crypto.randomUUID()}`
      const models = yield* ctx.catalog.model.list()
      const messages = captured ?? (yield* ctx.session.context(sessionRef))
      let capturedModel = ''
      const registration = yield* ctx.session.hook('generate', (request) => {
        if (!JSON.stringify(request.messages).includes(marker)) {
          return Effect.void
        }

        return Effect.sync(() => {
          const maxBytes = modelInputLimit(models.data, request.model)
          const prompt = prepare(messages, maxBytes)
          capturedModel = modelKey(request.model)
          request.system = []
          request.tools = {}
          request.messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }]
        })
      })
      const generated = yield* ctx.session
        .generate({ ...sessionRef, prompt: marker })
        .pipe(Effect.ensuring(registration.dispose))
      if (capturedModel === '') {
        return yield* Effect.fail(new Error('review generate hook did not capture generation'))
      }

      return { text: generated.text, model: capturedModel }
    })
  )
}
