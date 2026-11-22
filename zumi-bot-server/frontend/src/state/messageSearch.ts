import { isArchived } from '@zumibot/shared/archive'
import { displayName } from '@zumibot/shared/frontmatter'
import type { SearchHit, SearchResult } from '@zumibot/shared/search'
import { isGroup, type ChatMeta } from '@zumibot/shared/types'
import { chatTitle } from './sidebarTree'

/** How long the sidebar's search box waits after a keystroke before it asks the server. */
export const SEARCH_DEBOUNCE_MS = 250
/** While the server is still building its index, the first page is asked again this often, so hits fill in. */
export const SEARCH_INDEXING_RETRY_MS = 1500

export const hitKey = (h: Pick<SearchHit, 'chatId' | 'itemId'>): string => `${h.chatId}/${h.itemId}`

/** The hits listed so far plus the next page; one already listed is skipped (a newer message moved it down a place). */
export function addPage(held: readonly SearchHit[], page: readonly SearchHit[]): SearchHit[] {
  const seen = new Set(held.map(hitKey))
  return [...held, ...page.filter((h) => !seen.has(hitKey(h)))]
}

export interface HitRow {
  key: string
  hit: SearchHit
  chat: ChatMeta
  title: string
  /** Who wrote it: "You", the agent's name, or "@asker" for a message another agent asked. */
  who: string
  /** The agent whose icon it shows; null for the user's own message. */
  agent: string | null
  when: string
  archived: boolean
}

/** The hits as the list shows them; a hit of a chat this page does not list (made elsewhere since it loaded) is left out. */
export function hitRows(
  hits: readonly SearchHit[],
  chats: readonly ChatMeta[],
  now: number,
  agents: readonly { name: string }[]
): HitRow[] {
  const byId = new Map(chats.map((c) => [c.id, c]))
  return hits.flatMap((hit) => {
    const chat = byId.get(hit.chatId)
    if (!chat) return []
    const agent = hit.role === 'assistant' ? (hit.agent ?? (isGroup(chat) ? null : chat.agentName)) : hit.agent
    const who = hit.role === 'user' ? (hit.agent ? `@${displayName(hit.agent)}` : 'You') : agent ? displayName(agent) : 'Agent'
    return [
      { key: hitKey(hit), hit, chat, title: chatTitle(chat, agents), who, agent, when: whenLabel(hit.ts, now), archived: isArchived(chat) }
    ]
  })
}

const DAY_MS = 86_400_000
const startOfDay = (t: number): number => new Date(t).setHours(0, 0, 0, 0)

/** A time today, "Yesterday", a weekday this week, a short date this year, or one with the year. */
export function whenLabel(ts: number, now: number): string {
  const d = new Date(ts)
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS)
  if (days <= 0) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(
    undefined,
    sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }
  )
}

/** The snippet cut at its marks, for drawing the matched parts. Marks out of order or out of range are ignored. */
export function segments(snippet: string, marks: ReadonlyArray<readonly [number, number]>): Array<{ text: string; mark: boolean }> {
  const out: Array<{ text: string; mark: boolean }> = []
  let at = 0
  for (const [a, b] of marks) {
    if (a < at || b <= a || b > snippet.length) continue
    if (a > at) out.push({ text: snippet.slice(at, a), mark: false })
    out.push({ text: snippet.slice(a, b), mark: true })
    at = b
  }
  if (at < snippet.length) out.push({ text: snippet.slice(at), mark: false })
  return out
}

/** The line over the hits: what the search found so far, and whether older chats are still being indexed. */
export function statusText(result: Pick<SearchResult, 'total' | 'capped' | 'indexing'> | null, loading: boolean, failed: boolean): string {
  if (failed) return "Couldn't search messages."
  if (!result) return loading ? 'Searching messages…' : ''
  const count =
    result.total === 0
      ? 'No messages match'
      : `${result.total}${result.capped ? '+' : ''} ${result.total === 1 && !result.capped ? 'message' : 'messages'}`
  return result.indexing ? `${count} · still indexing older chats…` : count
}
