export type OwnedSkill = {
  skillId: string
  scope: string
  file: string
  dir: string
  text: string
  sha256: string
  supportingFiles: Array<{ path: string; bytes: number }>
}
