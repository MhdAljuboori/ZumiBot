import type { Question } from '@zumibot/shared/questions'
import type { QuestionAnswers } from '@zumibot/shared/types'

/** One question's in-progress pick. `other: null` = Other not chosen; `''` or typed text = Other is active. */
export interface QuestionPick {
  labels: string[]
  other: string | null
}

/** The whole card's in-progress state, keyed by question text. */
export interface Draft {
  step: number
  picks: Record<string, QuestionPick>
}

export const EMPTY_DRAFT: Draft = { step: 0, picks: {} }

const pickOf = (d: Draft, q: Question): QuestionPick => d.picks[q.text] ?? { labels: [], other: null }

const withPick = (d: Draft, q: Question, p: QuestionPick, step = d.step): Draft => ({
  step,
  picks: { ...d.picks, [q.text]: p }
})

/** Option click on the current step. Single-select advances (except on the last step); multi-select never does. */
export function choose(d: Draft, qs: Question[], label: string): Draft {
  const q = qs[d.step]
  if (!q) return d
  const prev = pickOf(d, q)
  if (q.multiSelect) {
    const set = new Set(prev.labels)
    if (set.has(label)) set.delete(label)
    else set.add(label)
    // Follow the question's option order, not click order, so the UI and the sent answer agree.
    const labels = q.options.filter((o) => set.has(o.label)).map((o) => o.label)
    return withPick(d, q, { labels, other: prev.other })
  }
  const nextStep = d.step < qs.length - 1 ? d.step + 1 : d.step
  return withPick(d, q, { labels: [label], other: null }, nextStep)
}

/** Toggles the Other slot for the current step's question. Never advances the step. */
export function chooseOther(d: Draft, qs: Question[]): Draft {
  const q = qs[d.step]
  if (!q) return d
  const prev = pickOf(d, q)
  if (prev.other !== null) return withPick(d, q, { labels: prev.labels, other: null })
  // Other replaces a single-select's picked label; a multi-select keeps whatever else is checked.
  return withPick(d, q, { labels: q.multiSelect ? prev.labels : [], other: '' })
}

/** Other text box input, also used for the `text`/`number` kinds (which have no options). Never advances. */
export function typeOther(d: Draft, qs: Question[], text: string): Draft {
  const q = qs[d.step]
  if (!q) return d
  const prev = pickOf(d, q)
  return withPick(d, q, { labels: prev.labels, other: text })
}

export function goTo(d: Draft, qs: Question[], step: number): Draft {
  const max = Math.max(qs.length - 1, 0)
  return { ...d, step: Math.min(Math.max(step, 0), max) }
}

/** The answer a pick resolves to, trimming Other text here so a blank Other reads as unanswered. */
export function answerOf(q: Question, p: QuestionPick | undefined): string | string[] | null {
  if (!p) return null
  const other = p.other !== null ? p.other.trim() : ''
  if (q.multiSelect) {
    const values = other ? [...p.labels, other] : p.labels
    return values.length > 0 ? values : null
  }
  if (other) return other
  return p.labels.length > 0 ? p.labels[0] : null
}

/** Null unless every question has a valid answer. */
export function buildAnswers(qs: Question[], d: Draft): QuestionAnswers | null {
  const result: QuestionAnswers = {}
  for (const q of qs) {
    const answer = answerOf(q, d.picks[q.text])
    if (answer === null) return null
    result[q.text] = answer
  }
  return result
}

/** What Enter in a text box does, matching the footer: Next before the last step, Send on it, nothing while unanswered. */
export function enterAction(d: Draft, qs: Question[]): 'send' | 'next' | null {
  const step = Math.min(d.step, qs.length - 1)
  const q = qs[step]
  if (!q || answerOf(q, d.picks[q.text]) === null) return null
  if (step < qs.length - 1) return 'next'
  return buildAnswers(qs, d) !== null ? 'send' : null
}

/** Inverse of answerOf, for the read-only view after sending: splits a sent answer into real option labels and leftover Other text. */
export function shownAnswer(q: Question, a: string | string[] | undefined): QuestionPick {
  if (a === undefined) return { labels: [], other: null }
  const optionLabels = new Set(q.options.map((o) => o.label))
  if (Array.isArray(a)) {
    const labels = q.options.filter((o) => a.includes(o.label)).map((o) => o.label)
    const leftover = a.filter((v) => !optionLabels.has(v))
    return { labels, other: leftover.length > 0 ? leftover.join(', ') : null }
  }
  return optionLabels.has(a) ? { labels: [a], other: null } : { labels: [], other: a }
}

const LIST_ITEM = /^\s*([-*+]|\d{1,9}[.)])(\s|$)/
const FENCE = /^\s*(```|~~~)/

/**
 * Question text for markdown. Agents write a question as plain lines, so an unindented line right after a list item
 * ("Reply …" below the numbered changes) is meant as its own line; markdown would glue it into the last item.
 */
export function questionMarkdown(text: string): string {
  const out: string[] = []
  let inFence = false
  let inList = false
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) inFence = !inFence
    else if (!inFence) {
      if (LIST_ITEM.test(line)) inList = true
      else if (line.trim() === '') inList = false
      else if (inList && !/^\s/.test(line)) {
        out.push('')
        inList = false
      }
    }
    out.push(line)
  }
  return out.join('\n')
}
