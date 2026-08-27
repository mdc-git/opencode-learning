import path from 'node:path'
import { createReviewSession, interruptSession, notifySession, promptSession } from './events.ts'
import { deriveTriggerFeatures, scoreReviewCandidate, type TriggerDecision } from './scoring.ts'
import {
  daysSince,
  isRecord,
  normalizeCreateProposal,
  readJson,
  redactError,
  SESSION_ID_KEY,
  trimText,
  writeJson
} from './shared.ts'
import { validateProposal, type OwnedSkill, type SkillStore } from './store.ts'
import type { InternalMailbox } from './mailbox.ts'
import type { ExperienceRecorder } from './recorder.ts'
import type {
  LearningConfig,
  CuratorConfig,
  Proposal,
  Validation,
  ValidationSubmission,
  UnknownRecord,
  ExperienceSnapshot,
  Candidate
} from './types.ts'
import type { OpenCodeContext, SessionInfo, SkillInfo } from './sdk.ts'
import type { SkillTelemetry, Telemetry } from './telemetry.ts'

type ReviewRequest = { force: boolean; terminalType?: string }
type ReviewOptions = { force?: boolean; terminalType?: string; triggerDecision?: TriggerDecision }
type ReviewAttemptOptions = ReviewOptions & { onReflectorStart?: () => void }
type ReviewValidation = UnknownRecord & {
  deterministic: Validation
  agent: ValidationSubmission
  ok: boolean
}
type ReviewAttempt = { proposal: Proposal; validation: ReviewValidation }
type ReviewOutcome = UnknownRecord & { status: string }
type PreparedReview = { batch: ExperienceSnapshot; candidate: TriggerDecision | undefined }
type CuratorResult = { stale: string[]; archived: string[] } | { skipped: string }
type ReviewPipelineOptions = {
  ctx: OpenCodeContext
  recorder: ExperienceRecorder
  store: SkillStore
  telemetry: Telemetry
  mailbox: InternalMailbox
  config: LearningConfig
}

function tokens(text: unknown): Set<string> {
  const matches = String(text)
    .toLowerCase()
    .match(/[0-9a-z][\u{2D}.0-9_a-z]{2,}/gv)
  return matches === null ? new Set<string>() : new Set(matches)
}

function overlapScore(a: unknown, b: unknown): number {
  const tokensA = tokens(a)
  const tokensB = tokens(b)
  if (tokensA.size === 0 || tokensB.size === 0) {
    return 0
  }

  let hits = 0
  for (const item of tokensA) {
    if (tokensB.has(item)) {
      hits++
    }
  }

  return hits / Math.sqrt(tokensA.size * tokensB.size)
}

async function retrieveCandidates({
  ctx,
  exp,
  store,
  maxCandidates = 5
}: {
  ctx: OpenCodeContext
  exp: ExperienceSnapshot
  store: SkillStore
  maxCandidates?: number
}): Promise<Candidate[]> {
  let catalog: readonly SkillInfo[] = []
  try {
    const skills = await ctx.skill.list()
    catalog = skills.data ?? []
  } catch {}

  const query = [
    exp.goal,
    ...(exp.contextTail ?? []).map((x) => x.text ?? x),
    ...(exp.toolCalls ?? [])
      .slice(-16)
      .map((x) => `${trimText(x.tool)} ${trimText(x.input)} ${trimText(x.result)}`)
  ].join('\n')
  const used = new Set(exp.skillsUsed)
  const ranked: Candidate[] = catalog
    .map((skill) => {
      const { id } = skill
      const description = skill.description ?? ''
      return {
        id,
        name: skill.name,
        description,
        score: overlapScore(query, `${id} ${description}`) + (used.has(id) ? 1 : 0)
      }
    })
    .filter((x) => x.id.length > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, maxCandidates)
  const enriched = await Promise.all(
    ranked.map(async (item) => {
      const owned = await store.getOwned(item.id, 'project')
      return owned === undefined
        ? { ...item, owned: false }
        : {
            ...item,
            owned: true,
            scope: owned.scope,
            sha256: owned.sha256,
            body: owned.text,
            supportingFiles: owned.supportingFiles
          }
    })
  )

  return enriched
}

function trajectoryPayload(exp: ExperienceSnapshot): UnknownRecord {
  return {
    goal: trimText(exp.goal, 2500),
    contextTail: exp.contextTail?.slice(-8),
    corrections: exp.corrections?.slice(-10),
    skillsUsed: exp.skillsUsed,
    recoveries: exp.recoveries,
    verificationSteps: exp.verificationSteps,
    toolCalls: exp.toolCalls?.slice(-50)
  }
}

