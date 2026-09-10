import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin/effect'
import { Effect } from 'effect'
import type { ReviewResult } from './review.ts'
import type { Store } from './store.ts'

type SessionId = Parameters<Plugin.Context['session']['get']>[0]['sessionID']

function emit(ctx: Plugin.Context, sessionId: SessionId, text: string): Effect.Effect<void, unknown> {
  return ctx.session.synthetic({ ['sessionID']: sessionId, text, resume: false }).pipe(Effect.asVoid)
}

function resultText(result: ReviewResult): string {
  if (result.kind === 'staged') {
    return `staged ${result.proposal.kind} proposal ${result.id} for ${result.proposal.skillId}\n/learn-pending ${result.id}`
  }

  if (result.kind === 'cap') {
    return 'pending proposal limit reached'
  }

  const prefix = result.kind === 'none' ? 'no proposal' : 'proposal rejected'
  return `${prefix}: ${result.reason}`
}

function runCommand(
  ctx: Plugin.Context,
  sessionId: SessionId,
  effect: Effect.Effect<string, unknown>
): Effect.Effect<void, unknown> {
  const rootOnly = ctx.session.get({ ['sessionID']: sessionId }).pipe(
    Effect.flatMap((session) =>
      session.parentID === undefined
        ? effect
        : Effect.fail(new Error('learning commands are root-session-only'))
    )
  )

  return rootOnly.pipe(
    Effect.catchAll((error) =>
      Effect.succeed(`error: ${error instanceof Error ? error.message : String(error)}`)
    ),
    Effect.flatMap((text) => emit(ctx, sessionId, text))
  )
}

async function pendingText(store: Store, id: string): Promise<string> {
  if (id === '') {
    const proposals = await store.listPending()
    return proposals.length === 0
      ? 'no pending proposals'
      : proposals
          .map((proposal) =>
            proposal.invalid === true
              ? `${proposal.id} invalid`
              : `${proposal.id} ${proposal.kind} ${proposal.skillId}\n${proposal.reason}`
          )
          .join('\n\n')
  }

  const proposal = await store.readPending(id)
  const root = path.join(store.pending, id, 'skill')
  const scan = await store.validateTree(root, false)
  const markdown = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8')
  const current = await store.patchStatus(proposal)
  return [
    JSON.stringify(proposal, null, 2),
    `stale: ${String(current.isStale)}`,
    'files:',
    ...current.files,
    '',
    ...scan.files.map((file) =>
      `${file.path} ${file.size} ${file.hash}${file.executable ? ' executable' : ''}`
    ),
    '',
    markdown
  ].join('\n')
}

function storeEffect(operation: () => Promise<string>): Effect.Effect<string, unknown> {
  return Effect.tryPromise(async () => operation())
}

export function registerCommands(
  ctx: Plugin.Context,
  store: Store,
  learn: (sessionId: SessionId) => Effect.Effect<ReviewResult, unknown>
): Effect.Effect<void, unknown, unknown> {
  return ctx.command
    .transform((editor) => {
      editor.add({
        name: 'learn',
        description: 'Review this root session for one reusable procedural skill.',
        execute({ sessionID: sessionId }) {
          return runCommand(ctx, sessionId, learn(sessionId).pipe(Effect.map(resultText)))
        }
      })
      editor.add({
        name: 'learn-pending',
        description: 'List or inspect staged learning proposals.',
        execute({ sessionID: sessionId, prompt }) {
          const id = prompt.text.trim()
          return runCommand(ctx, sessionId, storeEffect(async () => pendingText(store, id)))
        }
      })
      editor.add({
        name: 'learn-approve',
        description: 'Apply one exact staged proposal and reload skills.',
        execute({ sessionID: sessionId, prompt }) {
          const id = prompt.text.trim()
          const effect = storeEffect(async () => {
            const skillId = await store.approve(id)
            try {
              await Effect.runPromise(ctx.skill.reload())
              return `approved ${id}: ${skillId}`
            } catch (error: unknown) {
              return `approved ${id}: ${skillId}; skill reload failed: ${String(error)}`
            }
          })
          return runCommand(ctx, sessionId, effect)
        }
      })
      editor.add({
        name: 'learn-reject',
        description: 'Delete one exact staged proposal.',
        execute({ sessionID: sessionId, prompt }) {
          const id = prompt.text.trim()
          return runCommand(
            ctx,
            sessionId,
            storeEffect(async () => {
              await store.reject(id)
              return `rejected ${id}`
            })
          )
        }
      })
      editor.add({
        name: 'learn-promote',
        description: 'Replace the global copy of one owned project skill.',
        execute({ sessionID: sessionId, prompt }) {
          const skillId = prompt.text.trim()
          const effect = storeEffect(async () => {
            await store.promote(skillId)
            await Effect.runPromise(ctx.skill.reload())
            return `promoted ${skillId}`
          })
          return runCommand(ctx, sessionId, effect)
        }
      })
    })
    .pipe(Effect.flatMap(() => ctx.command.reload()))
}
