import fs from 'node:fs/promises'
import path from 'node:path'
import type { Options as ToolOptions, ToolContext } from '@opencode-ai/plugin/promise/tool'
import { EventBus, interruptSession } from './events.ts'
import { InternalMailbox } from './mailbox.ts'
import { ExperienceRecorder } from './recorder.ts'
import { Curator, ReviewPipeline } from './review.ts'
import { proposalInputSchema, SkillStore, validationInputSchema } from './store.ts'
import { Telemetry } from './telemetry.ts'
import { isRecord, SESSION_ID_KEY } from './shared.ts'
import type {
  AddLearningTool,
  ComponentStatus,
  ForegroundSessionFor,
  IdInput,
  LearningConfig,
  LearningToolInfo,
  MailboxLike,
  OpenCodeContext,
  PendingInput,
  ReviewInput,
  Runtime,
  SessionInfo,
  SessionRuntimeFor,
  SkillIdInput,
  TerminalEvent,
  ValidationSubmission,
  Proposal,
  RegisterToolsOptions,
  UnknownRecord
} from './types.ts'

export class LearningSetup {
  readonly ctx: OpenCodeContext
  readonly config: LearningConfig
  readonly mailbox = new InternalMailbox()
  readonly eventBus: EventBus
  readonly runtimes = new Map<string, Runtime>()
  readonly sessionRuntimes = new Map<string, Runtime>()
  readonly sessionDirectories = new Map<string, string>()
  readonly sessionInfo = new Map<string, SessionInfo>()
  readonly sessionEventChains = new Map<string, Promise<void>>()
  isSessionEventsStopped = false
  curatorTimer: ReturnType<typeof setInterval> | undefined
  removeTerminalListener: (() => boolean) | undefined

  constructor(ctx: OpenCodeContext, config: LearningConfig) {
    this.ctx = ctx
    this.config = config
    this.eventBus = new EventBus(ctx)
  }

  async setup(): Promise<() => Promise<void>> {
    await registerAgents(this.ctx, this.config)
    await registerTools(this.ctx, {
      config: this.config,
      mailbox: this.mailbox,
      runtimeForSession: async (sessionID, session) => this.runtimeForSession(sessionID, session),
      foregroundSessionFor: async (sessionID) => this.foregroundSessionFor(sessionID)
    })
    await registerCommands(this.ctx)
    this.eventBus.start()
    this.removeTerminalListener = this.eventBus.onTerminal((event) => {
      void this.handleTerminal(event).catch((error: unknown) => {
        console.error('[opencode-learning] terminal event routing failed', error)
      })
    })
    await this.registerHooks()
    this.startCuratorTimer()
    return async () => this.cleanup()
  }

  async registerHooks(): Promise<void> {
    await this.registerContextHook()
    await this.registerToolBeforeHook()
    await this.registerToolAfterHook()
  }

  async registerContextHook(): Promise<void> {
    await this.ctx.session.hook('context', async (event) => {
      await this.enqueueSessionEvent(event?.sessionID, async () => {
        const session = await this.foregroundSessionFor(event?.sessionID)
        if (session === undefined) {
          return
        }

        const runtime = await this.runtimeForSession(event.sessionID, session)
        runtime.recorder.observeContext(event)
      })
    })
  }

  async registerToolBeforeHook(): Promise<void> {
    await this.ctx.tool.hook('execute.before', async (event) => {
      if (event.sessionID.length === 0 || isLearningTool(event.tool)) {
        return
      }

      await this.enqueueSessionEvent(event.sessionID, async () => {
        const session = await this.foregroundSessionFor(event.sessionID)
        if (session === undefined) {
          return
        }

        const runtime = await this.runtimeForSession(event.sessionID, session)
        runtime.recorder.toolBefore(event)
      })
    })
  }

