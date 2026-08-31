import type { AddLearningTool, PendingInput, SessionRuntimeFor } from './setup-types.ts'
import { objectOutput, result } from './setup-tool-helpers.ts'
import type { SkillStore } from './store.ts'

async function pendingAction(
  store: SkillStore,
  action: PendingInput['action'],
  id: string | undefined
) {
  if (action === 'list') {
    return listPendingResult(store)
  }

  const pendingId = requirePendingId(id)

  if (action === 'show') {
    const pending = await store.getPending(pendingId)
    return result(pending, JSON.stringify(pending, null, 2))
  }

  if (action === 'reject') {
    await store.rejectPending(pendingId)
    return result({ rejected: pendingId }, `Rejected ${pendingId}.`)
  }

  throw new Error('unsupported pending action')
}

async function listPendingResult(store: SkillStore) {
  const pending = await store.listPending()
  const compact = pending.map((item) => compactPending(item))
  return result({ pending: compact }, JSON.stringify(compact, null, 2))
}

function compactPending(item: Awaited<ReturnType<SkillStore['listPending']>>[number]) {
  const { proposal } = item
  if (proposal === undefined) {
    return { id: item.id, validation: item.validation }
  }

  return {
    id: item.id,
    decision: proposal.decision,
    skillId: proposal.skillId,
    scope: proposal.scope,
    reason: proposal.reason,
    confidence: proposal.confidence,
    validation: item.validation
  }
}

function requirePendingId(id: string | undefined): string {
  if (id === undefined || id.length === 0) {
    throw new Error('id is required for show/apply/reject')
  }

  return id
}

export function addPendingTool(add: AddLearningTool, runtimeForSession: SessionRuntimeFor): void {
  add(
    'pending',
    {
      description: 'List, inspect, or reject staged learned-skill proposals.',
      input: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'show', 'reject'] },
          id: { type: 'string' }
        },
        required: ['action'],
        additionalProperties: false
      },
      output: objectOutput(),
      async execute({ action, id }: PendingInput, toolCtx) {
        const { store } = await runtimeForSession(toolCtx.sessionID)
        return pendingAction(store, action, id)
      }
    },
    { namespace: 'learning', codemode: false }
  )
}
