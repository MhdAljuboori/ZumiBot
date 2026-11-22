import { rangeOf, type ReviewComment } from '@zumibot/shared/reviewComments'

// The review draft of one chat, kept per device: it lives minutes, is cleared on send, and never reaches the server.
// Storage can be missing or throw (a private window, blocked site data), so every access is guarded and a bad value
// reads as no draft.

export const draftKey = (chatId: string): string => `zumibot:review:${chatId}`

const isComment = (v: unknown): v is ReviewComment => {
  const c = v as Partial<ReviewComment> | null
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.id === 'string' &&
    typeof c.path === 'string' &&
    typeof c.text === 'string' &&
    typeof c.quote === 'string' &&
    typeof c.from === 'number' &&
    typeof c.to === 'number' &&
    Number.isFinite(c.from) &&
    Number.isFinite(c.to) &&
    typeof c.old === 'boolean' &&
    typeof c.at === 'number' &&
    (c.scope === 'uncommitted' || c.scope === 'base')
  )
}

/** A stored draft, or none: anything that is not a list of comments is dropped rather than half-read. */
export function parseDraft(raw: string | null): ReviewComment[] {
  if (raw === null) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) && v.every(isComment) ? (v as ReviewComment[]) : []
  } catch {
    return []
  }
}

export function loadDraft(chatId: string): ReviewComment[] {
  try {
    return parseDraft(localStorage.getItem(draftKey(chatId)))
  } catch {
    return []
  }
}

/** Writes the draft, or removes the key once it is empty, so an unused chat leaves nothing behind. */
export function saveDraft(chatId: string, comments: readonly ReviewComment[]): void {
  try {
    if (comments.length === 0) localStorage.removeItem(draftKey(chatId))
    else localStorage.setItem(draftKey(chatId), JSON.stringify(comments))
  } catch {
    // storage unavailable: the draft simply isn't kept across a reload
  }
}

export const clearDraft = (chatId: string): void => saveDraft(chatId, [])

/** "3 comments" / "1 comment". */
export const draftCount = (n: number): string => `${n} ${n === 1 ? 'comment' : 'comments'}`

/** What a draft row shows: where it sits, and the first line of what was written. */
export function commentRow(c: ReviewComment): { where: string; first: string } {
  const first = c.text.split('\n').find((l) => l.trim() !== '') ?? ''
  return { where: rangeOf(c), first: first.trim() }
}
