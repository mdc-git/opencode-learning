import {
  CARGO_OPTION_FLAGS,
  CARGO_OPTION_VALUES,
  DOTNET_OPTION_FLAGS,
  DOTNET_OPTION_VALUES,
  GO_OPTION_FLAGS,
  GO_OPTION_VALUES,
  GRADLE_OPTION_FLAGS,
  GRADLE_OPTION_VALUES,
  MAKE_OPTION_FLAGS,
  MAKE_OPTION_VALUES,
  MAVEN_OPTION_FLAGS,
  MAVEN_OPTION_VALUES,
  PACKAGE_OPTION_FLAGS,
  PACKAGE_OPTION_VALUES,
  ZIG_OPTION_FLAGS,
  ZIG_OPTION_VALUES
} from './scoring-command-option-sets.ts'

export type OptionSpec = { values: Set<string>; flags: Set<string>; prefixes: string[] }

export const EXECUTION_TOOLS = new Set(['shell', 'execute', 'bash'])
export const PACKAGE_VERIFICATION_COMMANDS = new Set([
  'test',
  'lint',
  'typecheck',
  'check',
  'build'
])
export const MAKE_VERIFICATION_COMMANDS = new Set(['test', 'check', 'build'])
export const GRADLE_VERIFICATION_COMMANDS = new Set(['test', 'check', 'build'])
export const MAVEN_VERIFICATION_COMMANDS = new Set(['test', 'verify'])
export const OPTION_VALUES = new Set([
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
export const PYTHON_OPTION_VALUES = new Set(['-W', '-X', '-c'])
export const PYTHON_OPTION_FLAGS = new Set([
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
export const OPTION_PREFIXES = new Map([
  ['gradle', ['-D', '-P']],
  ['gradlew', ['-D', '-P']],
  ['mvn', ['-D', '-P', '-pl']],
  ['mvnw', ['-D', '-P', '-pl']],
  ['zig', ['-D']],
  ['make', ['-j']]
])
export const OPTION_VALUES_BY_EXECUTABLE = new Map<string, Set<string>>([
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
export const OPTION_FLAGS_BY_EXECUTABLE = new Map<string, Set<string>>([
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
export const EMPTY_OPTION_FLAGS = new Set<string>()
