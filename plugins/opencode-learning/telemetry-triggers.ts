import type { TriggerStats } from './telemetry-state.ts'

export function recordTriggerDecision(stats: TriggerStats, decision: string | undefined): void {
  const update = TRIGGER_DECISION_UPDATES[decision ?? '']
  if (update !== undefined) {
    update(stats)
  }
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

export function recordScoreBucket(stats: TriggerStats, score: number | undefined): void {
  const bucket = scoreBucket(score)
  if (bucket !== undefined) {
    stats.scores[bucket] += 1
  }
}

function scoreBucket(score: number | undefined): keyof TriggerStats['scores'] | undefined {
  if (score === undefined || !Number.isFinite(score)) {
    return undefined
  }

  return SCORE_BUCKETS.find((bucket) => score <= bucket.max)?.key
}

const SCORE_BUCKETS: Array<{ max: number; key: keyof TriggerStats['scores'] }> = [
  { max: 11, key: 'below12' },
  { max: 15, key: 'from12To15' },
  { max: 23, key: 'from16To23' },
  { max: Infinity, key: 'atLeast24' }
]

export function recordTriggerSignals(
  stats: TriggerStats,
  strongSignals: string[] | undefined
): void {
  for (const signal of strongSignals ?? []) {
    const key = triggerSignalKey(signal)
    if (key !== undefined) {
      stats.signals[key] += 1
    }
  }
}

function triggerSignalKey(value: string): keyof TriggerStats['signals'] | undefined {
  switch (value) {
    case 'correction': {
      return value
    }

    case 'recovery': {
      return value
    }

    case 'workflow': {
      return value
    }

    default: {
      return undefined
    }
  }
}
