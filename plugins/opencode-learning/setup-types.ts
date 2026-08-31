import type { Options as ToolOptions } from '@opencode-ai/plugin/promise/tool'
import type { InternalMailbox } from './mailbox.ts'
import type { Curator, ReviewPipeline } from './review.ts'
import type { SkillStore } from './store.ts'
import type { LearningToolInfo, SessionInfo } from './sdk.ts'
import type { LearningConfig } from './types.ts'
import type { Telemetry } from './telemetry.ts'
import type { ExperienceRecorder } from './recorder.ts'

export type Runtime = {
  directory: string
  store: SkillStore
  recorder: ExperienceRecorder
  ready: Promise<Runtime>
  telemetry: Telemetry
  curator: Curator
  pipeline: ReviewPipeline
}
export type SessionRuntimeFor = (sessionID: string, session?: SessionInfo) => Promise<Runtime>
export type ForegroundSessionFor = (
  sessionID: string | undefined
) => Promise<SessionInfo | undefined>
export type RegisterToolsOptions = {
  config: LearningConfig
  mailbox: InternalMailbox
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
export type AppliedPendingResult = Awaited<ReturnType<SkillStore['applyPending']>>
