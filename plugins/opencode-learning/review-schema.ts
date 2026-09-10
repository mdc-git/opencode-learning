import { Schema } from 'effect'

const {
  Array: arraySchema,
  Boolean: booleanSchema,
  Literals: literals,
  String: stringSchema,
  Struct: struct,
  Union: union
} = Schema

const generatedFileSchema = struct({
  path: stringSchema,
  content: stringSchema,
  executable: booleanSchema
})
const projectSourceSchema = struct({ from: literals(['project']), path: stringSchema })
const candidateSourceSchema = struct({ from: literals(['candidate']), path: stringSchema })
const sourceFileSchema = struct({
  path: stringSchema,
  source: union([projectSourceSchema, candidateSourceSchema])
})
const proposedSkillSchema = struct({
  skillMd: stringSchema,
  files: arraySchema(union([generatedFileSchema, sourceFileSchema]))
})
const reflectionSchema = union([
  struct({ kind: literals(['none']), reason: stringSchema }),
  struct({
    kind: literals(['create']),
    skillId: stringSchema,
    reason: stringSchema,
    skill: proposedSkillSchema
  }),
  struct({
    kind: literals(['patch']),
    skillId: stringSchema,
    reason: stringSchema,
    skill: proposedSkillSchema
  })
])
const validationSchema = struct({ accept: booleanSchema, reason: stringSchema })

export type Reflection = typeof reflectionSchema.Type
export type ActiveReflection = Extract<Reflection, { kind: 'create' | 'patch' }>
export type Validation = typeof validationSchema.Type

export function decodeReflection(text: string): Reflection {
  return Schema.decodeUnknownSync(reflectionSchema)(JSON.parse(text))
}

export function decodeValidation(text: string): Validation {
  return Schema.decodeUnknownSync(validationSchema)(JSON.parse(text))
}
