import type { Options as ToolOptions, ToolContext } from '@opencode-ai/plugin/promise/tool'
import type { InternalMailbox } from './mailbox.ts'
import { proposalInputSchema, validationInputSchema } from './store.ts'
import type { LearningToolInfo, OpenCodeContext } from './sdk.ts'
import type { LearningConfig, Proposal, ValidationSubmission } from './types.ts'
import type {
  AddLearningTool,
  ForegroundSessionFor,
  IdInput,
  RegisterToolsOptions,
  ReviewInput,
  SessionRuntimeFor,
  SkillIdInput
} from './setup-types.ts'
import { addPendingTool } from './setup-tool-pending.ts'
import {
  componentStatus,
  objectOutput,
  recordAppliedTelemetry,
  result
} from './setup-tool-helpers.ts'

function addCallbackTools(
  add: AddLearningTool,
  config: LearningConfig,
  mailbox: InternalMailbox
): void {
  add(
    'submit_proposal',
    {
      description:
        'Internal reflector-only tool. Submit exactly one structured procedural-skill proposal.',
      input: proposalInputSchema,
      output: objectOutput(),
      async execute(proposal: Proposal, toolCtx: ToolContext) {
        enforceAgent(toolCtx, config.reflectorAgent, 'proposal')
        mailbox.submit(toolCtx.sessionID, 'proposal', proposal)
        return result({ accepted: true }, 'Proposal received.')
      }
    },
    { namespace: 'learning', codemode: false }
  )
  add(
    'submit_validation',
    {
      description:
        'Internal validator-only tool. Submit exactly one structured procedural-skill validation.',
      input: validationInputSchema,
      output: objectOutput(),
      async execute(validation: ValidationSubmission, toolCtx: ToolContext) {
        enforceAgent(toolCtx, config.validatorAgent, 'validation')
        mailbox.submit(toolCtx.sessionID, 'validation', validation)
        return result({ accepted: true }, 'Validation received.')
      }
    },
    { namespace: 'learning', codemode: false }
  )
}

function addReviewTool(
  add: AddLearningTool,
  config: LearningConfig,
  runtimeForSession: SessionRuntimeFor,
  foregroundSessionFor: ForegroundSessionFor
): void {
  add(
    'request_review',
    {
      description: 'Schedule a procedural-learning review after the current turn becomes idle.',
      input: {
        type: 'object',
        properties: { force: { type: 'boolean' } },
        additionalProperties: false
      },
      output: objectOutput(),
      async execute({ force = false }: ReviewInput, toolCtx: ToolContext) {
        const session = await foregroundSessionFor(toolCtx.sessionID)
        if (session === undefined) {
          return result(
            { scheduled: false, force, reason: 'foreground sessions only' },
            'Learning review is available only for foreground sessions.'
          )
        }

        const { pipeline } = await runtimeForSession(toolCtx.sessionID, session)
        const scheduled = pipeline.schedule(toolCtx.sessionID, { force })
        return result(
          scheduled,
          scheduled.scheduled === true
            ? force
              ? 'Forced learning review scheduled after this turn.'
              : 'Learning review scheduled after this turn.'
            : 'Learning review was not scheduled.'
        )
      }
    },
    { namespace: 'learning', codemode: false }
  )
}

function addApplyTool(
  add: AddLearningTool,
  ctx: OpenCodeContext,
  config: LearningConfig,
  runtimeForSession: SessionRuntimeFor
): void {
  add(
    'apply',
    {
      description: 'Apply one staged learned-skill proposal.',
      input: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false
      },
      output: objectOutput(),
      async execute({ id }: IdInput, toolCtx: ToolContext) {
        const { store, telemetry } = await runtimeForSession(toolCtx.sessionID)
        const applied = await store.applyPending(id, {
          confidenceThreshold: config.confidenceThreshold
        })
        const skillId = applied.proposal?.skillId
        await recordAppliedTelemetry(telemetry, applied)
        await ctx.skill.reload()
        return result(
          { applied: id, skillId, result: applied.result, reloaded: true },
          `Applied ${id} to ${skillId} and reloaded skills.`
        )
      }
    },
    { namespace: 'learning', codemode: false }
  )
}

