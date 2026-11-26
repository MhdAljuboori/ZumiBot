# Mid-turn messages (Enter sends into the running reply) — design

## Intent

While an agent works on a reply, the user often thinks of a detail it should know ("also check the tests", "use the v2 API"). Today
they wait, or their Enter quietly queues the message as a task that runs only after the whole reply ends — too late to steer the
work. The user wants:

- **Enter** while a reply runs: the message goes **into that reply**. The agent reads it at its next step and continues with it,
  without stopping.
- **Ctrl+Enter** (Cmd+Enter on a Mac): the message is **queued** as a task, exactly as Enter does today.

## Goals

- A single chat whose agent runs on Claude takes a user message mid-turn, at the agent's next tool step.
- The message shows in the thread where the agent took it in, as the user's own bubble.
- Nothing the user writes is ever lost: a message the agent never took in goes back to the task tray.
- Ctrl/Cmd+Enter keeps today's queue behaviour; on an idle chat both keys just send.

## Non-goals

- Group rooms, Codex, ACP and AG-UI agents, and the Claude SDK adapter (`claudeSdkEngine.ts`): they keep queueing on Enter.
  (Codex may have a steer request in its app-server; not wired now.)
- Mid-turn messages from routines, workflows, channels (Telegram/Slack), voice talk, the To-dos page box, the Continue pill or
  a Run result: only the composer's Enter steers. Every other caller of `chats:send` / `TaskQueue.submit` behaves as today.
- Editing, resending or forking from a mid-turn message.
- Removing ("unsending") a message once it went into the running reply.

## Anti-goals (a failure even if it "works")

- A message silently lost (Stop, crash, restart or a turn that ends before the agent reads it).
- A message shown twice (as a pending row and a bubble, or as a bubble and a task).
- A turn's cost counted twice.
- Edit/Resend/Fork cutting the session at a wrong point because a mid-turn message sits inside the turn.
- A slash command, `/todo` or `/btw` written mid-turn reaching the CLI as raw text.

## How the CLI behaves (probed on claude 2.1.329)

ZumiBot runs `claude -p --input-format stream-json --output-format stream-json` and writes the turn's prompt to stdin. A second
user message written to stdin while the turn runs:

1. **A tool step is still ahead**: the CLI takes the message in right after the next tool result, and the same turn continues
   with it. One `result` event. Seen: the agent ran an extra command the second message asked for, inside the first turn.
2. **No tool step left** (the agent is already writing its final text): the first `result` comes as usual, then the CLI starts a
   **second turn in the same process** on the message (a new `system/init` with the same session id), and a second `result`
   follows. This happened even though ZumiBot closed stdin at the first result: the line was already read.
3. With `--replay-user-messages`, the CLI echoes each stdin user message back on stdout, as a `type: "user"` line with
   `isReplay: true` and the **uuid we sent**, at the moment it takes it in (case 1: after the tool result; case 2: after the second
   `init`). The turn's own prompt is echoed too, at its start.
4. `total_cost_usd` on the second `result` is **cumulative for the process** (first 0.0057, second 0.0094).

## Approaches

| | How | Trade-off |
|---|---|---|
| **A. Write into the running CLI's stdin (picked)** | `RunHandle.steer` writes a stream-json user message; `--replay-user-messages` tells us when it lands. | Native CLI behaviour, no lost work, the message is a real user entry in the session. Depends on CLI behaviour, so e2e must check it after each Claude Code update. |
| B. Stop the turn and resume with the new message | Interrupt, then `--resume` with the extra text. | Throws away in-flight tool work, costs a new request, the reply visibly restarts. Not "continue its work". |
| C. A hook feeds notes as `additionalContext` | A PostToolUse hook reads a per-chat notes file. | Not a user message in the session (invisible to Edit/Fork logic), extra hook plumbing, Claude-only anyway. |

The user approved **A**.

## Design

### Shared (`zumi-bot-server/shared`)

- `SendResult = 'sent' | 'queued' | 'steered'`.
- `ChatMeta.steering?: QueuedTask[]` — messages written into the running reply that the agent has not taken in yet, oldest
  first. Absent = none. Persisted in the meta so every tab draws them and a restart can recover them.
