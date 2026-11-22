// Approval, question and plan cards as channel messages (Telegram HTML). Pure: the server scrubs vault values out of every
// string before it gets here, and decides what a press means; this only lays the text out and states the outcome.
import { displayName } from './agentName'
import { TELEGRAM, type Dialect } from './channelText'
import type { Question } from './questions'
import type { ApprovalStatus, QuestionAnswers } from './types'

export const CARD_SUMMARY_MAX = 600
export const CARD_LINE_MAX = 300
export const OPTION_LABEL_MAX = 40

/** Cut on a line boundary where one is near, with a note, so a cut command is never mistaken for the whole one. */
export function cutForCard(text: string, max = CARD_SUMMARY_MAX): string {
  if (text.length <= max) return text
  const nl = text.lastIndexOf('\n', max)
  const at = nl > max / 2 ? nl : max
  return `${text.slice(0, at).trimEnd()}\n… (cut, see ZumiBot)`
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

/**
 * An approval card: who asks for which tool, what the call would do (for Bash the whole command, since judging it is the
 * point), and the request's own description and reason. `summary` is the web row's text (toolSummary).
 */
export function approvalCardHtml(
  o: { agent: string | null; toolName: string; input: unknown; summary: string; description: string | null; reason: string | null },
  d: Dialect = TELEGRAM
): string {
  const who = o.agent ? d.escape(displayName(o.agent)) : 'The agent'
  const lines = [`${who} wants to use ${d.bold(d.escape(o.toolName))}`]
  const input = (o.input && typeof o.input === 'object' ? o.input : {}) as Record<string, unknown>
  const command = o.toolName === 'Bash' ? str(input.command) : null
  if (command) {
    lines.push(d.pre(cutForCard(command), ''))
    const why = str(input.description)
    if (why) lines.push(d.escape(cutForCard(why, CARD_LINE_MAX)))
  } else {
    lines.push(d.code(cutForCard(o.summary)))
  }
  if (o.description) lines.push(d.escape(cutForCard(o.description, CARD_LINE_MAX)))
  if (o.reason) lines.push(d.italic(d.escape(cutForCard(o.reason, CARD_LINE_MAX))))
  return lines.join('\n')
}

/** One question of a question card, its options listed with their descriptions; the buttons carry only the labels. */
export function questionHtml(q: Question, o: { heading: string | null; index: number; count: number }, d: Dialect = TELEGRAM): string {
  const lines: string[] = []
  if (o.heading) lines.push(d.bold(d.escape(o.heading)))
  const head = q.header.trim() !== '' ? `${d.escape(q.header)}: ` : ''
  const n = o.count > 1 ? `${o.index + 1}/${o.count} ` : ''
  lines.push(`${n}${head}${d.escape(cutForCard(q.text, CARD_LINE_MAX))}`)
  if (q.description) lines.push(d.italic(d.escape(cutForCard(q.description, CARD_LINE_MAX))))
  for (const opt of q.options)
    lines.push(`• ${d.bold(d.escape(opt.label))}${opt.description ? ` — ${d.escape(cutForCard(opt.description, CARD_LINE_MAX))}` : ''}`)
  if (q.kind !== 'choice' || q.options.length === 0)
    lines.push(q.kind === 'number' ? 'Reply to this message with a number.' : 'Reply to this message with your answer.')
  else if (q.multiSelect) lines.push('Pick any, then Done.')
  return lines.join('\n')
}

/** A button's text: the option's label, cut, with a tick once a multi-select option is picked. */
export const optionLabel = (label: string, picked: boolean): string => {
  const l = label.length > OPTION_LABEL_MAX ? `${label.slice(0, OPTION_LABEL_MAX - 1)}…` : label
  return picked ? `✓ ${l}` : l
}

/** What a question's message says once it has an answer. */
export const pickedLine = (pick: string | string[], d: Dialect = TELEGRAM): string =>
  `✓ ${d.escape(Array.isArray(pick) ? pick.join(', ') : pick)}`

/** The answers object once every question has one, else null. Keyed by question text, as checkAnswers wants. */
export function answersOf(questions: readonly Question[], picks: ReadonlyMap<number, string | string[]>): QuestionAnswers | null {
  const out: QuestionAnswers = {}
  for (let i = 0; i < questions.length; i++) {
    const p = picks.get(i)
    if (p === undefined || (Array.isArray(p) && p.length === 0)) return null
    out[questions[i].text] = p
  }
  return out
}

/** A number answer must read as one; free text and choices pass. Null when fine, else what to tell the user. */
export function typedAnswerProblem(q: Question, text: string): string | null {
  const t = text.trim()
  if (t === '') return 'That answer is empty.'
  if (q.kind !== 'number') return null
  const n = Number(t)
  if (!Number.isFinite(n)) return 'That question wants a number.'
  if (q.min !== null && n < q.min) return `The smallest allowed is ${q.min}.`
  if (q.max !== null && n > q.max) return `The largest allowed is ${q.max}.`
  return null
}

/** The line a card's message gets once it stops waiting; `here`: the answer came from this channel. */
export function outcomeLine(status: ApprovalStatus, here: boolean): string {
  const where = here ? '' : ' in ZumiBot'
  switch (status) {
    case 'allowed-once':
      return `✓ Allowed once${where}`
    case 'allowed-chat':
    case 'allowed-agent':
    case 'allowed-step':
      return `✓ Allowed${where}`
    case 'auto-allowed':
    case 'auto-allowed-agent':
    case 'auto-allowed-workflow':
      return '✓ Allowed by a remembered rule'
    case 'denied':
      return `✗ Denied${where}`
    case 'answered':
      return `✓ Answered${where}`
    case 'skipped':
      return `Skipped${where}`
    case 'approved':
      return `✓ Plan approved${where}`
    case 'sent-back':
      return `↩ Sent back to keep planning${where}`
    case 'unanswered':
    case 'pending':
      return 'No longer pending'
  }
}
