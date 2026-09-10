import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { test } from 'node:test'

const repository = path.resolve(import.meta.dirname, '..')
const password = 'learning-plugin-test-password'
const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
const commands = ['learn', 'learn-pending', 'learn-approve', 'learn-reject', 'learn-promote']
const idA = '11111111-1111-4111-8111-111111111111'
const idB = '22222222-2222-4222-8222-222222222222'

function skill(description, body = '# Learned\n\nDo the verified thing.\n') {
  return `---\ndescription: ${description}\nmetadata:\n  opencode-learning/owner: "true"\n---\n${body}`
}

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

async function decodeApi(response) {
  if (!response.ok) {
    throw new Error(`${response.status}: ${await response.text()}`)
  }

  if (response.status === 204) {
    return undefined
  }

  return response.json()
}

async function api(base, requestPath, options = {}) {
  const response = await fetchApi(base, requestPath, options)
  return decodeApi(response)
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

async function pluginSnapshot(base, project) {
  const [plugins, registered] = await Promise.all([
    api(base, `/api/plugin${locationQuery(project)}`),
    api(base, `/api/command${locationQuery(project)}`)
  ])
  const plugin = plugins.data.find((item) => item.id === 'github.learning_skills')
  const commandNames = registered.data
    .map((item) => item.name)
    .filter((name) => name.startsWith('learn'))
  return { plugin, commandNames }
}

function isActivated(snapshot) {
  return (
    snapshot.plugin?.state?.status === 'active' &&
    commands.every((name) => snapshot.commandNames.includes(name))
  )
}

function activationError(snapshot, diagnostics) {
  return new Error(
    `learning plugin did not activate\nstate=${JSON.stringify(snapshot, null, 2)}\nstderr=${diagnostics()}`
  )
}

function waitForPlugin(base, project, diagnostics) {
  return new Promise((resolve, reject) => {
    let lastSnapshot = { commandNames: [] }
    const finish = (timer, interval, result) => {
      clearTimeout(timer)
      clearInterval(interval)
      result()
    }

    const timer = setTimeout(() => {
      finish(timer, interval, () => reject(activationError(lastSnapshot, diagnostics)))
    }, 15_000)
    const check = () => {
      pluginSnapshot(base, project)
        .then((snapshot) => {
          lastSnapshot = snapshot
          if (isActivated(snapshot)) {
            finish(timer, interval, () => resolve(snapshot.plugin))
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

async function runCommand(base, sessionID, command, text = '') {
  await api(base, `/api/session/${sessionID}/command`, {
    method: 'POST',
    body: JSON.stringify({ command, text })
  })
}

async function writeProposal(project, id, metadata, markdown) {
  const root = path.join(project, '.opencode', '.learning', 'pending', id)
  await mkdir(path.join(root, 'skill'), { recursive: true })
  await writeFile(path.join(root, 'proposal.json'), `${JSON.stringify(metadata)}\n`)
  await writeFile(path.join(root, 'skill', 'SKILL.md'), markdown)
}

async function createSession(base, project) {
  return api(base, '/api/session', {
    method: 'POST',
    body: JSON.stringify({ location: { directory: project } })
  })
}

async function assertCommands(base, project) {
  const registered = await api(base, `/api/command${locationQuery(project)}`)
  const learning = registered.data
    .map((item) => item.name)
    .filter((name) => name.startsWith('learn'))
  const compare = (left, right) => left.localeCompare(right)
  assert.deepEqual(learning.toSorted(compare), commands.toSorted(compare))
}

async function assertCreateApproval(base, project, sessionID) {
  const metadata = {
    kind: 'create',
    skillId: 'created-skill',
    reason: 'verified procedure',
    evidence: { records: [], omitted: 0 }
  }
  await writeProposal(project, idA, metadata, skill('Created skill'))
  await runCommand(base, sessionID, 'learn-approve', idA)
  const created = path.join(project, '.opencode', 'skills', 'created-skill', 'SKILL.md')
  assert.match(await readFile(created, 'utf8'), /Created skill/v)
  const consumed = path.join(project, '.opencode', '.learning', 'pending', idA, 'proposal.json')
  await assert.rejects(readFile(consumed, 'utf8'), { code: 'ENOENT' })
}

async function assertReject(base, project, sessionID) {
  const malformed = path.join(project, '.opencode', '.learning', 'pending', idB)
  await mkdir(malformed, { recursive: true })
  await writeFile(path.join(malformed, 'proposal.json'), '{not-json')
  await runCommand(base, sessionID, 'learn-reject', idB)
  await assert.rejects(readFile(path.join(malformed, 'proposal.json'), 'utf8'), {
    code: 'ENOENT'
  })
}

async function assertPromotion(base, project, root, sessionID) {
  const global = path.join(root, 'xdg-config', 'opencode', 'skills', 'created-skill')
  await mkdir(global, { recursive: true })
  await writeFile(path.join(global, 'SKILL.md'), skill('Wrong global copy'))
  await runCommand(base, sessionID, 'learn-promote', 'created-skill')
  const projectSkill = path.join(project, '.opencode', 'skills', 'created-skill', 'SKILL.md')
  assert.equal(
    await readFile(path.join(global, 'SKILL.md'), 'utf8'),
    await readFile(projectSkill, 'utf8')
  )
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
    const session = await createSession(base, project)
    await api(base, `/api/plugin/await-activation${locationQuery(project)}`, {
      method: 'POST',
      body: '{}'
    })
    const plugin = await waitForPlugin(base, project, running.diagnostics)
    assert.equal(plugin.source.type, 'local')
    await assertCommands(base, project)
    await assertCreateApproval(base, project, session.data.id)
    await assertReject(base, project, session.data.id)
    await assertPromotion(base, project, root, session.data.id)
    return plugin.id
  } finally {
    await stopServer(running.child)
  }
}

test('package-root plugin exposes only the current learning surface and stages explicit filesystem changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'opencode-learning-'))
  const project = path.join(root, 'project')
  try {
    assert.equal(await exercisePlugin(root, project), 'github.learning_skills')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
