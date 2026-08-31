import {
  EXECUTION_TOOLS,
  GRADLE_VERIFICATION_COMMANDS,
  MAKE_VERIFICATION_COMMANDS,
  MAVEN_VERIFICATION_COMMANDS,
  PACKAGE_VERIFICATION_COMMANDS,
  PYTHON_OPTION_FLAGS,
  PYTHON_OPTION_VALUES
} from './scoring-command-config.ts'
import { commandSegments, CONTROL_FLOW_TOKENS, shellTokens } from './scoring-shell.ts'
import {
  firstCommandWord,
  normalizedExecutable,
  optionSpecFor,
  positionalCommandWords,
  unwrapCommand
} from './scoring-command-options.ts'

type VerificationHandler = (args: string[]) => string

function packageRunVerification(args: string[], executable: string, firstIndex: number): string {
  const script = firstCommandWord(args, firstIndex + 1, optionSpecFor(executable))
  return script && PACKAGE_VERIFICATION_COMMANDS.has(script.value.toLowerCase())
    ? `${executable} ${script.value.toLowerCase()}`
    : ''
}

function packageVerification(args: string[], executable: string): string {
  const first = firstCommandWord(args, 0, optionSpecFor(executable))
  if (!first) {
    return ''
  }

  const command = first.value.toLowerCase()
  return command === 'run'
    ? packageRunVerification(args, executable, first.index)
    : PACKAGE_VERIFICATION_COMMANDS.has(command)
      ? `${executable} ${command}`
      : ''
}

type PythonStep =
  { kind: 'return'; value: string } | { kind: 'continue'; nextIndex: number } | { kind: 'invalid' }

function isPythonVerificationOption(argument: string): boolean {
  if (argument === '--' || argument === '-c' || !argument.startsWith('-')) {
    return false
  }

  return PYTHON_OPTION_VALUES.has(argument) || PYTHON_OPTION_FLAGS.has(argument)
}

function pythonVerificationStep(args: string[], index: number): PythonStep {
  const argument = args[index]
  if (argument === '-m') {
    return {
      kind: 'return',
      value: args[index + 1]?.toLowerCase() === 'pytest' ? 'python pytest' : ''
    }
  }

  if (!isPythonVerificationOption(argument)) {
    return { kind: 'invalid' }
  }

  return {
    kind: 'continue',
    nextIndex: index + 1 + Number(PYTHON_OPTION_VALUES.has(argument))
  }
}

function pythonVerification(args: string[], index = 0): string {
  if (index >= args.length) {
    return ''
  }

  const step = pythonVerificationStep(args, index)
  if (step.kind === 'return') {
    return step.value
  }

  return step.kind === 'invalid' ? '' : pythonVerification(args, step.nextIndex)
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

export function isRecognizedVerification(command: string): boolean {
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

type SegmentOperation = { operation?: string; skipped?: string }
const SKIPPED_COMMANDS = new Set(['cd', 'export', 'set', 'source'])

function commandSegmentOperation(segment: string[]): SegmentOperation {
  const unwrapped = unwrapCommand(segment)
  const executable = normalizedExecutable(unwrapped[0])
  if (executable.length === 0) {
    return {}
  }

  if (SKIPPED_COMMANDS.has(executable)) {
    return { skipped: executable }
  }

  const verified = verificationIdentity(segment)
  if (verified.length > 0) {
    return { operation: verified }
  }

  const first = firstCommandWord(unwrapped.slice(1), 0, optionSpecFor(executable))
  return { operation: first ? `${executable} ${first.value.toLowerCase()}` : executable }
}

export function normalizedCommandOperation(command: string): string {
  let skippedExecutable
  for (const segment of commandSegments(shellTokens(command))) {
    const result = commandSegmentOperation(segment)
    if (result.operation !== undefined) {
      return result.operation
    }

    skippedExecutable ??= result.skipped
  }

  return skippedExecutable ?? 'command'
}

export function isExecutionTool(tool: string): boolean {
  return EXECUTION_TOOLS.has(tool)
}
