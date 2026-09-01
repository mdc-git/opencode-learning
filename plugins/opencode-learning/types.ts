import type { CorrectionSignal, Experience, ToolRecord } from './scoring-types.ts'

export type Mode = 'off' | 'suggest' | 'auto'
export type CuratorConfig = {
  enabled: boolean
  checkEveryHours: number
  staleAfterDays: number
  archiveAfterDays: number
}
export type LearningConfig = {
  enabled: boolean
  mode: Mode
  scoreThreshold: number
  workflowCooldownTurns: number
  reviewerTimeoutMs: number
  maxEventsPerSession: number
  maxCandidates: number
  confidenceThreshold: number
  agentValidation: boolean
  notify: boolean
  reflectorAgent: string
  validatorAgent: string
  projectSkillDir: string
  globalSkillDir: string
  stateDir: string
  curator: CuratorConfig
}
export type UnknownRecord = Record<string, unknown>
export type OwnedSkill = {
  skillId: string
  scope: string
  file: string
  dir: string
  text: string
  sha256: string
  supportingFiles: Array<{ path: string; bytes: number }>
}
export type SupportingFile = { path: string; content: string }
export type SkillPayload = {
  name: string
  description: string
  body: string
  files?: SupportingFile[]
}
export type SectionOperation = {
  kind: string
  heading: string
  body: string
}
export type Proposal = {
  decision?: string
  skillId?: string
  scope?: string
  reason?: string
  confidence?: number
  evidence?: unknown[]
  expectedSha256?: string
  skill?: SkillPayload
  operations?: SectionOperation[]
  addFiles?: SupportingFile[]
}
export type Validation = { ok: boolean; errors: string[]; warnings: string[] }
export type ValidationSubmission = {
  decision: 'accept' | 'reject'
  reason: string
  warnings: string[]
}
export type ContextTailItem = { role: string; text: string; followsAssistant: boolean }
export type ToolCall = ToolRecord & {
  result: string
  durationMs?: number
  at: number
}
export type TurnSummary = { turn: number; terminalType: string; succeeded: boolean }
export type ExperienceState = {
  sessionID: string
  startedAt: number
  updatedAt: number
  goal: string
  contextTail: ContextTailItem[]
  corrections: string[]
  correctionSignals: CorrectionSignal[]
  seenUserMessages: Set<string>
  toolCalls: ToolCall[]
  skillsUsed: Set<string>
  recoveries: number
  verificationSteps: number
  turn: number
  turns: TurnSummary[]
}
export type PendingTool = {
  sessionID: string
  tool: string
  input: string
  startedAt: number
}
export type ExperienceSnapshot = Experience & {
  sessionID: string
  startedAt: number
  updatedAt: number
  goal: string
  contextTail: ContextTailItem[]
  corrections: string[]
  correctionSignals: CorrectionSignal[]
  seenUserMessages?: undefined
  toolCalls: ToolCall[]
  skillsUsed: string[]
  recoveries: number
  verificationSteps: number
  turn: number
  turns: TurnSummary[]
}
export type SessionHistory = { goal: string; seenUserMessages: Set<string> }
export type Candidate = {
  id: string
  name: string
  description: string
  score: number
  owned?: boolean
  scope?: string
  sha256?: string
  supportingFiles?: Array<{ path: string; bytes: number }>
  body?: string
}
