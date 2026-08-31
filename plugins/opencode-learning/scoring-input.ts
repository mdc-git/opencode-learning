type UnknownRecord = Record<string, unknown>
type ToolRecord = UnknownRecord

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseInput(value: unknown, depth = 0): unknown {
  return parseInputAtDepth(value, depth)
}

function parseInputAtDepth(value: unknown, depth: number): unknown {
  if (typeof value !== 'string' || depth > 4) {
    return value
  }

  const text = value.trim()
  if (text.length === 0) {
    return value
  }

  return parseJsonInput(value, text, depth)
}

function parseJsonInput(original: string, text: string, depth: number): unknown {
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed === original ? original : parseInputAtDepth(parsed, depth + 1)
  } catch {
    return original
  }
}

function inputCandidates(record: ToolRecord): unknown[] {
  const source = isRecord(record) ? record : {}
  const candidates: unknown[] = []
  const add = (value: unknown): void => {
    if (value === undefined || candidates.includes(value)) {
      return
    }

    candidates.push(value)
    if (isRecord(value)) {
      add(value.params)
      add(value.arguments)
      add(value.input)
    }
  }

  add(parseInput(source.input))
  add(parseInput(source.params))
  add(parseInput(source.arguments))
  return candidates
}

function candidateField(candidate: unknown, name: string): unknown {
  return isRecord(candidate) && candidate[name] !== undefined ? candidate[name] : undefined
}

export function inputField(record: ToolRecord, name: string): unknown {
  for (const candidate of inputCandidates(record)) {
    const value = candidateField(candidate, name)
    if (value !== undefined) {
      return value
    }
  }

  return isRecord(record) ? record[name] : undefined
}

function isInvalidCommandValue(value: unknown, depth: number): boolean {
  return value === null || value === undefined || depth > 4
}

export function commandText(value: unknown, depth = 0): string {
  return commandTextAtDepth(value, depth)
}

function commandTextAtDepth(value: unknown, depth: number): string {
  if (isInvalidCommandValue(value, depth)) {
    return ''
  }

  return commandTextNonInvalid(value, depth)
}

function commandTextNonInvalid(value: unknown, depth: number): string {
  if (typeof value === 'string') {
    return value
  }

  if (Array.isArray(value)) {
    return commandTextArray(value, depth)
  }

  if (!isRecord(value)) {
    return ''
  }

  return commandTextRecord(value, depth)
}

function commandTextArray(value: unknown[], depth: number): string {
  return value
    .map((item) => commandTextAtDepth(item, depth + 1))
    .filter(Boolean)
    .join(' ')
}

function commandTextRecord(value: UnknownRecord, depth: number): string {
  for (const key of ['command', 'cmd', 'script', 'shell']) {
    const text = commandTextAtDepth(value[key], depth + 1)
    if (text.length > 0) {
      return text
    }
  }

  return ''
}

function firstCommandText(values: unknown[]): string | undefined {
  return values.map((value) => commandText(value)).find((text) => text.length > 0)
}

function recordCommandText(record: ToolRecord): string {
  const source = isRecord(record) ? record : {}
  return commandText(source.command ?? source.cmd)
}

export function extractCommand(record: ToolRecord): string {
  return firstCommandText(inputCandidates(record)) ?? recordCommandText(record)
}

export function normalizeTool(record: ToolRecord): string {
  const value = toolNameValue(record)
  if (value === undefined) {
    return ''
  }

  const parts = value
    .trim()
    .toLowerCase()
    .split(/[.\/\\]/v)
  return parts.at(-1) ?? ''
}

function toolNameValue(record: ToolRecord): string | undefined {
  if (!isRecord(record)) {
    return undefined
  }

  const value = record.tool ?? record.name
  return typeof value === 'string' ? value : undefined
}
