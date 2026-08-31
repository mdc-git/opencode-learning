import { isRecord } from './shared.ts'
import type { Telemetry } from './telemetry.ts'
import type { OpenCodeContext } from './sdk.ts'
import type { LearningConfig, UnknownRecord } from './types.ts'
import type { AppliedPendingResult, ComponentStatus } from './setup-types.ts'

export function objectOutput(): { type: 'object'; additionalProperties: boolean } {
  return { type: 'object', additionalProperties: true }
}

export function result(output: unknown, content: string): { output: unknown; content: string } {
  return { output: sanitize(output), content }
}

export async function componentStatus(
  ctx: OpenCodeContext,
  config: LearningConfig
): Promise<ComponentStatus> {
  const out: ComponentStatus = { reflectorAgent: false, validatorAgent: false, commands: {} }
  try {
    const agentResponse = await ctx.agent.list()
    const ids = new Set(agentResponse.data.map((item) => item.id))
    out.reflectorAgent = ids.has(config.reflectorAgent)
    out.validatorAgent = ids.has(config.validatorAgent)
  } catch {}

  try {
    const commandResponse = await ctx.command.list()
    const ids = new Set(commandResponse.data.map((item) => item.name))
    for (const id of [
      'learn',
      'learn-pending',
      'learn-show',
      'learn-approve',
      'learn-reject',
      'learn-status',
      'learn-curate',
      'learn-promote'
    ]) {
      out.commands[id] = ids.has(id)
    }
  } catch {}

  return out
}

export async function recordAppliedTelemetry(
  telemetry: Telemetry,
  applied: AppliedPendingResult
): Promise<void> {
  const skillId = appliedSkillId(applied)
  if (skillId === undefined || !hasAppliedFile(applied)) {
    return
  }

  await recordAppliedOperation(telemetry, applied.proposal.decision, skillId)
}

function appliedSkillId(applied: AppliedPendingResult): string | undefined {
  const skillId = applied.proposal?.skillId
  return typeof skillId === 'string' ? skillId : undefined
}

function hasAppliedFile(applied: AppliedPendingResult): boolean {
  return isRecord(applied.result) && applied.result.file !== undefined
}

async function recordAppliedOperation(
  telemetry: Telemetry,
  decision: string | undefined,
  skillId: string
): Promise<void> {
  if (decision === 'create') {
    await telemetry.recordCreated(skillId)
  } else if (decision === 'patch') {
    await telemetry.recordPatched(skillId)
  }
}

function sanitize(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item))
  }

  if (isRecord(value)) {
    return sanitizeRecord(value)
  }

  return value
}

function sanitizeRecord(value: UnknownRecord): UnknownRecord {
  const out: UnknownRecord = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = sanitize(item)
  }

  return out
}
