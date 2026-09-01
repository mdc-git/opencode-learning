import {
  classifyToolCall,
  inputFingerprint,
  operationDescriptor,
  operationFingerprint
} from './scoring-calls.ts'
import { safeSignalHash, stableHash } from './scoring-hash.ts'
import { recoveryPairs } from './scoring-recovery.ts'
import type {
  CorrectionSignal,
  EnrichedCall,
  Experience,
  FeatureSignal,
  TriggerFeatures,
  WorkflowRecord
} from './scoring-types.ts'

const ACTION_KINDS = new Set(['mutate', 'execute'])
const WORKFLOW_KINDS = new Set(['mutate', 'execute', 'verify'])

function enrichedCalls(experience: Experience): EnrichedCall[] {
  return (experience.toolCalls ?? []).map((record, index) => {
    const descriptor = operationDescriptor(record)
    return {
      record,
      index,
      turn: record.turn,
      kind: classifyToolCall(record),
      isSuccess: record.status === 'success',
      isFailure: record.status === 'error',
      descriptor,
      operationFingerprint: operationFingerprint(record),
      inputFingerprint: inputFingerprint(record)
    }
  })
}

function addSignal(
  signals: FeatureSignal[],
  seen: Set<string>,
  kind: 'correction' | 'recovery' | 'workflow',
  value: unknown
): void {
  const fingerprint = safeSignalHash(value)
  const key = `${kind}:${fingerprint}`
  if (seen.has(key)) {
    return
  }

  seen.add(key)
  signals.push({ kind, fingerprint })
}

function groupedCalls(calls: EnrichedCall[]): Map<number, EnrichedCall[]> {
  const grouped = new Map<number, EnrichedCall[]>()
  for (const call of calls) {
    const group = grouped.get(call.turn) ?? []
    group.push(call)
    grouped.set(call.turn, group)
  }

  return grouped
}

function verificationIndexes(group: EnrichedCall[], mutationIndex: number): number[] {
  return group
    .map((call, index) =>
      index >= mutationIndex && call.isSuccess && call.kind === 'verify' ? index : -1
    )
    .filter((index) => index !== -1)
}

function workflowForGroup(
  turn: number,
  group: EnrichedCall[],
  states: Map<number, boolean>
): { record?: WorkflowRecord; verifications: number } {
  if (states.get(turn) !== true) {
    return { verifications: 0 }
  }

  const mutationIndex = group.findIndex((call) => call.isSuccess && call.kind === 'mutate')
  const verifierIndexes = verificationIndexes(group, mutationIndex)
  if (mutationIndex === -1 || verifierIndexes.length === 0) {
    return { verifications: 0 }
  }

  const end = verifierIndexes.at(-1)!
  const sequence = group
    .slice(mutationIndex, end + 1)
    .filter((call) => call.isSuccess && WORKFLOW_KINDS.has(call.kind))
    .map((call) => ({ category: call.kind, operation: call.operationFingerprint }))
  return {
    record: { turn, fingerprint: stableHash(sequence) },
    verifications: verifierIndexes.length
  }
}

function workflowRecords(
  calls: EnrichedCall[],
  states: Map<number, boolean>
): { records: WorkflowRecord[]; successfulVerifications: number } {
  const records: WorkflowRecord[] = []
  let successfulVerifications = 0
  for (const [turn, group] of groupedCalls(calls)) {
    const workflow = workflowForGroup(turn, group, states)
    successfulVerifications += workflow.verifications
    if (workflow.record !== undefined) {
      records.push(workflow.record)
    }
  }

  return { records, successfulVerifications }
}

function distinctCategoryCount(calls: EnrichedCall[]): number {
  const categories = new Set<string>()
  for (const call of calls) {
    if (WORKFLOW_KINDS.has(call.kind)) {
      categories.add(`${call.kind}:${call.descriptor.tool}:${call.descriptor.operation}`)
    }
  }

  return categories.size
}

function addCorrectionSignals(
  calls: EnrichedCall[],
  states: Map<number, boolean>,
  corrections: CorrectionSignal[],
  signalState: { signals: FeatureSignal[]; seen: Set<string> }
): number {
  let count = 0
  for (const signal of corrections) {
    const isIncorporated = calls.some(
      (call) =>
        call.turn >= signal.turn &&
        call.isSuccess &&
        ACTION_KINDS.has(call.kind) &&
        states.get(call.turn) === true
    )
    if (!isIncorporated) {
      continue
    }

    count++
    addSignal(signalState.signals, signalState.seen, 'correction', signal.fingerprint)
  }

  return count
}

function addRecoverySignals(
  pairs: Array<{ failure: EnrichedCall; success: EnrichedCall }>,
  signalState: { signals: FeatureSignal[]; seen: Set<string> }
): void {
  for (const pair of pairs) {
    addSignal(
      signalState.signals,
      signalState.seen,
      'recovery',
      stableHash({
        operation: pair.failure.operationFingerprint,
        failedInput: pair.failure.inputFingerprint,
        successfulInput: pair.success.inputFingerprint
      })
    )
  }
}

function workflowTurnGroups(records: WorkflowRecord[]): Map<string, Set<number>> {
  const groups = new Map<string, Set<number>>()
  for (const workflow of records) {
    const turns = groups.get(workflow.fingerprint) ?? new Set<number>()
    turns.add(workflow.turn)
    groups.set(workflow.fingerprint, turns)
  }

  return groups
}

function addWorkflowSignals(
  records: WorkflowRecord[],
  signalState: { signals: FeatureSignal[]; seen: Set<string> }
): number {
  let repeated = 0
  for (const [fingerprint, turns] of workflowTurnGroups(records)) {
    if (turns.size < 2) {
      continue
    }

    repeated++
    addSignal(signalState.signals, signalState.seen, 'workflow', fingerprint)
  }

  return repeated
}

export function deriveTriggerFeatures(experience: Experience): TriggerFeatures {
  const calls = enrichedCalls(experience)
  const states = new Map<number, boolean>(
    (experience.turns ?? []).map((turn) => [turn.turn, turn.succeeded])
  )
  const signalState = { signals: [] as FeatureSignal[], seen: new Set<string>() }
  const corrections = addCorrectionSignals(
    calls,
    states,
    experience.correctionSignals ?? [],
    signalState
  )
  const recovery = recoveryPairs(calls)
  addRecoverySignals(recovery.pairs, signalState)
  const workflows = workflowRecords(calls, states)
  const repeatedWorkflows = addWorkflowSignals(workflows.records, signalState)

  return {
    incorporatedCorrections: corrections,
    confirmedRecoveries: recovery.pairs.length,
    repeatedVerifiedWorkflows: repeatedWorkflows,
    successfulVerificationsAfterMutation: workflows.successfulVerifications,
    unresolvedFailures: calls.filter(
      (call) => call.isFailure && !recovery.pairedFailures.has(call.index)
    ).length,
    distinctCategories: distinctCategoryCount(calls),
    signalFingerprints: signalState.signals
  }
}
