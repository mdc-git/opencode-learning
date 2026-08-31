import type { Experience, TurnRecord } from './scoring-types.ts'
import { turnKey, turnValue } from './scoring-corrections.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function firstTurnStatus(turn: Record<string, unknown>): unknown {
  if (turn.succeeded !== undefined) {
    return turn.succeeded
  }

  return turn.success
}

function terminalTurnStatus(turn: Record<string, unknown>): boolean | undefined {
  if (typeof turn.status === 'string') {
    return turn.status === 'success'
  }

  if (typeof turn.terminalType === 'string') {
    return turn.terminalType === 'session.execution.succeeded'
  }

  return undefined
}

function completedTurnSuccessValue(turn: Record<string, unknown>): boolean | undefined {
  const status = firstTurnStatus(turn)
  if (status !== undefined) {
    return status === true
  }

  return terminalTurnStatus(turn)
}

function isCompletedTurnSucceeded(turn: TurnRecord): boolean {
  const value = isRecord(turn) ? completedTurnSuccessValue(turn) : undefined
  return value ?? false
}

function turnSource(experience: Experience): TurnRecord[] {
  if (Array.isArray(experience?.turns) && experience.turns.length > 0) {
    return experience.turns
  }

  return Array.isArray(experience?.completedTurns) ? experience.completedTurns : []
}

function addTurnState(states: Map<string, boolean>, item: TurnRecord): void {
  const key = turnKey(turnValue(item))
  if (key === undefined) {
    return
  }

  const previous = states.get(key)
  const isSucceeded = isCompletedTurnSucceeded(item)
  states.set(key, previous === undefined ? isSucceeded : previous && isSucceeded)
}

export function turnStates(experience: Experience): { states: Map<string, boolean> } {
  const source = turnSource(experience)
  const states = new Map<string, boolean>()
  for (const item of source) {
    addTurnState(states, item)
  }

  return { states }
}

export function isSuccessfulTurn(
  key: string | undefined,
  state: { states: Map<string, boolean> }
): boolean {
  return key !== undefined && state.states.get(key) === true
}
