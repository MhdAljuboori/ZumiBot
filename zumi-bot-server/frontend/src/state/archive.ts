import { isArchived } from '@zumibot/shared/archive'
import { displayName } from '@zumibot/shared/frontmatter'
import { isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'
import { folderName, titleMatches } from './sidebarTree'

/** The chats the sidebar, its dots and the unread roll-ups see: everything but the archived ones. */
export function liveChats<T extends ChatMeta>(chats: readonly T[]): T[] {
  return chats.filter((c) => !isArchived(c))
}

export interface ArchivedRow {
  chat: ChatMeta
  /** A single chat's agent; null for a room. */
  agent: AgentSummary | null
  /** A room's members that still exist. */
  members: AgentSummary[]
  folder: string
}

/**
 * The Archived list, newest archived first. A single chat whose agent is gone is left out, as the sidebar does: it
 * could not open. A search matches the title, the agent or member names (either spelling) and the folder.
 */
export function archivedRows(chats: readonly ChatMeta[], agents: readonly AgentSummary[], query: string): ArchivedRow[] {
  const q = query.trim().toLowerCase()
  const named = (a: AgentSummary): boolean => a.name.toLowerCase().includes(q) || displayName(a.name).toLowerCase().includes(q)
  const rows: ArchivedRow[] = []
  for (const chat of chats) {
    if (!isArchived(chat)) continue
    const agent = isGroup(chat) ? null : (agents.find((a) => a.name === chat.agentName) ?? null)
    if (!isGroup(chat) && !agent) continue
    const members = isGroup(chat) ? chat.group.members.flatMap((n) => agents.find((a) => a.name === n) ?? []) : []
    const folder = folderName(chat.cwd)
    const match =
      q === '' || titleMatches(chat, agents, q) || folder.toLowerCase().includes(q) || (agent ? named(agent) : members.some(named))
    if (match) rows.push({ chat, agent, members, folder })
  }
  return rows.sort((a, b) => (b.chat.archivedAt ?? 0) - (a.chat.archivedAt ?? 0))
}

const DAY_MS = 86_400_000
const startOfDay = (t: number): number => new Date(t).setHours(0, 0, 0, 0)

/** "Archived today", "yesterday", a short date this year, or one with the year. */
export function archivedLabel(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY_MS)
  if (days <= 0) return 'Archived today'
  if (days === 1) return 'Archived yesterday'
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  return `Archived ${new Date(at).toLocaleDateString(undefined, sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' })}`
}
