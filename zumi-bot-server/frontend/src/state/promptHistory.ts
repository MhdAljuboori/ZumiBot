import type { ChatItem, QueuedTask } from '@zumibot/shared/types'

/** The messages the user sent in a chat, oldest first, then the queued ones; a repeated text is kept once, where it was sent last. */
export function sentTexts(items: readonly ChatItem[], tasks: readonly QueuedTask[] = []): string[] {
  const texts = [...items.flatMap((i) => (i.type === 'user' ? [i.text] : [])), ...tasks.map((t) => t.text)]
  const seen = new Set<string>()
  const kept: string[] = []
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i]
    if (text.trim() === '' || seen.has(text)) continue
    seen.add(text)
    kept.push(text)
  }
  return kept.reverse()
}

/** A recalled message the box shows: its place in the history, and the draft it replaced. */
export interface Browse {
  index: number
  saved: string
  shown: string
}

// Still browsing only while the box holds the recalled text untouched: an edit makes it a new draft, which is then
// saved like any other, so no typed text is lost by walking the history.
const browsing = (history: readonly string[], browse: Browse | null, draft: string): Browse | null =>
  browse !== null && browse.shown === draft && history[browse.index] === draft ? browse : null

/** What the box shows after a step: the text, and where that leaves the browsing (null: back on the draft). */
export interface Step {
  browse: Browse | null
  text: string
}

/** Up: the message before the one shown, or the newest one (saving the draft); null when there is none further back. */
export function older(history: readonly string[], browse: Browse | null, draft: string): Step | null {
  const at = browsing(history, browse, draft)
  let index = (at ? at.index : history.length) - 1
  // The box already holds the newest message (sent again from it): showing it again would look like nothing happened.
  if (!at && history[index] === draft) index--
  if (index < 0) return null
  return { browse: { index, saved: at ? at.saved : draft, shown: history[index] }, text: history[index] }
}

/** Down: the message after the one shown, or past the newest the saved draft (browse null); null when not browsing. */
export function newer(history: readonly string[], browse: Browse | null, draft: string): Step | null {
  const at = browsing(history, browse, draft)
  if (!at) return null
  const index = at.index + 1
  if (index >= history.length) return { browse: null, text: at.saved }
  return { browse: { index, saved: at.saved, shown: history[index] }, text: history[index] }
}
