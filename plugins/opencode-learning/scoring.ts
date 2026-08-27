import { createHash } from 'node:crypto'

type UnknownRecord = Record<string, unknown>
type ToolRecord = UnknownRecord
type TurnRecord = UnknownRecord
type SignalKind = 'correction' | 'recovery' | 'workflow'
type ToolKind = 'inspect' | 'mutate' | 'execute' | 'verify' | 'delegate' | 'other'
type OperationDescriptor = { tool: string; operation: string; target: string }
type CorrectionSignal = { turn?: number; index?: number; at?: number; fingerprint: string }
type FeatureSignal = { kind: SignalKind; fingerprint: string }
type EnrichedCall = {
  record: ToolRecord
  index: number
  turn?: number
  kind: ToolKind
  isSuccess: boolean
  isFailure: boolean
  descriptor: OperationDescriptor
  operationFingerprint: string
  inputFingerprint: string
}
type WorkflowRecord = { turn?: string; fingerprint: string }
type CorrectionDetails = {
  fingerprint?: unknown
  text?: unknown
  turn?: number
  index?: number
  at?: number
}
export type TriggerFeatures = {
  incorporatedCorrections?: number
  confirmedRecoveries?: number
  repeatedVerifiedWorkflows?: number
  successfulVerificationsAfterMutation?: number
  unresolvedFailures?: number
  distinctCategories?: number
  signalFingerprints?: Array<FeatureSignal | string>
}
export type TriggerDecision = {
  eligible: boolean
  score: number
  threshold: number
  strongSignals: SignalKind[]
  workflowOnly: boolean
  fingerprint: string
  reasons: {
    incorporatedCorrections: number
    confirmedRecoveries: number
    repeatedVerifiedWorkflows: number
    successfulVerificationsAfterMutation: number
    unresolvedFailures: number
    distinctCategories: number
  }
}
export type Experience = {
  toolCalls?: ToolRecord[]
  correctionSignals?: unknown[] | UnknownRecord
  corrections?: unknown[]
  turns?: TurnRecord[]
  completedTurns?: TurnRecord[]
}
type OptionSpec = { values: Set<string>; flags: Set<string>; prefixes: string[] }

export const DEFAULT_SCORE_THRESHOLD = 12
export const WORKFLOW_COOLDOWN_TURNS = 3

