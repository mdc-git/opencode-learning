export const proposalInputSchema = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['none', 'create', 'patch'] },
    skillId: {
      type: 'string',
      description:
        'Lowercase kebab-case skill ID, 1-64 characters. Required for create and patch decisions.'
    },
    scope: { type: 'string', enum: ['project', 'global'] },
    reason: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    evidence: { type: 'array', items: { type: 'string' } },
    expectedSha256: { type: 'string' },
    skill: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        body: { type: 'string' },
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, content: { type: 'string' } },
            required: ['path', 'content'],
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['replace_section', 'append_section'] },
          heading: { type: 'string' },
          body: { type: 'string' }
        },
        required: ['kind', 'heading', 'body'],
        additionalProperties: false
      }
    },
    addFiles: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
        additionalProperties: false
      }
    }
  },
  required: ['decision', 'reason', 'confidence', 'evidence'],
  additionalProperties: false
}

export const validationInputSchema = {
  type: 'object',
  properties: {
    decision: { type: 'string', enum: ['accept', 'reject'] },
    reason: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } }
  },
  required: ['decision', 'reason', 'warnings'],
  additionalProperties: false
}
