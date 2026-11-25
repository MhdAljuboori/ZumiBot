import type { ChatItem } from '@zumibot/shared/types'

type AssistantItem = Extract<ChatItem, { type: 'assistant' }>

/** The quote of a replied-to message stops here: the agent already has the whole message in its session. */
export const REPLY_QUOTE_MAX = 1000

/** The agent message with this id, or undefined when there is none (or the id is of another kind of item). */
export function repliedItem(items: readonly ChatItem[], id: string | undefined): AssistantItem | undefined {
  if (id === undefined) return undefined
  return items.find((i): i is AssistantItem => i.type === 'assistant' && i.id === id)
}

/**
 * The user's text, after a quote of the agent message it replies to. `after` puts the quote behind the text instead: a Claude
 * command only runs as the first thing in the message, so a quote in front would turn it into plain text.
 */
export function withReply(text: string, quoted: AssistantItem | undefined, after = false): string {
  if (!quoted) return text
  const chars = [...quoted.text]
  const body = chars.length > REPLY_QUOTE_MAX ? chars.slice(0, REPLY_QUOTE_MAX).join('') + '…' : quoted.text
  const note = `<reply_to${quoted.agent ? ` from="${quoted.agent}"` : ''}>\n${body}\n</reply_to>`
  return text === '' ? note : after ? `${text}\n\n${note}` : `${note}\n\n${text}`
}

/** The items with each reply's quote put in front of its text, as the agents read them. */
export function withReplies(items: readonly ChatItem[]): ChatItem[] {
  return items.map((it) => (it.type === 'user' && it.replyTo ? { ...it, text: withReply(it.text, repliedItem(items, it.replyTo)) } : it))
}
