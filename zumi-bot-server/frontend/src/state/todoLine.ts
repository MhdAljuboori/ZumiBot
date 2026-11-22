import type { TodoTouch } from '@zumibot/shared/todos'

// A link or image, its target allowing one level of balanced parentheses (`…/Foo_(bar)`) and an optional title.
const LINK = /!?\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*(?:\s+"[^"]*")?\)/g

/** An item's text as the plain words a one-line notice shows: a link keeps its text, bold and code markers go. */
export function plainTodoText(text: string): string {
  return text.replace(LINK, '$1').replace(/\*\*|`/g, '')
}

/**
 * What a turn did to the to-do list, as the chat shows it under the reply: a chip for the new items (it opens the panel)
 * and one line per tick, untick and removal. In a room each line names the member. The texts are the items' own.
 */
export function todoLines(touch: TodoTouch | undefined, roomAgent: string | null): { chip: string | null; lines: string[] } {
  if (!touch) return { chip: null, lines: [] }
  const prefix = roomAgent === null ? '' : `${roomAgent}: `
  const lines = [
    ...touch.ticked.map((t) => `☑ Ticked: ${plainTodoText(t)}`),
    ...touch.unticked.map((t) => `☐ Unticked: ${plainTodoText(t)}`),
    ...touch.removed.map((t) => `✕ Removed: ${plainTodoText(t)}`),
    ...(touch.asked ?? []).map((t) => `? Asked on the task card: ${plainTodoText(t.replace(/\s+/g, ' '))}`),
    ...(touch.review ? ['✓ Marked the task card ready for review'] : []),
    ...(touch.commented ?? []).map((t) => `💬 Commented on: ${plainTodoText(t)}`)
  ].map((l) => prefix + l)
  return { chip: touch.added > 0 ? `☑ ${touch.added} new to-do${touch.added === 1 ? '' : 's'}` : null, lines }
}
