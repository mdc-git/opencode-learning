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

async function api(base, requestPath, options = {}) {
  const response = await fetch(new URL(requestPath, base), {
    ...options,
    headers: { authorization, 'content-type': 'application/json', ...options.headers }
  })
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

function startServer(project, root) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith('OPENCODE_') && !['HOME', 'TMPDIR', 'TMP', 'TEMP'].includes(name)
    )
  )
  return spawn(process.env.OPENCODE_BIN ?? 'opencode2', ['serve', '--stdio', '--port', '0'], {
    cwd: project,
    env: {
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
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

async function stopServer(server) {
  if (server.exitCode !== null) {
    return
  }
  server.kill('SIGTERM')
  const closed = await Promise.race([
    once(server, 'close').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2000))
  ])
  if (!closed) {
    server.kill('SIGKILL')
  }
}

function locationQuery(project) {
  return `?location%5Bdirectory%5D=${encodeURIComponent(project)}`
}

async function waitForPlugin(base, project) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const plugins = await api(base, `/api/plugin${locationQuery(project)}`)
    const plugin = plugins.data.find((item) => item.id === 'github.learning_skills')
    const registered = await api(base, `/api/command${locationQuery(project)}`)
    if (
      plugin?.state?.status === 'active' &&
      commands.every((name) => registered.data.some((item) => item.name === name))
    ) {
      return plugin
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  throw new Error('learning plugin did not activate')
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

test('package-root plugin exposes only the current learning surface and stages explicit filesystem changes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'opencode-learning-'))
  const project = path.join(root, 'project')
  let server
  try {
    await mkdir(project, { recursive: true })
    await mkdir(path.join(root, 'tmp'), { recursive: true })
    await writeFile(
      path.join(project, 'opencode.jsonc'),
      `${JSON.stringify({ plugins: [repository] })}\n`
    )
    server = startServer(project, root)
    const base = await serverUrl(server)
    const session = await api(base, '/api/session', {
      method: 'POST',
      body: JSON.stringify({ location: { directory: project } })
    })
    await api(base, `/api/plugin/await-activation${locationQuery(project)}`, {
      method: 'POST',
      body: '{}'
    })
    const plugin = await waitForPlugin(base, project)
    assert.equal(plugin.source.type, 'local')

    const registered = await api(base, `/api/command${locationQuery(project)}`)
    const learning = registered.data
      .map((item) => item.name)
      .filter((name) => name.startsWith('learn'))
    assert.deepEqual(learning.toSorted(), commands.toSorted())

    const create = {
      kind: 'create',
      skillId: 'created-skill',
      reason: 'verified procedure',
      evidence: { records: [], omitted: 0 }
    }
    await writeProposal(project, idA, create, skill('Created skill'))
    await runCommand(base, session.data.id, 'learn-approve', idA)
    assert.match(
      await readFile(
        path.join(project, '.opencode', 'skills', 'created-skill', 'SKILL.md'),
        'utf8'
      ),
      /Created skill/v
    )
    await assert.rejects(
      readFile(
        path.join(project, '.opencode', '.learning', 'pending', idA, 'proposal.json'),
        'utf8'
      )
    )

    const malformed = path.join(project, '.opencode', '.learning', 'pending', idB)
    await mkdir(malformed, { recursive: true })
    await writeFile(path.join(malformed, 'proposal.json'), '{not-json')
    await runCommand(base, session.data.id, 'learn-reject', idB)
    await assert.rejects(readFile(path.join(malformed, 'proposal.json'), 'utf8'))

    const global = path.join(root, 'xdg-config', 'opencode', 'skills', 'created-skill')
    await mkdir(global, { recursive: true })
    await writeFile(path.join(global, 'SKILL.md'), skill('Wrong global copy'))
    await runCommand(base, session.data.id, 'learn-promote', 'created-skill')
    assert.equal(
      await readFile(path.join(global, 'SKILL.md'), 'utf8'),
      await readFile(path.join(project, '.opencode', 'skills', 'created-skill', 'SKILL.md'), 'utf8')
    )
  } finally {
    if (server) {
      await stopServer(server)
    }
    await rm(root, { recursive: true, force: true })
  }
})
