import { splitTodo } from '@zumibot/shared/todos'
import type { ChatItem } from '@zumibot/shared/types'
import type { UserContent } from '../chat/controlProtocol'

// Same text on every turn of every agent, so the prompt cache holds; what changes goes in the state note instead.
export const TODO_SYSTEM = [
  'The user keeps one task board in ZumiBot, with the columns New, To do, Blocked, In progress, In review and Done. Each card has a creator and an assignee (the user, an agent, or nobody); an agent starts on a card when the user moves it to To do. Every agent sees the whole board and changes it with the zumibot_todos tools: mcp__zumibot_todos__list, mcp__zumibot_todos__add, mcp__zumibot_todos__check, mcp__zumibot_todos__remove and mcp__zumibot_todos__comment.',
  "- Add items only when the user's message asks for a to-do list. They go into New, with you as their creator and nobody assigned.",
  '- An item is one short, actionable line about something the user has to do, with its link if there is one. Leave out anything that needs nothing from the user.',
  '- Put everything needed to act on an item in its description: the context from your reply, names, links, numbers, dates, what was asked and why. The user may give the item to another agent that never sees this chat, so the description must stand on its own.',
  "- Use your reply's own headings as each item's group.",
  '- Before adding, look at the open items and skip anything already on the board, even when it is worded differently.',
  '- Tick an item (check, done true) when you finished it for the user in this turn, or when the user says it is done. Untick it (done false) when the user says so.',
  '- Remove an item only when the user asks you to.',
  '- Cards carry comments from the user and agents. Comment on a card (comment) to give the user an update on it or to answer a comment there.',
  '- Item ids are for these tools only: never show them to the user.',
  "- When the board changed since your last turn, the user's message ends with a note on what changed. That note is from ZumiBot, not the user."
].join('\n')

export const TODO_REQUEST =
  "Put the action items of your reply on the user's task board with the zumibot_todos tools, each with a description that holds everything needed to act on it."

/** The message plus a text of ZumiBot's own: after a blank line, or as a last block after any images. */
export function withTrailingText(content: UserContent, text: string): UserContent {
  if (typeof content !== 'string') return [...content, { type: 'text', text }]
  return content === '' ? text : `${content}\n\n${text}`
}

const LABEL_MAX = 40

/** What a turn's to-dos are grouped under: the latest user message's command, else the start of its text. */
export function todoLabel(items: readonly ChatItem[]): string {
  const user = [...items].reverse().find((i): i is Extract<ChatItem, { type: 'user' }> => i.type === 'user')
  if (!user) return ''
  if (user.command) return `/${user.command.name}`
  // By code point, so the cut never splits an emoji.
  return [...splitTodo(user.text).rest.replace(/\s+/g, ' ').trim()].slice(0, LABEL_MAX).join('').trim()
}
