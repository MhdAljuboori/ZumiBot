import { isAsked } from '@zumibot/shared/agentAsk'
import { isArchived } from '@zumibot/shared/archive'
import { isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import { chatStepProblem } from '@zumibot/shared/workflowChat'
import { chatTitle } from './sidebarTree'

// What the Chat step's picker and node show, kept apart from the components.

/**
 * Chats a step may post into, in two groups by the title shown. Not A to B, not a workflow's own, not archived, and no
 * single chat of Zumi Bot or of a gone or broken agent. The current pick stays listed whatever its kind (while the chat
 * exists), so the select shows it and the note under it says why the server refuses it.
 */
export function chatOptions(
  chats: ChatMeta[],
  current: string,
  agents: AgentSummary[],
  zumiBot: string
): { rooms: ChatMeta[]; singles: ChatMeta[] } {
  const live = chats
    .filter((c) => c.id === current || (!isArchived(c) && chatStepProblem(c, agents, zumiBot) === null))
    .map((c) => ({ c, t: chatTitle(c, agents) }))
    .sort((a, b) => a.t.localeCompare(b.t))
    .map((x) => x.c)
  return { rooms: live.filter((c) => isGroup(c)), singles: live.filter((c) => !isGroup(c)) }
}

/** The red line under the picker: the server's own words for a chat it will refuse (gone, read-only, a workflow's, or its agent's problem). */
export function chatStepNote(chatId: string, chats: ChatMeta[], agents: AgentSummary[], zumiBot: string): string | null {
  if (!chatId) return null
  return chatStepProblem(chats.find((c) => c.id === chatId) ?? null, agents, zumiBot)
}

/** The chat's title as the sidebar shows it (agent handles read as display names); null when no chat is set or it is gone. */
export function chatStepTitle(chatId: string, chats: ChatMeta[], agents: AgentSummary[]): string | null {
  if (!chatId) return null
  const c = chats.find((x) => x.id === chatId)
  return c ? chatTitle(c, agents) : null
}