function addPromoteTool(
  add: AddLearningTool,
  ctx: OpenCodeContext,
  runtimeForSession: SessionRuntimeFor
): void {
  add(
    'promote',
    {
      description:
        'Explicitly promote one plugin-owned project skill into the global OpenCode skill registry.',
      input: {
        type: 'object',
        properties: { skillId: { type: 'string' } },
        required: ['skillId'],
        additionalProperties: false
      },
      output: objectOutput(),
      async execute({ skillId }: SkillIdInput, toolCtx: ToolContext) {
        const { store } = await runtimeForSession(toolCtx.sessionID)
        const promoted = await store.promote(skillId)
        await ctx.skill.reload()
        return result(
          { ...promoted, reloaded: true },
          `Promoted ${skillId} to global skills and reloaded the skill registry.`
        )
      }
    },
    { namespace: 'learning', codemode: false }
  )
}

function addStatusTool(
  add: AddLearningTool,
  ctx: OpenCodeContext,
  config: LearningConfig,
  runtimeForSession: SessionRuntimeFor
): void {
  add(
    'status',
    {
      description:
        'Show procedural-learning configuration, native component availability, owned skills, pending proposals, and recent reviews.',
      input: { type: 'object', properties: {}, additionalProperties: false },
      output: objectOutput(),
      async execute(_: unknown, toolCtx: ToolContext) {
        const { directory, store, telemetry } = await runtimeForSession(toolCtx.sessionID)
        const [projectSkills, pending, components] = await Promise.all([
          store.listOwned('project'),
          store.listPending(),
          componentStatus(ctx, config)
        ])
        const output = {
          enabled: config.enabled,
          mode: config.mode,
          scoreThreshold: config.scoreThreshold,
          triggerVersion: 2,
          workflowCooldownTurns: config.workflowCooldownTurns,
          confidenceThreshold: config.confidenceThreshold,
          agentValidation: config.agentValidation,
          globalWrites: 'explicit-promotion-only',
          projectRoot: directory,
          projectSkillDir: store.projectRootSkills,
          globalSkillDir: store.globalRootSkills,
          stateDir: store.stateRoot,
          components,
          ownedSkills: projectSkills.map((x) => ({
            id: x.skillId,
            sha256: x.sha256,
            supportingFiles: x.supportingFiles
          })),
          pendingCount: pending.length,
          recentReviews: telemetry.recentReviews(10),
          triggerStats: telemetry.state.triggerStats
        }
        return result(output, JSON.stringify(output, null, 2))
      }
    },
    { namespace: 'learning', codemode: false }
  )
}

function addCurateTool(
  add: AddLearningTool,
  ctx: OpenCodeContext,
  runtimeForSession: SessionRuntimeFor
): void {
  add(
    'curate',
    {
      description:
        'Run deterministic stale/archive maintenance for agent-owned project skills. Never permanently deletes skills.',
      input: {
        type: 'object',
        properties: { force: { type: 'boolean' } },
        additionalProperties: false
      },
      output: objectOutput(),
      async execute({ force = false }: ReviewInput, toolCtx: ToolContext) {
        const { curator } = await runtimeForSession(toolCtx.sessionID)
        const output = await curator.maybeRun({ force })
        if ('archived' in output && output.archived.length > 0) {
          await ctx.skill.reload()
        }

        return result(output, JSON.stringify(output, null, 2))
      }
    },
    { namespace: 'learning', codemode: false }
  )
}

export async function registerTools(
  ctx: OpenCodeContext,
  { config, mailbox, runtimeForSession, foregroundSessionFor }: RegisterToolsOptions
): Promise<void> {
  await ctx.tool.transform((tools) => {
    const add = (name: string, info: LearningToolInfo, options: ToolOptions): void => {
      tools.add({ ...info, name, options })
    }

    addCallbackTools(add, config, mailbox)
    addReviewTool(add, config, runtimeForSession, foregroundSessionFor)
    addPendingTool(add, runtimeForSession)
    addApplyTool(add, ctx, config, runtimeForSession)
    addPromoteTool(add, ctx, runtimeForSession)
    addStatusTool(add, ctx, config, runtimeForSession)
    addCurateTool(add, ctx, runtimeForSession)
  })
}

function enforceAgent(toolCtx: ToolContext, expected: string, kind: string): void {
  if (toolCtx?.agent !== expected) {
    throw new Error(`learning.submit_${kind} is restricted to ${expected}`)
  }
}

export function isLearningTool(name: unknown): boolean {
  return typeof name === 'string' && (name.startsWith('learning.') || name.startsWith('learning_'))
}
