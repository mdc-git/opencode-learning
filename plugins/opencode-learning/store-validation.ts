import { isRecord, isSafeId } from './shared.ts'
import type {
  Proposal,
  SectionOperation,
  SupportingFile,
  UnknownRecord,
  Validation
} from './types.ts'

const SECRET_PATTERNS = [
  /-----begin (?:rsa |ec |openssh )?private key-----/iv,
  /\b(?:sk|ghp|github_pat|xox[abprs])-[\w\u{2D}]{16,}\b/v,
  /\bAKIA[0-9A-Z]{16}\b/v,
  /\b(?:password|passwd|api(?:-|_)?key|secret|token)\s*[:=]\s*\S{8,}/iv
]
const TRANSIENT_PATTERNS = [
  /\/tmp\//v,
  /\/var\/tmp\//v,
  /\/home\/[\w\u{2D}.]+\//v,
  /\b20\d\d(?:-|\/)\d\d(?:-|\/)\d\d[ T]\d\d:/v,
  /\bpid\s*(?:[:=]\s*)?\d{2,}\b/iv
]

export function validateProposal(
  proposal: unknown,
  { confidenceThreshold = 0.72 }: { confidenceThreshold?: number } = {}
): Validation {
  return validateProposalAt(proposal, confidenceThreshold)
}

function validateProposalAt(proposal: unknown, confidenceThreshold: number): Validation {
  const errors: string[] = []
  const warnings: string[] = []
  if (!isRecord(proposal)) {
    return { ok: false, errors: ['proposal must be an object'], warnings }
  }

  const candidate = proposal as Proposal
  validateProposalBasics(candidate, errors)
  if (candidate.decision === 'none') {
    return { ok: errors.length === 0, errors, warnings }
  }

  validateNonEmptyProposal(candidate, confidenceThreshold, errors)
  validateProposalSafety(candidate, warnings, errors)
  validateProposalDecision(candidate, errors)

  return { ok: errors.length === 0, errors, warnings }
}

function validateProposalDecision(candidate: Proposal, errors: string[]): void {
  if (candidate.decision === 'create') {
    validateCreateProposal(candidate, errors)
    return
  }

  if (candidate.decision === 'patch') {
    validatePatchProposal(candidate, errors)
  }
}

function validateProposalBasics(candidate: Proposal, errors: string[]): void {
  addValidationError(
    errors,
    isInvalidDecision(candidate.decision),
    'decision must be none, create, or patch'
  )
  addValidationError(errors, isInvalidReason(candidate.reason), 'reason is required')
  addValidationError(errors, !Array.isArray(candidate.evidence), 'evidence must be an array')
  addValidationError(errors, isInvalidConfidence(candidate.confidence), 'confidence must be 0..1')
}

function addValidationError(errors: string[], isInvalid: boolean, message: string): void {
  if (isInvalid) {
    errors.push(message)
  }
}

function isInvalidDecision(value: unknown): boolean {
  return !['none', 'create', 'patch'].includes(typeof value === 'string' ? value : '')
}

function isInvalidReason(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length < 12
}

function isInvalidConfidence(value: unknown): boolean {
  return typeof value !== 'number' || value < 0 || value > 1
}

function validateNonEmptyProposal(
  candidate: Proposal,
  confidenceThreshold: number,
  errors: string[]
): void {
  validateSkillId(candidate, errors)
  validateEvidence(candidate, errors)
  validateConfidenceThreshold(candidate, confidenceThreshold, errors)
  validateScope(candidate, errors)
}

function validateSkillId(candidate: Proposal, errors: string[]): void {
  addValidationError(
    errors,
    !isSafeId(candidate.skillId ?? ''),
    'skillId must be lowercase kebab-case, 1-64 chars'
  )
}

function validateEvidence(candidate: Proposal, errors: string[]): void {
  addValidationError(
    errors,
    !Array.isArray(candidate.evidence) || candidate.evidence.length === 0,
    'at least one evidence item is required'
  )
}

function validateConfidenceThreshold(
  candidate: Proposal,
  confidenceThreshold: number,
  errors: string[]
): void {
  addValidationError(
    errors,
    typeof candidate.confidence === 'number' && candidate.confidence < confidenceThreshold,
    `confidence below threshold ${confidenceThreshold}`
  )
}

