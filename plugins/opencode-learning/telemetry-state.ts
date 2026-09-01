import { isRecord } from './shared.ts'

export type TriggerStats = {
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

export type TelemetryState = {
  version: number
  skills: Record<string, SkillTelemetry>
  reviews: unknown[]
  triggerStats: TriggerStats
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
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return 0
  }

  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER)
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
  return {
    version: 3,
    skills: normalizeSkills(source.skills),
    reviews: Array.isArray(source.reviews) ? source.reviews : [],
    triggerStats: normalizeTriggerStats(source.triggerStats)
  }
}
