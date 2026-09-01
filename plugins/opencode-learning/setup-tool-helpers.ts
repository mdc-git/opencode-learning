import type { Options as ToolOptions } from '@opencode-ai/plugin/promise/tool'
import { isRecord } from './shared.ts'
import type { LearningToolInfo, OpenCodeContext } from './sdk.ts'
import type { LearningConfig, UnknownRecord } from './types.ts'

export type AddLearningTool = (name: string, info: LearningToolInfo, options: ToolOptions) => void

export const OBJECT_OUTPUT: { type: 'object'; additionalProperties: boolean } = {
  type: 'object',
  additionalProperties: true
}

export function result(output: unknown, content: string): { output: unknown; content: string } {
  return { output: sanitize(output), content }
}

export async function componentStatus(ctx: OpenCodeContext, config: LearningConfig) {
  const commands: Record<string, boolean> = {}
  const out = { reflectorAgent: false, validatorAgent: false, commands }
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

function sanitize(value: unknown): unknown {
  if (isMissingValue(value)) {
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

function isMissingValue(value: unknown): boolean {
  return value === undefined || value === null
}

function sanitizeRecord(value: UnknownRecord): UnknownRecord {
  const out: UnknownRecord = {}
  for (const [key, item] of Object.entries(value)) {
    out[key] = sanitize(item)
  }

  return out
}
