import fs from 'node:fs/promises'
import path from 'node:path'
import type { ExperienceRecorder } from './recorder.ts'
import { ReviewPipeline } from './review-scheduling.ts'
import type { ReviewState } from './review-state.ts'
import { Curator } from './review-curator.ts'
import { SkillStore } from './store.ts'
import { Telemetry } from './telemetry.ts'
import type { InternalMailbox } from './mailbox.ts'
import type { OpenCodeContext, SessionInfo } from './sdk.ts'
import type { LearningConfig } from './types.ts'

export type Runtime = {
  directory: string
  store: SkillStore
  recorder: ExperienceRecorder
  telemetry: Telemetry
  curator: Curator
  pipeline: ReviewPipeline
  ready: Promise<Runtime>
}

export type SessionRuntimeFor = (sessionID: string, session?: SessionInfo) => Promise<Runtime>

export function createRuntime({
  ctx,
  directory,
  config,
  mailbox,
  recorder,
  reviewState
}: {
  ctx: OpenCodeContext
  directory: string
  config: LearningConfig
  mailbox: InternalMailbox
  recorder: ExperienceRecorder
  reviewState: ReviewState
}): Runtime {
  const store = new SkillStore({
    projectRoot: directory,
    projectSkillDir: config.projectSkillDir,
    globalSkillDir: config.globalSkillDir,
    stateDir: config.stateDir
  })
  // Runtime fields are populated by the promise below; this assertion preserves the cyclic setup.
  const runtime = { directory, store, recorder } as unknown as Runtime
  runtime.ready = new Telemetry(store.stateRoot).load().then((telemetry) => {
    runtime.telemetry = telemetry
    runtime.curator = new Curator({ config, store, telemetry })
    runtime.pipeline = new ReviewPipeline({
      ctx,
      recorder,
      store,
      telemetry,
      mailbox,
      config,
      state: reviewState
    })
    runCuratorWhenReady(runtime, ctx.skill.reload)
    return runtime
  })
  return runtime
}

export async function canonicalDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  try {
    return await fs.realpath(resolved)
  } catch {
    return resolved
  }
}

export function runCuratorWhenReady(runtime: Runtime, reload: () => Promise<void>): void {
  void runtime.ready
    .then(async ({ curator }) => {
      const result = await curator.maybeRun()
      if ('archived' in result && result.archived.length > 0) {
        await reload()
      }
    })
    .catch((error: unknown) => {
      console.error('[opencode-learning] curator failed', error)
    })
}