function candidatesPayload(candidates: Candidate[]): UnknownRecord[] {
  return candidates.map((x) => ({
    id: x.id,
    name: x.name,
    description: x.description,
    owned: Boolean(x.owned),
    scope: x.scope,
    sha256: x.sha256,
    supportingFiles: x.supportingFiles,
    body: x.owned ? trimText(x.body, 14e3) : undefined
  }))
}

function buildReviewPrompt({
  exp,
  candidates,
  triggerDecision
}: {
  exp: ExperienceSnapshot
  candidates: Candidate[]
  triggerDecision?: TriggerDecision
}): string {
  const triggerBlock = formatTriggerSignals(triggerDecision)
  return `Review the completed experience below for durable procedural knowledge.

Allowed write scope: project only.

## Completed experience

\`\`\`json
${JSON.stringify(trajectoryPayload(exp), null, 2)}
\`\`\`

## Candidate skills

\`\`\`json
${JSON.stringify(candidatesPayload(candidates), null, 2)}
\`\`\`
${triggerBlock}
Submit exactly one proposal through learning_submit_proposal. Create and patch decisions must include skillId as lowercase kebab-case with 1-64 characters. For a create, supporting files may be supplied as skill.files. For a patch, addFiles may create new supporting files but must never overwrite an existing supporting file. Do not edit files directly.`
}

function formatTriggerSignals(triggerDecision: TriggerDecision | undefined): string {
  if (!triggerDecision) {
    return ''
  }

  const reasons = triggerDecision.reasons ?? {}
  const reasonLines =
    Object.keys(reasons).length > 0
      ? Object.entries(reasons)
          .map(([key, value]) => `- ${key}: ${value}`)
          .join('\n')
      : '- (none)'
  const signalText = (triggerDecision.strongSignals ?? []).join(', ')
  const signals = signalText.length > 0 ? signalText : 'none'
  return `
## Trigger signals

The deterministic trigger scorer found these closed-loop signals in the experience:

- strong signals: ${signals}
- reason counts:
${reasonLines}

Score is a deterministic gate; it does not by itself prove a reusable lesson. Evaluate the completed experience independently.
`
}

function buildValidationPrompt({
  exp,
  candidates,
  proposal,
  deterministicValidation
}: {
  exp: ExperienceSnapshot
  candidates: Candidate[]
  proposal: Proposal
  deterministicValidation: Validation
}): string {
  return `Independently validate this proposed learned-skill change against the evidence.

## Completed experience

\`\`\`json
${JSON.stringify(trajectoryPayload(exp), null, 2)}
\`\`\`

## Candidate skills

\`\`\`json
${JSON.stringify(candidatesPayload(candidates), null, 2)}
\`\`\`

## Proposal

\`\`\`json
${JSON.stringify(proposal, null, 2)}
\`\`\`

## Deterministic validation

\`\`\`json
${JSON.stringify(deterministicValidation, null, 2)}
\`\`\`

Call learning_submit_validation exactly once. Reject unsupported generalization.`
}

function isReviewSessionUnavailable(
  sessionID: string,
  isDisposed: boolean,
  mailbox: InternalMailbox
): boolean {
  return sessionID.length === 0 || isDisposed || mailbox.isInternalSession(sessionID)
}

function queuePendingReview(
  pendingReviews: Map<string, ReviewRequest>,
  sessionID: string,
  isForced: boolean,
  terminalType: string
): void {
  const pending = pendingReviews.get(sessionID) ?? { force: false, terminalType }
  pending.force ||= isForced
  pending.terminalType = terminalType
  pendingReviews.set(sessionID, pending)
}

function canStartReview({
  sessionID,
  isDisposed,
  isEnabled,
  inFlight,
  mailbox
}: {
  sessionID: string
  isDisposed: boolean
  isEnabled: boolean
  inFlight: Set<string>
  mailbox: InternalMailbox
}): boolean {
  return (
    !isReviewSessionUnavailable(sessionID, isDisposed, mailbox) &&
    isEnabled &&
    !inFlight.has(sessionID)
  )
}

type TriggerEvaluation = { decision: string; score: number; strongSignals: string[] }

