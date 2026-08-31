import path from 'node:path'
import { daysSince, readJson, writeJson } from './shared.ts'
import type { CuratorConfig, LearningConfig } from './types.ts'
import type { OwnedSkill, SkillStore } from './store.ts'
import type { SkillTelemetry, Telemetry } from './telemetry.ts'
import type { CuratorResult } from './review-types.ts'

export class Curator {
  private readonly config: LearningConfig
  private readonly store: SkillStore
  private readonly telemetry: Telemetry
  private readonly stateFile: string

  constructor({
    config,
    store,
    telemetry
  }: {
    config: LearningConfig
    store: SkillStore
    telemetry: Telemetry
  }) {
    this.config = config
    this.store = store
    this.telemetry = telemetry
    this.stateFile = path.join(store.stateRoot, 'curator.json')
  }

  async maybeRun({ force = false }: { force?: boolean } = {}): Promise<CuratorResult> {
    if (!this.config.curator.enabled) {
      return { skipped: 'disabled' }
    }

    const state = await readJson(this.stateFile, { lastRunAt: 0 })
    if (isCurationIntervalActive(state.lastRunAt, force, this.config.curator.checkEveryHours)) {
      return { skipped: 'interval' }
    }

    const curationResult = await this.run()
    await writeJson(this.stateFile, { lastRunAt: Date.now(), result: curationResult })
    return curationResult
  }

  async run(): Promise<{ stale: string[]; archived: string[] }> {
    const owned = await this.store.listOwned('project')
    const states = await Promise.all(
      owned.map(async (item) =>
        curateOwnedSkill(this.store, this.telemetry, item, this.config.curator)
      )
    )
    const archived = states.flatMap((state) => (state.state === 'archived' ? [state.id] : []))
    const stale = states.flatMap((state) => (state.state === 'stale' ? [state.id] : []))

    await this.telemetry.flush()
    return { stale, archived }
  }
}

function isCurationIntervalActive(
  lastRunAt: number,
  isForced: boolean,
  checkEveryHours: number
): boolean {
  const hours = (Date.now() - lastRunAt) / 36e5
  return !isForced && lastRunAt > 0 && hours < checkEveryHours
}

async function curateOwnedSkill(
  store: SkillStore,
  telemetry: Telemetry,
  item: OwnedSkill,
  config: CuratorConfig
): Promise<{ id: string; state: 'archived' | 'stale' | 'active' | undefined }> {
  const meta = telemetry.state.skills[item.skillId]
  const age = skillAge(meta)
  return curateByAge({ store, meta, skillId: item.skillId, age, config })
}

function skillAge(meta: SkillTelemetry | undefined): number {
  return daysSince(meta?.updatedAt ?? meta?.createdAt ?? Date.now())
}

async function curateByAge({
  store,
  meta,
  skillId,
  age,
  config
}: {
  store: SkillStore
  meta: SkillTelemetry | undefined
  skillId: string
  age: number
  config: CuratorConfig
}): Promise<{ id: string; state: 'archived' | 'stale' | 'active' | undefined }> {
  if (age >= config.archiveAfterDays) {
    return archiveOwnedSkill(store, meta, skillId)
  }

  const state = age >= config.staleAfterDays ? 'stale' : 'active'
  if (meta !== undefined) {
    meta.state = state
  }

  return { id: skillId, state }
}

async function archiveOwnedSkill(
  store: SkillStore,
  meta: SkillTelemetry | undefined,
  skillId: string
): Promise<{ id: string; state: 'archived' | 'stale' | 'active' | undefined }> {
  const isArchived = await store.archive(skillId, { scope: 'project' })
  if (!isArchived) {
    return { id: skillId, state: undefined }
  }

  if (meta !== undefined) {
    meta.state = 'archived'
  }

  return { id: skillId, state: 'archived' }
}
