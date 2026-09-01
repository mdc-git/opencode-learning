export type UnknownRecord = Record<string, unknown>
export type ToolRecord = {
  tool: string
  turn: number
  input: unknown
  status: 'success' | 'error'
  result?: unknown
}
export type StructuredValue = UnknownRecord | unknown[]
export type SignalKind = 'correction' | 'recovery' | 'workflow'
export type ToolKind = 'inspect' | 'mutate' | 'execute' | 'verify' | 'delegate' | 'other'
export type OperationDescriptor = { tool: string; operation: string; target: string }
export type CorrectionSignal = { turn: number; fingerprint: string }
export type FeatureSignal = { kind: SignalKind; fingerprint: string }
export type EnrichedCall = {
  record: ToolRecord
  index: number
  turn: number
  kind: ToolKind
  isSuccess: boolean
  isFailure: boolean
  descriptor: OperationDescriptor
  operationFingerprint: string
  inputFingerprint: string
}
export type WorkflowRecord = { turn: number; fingerprint: string }
export type TriggerFeatures = {
  incorporatedCorrections: number
  confirmedRecoveries: number
  repeatedVerifiedWorkflows: number
  successfulVerificationsAfterMutation: number
  unresolvedFailures: number
  distinctCategories: number
  signalFingerprints: Array<FeatureSignal | string>
}
export type TriggerDecision = {
  eligible: boolean
  score: number
  threshold: number
  strongSignals: SignalKind[]
  workflowOnly: boolean
  fingerprint: string
  reasons: {
    incorporatedCorrections: number
    confirmedRecoveries: number
    repeatedVerifiedWorkflows: number
    successfulVerificationsAfterMutation: number
    unresolvedFailures: number
    distinctCategories: number
  }
}
export type Experience = {
  toolCalls?: ToolRecord[]
  correctionSignals?: CorrectionSignal[]
  turns?: Array<{ turn: number; terminalType: string; succeeded: boolean }>
}