function recordTriggerEvaluationSafely(telemetry: Telemetry, evaluation: TriggerEvaluation): void {
  void telemetry.recordTriggerEvaluation(evaluation).catch((error: unknown) => {
    console.error('[opencode-learning] trigger telemetry failed', error)
  })
}

function isDuplicateFingerprint({
  sessionID,
  candidate,
  reviewedFingerprints,
  lastSuppressedFingerprint,
  telemetry
}: {
  sessionID: string
  candidate: TriggerDecision
  reviewedFingerprints: Map<string, Map<string, string>>
  lastSuppressedFingerprint: Map<string, string>
  telemetry: Telemetry
}): boolean {
  const reviewed = reviewedFingerprints.get(sessionID)
  if (!reviewed?.has(candidate.fingerprint)) {
    return false
  }

  if (lastSuppressedFingerprint.get(sessionID) !== candidate.fingerprint) {
    lastSuppressedFingerprint.set(sessionID, candidate.fingerprint)
    recordTriggerEvaluationSafely(telemetry, {
      decision: 'duplicate-fingerprint',
      score: candidate.score,
      strongSignals: candidate.strongSignals
    })
  }

  return true
}

function isWorkflowOnCooldown(
  sessionID: string,
  successfulTurns: Map<string, number>,
  lastAutomaticReviewTurn: Map<string, number>,
  cooldownTurns: number
): boolean {
  const turnsSinceReview =
    (successfulTurns.get(sessionID) ?? 0) - (lastAutomaticReviewTurn.get(sessionID) ?? 0)
  return turnsSinceReview < cooldownTurns
}

function shouldDeferWorkflowReview({
  sessionID,
  candidate,
  successfulTurns,
  lastAutomaticReviewTurn,
  workflowCooldownTurns,
  telemetry
}: {
  sessionID: string
  candidate: TriggerDecision
  successfulTurns: Map<string, number>
  lastAutomaticReviewTurn: Map<string, number>
  workflowCooldownTurns: number
  telemetry: Telemetry
}): boolean {
  if (
    !candidate.workflowOnly ||
    !isWorkflowOnCooldown(
      sessionID,
      successfulTurns,
      lastAutomaticReviewTurn,
      workflowCooldownTurns
    )
  ) {
    return false
  }

  recordTriggerEvaluationSafely(telemetry, {
    decision: 'workflow-cooldown',
    score: candidate.score,
    strongSignals: candidate.strongSignals
  })
  return true
}

function isIneligibleCandidate(candidate: TriggerDecision, telemetry: Telemetry): boolean {
  if (candidate.eligible) {
    return false
  }

  recordTriggerEvaluationSafely(telemetry, {
    decision: candidate.score < candidate.threshold ? 'below-threshold' : 'missing-strong-signal',
    score: candidate.score,
    strongSignals: candidate.strongSignals
  })
  return true
}

function evaluateAutomaticReview({
  sessionID,
  exp,
  scoreThreshold,
  workflowCooldownTurns,
  successfulTurns,
  lastAutomaticReviewTurn,
  reviewedFingerprints,
  lastSuppressedFingerprint,
  telemetry
}: {
  sessionID: string
  exp: ExperienceSnapshot
  scoreThreshold: number
  workflowCooldownTurns: number
  successfulTurns: Map<string, number>
  lastAutomaticReviewTurn: Map<string, number>
  reviewedFingerprints: Map<string, Map<string, string>>
  lastSuppressedFingerprint: Map<string, string>
  telemetry: Telemetry
}): TriggerDecision | undefined {
  const features = deriveTriggerFeatures(exp)
  const candidate = scoreReviewCandidate(features, scoreThreshold)
  if (isIneligibleCandidate(candidate, telemetry)) {
    return undefined
  }

  if (
    isDuplicateFingerprint({
      [SESSION_ID_KEY]: sessionID,
      candidate,
      reviewedFingerprints,
      lastSuppressedFingerprint,
      telemetry
    })
  ) {
    return undefined
  }

  lastSuppressedFingerprint.delete(sessionID)
  if (
    shouldDeferWorkflowReview({
      [SESSION_ID_KEY]: sessionID,
      candidate,
      successfulTurns,
      lastAutomaticReviewTurn,
      workflowCooldownTurns,
      telemetry
    })
  ) {
    return undefined
  }

  recordTriggerEvaluationSafely(telemetry, {
    decision: 'review',
    score: candidate.score,
    strongSignals: candidate.strongSignals
  })
  return candidate
}

