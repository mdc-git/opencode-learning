import { Rpc } from '@opencode/plugin/rpc'
import { Schema } from 'effect'

const proposalKindSchema = Schema.Literals(['create', 'patch'])
const reviewStatusSchema = Schema.Literals(['none', 'rejected', 'cap', 'staged'])
const activityKindSchema = Schema.Literals([
  'reviewer-started',
  'reviewer-result',
  'validator-started',
  'validator-result',
  'proposal-staged',
  'pending-limit'
])

const pendingProposalSchema = Schema.Struct({
  id: Schema.String,
  kind: proposalKindSchema,
  skillId: Schema.String,
  reason: Schema.String,
  invalid: Schema.Boolean
})
const fileManifestSchema = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  executable: Schema.Boolean,
  hash: Schema.String
})
const pendingDetailSchema = Schema.Struct({
  id: Schema.String,
  kind: proposalKindSchema,
  skillId: Schema.String,
  reason: Schema.String,
  invalid: Schema.Boolean,
  stale: Schema.Boolean,
  files: Schema.Array(Schema.String),
  manifest: Schema.Array(fileManifestSchema),
  markdown: Schema.String,
  evidence: Schema.String
})
const reviewResultSchema = Schema.Struct({
  status: reviewStatusSchema,
  message: Schema.String,
  proposalId: Schema.String,
  skillId: Schema.String
})
const activitySchema = Schema.Struct({
  kind: activityKindSchema,
  sessionId: Schema.String,
  message: Schema.String
})
const sessionInput = Schema.Struct({ sessionId: Schema.String })
const proposalInput = Schema.Struct({ sessionId: Schema.String, id: Schema.String })
const promoteInput = Schema.Struct({ sessionId: Schema.String, skillId: Schema.String })

export type LearningActivity = typeof activitySchema.Type

export const LearningRpc = Rpc.define({
  id: 'github.learning_skills',
  methods: {
    review: { input: sessionInput, output: reviewResultSchema },
    pending: { input: sessionInput, output: Schema.Array(pendingProposalSchema) },
    proposal: { input: proposalInput, output: pendingDetailSchema },
    approve: {
      input: proposalInput,
      output: Schema.Struct({ skillId: Schema.String })
    },
    reject: { input: proposalInput, output: Schema.Struct({}) },
    promote: { input: promoteInput, output: Schema.Struct({}) }
  },
  events: {
    activity: { schema: activitySchema }
  }
})
