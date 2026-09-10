import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { test } from 'node:test'

const repository = path.resolve(import.meta.dirname, '..')
const password = 'learning-plugin-test-password'
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`

async function fetchApi(base, requestPath, options) {
  try {
    return await fetch(new URL(requestPath, base), {
      ...options,
      signal: options.signal ?? AbortSignal.timeout(10_000),
      headers: { authorization, 'content-type': 'application/json', ...options.headers }
    })
  } catch (error) {
    throw new Error(`${requestPath}: ${String(error)}`, { cause: error })
  }
}

async function api(base, requestPath, options = {}) {
  const response = await fetchApi(base, requestPath, options)
  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`)
  }

  return response.status === 204 ? undefined : response.json()
}

async function serverUrl(server) {
  const lines = createInterface({ input: server.stdout })
  try {
    const [line] = await Promise.race([
      once(lines, 'line'),
      once(server, 'exit').then(([code]) => {
        throw new Error(`server exited ${code}`)
      })
    ])
    return JSON.parse(line).url
  } finally {
    lines.close()
  }
}

function isolatedEnvironment(root) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('OPENCODE_') && !['HOME', 'TMPDIR', 'TMP', 'TEMP'].includes(name)
    )
  )
  return {
    ...inherited,
    HOME: path.join(root, 'home'),
    OPENCODE_CONFIG_CONTENT: '{}',
    OPENCODE_CONFIG_DIR: path.join(root, 'config'),
    OPENCODE_DB: path.join(root, 'opencode.db'),
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_PASSWORD: password,
    TMPDIR: path.join(root, 'tmp'),
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
    XDG_CACHE_HOME: path.join(root, 'cache'),
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
    XDG_DATA_HOME: path.join(root, 'data'),
    XDG_STATE_HOME: path.join(root, 'state')
  }
}

function startServer(project, root) {
  const child = spawn(
    process.env.OPENCODE_BIN ?? 'opencode2',
    ['serve', '--stdio', '--port', '0'],
    {
      cwd: project,
      env: isolatedEnvironment(root),
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let diagnostics = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    diagnostics += chunk
  })
  return { child, diagnostics: () => diagnostics }
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

async function stopServer(server) {
  if (server.exitCode !== null) {
    return
  }

  server.kill('SIGTERM')
  const closed = await Promise.race([
    once(server, 'close').then(() => true),
    delay(2000).then(() => false)
  ])
  if (!closed) {
    server.kill('SIGKILL')
  }
}

function locationQuery(project) {
  return `?location%5Bdirectory%5D=${encodeURIComponent(project)}`
}

async function snapshot(base, project) {
  const [plugins, commands] = await Promise.all([
    api(base, `/api/plugin${locationQuery(project)}`),
    api(base, `/api/command${locationQuery(project)}`)
  ])
  return {
    plugin: plugins.data.find((item) => item.id === 'github.learning_skills'),
    learningCommands: commands.data
      .map((item) => item.name)
      .filter((name) => name.startsWith('learn'))
  }
}

function waitForPlugin(base, project, diagnostics) {
  return new Promise((resolve, reject) => {
    let lastSnapshot = { learningCommands: [] }
    const finish = (timer, interval, result) => {
      clearTimeout(timer)
      clearInterval(interval)
      result()
    }

    const timer = setTimeout(() => {
      finish(timer, interval, () =>
        reject(
          new Error(
            `learning plugin did not activate\nstate=${JSON.stringify(lastSnapshot, null, 2)}\nstderr=${diagnostics()}`
          )
        )
      )
    }, 15_000)
    const check = () => {
      snapshot(base, project)
        .then((current) => {
          lastSnapshot = current
          if (current.plugin?.state?.status === 'active') {
            finish(timer, interval, () => resolve(current))
          }
        })
        .catch((error) => {
          finish(timer, interval, () => reject(error))
        })
    }

    const interval = setInterval(check, 100)
    check()
  })
}

async function exercisePlugin(root, project) {
  await mkdir(project, { recursive: true })
  await mkdir(path.join(root, 'tmp'), { recursive: true })
  await writeFile(
    path.join(project, 'opencode.jsonc'),
    `${JSON.stringify({ plugins: [repository] })}\n`
  )
  const running = startServer(project, root)
  try {
    const base = await serverUrl(running.child)
    await api(base, `/api/plugin/await-activation${locationQuery(project)}`, {
      method: 'POST',
      body: '{}'
    })
    const current = await waitForPlugin(base, project, running.diagnostics)
    assert.equal(current.plugin.source.type, 'local')
    assert.deepEqual(current.learningCommands, [])
    return current.plugin.id
  } finally {
    await stopServer(running.child)
  }
}

test('package-root server plugin activates without exposing learning commands as session commands', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'opencode-learning-'))
  const project = path.join(root, 'project')
  try {
    assert.equal(await exercisePlugin(root, project), 'github.learning_skills')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
