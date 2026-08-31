import {
  commandText,
  extractCommand,
  inputField,
  isExecutionTool,
  isRecognizedVerification,
  normalizedCommandOperation,
  normalizeTool,
  parseInput,
  shellTokens
} from './scoring-commands.ts'
import { normalizeForComparison, normalizedTarget, stableHash } from './scoring-hash.ts'
import type { OperationDescriptor, ToolKind, ToolRecord, UnknownRecord } from './scoring-types.ts'

const INSPECTION_TOOLS = new Set(['read', 'grep', 'glob', 'webfetch', 'websearch', 'skill'])
const MUTATION_TOOLS = new Set(['patch', 'edit', 'write'])
const DELEGATE_TOOLS = new Set(['task', 'delegate', 'subagent', 'agent', 'spawn'])

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstDefinedInput(record: ToolRecord, names: string[]): unknown {
  for (const name of names) {
    const value = inputField(record, name)
    if (value !== undefined && value !== null) {
      return value
    }
  }

  return undefined
}

function operationFromRecord(record: ToolRecord, tool: string, command: string): string {
  if (command.length > 0) {
    return normalizedCommandOperation(command)
  }

  return operationFromValue(
    firstDefinedInput(record, ['operation', 'action', 'subcommand', 'kind']),
    tool
  )
}

function operationFromValue(value: unknown, tool: string): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.normalize('NFKC').trim().toLowerCase().replaceAll(/\s+/gv, ' ')
  }

  return tool.length > 0 ? tool : 'operation'
}

export function operationDescriptor(record: ToolRecord): OperationDescriptor {
  const tool = normalizeTool(record)
  const command = isExecutionTool(tool) ? extractCommand(record) : ''
  const target = normalizedTarget(firstDefinedInput(record, ['path', 'file', 'uri', 'id', 'name']))
  return { tool, operation: operationFromRecord(record, tool, command), target }
}

function inputSource(record: ToolRecord): unknown {
  if (!isRecord(record)) {
    return undefined
  }

  return firstDefinedInput(record, ['input', 'command', 'cmd', 'params', 'arguments'])
}

function executionCommand(record: ToolRecord): string {
  return isExecutionTool(normalizeTool(record)) ? extractCommand(record) : ''
}

function normalizeFingerprintInput(record: ToolRecord, input: unknown): unknown {
  const command = executionCommand(record)
  if (command.length === 0) {
    return normalizeForComparison(input)
  }

  return normalizeShellInput(input, 0, typeof input === 'string' || Array.isArray(input))
}

function inputFingerprint(record: ToolRecord): string {
  const input = parseInput(inputSource(record))
  return stableHash({ input: normalizeFingerprintInput(record, input) })
}

const SHELL_INPUT_KEYS = new Set(['command', 'cmd', 'script', 'shell'])

function normalizeShellRecord(value: UnknownRecord, depth: number): UnknownRecord {
  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [key, normalizeShellProperty(value[key], key, depth)])
  )
}

function normalizeShellProperty(value: unknown, key: string, depth: number): unknown {
  return SHELL_INPUT_KEYS.has(key)
    ? normalizeShellInput(value, depth + 1, true)
    : normalizeShellInput(value, depth + 1)
}

function normalizeShellValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) {
    return value
  }

  return normalizeNonNullShellValue(value, depth)
}

function normalizeNonNullShellValue(value: unknown, depth: number): unknown {
  if (typeof value === 'string') {
    return normalizeForComparison(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeShellInput(item, depth + 1))
  }

  if (!isRecord(value)) {
    return value
  }

  return normalizeShellRecord(value, depth)
}

function normalizeShellInput(value: unknown, depth = 0, isCommandValue = false): unknown {
  return normalizeShellInputAt(value, depth, isCommandValue)
}

function normalizeShellInputAt(value: unknown, depth: number, isCommandValue: boolean): unknown {
  if (depth > 8) {
    return '[DepthLimit]'
  }

  if (isCommandValue) {
    return shellTokens(commandText(value))
  }

  return normalizeShellValue(value, depth)
}

function directToolKind(tool: string): ToolKind | undefined {
  if (INSPECTION_TOOLS.has(tool)) {
    return 'inspect'
  }

  if (MUTATION_TOOLS.has(tool)) {
    return 'mutate'
  }

  if (DELEGATE_TOOLS.has(tool)) {
    return 'delegate'
  }

  return undefined
}

function executionToolKind(record: ToolRecord): ToolKind {
  return record?.status === 'success' && isRecognizedVerification(extractCommand(record))
    ? 'verify'
    : 'execute'
}

export function classifyToolCall(record: ToolRecord): ToolKind {
  const tool = normalizeTool(record)
  const direct = directToolKind(tool)
  if (direct !== undefined) {
    return direct
  }

  if (isExecutionTool(tool)) {
    return executionToolKind(record)
  }

  return 'other'
}

export function operationFingerprint(record: ToolRecord): string {
  return stableHash(operationDescriptor(record))
}

export function inputFingerprintFor(record: ToolRecord): string {
  return inputFingerprint(record)
}