  async registerToolAfterHook(): Promise<void> {
    await this.ctx.tool.hook('execute.after', async (event) => {
      if (event.sessionID.length === 0 || isLearningTool(event.tool)) {
        return
      }

      await this.enqueueSessionEvent(event.sessionID, async () => {
        const session = await this.foregroundSessionFor(event.sessionID)
        if (session === undefined) {
          return
        }

        const runtime = await this.runtimeForSession(event.sessionID, session)
        if (runtime.recorder.toolAfter(event) !== undefined) {
          this.recordRuntimeSkillUse(runtime, event)
        }
      })
    })
  }

  recordRuntimeSkillUse(runtime: Runtime, event: { tool: string; input: unknown }): void {
    if (event.tool !== 'skill' || !isRecord(event.input)) {
      return
    }

    const skillId = event.input.name ?? event.input.id ?? event.input.skill
    if (typeof skillId === 'string') {
      void runtime.telemetry.recordUse(skillId).catch(console.error)
    }
  }

  async enqueueSessionEvent(
    sessionID: string | undefined,
    task: () => Promise<void> | void
  ): Promise<void> {
    if (sessionID === undefined || sessionID.length === 0 || this.isSessionEventsStopped) {
      return
    }

    const previous = this.sessionEventChains.get(sessionID) ?? Promise.resolve()
    const next = previous
      .catch((error: unknown) => {
        console.error('[opencode-learning] session event failed', error)
      })
      .then(task)
    this.sessionEventChains.set(sessionID, next)
    const clear = () => {
      if (this.sessionEventChains.get(sessionID) === next) {
        this.sessionEventChains.delete(sessionID)
      }
    }

    void next.then(clear).catch(clear)
    return next
  }

  async sessionInfoFor(sessionID: string): Promise<SessionInfo> {
    if (!this.sessionInfo.has(sessionID)) {
      this.sessionInfo.set(sessionID, await this.ctx.session.get({ [SESSION_ID_KEY]: sessionID }))
    }

    return this.sessionInfo.get(sessionID)!
  }

  async foregroundSessionFor(sessionID: string | undefined): Promise<SessionInfo | undefined> {
    if (
      sessionID === undefined ||
      sessionID.length === 0 ||
      this.mailbox.isInternalSession(sessionID)
    ) {
      return undefined
    }

    const session = await this.sessionInfoFor(sessionID)
    return session.parentID === undefined || session.parentID.length === 0 ? session : undefined
  }

  async runtimeForSession(sessionID: string, session?: SessionInfo): Promise<Runtime> {
    const existing = this.sessionRuntimes.get(sessionID)
    if (existing !== undefined) {
      await existing.ready
      return existing
    }

    session ??= await this.sessionInfoFor(sessionID)
    const directory = await this.resolveSessionDirectory(sessionID, session)
    let runtime = this.runtimes.get(directory)
    if (runtime === undefined) {
      runtime = createRuntime({
        ctx: this.ctx,
        directory,
        config: this.config,
        mailbox: this.mailbox
      })
      this.runtimes.set(directory, runtime)
    }

    this.sessionDirectories.set(sessionID, directory)
    this.sessionRuntimes.set(sessionID, runtime)
    await runtime.ready
    return runtime
  }

  async resolveSessionDirectory(sessionID: string, session: SessionInfo): Promise<string> {
    const directory = session.location.directory ?? this.sessionDirectories.get(sessionID)
    if (directory === undefined || directory.length === 0) {
      throw new Error(`session ${sessionID} has no project directory`)
    }

    return canonicalDirectory(directory)
  }

  async handleTerminal(event: TerminalEvent): Promise<void> {
    await this.enqueueSessionEvent(event.sessionID, async () => {
      const runtime = await this.runtimeForTerminal(event)
      if (runtime === undefined) {
        return
      }

      await runtime.ready
      const experience = runtime.recorder.finishTurn(event.sessionID, event.type, event.eventID)
      if (experience !== undefined) {
        runtime.pipeline.executionFinished(event.sessionID, { terminalType: event.type })
      }
    })
  }