- User `ChatItem` gains `steered?: true`: the message went into a running reply. Such a bubble offers no Edit, Resend or Fork.
- `ZumiBotApi.chats.send(..., command, steer?: true)`: a new trailing argument. Only the composer passes it, on Enter.

### Backend

**Runner** (`claudeRunner.ts`, `claudeEngine.ts`, `engine.ts`):

- `buildArgs` takes `replayUser?: boolean` and adds `--replay-user-messages` when set. Set only for a single chat's Claude
  turns (not rooms, side runs, keep-warm pings, compaction or the SDK adapter), so nothing else sees new events.
- `RunHandle.steer?(content: UserContent, uuid: string): boolean` — optional. The CLI adapter implements it: writes
  `encodeUserMessage(content, uuid)` while stdin is open, else returns false. Engines without it fall back to the queue.
- Stdin closes at a `result` only when every steer written to this handle has been replayed. With one still unread, it stays
  open (the CLI's second turn may need approvals, question or plan cards answered over stdin) and closes at the next `result`
  with none pending. A short grace timer (a few seconds) after such a `result` closes it anyway when no replay or `init`
  arrives, so a message the CLI never reads cannot keep the process, and the chat, running. *(Builder-check answer, my call.)*
- A steer after stdin closed returns false → queued.

**Parser** (`streamParser.ts`): a `type: "user"` line with `isReplay: true` and a uuid becomes
`{ kind: 'userReplay'; uuid: string }`, and **no** `entry` event: today every top-level user line with a uuid yields `entry`,
which sets the turn's `tip` (the next `end.at` and assistant `cut`); a replay must not become a cut point. Every other consumer
ignores the new kind.

**ChatService**:

- `steer(chatId, task: QueuedTask): Promise<boolean>`: true only when the chat is a single chat with one running Claude turn
  whose slot installed a steer path, and that turn is a real turn (not a compaction, not being stopped, not a cut run that was
  ignored). Otherwise false and nothing changes.
- **Only turns the user started take a steer** *(my call)*: not a routine's or process's turn (`spec.auto`), not a workflow
  Agent step's chat (`meta.workflow`), not an asked A→B chat (`meta.asked`), not a card-comment turn. Their reply is data that
  flows elsewhere; a message there queues as today.
- **Attachments** *(my call)*: images go in as content blocks and always steer. A non-image file needs the attachments folder in
  the run's `--add-dir`; when the running process was started without it, the message queues instead.
- The running turn (`agentTurn`) installs `slot.steer`. It:
  1. builds the message's content exactly like a turn's prompt from a user item (the same `readAs`/`withReply`/attachment refs
     path, without the turn-start notes; extract a shared helper rather than copy it),
  2. adds the task to `meta.steering` **before** writing (a fast replay must find it), pushes the meta,
  3. calls `handle.steer(content, task.id)` (message ids are already `crypto.randomUUID()`); on false, removes it again and
     returns false.
- On `userReplay` whose uuid is one of this turn's steered tasks: append a user item
  `{ type: 'user', id, text, ts: now, attachments?, replyTo?, steered: true }` to the items (after everything so far), drop
  the task from `meta.steering`, save and push both. Replays of other uuids (the turn's own prompt) are ignored.
- **Second result in one process** (case 2): report only the cost growth since the attempt's previous `result`
  (`total_cost_usd` is cumulative), so spend and usage never count the first part twice. The turn's text, end stamp (`end`)
  and `sent` stay as today: `end` lands on the turn's last item, `sent` stays the original prompt's uuid.
- **Attempt ends with steered tasks never replayed** (Stop, crash, error, a retry attempt): they go back to the **front** of
  `meta.tasks`, in order, and leave `meta.steering`. The tray's `held` is not touched *(my call)*: today a Stop lets the pump send
  the next task, and an Edit/Resend holds the tray before its stop, so handed-back messages simply follow whatever the tray does.
- **Restart**: the startup recovery of interrupted chats moves any leftover `meta.steering` to the front of `meta.tasks` (held
  only as the recovery already holds the tray).

**TaskQueue.submit**: `SubmitOptions.steer?: true`. Under the chat's lock, when the chat is busy and all of these hold, it calls
`chats.steer` and returns `'steered'`: `from === 'user'`, a single chat (not a group), not paused or pausing, not compacting,
not waiting out a usage limit, no command, no `/todo`, no `once`/`cardAsk`/`run`. Attachments are committed first (as for a
task). If `chats.steer` returns false, it falls through to today's path (task, or a send if the chat went idle meanwhile).
`TASKS_MAX` counts `tasks + steering`.

**RPC** (`handlers.ts` `chats:send`): reads the new `steer` argument (`true` or absent; anything else rejected) and passes
`{ steer: true }` to `submit` only then.

### Frontend

- **Keys** (`Composer.tsx`, logic in a pure helper in `src/state/` so it is unit-tested): Enter (not on a touch keyboard) →
  send with steer; Ctrl/Cmd+Enter → send without steer (queues while busy, sends while idle). Shift+Enter stays a new line; a
  touch keyboard's Enter stays a new line, and its Ctrl/Cmd+Enter still sends (now: queues while busy).
- **Send button**: a click sends with steer; a long press (about 500 ms) sends without steer (queue). While a reply runs its
  tooltip says so ("Enter: add to this reply · Ctrl+Enter or hold: queue").
- **App.sendMessage** takes a `steer` flag and passes it to `api.chats.send`. While the chat is busy no optimistic bubble is drawn
  either way (as for a task today): the message shows from the meta push, as a steering row or a task row, so it never shows
  twice. `rejectedSendState`/`quietRejection` treat an id found in `meta.steering` like a queued one.
- **Steering rows**: in the tray above the composer, above the task rows: each mid-turn message waiting to be read, labelled
  "Waiting for the agent's next step", with no buttons. They disappear when the bubble lands or move to the task rows when handed
  back.
- **MessageList**: a user bubble with `steered` has no Edit, Resend or Fork actions.

### Edit, Resend, Fork

- Edit/Resend of the turn's **original** message: `droppedTurn` (`sessionPoints.ts`) declares no dropped turn once any later
  user item follows the message, and a steered bubble is one, so no `--resume-drops-turn` is passed and the cut runs at the
  previous turn's `end`, unvalidated. That drops both the original prompt and the steered entry, which is right. The plan must
  test that this cut drops the steered entry (a fake-claude run sees the cut point before both), and that the new version hides
  the old one's items, mid-turn bubble included.
- A cut point stamped on an assistant item after the steered message (Fork from that reply) is a normal entry uuid and works as
  today.

### Docs and tests

- New `docs/architecture/mid-turn-messages.md`, an index line in root `CLAUDE.md` (it is at 16 380 of 16 384 bytes: shorten
  another line to make room), and pointers in `edit-resend-fork.md`, `pause-resume.md` (tasks/held), `data.md`
  (`steering`), `ui.md` (keys, tray rows). User docs: the chatting page that covers sending/queueing.
- Unit tests: parser (`userReplay`), `buildArgs` flag, runner `steer` (open/closed stdin), TaskQueue steer and every fallback,
  ChatService with a fake claude that echoes a second stdin message mid-turn and in the late case (two results), hand-back on
  Stop and exit, restart recovery, cost delta; frontend pure helpers (key mapping, tray rows, send-state).
- E2E: `npm run e2e` gets a check that the installed `claude` still takes a mid-turn message and replays it, since the feature
  rests on that behaviour.

## Calls made after the builder check

1. Stdin stays open while a steer is unread, with a grace timer (late case approvals).
2. Only turns the user started take a steer; routine, workflow-step, asked-chat and card turns queue.
3. Handed-back messages go to the front of the tray without touching `held`.
4. A non-image attachment steers only when the run has the attachments folder; otherwise it queues.

## Left to the builder

- Exact names, the tray's markup and copy, the long-press timing.
- Whether the steer path lives on `TurnSlot` or beside it, and how the shared prompt helper is cut out of `runTurn`.
- Which existing doc line in root `CLAUDE.md` to shorten.
