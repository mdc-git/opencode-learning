import type { TriggerStats } from './telemetry-state.ts'

export function recordTriggerDecision(stats: TriggerStats, decision: string | undefined): void {
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

    case undefined: {
      break
    }

    default: {
      break
    }
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

  if (score < 12) {
    return 'below12'
  }

  if (score <= 15) {
    return 'from12To15'
  }

  return score <= 23 ? 'from16To23' : 'atLeast24'
}

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
