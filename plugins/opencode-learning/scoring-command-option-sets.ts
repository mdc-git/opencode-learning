export const PACKAGE_OPTION_VALUES = new Set([
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

export const GO_OPTION_VALUES = new Set([
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

export const CARGO_OPTION_VALUES = new Set([
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

export const ZIG_OPTION_VALUES = new Set([
  '--build-file',
  '--cache-dir',
  '--global-cache-dir',
  '--summary'
])

export const MAKE_OPTION_VALUES = new Set([
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

export const GRADLE_OPTION_VALUES = new Set([
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

export const MAVEN_OPTION_VALUES = new Set([
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

export const DOTNET_OPTION_VALUES = new Set([
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

export const PACKAGE_OPTION_FLAGS = new Set([
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

export const GO_OPTION_FLAGS = new Set(['-a', '-race', '-trimpath', '-v', '-x'])

export const CARGO_OPTION_FLAGS = new Set([
  '--all-features',
  '--all-targets',
  '--locked',
  '--offline',
  '--release',
  '--workspace',
  '-q',
  '-v'
])

export const ZIG_OPTION_FLAGS = new Set(['--verbose', '-freference-trace'])

export const MAKE_OPTION_FLAGS = new Set([
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

export const GRADLE_OPTION_FLAGS = new Set([
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

export const MAVEN_OPTION_FLAGS = new Set([
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

export const DOTNET_OPTION_FLAGS = new Set([
  '--no-build',
  '--no-restore',
  '--nologo',
  '--no-self-contained',
  '--self-contained',
  '-nologo'
])
