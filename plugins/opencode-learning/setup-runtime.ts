import fs from 'node:fs/promises'
import path from 'node:path'
import { ExperienceRecorder } from './recorder.ts'
import { Curator, ReviewPipeline } from './review.ts'
import { SkillStore } from './store.ts'
import { Telemetry } from './telemetry.ts'
import type { InternalMailbox } from './mailbox.ts'
import type { OpenCodeContext, SessionInfo, TerminalEvent } from './sdk.ts'
import type { LearningConfig } from './types.ts'
import type { Runtime } from './setup-types.ts'

export function createRuntime({
  ctx,
  directory,
  config,
  mailbox
}: {
  ctx: OpenCodeContext
  directory: string
  config: LearningConfig
  mailbox: InternalMailbox
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

export async function canonicalDirectory(directory: string): Promise<string> {
  const resolved = path.resolve(directory)
  try {
    return await fs.realpath(resolved)
  } catch {
    return resolved
  }
}

export function terminalDirectory(
  event: TerminalEvent,
  sessionID: string,
  session: SessionInfo,
  sessionDirectories: Map<string, string>
): string | undefined {
  return nonEmptyDirectory(eventDirectory(event, session, sessionDirectories, sessionID))
}

function eventDirectory(
  event: TerminalEvent,
  session: SessionInfo,
  sessionDirectories: Map<string, string>,
  sessionID: string
): string | undefined {
  return (
    event.location?.directory ?? session.location.directory ?? sessionDirectories.get(sessionID)
  )
}

function nonEmptyDirectory(directory: string | undefined): string | undefined {
  return directory === undefined || directory.length === 0 ? undefined : directory
}