  async runtimeForTerminal(event: TerminalEvent): Promise<Runtime | undefined> {
    const existing = this.sessionRuntimes.get(event.sessionID)
    if (existing !== undefined) {
      return existing
    }

    const session = await this.foregroundSessionFor(event.sessionID)
    if (session === undefined) {
      return undefined
    }

    const eventDirectory =
      event.location?.directory ??
      session.location.directory ??
      this.sessionDirectories.get(event.sessionID)
    if (eventDirectory === undefined || eventDirectory.length === 0) {
      return undefined
    }

    const directory = await canonicalDirectory(eventDirectory)
    const runtime = this.runtimes.get(directory)
    if (runtime !== undefined) {
      this.sessionDirectories.set(event.sessionID, directory)
      this.sessionRuntimes.set(event.sessionID, runtime)
    }

    return runtime
  }

  startCuratorTimer(): void {
    this.curatorTimer = setInterval(
      () => {
        for (const runtime of this.runtimes.values()) {
          void runtime.curator.maybeRun().catch((error: unknown) => {
            console.error('[opencode-learning] curator failed', error)
          })
        }
      },
      Math.max(1, this.config.curator.checkEveryHours) * 36e5
    )
    this.curatorTimer.unref?.()
  }

  async cleanup(): Promise<void> {
    if (this.curatorTimer !== undefined) {
      clearInterval(this.curatorTimer)
    }

    this.removeTerminalListener?.()
    this.isSessionEventsStopped = true
    await Promise.allSettled(this.sessionEventChains.values())
    this.sessionEventChains.clear()
    const runtimeCleanups: Array<Promise<void>> = []
    this.runtimes.forEach((runtime) => {
      runtimeCleanups.push(this.cleanupRuntime(runtime))
    })
    await Promise.allSettled(runtimeCleanups)
    await Promise.allSettled(
      this.mailbox.sessionIds().map(async (sessionID) => interruptSession(this.ctx, sessionID))
    )
    this.mailbox.clear()
    this.sessionRuntimes.clear()
    this.sessionDirectories.clear()
    this.sessionInfo.clear()
    for (const runtime of this.runtimes.values()) {
      runtime.recorder.clear()
    }

    this.runtimes.clear()
    await this.eventBus.dispose()
  }

  async cleanupRuntime(runtime: Runtime): Promise<void> {
    await runtime.ready
    await runtime.pipeline.cleanup()
  }
}

function createRuntime({
  ctx,
  directory,
  config,
  mailbox
}: {
  ctx: OpenCodeContext
  directory: string
  config: LearningConfig
  mailbox: MailboxLike
}): Runtime {
  const store = new SkillStore({
    projectRoot: directory,
    projectSkillDir: config.projectSkillDir,
    globalSkillDir: config.globalSkillDir,
    stateDir: config.stateDir
  })
  const recorder = new ExperienceRecorder({ maxEventsPerSession: config.maxEventsPerSession })
  // Runtime fields are populated by the promise below; this assertion preserves the cyclic setup.
  const runtime = { directory, store, recorder } as unknown as Runtime
  runtime.ready = new Telemetry(store.stateRoot).load().then((telemetry) => {
    runtime.telemetry = telemetry
    runtime.curator = new Curator({ config, store, telemetry })
    runtime.pipeline = new ReviewPipeline({ ctx, recorder, store, telemetry, mailbox, config })
    void runtime.curator.maybeRun().catch((error: unknown) => {
      console.error('[opencode-learning] curator failed', error)
    })
    return runtime
  })
  return runtime
}

async function canonicalDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  try {
    return await fs.realpath(resolved)
  } catch {
    return resolved
  }
}

