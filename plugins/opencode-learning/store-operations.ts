import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertNoSymlinkPath, atomicWrite, hasErrorCode, isRecord, isSafeId } from './shared.ts'
import { applyOperations, bumpVersion, readOptionalText, safePending } from './store-files.ts'
import { validateProposal } from './store-validation.ts'
import type { OwnedSkill, Proposal, UnknownRecord } from './types.ts'
import type { SkillStore } from './store.ts'

type PendingProposal = { id: string; proposal: Proposal; validation: UnknownRecord }
type PendingDetails = PendingProposal & { previews: Record<string, string> }

async function stageCreate(store: SkillStore, dir: string, proposal: Proposal): Promise<void> {
  const files = proposal.skill?.files ?? []
  await Promise.all([
    atomicWrite(path.join(dir, 'SKILL.preview.md'), store.renderCreated(proposal)),
    ...files.map(async (file) => atomicWrite(path.join(dir, 'FILES', file.path), file.content))
  ])
}

async function stagePatch(store: SkillStore, dir: string, proposal: Proposal): Promise<void> {
  const current = await store.getOwned(proposal.skillId ?? 'none', proposal.scope ?? 'project')
  if (current === undefined) {
    return
  }

  await writePatchPreview(store, dir, proposal, current)
}

async function writePatchPreview(
  store: SkillStore,
  dir: string,
  proposal: Proposal,
  current: OwnedSkill
): Promise<void> {
  const text = applyOperations(current.text, proposal.operations ?? [])
  const next = bumpVersion(text)
  const writes = [
    atomicWrite(path.join(dir, 'BEFORE.md'), current.text),
    atomicWrite(path.join(dir, 'AFTER.md'), next),
    ...(proposal.addFiles ?? []).map(async (file) =>
      atomicWrite(path.join(dir, 'FILES', file.path), file.content)
    )
  ]
  await Promise.all(writes)
}

export async function listOwned(store: SkillStore, scope: string): Promise<OwnedSkill[]> {
  const root = store.root(scope)
  let dirs
  try {
    dirs = await fs.readdir(root, { withFileTypes: true })
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return []
    }

    throw error
  }

  const items = await Promise.all(
    dirs
      .filter((entry) => entry.isDirectory() && isSafeId(entry.name))
      .map(async (entry) => store.getOwned(entry.name, scope))
  )
  return items.filter((item): item is OwnedSkill => item !== undefined)
}

export async function stage(
  store: SkillStore,
  proposal: Proposal,
  validation: UnknownRecord
): Promise<{ id: string; dir: string }> {
  const id = `${Date.now()}-${randomUUID()}-${proposal.skillId ?? 'none'}`
  const dir = path.join(store.pendingRoot, id)
  await assertNoSymlinkPath(dir)
  await fs.mkdir(dir, { recursive: true })
  await atomicWrite(
    path.join(dir, 'proposal.json'),
    `${JSON.stringify({ proposal, validation }, null, 2)}\n`
  )
  if (proposal.decision === 'create') {
    await stageCreate(store, dir, proposal)
  } else if (proposal.decision === 'patch') {
    await stagePatch(store, dir, proposal)
  }

  return { id, dir }
}

export async function listPending(store: SkillStore): Promise<PendingProposal[]> {
  let entries
  try {
    entries = await fs.readdir(store.pendingRoot, { withFileTypes: true })
  } catch (error: unknown) {
    if (hasErrorCode(error, 'ENOENT')) {
      return []
    }

    throw error
  }

  const out = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          const raw = JSON.parse(
            await fs.readFile(path.join(store.pendingRoot, entry.name, 'proposal.json'), 'utf8')
          ) as { proposal: Proposal; validation: UnknownRecord }
          return { id: entry.name, ...raw }
        } catch {
          return undefined
        }
      })
  )

  return out
    .filter((item): item is PendingProposal => item !== undefined)
    .toSorted((a, b) => b.id.localeCompare(a.id))
}

export async function getPending(store: SkillStore, id: string): Promise<PendingDetails> {
  const dir = safePending(store.pendingRoot, id)
  await assertNoSymlinkPath(dir)
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'proposal.json'), 'utf8')) as {
    proposal: Proposal
    validation: UnknownRecord
  }
  const pendingDetails: PendingDetails = { id, ...raw, previews: {} }
  const previews = await Promise.all(
    ['SKILL.preview.md', 'BEFORE.md', 'AFTER.md'].map(async (name) => ({
      name,
      text: await readOptionalText(path.join(dir, name))
    }))
  )
  for (const preview of previews) {
    if (preview.text !== undefined) {
      pendingDetails.previews[preview.name] = preview.text
    }
  }

  return pendingDetails
}

async function readPendingProposal(pendingRoot: string, id: string): Promise<Proposal> {
  const dir = safePending(pendingRoot, id)
  await assertNoSymlinkPath(dir)
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'proposal.json'), 'utf8')) as unknown
  if (!isRecord(raw) || !isRecord(raw.proposal)) {
    throw new Error('pending proposal is invalid')
  }

  return raw.proposal
}

function assertProjectScope(proposal: Proposal): void {
  if (proposal.scope !== undefined && proposal.scope !== 'project') {
    throw new Error('pending proposal must target project scope')
  }
}

function assertPendingProposal(proposal: Proposal, confidenceThreshold: number): void {
  const validation = validateProposal(proposal, { confidenceThreshold })
  if (!validation.ok) {
    throw new Error(`pending proposal is no longer valid: ${validation.errors.join('; ')}`)
  }
}

export async function applyPending(
  store: SkillStore,
  id: string,
  confidenceThreshold: number
): Promise<{ result: unknown; proposal: Proposal }> {
  const proposal = await readPendingProposal(store.pendingRoot, id)
  assertProjectScope(proposal)
  const projectProposal = { ...proposal, scope: 'project' }
  assertPendingProposal(projectProposal, confidenceThreshold)
  let result: unknown
  if (projectProposal.decision === 'create') {
    result = await store.create(projectProposal, { scope: 'project' })
  } else if (projectProposal.decision === 'patch') {
    result = await store.patch(projectProposal, { scope: 'project' })
  } else {
    result = { skipped: true }
  }

  await fs.rm(safePending(store.pendingRoot, id), { recursive: true, force: true })
  return { result, proposal: projectProposal }
}

export async function rejectPending(store: SkillStore, id: string): Promise<void> {
  await fs.rm(safePending(store.pendingRoot, id), { recursive: true, force: true })
}
