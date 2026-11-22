import { engineCaps, engineOfAgent, spendCapRefusal, type Engine, type EngineCaps } from './engine'
import type { RoutineTarget } from './routines'
import type { AgentSummary, ChatMeta } from './types'
import type { Step } from './workflows'

/** Where a routine's or workflow's agents come from: names it holds, and existing chats (a room's members, a chat's agent) to look up. */
export interface AgentRefs {
  agents: string[]
  chats: string[]
}

export type ChatAgents = Pick<ChatMeta, 'agentName' | 'group'>

export function routineRefs(target: RoutineTarget): AgentRefs {
  switch (target.kind) {
    case 'new-chat':
      return { agents: [target.agent], chats: [] }
    case 'new-group':
      return { agents: [...target.members], chats: [] }
    case 'chat':
      return { agents: [], chats: [target.chatId] }
  }
}

/** The agents a workflow's own steps run: an Agent or For each step's, a Room step's members (or its template room's), a Chat step's chat's. */
export function workflowRefs(steps: readonly Step[]): AgentRefs {
  const out: AgentRefs = { agents: [], chats: [] }
  for (const s of steps) {
    if (s.kind === 'agent' || s.kind === 'foreach') out.agents.push(s.agent)
    else if (s.kind === 'room') {
      if (s.members !== undefined) out.agents.push(...s.members)
      else if (s.room) out.chats.push(s.room)
    } else if (s.kind === 'chat' && s.chat) out.chats.push(s.chat)
  }
  return out
}

/**
 * The fixed sentence for a spend cap that can't hold: the first agent (a name that is no loaded agent counts as Claude, as the
 * server's lookup does) whose engine has no `cost`. Null when every agent reports a cost, or there are none.
 */
export function spendCapBlocker(
  refs: AgentRefs,
  agents: readonly AgentSummary[],
  chatOf: (id: string) => ChatAgents | null | undefined,
  caps: (e: Engine) => EngineCaps = engineCaps
): string | null {
  const names = [
    ...refs.agents,
    ...refs.chats.flatMap((id) => {
      const chat = chatOf(id)
      return !chat ? [] : chat.group ? chat.group.members : [chat.agentName]
    })
  ]
  for (const name of new Set(names)) {
    const engine = engineOfAgent(agents.find((a) => a.name === name))
    if (!caps(engine).cost) return spendCapRefusal(engine, name)
  }
  return null
}
