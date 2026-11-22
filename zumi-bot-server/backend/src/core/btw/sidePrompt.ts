import type { ChatItem } from '@zumibot/shared/types'
import type { SideQuestion } from '@zumibot/shared/btw'
import { toolSummary } from '@zumibot/shared/toolSummary'
import { threadEntries, threadLines, type ThreadEntry } from '../chat/groupPrompts'
import { buildSeedPrompt } from '../chat/seedPrompt'

const ANSWER = 'Answer only this question, briefly, from what you already know in this conversation.'
const KEEP = 'Do not continue, restart or change the main work; this answer does not affect it.'
const BY_USER = 'The user is asking you a side question with /btw while your main work goes on in another process.'
export const SIDE_NOTE = `${BY_USER} ${ANSWER} You cannot use tools here. ${KEEP}`

/** B's note for a side question another agent put to it: no tools, so it cannot ask on in turn. */
export function askedSideNote(by: string): string {
  return `@${by} is asking you a side question while your main work goes on in another process. ${ANSWER} You cannot use tools here. ${KEEP}`
}

/**
 * A user's side question where the run may use side_question. Its fork stops before an ask still running, so the
 * note names whom it asked from this chat; with nobody, it reads as SIDE_NOTE (the guard still lets the tool through).
 */
export function askingSideNote(handles: readonly string[]): string {
  if (!handles.length) return SIDE_NOTE
  const who = handles.map((h) => `@${h}`).join(', ')
  return `${BY_USER} ${ANSWER} You cannot use tools here, except side_question, to ask ${who} (agents you asked from this chat) a quick question about that conversation. ${KEEP}`
}

/**
 * A Codex agent's own side answer where its main run has the ask bridge: no hook can let side_question alone through on Codex,
 * so the run declines it like every call, and the note says so rather than leaving the roster to suggest otherwise.
 */
export const NO_ASK_SIDE_NOTE = `${BY_USER} ${ANSWER} You cannot use tools here, so you cannot ask other agents anything either. ${KEEP}`

export const ASKED_THREAD_MAX = 20_000

/** What a side answer reads before its note: the optional lead, then the room thread lines. '' when neither. */
export function sideContext(thread: ThreadEntry[] | null, lead?: string): string {
  return [...(lead ? [lead] : []), ...threadLines(thread ?? [])].join('\n')
}

export function sideMessage(question: string, thread: ThreadEntry[] | null, note = SIDE_NOTE, lead?: string): string {
  const context = sideContext(thread, lead)
  return [...(context ? [context] : []), note, `<btw>${question}</btw>`].join('\n')
}

/** Restores the visible items before a message, as a reseeded session does. */
export function seedWith(items: ChatItem[], message: string): string {
  return buildSeedPrompt(items, message)
}

export function seededSideMessage(
  items: ChatItem[],
  question: string,
  thread: ThreadEntry[] | null = null,
  note = SIDE_NOTE,
  lead?: string
): string {
  return seedWith(items, sideMessage(question, thread, note, lead))
}

export const FOLLOW_MAX = 40_000
export const FOLLOW_LEAD =
  'This side question follows up earlier ones in the same side thread. The earlier questions and your answers, oldest first:'
export const FOLLOW_LEAD_CUT =
  'This side question follows up earlier ones in the same side thread. The earlier questions and your answers, oldest first, some in the middle left out:'

type Earlier = readonly Pick<SideQuestion, 'question' | 'answer'>[]

// Same walk as askedThread: the thread's first pair always stays, then the newest that still fit.
export function followExchange(earlier: Earlier, max = FOLLOW_MAX): { pairs: string[]; cut: boolean } {
  const all = earlier.map((e) => `<btw>${e.question}</btw>\n<answer>${e.answer.trim() || '(no answer)'}</answer>`)
  let used = all.reduce((n, p) => n + p.length, 0)
  if (used <= max) return { pairs: all, cut: false }
  used = all[0].length
  let start = all.length
  while (start > 1 && used + all[start - 1].length <= max) {
    start--
    used += all[start].length
  }
  return { pairs: [all[0], ...all.slice(start)], cut: start > 1 }
}

/** A follow-up's message: the room context, the side note, the thread's earlier exchange, then the new question. */
export function followMessage(context: string, note: string, earlier: Earlier, question: string): string {
  const { pairs, cut } = followExchange(earlier)
  return [...(context ? [context] : []), note, cut ? FOLLOW_LEAD_CUT : FOLLOW_LEAD, ...pairs, `<btw>${question}</btw>`].join('\n')
}

// The A->B chat's live turn is hidden from threadEntries (its items carry `turn`), so a side question about it is
// told the visible messages itself: the ask, B's text and one line per tool step. `turn` is ignored on purpose.
export function askedThread(
  items: readonly ChatItem[],
  asker: string,
  owner: string,
  max = ASKED_THREAD_MAX
): { entries: ThreadEntry[]; cut: boolean } {
  const all: ThreadEntry[] = []
  for (const item of items) {
    if (item.type === 'user') all.push({ from: item.from ?? asker, text: item.text })
    else if (item.type === 'assistant') all.push({ from: owner, text: item.text })
    else if (item.type === 'tool') all.push({ from: owner, text: `Used ${toolSummary(item.name, item.input)}` })
  }
  let used = all.reduce((n, e) => n + e.text.length, 0)
  if (used <= max) return { entries: all, cut: false }
  // Keep the first message (the ask itself), then the newest that still fit.
  used = all[0].text.length
  let start = all.length
  while (start > 1 && used + all[start - 1].text.length <= max) {
    start--
    used += all[start].text.length
  }
  return { entries: [all[0], ...all.slice(start)], cut: start > 1 }
}

export function askedLead(owner: string, cut: boolean): string {
  return `These are the messages of your ask to @${owner} so far, newest last${cut ? ', older ones left out' : ''}:`
}

export function unseenEntries(items: readonly ChatItem[], afterId: string | null, me: string): ThreadEntry[] {
  const visible = items.map((item) => {
    if ('turn' in item && (!('agent' in item) || item.agent !== me)) {
      // Other members' live messages belong in a side answer's snapshot.
      const { turn: _turn, ...entry } = item
      return entry
    }
    return item
  })
  return threadEntries(visible, afterId, me)
}