function validateScope(candidate: Proposal, errors: string[]): void {
  if (candidate.scope !== undefined && !['project', 'global'].includes(candidate.scope)) {
    errors.push('scope must be project or global')
  }

  if (candidate.scope === 'global') {
    errors.push('global skill writes are disabled')
  }
}

function validateProposalSafety(candidate: Proposal, warnings: string[], errors: string[]): void {
  const serialized = JSON.stringify(candidate)
  if (SECRET_PATTERNS.some((re) => re.test(serialized))) {
    errors.push('proposal appears to contain a credential or secret')
  }

  if (TRANSIENT_PATTERNS.some((re) => re.test(serialized))) {
    warnings.push('proposal contains machine- or run-specific data; inspect before applying')
  }
}

function validateCreateProposal(candidate: Proposal, errors: string[]): void {
  const { skill } = candidate
  if (skill === undefined) {
    errors.push('create requires skill')
    return
  }

  validateCreateSkillFields(skill, errors)
  validateSupportingFiles(skill.files, errors, 'skill.files')
}

function validateCreateSkillFields(skill: NonNullable<Proposal['skill']>, errors: string[]): void {
  addValidationError(
    errors,
    typeof skill.name !== 'string' || skill.name.trim().length === 0,
    'skill.name is required'
  )
  addValidationError(
    errors,
    typeof skill.description !== 'string' || skill.description.trim().length < 12,
    'skill.description is required'
  )
  addValidationError(
    errors,
    typeof skill.body !== 'string' || skill.body.trim().length < 40,
    'skill.body is too short'
  )
}

function validatePatchProposal(candidate: Proposal, errors: string[]): void {
  validatePatchRequirements(candidate, errors)
  validatePatchOperations(candidate, errors)
  validateSupportingFiles(candidate.addFiles, errors, 'addFiles')
}

function validatePatchRequirements(candidate: Proposal, errors: string[]): void {
  if (isInvalidExpectedHash(candidate.expectedSha256)) {
    errors.push('patch requires expectedSha256')
  }

  if (isMissingPatchOperations(candidate.operations)) {
    errors.push('patch requires operations')
  }
}

function isInvalidExpectedHash(value: unknown): boolean {
  return typeof value !== 'string' || !/^[0-9a-f]{64}$/iv.test(value)
}

function isMissingPatchOperations(value: unknown): boolean {
  return !Array.isArray(value) || value.length === 0
}

function validatePatchOperations(candidate: Proposal, errors: string[]): void {
  for (const op of candidate.operations ?? []) {
    validateSectionOperation(op, errors)
  }
}

function validateSectionOperation(op: SectionOperation, errors: string[]): void {
  if (isInvalidOperationKind(op.kind)) {
    errors.push(`unsupported operation ${op.kind}`)
  }

  if (isMissingOperationHeading(op.heading)) {
    errors.push('operation heading is required')
  }

  if (isMissingOperationBody(op.body)) {
    errors.push('operation body is required')
  }
}

function isInvalidOperationKind(value: unknown): boolean {
  return !['replace_section', 'append_section'].includes(String(value))
}

function isMissingOperationHeading(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0
}

function isMissingOperationBody(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0
}

function validateSupportingFiles(files: unknown, errors: string[], label: string): void {
  if (isMissingSupportingFiles(files)) {
    return
  }

  if (!Array.isArray(files)) {
    errors.push(`${label} must be an array`)
    return
  }

  for (const file of files) {
    validateSupportingFile(file, errors, label)
  }
}

function isMissingSupportingFiles(files: unknown): boolean {
  return files === null || files === undefined
}

function validateSupportingFile(file: unknown, errors: string[], label: string): void {
  if (!isRecord(file)) {
    errors.push(`${label} entries must be objects`)
    return
  }

  if (!isSafeSupportPath(file.path)) {
    errors.push(`${label} path must be a safe relative path outside SKILL.md`)
  }

  if (isMissingSupportingContent(file.content)) {
    errors.push(`${label} content is required`)
  }
}

function isMissingSupportingContent(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0
}

export function isSafeSupportPath(value: unknown): boolean {
  if (!isSupportPathString(value)) {
    return false
  }

  return isRelativeSupportPath(value)
}

function isSupportPathString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 180
}

function isRelativeSupportPath(value: string): boolean {
  if (value === 'SKILL.md' || value.startsWith('/') || value.includes('\\')) {
    return false
  }

  const parts = value.split('/')
  return parts.every(
    (part) => part.length > 0 && part !== '.' && part !== '..' && !part.startsWith('.')
  )
}
