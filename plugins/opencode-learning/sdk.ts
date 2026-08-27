import type { Plugin } from '@opencode-ai/plugin'
import type { SessionContext } from '@opencode-ai/plugin/promise/session'
import type { Info as ToolInfo } from '@opencode-ai/plugin/promise/tool'

export type OpenCodeContext = Parameters<Plugin.Plugin['setup']>[0]
export type LearningToolInfo = Omit<ToolInfo, 'name' | 'options'>
export type ContextEvent = Pick<SessionContext, 'sessionID' | 'messages'>

type ToolHook = OpenCodeContext['tool']['hook']
type ToolHookEvent = Parameters<Parameters<ToolHook>[1]>[0]

export type ToolBeforeEvent = Exclude<ToolHookEvent, { status: 'completed' | 'error' }>
export type ToolAfterEvent = Extract<ToolHookEvent, { status: 'completed' | 'error' }>
export type SessionInfo = Awaited<ReturnType<OpenCodeContext['session']['get']>>
export type SessionCreateInput = NonNullable<Parameters<OpenCodeContext['session']['create']>[0]>
export type SkillInfo = Awaited<ReturnType<OpenCodeContext['skill']['list']>>['data'][number]

type EventStream = ReturnType<OpenCodeContext['event']['subscribe']>
export type OpenCodeEvent = EventStream extends AsyncIterable<infer Event> ? Event : never
export type TerminalEvent = Extract<
  OpenCodeEvent,
  {
    type:
      'session.execution.succeeded' | 'session.execution.failed' | 'session.execution.interrupted'
  }
>
export type SessionMovedEvent = Extract<OpenCodeEvent, { type: 'session.moved' }>
