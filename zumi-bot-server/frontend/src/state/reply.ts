import type { ChatItem } from '@zumibot/shared/types'

type AssistantItem = Extract<ChatItem, { type: 'assistant' }>

/** The agent message with this id, or undefined when there is none. */
export function findReplied(items: readonly ChatItem[], id: string | null | undefined): AssistantItem | undefined {
  if (!id) return undefined
  return items.find((i): i is AssistantItem => i.type === 'assistant' && i.id === id)
}

/** An agent message as one line of plain text, for a reply's quote: markdown marks dropped, whitespace collapsed. */
export function replySnippet(text: string): string {
  return text
    .replace(/^```.*$/gm, '')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Selected text as a markdown quote: every line behind `> `, blank lines kept as a bare `>` so the quote stays one block. */
export function quoteMarkdown(selected: string): string {
  return selected
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n')
}

/**
 * The draft with the selected text quoted after it, then an empty line for what is typed next. The composer reads each
 * line as a paragraph, so a blank line would show as an empty one; only a quote right before keeps one, or the two would merge.
 */
export function withQuote(draft: string, selected: string): string {
  const before = draft.trimEnd()
  const gap = before === '' ? '' : before.split('\n').pop()!.startsWith('>') ? '\n\n' : '\n'
  return `${before}${gap}${quoteMarkdown(selected)}\n`
}

/** The message Explain sends: the selected text quoted, then the ask on the next line (a blank one would show as an empty paragraph). */
export function explainText(selected: string): string {
  return `${quoteMarkdown(selected)}\nExplain this selected text`
}
