import { Plugin } from '@opencode/plugin/tui'
import { LearningRpc } from './rpc.ts'

type Context = Plugin.Context

function createLearningClient(context: Context) {
  return context.client.rpc(LearningRpc)
}

type LearningClient = ReturnType<typeof createLearningClient>
type ProposalDetail = Awaited<ReturnType<LearningClient['proposal']>>

function currentSession(context: Context): string | undefined {
  const route = context.ui.router.current()
  return route.type === 'session' ? route.sessionID : undefined
}

function requireSession(context: Context): string | undefined {
  const sessionId = currentSession(context)
  if (sessionId === undefined) {
    context.ui.toast.show({
      title: 'Learning',
      message: 'Open a root session to use learning commands.',
      variant: 'warning'
    })
  }

  return sessionId
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function showError(context: Context, error: unknown): void {
  context.ui.toast.show({
    title: 'Learning',
    message: errorMessage(error),
    variant: 'error',
    duration: 6000
  })
}

function detailText(detail: ProposalDetail): string {
  const files = detail.files.length === 0 ? 'none' : detail.files.join('\n')
  const manifest = detail.manifest
    .map((file) => `${file.path} ${file.size} ${file.hash}${file.executable ? ' executable' : ''}`)
    .join('\n')
  return [
    `${detail.kind} ${detail.skillId}`,
    detail.reason,
    `stale: ${String(detail.stale)}`,
    '',
    'changes:',
    files,
    '',
    'manifest:',
    manifest,
    '',
    'evidence:',
    detail.evidence,
    '',
    detail.markdown
  ].join('\n')
}

async function showProposal(context: Context, rpc: LearningClient, sessionId: string, id: string) {
  const detail = await rpc.proposal({ sessionId, id })
  await context.ui.dialog.alert({
    title: `${detail.kind} ${detail.skillId}`,
    message: detailText(detail)
  })
}

async function showPending(context: Context, rpc: LearningClient, input?: string) {
  const sessionId = requireSession(context)
  if (sessionId === undefined) return

  try {
    const id = input?.trim() ?? ''
    if (id !== '') {
      await showProposal(context, rpc, sessionId, id)
      return
    }

    const proposals = await rpc.pending({ sessionId })
    if (proposals.length === 0) {
      context.ui.toast.show({ title: 'Learning', message: 'No pending proposals.', variant: 'info' })
      return
    }

    const selected = await context.ui.dialog.select({
      title: 'Pending skill proposals',
      options: proposals.map((proposal) => ({
        title: proposal.invalid ? `${proposal.id} invalid` : `${proposal.kind} ${proposal.skillId}`,
        description: proposal.reason,
        value: proposal.id
      }))
    })
    if (selected !== undefined) {
      await showProposal(context, rpc, sessionId, selected)
    }
  } catch (error) {
    showError(context, error)
  }
}

async function runReview(context: Context, rpc: LearningClient) {
  const sessionId = requireSession(context)
  if (sessionId === undefined) return

  try {
    const result = await rpc.review({ sessionId })
    if (result.status !== 'staged') {
      context.ui.toast.show({
        title: 'Learning',
        message: result.message,
        variant: result.status === 'cap' ? 'warning' : 'info',
        duration: 5000
      })
    }
  } catch (error) {
    showError(context, error)
  }
}

async function approve(context: Context, rpc: LearningClient, input?: string) {
  const sessionId = requireSession(context)
  const id = input?.trim() ?? ''
  if (sessionId === undefined || id === '') return

  try {
    const result = await rpc.approve({ sessionId, id })
    context.ui.toast.show({
      title: 'Learning',
      message: `Approved ${result.skillId}.`,
      variant: 'success'
    })
  } catch (error) {
    showError(context, error)
  }
}

async function reject(context: Context, rpc: LearningClient, input?: string) {
  const sessionId = requireSession(context)
  const id = input?.trim() ?? ''
  if (sessionId === undefined || id === '') return

  try {
    await rpc.reject({ sessionId, id })
    context.ui.toast.show({ title: 'Learning', message: `Rejected ${id}.`, variant: 'success' })
  } catch (error) {
    showError(context, error)
  }
}

async function promote(context: Context, rpc: LearningClient, input?: string) {
  const sessionId = requireSession(context)
  const skillId = input?.trim() ?? ''
  if (sessionId === undefined || skillId === '') return

  try {
    await rpc.promote({ sessionId, skillId })
    context.ui.toast.show({
      title: 'Learning',
      message: `Promoted ${skillId}.`,
      variant: 'success'
    })
  } catch (error) {
    showError(context, error)
  }
}

function activityToast(context: Context, activity: { kind: string; message: string }): void {
  const variant =
    activity.kind === 'proposal-staged'
      ? 'success'
      : activity.kind === 'pending-limit' || activity.message.startsWith('rejected:')
        ? 'warning'
        : 'info'
  context.ui.toast.show({
    title: 'Learning',
    message: activity.message,
    variant,
    duration: activity.kind.endsWith('started') ? 2500 : 5000
  })
}

export default Plugin.define({
  id: 'github.learning_skills.tui',
  setup(context) {
    const location = context.location ?? context.data.location.default()
    const rpc = createLearningClient(context)
    const stopActivity = rpc.events.on('activity', (event) => {
      if (event.location.directory === location.directory) {
        activityToast(context, event.data)
      }
    })

    context.keymap.layer(() => ({
      mode: 'global',
      commands: [
        {
          id: 'learning.review',
          title: 'Review session for a reusable skill',
          group: 'Learning',
          slash: { name: 'learn' },
          run: async () => runReview(context, rpc)
        },
        {
          id: 'learning.pending',
          title: 'Show pending skill proposals',
          group: 'Learning',
          slash: { name: 'learn-pending', arguments: true },
          run: async (input) => showPending(context, rpc, input)
        },
        {
          id: 'learning.approve',
          title: 'Approve a pending skill proposal',
          group: 'Learning',
          slash: { name: 'learn-approve', arguments: true },
          run: async (input) => approve(context, rpc, input)
        },
        {
          id: 'learning.reject',
          title: 'Reject a pending skill proposal',
          group: 'Learning',
          slash: { name: 'learn-reject', arguments: true },
          run: async (input) => reject(context, rpc, input)
        },
        {
          id: 'learning.promote',
          title: 'Promote a project skill globally',
          group: 'Learning',
          slash: { name: 'learn-promote', arguments: true },
          run: async (input) => promote(context, rpc, input)
        }
      ]
    }))

    return stopActivity
  }
})
