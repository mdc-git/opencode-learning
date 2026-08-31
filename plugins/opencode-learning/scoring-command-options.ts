import {
  EMPTY_OPTION_FLAGS,
  OPTION_FLAGS_BY_EXECUTABLE,
  OPTION_PREFIXES,
  OPTION_VALUES,
  OPTION_VALUES_BY_EXECUTABLE,
  type OptionSpec
} from './scoring-command-config.ts'
import {
  isOptionValueAttached,
  nextOptionValueIndex,
  optionKind
} from './scoring-command-positionals.ts'

export { firstCommandWord, positionalCommandWords } from './scoring-command-positionals.ts'

const ENV_OPTION_VALUES = new Set(['-C', '-S', '--chdir', '--split-string', '--unset', '-u'])
const ENV_OPTION_FLAGS = new Set(['--ignore-environment', '--null', '-0', '-i'])
const ENV_OPTION_PREFIXES = ['-C', '-S', '-u']
const ENV_OPTION_SPEC: OptionSpec = {
  values: ENV_OPTION_VALUES,
  flags: ENV_OPTION_FLAGS,
  prefixes: ENV_OPTION_PREFIXES
}

const EXECUTABLE_ALIASES = new Map([
  ['python3', 'python'],
  ['python2', 'python'],
  ['py', 'python'],
  ['gradlew.bat', 'gradlew'],
  ['mvnw.bat', 'mvnw']
])

export function normalizedExecutable(value: string | undefined): string {
  if (typeof value !== 'string') {
    return ''
  }

  const executable =
    value
      .trim()
      .toLowerCase()
      .split(/[\/\\]/v)
      .at(-1) ?? ''
  const withoutWindowsSuffix = executable.replace(/\.(?:cmd|exe)$/v, '')
  return EXECUTABLE_ALIASES.get(withoutWindowsSuffix) ?? withoutWindowsSuffix
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[a-z_]\w*=/iv.test(token)
}

function skipEnvironmentOptions(tokens: string[], start: number): number | undefined {
  let index = start
  while (index < tokens.length) {
    const next = nextEnvironmentIndex(tokens, index)
    if (next === undefined || next === index) {
      return next
    }

    index = next
  }

  return index
}

function nextEnvironmentOptionIndex(tokens: string[], index: number): number | undefined {
  const option = tokens[index]
  const kind = optionKind(option, ENV_OPTION_SPEC)
  if (kind === 'unknown') {
    return undefined
  }

  if (kind === 'value' && !isOptionValueAttached(option, ENV_OPTION_SPEC)) {
    return nextOptionValueIndex(tokens, index)
  }

  return index + 1
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

  return nextEnvironmentOptionIndex(tokens, index)
}

function unwrapPrefixIndex(tokens: string[], index: number): number | undefined {
  const token = tokens[index]
  const executable = normalizedExecutable(token)
  if (isEnvironmentAssignment(token) || ['sudo', 'time', 'command'].includes(executable)) {
    return index + 1
  }

  return executable === 'env' ? skipEnvironmentOptions(tokens, index + 1) : index
}

export function unwrapCommand(tokens: string[]): string[] {
  let index = 0
  while (index < tokens.length) {
    const next = unwrapPrefixIndex(tokens, index)
    if (canAdvanceUnwrap(next, index)) {
      index = next
      continue
    }

    return finishUnwrap(next, index, tokens)
  }

  return tokens.slice(index)
}

function canAdvanceUnwrap(next: number | undefined, index: number): next is number {
  return next !== undefined && next !== index
}

function finishUnwrap(next: number | undefined, index: number, tokens: string[]): string[] {
  return next === undefined ? [] : tokens.slice(index)
}

function optionValuesFor(executable: string): Set<string> {
  return OPTION_VALUES_BY_EXECUTABLE.get(executable) ?? OPTION_VALUES
}

function optionFlagsFor(executable: string): Set<string> {
  return OPTION_FLAGS_BY_EXECUTABLE.get(executable) ?? EMPTY_OPTION_FLAGS
}

export function optionSpecFor(executable: string): OptionSpec {
  return {
    values: optionValuesFor(executable),
    flags: optionFlagsFor(executable),
    prefixes: OPTION_PREFIXES.get(executable) ?? []
  }
}
