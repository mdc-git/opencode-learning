import { SESSION_ID_KEY } from './shared.ts'
import type { OpenCodeContext } from './sdk.ts'

const COMMANDS = [
  {
    name: 'learn',
    description: 'Force a procedural-learning review of this session',
    template:
      'Call `learning_request_review` exactly once with `force=true`. Then report that the review is scheduled and that staged changes can be inspected with `/learn-pending`.'
  },
  {
    name: 'learn-pending',
    description: 'List staged learned-skill proposals',
    template:
      'Call `learning_pending` with `action=list`. Summarize the returned proposal IDs, target skills, decisions, confidence, and reasons. Do not apply anything.'
  },
  {
    name: 'learn-show',
    description: 'Inspect one staged learned-skill proposal',
    template:
      'Call `learning_pending` with `action=show` and `id=$1`. Show the proposal, validation result, and before/after preview without applying it.'
  },
  {
    name: 'learn-approve',
    description: 'Apply one staged learned-skill proposal',
    template:
      'Call `learning_apply` with `id=$1`. Report exactly which skill was created or patched and whether the skill registry reloaded successfully.'
  },
  {
    name: 'learn-reject',
    description: 'Reject one staged learned-skill proposal',
    template:
      'Call `learning_pending` with `action=reject` and `id=$1`. Report the rejected proposal ID.'
  },
  {
    name: 'learn-status',
    description: 'Show procedural-learning configuration and telemetry',
    template:
      'Call `learning_status` and summarize whether automatic learning is enabled, the current mode and thresholds, pending proposal count, owned learned skills, and recent review outcomes.'
  },
  {
    name: 'learn-curate',
    description: 'Run learned-skill stale/archive curation now',
    template:
      'Call `learning_curate` with `force=true`. Report skills marked stale and skills archived. Do not delete anything permanently.'
  },
  {
    name: 'learn-promote',
    description: 'Promote one owned project skill to the global skill registry',
    template:
      'Call `learning_promote` with `skillId=$1`. This is an explicit cross-project publication action. Report the project source and global destination, or the exact reason promotion was refused.'
  }
]

export async function registerCommands(ctx: OpenCodeContext): Promise<void> {
  await ctx.command.transform((commands) => {
    for (const { name, description, template } of COMMANDS) {
      commands.add({
        name,
        description,
        async execute({ sessionID, prompt, delivery }) {
          await ctx.session.prompt({
            [SESSION_ID_KEY]: sessionID,
            text: template.replaceAll('$1', () => prompt.text?.trim() ?? ''),
            delivery
          })
        }
      })
    }
  })
}
