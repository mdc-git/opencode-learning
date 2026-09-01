export type PendingReview = { force: boolean; terminalType: string }
export type ReviewOwner = {
  start: (sessionID: string, options: PendingReview) => void
  invalidateSession: (sessionID: string) => void
  waitForSession: (sessionID: string) => Promise<void>
}
export type ReviewState = {
  inFlight: Set<string>
  requests: Map<string, boolean>
  pending: Map<string, PendingReview>
  lastAutomaticReviewTurn: Map<string, number>
  successfulTurns: Map<string, number>
  reviewedFingerprints: Map<string, Map<string, string>>
  lastSuppressedFingerprint: Map<string, string>
  owners: Map<string, ReviewOwner>
  claims: Map<string, symbol>
}

export function createReviewState(): ReviewState {
  return {
    inFlight: new Set(),
    requests: new Map(),
    pending: new Map(),
    lastAutomaticReviewTurn: new Map(),
    successfulTurns: new Map(),
    reviewedFingerprints: new Map(),
    lastSuppressedFingerprint: new Map(),
    owners: new Map(),
    claims: new Map()
  }
}

export function clearReviewState(state: ReviewState): void {
  state.inFlight.clear()
  state.requests.clear()
  state.pending.clear()
  state.lastAutomaticReviewTurn.clear()
  state.successfulTurns.clear()
  state.reviewedFingerprints.clear()
  state.lastSuppressedFingerprint.clear()
  state.owners.clear()
  state.claims.clear()
}

export async function waitForPreviousOwner(
  state: ReviewState,
  owner: ReviewOwner,
  sessionID: string
): Promise<void> {
  const previous = state.owners.get(sessionID)
  if (previous === undefined || previous === owner) {
    return
  }

  previous.invalidateSession(sessionID)
  await previous.waitForSession(sessionID)
}

function isSessionOwned(state: ReviewState, owner: ReviewOwner, sessionID: string): boolean {
  const current = state.owners.get(sessionID)
  return current === undefined || current === owner
}

export function createClaimGuard(
  state: ReviewState,
  owner: ReviewOwner,
  invalidatedSessions: Set<string>,
  isDisposed: () => boolean
): (sessionID: string, isExpectedOwner: boolean) => boolean {
  return (sessionID, isExpectedOwner) =>
    !isDisposed() &&
    (isExpectedOwner ||
      (!invalidatedSessions.has(sessionID) && isSessionOwned(state, owner, sessionID)))
}

export function markAutomaticReview(
  state: ReviewState,
  sessionID: string,
  isForced: boolean
): void {
  if (!isForced) {
    state.lastAutomaticReviewTurn.set(sessionID, state.successfulTurns.get(sessionID) ?? 0)
  }
}
