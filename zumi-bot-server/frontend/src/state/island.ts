import { isArchived } from '@zumibot/shared/archive'
import { isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import { isUnread } from '@zumibot/shared/unread'

export const RECENT_MAX = 8

/** Shown instead of sending a typed `/btw` from the island, whose popup has no side panel. */
export const ISLAND_BTW_NOTICE = 'Side questions open in ZumiBot'
/** The same for a typed `/run-workflow`: the popup has no workflow list and no run to open. */
export const ISLAND_RUN_WORKFLOW_NOTICE = 'Workflows start in ZumiBot'

export interface IslandMarks {
  working: boolean
  waiting: number
  unread: boolean
}
export type IslandTarget = { kind: 'chat'; chatId: string } | { kind: 'new' }

/** What the island lists for an agent: its plain single chats. Asked, unkept workflow and archived chats are not the user's to open. */
export function islandChats(chats: readonly ChatMeta[], agent: string): ChatMeta[] {
  return chats
    .filter(
      (c) => !isGroup(c) && c.agentName === agent && !isArchived(c) && !c.asked && (!c.workflow || c.workflow.keep) && !c.workflowTest
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function islandMarks(chats: readonly ChatMeta[], agent: string, approvals: Record<string, number>): IslandMarks {
  const mine = islandChats(chats, agent)
  return {
    working: mine.some((c) => c.inFlight),
    waiting: mine.reduce((n, c) => n + (approvals[c.id] ?? 0), 0),
    unread: mine.some(isUnread)
  }
}

/** The icon's click: a waiting chat first (the oldest has waited longest), then where the user left off, then what is new. */
export function chatToOpen(
  chats: readonly ChatMeta[],
  agent: string,
  approvals: Record<string, number>,
  remembered: IslandTarget | undefined
): IslandTarget {
  const mine = islandChats(chats, agent)
  const waiting = mine.filter((c) => (approvals[c.id] ?? 0) > 0).sort((a, b) => a.updatedAt - b.updatedAt)[0]
  if (waiting) return { kind: 'chat', chatId: waiting.id }
  if (remembered && (remembered.kind === 'new' || mine.some((c) => c.id === remembered.chatId))) return remembered
  const next = mine.find(isUnread) ?? mine[0]
  return next ? { kind: 'chat', chatId: next.id } : { kind: 'new' }
}

export function recentChats(chats: readonly ChatMeta[], agent: string): ChatMeta[] {
  return islandChats(chats, agent).slice(0, RECENT_MAX)
}

/** The picked agents that can still run, in the user's order. */
export function islandAgents(picks: readonly string[], agents: readonly AgentSummary[]): AgentSummary[] {
  const out: AgentSummary[] = []
  for (const name of picks) {
    const a = agents.find((x) => x.name === name)
    if (a && a.error === null) out.push(a)
  }
  return out
}

/**
 * The agent whose popup the island shows: a picked agent, or the one a voice request just went to (its chat opens in the
 * popup though the agent isn't on the strip). Never one that is gone or broken.
 */
export function popupAgentOf(
  open: string | null,
  picks: readonly string[],
  voiceAgent: string | null,
  agents: readonly Pick<AgentSummary, 'name' | 'error'>[]
): string | null {
  if (open === null || (!picks.includes(open) && open !== voiceAgent)) return null
  return agents.some((a) => a.name === open && a.error === null) ? open : null
}
