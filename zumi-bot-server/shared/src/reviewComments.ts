import type { GitDiffScope } from './types'

// Pure, like gitChanges.ts: the frontend keeps the draft and builds the message, the backend never sees either.

/** What the user writes on one comment. */
export const REVIEW_TEXT_MAX = 4_000
/** The quoted lines kept with a comment; a longer selection is cut and the cut says how much went. */
export const REVIEW_QUOTE_MAX = 4_000
/** Comments in one draft: a review is read in one turn, so it stays a review and not a file. */
export const REVIEW_COMMENTS_MAX = 50

export const REVIEW_EMPTY = 'Write a comment first.'
export const REVIEW_FULL = `A review holds at most ${REVIEW_COMMENTS_MAX} comments. Send these first.`

/**
 * One comment on a diff: where it sits, the lines as they read when it was made, and the user's text. The quote is the
 * point — the agent finds the place again after the file has moved on, so the line numbers are only a hint.
 */
export interface ReviewComment {
  id: string
  path: string // repo-relative, as the Changes panel lists it
  from: number // first line of the range
  to: number // last line; `from` when one line is selected
  old: boolean // the range is on the old side (selectedLines' `old`), so the quote says so
  quote: string
  text: string
  at: number
  scope: GitDiffScope // which diff it was made on
}

/** A selection waiting for its text: what the diff's rows give before the user writes anything. */
export interface ReviewPick {
  path: string
  from: number
  to: number
  old: boolean
  quote: string
  scope: GitDiffScope
}

const block = (s: string, max: number): string => s.replace(/\r\n?/g, '\n').trim().slice(0, max).trim()

/** The selected lines as they are kept: line ends normalised, indentation left alone, cut with a line saying so. */
export function cutQuote(text: string): string {
  const t = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  if (t.length <= REVIEW_QUOTE_MAX) return t
  const dropped = t.length - REVIEW_QUOTE_MAX
  return `${t.slice(0, REVIEW_QUOTE_MAX)}\n… ${dropped} more characters not quoted`
}

/** `path:12` or `path:12-18`. */
export const rangeOf = (c: Pick<ReviewComment, 'path' | 'from' | 'to'>): string =>
  c.from === c.to ? `${c.path}:${c.from}` : `${c.path}:${c.from}-${c.to}`

/** The line after the range: which side the lines came from, and which diff they were read on. */
function marks(c: Pick<ReviewComment, 'old' | 'scope'>): string {
  const parts: string[] = []
  if (c.old) parts.push('old')
  if (c.scope === 'base') parts.push('since start')
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`
}

/** Adds a comment to the draft. Throws when the text is empty or the draft is full, so nothing is stored half way. */
export function addComment(comments: readonly ReviewComment[], pick: ReviewPick, text: string, now: number, id: string): ReviewComment[] {
  const body = block(text, REVIEW_TEXT_MAX)
  if (body === '') throw new Error(REVIEW_EMPTY)
  if (comments.length >= REVIEW_COMMENTS_MAX) throw new Error(REVIEW_FULL)
  const c: ReviewComment = {
    id,
    path: pick.path,
    from: pick.from,
    to: pick.to,
    old: pick.old,
    quote: cutQuote(pick.quote),
    text: body,
    at: now,
    scope: pick.scope
  }
  return [...comments, c]
}

/** The user's edit of a comment's text. The quote is never re-read, so it stays the lines the user saw. */
export function editComment(comments: readonly ReviewComment[], id: string, text: string): ReviewComment[] {
  const body = block(text, REVIEW_TEXT_MAX)
  if (body === '') throw new Error(REVIEW_EMPTY)
  return comments.map((c) => (c.id === id ? { ...c, text: body } : c))
}

export const removeComment = (comments: readonly ReviewComment[], id: string): ReviewComment[] => comments.filter((c) => c.id !== id)

/** The reading order: by path as the panel sorts it, then up the file, then as they were written. */
export function sortComments(comments: readonly ReviewComment[]): ReviewComment[] {
  return comments
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.path < b.c.path ? -1 : a.c.path > b.c.path ? 1 : a.c.from - b.c.from || a.c.to - b.c.to || a.i - b.i))
    .map((e) => e.c)
}

/** A fence longer than any backtick run inside the text, so a quote holding its own fences still comes through. */
function fenceFor(text: string): string {
  let longest = 0
  for (const m of text.match(/`+/g) ?? []) if (m.length > longest) longest = m.length
  return '`'.repeat(Math.max(3, longest + 1))
}

/** `n places`, or `1 place`. */
const places = (n: number): string => `${n} ${n === 1 ? 'place' : 'places'}`

/**
 * The one user turn Send review posts: a line saying how many places, then each comment's range, the lines it quoted
 * and the text. Ordinary message text, so Edit, Resend, versions and the queue all work on it unchanged.
 */
export function reviewMessage(comments: readonly ReviewComment[]): string {
  const sorted = sortComments(comments)
  if (sorted.length === 0) return ''
  const parts = sorted.map((c) => {
    const fence = fenceFor(c.quote)
    const quote = c.quote === '' ? '' : `${fence}\n${c.quote}\n${fence}\n`
    return `\`${rangeOf(c)}\`${marks(c)}\n${quote}${c.text}`
  })
  return `Review of ${places(sorted.length)} in the changes.\n\n${parts.join('\n\n')}\n`
}
