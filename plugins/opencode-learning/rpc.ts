import { Rpc } from '@opencode/plugin/rpc'
import { z } from 'zod'

const proposalKindSchema = z.enum(['create', 'patch'])
const reviewStatusSchema = z.enum(['none', 'rejected', 'cap', 'staged'])
const activityKindSchema = z.enum([
  'reviewer-started',
  'reviewer-result',
  'validator-started',
  'validator-result',
  'proposal-staged',
  'review-failed',
  'review-skipped',
  'pending-limit'
])

const pendingProposalSchema = z
  .object({
    id: z.string(),
    kind: proposalKindSchema,
    skillId: z.string(),
    reason: z.string(),
    invalid: z.boolean()
  })
  .strict()
const fileManifestSchema = z
  .object({
    path: z.string(),
    size: z.number(),
    executable: z.boolean(),
    hash: z.string()
  })
  .strict()
const pendingDetailSchema = z
  .object({
    id: z.string(),
    kind: proposalKindSchema,
    skillId: z.string(),
    reason: z.string(),
    invalid: z.boolean(),
    stale: z.boolean(),
    files: z.array(z.string()),
    manifest: z.array(fileManifestSchema),
    markdown: z.string(),
    evidence: z.string()
  })
  .strict()
const reviewResultSchema = z
  .object({
    status: reviewStatusSchema,
    message: z.string(),
    proposalId: z.string(),
    skillId: z.string()
  })
  .strict()
const activitySchema = z
  .object({
    kind: activityKindSchema,
    sessionId: z.string(),
    message: z.string()
  })
  .strict()
const sessionInput = z.object({ sessionId: z.string() }).strict()
const proposalInput = z.object({ sessionId: z.string(), id: z.string() }).strict()
const promoteInput = z.object({ sessionId: z.string(), skillId: z.string() }).strict()
const emptyOutput = z.object({}).strict()
const failureSchema = z.object({ message: z.string() }).strict()
const methodErrors = { failure: failureSchema }

export type LearningActivity = z.infer<typeof activitySchema>

export const learningRpc = Rpc.define({
  id: 'github.learning_skills',
  methods: {
    review: { input: sessionInput, output: reviewResultSchema, errors: methodErrors },
    pending: { input: sessionInput, output: z.array(pendingProposalSchema), errors: methodErrors },
    proposal: { input: proposalInput, output: pendingDetailSchema, errors: methodErrors },
    approve: {
      input: proposalInput,
      output: z.object({ skillId: z.string() }).strict(),
      errors: methodErrors
    },
    reject: { input: proposalInput, output: emptyOutput, errors: methodErrors },
    promote: { input: promoteInput, output: emptyOutput, errors: methodErrors }
  },
  events: {
    activity: { schema: activitySchema }
  }
})
