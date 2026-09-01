import type { EnrichedCall } from './scoring-types.ts'

type RecoveryState = {
  pairedFailures: Set<number>
  pairedSuccesses: Set<number>
  pairs: Array<{ failure: EnrichedCall; success: EnrichedCall }>
}

function addRecoveryPair(success: EnrichedCall, calls: EnrichedCall[], state: RecoveryState): void {
  if (!canPairSuccess(success, state)) {
    return
  }

  const failure = findRecoveryFailure(success, calls, state.pairedFailures)
  if (failure) {
    state.pairedFailures.add(failure.index)
    state.pairedSuccesses.add(success.index)
    state.pairs.push({ failure, success })
  }
}

function canPairSuccess(success: EnrichedCall, state: RecoveryState): boolean {
  return (
    success.isSuccess && success.kind !== 'inspect' && !state.pairedSuccesses.has(success.index)
  )
}

export function recoveryPairs(calls: EnrichedCall[]): {
  pairs: Array<{ failure: EnrichedCall; success: EnrichedCall }>
  pairedFailures: Set<number>
} {
  const state: RecoveryState = {
    pairedFailures: new Set<number>(),
    pairedSuccesses: new Set<number>(),
    pairs: []
  }
  for (const success of calls) {
    addRecoveryPair(success, calls, state)
  }

  return { pairs: state.pairs, pairedFailures: state.pairedFailures }
}

type RecoverySearchStep = {
  failure?: EnrichedCall
  nonInspectionCalls: number
  done: boolean
}

function recoverySearchStep(
  candidate: EnrichedCall,
  success: EnrichedCall,
  pairedFailures: Set<number>,
  nonInspectionCalls: number
): RecoverySearchStep {
  if (isRecoveryMatch(candidate, success, pairedFailures, nonInspectionCalls)) {
    return { failure: candidate, nonInspectionCalls, done: true }
  }

  const nextNonInspectionCalls =
    candidate.kind === 'inspect' ? nonInspectionCalls : nonInspectionCalls + 1
  return {
    nonInspectionCalls: nextNonInspectionCalls,
    done: nextNonInspectionCalls > 2
  }
}

function findRecoveryFailure(
  success: EnrichedCall,
  calls: EnrichedCall[],
  pairedFailures: Set<number>
): EnrichedCall | undefined {
  let nonInspectionCalls = 1
  for (let index = success.index - 1; index >= 0; index--) {
    const candidate = calls[index]
    const step = recoverySearchStep(candidate, success, pairedFailures, nonInspectionCalls)
    if (step.done) {
      return step.failure
    }

    nonInspectionCalls = step.nonInspectionCalls
  }

  return undefined
}

function isRecoveryMatch(
  candidate: EnrichedCall,
  success: EnrichedCall,
  pairedFailures: Set<number>,
  nonInspectionCalls: number
): boolean {
  return (
    isCandidateFailure(candidate, pairedFailures, nonInspectionCalls) &&
    candidate.operationFingerprint === success.operationFingerprint &&
    candidate.inputFingerprint !== success.inputFingerprint
  )
}

function isCandidateFailure(
  candidate: EnrichedCall,
  pairedFailures: Set<number>,
  nonInspectionCalls: number
): boolean {
  return (
    candidate.isFailure &&
    candidate.kind !== 'inspect' &&
    !pairedFailures.has(candidate.index) &&
    nonInspectionCalls <= 2
  )
}
