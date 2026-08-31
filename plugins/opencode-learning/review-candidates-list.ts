import type { OpenCodeContext, SkillInfo } from './sdk.ts'

export async function listSkills(ctx: OpenCodeContext): Promise<readonly SkillInfo[]> {
  try {
    const response = await ctx.skill.list()
    return response.data ?? []
  } catch {
    return []
  }
}
