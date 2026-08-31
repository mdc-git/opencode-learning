import { SESSION_ID_KEY } from './shared.ts'
import type { Telemetry } from './telemetry.ts'
import type { Proposal } from './types.ts'
import type { ReviewResultOptions, ReviewValidation } from './review-types.ts'

export async function recordReviewResult({
  telemetry,
  sessionID,
  terminalType,
  force,
  score,
  proposal,
  validation
}: ReviewResultOptions): Promise<void> {
  await telemetry
    .recordReview({
      [SESSION_ID_KEY]: sessionID,
      trigger: force ? 'forced' : 'automatic',
      terminalType,
      score,
      decision: proposal.decision,
      skillId: proposal.skillId,
      validation
    })
    .catch((error: unknown) => {
      console.error('[opencode-learning] telemetry recordReview failed', error)
    })
}

export function summarizeNoChange(proposal: Proposal, validation: ReviewValidation): string {
  if (isNoChangeProposal(proposal)) {
    return noChangeProposalReason(proposal.reason)
  }

  if (isInvalidValidation(validation)) {
    return validationErrors(validation)
  }

  return rejectedReason(validation)
}

function isNoChangeProposal(proposal: Proposal): boolean {
  return proposal.decision === 'none'
}

function isInvalidValidation(validation: ReviewValidation): boolean {
  return !validation.deterministic.ok
}

function noChangeProposalReason(reason: string | undefined): string {
  return reason === undefined || reason.length === 0 ? 'nothing durable was found' : reason
}

function validationErrors(validation: ReviewValidation): string {
  return validation.deterministic.errors.join('; ')
}

function rejectedReason(validation: ReviewValidation): string {
  return validation.agent?.decision === 'reject' ? validation.agent.reason : 'no durable change'
}
