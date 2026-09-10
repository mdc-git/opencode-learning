import { candidatePacket, catalog, type Candidate } from './candidates.ts'
import type { Evidence } from './evidence.ts'
import type { ProposalMetadata } from './proposal.ts'
import type { ActiveReflection } from './review-schema.ts'

type PacketReview = {
  evidence: Evidence
  candidates: Candidate[]
  all: Candidate[]
}

export function proposalFor(
  reflection: ActiveReflection,
  evidence: Evidence,
  candidate?: Candidate
): ProposalMetadata {
  return {
    kind: reflection.kind,
    skillId: reflection.skillId,
    reason: reflection.reason,
    evidence,
    ...(candidate !== undefined && { expectedRevision: candidate.revision })
  }
}

function sourceSnapshots(reflection: ActiveReflection, files: ReadonlyArray<{ path: string }>) {
  const sourcePaths = new Set(
    reflection.skill.files.filter((file) => 'source' in file).map((file) => file.path)
  )
  return files.filter((file) => sourcePaths.has(file.path))
}

export function validatorPacket(
  reflection: ActiveReflection,
  result: PacketReview,
  files: ReadonlyArray<{ path: string }>
) {
  return {
    evidence: result.evidence,
    ownedSkills: catalog(result.all),
    candidates: candidatePacket(result.candidates),
    proposal: { kind: reflection.kind, skillId: reflection.skillId },
    skillMd: reflection.skill.skillMd,
    generatedFiles: reflection.skill.files.filter((file) => 'content' in file),
    sourceSnapshots: sourceSnapshots(reflection, files),
    manifest: files
  }
}