async function maybeValidateProposal({
  enabled,
  deterministic,
  proposal,
  directory,
  model,
  exp,
  candidates,
  validate
}: {
  enabled: boolean
  deterministic: Validation
  proposal: Proposal
  directory: string
  model: SessionInfo['model'] | undefined
  exp: ExperienceSnapshot
  candidates: Candidate[]
  validate: (options: {
    directory: string
    model: SessionInfo['model'] | undefined
    exp: ExperienceSnapshot
    candidates: Candidate[]
    proposal: Proposal
    deterministic: Validation
  }) => Promise<ValidationSubmission>
}): Promise<ValidationSubmission> {
  if (!enabled || !deterministic.ok || proposal.decision === 'none') {
    return {
      decision: 'accept',
      reason: 'agent validation disabled',
      warnings: []
    }
  }

  return validate({ directory, model, exp, candidates, proposal, deterministic })
}

function reviewValidation(
  deterministic: Validation,
  proposal: Proposal,
  agent: ValidationSubmission
): ReviewValidation {
  return {
    deterministic,
    agent,
    ok: deterministic.ok && (proposal.decision === 'none' || agent.decision === 'accept')
  }
}

type ReviewScore =
  | {
      score: number
      threshold: number
      reasons: TriggerDecision['reasons']
      signals: TriggerDecision['strongSignals']
    }
  | undefined

function reviewScore(triggerDecision: TriggerDecision | undefined): ReviewScore {
  if (triggerDecision === undefined) {
    return undefined
  }

  return {
    score: triggerDecision.score,
    threshold: triggerDecision.threshold,
    reasons: triggerDecision.reasons,
    signals: triggerDecision.strongSignals
  }
}

async function retryReviewAttempt(
  run: () => Promise<ReviewAttempt>,
  shouldStop: () => boolean
): Promise<ReviewAttempt> {
  try {
    return await run()
  } catch (error) {
    if (shouldStop()) {
      throw error
    }

    return run()
  }
}

function createAutomaticReviewStart(telemetry: Telemetry, isForced: boolean): () => void {
  let hasStarted = false
  return () => {
    if (isForced || hasStarted) {
      return
    }

    hasStarted = true
    void telemetry.recordAutomaticReview().catch((error: unknown) => {
      console.error('[opencode-learning] automatic-review telemetry failed', error)
    })
  }
}

type ReviewFailureOptions = {
  telemetry: Telemetry
  ctx: OpenCodeContext
  sessionID: string
  terminalType: string
  force: boolean
  score: ReviewScore
  error: unknown
  notify: boolean
}
type ReviewErrorOptions = {
  sessionId: string
  terminalType: string
  force: boolean
  score: ReviewScore
  error: unknown
}

async function recordReviewFailure({
  telemetry,
  ctx,
  sessionID,
  terminalType,
  force,
  score,
  error,
  notify
}: ReviewFailureOptions): Promise<void> {
  await telemetry
    .recordReview({
      [SESSION_ID_KEY]: sessionID,
      trigger: force ? 'forced' : 'automatic',
      terminalType,
      score,
      decision: 'error',
      error: redactError(error)
    })
    .catch(() => undefined)
  if (!force) {
    await telemetry.recordTriggerOutcome('error').catch(console.error)
  }

  if (force && notify) {
    await notifySession(ctx, sessionID, `[opencode-learning] Review failed: ${redactError(error)}`)
  }
}

type ReviewResultOptions = {
  ctx: OpenCodeContext
  store: SkillStore
  telemetry: Telemetry
  config: LearningConfig
  sessionID: string
  terminalType: string
  force: boolean
  score: ReviewScore
  triggerDecision: TriggerDecision | undefined
  proposal: Proposal
  validation: ReviewValidation
  recordFingerprint: (
    sessionID: string,
    triggerDecision: TriggerDecision | undefined,
    outcome: string
  ) => void
}

async function finishReview(options: ReviewResultOptions): Promise<ReviewOutcome> {
  const { proposal, validation } = options
  await recordReviewResult(options)
  if (!validation.ok || proposal.decision === 'none') {
    return finishNoChange(options)
  }

  if (options.config.mode === 'suggest') {
    return finishStaged(options)
  }

  return finishApplied(options)
}

