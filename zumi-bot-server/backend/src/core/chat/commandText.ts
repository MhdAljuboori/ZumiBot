import { cardAskComment, cardAskPrompt, splitTodo } from '@zumibot/shared/todos'
import type { ChatItem } from '@zumibot/shared/types'
import { TODO_REQUEST } from '../todos/todoPrompt'

type UserItem = Extract<ChatItem, { type: 'user' }>

/** Whether a message asks its agent for to-dos: a `/todo` message, or a command that makes them. The one flag every send path sets. */
export const asksTodos = (user: Pick<UserItem, 'todo' | 'command'>): boolean => user.todo === true || user.command?.todos === true

/**
 * What `reader` is shown for a user message: the filled prompt of its own command, the typed text for anyone else; a card ask wraps either in its card's context.
 * A to-do message loses its `/todo` and ends with the request line, for every reader: whichever member answers it
 * should put its action items on the list. The stored text is untouched (the bubble and the moderator read that).
 * `bridges`: false for a reader without ZumiBot's to-do tools (ACP, remote): the request line is left off, since it names
 * tools that reader lacks (and a remote host would be sent ZumiBot's own instruction). A new message is refused before
 * it gets here; this keeps an older one in a reseeded history from carrying it.
 */
export function readAs(user: UserItem, reader: string, bridges = true): string {
  const body = user.command && user.command.agent === reader ? user.command.prompt : user.todo ? splitTodo(user.text).rest : user.text
  const text = !user.todo || !bridges ? body : body === '' ? TODO_REQUEST : `${body}\n\n${TODO_REQUEST}`
  // A routed card ask shows its written line but quotes the comment itself, the ground truth the line was made from.
  return user.cardAsk ? cardAskPrompt(user.cardAsk, cardAskComment(user.cardAsk, text)) : text
}

/** The items as `reader` saw them (for a reseed); only user messages with a command of its own, a to-do request or a card ask change. */
export function withCommands(items: readonly ChatItem[], reader: string, bridges = true): ChatItem[] {
  return items.map((it) =>
    it.type === 'user' && (it.command?.agent === reader || it.todo || it.cardAsk) ? { ...it, text: readAs(it, reader, bridges) } : it
  )
}
