import fs from 'node:fs/promises'
import path from 'node:path'
import { assertNoSymlinkPath, hasErrorCode } from './shared.ts'
import type { SkillStore } from './store.ts'

async function copyPromotedSkill(
  sourceDir: string,
  target: string,
  globalRootSkills: string
): Promise<void> {
  await assertNoSymlinkPath(target)
  await fs.mkdir(globalRootSkills, { recursive: true })
  let isReserved = false
  try {
    await fs.mkdir(target)
    isReserved = true
    const entries = await fs.readdir(sourceDir)
    await Promise.all(
      entries.map(async (entry) =>
        fs.cp(path.join(sourceDir, entry), path.join(target, entry), {
          recursive: true,
          force: false,
          errorOnExist: true
        })
      )
    )
  } catch (error) {
    if (isReserved) {
      await fs.rm(target, { recursive: true, force: true })
    }

    throw error
  }
}

async function ensurePromotionTarget(store: SkillStore, skillId: string): Promise<string> {
  if (await store.getOwned(skillId, 'global')) {
    throw new Error(`global skill already exists: ${skillId}`)
  }

  const target = store.skillDir(skillId, 'global')
  try {
    await fs.access(target)
    throw new Error(`global skill path already exists: ${skillId}`)
  } catch (error: unknown) {
    if (!hasErrorCode(error, 'ENOENT')) {
      throw error
    }
  }

  return target
}

export async function promote(
  store: SkillStore,
  skillId: string
): Promise<{ skillId: string; source: string; target: string }> {
  const source = await store.getOwned(skillId, 'project')
  if (source === undefined) {
    throw new Error(`cannot promote non-owned or missing project skill: ${skillId}`)
  }

  const target = await ensurePromotionTarget(store, skillId)
  await copyPromotedSkill(source.dir, target, store.globalRootSkills)
  return { skillId, source: source.dir, target }
}

export async function archiveSkill(
  store: SkillStore,
  skillId: string,
  scope: string
): Promise<string | undefined> {
  const current = await store.getOwned(skillId, scope)
  if (!current) {
    return undefined
  }

  const target = path.join(store.archiveRoot, scope, `${Date.now()}-${skillId}`)
  await assertNoSymlinkPath(target)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.rename(current.dir, target)
  return target
}
