import { parseDocument } from 'yaml'

const OWNER_KEY = 'opencode-learning/owner'

type Mapping = Record<string, unknown>

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function frontmatterGroups(text: string): Record<string, string> {
  const match = /^---\r?\n(?<yaml>[\s\S]*?)\r?\n---\r?\n(?<body>[\s\S]*)$/v.exec(text)
  if (match?.groups === undefined) {
    throw new Error('SKILL.md requires YAML frontmatter')
  }

  return match.groups
}

function group(groups: Record<string, string>, key: string): string {
  const value = groups[key]
  return value === undefined ? '' : value
}

function frontmatterData(document: ReturnType<typeof parseDocument>): Mapping {
  if (document.errors.length > 0) {
    throw new Error(`invalid SKILL.md frontmatter: ${document.errors[0]?.message}`)
  }

  const data = document.toJS() as unknown
  if (!isMapping(data)) {
    throw new TypeError('skill frontmatter must be a mapping')
  }

  return data
}

function skillDocument(text: string) {
  const groups = frontmatterGroups(text)
  const document = parseDocument(group(groups, 'yaml'))
  return {
    document,
    data: frontmatterData(document),
    body: group(groups, 'body')
  }
}

function requireDescription(data: Mapping): string {
  const { description } = data
  if (typeof description !== 'string' || description.trim() === '') {
    throw new Error('skill description is required')
  }

  return description
}

export function addOwnership(text: string): string {
  const { document, data, body } = skillDocument(text)
  requireDescription(data)
  const current = data.metadata
  const metadata = isMapping(current) ? current : {}
  document.set('metadata', { ...metadata, [OWNER_KEY]: 'true' })
  return `---\n${String(document).trimEnd()}\n---\n${body}`
}

export function skillDescription(text: string): string {
  return requireDescription(skillDocument(text).data)
}

export function hasOwnership(text: string): boolean {
  const { data } = skillDocument(text)
  requireDescription(data)
  return isMapping(data.metadata) && data.metadata[OWNER_KEY] === 'true'
}
