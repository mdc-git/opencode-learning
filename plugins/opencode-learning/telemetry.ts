import path from 'node:path'
import { isRecord, readJson, writeJson } from './shared.ts'
import type { ExperienceSnapshot, UnknownRecord } from './types.ts'

type TriggerStats = {
  version: number
  successfulTurns: number
  eligible: number
  deferred: number
  suppressed: number
  automaticReviews: number
  accepted: number
  noChange: number
  errors: number
  signals: { correction: number; recovery: number; workflow: number }
  scores: { below12: number; from12To15: number; from16To23: number; atLeast24: number }
}
export type SkillTelemetry = {
  createdAt: number
  updatedAt: number
  uses: number
  observedSessions: number
  sessionsWithErrors: number
  sessionsWithRecovery: number
  sessionsWithCorrections: number
  patches: number
  state: string
  owner: string
  seenSessions: string[]
}
type TelemetryState = UnknownRecord & {
  version: number
  skills: Record<string, SkillTelemetry>
  reviews: unknown[]
  triggerStats: TriggerStats
}

function defaultTriggerStats(): TriggerStats {
  return {
    version: 1,
    successfulTurns: 0,
    eligible: 0,
    deferred: 0,
    suppressed: 0,
    automaticReviews: 0,
    accepted: 0,
    noChange: 0,
    errors: 0,
    signals: { correction: 0, recovery: 0, workflow: 0 },
    scores: { below12: 0, from12To15: 0, from16To23: 0, atLeast24: 0 }
  }
}

function normalizeSkillTelemetry(value: unknown): SkillTelemetry | undefined {
  if (!isRecord(value)) {
    return undefined
  }

  const numberValue = (candidate: unknown): number =>
    typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0
  const stringValue = (candidate: unknown, fallback: string): string =>
    typeof candidate === 'string' ? candidate : fallback
  const seenSessions = Array.isArray(value.seenSessions)
    ? value.seenSessions.filter((candidate): candidate is string => typeof candidate === 'string')
    : []
  return {
    createdAt: numberValue(value.createdAt),
    updatedAt: numberValue(value.updatedAt),
    uses: numberValue(value.uses),
    observedSessions: numberValue(value.observedSessions),
    sessionsWithErrors: numberValue(value.sessionsWithErrors),
    sessionsWithRecovery: numberValue(value.sessionsWithRecovery),
    sessionsWithCorrections: numberValue(value.sessionsWithCorrections),
    patches: numberValue(value.patches),
    state: stringValue(value.state, 'active'),
    owner: stringValue(value.owner, 'opencode-learning'),
    seenSessions
  }
}

function normalizeSkills(value: unknown): Record<string, SkillTelemetry> {
  if (!isRecord(value)) {
    return {}
  }

  const skills: Record<string, SkillTelemetry> = {}
  for (const [id, entry] of Object.entries(value)) {
    const skill = normalizeSkillTelemetry(entry)
    if (skill) {
      skills[id] = skill
    }
  }

  return skills
}

function normalizeCounter(value: unknown): number {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim().length > 0
        ? Number(value)
        : 0
  if (!Number.isFinite(number) || number < 0) {
    return 0
  }

  return Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER)
}

function normalizeTriggerStats(value: unknown): TriggerStats {
  const source = isRecord(value) ? value : {}
  const signals = isRecord(source.signals) ? source.signals : {}
  const scores = isRecord(source.scores) ? source.scores : {}
  return {
    version: 1,
    successfulTurns: normalizeCounter(source.successfulTurns),
    eligible: normalizeCounter(source.eligible),
    deferred: normalizeCounter(source.deferred),
    suppressed: normalizeCounter(source.suppressed),
    automaticReviews: normalizeCounter(source.automaticReviews),
    accepted: normalizeCounter(source.accepted),
    noChange: normalizeCounter(source.noChange),
    errors: normalizeCounter(source.errors),
    signals: {
      correction: normalizeCounter(signals.correction),
      recovery: normalizeCounter(signals.recovery),
      workflow: normalizeCounter(signals.workflow)
    },
    scores: {
      below12: normalizeCounter(scores.below12),
      from12To15: normalizeCounter(scores.from12To15),
      from16To23: normalizeCounter(scores.from16To23),
      atLeast24: normalizeCounter(scores.atLeast24)
    }
  }
}

export function normalizeTelemetryState(state: unknown): TelemetryState {
  const source = isRecord(state) ? state : {}
  const normalized: TelemetryState = {
    ...source,
    version: 3,
    skills: normalizeSkills(source.skills),
    reviews: Array.isArray(source.reviews) ? source.reviews : [],
    triggerStats: normalizeTriggerStats(source.triggerStats)
  }
  return normalized
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
  if (isFailures) {
    skill.sessionsWithErrors += 1
  }

  if ((exp.recoveries ?? 0) > 0) {
    skill.sessionsWithRecovery += 1
  }

  if ((exp.corrections?.length ?? 0) > 0) {
    skill.sessionsWithCorrections += 1
  }

  skill.updatedAt = Date.now()
}

function recordTriggerDecision(stats: TriggerStats, decision: string | undefined): void {
  switch (decision) {
    case 'review': {
      stats.eligible += 1
      break
    }

    case 'workflow-cooldown': {
      stats.deferred += 1
      break
    }

    case 'duplicate-fingerprint': {
      stats.suppressed += 1
      break
    }

    case undefined:
    default: {
      break
    }
  }
}

function recordScoreBucket(stats: TriggerStats, score: number | undefined): void {
  if (score === undefined || !Number.isFinite(score)) {
    return
  }

  if (score < 12) {
    stats.scores.below12 += 1
  } else if (score <= 15) {
    stats.scores.from12To15 += 1
  } else if (score <= 23) {
    stats.scores.from16To23 += 1
  } else {
    stats.scores.atLeast24 += 1
  }
}

function triggerSignalKey(value: string): keyof TriggerStats['signals'] | undefined {
  switch (value) {
    case 'correction':
    case 'recovery':
    case 'workflow': {
      return value
    }

    default: {
      return undefined
    }
  }
}

function recordTriggerSignals(stats: TriggerStats, strongSignals: string[] | undefined): void {
  for (const signal of strongSignals ?? []) {
    const key = triggerSignalKey(signal)
    if (key !== undefined) {
      stats.signals[key] += 1
    }
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
    const scoreObject = isRecord(item.score) ? item.score : undefined
    this.state.reviews.push({
      ...item,
      triggerVersion: 2,
      triggerScore: typeof scoreObject?.score === 'number' ? scoreObject.score : null,
      triggerReasons: isRecord(scoreObject?.reasons) ? scoreObject.reasons : null,
      triggerSignals: Array.isArray(scoreObject?.signals) ? scoreObject.signals : null,
      at: Date.now()
    })
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
