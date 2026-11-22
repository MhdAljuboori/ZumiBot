import { SUGGEST_MIN_CHARS } from '@zumibot/shared/jev'
import type { AgentSummary } from '@zumibot/shared/types'
import type { NewChatDraft } from './newChat'

/** Waits for a pause in typing, so Jev is asked about the message, not every keystroke. */
export const SUGGEST_DEBOUNCE_MS = 700

/** The text to ask Jev about, or null when no suggestion is wanted: an agent is picked, group mode, or too little text. */
export function suggestQuery(draft: NewChatDraft, agents: readonly AgentSummary[]): string | null {
  if (draft.mode !== 'single') return null
  if (agents.some((a) => a.name === draft.agentName && a.error === null)) return null
  const text = draft.text.trim()
  return text.length >= SUGGEST_MIN_CHARS ? text : null
}
