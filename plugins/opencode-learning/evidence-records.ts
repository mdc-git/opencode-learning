import { Buffer } from 'node:buffer'
import { fileURLToPath } from 'node:url'

const EXCERPT_LIMIT = 4096
const PATH_KEYS = new Set(['path', 'target', 'file'])

export function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function excerpt(value: unknown): unknown {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text === undefined || Buffer.byteLength(text) <= EXCERPT_LIMIT) {
    return value
  }

  const bytes = Buffer.from(text)
  return {
    truncated: true,
    bytes: bytes.length,
    head: bytes.subarray(0, EXCERPT_LIMIT / 2).toString(),
    tail: bytes.subarray(-EXCERPT_LIMIT / 2).toString()
  }
}

function toolRecord(part: Record<string, unknown>) {
  const state = record(part.state) ?? {}
  return {
    type: 'tool',
    id: part.id,
    tool: part.name,
    outcome: state.status,
    relevantInput: excerpt(state.input),
    metadata: excerpt(state.metadata),
    observation: excerpt(state.content),
    error: excerpt(state.error)
  }
}

function assistantPart(value: unknown): unknown[] {
  const part = record(value) ?? {}
  const compact = PARTS[String(part.type)]
  return compact === undefined ? [] : [compact(part)]
}

const PARTS: Record<string, (part: Record<string, unknown>) => Record<string, unknown>> = {
  tool: toolRecord,
  text: (part) => ({ type: 'text', claim: excerpt(part.text) })
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function assistant(message: Record<string, unknown>) {
  const content = list(message.content)
  return { content: content.flatMap((part) => assistantPart(part)) }
}

const COMPACTERS: Record<string, (message: Record<string, unknown>) => Record<string, unknown>> = {
  user: (message) => ({ text: message.text, files: excerpt(message.files) }),
  assistant,
  shell: (message) => ({
    command: message.command,
    status: message.status,
    exit: message.exit,
    observation: excerpt(message.output)
  })
}

function collectPaths(value: unknown, paths: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPaths(item, paths)
    }

    return
  }

  collectObjectPaths(value, paths)
}

function collectObjectPaths(value: unknown, paths: Set<string>): void {
  for (const [key, item] of Object.entries(record(value) ?? {})) {
    collectPath(key, item, paths)
  }
}

function collectPath(key: string, value: unknown, paths: Set<string>): void {
  if (typeof value === 'string' && PATH_KEYS.has(key)) {
    paths.add(value)
    return
  }

  collectPaths(value, paths)
}

function fileUri(file: unknown): unknown {
  const attachment = record(file) ?? {}
  const source = record(attachment.source) ?? {}
  return source.uri
}

function filePath(file: unknown): string[] {
  const uri = fileUri(file)
  return typeof uri === 'string' && uri.startsWith('file:') ? [fileURLToPath(uri)] : []
}

function userPaths(message: Record<string, unknown>, paths: Set<string>): void {
  for (const source of list(message.files).flatMap((file) => filePath(file))) {
    paths.add(source)
  }
}

function toolPaths(part: unknown, paths: Set<string>): void {
  const item = record(part) ?? {}
  if (item.type === 'tool') {
    const state = record(item.state) ?? {}
    collectPaths(state.input, paths)
    collectPaths(state.metadata, paths)
  }
}

export function compactMessages(messages: readonly unknown[]) {
  const paths = new Set<string>()
  const records = messages.flatMap((value) => {
    const message = record(value) ?? {}
    const compact = COMPACTERS[String(message.type)]
    if (compact === undefined) {
      return []
    }

    userPaths(message, paths)
    for (const part of list(message.content)) {
      toolPaths(part, paths)
    }

    return [{ type: message.type, messageId: message.id, ...compact(message) }]
  })
  return { records, authorizedPaths: [...paths].toSorted() }
}