async function recordReviewResult({
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

async function finishNoChange({
  ctx,
  telemetry,
  sessionID,
  force,
  config,
  score,
  triggerDecision,
  proposal,
  validation,
  recordFingerprint
}: ReviewResultOptions): Promise<ReviewOutcome> {
  if (force && config.notify) {
    await notifySession(
      ctx,
      sessionID,
      `[opencode-learning] Review completed with no applied change: ${summarizeNoChange(proposal, validation)}`
    )
  }

  recordFingerprint(sessionID, triggerDecision, 'no-change')
  if (!force) {
    await telemetry.recordTriggerOutcome('no-change').catch(console.error)
  }

  return { status: 'no-change', proposal, validation, score }
}

async function finishStaged({
  ctx,
  telemetry,
  sessionID,
  force,
  config,
  score,
  triggerDecision,
  proposal,
  validation,
  store,
  recordFingerprint
}: ReviewResultOptions): Promise<ReviewOutcome> {
  const staged = await store.stage(proposal, validation)
  if (force && config.notify) {
    await notifySession(
      ctx,
      sessionID,
      `[opencode-learning] Staged ${proposal.decision} proposal ${staged.id} for ${proposal.skillId}. Inspect with /learn-show ${staged.id} or /learn-pending.`
    )
  }

  recordFingerprint(sessionID, triggerDecision, 'accepted')
  if (!force) {
    await telemetry.recordTriggerOutcome('staged').catch(console.error)
  }

  return { status: 'staged', staged, proposal, validation, score }
}

async function finishApplied({
  ctx,
  telemetry,
  sessionID,
  force,
  config,
  score,
  triggerDecision,
  proposal,
  validation,
  store,
  recordFingerprint
}: ReviewResultOptions): Promise<ReviewOutcome> {
  const applied = await applyProposal(store, proposal)
  const skillId = proposal.skillId ?? ''
  if (proposal.decision === 'create') {
    await telemetry.recordCreated(skillId)
  } else {
    await telemetry.recordPatched(skillId)
  }

  await ctx.skill.reload()
  if (force && config.notify) {
    await notifySession(
      ctx,
      sessionID,
      `[opencode-learning] Applied ${proposal.decision} for learned skill ${proposal.skillId} and reloaded skills.`
    )
  }

  recordFingerprint(sessionID, triggerDecision, 'accepted')
  if (!force) {
    await telemetry.recordTriggerOutcome('applied').catch(console.error)
  }

  return { status: 'applied', applied, proposal, validation, score }
}

async function applyProposal(store: SkillStore, proposal: Proposal): Promise<unknown> {
  if (proposal.decision === 'create') {
    return store.create(proposal, { scope: proposal.scope })
  }

  return store.patch(proposal, { scope: proposal.scope })
}

export class ReviewPipeline {
  private readonly ctx: OpenCodeContext
  private readonly recorder: ExperienceRecorder
  private readonly store: SkillStore
  private readonly telemetry: Telemetry
  private readonly mailbox: InternalMailbox
  private readonly config: LearningConfig
  private readonly inFlight = new Set<string>()
  private readonly requests = new Map<string, ReviewRequest>()
  private readonly pending = new Map<string, ReviewRequest>()
  private disposed = false
  private readonly lastAutomaticReviewTurn = new Map<string, number>()
  private readonly successfulTurns = new Map<string, number>()
  private readonly reviewedFingerprints = new Map<string, Map<string, string>>()
  private readonly lastSuppressedFingerprint = new Map<string, string>()
  private readonly activeReviews = new Set<Promise<unknown>>()

  constructor({ ctx, recorder, store, telemetry, mailbox, config }: ReviewPipelineOptions) {
    this.ctx = ctx
    this.recorder = recorder
    this.store = store
    this.telemetry = telemetry
    this.mailbox = mailbox
    this.config = config
  }

  captureReview(sessionID: string, isForced: boolean): PreparedReview | undefined {
    const exp = this.recorder.snapshot(sessionID)
    if (exp === undefined) {
      return undefined
    }

    const candidate = isForced
      ? undefined
      : evaluateAutomaticReview({
          [SESSION_ID_KEY]: sessionID,
          exp,
          scoreThreshold: this.config.scoreThreshold,
          workflowCooldownTurns: this.config.workflowCooldownTurns,
          successfulTurns: this.successfulTurns,
          lastAutomaticReviewTurn: this.lastAutomaticReviewTurn,
          reviewedFingerprints: this.reviewedFingerprints,
          lastSuppressedFingerprint: this.lastSuppressedFingerprint,
          telemetry: this.telemetry
        })
    if (!isForced && candidate === undefined) {
      return undefined
    }

    const batch = this.recorder.take(sessionID)
    return batch === undefined ? undefined : { batch, candidate }
  }

  schedule(sessionID: string, { force = false }: { force?: boolean } = {}): UnknownRecord {
    if (sessionID.length === 0 || this.disposed || this.mailbox.isInternalSession(sessionID)) {
      return { scheduled: false, force, reason: 'session is not eligible for review' }
    }

    const request = this.requests.get(sessionID) ?? { force: false }
    request.force ||= force
    this.requests.set(sessionID, request)
    return { scheduled: true, force: request.force }
  }

  executionFinished(
    sessionID: string,
    { terminalType = 'session.execution.succeeded' }: { terminalType?: string } = {}
  ): void {
    if (isReviewSessionUnavailable(sessionID, this.disposed, this.mailbox)) {
      return
    }

    const isSucceeded = terminalType === 'session.execution.succeeded'
    if (isSucceeded) {
      this.successfulTurns.set(sessionID, (this.successfulTurns.get(sessionID) ?? 0) + 1)
      void this.telemetry.recordSuccessfulTurn().catch((error: unknown) => {
        console.error('[opencode-learning] successful-turn telemetry failed', error)
      })
    }

    const request = this.requests.get(sessionID)
    const isForce = Boolean(request?.force)
    this.requests.delete(sessionID)
    if (!isForce && !isSucceeded) {
      return
    }

    if (this.inFlight.has(sessionID)) {
      queuePendingReview(this.pending, sessionID, isForce, terminalType)
      return
    }

    this.start(sessionID, { force: isForce, terminalType })
  }

  start(
    sessionID: string,
    { force = false, terminalType = 'session.execution.succeeded' }: ReviewOptions = {}
  ): void {
    if (
      !canStartReview({
        [SESSION_ID_KEY]: sessionID,
        isDisposed: this.disposed,
        isEnabled: this.config.enabled,
        inFlight: this.inFlight,
        mailbox: this.mailbox
      })
    ) {
      return
    }

    const prepared = this.captureReview(sessionID, force)
    if (prepared === undefined) {
      return
    }

    const { batch, candidate } = prepared

    this.inFlight.add(sessionID)
    if (!force) {
      this.lastAutomaticReviewTurn.set(sessionID, this.successfulTurns.get(sessionID) ?? 0)
    }

    const review = this.reviewWithRetry(sessionID, batch, {
      force,
      terminalType,
      triggerDecision: candidate
    })
      .catch((error: unknown) => {
        console.error('[opencode-learning] review failed', error)
      })
      .finally(() => {
        this.inFlight.delete(sessionID)
        this.drain(sessionID)
      })
    this.activeReviews.add(review)
    void review
      .then(() => {
        this.activeReviews.delete(review)
      })
      .catch(() => {
        this.activeReviews.delete(review)
      })
  }

  drain(sessionID: string): void {
    if (this.disposed || this.inFlight.has(sessionID)) {
      return
    }

    const pending = this.pending.get(sessionID)
    if (!pending) {
      return
    }

    this.pending.delete(sessionID)
    this.start(sessionID, pending)
  }

  async reviewAttempt(
    sessionID: string,
    exp: ExperienceSnapshot,
    { triggerDecision, onReflectorStart }: ReviewAttemptOptions = {}
  ): Promise<ReviewAttempt> {
    const parent = await this.ctx.session.get({ [SESSION_ID_KEY]: sessionID })
    const directory = parent?.location?.directory ?? this.store.projectRoot
    const model = parent?.model
    const candidates = await retrieveCandidates({
      ctx: this.ctx,
      exp,
      store: this.store,
      maxCandidates: this.config.maxCandidates
    })
    const proposal = normalizeCreateProposal(
      await this.runReflector({
        directory,
        model,
        exp,
        candidates,
        triggerDecision,
        onReflectorStart
      })
    )
    proposal.scope = 'project'
    const deterministic = validateProposal(proposal, {
      confidenceThreshold: this.config.confidenceThreshold
    })
    const agentValidation = await maybeValidateProposal({
      enabled: this.config.agentValidation,
      deterministic,
      proposal,
      directory,
      model,
      exp,
      candidates,
      validate: async (options) => this.runValidator(options)
    })

    if (this.disposed) {
      throw new Error('learning pipeline was disposed during review')
    }

    return { proposal, validation: reviewValidation(deterministic, proposal, agentValidation) }
  }

  async runReviewAttempts(
    sessionID: string,
    exp: ExperienceSnapshot,
    options: ReviewAttemptOptions
  ): Promise<ReviewAttempt> {
    return retryReviewAttempt(
      async () => this.reviewAttempt(sessionID, exp, options),
      () => this.disposed
    )
  }

  async reviewWithRetry(
    sessionID: string,
    exp: ExperienceSnapshot,
    {
      force = false,
      terminalType = 'session.execution.succeeded',
      triggerDecision
    }: ReviewOptions = {}
  ): Promise<ReviewOutcome> {
    if (this.disposed || !this.config.enabled || this.mailbox.isInternalSession(sessionID)) {
      return { status: 'skipped' }
    }

    const score = reviewScore(triggerDecision)
    const onReflectorStart = createAutomaticReviewStart(this.telemetry, force)
    await this.telemetry.recordExperience(exp).catch((error: unknown) => {
      console.error('[opencode-learning] telemetry recordExperience failed', error)
    })
    try {
      const attempt = await this.runReviewAttempts(sessionID, exp, {
        force,
        terminalType,
        triggerDecision,
        onReflectorStart
      })
      if (this.disposed) {
        return { status: 'disposed' }
      }

      return await finishReview({
        ctx: this.ctx,
        store: this.store,
        telemetry: this.telemetry,
        config: this.config,
        [SESSION_ID_KEY]: sessionID,
        terminalType,
        force,
        score,
        triggerDecision,
        proposal: attempt.proposal,
        validation: attempt.validation,
        recordFingerprint: (id, decision, outcome) => {
          this.recordFingerprint(id, decision, outcome)
        }
      })
    } catch (error) {
      return this.handleReviewError({ sessionId: sessionID, terminalType, force, score, error })
    }
  }

  async handleReviewError({
    sessionId,
    terminalType,
    force,
    score,
    error
  }: ReviewErrorOptions): Promise<ReviewOutcome> {
    if (this.disposed) {
      return { status: 'disposed' }
    }

    await recordReviewFailure({
      telemetry: this.telemetry,
      ctx: this.ctx,
      [SESSION_ID_KEY]: sessionId,
      terminalType,
      force,
      score,
      error,
      notify: this.config.notify
    })
    throw error
  }

  recordFingerprint(
    sessionID: string,
    triggerDecision: TriggerDecision | undefined,
    outcome: string
  ): void {
    if (triggerDecision === undefined || triggerDecision.fingerprint.length === 0) {
      return
    }

    let reviewed = this.reviewedFingerprints.get(sessionID)
    if (!reviewed) {
      reviewed = new Map()
      this.reviewedFingerprints.set(sessionID, reviewed)
    }

    reviewed.set(triggerDecision.fingerprint, outcome)
  }

  async runReflector({
    directory,
    model,
    exp,
    candidates,
    triggerDecision,
    onReflectorStart
  }: {
    directory: string
    model?: SessionInfo['model']
    exp: ExperienceSnapshot
    candidates: Candidate[]
    triggerDecision?: TriggerDecision
    onReflectorStart?: () => void
  }): Promise<Proposal> {
    onReflectorStart?.()
    const session = await createReviewSession(this.ctx, {
      directory,
      model,
      agent: this.config.reflectorAgent,
      title: 'Procedural skill reflection'
    })
    const { id } = session
    if (id.length === 0) {
      throw new Error('OpenCode did not return a reflector session id')
    }

    this.mailbox.register(id, 'proposal')
    try {
      const callback = this.mailbox.wait<Proposal>(id, this.config.reviewerTimeoutMs)
      void callback.catch(() => undefined)
      await promptSession(this.ctx, id, buildReviewPrompt({ exp, candidates, triggerDecision }))
      const proposal = await callback
      if (!this.mailbox.hasSubmitted(id)) {
        throw new Error('reflector finished without submitting a proposal')
      }

      return proposal
    } finally {
      this.mailbox.release(id)
      await interruptSession(this.ctx, id)
    }
  }

  async runValidator({
    directory,
    model,
    exp,
    candidates,
    proposal,
    deterministic
  }: {
    directory: string
    model?: SessionInfo['model']
    exp: ExperienceSnapshot
    candidates: Candidate[]
    proposal: Proposal
    deterministic: Validation
  }): Promise<ValidationSubmission> {
    const session = await createReviewSession(this.ctx, {
      directory,
      model,
      agent: this.config.validatorAgent,
      title: 'Procedural skill validation'
    })
    const { id } = session
    if (id.length === 0) {
      throw new Error('OpenCode did not return a validator session id')
    }

    this.mailbox.register(id, 'validation')
    try {
      const callback = this.mailbox.wait<ValidationSubmission>(id, this.config.reviewerTimeoutMs)
      void callback.catch(() => undefined)
      await promptSession(
        this.ctx,
        id,
        buildValidationPrompt({ exp, candidates, proposal, deterministicValidation: deterministic })
      )
      const validation = await callback
      if (!this.mailbox.hasSubmitted(id)) {
        throw new Error('validator finished without submitting a validation')
      }

      return validation
    } finally {
      this.mailbox.release(id)
      await interruptSession(this.ctx, id)
    }
  }

  async cleanup(): Promise<void> {
    this.disposed = true
    this.requests.clear()
    this.pending.clear()
    this.lastAutomaticReviewTurn.clear()
    this.successfulTurns.clear()
    this.reviewedFingerprints.clear()
    this.lastSuppressedFingerprint.clear()
  }

  async waitForReviews(): Promise<void> {
    await Promise.allSettled(this.activeReviews)
    this.activeReviews.clear()
  }
}

function summarizeNoChange(proposal: Proposal, validation: ReviewValidation): string {
  if (proposal?.decision === 'none') {
    const { reason } = proposal
    return reason === undefined || reason.length === 0 ? 'nothing durable was found' : reason
  }

  if (!validation?.deterministic?.ok) {
    return validation.deterministic.errors.join('; ')
  }

  return validation.agent?.decision === 'reject' ? validation.agent.reason : 'no durable change'
}

export class Curator {
  private readonly config: LearningConfig
  private readonly store: SkillStore
  private readonly telemetry: Telemetry
  private readonly stateFile: string

  constructor({
    config,
    store,
    telemetry
  }: {
    config: LearningConfig
    store: SkillStore
    telemetry: Telemetry
  }) {
    this.config = config
    this.store = store
    this.telemetry = telemetry
    this.stateFile = path.join(store.stateRoot, 'curator.json')
  }

  async maybeRun({ force = false }: { force?: boolean } = {}): Promise<CuratorResult> {
    if (!this.config.curator.enabled) {
      return { skipped: 'disabled' }
    }

    const state = await readJson(this.stateFile, { lastRunAt: 0 })
    const hours = (Date.now() - state.lastRunAt) / 36e5
    if (!force && state.lastRunAt > 0 && hours < this.config.curator.checkEveryHours) {
      return { skipped: 'interval' }
    }

    const curationResult = await this.run()
    await writeJson(this.stateFile, { lastRunAt: Date.now(), result: curationResult })
    return curationResult
  }

  async run(): Promise<{ stale: string[]; archived: string[] }> {
    const owned = await this.store.listOwned('project')
    const states = await Promise.all(
      owned.map(async (item) =>
        curateOwnedSkill(this.store, this.telemetry, item, this.config.curator)
      )
    )
    const archived = states.flatMap((state) => (state.state === 'archived' ? [state.id] : []))
    const stale = states.flatMap((state) => (state.state === 'stale' ? [state.id] : []))

    await this.telemetry.flush()
    return { stale, archived }
  }
}

async function curateOwnedSkill(
  store: SkillStore,
  telemetry: Telemetry,
  item: OwnedSkill,
  config: CuratorConfig
): Promise<{ id: string; state: 'archived' | 'stale' | 'active' | undefined }> {
  const meta = telemetry.state.skills[item.skillId]
  const last = meta?.updatedAt ?? meta?.createdAt ?? Date.now()
  const age = daysSince(last)
  if (age >= config.archiveAfterDays) {
    return archiveOwnedSkill(store, meta, item.skillId)
  }

  if (age >= config.staleAfterDays) {
    if (meta !== undefined) {
      meta.state = 'stale'
    }

    return { id: item.skillId, state: 'stale' }
  }

  if (meta !== undefined) {
    meta.state = 'active'
  }

  return { id: item.skillId, state: 'active' }
}

async function archiveOwnedSkill(
  store: SkillStore,
  meta: SkillTelemetry | undefined,
  skillId: string
): Promise<{ id: string; state: 'archived' | 'stale' | 'active' | undefined }> {
  const isArchived = await store.archive(skillId, { scope: 'project' })
  if (!isArchived) {
    return { id: skillId, state: undefined }
  }

  if (meta !== undefined) {
    meta.state = 'archived'
  }

  return { id: skillId, state: 'archived' }
}
