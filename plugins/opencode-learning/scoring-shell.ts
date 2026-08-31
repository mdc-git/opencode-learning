export const CONTROL_FLOW_TOKENS = new Set([';', '&&', '||', '|', '&', '\n'])
const LITERAL_TOKEN_PREFIX = '\0'

type ShellState = { token: string; quote: string; isEscaped: boolean; isComment: boolean }

function flushShellToken(state: ShellState, tokens: string[]): void {
  if (state.token.length > 0) {
    tokens.push(state.token)
  }

  state.token = ''
}

function isShellCommentConsumed(state: ShellState, char: string, tokens: string[]): boolean {
  if (!state.isComment) {
    return false
  }

  if (char === '\n') {
    state.isComment = false
    flushShellToken(state, tokens)
    tokens.push('\n')
  }

  return true
}

function consumeQuotedCharacter(state: ShellState, char: string): void {
  if (state.isEscaped) {
    consumeEscapedCharacter(state, char)
    return
  }

  if (isDoubleQuoteEscape(state, char)) {
    state.isEscaped = true
    return
  }

  if (char === state.quote) {
    state.quote = ''
    return
  }

  state.token += literalShellCharacter(char)
}

function consumeEscapedCharacter(state: ShellState, char: string): void {
  state.token += literalShellCharacter(char)
  state.isEscaped = false
}

function isDoubleQuoteEscape(state: ShellState, char: string): boolean {
  return char === '\\' && state.quote === '"'
}

function isShellQuoteConsumed(state: ShellState, char: string): boolean {
  if (state.quote.length === 0) {
    return false
  }

  consumeQuotedCharacter(state, char)
  return true
}

function consumeShellPlainCharacter(
  state: ShellState,
  text: string,
  index: number,
  tokens: string[]
): number {
  const controlIndex = consumeShellControl(state, text, index, tokens)
  if (controlIndex !== undefined) {
    return controlIndex
  }

  const separatorIndex = consumeShellSeparator(state, text, index, tokens)
  if (separatorIndex !== undefined) {
    return separatorIndex
  }

  const char = text[index]
  state.token += char
  return index
}

function consumeShellControl(
  state: ShellState,
  text: string,
  index: number,
  tokens: string[]
): number | undefined {
  if (isShellCommentStart(state, text, index, tokens)) {
    state.isComment = true
    return index
  }

  return isShellLineBreak(text[index])
    ? consumeShellLineBreak(state, text, index, tokens)
    : undefined
}

function consumeShellSeparator(
  state: ShellState,
  text: string,
  index: number,
  tokens: string[]
): number | undefined {
  const char = text[index]
  if (/\s/v.test(char)) {
    flushShellToken(state, tokens)
    return index
  }

  return [';', '&', '|'].includes(char)
    ? consumeShellOperator(state, text, index, tokens)
    : undefined
}

function isCommentBoundary(text: string, index: number, tokens: string[]): boolean {
  if (index === 0) {
    return true
  }

  return isWhitespaceBefore(text, index) || isControlTokenBefore(tokens)
}

function isWhitespaceBefore(text: string, index: number): boolean {
  return /\s/v.test(text[index - 1] ?? '')
}

function isControlTokenBefore(tokens: string[]): boolean {
  return CONTROL_FLOW_TOKENS.has(tokens.at(-1) ?? '')
}

function isShellCommentStart(
  state: ShellState,
  text: string,
  index: number,
  tokens: string[]
): boolean {
  if (text[index] !== '#' || state.token.length > 0) {
    return false
  }

  return isCommentBoundary(text, index, tokens)
}

function isShellLineBreak(char: string): boolean {
  return ['\n', '\r'].includes(char)
}

function consumeShellLineBreak(
  state: ShellState,
  text: string,
  index: number,
  tokens: string[]
): number {
  flushShellToken(state, tokens)
  tokens.push('\n')
  return text[index] === '\r' && text[index + 1] === '\n' ? index + 1 : index
}

function consumeShellOperator(
  state: ShellState,
  text: string,
  index: number,
  tokens: string[]
): number {
  flushShellToken(state, tokens)
  const char = text[index]
  const operator = text[index + 1] === char ? char + char : char
  tokens.push(operator)
  return operator.length === 2 ? index + 1 : index
}

function consumeShellUnquotedCharacter(
  state: ShellState,
  command: string,
  index: number,
  tokens: string[]
): number {
  const char = command[index]
  if (state.isEscaped) {
    consumeEscapedCharacter(state, char)
    return index
  }

  if (char === '\\') {
    state.isEscaped = true
    return index
  }

  if (isQuote(char)) {
    state.quote = char
    return index
  }

  return consumeShellPlainCharacter(state, command, index, tokens)
}

function isQuote(char: string): boolean {
  return char === '"' || char === "'"
}

function consumeShellCharacter(
  state: ShellState,
  command: string,
  index: number,
  tokens: string[]
): number {
  const char = command[index]
  if (isShellCommentConsumed(state, char, tokens) || isShellQuoteConsumed(state, char)) {
    return index
  }

  return consumeShellUnquotedCharacter(state, command, index, tokens)
}

export function shellTokens(command: string): string[] {
  const tokens: string[] = []
  const state: ShellState = { token: '', quote: '', isEscaped: false, isComment: false }
  for (let index = 0; index < command.length; index++) {
    index = consumeShellCharacter(state, command, index, tokens)
  }

  if (state.isEscaped) {
    state.token += '\\'
  }

  flushShellToken(state, tokens)
  return tokens
}

function literalShellCharacter(char: string): string {
  return CONTROL_FLOW_TOKENS.has(char) ? `${LITERAL_TOKEN_PREFIX}${char}` : char
}

function flushCommandSegment(segments: string[][], segment: string[]): string[] {
  if (segment.length > 0) {
    segments.push(segment)
  }

  return []
}

function consumeCommandToken(segments: string[][], segment: string[], token: string): string[] {
  if (CONTROL_FLOW_TOKENS.has(token)) {
    return flushCommandSegment(segments, segment)
  }

  segment.push(token)
  return segment
}

export function commandSegments(tokens: string[]): string[][] {
  const segments: string[][] = []
  let segment: string[] = []
  for (const token of tokens) {
    segment = consumeCommandToken(segments, segment, token)
  }

  flushCommandSegment(segments, segment)
  return segments
}
