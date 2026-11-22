// Pure helpers for the @mention picker in the composer and the message editor.
import { displayName } from '@zumibot/shared/frontmatter'
import { EVERYONE } from '@zumibot/shared/mentions'
import type { AgentSummary } from '@zumibot/shared/types'

export interface MentionQuery {
  start: number // index of the '@'
  query: string
}

/** The `@word` being typed right before the caret, or null when the caret is not inside one. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const m = /(?<![\w@./-])@([a-z0-9-]*)$/i.exec(text.slice(0, caret))
  return m ? { start: m.index, query: m[1] } : null
}

/** Members whose name or display name starts with the query, case-insensitively. */
export function filterMembers(query: string, members: readonly AgentSummary[]): AgentSummary[] {
  const q = query.toLowerCase()
  return members.filter((m) => m.name.toLowerCase().startsWith(q) || displayName(m.name).toLowerCase().startsWith(q))
}

/** Whether the `@everyone` option fits the query: 'everyone' starts with it. */
export const everyoneMatches = (query: string): boolean => 'everyone'.startsWith(query.toLowerCase())

export type MentionOption = AgentSummary | 'everyone'

/** The @ list for a query: `@everyone` first when offered (a room) and it fits, then the members that match. */
export function mentionOptions(query: string, members: readonly AgentSummary[], everyone: boolean): MentionOption[] {
  return [...(everyone && everyoneMatches(query) ? ['everyone' as const] : []), ...filterMembers(query, members)]
}

/** The handle an option inserts, without its `@`. */
export const mentionOptionName = (o: MentionOption): string => (o === 'everyone' ? EVERYONE : o.name)

/** Replaces the typed `@query` with `@name ` and puts the caret after the space. */
export function insertMention(text: string, q: MentionQuery, caret: number, name: string): { text: string; caret: number } {
  const inserted = `@${name} `
  return { text: text.slice(0, q.start) + inserted + text.slice(caret), caret: q.start + inserted.length }
}
