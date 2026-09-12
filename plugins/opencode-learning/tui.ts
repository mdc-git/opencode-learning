import { Plugin } from '@opencode/plugin/tui'
import { learningRpc, type LearningActivity } from './rpc.ts'

type Context = Plugin.Context

function createLearningClient(context: Context) {
  return context.client.rpc(learningRpc)
}

type LearningClient = ReturnType<typeof createLearningClient>
type ProposalDetail = Awaited<ReturnType<LearningClient['proposal']>>

function currentSession(context: Context): string | undefined {
  const route = context.ui.router.current()
  return route.type === 'session' ? route.sessionID : undefined
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

async function withSession(
  context: Context,
  operation: (sessionId: string) => Promise<void>
): Promise<void> {
  const sessionId = currentSession(context)
  if (sessionId === undefined) {
    context.ui.toast.show({
      title: 'Learning',
      message: 'Open a root session to use learning commands.',
      variant: 'warning'
    })
    return
  }

  try {
    await operation(sessionId)
  } catch (error) {
    showError(context, error)
  }
}

function commandArgument(input?: string): string | undefined {
  const value = input?.trim() ?? ''
  return value === '' ? undefined : value
}

async function withArgument(
  context: Context,
  input: string | undefined,
  operation: (sessionId: string, value: string) => Promise<void>
): Promise<void> {
  const value = commandArgument(input)
  if (value === undefined) {
    return
  }

  await withSession(context, async (sessionId) => operation(sessionId, value))
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

async function showProposal(
  context: Context,
  rpc: LearningClient,
  sessionId: string,
  id: string
): Promise<void> {
  const detail = await rpc.proposal({ sessionId, id })
  await context.ui.dialog.alert({
    title: `${detail.kind} ${detail.skillId}`,
    message: detailText(detail)
  })
}

async function selectPending(
  context: Context,
  rpc: LearningClient,
  sessionId: string
): Promise<void> {
  const proposals = await rpc.pending({ sessionId })
  if (proposals.length === 0) {
    context.ui.toast.show({ title: 'Learning', message: 'No pending proposals.', variant: 'info' })
    return
  }

  const selected = await context.ui.dialog.select<string>({
    title: 'Pending skill proposals',
    options: proposals.map((proposal) => ({
      title: proposal.invalid ? `${proposal.id} invalid` : `${proposal.kind} ${proposal.skillId}`,
      description: proposal.reason,
      value: proposal.id
    }))
  })
  if (typeof selected === 'string') {
    await showProposal(context, rpc, sessionId, selected)
  }
}

async function showPending(context: Context, rpc: LearningClient, input?: string): Promise<void> {
  const id = commandArgument(input)
  await withSession(context, async (sessionId) => {
    if (id !== undefined) {
      await showProposal(context, rpc, sessionId, id)
      return
    }

    await selectPending(context, rpc, sessionId)
  })
}

async function runReview(context: Context, rpc: LearningClient): Promise<void> {
  await withSession(context, async (sessionId) => {
    const result = await rpc.review({ sessionId })
    if (result.status === 'staged') {
      return
    }

    context.ui.toast.show({
      title: 'Learning',
      message: result.message,
      variant: result.status === 'cap' ? 'warning' : 'info',
      duration: 5000
    })
  })
}

async function approve(context: Context, rpc: LearningClient, input?: string): Promise<void> {
  await withArgument(context, input, async (sessionId, id) => {
    const result = await rpc.approve({ sessionId, id })
    context.ui.toast.show({
      title: 'Learning',
      message: `Approved ${result.skillId}.`,
      variant: 'success'
    })
  })
}

async function reject(context: Context, rpc: LearningClient, input?: string): Promise<void> {
  await withArgument(context, input, async (sessionId, id) => {
    await rpc.reject({ sessionId, id })
    context.ui.toast.show({ title: 'Learning', message: `Rejected ${id}.`, variant: 'success' })
  })
}

async function promote(context: Context, rpc: LearningClient, input?: string): Promise<void> {
  await withArgument(context, input, async (sessionId, skillId) => {
    await rpc.promote({ sessionId, skillId })
    context.ui.toast.show({
      title: 'Learning',
      message: `Promoted ${skillId}.`,
      variant: 'success'
    })
  })
}

function activityVariant(activity: LearningActivity): 'info' | 'success' | 'warning' | 'error' {
  const variants: Partial<Record<LearningActivity['kind'], 'error' | 'success' | 'warning'>> = {
    'review-failed': 'error',
    'proposal-staged': 'success',
    'pending-limit': 'warning',
    'review-skipped': 'warning'
  } as const
  return variants[activity.kind] ?? (activity.message.startsWith('rejected:') ? 'warning' : 'info')
}

function activityToast(context: Context, activity: LearningActivity): void {
  context.ui.toast.show({
    title: 'Learning',
    message: activity.message,
    variant: activityVariant(activity),
    duration: activity.kind.endsWith('started') ? 2500 : 5000
  })
}

function learningCommands(context: Context, rpc: LearningClient) {
  return [
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
      slash: { name: 'learn-pending', arguments: true as const },
      run: async (input?: string) => showPending(context, rpc, input)
    },
    {
      id: 'learning.approve',
      title: 'Approve a pending skill proposal',
      group: 'Learning',
      slash: { name: 'learn-approve', arguments: true as const },
      run: async (input?: string) => approve(context, rpc, input)
    },
    {
      id: 'learning.reject',
      title: 'Reject a pending skill proposal',
      group: 'Learning',
      slash: { name: 'learn-reject', arguments: true as const },
      run: async (input?: string) => reject(context, rpc, input)
    },
    {
      id: 'learning.promote',
      title: 'Promote a project skill globally',
      group: 'Learning',
      slash: { name: 'learn-promote', arguments: true as const },
      run: async (input?: string) => promote(context, rpc, input)
    }
  ]
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
    const stopCommands = context.ui.slot({
      append: 'app',
      render() {
        context.keymap.layer(() => ({
          mode: 'global',
          commands: learningCommands(context, rpc)
        }))
        return null
      }
    })

    return () => {
      stopCommands()
      stopActivity()
    }
  }
})
