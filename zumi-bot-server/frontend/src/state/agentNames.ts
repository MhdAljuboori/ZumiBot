// Agents read by their display names wherever the UI shows them; the handle stays in what is stored and sent.
import { displayName } from '@zumibot/shared/frontmatter'
import { EVERYONE } from '@zumibot/shared/mentions'
import { mentionSegments } from './groupChat'

/** How a mention reads: `@code-specialist` as `@Code Specialist`, and `@everyone` as it is. */
export const mentionLabel = (name: string): string => `@${name === EVERYONE ? EVERYONE : displayName(name)}`

/** Text (a chat title) with each known agent's `@handle` written as `@Display Name`; code spans stay as written. */
export function friendlyText(text: string, agents: readonly { name: string }[]): string {
  if (agents.length === 0 || !text.includes('@')) return text
  return mentionSegments(
    text,
    agents.map((a) => a.name)
  )
    .map((s) => (s.kind === 'text' ? s.text : mentionLabel(s.name)))
    .join('')
}

/**
 * Whether the composer shows a mention's raw handle: while the caret or a selection touches it, start and end
 * included, so it is edited as the text it is and the caret never sits in hidden text.
 */
export const revealsMention = (from: number, to: number, selFrom: number, selTo: number): boolean => selFrom <= to && selTo >= from

/**
 * The agent a code span names when it spells exactly a known handle. A one-word handle is left as code: `claude` or
 * `codex` in backticks names a program far more often than an agent.
 */
export function codeHandle(code: string, agents: readonly { name: string }[]): string | null {
  if (!code.includes('-')) return null
  return agents.some((a) => a.name === code) ? code : null
}
