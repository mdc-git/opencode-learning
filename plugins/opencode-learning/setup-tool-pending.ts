import type { AddLearningTool, PendingInput, SessionRuntimeFor } from './setup-types.ts'
import { objectOutput, result } from './setup-tool-helpers.ts'
import type { SkillStore } from './store.ts'

async function pendingAction(
  store: SkillStore,
  action: PendingInput['action'],
  id: string | undefined
) {
  if (action === 'list') {
    const pending = await store.listPending()
    const compact = pending.map((item) => ({
      id: item.id,
      decision: item.proposal?.decision,
      skillId: item.proposal?.skillId,
      scope: item.proposal?.scope,
      reason: item.proposal?.reason,
      confidence: item.proposal?.confidence,
      validation: item.validation
    }))
    return result({ pending: compact }, JSON.stringify(compact, null, 2))
  }

  if (id === undefined || id.length === 0) {
    throw new Error('id is required for show/apply/reject')
  }

  if (action === 'show') {
    const pending = await store.getPending(id)
    return result(pending, JSON.stringify(pending, null, 2))
  }

  if (action === 'reject') {
    await store.rejectPending(id)
    return result({ rejected: id }, `Rejected ${id}.`)
  }

  throw new Error('unsupported pending action')
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
