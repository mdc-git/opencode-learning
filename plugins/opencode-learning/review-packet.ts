import { Buffer } from 'node:buffer'
import { candidatePacket, catalog, type Candidate } from './candidates.ts'
import type { PendingProposal, ProposalMetadata } from './proposal.ts'
import { boundPacket, pendingCatalog, type Evidence } from './evidence.ts'
import { REFLECTOR } from './review-prompts.ts'
import type { ActiveReflection } from './review-schema.ts'

type PacketReview = {
  evidence: Evidence
  candidates: Candidate[]
  all: Candidate[]
  pending: PendingProposal[]
}

export function reflectionCapture(
  all: Candidate[],
  pending: PendingProposal[],
  options: { startAfter?: string; lookbackTurns?: number }
) {
  let evidence: Evidence = {
    records: [],
    omitted: 0,
    authorizedPaths: [],
    freshStart: 0,
    skipped: 0,
    deferred: 0
  }
  let candidates: Candidate[] = []
  return {
    prepare(messages: readonly unknown[], maxBytes: number): string {
      const overhead = Buffer.byteLength(`${REFLECTOR}\n\n`) + 64
      const bounded = boundPacket(
        messages,
        { all, pending },
        options,
        Math.max(1, Math.floor(maxBytes / 2) - overhead)
      )
      evidence = bounded.evidence
      candidates = bounded.candidates
      return `${REFLECTOR}\n\n${JSON.stringify({
        evidence,
        ownedSkills: catalog(all),
        pendingSkills: pendingCatalog(pending),
        candidates: candidatePacket(candidates)
      })}`
    },
    result: () => ({ evidence, candidates })
  }
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
    pendingSkills: pendingCatalog(result.pending),
    candidates: candidatePacket(result.candidates),
    proposal: { kind: reflection.kind, skillId: reflection.skillId },
    skillMd: reflection.skill.skillMd,
    generatedFiles: reflection.skill.files.filter((file) => 'content' in file),
    sourceSnapshots: sourceSnapshots(reflection, files),
    manifest: files
  }
}