const INSPECTION_TOOLS = new Set(['read', 'grep', 'glob', 'webfetch', 'websearch', 'skill'])
const MUTATION_TOOLS = new Set(['patch', 'edit', 'write'])
const EXECUTION_TOOLS = new Set(['shell', 'execute', 'bash'])
const DELEGATE_TOOLS = new Set(['task', 'delegate', 'subagent', 'agent', 'spawn'])
const FAILURE_STATUSES = new Set(['error', 'failed', 'failure'])
const STRONG_SIGNAL_KINDS = new Set(['correction', 'recovery', 'workflow'])
const ACTION_KINDS = new Set(['mutate', 'execute'])
const WORKFLOW_KINDS = new Set(['mutate', 'execute', 'verify'])
const PACKAGE_VERIFICATION_COMMANDS = new Set(['test', 'lint', 'typecheck', 'check', 'build'])
const MAKE_VERIFICATION_COMMANDS = new Set(['test', 'check', 'build'])
const GRADLE_VERIFICATION_COMMANDS = new Set(['test', 'check', 'build'])
const MAVEN_VERIFICATION_COMMANDS = new Set(['test', 'verify'])
const OPTION_VALUES = new Set([
  '-c',
  '-C',
  '-f',
  '-p',
  '--config',
  '--cwd',
  '--directory',
  '--file',
  '--filter',
  '--framework',
  '--gradle-user-home',
  '--include-build',
  '--init-script',
  '--manifest-path',
  '--modfile',
  '--package',
  '--prefix',
  '--project',
  '--project-dir',
  '--runtime',
  '--settings',
  '--solution',
  '--target-dir',
  '--target-framework',
  '--toolchains',
  '--userconfig',
  '--workspace',
  '--dir',
  '-F',
  '-s'
])
const PYTHON_OPTION_VALUES = new Set(['-W', '-X', '-c'])
const PYTHON_OPTION_FLAGS = new Set([
  '-B',
  '-E',
  '-H',
  '-I',
  '-i',
  '-O',
  '-OO',
  '-q',
  '-s',
  '-S',
  '-u',
  '-v',
  '-V',
  '-x'
])
const PACKAGE_OPTION_VALUES = new Set([
  '--cache',
  '--cache-folder',
  '--color',
  '--config',
  '--cwd',
  '--dir',
  '--fetch-retries',
  '--fetch-retry-factor',
  '--fetch-retry-maxtimeout',
  '--fetch-timeout',
  '--filter',
  '--globalconfig',
  '--include',
  '--location',
  '--loglevel',
  '--maxsockets',
  '--modules-folder',
  '--mutex',
  '--network-timeout',
  '--node-options',
  '--omit',
  '--prefix',
  '--registry',
  '--script-shell',
  '--tag',
  '--userconfig',
  '--workspace',
  '-C',
  '-F'
])
const GO_OPTION_VALUES = new Set([
  '-C',
  '-asmflags',
  '-exec',
  '-gcflags',
  '-ldflags',
  '-modfile',
  '-overlay',
  '-tags',
  '-toolexec',
  '--modfile'
])
const CARGO_OPTION_VALUES = new Set([
  '--config',
  '--color',
  '--features',
  '--jobs',
  '--manifest-path',
  '--message-format',
  '--package',
  '--profile',
  '--target',
  '--target-dir',
  '--timings',
  '-p',
  '-j'
])
const ZIG_OPTION_VALUES = new Set([
  '--build-file',
  '--cache-dir',
  '--global-cache-dir',
  '--summary'
])
const MAKE_OPTION_VALUES = new Set([
  '-C',
  '-f',
  '-I',
  '-o',
  '-W',
  '--assume-old',
  '--directory',
  '--file',
  '--include-dir',
  '--old-file'
])
const GRADLE_OPTION_VALUES = new Set([
  '--console',
  '--dependency-verification',
  '--exclude-task',
  '--gradle-user-home',
  '--include-build',
  '--init-script',
  '--max-workers',
  '--project-cache-dir',
  '--priority',
  '--project-dir',
  '--settings-file',
  '--tests',
  '--warning-mode',
  '--build-file',
  '--system-prop',
  '--project-prop',
  '--write-verification-metadata',
  '-I',
  '-P',
  '-p'
])
const MAVEN_OPTION_VALUES = new Set([
  '--activate-profiles',
  '--file',
  '--log-file',
  '--projects',
  '--resume-from',
  '--settings',
  '--threads',
  '--toolchains',
  '--define',
  '--encrypt-master-password',
  '--encrypt-password',
  '-t',
  '-D',
  '-P',
  '-T',
  '-f',
  '-pl',
  '-s'
])
const DOTNET_OPTION_VALUES = new Set([
  '--arch',
  '--configuration',
  '--filter',
  '--framework',
  '--logger',
  '--os',
  '--output',
  '--project',
  '--runtime',
  '--solution',
  '--verbosity',
  '-c',
  '-f',
  '-o'
])
const PACKAGE_OPTION_FLAGS = new Set([
  '--frozen-lockfile',
  '--global',
  '--ignore-scripts',
  '--if-present',
  '--offline',
  '--quiet',
  '--recursive',
  '--silent',
  '--workspace-root',
  '-g',
  '-r'
])
const GO_OPTION_FLAGS = new Set(['-a', '-race', '-trimpath', '-v', '-x'])
const CARGO_OPTION_FLAGS = new Set([
  '--all-features',
  '--all-targets',
  '--locked',
  '--offline',
  '--release',
  '--workspace',
  '-q',
  '-v'
])
const ZIG_OPTION_FLAGS = new Set(['--verbose', '-freference-trace'])
const MAKE_OPTION_FLAGS = new Set([
  '--always-make',
  '--debug',
  '--dry-run',
  '--jobs',
  '--keep-going',
  '--no-builtin-rules',
  '--no-print-directory',
  '--print-data-base',
  '--question',
  '--silent',
  '--touch',
  '-B',
  '-d',
  '-j',
  '-n',
  '-p',
  '-q',
  '-s',
  '-t'
])
const GRADLE_OPTION_FLAGS = new Set([
  '--build-cache',
  '--continue',
  '--daemon',
  '--no-build-cache',
  '--no-daemon',
  '--no-parallel',
  '--offline',
  '--parallel',
  '--quiet',
  '--refresh-dependencies',
  '--rerun-tasks',
  '--scan',
  '--stacktrace',
  '--stop',
  '--version',
  '-q',
  '-S',
  '-s',
  '-v'
])
const MAVEN_OPTION_FLAGS = new Set([
  '--also-make',
  '--also-make-dependents',
  '--batch-mode',
  '--debug',
  '--fail-at-end',
  '--fail-fast',
  '--non-recursive',
  '--offline',
  '--quiet',
  '--show-version',
  '--update-snapshots',
  '-B',
  '-b',
  '-e',
  '-N',
  '-o',
  '-q',
  '-U',
  '-X'
])
const DOTNET_OPTION_FLAGS = new Set([
  '--no-build',
  '--no-restore',
  '--nologo',
  '--no-self-contained',
  '--self-contained',
  '-nologo'
])
const OPTION_PREFIXES = new Map([
  ['gradle', ['-D', '-P']],
  ['gradlew', ['-D', '-P']],
  ['mvn', ['-D', '-P', '-pl']],
  ['mvnw', ['-D', '-P', '-pl']],
  ['zig', ['-D']],
  ['make', ['-j']]
])
const CONTROL_FLOW_TOKENS = new Set([';', '&&', '||', '|', '&', '\n'])
const LITERAL_TOKEN_PREFIX = '\0'
const SKIPPED_COMMANDS = new Set(['cd', 'export', 'set', 'source'])
const ENV_OPTION_VALUES = new Set(['-C', '-S', '--chdir', '--split-string', '--unset', '-u'])
const ENV_OPTION_FLAGS = new Set(['--ignore-environment', '--null', '-0', '-i'])
const ENV_OPTION_PREFIXES = ['-C', '-S', '-u']
const ENV_OPTION_SPEC = {
  values: ENV_OPTION_VALUES,
  flags: ENV_OPTION_FLAGS,
  prefixes: ENV_OPTION_PREFIXES
}
const OPTION_VALUES_BY_EXECUTABLE = new Map<string, Set<string>>([
  ['npm', PACKAGE_OPTION_VALUES],
  ['pnpm', PACKAGE_OPTION_VALUES],
  ['yarn', PACKAGE_OPTION_VALUES],
  ['bun', PACKAGE_OPTION_VALUES],
  ['go', GO_OPTION_VALUES],
  ['cargo', CARGO_OPTION_VALUES],
  ['zig', ZIG_OPTION_VALUES],
  ['make', MAKE_OPTION_VALUES],
  ['gradle', GRADLE_OPTION_VALUES],
  ['gradlew', GRADLE_OPTION_VALUES],
  ['mvn', MAVEN_OPTION_VALUES],
  ['mvnw', MAVEN_OPTION_VALUES],
  ['dotnet', DOTNET_OPTION_VALUES]
])
const OPTION_FLAGS_BY_EXECUTABLE = new Map<string, Set<string>>([
  ['npm', PACKAGE_OPTION_FLAGS],
  ['pnpm', PACKAGE_OPTION_FLAGS],
  ['yarn', PACKAGE_OPTION_FLAGS],
  ['bun', PACKAGE_OPTION_FLAGS],
  ['go', GO_OPTION_FLAGS],
  ['cargo', CARGO_OPTION_FLAGS],
  ['zig', ZIG_OPTION_FLAGS],
  ['make', MAKE_OPTION_FLAGS],
  ['gradle', GRADLE_OPTION_FLAGS],
  ['gradlew', GRADLE_OPTION_FLAGS],
  ['mvn', MAVEN_OPTION_FLAGS],
  ['mvnw', MAVEN_OPTION_FLAGS],
  ['dotnet', DOTNET_OPTION_FLAGS]
])
const EMPTY_OPTION_FLAGS = new Set<string>()

