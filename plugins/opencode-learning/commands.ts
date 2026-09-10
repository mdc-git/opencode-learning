import fs from 'node:fs/promises'
import path from 'node:path'
import { Plugin } from '@opencode/plugin/effect'
import { Effect } from 'effect'
import type { ReviewResult } from './review.ts'
import type { Store } from './store.ts'

function emit(ctx: Plugin.Context, sessionID: string, text: string): Effect.Effect<void, unknown> {
  return ctx.session.synthetic({ sessionID, text, resume: false }).pipe(Effect.asVoid)
}

function argument(text: string): string {
  return text.trim()
}

function resultText(result: ReviewResult): string {
  if (result.kind === 'staged') {
    return `staged ${result.proposal.kind} proposal ${result.id} for ${result.proposal.skillId}\n/learn-pending ${result.id}`
  }
  if (result.kind === 'cap') return 'pending proposal limit reached'
  return result.kind === 'none' ? `no proposal: ${result.reason}` : `proposal rejected: ${result.reason}`
}

function commandEffect(effect: Effect.Effect<string, unknown>, ctx: Plugin.Context, sessionID: string): Effect.Effect<void, unknown> {
  const rootOnly = ctx.session.get({ sessionID }).pipe(
    Effect.flatMap((session) => (session.parentID ? Effect.fail(new Error('learning commands are root-session-only')) : effect))
  )
  return rootOnly.pipe(
    Effect.catch((error) => Effect.succeed(`error: ${error instanceof Error ? error.message : String(error)}`)),
    Effect.flatMap((text) => emit(ctx, sessionID, text))
  )
}

function inspectPending(store: Store, id: string): Effect.Effect<string, unknown> {
  return Effect.tryPromise(async () => {
    if (!id) {
      const proposals = await store.listPending()
      if (proposals.length === 0) return 'no pending proposals'
      return proposals
        .map((proposal) =>
          proposal.invalid
            ? `${proposal.id} invalid`
            : `${proposal.id} ${proposal.kind} ${proposal.skillId}\n${proposal.reason}`
        )
        .join('\n\n')
    }
    const proposal = await store.readPending(id)
    const root = path.join(store.pending, id, 'skill')
    const scan = await store.validateTree(root, false)
    const markdown = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8')
    let stale = false
    if (proposal.kind === 'patch') {
      try {
        stale = (await store.validateTree(path.join(store.projectSkills, proposal.skillId), true)).revision !== proposal.expectedRevision
      } catch {
        stale = true
      }
    }
    return [
      JSON.stringify(proposal, null, 2),
      `stale: ${String(stale)}`,
      'files:',
      ...scan.files.map((file) => `${file.path} ${file.size} ${file.hash}${file.executable ? ' executable' : ''}`),
      '',
      markdown
    ].join('\n')
  })
}

export function registerCommands(
  ctx: Plugin.Context,
  store: Store,
  learn: (sessionID: string) => Effect.Effect<ReviewResult, unknown>
): Effect.Effect<void, never, unknown> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: 'learn',
      description: 'Review this root session for one reusable procedural skill.',
      execute: ({ sessionID }) => commandEffect(learn(sessionID).pipe(Effect.map(resultText)), ctx, sessionID)
    })
    editor.add({
      name: 'learn-pending',
      description: 'List or inspect staged learning proposals.',
      execute: ({ sessionID, prompt }) => commandEffect(inspectPending(store, argument(prompt.text)), ctx, sessionID)
    })
    editor.add({
      name: 'learn-approve',
      description: 'Apply one exact staged proposal and reload skills.',
      execute: ({ sessionID, prompt }) => {
        const id = argument(prompt.text)
        const effect = Effect.tryPromise(() => store.approve(id)).pipe(
          Effect.flatMap((skillId) =>
            ctx.skill.reload().pipe(
              Effect.as(`approved ${id}: ${skillId}`),
              Effect.catch((error) => Effect.succeed(`approved ${id}: ${skillId}; skill reload failed: ${String(error)}`))
            )
          )
        )
        return commandEffect(effect, ctx, sessionID)
      }
    })
    editor.add({
      name: 'learn-reject',
      description: 'Delete one exact staged proposal.',
      execute: ({ sessionID, prompt }) => {
        const id = argument(prompt.text)
        return commandEffect(Effect.tryPromise(() => store.reject(id)).pipe(Effect.as(`rejected ${id}`)), ctx, sessionID)
      }
    })
    editor.add({
      name: 'learn-promote',
      description: 'Replace the global copy of one owned project skill.',
      execute: ({ sessionID, prompt }) => {
        const skillId = argument(prompt.text)
        const effect = Effect.tryPromise(() => store.promote(skillId)).pipe(
          Effect.flatMap(() => ctx.skill.reload()),
          Effect.as(`promoted ${skillId}`)
        )
        return commandEffect(effect, ctx, sessionID)
      }
    })
  }).pipe(Effect.flatMap(() => ctx.command.reload()))
}
