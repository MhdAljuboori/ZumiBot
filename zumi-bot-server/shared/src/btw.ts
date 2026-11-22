export type SideState = 'picking' | 'running' | 'done' | 'error' | 'stopped'

/** A side question this entry's answer put to another agent with side_question: B's entry in the A→B chat. */
export interface SideAskLink {
  agent: string
  chatId: string
  entryId: string
  state: 'running' | 'done' | 'error' | 'stopped'
}

/** A quick question asked on the side of a chat; it never joins the chat's items. */
export interface SideQuestion {
  id: string
  question: string
  agent: string | null // null while a room still waits for the user to pick who answers
  mention?: true // the user named the member with @
  from?: string // the asking agent's handle when an agent asked (side_question); absent = the user
  thread?: string // a follow-up: its thread's first entry; absent = a thread's first question
  asks?: SideAskLink[] // side questions this answer asked other agents, in order
  askedAt: number
  after: string | null // id of the chat item the question was asked after
  state: SideState
  answer: string
  error?: string
  endedAt?: number
}

export const BTW_NAME = 'btw'
export const SIDE_MAX_OPEN = 3
export const SIDE_TIMEOUT_MS = 180_000
// An answer's clock pauses while it waits on side_question, so the asked agent gets its own full time; this caps the wall time.
export const SIDE_ASKING_CAP_MS = 360_000
export const SIDE_LIMIT_TEXT = '3 side questions are already running in this chat'
export const SIDE_TIMEOUT_TEXT = 'Took too long'
export const SIDE_RESTART_TEXT = 'Interrupted by a restart'
export const BTW_DESCRIPTION = 'Ask on the side; the run keeps going'
/** An A→B chat's asker answers from the chat it asked from; once that is deleted, it cannot. Names no id or path. */
export const sourceGoneText = (agent: string): string => `The chat @${agent} asked from was deleted`
// Follow-up and Ask again refusals, shared so the UI can match them.
export const SIDE_WAIT_TEXT = 'Wait for this answer to finish'
export const SIDE_NOT_FOUND_TEXT = 'Side question not found'
export const SIDE_ASK_FIRST_TEXT = 'Ask this side question again first'
export const askedByText = (agent: string): string => `Asked by @${agent}; follow-ups are not available`
export const SIDE_LAST_ONLY_TEXT = 'Only the last question in a side thread can be asked again'

export const isOpen = (q: SideQuestion): boolean => q.state === 'picking' || q.state === 'running'

// Handle chars as in mentions.ts, plus `_`; it must end at whitespace so "@a.b" is not a handle.
const LEAD_MENTION = /^@([a-z0-9_-]+)(?=\s|$)/i
// Same boundary rule as leadingCommand: `/btwx y` is another command's name.
const LEAD_BTW = new RegExp(`^/${BTW_NAME}(?=\\s|$)`)

/** What follows `/btw `: an optional leading `@member`, then the question (trimmed). Empty question → null. */
export function sideParts(rest: string): { question: string; mention: string | null } | null {
  const t = rest.trim()
  const m = LEAD_MENTION.exec(t)
  const question = (m ? t.slice(m[0].length) : t).trim()
  return question === '' ? null : { question, mention: m ? m[1] : null }
}

/** `/btw [@member] question` at index 0 of the untrimmed text, else null: `sideParts` of what follows `/btw`. */
export function btwOf(text: string): { question: string; mention: string | null } | null {
  const m = LEAD_BTW.exec(text)
  return m ? sideParts(text.slice(m[0].length)) : null
}