const PRIMITIVE_SERIALIZERS = new Map<string, (value: unknown) => string>([
  ['undefined', () => 'undefined'],
  ['string', (value) => JSON.stringify(value)],
  ['number', (value) => (Number.isFinite(value) ? String(value) : JSON.stringify(String(value)))],
  ['boolean', String],
  ['bigint', (value) => `${JSON.stringify(String(value))}n`],
  ['symbol', (value) => JSON.stringify(String(value))],
  ['function', (value) => JSON.stringify(String(value))]
])

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function serializePrimitive(value: unknown): string | undefined {
  if (value === null) {
    return 'null'
  }

  return PRIMITIVE_SERIALIZERS.get(typeof value)?.(value)
}

function stableSerialize(value: unknown, seen = new Set<unknown>()): string {
  const primitive = serializePrimitive(value)
  if (primitive !== undefined) {
    return primitive
  }

  if (typeof value !== 'object' || value === null) {
    return 'undefined'
  }

  if (seen.has(value)) {
    return JSON.stringify('[Circular]')
  }

  seen.add(value)
  let result
  if (Array.isArray(value)) {
    result = `[${value.map((item) => stableSerialize(item, seen)).join(',')}]`
  } else {
    const record = value as UnknownRecord
    result = `{${Object.keys(record)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`)
      .join(',')}}`
  }

  seen.delete(value)
  return result
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex')
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/iv.test(value.trim())
}

function safeSignalHash(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return isSha256(text) ? text.toLowerCase() : stableHash(value)
}

function parseInput(value: unknown, depth = 0): unknown {
  if (typeof value !== 'string' || depth > 4) {
    return value
  }

  const text = value.trim()
  if (text.length === 0) {
    return value
  }

  try {
    const parsed = JSON.parse(text) as unknown
    return parsed === value ? value : parseInput(parsed, depth + 1)
  } catch {
    return value
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

function inputField(record: ToolRecord, name: string): unknown {
  for (const candidate of inputCandidates(record)) {
    if (isRecord(candidate) && candidate[name] !== undefined) {
      return candidate[name]
    }
  }

  if (isRecord(record) && record[name] !== undefined) {
    return record[name]
  }

  return undefined
}

function commandText(value: unknown, depth = 0): string {
  if (value === null || value === undefined || depth > 4) {
    return ''
  }

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
    .map((item) => commandText(item, depth + 1))
    .filter(Boolean)
    .join(' ')
}

function commandTextRecord(value: UnknownRecord, depth: number): string {
  for (const key of ['command', 'cmd', 'script', 'shell']) {
    const text = commandText(value[key], depth + 1)
    if (text.length > 0) {
      return text
    }
  }

  return ''
}

function extractCommand(record: ToolRecord): string {
  for (const candidate of inputCandidates(record)) {
    const text = commandText(candidate)
    if (text.length > 0) {
      return text
    }
  }

  const source = isRecord(record) ? record : {}
  const text = commandText(source.command ?? source.cmd)
  if (text.length > 0) {
    return text
  }

  return ''
}

function normalizeTool(record: ToolRecord): string {
  if (!isRecord(record)) {
    return ''
  }

  const value = record.tool ?? record.name
  if (typeof value !== 'string') {
    return ''
  }

  const parts = value
    .trim()
    .toLowerCase()
    .split(/[.\/\\]/v)
  return parts.at(-1) ?? ''
}

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

function isShellQuoteConsumed(state: ShellState, char: string): boolean {
  if (state.quote.length === 0) {
    return false
  }

  if (state.isEscaped) {
    state.token += literalShellCharacter(char)
    state.isEscaped = false
  } else if (char === '\\' && state.quote === '"') {
    state.isEscaped = true
  } else if (char === state.quote) {
    state.quote = ''
  } else {
    state.token += literalShellCharacter(char)
  }

  return true
}

function consumeShellPlainCharacter(
  state: ShellState,
  text: string,
  index: number,
  tokens: string[]
): number {
  const char = text[index]
  if (isShellCommentStart(state, text, index, tokens)) {
    state.isComment = true
    return index
  }

  if (isShellLineBreak(char)) {
    return consumeShellLineBreak(state, text, index, tokens)
  }

  if (/\s/v.test(char)) {
    flushShellToken(state, tokens)
    return index
  }

  if ([';', '&', '|'].includes(char)) {
    return consumeShellOperator(state, text, index, tokens)
  }

  state.token += char
  return index
}

function isShellCommentStart(
  state: ShellState,
  text: string,
  index: number,
  tokens: string[]
): boolean {
  return (
    text[index] === '#' &&
    state.token.length === 0 &&
    (index === 0 ||
      /\s/v.test(text[index - 1] ?? '') ||
      CONTROL_FLOW_TOKENS.has(tokens.at(-1) ?? ''))
  )
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

function shellTokens(command: string): string[] {
  const tokens: string[] = []
  const state: ShellState = { token: '', quote: '', isEscaped: false, isComment: false }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (isShellCommentConsumed(state, char, tokens) || isShellQuoteConsumed(state, char)) {
      continue
    }

    if (state.isEscaped) {
      state.token += literalShellCharacter(char)
      state.isEscaped = false
      continue
    }

    if (char === '\\') {
      state.isEscaped = true
      continue
    }

    if (char === '"' || char === "'") {
      state.quote = char
      continue
    }

    index = consumeShellPlainCharacter(state, command, index, tokens)
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

function commandSegments(tokens: string[]): string[][] {
  const segments: string[][] = []
  let segment: string[] = []
  for (const token of tokens) {
    if (CONTROL_FLOW_TOKENS.has(token)) {
      if (segment.length > 0) {
        segments.push(segment)
      }

      segment = []
    } else {
      segment.push(token)
    }
  }

  if (segment.length > 0) {
    segments.push(segment)
  }

  return segments
}

function normalizedExecutable(value: string | undefined): string {
  if (typeof value !== 'string') {
    return ''
  }

  let executable =
    value
      .trim()
      .toLowerCase()
      .split(/[\/\\]/v)
      .at(-1) ?? ''
  if (executable.endsWith('.cmd') || executable.endsWith('.exe')) {
    executable = executable.slice(0, -4)
  }

  if (['python3', 'python2', 'py'].includes(executable)) {
    return 'python'
  }

  if (executable === 'gradlew.bat') {
    return 'gradlew'
  }

  if (executable === 'mvnw.bat') {
    return 'mvnw'
  }

  return executable
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[a-z_]\w*=/iv.test(token)
}

function skipEnvironmentOptions(tokens: string[], start: number): number | undefined {
  let index = start
  while (index < tokens.length) {
    const next = nextEnvironmentIndex(tokens, index)
    if (next === undefined) {
      return undefined
    }

    if (next === index) {
      return index
    }

    index = next
  }

  return index
}

function nextEnvironmentIndex(tokens: string[], index: number): number | undefined {
  const option = tokens[index]
  if (option === '--') {
    return index + 1
  }

  if (isEnvironmentAssignment(option)) {
    return index + 1
  }

  if (!option.startsWith('-')) {
    return index
  }

  const kind = optionKind(option, ENV_OPTION_SPEC)
  if (kind === 'unknown') {
    return undefined
  }

  if (kind === 'value' && !isOptionValueAttached(option, ENV_OPTION_SPEC)) {
    return tokens[index + 1] === undefined ? undefined : index + 2
  }

  return index + 1
}

function unwrapCommand(tokens: string[]): string[] {
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    const executable = normalizedExecutable(token)
    if (isEnvironmentAssignment(token) || ['sudo', 'time', 'command'].includes(executable)) {
      index++
      continue
    }

    if (executable === 'env') {
      const next = skipEnvironmentOptions(tokens, index + 1)
      if (next === undefined) {
        return []
      }

      index = next
      continue
    }

    break
  }

  return tokens.slice(index)
}

function optionValuesFor(executable: string): Set<string> {
  return OPTION_VALUES_BY_EXECUTABLE.get(executable) ?? OPTION_VALUES
}

function optionFlagsFor(executable: string): Set<string> {
  return OPTION_FLAGS_BY_EXECUTABLE.get(executable) ?? EMPTY_OPTION_FLAGS
}

function optionSpecFor(executable: string): OptionSpec {
  return {
    values: optionValuesFor(executable),
    flags: optionFlagsFor(executable),
    prefixes: OPTION_PREFIXES.get(executable) ?? []
  }
}

function optionName(token: string): string {
  const equals = token.indexOf('=')
  return equals > 0 ? token.slice(0, equals) : token
}

function optionKind(token: string, spec: OptionSpec): 'value' | 'flag' | 'unknown' {
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

function isOptionValueAttached(token: string, spec: OptionSpec): boolean {
  const name = optionName(token)
  return (
    name !== token ||
    spec.prefixes.some((prefix) => token.startsWith(prefix) && token.length > prefix.length)
  )
}

function firstCommandWord(
  tokens: string[],
  start = 0,
  spec: OptionSpec = optionSpecFor('')
): { value: string; index: number } | undefined {
  for (let index = start; index < tokens.length; index++) {
    const next = commandWordResult(tokens, index, spec)
    if (next === undefined) {
      return undefined
    }

    if ('wordIndex' in next) {
      return { value: tokens[next.wordIndex], index: next.wordIndex }
    }

    index = next.skipTo - 1
  }

  return undefined
}

function commandWordResult(
  tokens: string[],
  index: number,
  spec: OptionSpec
): { wordIndex: number } | { skipTo: number } | undefined {
  const token = tokens[index]
  if (token === '--') {
    return tokens[index + 1] === undefined ? undefined : { wordIndex: index + 1 }
  }

  if (token === '-' || !token.startsWith('-')) {
    return { wordIndex: index }
  }

  const next = skipCommandOption(tokens, index, spec)
  return next === undefined ? undefined : { skipTo: next }
}

function skipCommandOption(tokens: string[], index: number, spec: OptionSpec): number | undefined {
  const token = tokens[index]
  const kind = optionKind(token, spec)
  if (kind === 'unknown') {
    return undefined
  }

  if (kind === 'value' && !isOptionValueAttached(token, spec)) {
    return tokens[index + 1] === undefined ? undefined : index + 2
  }

  return index + 1
}

function positionalCommandWords(
  tokens: string[],
  spec: OptionSpec = optionSpecFor('')
): string[] | undefined {
  const words: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (token === '--') {
      words.push(...tokens.slice(index + 1))
      break
    }

    if (token === '-') {
      words.push(token)
      continue
    }

    if (token.startsWith('-')) {
      const next = positionalOptionIndex(tokens, index, spec)
      if (next === undefined) {
        return undefined
      }

      index = next
      continue
    }

    words.push(token)
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
    ? tokens[index + 1] === undefined
      ? undefined
      : index + 1
    : index
}

type VerificationHandler = (args: string[]) => string

function packageVerification(args: string[], executable: string): string {
  const first = firstCommandWord(args, 0, optionSpecFor(executable))
  if (!first) {
    return ''
  }

  const command = first.value.toLowerCase()
  if (command === 'run') {
    const script = firstCommandWord(args, first.index + 1, optionSpecFor(executable))
    return script && PACKAGE_VERIFICATION_COMMANDS.has(script.value.toLowerCase())
      ? `${executable} ${script.value.toLowerCase()}`
      : ''
  }

  return PACKAGE_VERIFICATION_COMMANDS.has(command) ? `${executable} ${command}` : ''
}

function pythonVerification(args: string[]): string {
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '-m') {
      return args[index + 1]?.toLowerCase() === 'pytest' ? 'python pytest' : ''
    }

    const isValueOption = PYTHON_OPTION_VALUES.has(argument)
    if (
      argument === '--' ||
      argument === '-c' ||
      !argument.startsWith('-') ||
      (!isValueOption && !PYTHON_OPTION_FLAGS.has(argument))
    ) {
      return ''
    }

    index += Number(isValueOption)
  }

  return ''
}

function firstVerification(
  args: string[],
  executable: string,
  allowed: Set<string>,
  label = executable
): string {
  const first = firstCommandWord(args, 0, optionSpecFor(executable))
  const command = first?.value.toLowerCase()
  return command !== undefined && allowed.has(command) ? `${label} ${command}` : ''
}

function positionalVerification(args: string[], executable: string, allowed: Set<string>): string {
  const target = positionalCommandWords(args, optionSpecFor(executable))?.find((value) =>
    allowed.has(value.toLowerCase())
  )
  if (target === undefined) {
    return ''
  }

  return `${executable} ${target.toLowerCase()}`
}

const VERIFICATION_HANDLERS = new Map<string, VerificationHandler>([
  ['npm', (args) => packageVerification(args, 'npm')],
  ['pnpm', (args) => packageVerification(args, 'pnpm')],
  ['yarn', (args) => packageVerification(args, 'yarn')],
  ['bun', (args) => packageVerification(args, 'bun')],
  ['pytest', () => 'pytest'],
  ['python', pythonVerification],
  ['go', (args) => firstVerification(args, 'go', new Set(['test']), 'go')],
  [
    'cargo',
    (args) =>
      firstVerification(args, 'cargo', new Set(['test', 'check', 'clippy', 'build']), 'cargo')
  ],
  ['zig', (args) => firstVerification(args, 'zig', new Set(['build']), 'zig')],
  ['make', (args) => positionalVerification(args, 'make', MAKE_VERIFICATION_COMMANDS)],
  ['gradle', (args) => positionalVerification(args, 'gradle', GRADLE_VERIFICATION_COMMANDS)],
  ['gradlew', (args) => positionalVerification(args, 'gradlew', GRADLE_VERIFICATION_COMMANDS)],
  ['mvn', (args) => positionalVerification(args, 'mvn', MAVEN_VERIFICATION_COMMANDS)],
  ['mvnw', (args) => positionalVerification(args, 'mvnw', MAVEN_VERIFICATION_COMMANDS)],
  ['dotnet', (args) => firstVerification(args, 'dotnet', new Set(['test', 'build']), 'dotnet')]
])

function verificationIdentity(tokens: string[]): string {
  const command = unwrapCommand(tokens)
  if (command.length === 0) {
    return ''
  }

  const executable = normalizedExecutable(command[0])
  return VERIFICATION_HANDLERS.get(executable)?.(command.slice(1)) ?? ''
}

function isRecognizedVerification(command: string): boolean {
  if (command.length === 0) {
    return false
  }

  const tokens = shellTokens(command)
  if (tokens.length === 0 || tokens.some((token) => CONTROL_FLOW_TOKENS.has(token))) {
    return false
  }

  const segments = commandSegments(tokens)
  return segments.length === 1 && verificationIdentity(segments[0]) !== ''
}

function normalizedCommandOperation(command: string): string {
  const segments = commandSegments(shellTokens(command))
  let skippedExecutable
  for (const segment of segments) {
    const unwrapped = unwrapCommand(segment)
    const executable = normalizedExecutable(unwrapped[0])
    if (executable.length === 0) {
      continue
    }

    if (SKIPPED_COMMANDS.has(executable)) {
      skippedExecutable ??= executable
      continue
    }

    const verified = verificationIdentity(segment)
    if (verified.length > 0) {
      return verified
    }

    const first = firstCommandWord(unwrapped.slice(1), 0, optionSpecFor(executable))
    return first ? `${executable} ${first.value.toLowerCase()}` : executable
  }

  return skippedExecutable ?? 'command'
}

function normalizedTarget(value: unknown): string {
  if (value === undefined || value === null || (typeof value === 'string' && value.length === 0)) {
    return ''
  }

  if (typeof value === 'string') {
    return value.normalize('NFKC').trim().replaceAll('\\', '/')
  }

  return stableSerialize(value)
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

  const value = firstDefinedInput(record, ['operation', 'action', 'subcommand', 'kind'])
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.normalize('NFKC').trim().toLowerCase().replaceAll(/\s+/gv, ' ')
  }

  return tool.length > 0 ? tool : 'operation'
}

function operationDescriptor(record: ToolRecord): OperationDescriptor {
  const tool = normalizeTool(record)
  const command = EXECUTION_TOOLS.has(tool) ? extractCommand(record) : ''
  const target = normalizedTarget(firstDefinedInput(record, ['path', 'file', 'uri', 'id', 'name']))
  return { tool, operation: operationFromRecord(record, tool, command), target }
}

function inputFingerprint(record: ToolRecord): string {
  const inputRecord = isRecord(record) ? record : {}
  const source =
    inputRecord.input ??
    inputRecord.command ??
    inputRecord.cmd ??
    inputRecord.params ??
    inputRecord.arguments
  const input = parseInput(source)
  const command = EXECUTION_TOOLS.has(normalizeTool(record)) ? extractCommand(record) : ''
  const normalized =
    command.length > 0
      ? normalizeShellInput(input, 0, typeof input === 'string' || Array.isArray(input))
      : normalizeForComparison(input)
  return stableHash({ input: normalized })
}

const SHELL_INPUT_KEYS = new Set(['command', 'cmd', 'script', 'shell'])

function normalizeShellInput(value: unknown, depth = 0, isCommandValue = false): unknown {
  if (depth > 8) {
    return '[DepthLimit]'
  }

  if (isCommandValue) {
    return shellTokens(commandText(value))
  }

  if (value === null || value === undefined) {
    return value
  }

  if (typeof value === 'string') {
    return normalizeForComparison(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeShellInput(item, depth + 1))
  }

  if (!isRecord(value)) {
    return value
  }

  return Object.fromEntries(
    Object.keys(value)
      .toSorted()
      .map((key) => [
        key,
        SHELL_INPUT_KEYS.has(key)
          ? normalizeShellInput(value[key], depth + 1, true)
          : normalizeShellInput(value[key], depth + 1)
      ])
  )
}

function normalizeForComparison(value: unknown, seen = new Set<unknown>()): unknown {
  if (typeof value === 'string') {
    return value.normalize('NFKC').replaceAll('\r\n', '\n').trim()
  }

  if (value === null || value === undefined || typeof value !== 'object') {
    return value
  }

  if (seen.has(value)) {
    return '[Circular]'
  }

  seen.add(value)
  let result
  if (Array.isArray(value)) {
    result = value.map((item) => normalizeForComparison(item, seen))
  } else {
    const record = value as UnknownRecord
    result = Object.fromEntries(
      Object.keys(record)
        .toSorted()
        .map((key) => [key, normalizeForComparison(record[key], seen)])
    )
  }

  seen.delete(value)
  return result
}

export function classifyToolCall(record: ToolRecord): ToolKind {
  const tool = normalizeTool(record)
  if (INSPECTION_TOOLS.has(tool)) {
    return 'inspect'
  }

  if (MUTATION_TOOLS.has(tool)) {
    return 'mutate'
  }

  if (DELEGATE_TOOLS.has(tool)) {
    return 'delegate'
  }

  if (EXECUTION_TOOLS.has(tool)) {
    return record?.status === 'success' && isRecognizedVerification(extractCommand(record))
      ? 'verify'
      : 'execute'
  }

  return 'other'
}

export function operationFingerprint(record: ToolRecord): string {
  return stableHash(operationDescriptor(record))
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
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const number = Number(value)
    if (Number.isSafeInteger(number) && number >= 0) {
      return number
    }
  }

  return undefined
}

function turnValue(record: ToolRecord): number | undefined {
  if (!isRecord(record)) {
    return undefined
  }

  return numericTurn(record.turn ?? record.turnNumber ?? record.executionTurn)
}

function turnKey(value: unknown): string | undefined {
  const turn = numericTurn(value)
  return turn === undefined ? undefined : String(turn)
}

function isCompletedTurnSucceeded(turn: TurnRecord): boolean {
  if (isRecord(turn)) {
    if (turn.succeeded !== undefined) {
      return turn.succeeded === true
    }

    if (turn.success !== undefined) {
      return turn.success === true
    }

    if (typeof turn.status === 'string') {
      return turn.status === 'success'
    }

    if (typeof turn.terminalType === 'string') {
      return turn.terminalType === 'session.execution.succeeded'
    }
  }

  return false
}

function correctionSignals(experience: Experience): CorrectionSignal[] {
  return correctionSource(experience)
    .map((item) => correctionSignal(item))
    .filter((signal): signal is CorrectionSignal => signal !== undefined)
}

function correctionSource(experience: Experience): unknown[] {
  const explicit = isUnknownArray(experience?.correctionSignals)
    ? experience.correctionSignals
    : isRecord(experience?.correctionSignals)
      ? [experience.correctionSignals]
      : []
  return explicit.length > 0
    ? explicit
    : isUnknownArray(experience?.corrections)
      ? experience.corrections
      : []
}

function correctionSignal(item: unknown): CorrectionSignal | undefined {
  const details = correctionDetails(item)
  if (!details) {
    return undefined
  }

  const fingerprint = details.fingerprint ?? details.text
  if (
    fingerprint === undefined ||
    fingerprint === null ||
    (typeof fingerprint === 'string' && fingerprint.length === 0)
  ) {
    return undefined
  }

  return {
    turn: details.turn,
    index: details.index,
    at: details.at,
    fingerprint: safeSignalHash(fingerprint)
  }
}

function correctionDetails(item: unknown): CorrectionDetails | undefined {
  return isRecord(item) ? recordCorrectionDetails(item) : primitiveCorrectionDetails(item)
}

function recordCorrectionDetails(item: UnknownRecord): CorrectionDetails | undefined {
  const text = item.text ?? item.message ?? item.correction
  if (item.fingerprint === undefined && !isExplicitCorrection(text)) {
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

function primitiveCorrectionDetails(item: unknown): CorrectionDetails | undefined {
  if (isExplicitCorrection(item) || isSha256(item)) {
    return { fingerprint: item }
  }

  return undefined
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }

  if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) {
    return Number(value)
  }

  return undefined
}

function isFailure(record: ToolRecord): boolean {
  return typeof record?.status === 'string' && FAILURE_STATUSES.has(record.status.toLowerCase())
}

function enrichedCalls(experience: Experience): EnrichedCall[] {
  const records = Array.isArray(experience?.toolCalls) ? experience.toolCalls : []
  return records.map((record, index) => {
    const source = isRecord(record) ? record : {}
    const descriptor = operationDescriptor(source)
    return {
      record: source,
      index,
      turn: turnValue(source),
      kind: classifyToolCall(source),
      isSuccess: source.status === 'success',
      isFailure: isFailure(source),
      descriptor,
      operationFingerprint: operationFingerprint(source),
      inputFingerprint: inputFingerprint(record)
    }
  })
}

function turnStates(experience: Experience): { states: Map<string, boolean> } {
  const source =
    Array.isArray(experience?.turns) && experience.turns.length > 0
      ? experience.turns
      : Array.isArray(experience?.completedTurns)
        ? experience.completedTurns
        : []
  const states = new Map<string, boolean>()
  for (const item of source) {
    const key = turnKey(turnValue(item))
    if (key === undefined) {
      continue
    }

    const isSucceeded = isCompletedTurnSucceeded(item)
    states.set(key, states.has(key) ? states.get(key) === true && isSucceeded : isSucceeded)
  }

  return { states }
}

function isSuccessfulTurn(
  key: string | undefined,
  state: { states: Map<string, boolean> }
): boolean {
  return key !== undefined && state.states.get(key) === true
}

function doesFollowTurn(call: EnrichedCall, signal: CorrectionSignal): boolean {
  if (call.turn === undefined || signal.turn === undefined) {
    return false
  }

  if (call.turn > signal.turn) {
    return true
  }

  if (call.turn < signal.turn) {
    return false
  }

  if (signal.index !== undefined) {
    return call.index > signal.index
  }

  const callAt = numericValue(call.record.at)
  if (callAt !== undefined && signal.at !== undefined) {
    return callAt >= signal.at
  }

  return true
}

function recoveryPairs(calls: EnrichedCall[]): {
  pairs: Array<{ failure: EnrichedCall; success: EnrichedCall }>
  pairedFailures: Set<number>
} {
  const pairedFailures = new Set<number>()
  const pairedSuccesses = new Set<number>()
  const pairs: Array<{ failure: EnrichedCall; success: EnrichedCall }> = []
  for (const success of calls) {
    if (!success.isSuccess || success.kind === 'inspect' || pairedSuccesses.has(success.index)) {
      continue
    }

    const failure = findRecoveryFailure(success, calls, pairedFailures)
    if (failure) {
      pairedFailures.add(failure.index)
      pairedSuccesses.add(success.index)
      pairs.push({ failure, success })
    }
  }

  return { pairs, pairedFailures }
}

function findRecoveryFailure(
  success: EnrichedCall,
  calls: EnrichedCall[],
  pairedFailures: Set<number>
): EnrichedCall | undefined {
  let nonInspectionCalls = 1
  for (let index = success.index - 1; index >= 0; index--) {
    const candidate = calls[index]
    if (isRecoveryMatch(candidate, success, pairedFailures, nonInspectionCalls)) {
      return candidate
    }

    if (candidate.kind !== 'inspect') {
      nonInspectionCalls++
      if (nonInspectionCalls > 2) {
        return undefined
      }
    }
  }

  return undefined
}

function isRecoveryMatch(
  candidate: EnrichedCall,
  success: EnrichedCall,
  pairedFailures: Set<number>,
  nonInspectionCalls: number
): boolean {
  return (
    candidate.isFailure &&
    candidate.kind !== 'inspect' &&
    !pairedFailures.has(candidate.index) &&
    nonInspectionCalls <= 2 &&
    candidate.operationFingerprint === success.operationFingerprint &&
    candidate.inputFingerprint !== success.inputFingerprint
  )
}

function addSignal(
  signals: FeatureSignal[],
  seen: Set<string>,
  kind: SignalKind,
  value: unknown
): void {
  const fingerprint = safeSignalHash(value)
  const key = `${kind}:${fingerprint}`
  if (seen.has(key)) {
    return
  }

  seen.add(key)
  signals.push({ kind, fingerprint })
}

function workflowRecords(
  calls: EnrichedCall[],
  state: { states: Map<string, boolean> }
): { records: WorkflowRecord[]; successfulVerifications: number } {
  const grouped = new Map<string | undefined, EnrichedCall[]>()
  for (const call of calls) {
    const key = turnKey(call.turn)
    const group = grouped.get(key) ?? []
    group.push(call)
    grouped.set(key, group)
  }

  const records: WorkflowRecord[] = []
  let successfulVerifications = 0
  for (const [key, group] of grouped) {
    const workflow = workflowForGroup(key, group, state)
    successfulVerifications += workflow.verifications
    if (workflow.record) {
      records.push(workflow.record)
    }
  }

  return { records, successfulVerifications }
}

function workflowForGroup(
  key: string | undefined,
  group: EnrichedCall[],
  state: { states: Map<string, boolean> }
): { record?: WorkflowRecord; verifications: number } {
  if (!isSuccessfulTurn(key, state)) {
    return { verifications: 0 }
  }

  const mutationIndex = group.findIndex((call) => call.isSuccess && call.kind === 'mutate')
  const verifierIndexes = group
    .map((call, index) =>
      index >= mutationIndex && call.isSuccess && call.kind === 'verify' ? index : -1
    )
    .filter((index) => index !== -1)
  if (mutationIndex === -1 || verifierIndexes.length === 0) {
    return { verifications: 0 }
  }

  const end = verifierIndexes.at(-1)
  if (end === undefined) {
    return { verifications: verifierIndexes.length }
  }

  const sequence = group
    .slice(mutationIndex, end + 1)
    .filter((call) => call.isSuccess && WORKFLOW_KINDS.has(call.kind))
    .map((call) => ({ category: call.kind, operation: call.operationFingerprint }))
  return {
    record: { turn: key, fingerprint: stableHash(sequence) },
    verifications: verifierIndexes.length
  }
}

function distinctCategoryCount(calls: EnrichedCall[]): number {
  const categories = new Set<string>()
  for (const call of calls) {
    if (!WORKFLOW_KINDS.has(call.kind)) {
      continue
    }

    categories.add(`${call.kind}:${call.descriptor.tool}:${call.descriptor.operation}`)
  }

  return categories.size
}

export function deriveTriggerFeatures(experience: Experience): TriggerFeatures {
  const calls = enrichedCalls(experience)
  const state = turnStates(experience)
  const signalState = { signals: [] as FeatureSignal[], seen: new Set<string>() }
  const incorporatedCorrections = addCorrectionSignals(
    calls,
    state,
    correctionSignals(experience),
    signalState
  )
  const recovery = recoveryPairs(calls)
  addRecoverySignals(recovery.pairs, signalState)
  const workflows = workflowRecords(calls, state)
  const repeatedWorkflows = addWorkflowSignals(workflows.records, signalState)

  return {
    incorporatedCorrections,
    confirmedRecoveries: recovery.pairs.length,
    repeatedVerifiedWorkflows: repeatedWorkflows,
    successfulVerificationsAfterMutation: workflows.successfulVerifications,
    unresolvedFailures: calls.filter(
      (call) => call.isFailure && !recovery.pairedFailures.has(call.index)
    ).length,
    distinctCategories: distinctCategoryCount(calls),
    signalFingerprints: signalState.signals
  }
}

function addCorrectionSignals(
  calls: EnrichedCall[],
  state: { states: Map<string, boolean> },
  corrections: CorrectionSignal[],
  signalState: { signals: FeatureSignal[]; seen: Set<string> }
): number {
  let count = 0
  for (const signal of corrections) {
    const isIncorporated = calls.some(
      (call) =>
        call.isSuccess &&
        ACTION_KINDS.has(call.kind) &&
        isSuccessfulTurn(turnKey(call.turn), state) &&
        doesFollowTurn(call, signal)
    )
    if (!isIncorporated) {
      continue
    }

    count++
    addSignal(signalState.signals, signalState.seen, 'correction', signal.fingerprint)
  }

  return count
}

function addRecoverySignals(
  pairs: Array<{ failure: EnrichedCall; success: EnrichedCall }>,
  signalState: { signals: FeatureSignal[]; seen: Set<string> }
): void {
  for (const pair of pairs) {
    addSignal(
      signalState.signals,
      signalState.seen,
      'recovery',
      stableHash({
        operation: pair.failure.operationFingerprint,
        failedInput: pair.failure.inputFingerprint,
        successfulInput: pair.success.inputFingerprint
      })
    )
  }
}

function addWorkflowSignals(
  records: WorkflowRecord[],
  signalState: { signals: FeatureSignal[]; seen: Set<string> }
): number {
  const workflowTurns = new Map<string, Set<string | undefined>>()
  for (const workflow of records) {
    const turns = workflowTurns.get(workflow.fingerprint) ?? new Set<string | undefined>()
    turns.add(workflow.turn)
    workflowTurns.set(workflow.fingerprint, turns)
  }

  let repeated = 0
  for (const [fingerprint, turns] of workflowTurns) {
    if (turns.size < 2) {
      continue
    }

    repeated++
    addSignal(signalState.signals, signalState.seen, 'workflow', fingerprint)
  }

  return repeated
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined
  }

  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined
  }

  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function normalizedCount(value: unknown): number {
  const number = finiteNumber(value)
  return number !== undefined && number > 0 ? Math.floor(number) : 0
}

function normalizedThreshold(value: unknown): number {
  return finiteNumber(value) ?? DEFAULT_SCORE_THRESHOLD
}

function strongSignalEntries(features: Partial<TriggerFeatures> | undefined): string[] {
  const entries = Array.isArray(features?.signalFingerprints) ? features.signalFingerprints : []
  return entries
    .map((entry) => strongSignalEntry(entry))
    .filter((entry): entry is string => entry !== undefined)
}

function strongSignalEntry(entry: FeatureSignal | string): string | undefined {
  if (typeof entry === 'string') {
    return entry.length > 0 ? entry : undefined
  }

  const kind = typeof entry.kind === 'string' ? entry.kind : ''
  return STRONG_SIGNAL_KINDS.has(kind) && entry.fingerprint !== undefined
    ? `${kind}:${safeSignalHash(entry.fingerprint)}`
    : undefined
}

export function candidateFingerprint(features: Partial<TriggerFeatures> | undefined): string {
  return stableHash(strongSignalEntries(features).toSorted())
}

export function scoreReviewCandidate(
  features: Partial<TriggerFeatures> | undefined,
  threshold: unknown = DEFAULT_SCORE_THRESHOLD
): TriggerDecision {
  const counts = scoreCounts(features)
  const points = scorePoints(counts)
  const strongSignals = signalKinds(points)

  const normalized = normalizedThreshold(threshold)
  return {
    eligible: points.score >= normalized && strongSignals.length > 0,
    score: points.score,
    threshold: normalized,
    strongSignals,
    workflowOnly: points.workflow > 0 && points.correction === 0 && points.recovery === 0,
    fingerprint: candidateFingerprint(features),
    reasons: counts
  }
}

function scoreCounts(features: Partial<TriggerFeatures> | undefined): TriggerDecision['reasons'] {
  return {
    incorporatedCorrections: normalizedCount(features?.incorporatedCorrections),
    confirmedRecoveries: normalizedCount(features?.confirmedRecoveries),
    repeatedVerifiedWorkflows: normalizedCount(features?.repeatedVerifiedWorkflows),
    successfulVerificationsAfterMutation: normalizedCount(
      features?.successfulVerificationsAfterMutation
    ),
    unresolvedFailures: normalizedCount(features?.unresolvedFailures),
    distinctCategories: normalizedCount(features?.distinctCategories)
  }
}

function scorePoints(counts: TriggerDecision['reasons']): {
  score: number
  correction: number
  recovery: number
  workflow: number
} {
  const correction = Math.min(counts.incorporatedCorrections, 1) * 12
  const recovery = Math.min(counts.confirmedRecoveries, 2) * 8
  const workflow = Math.min(counts.repeatedVerifiedWorkflows, 1) * 8
  const verification = Math.min(counts.successfulVerificationsAfterMutation, 2) * 2
  const failure = Math.min(counts.unresolvedFailures, 2)
  const category = Math.min(counts.distinctCategories, 3)
  return {
    score: correction + recovery + workflow + verification + failure + category,
    correction,
    recovery,
    workflow
  }
}

function signalKinds(points: {
  correction: number
  recovery: number
  workflow: number
}): SignalKind[] {
  return [
    points.correction > 0 ? 'correction' : undefined,
    points.recovery > 0 ? 'recovery' : undefined,
    points.workflow > 0 ? 'workflow' : undefined
  ].filter((kind): kind is SignalKind => kind !== undefined)
}
