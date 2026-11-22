import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { isRemoteAgent } from '@zumibot/shared/engine'
import { TALK_PHRASES_MAX } from '@zumibot/shared/voice'
import type { AgentSummary } from '@zumibot/shared/types'

/** What a voice request can go to: a loadable agent that is not Zumi Bot (chats:createVoice refuses it) nor a remote one (speech is never sent off this machine by a name). */
export function talkAgents(agents: readonly AgentSummary[]): AgentSummary[] {
  return agents.filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME && !isRemoteAgent(a))
}

/** The agents whose alias lists the page shows: the usable ones, plus any that still hold aliases but are gone (so they can be removed). */
export function aliasAgents(agents: readonly AgentSummary[], aliases: Record<string, string[]>): string[] {
  const names = talkAgents(agents).map((a) => a.name)
  return [...names, ...Object.keys(aliases).filter((n) => !names.includes(n))]
}

export type AliasDraft = Record<string, string[]>

export function addPhrase(d: AliasDraft, agent: string): AliasDraft {
  const cur = d[agent] ?? []
  return cur.length >= TALK_PHRASES_MAX ? d : { ...d, [agent]: [...cur, ''] }
}

export function setPhrase(d: AliasDraft, agent: string, i: number, text: string): AliasDraft {
  const cur = d[agent]
  if (!cur || i < 0 || i >= cur.length) return d
  return { ...d, [agent]: cur.map((p, j) => (j === i ? text : p)) }
}

export function removePhrase(d: AliasDraft, agent: string, i: number): AliasDraft {
  const cur = d[agent]
  if (!cur || i < 0 || i >= cur.length) return d
  return { ...d, [agent]: cur.filter((_, j) => j !== i) }
}

/** What goes to the server: trimmed phrases, no blanks, no agent left empty. */
export function cleanAliases(d: AliasDraft): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [agent, list] of Object.entries(d)) {
    const phrases = list.map((p) => p.trim()).filter((p) => p !== '')
    if (phrases.length > 0) out[agent] = phrases
  }
  return out
}

export const sameAliases = (a: Record<string, string[]>, b: Record<string, string[]>): boolean => JSON.stringify(a) === JSON.stringify(b)
