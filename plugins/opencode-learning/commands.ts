import fs from 'node:fs/promises'
import path from 'node:path'
import type { Plugin } from '@opencode/plugin/effect'
import { Effect } from 'effect'
import type { ReviewResult } from './review.ts'
import type { Store } from './store.ts'

type SessionRef = Parameters<Plugin.Context['session']['get']>[0]
type SessionId = SessionRef['sessionID']
type CommandInvocation = Parameters<
  Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0]['add']
>[0]['execute'] extends (input: infer Input) => unknown
  ? Input
  : never
type CommandEditor = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0]
type Learn = (sessionId: SessionId) => Effect.Effect<ReviewResult, unknown>

function emit(
  ctx: Plugin.Context,
  invocation: CommandInvocation,
  text: string
): Effect.Effect<void, unknown> {
  return ctx.session.synthetic({ ...invocation, text, resume: false }).pipe(Effect.asVoid)
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
  invocation: CommandInvocation,
  effect: Effect.Effect<string, unknown>
): Effect.Effect<void, unknown> {
  return ctx.session.get(invocation).pipe(
    Effect.flatMap((session) =>
      session.parentID === undefined
        ? effect
        : Effect.fail(new Error('learning commands are root-session-only'))
    ),
    Effect.catch((error) =>
      Effect.succeed(`error: ${error instanceof Error ? error.message : String(error)}`)
    ),
    Effect.flatMap((text) => emit(ctx, invocation, text))
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
    ...scan.files.map(
      (file) => `${file.path} ${file.size} ${file.hash}${file.executable ? ' executable' : ''}`
    ),
    '',
    markdown
  ].join('\n')
}

function storeEffect(operation: () => Promise<string>): Effect.Effect<string, unknown> {
  return Effect.tryPromise(async () => operation())
}

function addLearn(editor: CommandEditor, ctx: Plugin.Context, learn: Learn): void {
  editor.add({
    name: 'learn',
    description: 'Review this root session for one reusable procedural skill.',
    execute(invocation) {
      return runCommand(
        ctx,
        invocation,
        learn(invocation.sessionID).pipe(Effect.map(resultText))
      )
    }
  })
}

function addPending(editor: CommandEditor, ctx: Plugin.Context, store: Store): void {
  editor.add({
    name: 'learn-pending',
    description: 'List or inspect staged learning proposals.',
    execute(invocation) {
      return runCommand(
        ctx,
        invocation,
        storeEffect(async () => pendingText(store, invocation.prompt.text.trim()))
      )
    }
  })
}

function addApprove(editor: CommandEditor, ctx: Plugin.Context, store: Store): void {
  editor.add({
    name: 'learn-approve',
    description: 'Apply one exact staged proposal and reload skills.',
    execute(invocation) {
      const id = invocation.prompt.text.trim()
      const operation = storeEffect(async () => {
        const skillId = await store.approve(id)
        try {
          await Effect.runPromise(ctx.skill.reload())
          return `approved ${id}: ${skillId}`
        } catch (error: unknown) {
          return `approved ${id}: ${skillId}; skill reload failed: ${String(error)}`
        }
      })
      return runCommand(ctx, invocation, operation)
    }
  })
}

function addReject(editor: CommandEditor, ctx: Plugin.Context, store: Store): void {
  editor.add({
    name: 'learn-reject',
    description: 'Delete one exact staged proposal.',
    execute(invocation) {
      const id = invocation.prompt.text.trim()
      return runCommand(
        ctx,
        invocation,
        storeEffect(async () => {
          await store.reject(id)
          return `rejected ${id}`
        })
      )
    }
  })
}

function addPromote(editor: CommandEditor, ctx: Plugin.Context, store: Store): void {
  editor.add({
    name: 'learn-promote',
    description: 'Replace the global copy of one owned project skill.',
    execute(invocation) {
      const skillId = invocation.prompt.text.trim()
      return runCommand(
        ctx,
        invocation,
        storeEffect(async () => {
          await store.promote(skillId)
          await Effect.runPromise(ctx.skill.reload())
          return `promoted ${skillId}`
        })
      )
    }
  })
}

export function registerCommands(ctx: Plugin.Context, store: Store, learn: Learn) {
  return ctx.command
    .transform((editor) => {
      addLearn(editor, ctx, learn)
      addPending(editor, ctx, store)
      addApprove(editor, ctx, store)
      addReject(editor, ctx, store)
      addPromote(editor, ctx, store)
    })
    .pipe(Effect.flatMap(() => ctx.command.reload()))
}
