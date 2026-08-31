import {
  classifyToolCall,
  inputFingerprintFor,
  operationFingerprint,
  operationDescriptor
} from './scoring-calls.ts'
import {
  correctionSignals,
  isFailure,
  numericValue,
  turnKey,
  turnValue
} from './scoring-corrections.ts'
import { isRecord } from './scoring-input.ts'
import { safeSignalHash, stableHash } from './scoring-hash.ts'
import { addRecoverySignals, recoveryPairs } from './scoring-recovery.ts'
import { isSuccessfulTurn, turnStates } from './scoring-turns.ts'
import type {
  CorrectionSignal,
  EnrichedCall,
  Experience,
  FeatureSignal,
  ToolRecord,
  TurnRecord,
  TriggerFeatures,
  WorkflowRecord
} from './scoring-types.ts'

const ACTION_KINDS = new Set(['mutate', 'execute'])
const WORKFLOW_KINDS = new Set(['mutate', 'execute', 'verify'])

function enrichedCalls(experience: Experience): EnrichedCall[] {
  const records = Array.isArray(experience?.toolCalls) ? experience.toolCalls : []
  return records.map((record, index) => {
    const source = isRecord(record) ? record : {}
    const descriptor = operationDescriptor(source)
    return {
      record: source,
      index,
      turn: turnValue(source),
      kind: classifyToolCall(source),
      isSuccess: source.status === 'success',
      isFailure: isFailure(source),
      descriptor,
      operationFingerprint: operationFingerprint(source),
      inputFingerprint: inputFingerprintFor(record)
    }
  })
}

function doesFollowTurn(call: EnrichedCall, signal: CorrectionSignal): boolean {
  if (call.turn === undefined || signal.turn === undefined) {
    return false
  }

  if (call.turn !== signal.turn) {
    return call.turn > signal.turn
  }

  return doesFollowWithinTurn(call, signal)
}

function doesFollowWithinTurn(call: EnrichedCall, signal: CorrectionSignal): boolean {
  if (signal.index !== undefined) {
    return call.index > signal.index
  }

  const callAt = numericValue(call.record.at)
  if (callAt !== undefined && signal.at !== undefined) {
    return callAt >= signal.at
  }

  return true
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

function workflowRecords(
  calls: EnrichedCall[],
  state: { states: Map<string, boolean> }
): { records: WorkflowRecord[]; successfulVerifications: number } {
  const grouped = groupedCalls(calls)

  const records: WorkflowRecord[] = []
  let successfulVerifications = 0
  for (const [key, group] of grouped) {
    const workflow = workflowForGroup(key, group, state)
    successfulVerifications += workflow.verifications
    appendWorkflowRecord(records, workflow.record)
  }

  return { records, successfulVerifications }
}

function groupedCalls(calls: EnrichedCall[]): Map<string | undefined, EnrichedCall[]> {
  const grouped = new Map<string | undefined, EnrichedCall[]>()
  for (const call of calls) {
    const key = turnKey(call.turn)
    const group = grouped.get(key) ?? []
    group.push(call)
    grouped.set(key, group)
  }

  return grouped
}

function appendWorkflowRecord(records: WorkflowRecord[], record: WorkflowRecord | undefined): void {
  if (record !== undefined) {
    records.push(record)
  }
}

function workflowForGroup(
  key: string | undefined,
  group: EnrichedCall[],
  state: { states: Map<string, boolean> }
): { record?: WorkflowRecord; verifications: number } {
  if (!isSuccessfulTurn(key, state)) {
    return { verifications: 0 }
  }

  const mutationIndex = group.findIndex((call) => call.isSuccess && call.kind === 'mutate')
  const verifierIndexes = verificationIndexes(group, mutationIndex)
  if (!hasWorkflowVerification(mutationIndex, verifierIndexes)) {
    return { verifications: 0 }
  }

  return workflowResult(key, group, mutationIndex, verifierIndexes)
}

function verificationIndexes(group: EnrichedCall[], mutationIndex: number): number[] {
  return group
    .map((call, index) =>
      index >= mutationIndex && call.isSuccess && call.kind === 'verify' ? index : -1
    )
    .filter((index) => index !== -1)
}

function hasWorkflowVerification(mutationIndex: number, verifierIndexes: number[]): boolean {
  return mutationIndex !== -1 && verifierIndexes.length > 0
}

function workflowResult(
  key: string | undefined,
  group: EnrichedCall[],
  mutationIndex: number,
  verifierIndexes: number[]
): { record?: WorkflowRecord; verifications: number } {
  const end = verifierIndexes.at(-1)
  if (end === undefined) {
    return { verifications: verifierIndexes.length }
  }

  const sequence = group
    .slice(mutationIndex, end + 1)
    .filter((call) => call.isSuccess && WORKFLOW_KINDS.has(call.kind))
    .map((call) => ({ category: call.kind, operation: call.operationFingerprint }))
  return {
    record: { turn: key, fingerprint: stableHash(sequence) },
    verifications: verifierIndexes.length
  }
}

function distinctCategoryCount(calls: EnrichedCall[]): number {
  const categories = new Set<string>()
  for (const call of calls) {
    if (!WORKFLOW_KINDS.has(call.kind)) {
      continue
    }

    categories.add(`${call.kind}:${call.descriptor.tool}:${call.descriptor.operation}`)
  }

  return categories.size
}

export function deriveTriggerFeatures(experience: Experience): TriggerFeatures {
  const calls = enrichedCalls(experience)
  const state = turnStates(experience)
  const signalState = { signals: [] as FeatureSignal[], seen: new Set<string>() }
  const incorporatedCorrections = addCorrectionSignals(
    calls,
    state,
    correctionSignals(experience),
    signalState
  )
  const recovery = recoveryPairs(calls)
  addRecoverySignals(recovery.pairs, signalState, addSignal)
  const workflows = workflowRecords(calls, state)
  const repeatedWorkflows = addWorkflowSignals(workflows.records, signalState)

  return {
    incorporatedCorrections,
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

function addCorrectionSignals(
  calls: EnrichedCall[],
  state: { states: Map<string, boolean> },
  corrections: CorrectionSignal[],
  signalState: { signals: FeatureSignal[]; seen: Set<string> }
): number {
  let count = 0
  for (const signal of corrections) {
    const isIncorporated = calls.some(
      (call) =>
        call.isSuccess &&
        ACTION_KINDS.has(call.kind) &&
        isSuccessfulTurn(turnKey(call.turn), state) &&
        doesFollowTurn(call, signal)
    )
    if (!isIncorporated) {
      continue
    }

    count++
    addSignal(signalState.signals, signalState.seen, 'correction', signal.fingerprint)
  }

  return count
}

function addWorkflowSignals(
  records: WorkflowRecord[],
  signalState: { signals: FeatureSignal[]; seen: Set<string> }
): number {
  const workflowTurns = workflowTurnGroups(records)

  let repeated = 0
  for (const [fingerprint, turns] of workflowTurns) {
    if (turns.size < 2) {
      continue
    }

    repeated++
    addSignal(signalState.signals, signalState.seen, 'workflow', fingerprint)
  }

  return repeated
}

function workflowTurnGroups(records: WorkflowRecord[]): Map<string, Set<string | undefined>> {
  const workflowTurns = new Map<string, Set<string | undefined>>()
  for (const workflow of records) {
    const turns = workflowTurns.get(workflow.fingerprint) ?? new Set<string | undefined>()
    turns.add(workflow.turn)
    workflowTurns.set(workflow.fingerprint, turns)
  }

  return workflowTurns
}