function addCallbackTools(
  add: AddLearningTool,
  config: LearningConfig,
  mailbox: MailboxLike
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

function addPendingTool(add: AddLearningTool, runtimeForSession: SessionRuntimeFor): void {
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
      async execute({ action, id }: PendingInput, toolCtx: ToolContext) {
        const { store } = await runtimeForSession(toolCtx.sessionID)
        if (action === 'list') {
          const pending = await store.listPending()
          const compact = pending.map((x) => ({
            id: x.id,
            decision: x.proposal?.decision,
            skillId: x.proposal?.skillId,
            scope: x.proposal?.scope,
            reason: x.proposal?.reason,
            confidence: x.proposal?.confidence,
            validation: x.validation
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
    },
    { namespace: 'learning', codemode: false }
  )
}

function addApplyTool(
  add: AddLearningTool,
  ctx: OpenCodeContext,
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
        const applied = await store.applyPending(id)
        const skillId = applied.proposal?.skillId
        const appliedResult = isRecord(applied.result) ? applied.result : {}
        if (typeof skillId === 'string' && appliedResult.file !== undefined) {
          if (applied.proposal.decision === 'create') {
            await telemetry.recordCreated(skillId)
          } else if (applied.proposal.decision === 'patch') {
            await telemetry.recordPatched(skillId)
          }
        }

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

async function registerTools(
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
    addApplyTool(add, ctx, runtimeForSession)
    addPromoteTool(add, ctx, runtimeForSession)
    addStatusTool(add, ctx, config, runtimeForSession)
    addCurateTool(add, ctx, runtimeForSession)
  })
}

const REFLECTOR_SYSTEM = `You are the procedural-learning reflector for OpenCode.

Your task is not to summarize a session. Decide whether the supplied completed experience contains durable procedural knowledge worth reusing in future coding sessions.

## Worth learning

Prefer lessons supported by concrete trajectory evidence:

- a user correction that changes how a task should be done in future;
- a non-obvious failure followed by a verified recovery;
- a reusable multi-step workflow discovered during the task;
- a verification sequence that prevented or caught a likely mistake;
- an existing learned skill that proved incomplete, too broad, or wrong.

Do not persist:

- unexplained or one-off failures;
- temporary paths, timestamps, process IDs, ephemeral ports, generated IDs, usernames, or machine-specific values;
- credentials, secrets, tokens, private keys, cookies, or authentication material;
- speculation unsupported by the completed trajectory;
- facts that belong in project instructions rather than a reusable procedure;
- a narrow new skill when an existing agent-owned skill can be improved.

## Decision order

1. If an agent-owned skill was used and evidence shows it should change, patch it.
2. Otherwise prefer patching a relevant agent-owned umbrella skill.
3. Create a new skill only when the procedure is reusable and no owned candidate fits.
4. Otherwise submit \`decision=none\`.

Every create or patch proposal must include \`skillId\`. Use lowercase kebab-case with 1-64 characters, for example \`validated-config-loader\`. A display name in \`skill.name\` does not replace \`skillId\`.

You may patch only candidate skills marked \`owned=true\`. For a patch, copy the supplied SHA-256 exactly into \`expectedSha256\`; never invent current skill content.

Use section-level operations only:

- \`replace_section\`: replace an existing \`## Heading\`, or create it if absent.
- \`append_section\`: append a new \`## Heading\`.

For a new skill, \`skill.files\` may add supporting scripts, references, or templates. For a patch, \`addFiles\` may add new supporting files only. Never overwrite or remove an existing supporting file; if existing support material is wrong, patch the SKILL.md procedure to compensate and leave a human-review note in the proposal reason.

Keep generated skills operational. Prefer these sections when useful: \`When to use\`, \`Preconditions\`, \`Procedure\`, \`Pitfalls\`, and \`Verification\`.

Call \`learning_submit_proposal\` exactly once. Do not call any other tool and do not edit files directly.`

const VALIDATOR_SYSTEM = `You are the independent validator for OpenCode procedural-learning proposals.

You receive a completed experience, candidate skill context, and one already schema-validated proposal. Your job is to reject proposals that are not adequately supported by the evidence or that generalize too aggressively.

Accept only when all of these are true:

1. The proposed lesson is directly supported by supplied trajectory evidence.
2. The lesson is reusable beyond the exact run that produced it.
3. It does not encode secrets, transient IDs, temporary paths, usernames, timestamps, or machine-specific state.
4. A patch is consistent with the supplied current skill and does not overwrite unrelated procedure.
5. A create decision is meaningfully distinct from the supplied candidate skills.
6. The procedure contains a verification step when the trajectory provides one.
7. The proposal does not turn an unverified failure into a general rule.

Reject if uncertain. Explain the reason briefly.

Call \`learning_submit_validation\` exactly once with \`decision=accept\` or \`decision=reject\`. Do not call any other tool and do not edit files.`

async function registerAgents(ctx: OpenCodeContext, config: LearningConfig): Promise<void> {
  await ctx.agent.transform((agents) => {
    for (const current of agents.list()) {
      agents.update(String(current.id), (agent) => {
        agent.permissions.push(
          { action: 'learning_submit_proposal', resource: '*', effect: 'deny' },
          { action: 'learning_submit_validation', resource: '*', effect: 'deny' },
          { action: 'learning_apply', resource: '*', effect: 'ask' }
        )
      })
    }

    agents.update(config.reflectorAgent, (agent) => {
      agent.description =
        'Internal reviewer that extracts reusable procedural knowledge from completed sessions'
      agent.mode = 'all'
      agent.hidden = true
      agent.steps = 6
      agent.system = REFLECTOR_SYSTEM
      agent.permissions = [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'learning_submit_proposal', resource: '*', effect: 'allow' }
      ]
    })
    agents.update(config.validatorAgent, (agent) => {
      agent.description = 'Internal validator for proposed learned skill changes'
      agent.mode = 'all'
      agent.hidden = true
      agent.steps = 4
      agent.system = VALIDATOR_SYSTEM
      agent.permissions = [
        { action: '*', resource: '*', effect: 'deny' },
        { action: 'learning_submit_validation', resource: '*', effect: 'allow' }
      ]
    })
  })
}

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

async function registerCommands(ctx: OpenCodeContext): Promise<void> {
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

function enforceAgent(toolCtx: ToolContext, expected: string, kind: string): void {
  if (toolCtx?.agent !== expected) {
    throw new Error(`learning.submit_${kind} is restricted to ${expected}`)
  }
}

async function componentStatus(
  ctx: OpenCodeContext,
  config: LearningConfig
): Promise<ComponentStatus> {
  const out: ComponentStatus = { reflectorAgent: false, validatorAgent: false, commands: {} }
  try {
    const agentResponse = await ctx.agent.list()
    const agents = agentResponse.data
    const ids = new Set(agents.map((x) => x.id))
    out.reflectorAgent = ids.has(config.reflectorAgent)
    out.validatorAgent = ids.has(config.validatorAgent)
  } catch {}

  try {
    const commandResponse = await ctx.command.list()
    const commands = commandResponse.data
    const ids = new Set(commands.map((x) => x.name))
    for (const id of [
      'learn',
      'learn-pending',
      'learn-show',
      'learn-approve',
      'learn-reject',
      'learn-status',
      'learn-curate',
      'learn-promote'
    ]) {
      out.commands[id] = ids.has(id)
    }
  } catch {}

  return out
}

function objectOutput(): { type: 'object'; additionalProperties: boolean } {
  return { type: 'object', additionalProperties: true }
}

function result(output: unknown, content: string): { output: unknown; content: string } {
  return { output: sanitize(output), content }
}

function sanitize(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item))
  }

  if (isRecord(value)) {
    const out: UnknownRecord = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitize(v)
    }

    return out
  }

  return value
}

function isLearningTool(name: unknown): boolean {
  return typeof name === 'string' && (name.startsWith('learning.') || name.startsWith('learning_'))
}
