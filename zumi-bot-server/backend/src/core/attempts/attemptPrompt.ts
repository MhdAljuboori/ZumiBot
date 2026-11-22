import type { TodoItem } from '@zumibot/shared/todos'

// What an attempt's chat is told, through the message itself — never the appended system prompt, which must stay the
// same for every chat or every prompt cache misses.

/**
 * The first message of one attempt's chat: the card, then what being one of several tries means. An attempt chat has no
 * `task` link, so the card tools refuse there; the agent reports by ending its turn with a summary instead, and the
 * user picks a winner on the card.
 */
export function attemptMessage(item: Pick<TodoItem, 'text' | 'description'>, o: { n: number; total: number }): string {
  const card = item.description ? `Task: ${item.text}\n\n${item.description}` : `Task: ${item.text}`
  return [
    card,
    '',
    '---',
    `This is attempt ${o.n} of ${o.total}. ${o.total} agents were given this same task at once, each in its own git worktree made from the same commit, and the user will compare the results and keep one.`,
    "- Work only in this chat's own folder. The other attempts are elsewhere and you cannot see them; do not look for them, and do not try to coordinate.",
    '- Commit your work on this branch when it is ready. The user reviews the diff since the worktree started, so uncommitted work is fine too, but committing makes it easier to read.',
    '- End your turn with a short summary of what you did and how to check it. Do not call the task-card tools: this chat is not linked to the card, and they will refuse.',
    'This last part is from ZumiBot, not the user.'
  ].join('\n')
}
