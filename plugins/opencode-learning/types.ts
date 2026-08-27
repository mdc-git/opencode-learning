import type { Plugin } from '@opencode-ai/plugin'
import type { Info as ToolInfo, Options as ToolOptions } from '@opencode-ai/plugin/promise/tool'
import type { Experience, TriggerDecision } from './scoring.ts'

export type OpenCodeContext = Parameters<Plugin.Plugin['setup']>[0]
export type LearningToolInfo = Omit<ToolInfo, 'name' | 'options'>
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
export type Proposal = UnknownRecord & {
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
export type Validation = UnknownRecord & { ok: boolean; errors: string[]; warnings: string[] }
export type ValidationSubmission = UnknownRecord & {
  decision: 'accept' | 'reject'
  reason: string
  warnings: string[]
}
export type ContextEvent = { sessionID?: string; messages?: unknown[] }
export type ToolBeforeEvent = { sessionID?: string; tool?: string; id?: string; input?: unknown }
export type ToolAfterEvent = ToolBeforeEvent & {
  status?: string
  result?: unknown
  error?: unknown
}
export type ContextTailItem = { role?: string; text: string; followsAssistant: boolean }
export type ToolCall = {
  tool: string
  turn: number
  input: string
  status: 'success' | 'error' | 'unknown'
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
  correctionSignals: UnknownRecord[]
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
  callId: string
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
  correctionSignals: UnknownRecord[]
  seenUserMessages?: undefined
  toolCalls: ToolCall[]
  skillsUsed: string[]
  recoveries: number
  verificationSteps: number
  turn: number
  turns: TurnSummary[]
}
export type SessionHistory = { goal: string; seenUserMessages: Set<string> }
export type OwnedSkill = {
  skillId: string
  scope: string
  file: string
  dir: string
  text: string
  sha256: string
  supportingFiles: Array<{ path: string; bytes: number }>
}
export type PendingProposal = { id: string; proposal: Proposal; validation: UnknownRecord }
export type PendingDetails = PendingProposal & { previews: Record<string, string> }
export type CreateResult = {
  file: string
  text: string
  sha256: string
  supportingFiles: string[]
}
export type PatchResult = { file: string; text: string; sha256: string; addedFiles: string[] }
export type AppliedPending = { result: unknown; proposal: Proposal }
export type StagedProposal = { id: string; dir: string }
export type SkillStoreLike = {
  readonly projectRoot: string
  readonly projectRootSkills: string
  readonly globalRootSkills: string
  readonly stateRoot: string
  getOwned: (skillId: string, scope?: string) => Promise<OwnedSkill | undefined>
  listOwned: (scope?: string) => Promise<OwnedSkill[]>
  listPending: () => Promise<PendingProposal[]>
  getPending: (id: string) => Promise<PendingDetails>
  rejectPending: (id: string) => Promise<void>
  applyPending: (id: string) => Promise<AppliedPending>
  promote: (skillId: string) => Promise<{ skillId: string; source: string; target: string }>
  archive: (skillId: string, options?: { scope?: string }) => Promise<boolean>
  stage: (proposal: Proposal, validation: UnknownRecord) => Promise<StagedProposal>
  create: (proposal: Proposal, options?: { scope?: string }) => Promise<CreateResult>
  patch: (proposal: Proposal, options?: { scope?: string }) => Promise<PatchResult>
}
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
export type TelemetryState = UnknownRecord & {
  version: number
  skills: Record<string, SkillTelemetry>
  reviews: unknown[]
  triggerStats: TriggerStats
}
export type ExperienceRecorderLike = {
  observeContext: (event: ContextEvent) => ExperienceState | undefined
  toolBefore: (event: ToolBeforeEvent) => void
  toolAfter: (event: ToolAfterEvent) => ExperienceState | undefined
  finishTurn: (
    sessionID: string,
    terminalType: string,
    eventID?: string
  ) => ExperienceSnapshot | undefined
  snapshot: (sessionID: string) => ExperienceSnapshot | undefined
  take: (sessionID: string) => ExperienceSnapshot | undefined
  clear: (sessionID?: string) => void
}
export type TelemetryLike = {
  state: TelemetryState
  load: () => Promise<TelemetryLike>
  skill: (id: string) => SkillTelemetry
  recordUse: (id: string) => Promise<void>
  recordExperience: (exp: ExperienceSnapshot) => Promise<void>
  recordCreated: (id: string) => Promise<void>
  recordPatched: (id: string) => Promise<void>
  recordSuccessfulTurn: () => Promise<void>
  recordTriggerEvaluation: (evaluation?: {
    decision?: string
    score?: number
    strongSignals?: string[]
  }) => Promise<void>
  recordTriggerOutcome: (decision: string) => Promise<void>
  recordReview: (item: UnknownRecord) => Promise<void>
  recentReviews: (limit?: number) => unknown[]
  flush: () => Promise<void>
}
export type MailboxKind = 'proposal' | 'validation'
export type MailboxWaiter = {
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
  cancel: () => void
}
export type MailboxLike = {
  register: (sessionID: string, kind: MailboxKind) => void
  release: (sessionID: string) => void
  isInternalSession: (sessionID: string) => boolean
  kind: (sessionID: string) => MailboxKind | undefined
  sessionIds: () => string[]
  hasSubmitted: (sessionID: string) => boolean
  submit: (sessionID: string, kind: MailboxKind, payload: unknown) => void
  wait: <T>(sessionID: string, timeoutMs: number) => Promise<T>
  clear: () => void
}
export type Runtime = {
  directory: string
  store: SkillStoreLike
  recorder: ExperienceRecorderLike
  ready: Promise<Runtime>
  telemetry: TelemetryLike
  curator: CuratorLike
  pipeline: ReviewPipelineLike
}
export type ReviewRequest = { force: boolean; terminalType?: string }
export type TerminalEvent = {
  type: string
  sessionID: string
  eventID?: string
  location?: { directory?: string }
}
export type SessionInfo = {
  id: string
  parentID?: string
  location: { directory: string }
  model?: { id: string; providerID: string; variant?: string }
}
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
export type ReviewPipelineOptions = {
  ctx: OpenCodeContext
  recorder: ExperienceRecorderLike
  store: SkillStoreLike
  telemetry: TelemetryLike
  mailbox: MailboxLike
  config: LearningConfig
}
export type ReviewOptions = {
  force?: boolean
  terminalType?: string
  triggerDecision?: TriggerDecision
}
export type ReviewValidation = UnknownRecord & {
  deterministic: Validation
  agent: ValidationSubmission
  ok: boolean
}
export type ReviewAttempt = { proposal: Proposal; validation: ReviewValidation }
export type ReviewOutcome = UnknownRecord & { status: string }
export type PreparedReview = { batch: ExperienceSnapshot; candidate: TriggerDecision | undefined }
export type CuratorResult = { stale: string[]; archived: string[] } | { skipped: string }
export type CuratorLike = {
  maybeRun: (options?: { force?: boolean }) => Promise<CuratorResult>
  run: () => Promise<{ stale: string[]; archived: string[] }>
}
export type ReviewPipelineLike = {
  schedule: (sessionID: string, options?: { force?: boolean }) => UnknownRecord
  executionFinished: (sessionID: string, options?: { terminalType?: string }) => void
  cleanup: () => Promise<void>
}
export type SessionRuntimeFor = (sessionID: string, session?: SessionInfo) => Promise<Runtime>
export type ForegroundSessionFor = (
  sessionID: string | undefined
) => Promise<SessionInfo | undefined>
export type RegisterToolsOptions = {
  config: LearningConfig
  mailbox: MailboxLike
  runtimeForSession: SessionRuntimeFor
  foregroundSessionFor: ForegroundSessionFor
}
export type AddLearningTool = (name: string, info: LearningToolInfo, options: ToolOptions) => void
export type ReviewInput = { force?: boolean }
export type PendingInput = { action: 'list' | 'show' | 'reject'; id?: string }
export type IdInput = { id: string }
export type SkillIdInput = { skillId: string }
export type ComponentStatus = {
  reflectorAgent: boolean
  validatorAgent: boolean
  commands: Record<string, boolean>
}
