# To-do cards and the task board

## Goal

A to-do stays what it is today, a checkbox and a one-line title, but it can be opened as a card from a very simple task
manager: notes, images, and an agent it is given to. The agent works on it in its own chat, puts its questions on the
card, and says when the work is ready for review. The user answers and ticks on the card, any time later.

## Decisions (asked and agreed)

- **Every to-do is a card**: a chat's and My to-dos', and the ones agents add.
- **A new chat per task**: Give starts a fresh chat with the chosen agent and folder; the first message is the card.
  Giving it again starts another chat; the old one stays.
- **Questions are asynchronous**: the agent calls `ask_user`, the questions land on the card, and the agent ends its
  turn. Nothing keeps a process waiting. The answers go to the task's chat as one user message, which starts the next turn
  (or waits in the queue while the chat runs).
- **Review, then the user ticks**: the agent calls `ready_for_review` with a summary. The user ticks the card, or writes
  back from the card, which ends the review. The row shows a status chip; there is no board.

## Shape

- Item fields, all optional: `description`, `files`, `task {agent, chatId, at, review}`, `questions[]`. A file without
  them is a plain to-do, so older files and `sync.mjs`, which joins whole items by `updatedAt`, need no change.
- The task chat carries `ChatMeta.task {list, todoId}`; the tools find the card through it, so the bridge still names
  no chat or item of its own.
- The agent learns about the card from its messages: the first one is the card, and every turn ends with a short note.
  The appended system prompt stays the same for every chat, so the prompt cache holds.
- `AskUserQuestion` is denied in a task chat, pointing at `ask_user`.
- Status is derived, never stored: done, chat deleted, waiting for you, needs approval, working, ready for review, given.

## Follow-up (asked and agreed)

- **Me as an assignee**: the Assign picker offers Me first. A card is unassigned, mine, or given to one agent; taking
  over an agent's card ends its task there (its chat stays).
- **Notes carry the context**: agents are told to put everything needed to act on a to-do in its notes, because a card
  may go to an agent that never sees the chat. A give still passes only the card, never the chat.
- **Inbox and push**: a card with an open question is a Waiting entry in the Inbox, answered in place, and the task
  chat's turn end that asked is a waiting notification (it respects the Waiting toggle) whose click opens the Inbox.

## The board (asked and agreed)

The per-chat lists, the To-dos page's column of chats and its message box are gone. One board holds every task.

- **Creator, not list**: an item records who added it (`addedBy`) and the chat it was made in (`from.chatId`, null for
  one added on the board). A chat's side panel shows the items made in it; fork and clone copy none.
- **Status columns** (first derived from the task; then stored, as asked): New, To do, Blocked, In progress, In review,
  Done. Any column takes a drop (or the card's Move to menu, or its Status picker).
- **Existing to-dos move over**: every chat's list and My to-dos fold into the board once at start, creator and chat kept.
- **Agents see the whole board**: in `list`, in every tool answer, and in the note before a turn. To keep that cheap, a
  session that already saw the board only hears what others changed since; a new session gets the open items.
- **Rail badge**: the open cards on the user's side (every one but those an agent has in To do or In progress).

## Statuses, creator and assignee (asked and agreed)

- **New** is the default. A card assigned to an agent stays put there: nothing starts until it moves.
- **To do** starts the assigned agent at once (a new chat with the card, or its chat told to carry on); the card goes to
  **In progress** when the turn starts, and several cards can run at once.
- **Blocked**: the agent's questions wait on the card (or approval cards in its chat). **In review**: the agent is done
  and the user checks; a turn that ends with neither a question nor a review lands there too. A stopped or failed turn
  goes back to New.
- **Done** is the tick. Moving a working card to **New** (or Done) stops its agent; To do again carries on in the same
  chat.
- Every card shows its **creator** (you or an agent) and its **assignee** (you, an agent, or nobody, the default). A card
  nobody has, moved to To do, asks who first.

## Not now

- Due dates, priorities, rooms as task owners, ordering cards by hand inside a column.
- A link from the task chat back to its card.
