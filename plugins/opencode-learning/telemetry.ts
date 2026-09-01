import path from 'node:path'
import { isRecord, readJson, writeJson } from './shared.ts'
import type { ExperienceSnapshot, UnknownRecord } from './types.ts'
import {
  normalizeTelemetryState,
  type SkillTelemetry,
  type TelemetryState,
  type TriggerStats
} from './telemetry-state.ts'

const TRIGGER_OUTCOMES: Record<string, 'accepted' | 'noChange' | 'errors'> = {
  staged: 'accepted',
  applied: 'accepted',
  'no-change': 'noChange',
  error: 'errors'
}

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
  for (const [isPresent, key] of [
    [isFailures, 'sessionsWithErrors'],
    [exp.recoveries > 0, 'sessionsWithRecovery'],
    [exp.corrections.length > 0, 'sessionsWithCorrections']
  ] as const) {
    if (isPresent) {
      skill[key] += 1
    }
  }

  skill.updatedAt = Date.now()
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

function shouldRewriteTelemetry(
  raw: unknown,
  state: TelemetryState,
  shouldWrite: boolean
): boolean {
  return shouldWrite || (raw !== undefined && JSON.stringify(raw) !== JSON.stringify(state))
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
    let raw: unknown
    let shouldWrite = false
    try {
      raw = await readJson<unknown>(this.file, undefined)
    } catch (error: unknown) {
      console.error('[opencode-learning] telemetry file unreadable; resetting state', error)
      raw = undefined
      shouldWrite = true
    }

    this.state = normalizeTelemetryState(raw)
    if (shouldRewriteTelemetry(raw, this.state, shouldWrite)) {
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
    const isFailures = exp.toolCalls.some((item) => item.status === 'error')
    for (const id of exp.skillsUsed) {
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
    decision: string
    score: number
    strongSignals: string[]
  }): Promise<void> {
    const stats = this.state.triggerStats
    recordTriggerDecision(stats, decision)
    recordScoreBucket(stats, score)
    recordTriggerSignals(stats, strongSignals)

    return this.flush()
  }

  async recordTriggerOutcome(decision: TriggerOutcome): Promise<void> {
    this.state.triggerStats[TRIGGER_OUTCOMES[decision]] += 1

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

type TriggerOutcome = 'staged' | 'applied' | 'no-change' | 'error'

function recordTriggerDecision(stats: TriggerStats, decision: string): void {
  const update = TRIGGER_DECISION_UPDATES[decision]
  update?.(stats)
}

const TRIGGER_DECISION_UPDATES: Record<string, (stats: TriggerStats) => void> = {
  review(stats) {
    stats.eligible += 1
  },
  'workflow-cooldown'(stats) {
    stats.deferred += 1
  },
  'duplicate-fingerprint'(stats) {
    stats.suppressed += 1
  }
}

function recordScoreBucket(stats: TriggerStats, score: number): void {
  if (!Number.isFinite(score)) {
    return
  }

  const bucket = SCORE_BUCKETS.find((item) => score <= item.max)
  if (bucket !== undefined) {
    stats.scores[bucket.key] += 1
  }
}

const SCORE_BUCKETS: Array<{ max: number; key: keyof TriggerStats['scores'] }> = [
  { max: 11, key: 'below12' },
  { max: 15, key: 'from12To15' },
  { max: 23, key: 'from16To23' },
  { max: Infinity, key: 'atLeast24' }
]

function recordTriggerSignals(stats: TriggerStats, strongSignals: string[]): void {
  for (const signal of strongSignals) {
    if (TRIGGER_SIGNAL_KEYS.has(signal as keyof TriggerStats['signals'])) {
      stats.signals[signal as keyof TriggerStats['signals']] += 1
    }
  }
}

const TRIGGER_SIGNAL_KEYS = new Set<keyof TriggerStats['signals']>([
  'correction',
  'recovery',
  'workflow'
])
