import fs from 'node:fs/promises'
import path from 'node:path'
import {
  assertNoSymlinkPath,
  atomicWrite,
  hasErrorCode,
  isSafeId,
  nowIso,
  sha256
} from './shared.ts'
import {
  applyOperations,
  bumpVersion,
  ensureSupportingFilesAbsent,
  proposalFiles,
  reserveDirectory,
  supportPath,
  writeCreatedSkill,
  yamlScalar
} from './store-files.ts'
import {
  applyPending as applyPendingSkill,
  getPending as getPendingSkill,
  listOwned as listOwnedSkills,
  listPending as listPendingSkills,
  listSupportingFiles as listSkillSupportingFiles,
  rejectPending as rejectPendingSkill,
  stage as stageSkill
} from './store-operations.ts'
import { archiveSkill, promote as promoteSkill } from './store-promotion.ts'
import type { Proposal, SupportingFile, UnknownRecord } from './types.ts'
import type { OwnedSkill } from './store-types.ts'

export { validateProposal } from './store-validation.ts'
export { proposalInputSchema, validationInputSchema } from './store-schemas.ts'

export type { OwnedSkill } from './store-types.ts'
type PreparedPatch = { current: OwnedSkill; nextText: string; supportingFiles: SupportingFile[] }

async function readOwnedSkill(
  file: string,
  skillId: string,
  scope: string,
  supportingFiles: (
    skillId: string,
    scope: string
  ) => Promise<Array<{ path: string; bytes: number }>>
): Promise<OwnedSkill | undefined> {
  const text = await fs.readFile(file, 'utf8')
  if (!text.includes(OWNER_MARKER)) {
    return undefined
  }

  return {
    skillId,
    scope,
    file,
    dir: path.dirname(file),
    text,
    sha256: sha256(text),
    supportingFiles: await supportingFiles(skillId, scope)
  }
}

async function preparePatch(
  store: SkillStore,
  proposal: Proposal,
  scope: string
): Promise<PreparedPatch> {
  const skillId = proposal.skillId ?? ''
  const current = await requireOwnedSkill(store, skillId, scope)
  assertExpectedSkillHash(current, proposal.expectedSha256, skillId)
  const supportingFiles = proposal.addFiles ?? []
  await ensureSupportingFilesAbsent(current.dir, supportingFiles)
  const text = applyOperations(current.text, proposal.operations ?? [])
  return { current, nextText: bumpVersion(text), supportingFiles }
}

const OWNER_MARKER = 'learning/owner: "opencode-learning"'

export class SkillStore {
  readonly projectRoot: string
  readonly projectRootSkills: string
  readonly globalRootSkills: string
  readonly stateRoot: string
  readonly pendingRoot: string
  readonly archiveRoot: string

  constructor({
    projectRoot,
    projectSkillDir,
    globalSkillDir,
    stateDir
  }: {
    projectRoot: string
    projectSkillDir: string
    globalSkillDir: string
    stateDir: string
  }) {
    this.projectRoot = projectRoot
    this.projectRootSkills = path.resolve(projectRoot, projectSkillDir)
    this.globalRootSkills = path.resolve(globalSkillDir)
    this.stateRoot = path.resolve(projectRoot, stateDir)
    this.pendingRoot = path.join(this.stateRoot, 'pending')
    this.archiveRoot = path.join(this.stateRoot, 'archive')
  }

  root(scope = 'project'): string {
    return scope === 'global' ? this.globalRootSkills : this.projectRootSkills
  }

  skillDir(skillId: string, scope = 'project'): string {
    const invalidSkillId = skillId
    if (!isSafeId(skillId)) {
      throw new Error(`invalid skill id: ${invalidSkillId}`)
    }

    return path.join(this.root(scope), skillId)
  }

  skillPath(skillId: string, scope = 'project'): string {
    return path.join(this.skillDir(skillId, scope), 'SKILL.md')
  }

  async listSupportingFiles(
    skillId: string,
    scope = 'project'
  ): Promise<Array<{ path: string; bytes: number }>> {
    return listSkillSupportingFiles(this, skillId, scope)
  }

