import { isSha256, safeSignalHash, stableHash } from './scoring-hash.ts'
import type {
  CorrectionDetails,
  CorrectionSignal,
  Experience,
  ToolRecord,
  UnknownRecord
} from './scoring-types.ts'

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stripQuotedContent(value: unknown): string {
  let text = typeof value === 'string' ? value : ''
  text = text.replaceAll(/```[\s\S]*?(?:```|$)/gv, ' ').replaceAll(/~~~[\s\S]*?(?:~~~|$)/gv, ' ')
  text = text.replaceAll(/^[\t ]*>.*$/gmv, ' ')
  text = text.replaceAll(/`[^`]*`/gv, ' ')
  text = text.replaceAll(/"(?:\\[\s\S]|[^"\\])*"/gv, ' ')
  text = text.replaceAll(
    // eslint-disable-next-line regexp/no-useless-non-capturing-group, regexp/prefer-character-class
    /(?<=^|(?:\s|\(|,|:|;|\[|\{))'(?:\\[\s\S]|[^'\\])*'/gv,
    ' '
  )
  // Bounded quote matches keep quoted instructions out of correction detection.
  text = text
    // eslint-disable-next-line regexp/no-super-linear-move
    .replaceAll(/\u{201C}[^\u{201D}]*\u{201D}/gv, ' ')
    // eslint-disable-next-line regexp/no-super-linear-move
    .replaceAll(/\u{2018}[^\u{2019}]*\u{2019}/gv, ' ')
  return text
}

const EXPLICIT_CORRECTION_RE =
  /^\s*(?:no\b|nope\b|not\s+quite\b|that(?:'s|\s+is)\s+(?:not\s+right|wrong)\b|wrong\b|correction\b|actually[ ,:]\s*|instead[ ,:]\s*|you\s+(?:missed|should|shouldn't|need\s+to)\b)/iv

export function isExplicitCorrection(text: unknown): boolean {
  return typeof text === 'string' && EXPLICIT_CORRECTION_RE.test(stripQuotedContent(text))
}

function numericTurn(value: unknown): number | undefined {
  const direct = validTurnNumber(value)
  if (direct !== undefined) {
    return direct
  }

  if (typeof value !== 'string') {
    return undefined
  }

  const text = value.trim()
  if (text.length === 0) {
    return undefined
  }

  return validTurnNumber(Number(text))
}

function validTurnNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

export function turnValue(record: ToolRecord): number | undefined {
  if (!isRecord(record)) {
    return undefined
  }

  return numericTurn(record.turn ?? record.turnNumber ?? record.executionTurn)
}

export function turnKey(value: unknown): string | undefined {
  const turn = numericTurn(value)
  return turn === undefined ? undefined : String(turn)
}

function explicitCorrectionSource(value: unknown[] | UnknownRecord | undefined): unknown[] {
  if (Array.isArray(value)) {
    return value
  }

  return isRecord(value) ? [value] : []
}

function legacyCorrectionSource(value: unknown[] | undefined): unknown[] {
  return Array.isArray(value) ? value : []
}

function correctionSource(experience: Experience): unknown[] {
  const explicit = explicitCorrectionSource(experience?.correctionSignals)
  if (explicit.length > 0) {
    return explicit
  }

  return legacyCorrectionSource(experience?.corrections)
}

function correctionSignal(item: unknown): CorrectionSignal | undefined {
  const details = correctionDetails(item)
  if (!details) {
    return undefined
  }

  const fingerprint = details.fingerprint ?? details.text
  if (!hasCorrectionFingerprint(fingerprint)) {
    return undefined
  }

  return {
    turn: details.turn,
    index: details.index,
    at: details.at,
    fingerprint: safeSignalHash(fingerprint)
  }
}

function hasCorrectionFingerprint(value: unknown): boolean {
  return value !== undefined && value !== null && (typeof value !== 'string' || value.length > 0)
}

function correctionDetails(item: unknown): CorrectionDetails | undefined {
  return isRecord(item) ? recordCorrectionDetails(item) : primitiveCorrectionDetails(item)
}

function recordCorrectionDetails(item: UnknownRecord): CorrectionDetails | undefined {
  const text = item.text ?? item.message ?? item.correction
  if (!hasCorrectionDetails(item, text)) {
    return undefined
  }

  return {
    fingerprint: item.fingerprint,
    text,
    turn: turnValue(item),
    index: numericValue(item.index ?? item.toolIndex ?? item.order),
    at: numericValue(item.at)
  }
}

function hasCorrectionDetails(item: UnknownRecord, text: unknown): boolean {
  return item.fingerprint !== undefined || isExplicitCorrection(text)
}

function primitiveCorrectionDetails(item: unknown): CorrectionDetails | undefined {
  if (isExplicitCorrection(item) || isSha256(item)) {
    return { fingerprint: item }
  }

  return undefined
}

export function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) {
    return Number(value)
  }

  return undefined
}

export function correctionSignals(experience: Experience): CorrectionSignal[] {
  return correctionSource(experience)
    .map((item) => correctionSignal(item))
    .filter((signal): signal is CorrectionSignal => signal !== undefined)
}

export function isFailure(record: ToolRecord): boolean {
  return typeof record?.status === 'string' && FAILURE_STATUSES.has(record.status.toLowerCase())
}

const FAILURE_STATUSES = new Set(['error', 'failed', 'failure'])
