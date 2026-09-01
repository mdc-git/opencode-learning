import { isSafeId, trimText } from './shared.ts'
import type { OpenCodeContext, SkillInfo } from './sdk.ts'
import type { Candidate, ExperienceSnapshot, Proposal, UnknownRecord, Validation } from './types.ts'
import type { SkillStore } from './store.ts'
import type { TriggerDecision } from './scoring.ts'

async function listSkills(ctx: OpenCodeContext): Promise<readonly SkillInfo[]> {
  try {
    const response = await ctx.skill.list()
    return response.data ?? []
  } catch {
    return []
  }
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

  const hits = sharedTokenCount(tokensA, tokensB)

  return hits / Math.sqrt(tokensA.size * tokensB.size)
}

function sharedTokenCount(first: Set<string>, second: Set<string>): number {
  let hits = 0
  for (const item of first) {
    if (second.has(item)) {
      hits++
    }
  }

  return hits
}

function reviewQuery(exp: ExperienceSnapshot): string {
  return [
    exp.goal,
    ...exp.contextTail.map((x) => x.text),
    ...exp.toolCalls
      .slice(-16)
      .map((x) => `${trimText(x.tool, 4e3)} ${trimText(x.input, 4e3)} ${trimText(x.result, 4e3)}`)
  ].join('\n')
}

export async function retrieveCandidates({
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
  const catalog = await listSkills(ctx)

  const query = reviewQuery(exp)
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
      const owned = isSafeId(item.id) ? await store.getOwned(item.id, 'project') : undefined
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
    contextTail: exp.contextTail.slice(-8),
    corrections: exp.corrections.slice(-10),
    skillsUsed: exp.skillsUsed,
    recoveries: exp.recoveries,
    verificationSteps: exp.verificationSteps,
    toolCalls: exp.toolCalls.slice(-50)
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

export function buildReviewPrompt({
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

  const { reasons } = triggerDecision
  const reasonText = Object.entries(reasons)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join('\n')
  const reasonLines = reasonText.length > 0 ? reasonText : '- (none)'
  const signalText = triggerDecision.strongSignals.join(', ')
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

export function buildValidationPrompt({
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
