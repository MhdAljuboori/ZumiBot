# Queued follow-up messages ("Tasks") — design

Date: 2026-10-26

## Why

While an agent works, the user often thinks of the next thing to ask. Today a single chat refuses the message
("Chat is already running") and a group chat drops it straight into the conversation, where the moderator may hand it
to an idle member while others are still mid-turn. The user wants the Claude Code desktop behaviour instead: a message
sent mid-run waits in a visible queue and goes in, on its own, the moment the current work ends.

## What the user sees

- The agent (or any group member) is working. The user types and hits **Send**. The message does **not** enter the
  chat. It becomes a row in a **Tasks** section above the composer.
- Several sends make several rows, oldest first.
- When the current run ends, the first task goes into the chat at once as a normal user message and leaves the list.
  Its reply runs; when that ends, the next task goes in, and so on. One task per turn, never merged.
- **Stop** ends the current run like any other end: the next task then goes in. (The user's choice: Stop does not
  hold or return the queue.)
- Each task row has a small **×** that removes it before it is sent, and (only while the chat is idle) an **Enter**
  button that sends that task now and removes it from the queue. Tasks cannot be edited or reordered.
- **Paused group** (agent-to-agent hop cap reached): queued tasks do **not** go in; the queue holds and the room stays
  stopped. The user can then write a new message (it is sent at once; the queued tasks stay) or press Enter on a task.
- The queue lives on the server: it survives a reload or a closed tab and shows the same in every tab and device.
- Layout above the composer, top to bottom: **Tasks**, then **Working now** (groups only, as today), then the
  composer. Each section has a header with a caret and collapses/expands on its own. A collapsed header still shows
  its count, e.g. `Tasks · 3`.
- Look follows the user's reference (Claude Code's "3 in queue" list): small muted uppercase header with caret, rows
  with a hollow circle and the message text on one line, cut with an ellipsis.

### Single chats vs. groups

- **Single chats** gain send-while-running (the Composer's `allowSendWhileRunning`, as groups have): with text in the
  box the button is Send, with an empty box it is Stop. Single chats show only the Tasks section; they have no
  Working now tray and don't get one.
- **Groups** switch to the same queue: a message sent while the room is running (any member working, waiting on an
  approval, queued by the moderator, or the room winding down) waits in Tasks until the room has fully ended, then
  goes in. This replaces today's "goes straight in mid-run" behaviour.

## Goals / non-goals / anti-goals

Goals: the flow above, same for both chat types, server-owned, visible in every tab.

Non-goals: editing or reordering tasks; merging tasks into one message; a Working now tray for single chats; changing
the moderator.

Anti-goals (would make it a failure even if it "works"):
- A queued message appears in the chat before its turn, or appears twice (once as a pending bubble, once as a task).
- Tasks go in out of order, or two go in at once.
- A task is silently lost (on Stop, reload, or a send that races the end of a run).
- An approval card hides behind a collapsed Working now section.

## How (decided)

### Data

- `ChatMeta.tasks?: QueuedTask[]` (absent = none), saved in `chats.json` with the rest of the meta, so every
  `kind: 'meta'` push carries it to every tab.
- `QueuedTask = { id: string; text: string; attachments?: Attachment[]; replyTo?: string; ts: number }`. `id` is the
  client's message id (`mid`), reused as the stored user item's id at dispatch, so pending-send matching keeps working.
- Attachments are committed into the chat's folder when the task is queued (staged files are cleared on server start,
  so they can't wait in staging).

### Server: one dispatcher in front of both services

A new `TaskQueue` (backend `core/chat/taskQueue.ts`), built in `app.ts`, owns the rule. `chats:send` goes through it
for both chat types:

- `submit(chatId, text, attachments, replyTo, mid)`: if the chat is running (`chatService.isRunning`, which also covers
  group rooms because they claim the chat) **or** a dispatch for it is in progress → append a task and push meta;
  resolve at once. Otherwise dispatch now, exactly as today's handler does (an idle chat that holds tasks, i.e. a paused
  group, sends the written message straight away and keeps the tasks).
- `sendTask(chatId, taskId)`: the Enter button; refused with `Chat is busy` unless idle; removes that task and
  dispatches it. New RPC `chats:sendTask`.
- On idle, a group chat whose last item is the `paused` notice does not dispatch.
- `ChatService` gets an `onIdle(chatId)` callback, fired from `release()`. Both single turns and group rooms release
  through it, so this is the one "run ended" signal. On idle, `TaskQueue` takes the first task, saves the shortened
  list, pushes meta, and dispatches it through `ChatService.send` or `GroupService.send` as usual.
- A per-chat "dispatching" flag covers the gap between taking a task and the run claiming the chat (group `post`
  claims after a few awaits). It clears once the claim exists or the send fails.
- A dispatch that fails before a run starts (e.g. Claude CLI not found) is recorded the way that service already
  records it (error item); the queue then moves on to the next task.
- Stop needs nothing new: the run ends, `release` fires `onIdle`, the next task goes in.
- New RPC `chats:dropTask(chatId, taskId)` removes a task and pushes meta. Three-place rule from CLAUDE.md:
  `ZumiBotApi` in `shared/src/types.ts`, handler in `rpc/handlers.ts`, mapping in `frontend/src/net/api.ts`.
- Single-chat `chats:send` today resolves only when the turn ends; a queued send resolves as soon as the task is
  saved. Its return value tells the client which happened (`'queued' | 'sent'` or similar).
- `chats:remove` with tasks: the meta goes with the chat; nothing else to do.

### Client

- Sending while the chat runs (client's view: `chat.inFlight` or a send still on its way) does **not** add a pending
  bubble; the task appears from the meta push. If the server queues a send the client drew as a bubble (race), the
  bubble is dropped when the call returns "queued".
- A failed queued send restores the draft and shows the chat's send error, like a failed send today.
- New `TasksTray` component (beside `WorkingTray`) rendered by `ChatView` for both chat types when `chat.tasks` is
  non-empty; × calls `api.chats.dropTask`.
- `WorkingTray`'s "Working now" label becomes a toggle header with caret and count.
- Logic goes in pure modules under `src/state/` (frontend tests cover only those).

## My calls (builder may revisit; flagged for the user to check)

1. **Collapsed Working now still shows rows needing approval.** Matches the existing rule that an approval row is
   always open; keeps the anti-goal above.
2. **Collapse state is remembered per browser** (`localStorage`, wrapped in try/catch), one setting per section,
   the same across all chats. Defaults: both expanded.
3. **After a server restart, queued tasks are dispatched** once interrupted chats are recovered. The user asked for
   tasks to always flow (even after Stop), and a restart only happens mid-run under `deploy --force`.
4. **Removing a task deletes its committed attachment files.**
5. **Cap of 50 tasks per chat**; a send past it fails with a clear error.
6. A task that replies to a message shows a small reply mark; a task with files shows a paperclip and count. Text is
   the raw message (mentions as typed).

## Left to the builder

Exact names, CSS, max height of the Tasks list before it scrolls (keep the composer reachable on phones), test split
between backend unit tests (`TaskQueue` with fake services, handler tests) and an e2e case in `e2e:group` plus the
single-chat suite.
