# Card comment asks: comment bubble plus inline card

Short design, approved 2026-11-23.

## Why

An `@agent` mention in a card's comment sends the agent one long message (`commentAskMessage`: the card's title and id,
notes, every earlier comment, the comment, command prompts, the closing line). That whole text is stored as the user
item's `text`, so the comment chat shows it as one hard-to-read bubble. The user wants the bubble to show their comment
and a small inline card instead. The agent must still read the full context.

## Goals

- The comment chat's user bubble shows only the comment (mentions and `/commands` drawn as anywhere else).
- Above it, an inline card: the card's title, its live status from the board (or "Card removed"), and Open card → to
  `/todos/<id>`.
- Under the row, **Full prompt** (as a sent command has) shows exactly what the agent read.
- What the agent reads stays byte-for-byte what it reads today, on send, Resend, Edit and a reseed.

## Non-goals

- Old comment chats keep their stored long text (no migration, no parsing).
- No change to the card's own comment thread or to how the reply is posted.

## Approaches

1. **Structured field (picked).** The user item gets `cardAsk {todoId, title, before, after}`; `text` is the comment.
   `readAs` composes `before + quote(text) + after` for the CLI, as a command's filled prompt is swapped in today.
   Search, sidebar preview, the ack line, export and Edit see the comment. Costs a new field threaded through
   TaskQueue, ChatService and QueuedTask.
2. **Display-only parse.** The frontend splits the stored text in `cardComments` chats, as workflow input blocks are
   drawn. Fixes old messages, but breaks on notes or command prompts holding the marker lines, and search, Edit and
   Copy still see the wall of text. Rejected.

## Design

- `shared/src/todos.ts`: `CardAsk {todoId, title, before, after}` and `cardAskPrompt(ask, text)` (the quote rule moves
  here from `taskPrompt.ts`). `before` ends with `The user's comment:\n\n`; `after` starts with `\n\n`.
- `taskPrompt.ts`: `commentAsk(item, comment, commands, images): CardAsk`. `commentAskMessage` was removed once nothing
  called it; tests pin `cardAskPrompt(commentAsk(...), comment.text)` against literal strings of the old message.
- `ChatItem` user and `QueuedTask` get `cardAsk?`. `TaskQueue.submit` takes it in `SubmitOptions`; `launch`,
  `launchTask` and `ChatService.send`/`sendTurn` carry it as a trailing slot (no trailing undefined, as `withAuto` does).
- `readAs` wraps the usual body in `cardAskPrompt` when the item has `cardAsk`; `withCommands` maps such items too.
- Resend and Edit keep `old.cardAsk` (an edited comment is still read inside the card's context; `after` keeps the
  original command prompts).
- `CommentAsks.ask` submits the comment text with `cardAsk`; the chat title stays `Comments · <card>`.
- Frontend: `CardAskCard` above the bubble (title, status from the board the app holds through a small context,
  Open card → via `AppLink`), `FullPrompt` generalised to take the prompt text.
- Docs: `todos.md` Threads section updated.

## Left to the builder

Class names and the exact card styling (app tokens only, so dark mode follows).
