import path from 'node:path'
import { isRecord, readJson, writeJson } from './shared.ts'
import type { ExperienceSnapshot, UnknownRecord } from './types.ts'
import {
  defaultTriggerStats,
  normalizeTelemetryState,
  type SkillTelemetry,
  type TelemetryState,
  type TriggerStats
} from './telemetry-state.ts'
import {
  recordScoreBucket,
  recordTriggerDecision,
  recordTriggerSignals
} from './telemetry-triggers.ts'

export { normalizeTelemetryState } from './telemetry-state.ts'
export type { SkillTelemetry } from './telemetry-state.ts'

function recordSkillExperience(
  skill: SkillTelemetry,
  exp: ExperienceSnapshot,
  isFailures: boolean
): void {
  if (skill.seenSessions.includes(exp.sessionID)) {
    return
  }

  skill.seenSessions.push(exp.sessionID)
  skill.seenSessions = skill.seenSessions.slice(-100)
  skill.observedSessions += 1
  recordSkillOutcome(skill, exp, isFailures)
  skill.updatedAt = Date.now()
}

function recordSkillOutcome(
  skill: SkillTelemetry,
  exp: ExperienceSnapshot,
  isFailures: boolean
): void {
  if (isFailures) {
    skill.sessionsWithErrors += 1
  }

  if (hasRecoveries(exp)) {
    skill.sessionsWithRecovery += 1
  }

  if (hasCorrections(exp)) {
    skill.sessionsWithCorrections += 1
  }
}

function hasRecoveries(exp: ExperienceSnapshot): boolean {
  return (exp.recoveries ?? 0) > 0
}

function hasCorrections(exp: ExperienceSnapshot): boolean {
  return (exp.corrections?.length ?? 0) > 0
}

function scoreField(score: unknown, key: string): unknown {
  return isRecord(score) ? score[key] : undefined
}

function numberOrNull(value: unknown): unknown {
  return typeof value === 'number' ? value : null
}

function recordOrNull(value: unknown): unknown {
  return isRecord(value) ? value : null
}

function arrayOrNull(value: unknown): unknown {
  return Array.isArray(value) ? value : null
}

function reviewTelemetryItem(item: UnknownRecord): UnknownRecord {
  return {
    ...item,
    triggerVersion: 2,
    triggerScore: numberOrNull(scoreField(item.score, 'score')),
    triggerReasons: recordOrNull(scoreField(item.score, 'reasons')),
    triggerSignals: arrayOrNull(scoreField(item.score, 'signals')),
    at: Date.now()
  }
}

export class Telemetry {
  private queue: Promise<void>
  readonly file: string
  state: TelemetryState

  constructor(stateRoot: string) {
    this.file = path.join(stateRoot, 'telemetry.json')
    this.state = normalizeTelemetryState({})
    this.queue = Promise.resolve()
  }

  async load(): Promise<this> {
    const raw = await readJson<unknown>(this.file, undefined)
    this.state = normalizeTelemetryState(raw)
    if (raw !== undefined && JSON.stringify(raw) !== JSON.stringify(this.state)) {
      await writeJson(this.file, this.state)
    }

    return this
  }

  skill(id: string): SkillTelemetry {
    const existing = this.state.skills[id]
    if (existing !== undefined) {
      return existing
    }

    const skill: SkillTelemetry = {
      createdAt: Date.now(),
      updatedAt: Date.now(),
      uses: 0,
      observedSessions: 0,
      sessionsWithErrors: 0,
      sessionsWithRecovery: 0,
      sessionsWithCorrections: 0,
      patches: 0,
      state: 'active',
      owner: 'opencode-learning',
      seenSessions: []
    }
    this.state.skills[id] = skill
    return skill
  }

  async recordUse(id: string): Promise<void> {
    const s = this.skill(id)
    s.uses += 1
    s.updatedAt = Date.now()
    return this.flush()
  }

  async recordExperience(exp: ExperienceSnapshot): Promise<void> {
    const isFailures = exp.toolCalls?.some((x) => x.status === 'error') ?? false
    for (const id of exp.skillsUsed ?? []) {
      const s = this.skill(id)
      recordSkillExperience(s, exp, isFailures)
    }

    return this.flush()
  }

  async recordCreated(id: string): Promise<void> {
    const s = this.skill(id)
    s.createdAt = Date.now()
    s.updatedAt = Date.now()
    return this.flush()
  }

  async recordPatched(id: string): Promise<void> {
    const s = this.skill(id)
    s.patches += 1
    s.updatedAt = Date.now()
    return this.flush()
  }

  async recordSuccessfulTurn(): Promise<void> {
    this.state.triggerStats.successfulTurns += 1
    return this.flush()
  }

  async recordAutomaticReview(): Promise<void> {
    this.state.triggerStats.automaticReviews += 1
    return this.flush()
  }

  async recordTriggerEvaluation({
    decision,
    score,
    strongSignals
  }: {
    decision?: string
    score?: number
    strongSignals?: string[]
  } = {}): Promise<void> {
    this.state.triggerStats ??= defaultTriggerStats()
    const stats = this.state.triggerStats
    recordTriggerDecision(stats, decision)
    recordScoreBucket(stats, score)
    recordTriggerSignals(stats, strongSignals)

    return this.flush()
  }

  async recordTriggerOutcome(decision: string): Promise<void> {
    this.state.triggerStats ??= defaultTriggerStats()
    const stats = this.state.triggerStats
    switch (decision) {
      case 'staged':
      case 'applied': {
        stats.accepted += 1
        break
      }

      case 'no-change': {
        stats.noChange += 1
        break
      }

      case 'error': {
        stats.errors += 1

        break
      }

      default: {
        break
      }
    }

    return this.flush()
  }

  async recordReview(item: UnknownRecord): Promise<void> {
    this.state.reviews.push(reviewTelemetryItem(item))
    this.state.reviews = this.state.reviews.slice(-200)
    return this.flush()
  }

  recentReviews(limit = 10): unknown[] {
    return this.state.reviews.slice(-limit).toReversed()
  }

  async flush(): Promise<void> {
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => writeJson(this.file, this.state))
    return this.queue
  }
}
