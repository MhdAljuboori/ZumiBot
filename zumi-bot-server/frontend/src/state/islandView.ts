import type { IslandLive, IslandOpenTarget } from '@zumibot/shared/island'
import type { ChatMeta } from '@zumibot/shared/types'
import { isUnread } from '@zumibot/shared/unread'
import { recentChats, type IslandMarks, type IslandTarget } from './island'
import { chatTitle } from './sidebarTree'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** The ⋯ menu's age column: 'now', '5m', '2h', '3d', '2w'. */
export function shortAgo(at: number, now: number): string {
  const ago = Math.max(0, now - at)
  if (ago < MIN) return 'now'
  if (ago < HOUR) return `${Math.floor(ago / MIN)}m`
  if (ago < DAY) return `${Math.floor(ago / HOUR)}h`
  if (ago < 7 * DAY) return `${Math.floor(ago / DAY)}d`
  return `${Math.floor(ago / (7 * DAY))}w`
}

export interface RecentRow {
  id: string
  title: string
  ago: string
  current: boolean
  marks: IslandMarks
}

/** The ⋯ menu's recent chats of the agent, each with the marks the sidebar would show for it. */
export function recentRows(
  chats: readonly ChatMeta[],
  agent: string,
  approvals: Record<string, number>,
  shownChatId: string | null,
  now: number,
  agents: readonly { name: string }[]
): RecentRow[] {
  return recentChats(chats, agent).map((c) => ({
    id: c.id,
    title: chatTitle(c, agents),
    ago: shortAgo(c.updatedAt, now),
    current: c.id === shownChatId,
    marks: { working: c.inFlight, waiting: approvals[c.id] ?? 0, unread: isUnread(c) }
  }))
}

/** What the popup remembers about where it is: a chat of this agent, or its new-chat state. */
export function islandTargetOf(view: { kind: string; chatId?: string }, chats: readonly ChatMeta[], agent: string): IslandTarget | null {
  if (view.kind === 'empty') return { kind: 'new' }
  if (view.kind !== 'chat' || view.chatId === undefined) return null
  const chat = chats.find((c) => c.id === view.chatId)
  // A chat of another agent (an opened ask card) is not where this icon's popup left off.
  return chat && chat.agentName === agent && !chat.group ? { kind: 'chat', chatId: chat.id } : null
}

/** The same target twice is no change, so remembering it never re-renders the page. */
export const sameTarget = (a: IslandTarget | undefined, b: IslandTarget): boolean =>
  a !== undefined && a.kind === b.kind && (a.kind === 'new' || (b.kind === 'chat' && a.chatId === b.chatId))

/** An open request of the island, as the main window's own `LiveAsk` carries it (the chat it moves to added). */
export type IslandLiveAsk =
  | { kind: 'desktop'; chatId: string; agent: string; point: { x: number; y: number } | null }
  | { kind: 'handoff'; chatId: string; surface: 'desktop' | 'browser'; target: { agent: string; chatId: string; requestId: string } }

/** The chat to open and its live view; null when the request names no chat (the shell already raised the window). */
export function islandOpenAsk(t: IslandOpenTarget): { chatId: string; live: IslandLiveAsk | null } | null {
  const live: IslandLive | null = t.live
  const chatId = t.chatId ?? (live?.kind === 'handoff' ? live.target.chatId : null)
  if (chatId === null) return null
  if (live === null) return { chatId, live: null }
  if (live.kind === 'desktop') return { chatId, live: { kind: 'desktop', chatId, agent: live.agent, point: live.point } }
  return { chatId, live: { kind: 'handoff', chatId, surface: live.surface, target: live.target } }
}
