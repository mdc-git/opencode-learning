import { Plugin } from '@opencode-ai/plugin/tui'
import type { Context } from '@opencode-ai/plugin/tui/context'
import {
  REFLECTOR_SESSION_TITLE,
  REVIEW_SESSION_TITLE_PREFIX,
  SESSION_ID_KEY,
  VALIDATOR_SESSION_TITLE
} from './types.ts'

type TuiClient = Context['client']
type ReviewSession = Awaited<ReturnType<TuiClient['session']['get']>>

const REVIEW_SESSION_TITLES = new Set([REFLECTOR_SESSION_TITLE, VALIDATOR_SESSION_TITLE])

function isReviewSession(session: ReviewSession): boolean {
  return session.parentID === undefined && REVIEW_SESSION_TITLES.has(session.title ?? '')
}

async function removeReviewSession(
  client: TuiClient,
  sessionID: string,
  handled: Set<string>
): Promise<void> {
  if (handled.has(sessionID)) {
    return
  }

  handled.add(sessionID)
  try {
    const session = await client.session.get({ [SESSION_ID_KEY]: sessionID })
    if (isReviewSession(session)) {
      await client.session.remove({ [SESSION_ID_KEY]: sessionID })
    }
  } catch (error) {
    handled.delete(sessionID)
    console.error(`[opencode-learning] reviewer session cleanup failed for ${sessionID}`, error)
  }
}

type SessionListInput = NonNullable<Parameters<TuiClient['session']['list']>[0]>

function reviewSessionListInput(cursor?: string): SessionListInput {
  return {
    search: REVIEW_SESSION_TITLE_PREFIX,
    limit: 100,
    order: 'asc',
    cursor
  }
}

async function listReviewSessions(
  client: TuiClient,
  cursor?: string,
  sessions: ReviewSession[] = []
): Promise<ReviewSession[]> {
  const page = await client.session.list(reviewSessionListInput(cursor))
  const allSessions = [...sessions, ...page.data]
  const next = page.cursor.next ?? undefined
  return next === undefined ? allSessions : listReviewSessions(client, next, allSessions)
}

async function removeInactiveReviewSessions(
  client: TuiClient,
  reviewerSessions: Set<string>,
  remove: (sessionID: string) => Promise<void>
): Promise<void> {
  const [active, sessions] = await Promise.all([
    client.session.active(),
    listReviewSessions(client)
  ])
  const reviewSessions = sessions.filter((session) => isReviewSession(session))
  for (const session of reviewSessions) {
    reviewerSessions.add(session.id)
  }

  const inactiveSessionIds = reviewSessions
    .filter((session) => active[session.id] === undefined)
    .map((session) => session.id)
  await Promise.all(inactiveSessionIds.map(async (sessionID) => remove(sessionID)))
}

function registerCleanupListeners(
  context: Context,
  reviewerSessions: Set<string>,
  remove: (sessionID: string) => Promise<void>
): Array<() => void> {
  const trackCreated = (event: {
    data: { sessionID: string; parentID?: string; title?: string }
  }) => {
    if (event.data.parentID === undefined && REVIEW_SESSION_TITLES.has(event.data.title ?? '')) {
      reviewerSessions.add(event.data.sessionID)
    }
  }

  const removeFinished = (event: { data: { sessionID: string } }) => {
    if (!reviewerSessions.has(event.data.sessionID)) {
      return
    }

    void remove(event.data.sessionID)
  }

  const stopSynthetic = context.data.on('session.synthetic', (event) => {
    if (
      event.data.metadata?.source !== 'opencode-learning' ||
      event.data.metadata.type !== 'proposal-staged'
    ) {
      return
    }

    context.ui.toast.show({
      title: 'Learning proposal',
      message: event.data.text,
      variant: 'success',
      duration: 6000
    })
  })

  return [
    context.data.on('session.created', trackCreated),
    stopSynthetic,
    context.data.on('session.execution.succeeded', removeFinished),
    context.data.on('session.execution.failed', removeFinished),
    context.data.on('session.execution.interrupted', removeFinished)
  ]
}

export default Plugin.define({
  id: 'github.learning_skills_tui',
  setup(context) {
    const handled = new Set<string>()
    const reviewerSessions = new Set<string>()
    const remove = async (sessionID: string): Promise<void> =>
      removeReviewSession(context.client, sessionID, handled)
    const stops = registerCleanupListeners(context, reviewerSessions, remove)
    void removeInactiveReviewSessions(context.client, reviewerSessions, remove).catch(
      (error: unknown) => {
        console.error('[opencode-learning] stale reviewer session cleanup failed', error)
      }
    )

    return () => {
      for (const stop of stops) {
        stop()
      }
    }
  }
})
