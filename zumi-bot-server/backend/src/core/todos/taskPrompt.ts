import {
  liveComments,
  quoteLines as quote,
  unanswered,
  type CardAsk,
  type TodoComment,
  type TodoItem,
  type TodoQuestion
} from '@zumibot/shared/todos'
import type { CommentCommand } from '@zumibot/shared/commentCommands'

// A task chat's agent is told what the card is through the message itself (the first message is the card, every turn
// ends with taskNote), never the appended system prompt: that must stay the same for every chat, or the prompt cache misses.

/** AskUserQuestion is denied with this in a task chat: nobody watches the chat, the card is where the user answers. */
export const TASK_QUESTIONS_DENIED =
  'This chat works on a task card: put your questions on it with mcp__zumibot_todos__ask_user, then end your turn.'

const author = (by: string): string => (by === 'user' ? 'The user' : by)

// Comments go into the message whole (the board note cuts them to a line), up to this much; the oldest are left out first.
const COMMENTS_MAX = 8_000

/** The card's comments as the agent reads them: a heading, then each author and its quoted text, oldest first. */
function commentsBlock(comments: readonly TodoComment[], heading: string): string {
  const kept: string[] = []
  let len = 0
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!
    const part = `${author(c.by)}${c.editedAt !== undefined ? ' (edited)' : ''}:\n${quote(c.text)}`
    if (kept.length > 0 && len + part.length > COMMENTS_MAX) break
    kept.unshift(part)
    len += part.length + 2
  }
  const left = comments.length - kept.length
  const more =
    left > 0 ? [`(${left} older ${left === 1 ? 'comment is' : 'comments are'} not shown: call mcp__zumibot_todos__list to read them.)`] : []
  return [heading, ...more, ...kept].join('\n\n')
}

/**
 * The first message of a task's chat: the card's title, notes and comments (its files go as the message's attachments).
 * Plain, as a user bubble shows it.
 */
export function taskMessage(item: Pick<TodoItem, 'text' | 'description' | 'comments'>): string {
  const parts = [`Task: ${item.text}`]
  if (item.description) parts.push(item.description)
  const comments = liveComments(item)
  if (comments.length > 0) parts.push(commentsBlock(comments, 'Comments on the card:'))
  return parts.join('\n\n')
}

/**
 * What an agent the user mentioned in a card's comment is sent, in two parts around the comment: the card (id for the
 * to-do tools, notes, earlier comments) and the instructions. Its reply is posted on the card under that comment, so it
 * is told to end with the answer.
 */
export function commentAsk(
  item: Pick<TodoItem, 'id' | 'text' | 'description' | 'comments'>,
  comment: Pick<TodoComment, 'id'>,
  commands: readonly CommentCommand[] = [],
  images = 0
): CardAsk {
  const before = [`The user mentioned you in a comment on the task card "${item.text}" (id ${item.id}, for the zumibot_todos tools).`]
  if (item.description) before.push(`The card's notes:\n\n${item.description}`)
  if (images > 0)
    before.push(
      images === 1 ? "The card's image is attached to this message." : `The card's ${images} images are attached to this message.`
    )
  const earlier = liveComments(item).filter((c) => c.id !== comment.id)
  if (earlier.length > 0) before.push(commentsBlock(earlier, 'Earlier comments on the card:'))
  before.push("The user's comment:")
  const after: string[] = []
  // The comment shows only "/card"; the agent reads the saved prompt it stands for, as a chat's command does.
  for (const c of commands) after.push(`The comment runs your command /${c.name}. Its instructions:\n\n${c.prompt}`)
  after.push(
    `Do what the comment asks${commands.length > 0 ? ', following those instructions' : ''}. Your final message is posted on the card as your reply to this comment, so end with a short answer the user can read there.`
  )
  return { todoId: item.id, title: item.text, before: `${before.join('\n\n')}\n\n`, after: `\n\n${after.join('\n\n')}` }
}

/** What a task chat is sent when its card goes back to To do: the agent picks up where it left off. */
export const CONTINUE_MESSAGE = 'Carry on with the task on the card.'

/**
 * The To do message for a task chat that already ran: CONTINUE_MESSAGE, plus the comments others wrote or edited on the
 * card since `since` (the chat's last reply), so a comment that asks for more is read before the agent goes on.
 */
export function continueMessage(item: Pick<TodoItem, 'comments'>, agent: string, since: number): string {
  const fresh = liveComments(item).filter((c) => c.by !== agent && (c.editedAt ?? c.at) > since)
  return fresh.length > 0
    ? `${CONTINUE_MESSAGE}\n\n${commentsBlock(fresh, 'New comments on the card since your last reply:')}`
    : CONTINUE_MESSAGE
}

/** The user's answers from the card, sent to the task's chat as one message: each question quoted, its answer under it. */
export function answersMessage(answered: readonly TodoQuestion[]): string {
  const parts = ['Answers to your questions on the task card:']
  for (const q of answered) parts.push(`${quote(q.text)}\n\n${q.answer?.text ?? ''}`)
  return parts.join('\n\n')
}

/** After every message of a task's chat, for the CLI only (never an item). */
export function taskNote(item: TodoItem | null): string {
  if (item === null)
    return 'This chat worked on a task card that the user removed. Finish what you are doing and say so in your reply. This note is from ZumiBot, not the user.'
  const lines = [
    `This chat works on a task card on the user's task board in ZumiBot: "${item.text}". The user follows the card, which shows your questions and your review.`,
    '- To ask the user something, call mcp__zumibot_todos__ask_user with all your questions at once, then end your turn. The answers come back as a new message. Never use AskUserQuestion in this chat.',
    '- When the task is done, call mcp__zumibot_todos__ready_for_review with a short summary of what you did and how to check it, then end your turn. The user ticks the card when they agree, or writes back.'
  ]
  lines.push(
    '- The user may comment on the card; their new comments reach you in the board note. Answer one with mcp__zumibot_todos__comment, or act on it.'
  )
  const open = unanswered(item).length
  if (open > 0) lines.push(`${open} of your questions on the card still wait for the user.`)
  if (item.done !== null) lines.push('The user already ticked this card done.')
  lines.push('This note is from ZumiBot, not the user.')
  return lines.join('\n')
}
