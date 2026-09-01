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
  listSupportingFiles,
  reserveDirectory,
  supportPath,
  yamlScalar
} from './store-files.ts'
import type { OwnedSkill, Proposal, SupportingFile } from './types.ts'

const OWNER_MARKER = 'learning/owner: "opencode-learning"'

export class SkillStore {
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
    this.projectRootSkills = path.resolve(projectRoot, projectSkillDir)
    this.globalRootSkills = path.resolve(globalSkillDir)
    this.stateRoot = path.resolve(projectRoot, stateDir)
    this.pendingRoot = path.join(this.stateRoot, 'pending')
    this.archiveRoot = path.join(this.stateRoot, 'archive')
  }

  root(scope: string): string {
    return scope === 'global' ? this.globalRootSkills : this.projectRootSkills
  }

  skillDir(skillId: string, scope: string): string {
    if (!isSafeId(skillId)) {
      throw new Error(`invalid skill id: ${skillId}`)
    }

    return path.join(this.root(scope), skillId)
  }

  async getOwned(skillId: string, scope: string): Promise<OwnedSkill | undefined> {
    const file = path.join(this.skillDir(skillId, scope), 'SKILL.md')
    await assertNoSymlinkPath(file)
    try {
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
        supportingFiles: await listSupportingFiles(path.dirname(file))
      }
    } catch (error: unknown) {
      if (hasErrorCode(error, 'ENOENT')) {
        return undefined
      }

      throw error
    }
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
    { scope }: { scope: string }
  ): Promise<{ file: string; text: string; sha256: string; supportingFiles: string[] }> {
    const skillId = proposal.skillId!
    const dir = this.skillDir(skillId, scope)
    const file = path.join(dir, 'SKILL.md')
    const text = this.renderCreated(proposal)
    const files = proposal.skill!.files ?? []
    await reserveDirectory(dir, `skill already exists: ${proposal.skillId}`)

    try {
      await atomicWrite(file, text)
      await this.addSupportingFiles(dir, files)
    } catch (error) {
      await fs.rm(dir, { recursive: true, force: true })
      throw error
    }

    return {
      file,
      text,
      sha256: sha256(text),
      supportingFiles: files.map((item) => item.path)
    }
  }

  async patch(
    proposal: Proposal,
    { scope }: { scope: string }
  ): Promise<{ file: string; text: string; sha256: string; addedFiles: string[] }> {
    const skillId = proposal.skillId!
    const current = await this.getOwned(skillId, scope)
    if (current === undefined) {
      throw new Error(`refusing to patch non-owned or missing skill: ${skillId}`)
    }

    if (current.sha256 !== proposal.expectedSha256) {
      throw new Error(`stale patch for ${skillId}; skill changed since reflection`)
    }

    const supportingFiles = proposal.addFiles ?? []
    await ensureSupportingFilesAbsent(current.dir, supportingFiles)
    const nextText = bumpVersion(applyOperations(current.text, proposal.operations!))
    await atomicWrite(current.file, nextText)
    await this.addSupportingFiles(current.dir, supportingFiles)
    return {
      file: current.file,
      text: nextText,
      sha256: sha256(nextText),
      addedFiles: supportingFiles.map((item) => item.path)
    }
  }

  async addSupportingFiles(skillDir: string, files: SupportingFile[]): Promise<void> {
    await Promise.all(
      files.map(async (item) => atomicWrite(supportPath(skillDir, item.path), item.content))
    )
  }
}
