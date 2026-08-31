import type { OptionSpec } from './scoring-command-config.ts'

function optionName(token: string): string {
  const equals = token.indexOf('=')
  return equals > 0 ? token.slice(0, equals) : token
}

export function optionKind(token: string, spec: OptionSpec): 'value' | 'flag' | 'unknown' {
  const name = optionName(token)
  if (
    spec.values.has(token) ||
    spec.values.has(name) ||
    spec.prefixes.some((prefix) => token.startsWith(prefix) && token.length > prefix.length)
  ) {
    return 'value'
  }

  if (spec.flags.has(token) || spec.flags.has(name)) {
    return 'flag'
  }

  return 'unknown'
}

export function isOptionValueAttached(token: string, spec: OptionSpec): boolean {
  const name = optionName(token)
  return (
    name !== token ||
    spec.prefixes.some((prefix) => token.startsWith(prefix) && token.length > prefix.length)
  )
}

export function nextOptionValueIndex(tokens: string[], index: number): number | undefined {
  return tokens[index + 1] === undefined ? undefined : index + 2
}

type CommandWordResult = { wordIndex: number } | { skipTo: number }

export function firstCommandWord(
  tokens: string[],
  start: number,
  spec: OptionSpec
): { value: string; index: number } | undefined {
  let index = start
  while (index < tokens.length) {
    const next = commandWordResult(tokens, index, spec)
    if ('wordIndex' in next) {
      return { value: tokens[next.wordIndex], index: next.wordIndex }
    }

    index = next.skipTo
  }

  return undefined
}

function isCommandWord(token: string): boolean {
  return token === '-' || !token.startsWith('-')
}

function commandWordResult(tokens: string[], index: number, spec: OptionSpec): CommandWordResult {
  const token = tokens[index]
  if (token === '--') {
    return delimiterCommandWord(tokens, index)
  }

  if (isCommandWord(token)) {
    return { wordIndex: index }
  }

  const next = skipCommandOption(tokens, index, spec)
  return { skipTo: next ?? tokens.length }
}

function delimiterCommandWord(tokens: string[], index: number): CommandWordResult {
  return tokens[index + 1] === undefined ? { skipTo: tokens.length } : { wordIndex: index + 1 }
}

function skipCommandOption(tokens: string[], index: number, spec: OptionSpec): number | undefined {
  const token = tokens[index]
  const kind = optionKind(token, spec)
  if (kind === 'unknown') {
    return undefined
  }

  if (kind === 'value' && !isOptionValueAttached(token, spec)) {
    return nextOptionValueIndex(tokens, index)
  }

  return index + 1
}

type PositionalToken = {
  word?: string
  words?: string[]
  nextIndex: number
  done: boolean
}
const POSITIONAL_DONE = -1

function positionalToken(
  tokens: string[],
  index: number,
  spec: OptionSpec
): PositionalToken | undefined {
  const token = tokens[index]
  if (token === '--') {
    return { words: tokens.slice(index + 1), nextIndex: tokens.length, done: true }
  }

  if (isCommandWord(token)) {
    return { word: token, nextIndex: index, done: false }
  }

  const next = positionalOptionIndex(tokens, index, spec)
  return next === undefined ? undefined : { nextIndex: next, done: false }
}

function consumePositionalToken(
  tokens: string[],
  index: number,
  spec: OptionSpec,
  words: string[]
): number | undefined {
  const item = positionalToken(tokens, index, spec)
  if (item === undefined) {
    return undefined
  }

  if (item.words !== undefined) {
    words.push(...item.words)
  } else if (item.word !== undefined) {
    words.push(item.word)
  }

  return item.done ? POSITIONAL_DONE : item.nextIndex
}

export function positionalCommandWords(tokens: string[], spec: OptionSpec): string[] | undefined {
  const words: string[] = []
  let index = 0
  let nextIndex = 0
  while (nextIndex !== POSITIONAL_DONE && index < tokens.length) {
    const next = consumePositionalToken(tokens, index, spec, words)
    if (next === undefined) {
      return undefined
    }

    nextIndex = next
    index = nextIndex + 1
  }

  return words
}

function positionalOptionIndex(
  tokens: string[],
  index: number,
  spec: OptionSpec
): number | undefined {
  const token = tokens[index]
  const kind = optionKind(token, spec)
  if (kind === 'unknown') {
    return undefined
  }

  return kind === 'value' && !isOptionValueAttached(token, spec)
    ? nextPositionalValueIndex(tokens, index)
    : index
}

function nextPositionalValueIndex(tokens: string[], index: number): number | undefined {
  return tokens[index + 1] === undefined ? undefined : index + 1
}
