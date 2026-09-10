import fs from 'node:fs/promises'
import path from 'node:path'
import type { FileManifest } from './skill-tree.ts'
import { hasOwnership, skillDescription } from './skill-markdown.ts'
import type { Store } from './store.ts'

export type Candidate = {
  id: string
  description: string
  markdown: string
  manifest: FileManifest[]
  revision: string
}

async function candidateFor(store: Store, name: string): Promise<Candidate | undefined> {
  const root = path.join(store.projectSkills, name)
  try {
    const markdown = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8')
    if (!hasOwnership(markdown)) {
      return undefined
    }

    const scan = await store.validateTree(root, true)
    return {
      id: name,
      description: skillDescription(markdown),
      markdown,
      manifest: scan.files,
      revision: scan.revision
    }
  } catch {
    return undefined
  }
}

export async function ownedCandidates(store: Store): Promise<Candidate[]> {
  await fs.mkdir(store.projectSkills, { recursive: true })
  const entries = await fs.readdir(store.projectSkills, { withFileTypes: true })
  const names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  const candidates = await Promise.all(names.map(async (name) => candidateFor(store, name)))
  return candidates
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .toSorted((left, right) => left.id.localeCompare(right.id))
}

function tokens(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^0-9a-z]+/v)
    .filter((item) => item.length > 2)
  return new Set(words)
}

type CandidateScore = { candidate: Candidate; explicit: boolean; overlap: number }

function scoreCandidate(candidate: Candidate, text: string, words: Set<string>): CandidateScore {
  const overlap = [...tokens(`${candidate.id} ${candidate.description}`)].filter((word) =>
    words.has(word)
  ).length
  return { candidate, explicit: text.includes(candidate.id), overlap }
}

function compareScore(left: CandidateScore, right: CandidateScore): number {
  if (left.explicit !== right.explicit) {
    return left.explicit ? -1 : 1
  }

  if (left.overlap !== right.overlap) {
    return right.overlap - left.overlap
  }

  return left.candidate.id.localeCompare(right.candidate.id)
}

export function selectCandidates(
  all: Candidate[],
  evidence: { records: unknown[] }
): Candidate[] {
  const text = JSON.stringify(evidence.records)
  const words = tokens(text)
  return all
    .map((candidate) => scoreCandidate(candidate, text, words))
    .filter((item) => item.explicit || item.overlap > 0)
    .toSorted(compareScore)
    .slice(0, 5)
    .map((item) => item.candidate)
}

export function catalog(candidates: Candidate[]) {
  return candidates.map(({ id, description }) => ({ id, description }))
}

export function candidatePacket(candidates: Candidate[]) {
  return candidates.map((candidate) => ({
    id: candidate.id,
    description: candidate.description,
    skillMd: candidate.markdown,
    revision: candidate.revision,
    files: candidate.manifest.filter((file) => file.path !== 'SKILL.md')
  }))
}