  async getOwned(skillId: string, scope = 'project'): Promise<OwnedSkill | undefined> {
    const file = this.skillPath(skillId, scope)
    await assertNoSymlinkPath(file)
    try {
      return await readOwnedSkill(file, skillId, scope, async (id, currentScope) =>
        this.listSupportingFiles(id, currentScope)
      )
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) {
        return undefined
      }

      throw error
    }
  }

  async listOwned(scope = 'project'): Promise<OwnedSkill[]> {
    return listOwnedSkills(this, scope)
  }

  renderCreated(proposal: Proposal): string {
    const skill = proposal.skill!
    return `---
name: ${yamlScalar(proposal.skillId)}
description: ${yamlScalar(skill.description)}
metadata:
  opencode/slash: "false"
  opencode/autoinvoke: "true"
  ${OWNER_MARKER}
  learning/created: ${yamlScalar(nowIso())}
  learning/version: "1"
---

${skill.body.trim()}
`
  }

  async create(
    proposal: Proposal,
    { scope = 'project' }: { scope?: string } = {}
  ): Promise<{ file: string; text: string; sha256: string; supportingFiles: string[] }> {
    const skillId = proposal.skillId ?? ''
    const dir = this.skillDir(skillId, scope)
    const file = path.join(dir, 'SKILL.md')
    const text = this.renderCreated(proposal)
    const files = proposalFiles(proposal)
    await reserveDirectory(dir, `skill already exists: ${proposal.skillId}`)
    await writeCreatedSkill({ store: this, dir, file, text, files })

    return {
      file,
      text,
      sha256: sha256(text),
      supportingFiles: files.map((item) => item.path)
    }
  }

  async patch(
    proposal: Proposal,
    { scope = 'project' }: { scope?: string } = {}
  ): Promise<{ file: string; text: string; sha256: string; addedFiles: string[] }> {
    const prepared = await preparePatch(this, proposal, scope)
    await atomicWrite(prepared.current.file, prepared.nextText)
    await this.addSupportingFiles(prepared.current.dir, prepared.supportingFiles)
    return {
      file: prepared.current.file,
      text: prepared.nextText,
      sha256: sha256(prepared.nextText),
      addedFiles: prepared.supportingFiles.map((item) => item.path)
    }
  }

  async addSupportingFiles(skillDir: string, files: SupportingFile[]): Promise<void> {
    await Promise.all(
      files.map(async (item) => atomicWrite(supportPath(skillDir, item.path), item.content))
    )
  }

  async stage(proposal: Proposal, validation: UnknownRecord): Promise<{ id: string; dir: string }> {
    return stageSkill(this, proposal, validation)
  }

  async listPending() {
    return listPendingSkills(this)
  }

  async getPending(id: string) {
    return getPendingSkill(this, id)
  }

  async applyPending(
    id: string,
    { confidenceThreshold = 0.72 }: { confidenceThreshold?: number } = {}
  ) {
    return applyPendingSkill(this, id, confidenceThreshold)
  }

  async rejectPending(id: string): Promise<void> {
    return rejectPendingSkill(this, id)
  }

  async promote(skillId: string) {
    return promoteSkill(this, skillId)
  }

  async archive(skillId: string, { scope = 'project' }: { scope?: string } = {}): Promise<boolean> {
    return (await archiveSkill(this, skillId, scope)) !== undefined
  }
}

async function requireOwnedSkill(
  store: SkillStore,
  skillId: string,
  scope: string
): Promise<OwnedSkill> {
  const current = await store.getOwned(skillId, scope)
  if (current === undefined) {
    throw new Error(`refusing to patch non-owned or missing skill: ${skillId}`)
  }

  return current
}

function assertExpectedSkillHash(
  current: OwnedSkill,
  expectedSha256: string | undefined,
  skillId: string
): void {
  if (current.sha256 !== expectedSha256) {
    throw new Error(`stale patch for ${skillId}; skill changed since reflection`)
  }
}
