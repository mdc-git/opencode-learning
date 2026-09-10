const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/v
const SKILL_ID = /^[0-9a-z]+(?:-[0-9a-z]+)*$/v
const REVISION = /^[0-9a-f]{64}$/v
const PROPOSAL_KEYS = new Set(['kind', 'skillId', 'reason', 'evidence', 'expectedRevision'])

export type ProposalMetadata = {
  kind: 'create' | 'patch'
  skillId: string
  reason: string
  evidence: unknown
  expectedRevision?: string
}

export type PendingProposal = ProposalMetadata & { id: string; invalid?: boolean }
type ProposalBase = Pick<ProposalMetadata, 'kind' | 'skillId' | 'reason' | 'evidence'>

type Mapping = Record<string, unknown>

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function proposalRecord(value: unknown): Mapping {
  if (!isMapping(value)) {
    throw new TypeError('invalid proposal metadata')
  }

  if (Object.keys(value).some((key) => !PROPOSAL_KEYS.has(key))) {
    throw new Error('proposal metadata contains unsupported fields')
  }

  return value
}

function proposalKind(value: unknown): ProposalMetadata['kind'] {
  if (value !== 'create' && value !== 'patch') {
    throw new TypeError('invalid proposal kind')
  }

  return value
}

export function validSkillId(value: unknown): value is string {
  return typeof value === 'string' && SKILL_ID.test(value)
}

function proposalSkillId(value: unknown): string {
  if (!validSkillId(value)) {
    throw new TypeError('invalid skill id')
  }

  return value
}

function proposalReason(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('proposal reason is required')
  }

  return value
}

function proposalBase(input: Mapping): ProposalBase {
  if (!('evidence' in input)) {
    throw new TypeError('proposal evidence is required')
  }

  return {
    kind: proposalKind(input.kind),
    skillId: proposalSkillId(input.skillId),
    reason: proposalReason(input.reason),
    evidence: input.evidence
  }
}

function patchRevision(input: Mapping): string {
  if (typeof input.expectedRevision !== 'string' || !REVISION.test(input.expectedRevision)) {
    throw new TypeError('patch expectedRevision is required')
  }

  return input.expectedRevision
}

export function isProposalId(id: string): boolean {
  return UUID.test(id)
}

export function decodeProposal(value: unknown): ProposalMetadata {
  const input = proposalRecord(value)
  const proposal = proposalBase(input)
  if (proposal.kind === 'create') {
    if ('expectedRevision' in input) {
      throw new Error('create proposal must not have expectedRevision')
    }

    return proposal
  }

  return { ...proposal, expectedRevision: patchRevision(input) }
}
