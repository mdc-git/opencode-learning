import { createHash } from 'node:crypto'
import type { StructuredValue } from './scoring-types.ts'

function serializePrimitive(value: unknown): string | undefined {
  if (value === null) {
    return 'null'
  }

  return PRIMITIVE_SERIALIZERS.get(typeof value)?.(value)
}

function isObjectValue(value: unknown): value is StructuredValue {
  return typeof value === 'object' && value !== null
}

function serializeStructuredValue(value: StructuredValue, seen: Set<unknown>): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item, seen)).join(',')}]`
  }

  const record = value
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`)
    .join(',')}}`
}

function stableSerialize(value: unknown, seen: Set<unknown>): string {
  const primitive = serializePrimitive(value)
  if (primitive !== undefined) {
    return primitive
  }

  if (!isObjectValue(value)) {
    return 'undefined'
  }

  if (seen.has(value)) {
    return JSON.stringify('[Circular]')
  }

  seen.add(value)
  const result = serializeStructuredValue(value, seen)
  seen.delete(value)
  return result
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value, new Set())).digest('hex')
}

export function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/iv.test(value.trim())
}

export function safeSignalHash(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return isSha256(text) ? text.toLowerCase() : stableHash(value)
}

export function normalizedTarget(value: unknown): string {
  if (isEmptyTarget(value)) {
    return ''
  }

  if (typeof value === 'string') {
    return value.normalize('NFKC').trim().replaceAll('\\', '/')
  }

  return stableSerialize(value, new Set())
}

function isEmptyTarget(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.length === 0)
}

export function normalizeForComparison(value: unknown): unknown {
  return normalizeComparison(value, new Set())
}

function normalizeComparison(value: unknown, seen: Set<unknown>): unknown {
  if (typeof value === 'string') {
    return value.normalize('NFKC').replaceAll('\r\n', '\n').trim()
  }

  if (!isObjectValue(value)) {
    return value
  }

  if (seen.has(value)) {
    return '[Circular]'
  }

  seen.add(value)
  const result = normalizeComparableObject(value, seen)
  seen.delete(value)
  return result
}

function normalizeComparableObject(value: StructuredValue, seen: Set<unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeComparison(item, seen))
  }

  const record = value
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .map((key) => [key, normalizeComparison(record[key], seen)])
  )
}

const PRIMITIVE_SERIALIZERS = new Map<string, (value: unknown) => string>([
  ['undefined', () => 'undefined'],
  ['string', (value) => JSON.stringify(value)],
  ['number', (value) => (Number.isFinite(value) ? String(value) : JSON.stringify(String(value)))],
  ['boolean', String],
  ['bigint', (value) => `${JSON.stringify(String(value))}n`],
  ['symbol', (value) => JSON.stringify(String(value))],
  ['function', (value) => JSON.stringify(String(value))]
])
