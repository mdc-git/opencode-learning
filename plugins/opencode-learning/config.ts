import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SCORE_THRESHOLD, WORKFLOW_COOLDOWN_TURNS } from './scoring.ts'
import { isRecord } from './shared.ts'
import type { LearningConfig, Mode } from './types.ts'

const DEFAULTS: LearningConfig = Object.freeze({
  enabled: true,
  mode: 'suggest',
  scoreThreshold: DEFAULT_SCORE_THRESHOLD,
  workflowCooldownTurns: WORKFLOW_COOLDOWN_TURNS,
  reviewerTimeoutMs: 12e4,
  maxEventsPerSession: 120,
  maxCandidates: 5,
  confidenceThreshold: 0.72,
  agentValidation: true,
  notify: true,
  reflectorAgent: 'learning-reflector',
  validatorAgent: 'learning-validator',
  projectSkillDir: '.opencode/skills',
  globalSkillDir: path.join(os.homedir(), '.config/opencode/skills'),
  stateDir: '.opencode/.learning',
  curator: {
    enabled: true,
    checkEveryHours: 24,
    staleAfterDays: 30,
    archiveAfterDays: 90
  }
})
function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && ['off', 'suggest', 'auto'].includes(value)
}

function configValues(options: unknown): Record<string, unknown> {
  return isRecord(options) ? options : {}
}

function configMode(values: Record<string, unknown>): Mode {
  return isMode(values.mode) ? values.mode : DEFAULTS.mode
}

function configCurator(values: Record<string, unknown>): LearningConfig['curator'] {
  return {
    ...DEFAULTS.curator,
    ...(isRecord(values.curator) && values.curator)
  }
}

function isNotDisabled(value: unknown): boolean {
  return value !== false
}

export function loadConfig(options: unknown = {}): LearningConfig {
  const values = configValues(options)
  const mode = configMode(values)
  return {
    ...DEFAULTS,
    ...values,
    mode,
    curator: configCurator(values),
    enabled: isNotDisabled(values.enabled) && mode !== 'off',
    agentValidation: isNotDisabled(values.agentValidation),
    notify: isNotDisabled(values.notify)
  }
}
