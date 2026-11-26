# Mid-turn messages

While a single chat's reply runs, **Enter** sends the message *into that reply*: the agent reads it at its next step and goes on
with it, without stopping. **Ctrl+Enter** (Cmd+Enter on a Mac) queues it as a task instead, as Enter did before; on an idle chat
both keys just send. Internally a message into the running reply is a *steer*. Design: `docs/superpowers/specs/2026-11-26-mid-turn-messages-design.md`.

**The CLI behaviour it rests on** (probed on claude 2.1.329; `e2e/steerProbe.mjs` checks it, see below). A run is
`claude -p --input-format stream-json`; a second user line written to its stdin while the turn runs is taken in right after the
agent's next tool result, and the same turn goes on with it (one `result`). When no tool step is left (the agent is writing its
last text), the first `result` comes as usual and the CLI then runs a second turn in the same process on the message (a new
`init`, same session, a second `result`), even when stdin was closed after the line was read. With `--replay-user-messages` the
CLI echoes each stdin user message back (`type: "user"`, `isReplay: true`) under the uuid it was sent with, at the moment it
takes it in; the turn's own prompt is echoed too, at its start. `total_cost_usd` and the model usage of a second `result` count
the whole process (0.0057 then 0.0094 in the probe).

**Keys and the composer** (`state/sendKeys.ts`, `Composer.tsx`). `sendKeyAction` maps a key to `SendHow` (`'steer' | 'queue'`):
Enter steers, Ctrl/Cmd+Enter queues, Shift+Enter and an IME composition send nothing, and a touch keyboard's Enter stays a new
line (its Ctrl/Cmd+Enter still sends, queued while busy). A click on Send steers; a press held 500 ms (`LONG_PRESS_MS`) queues,
and the click that ends the press sends nothing more; while a reply runs and the box has text, Send's tip says so
(`STEER_TIP`). Both only where Enter can steer (`takesSteers`: a single chat on Claude, the `steers` prop); a room's or another
engine's Send keeps its plain tip, since there everything sent while it works queues. A dictation's held send goes the way the user sent it (`sendHow` ref). `onSend` carries `how` through ChatView
to `App.sendMessage`, which passes `steer: true` as `chats:send`'s 7th argument only for `'steer'` (every other caller sends 6, as
before). While the chat is busy no optimistic bubble is drawn either way: the message shows from the meta push, as a steering row
or a task row. `rejectedSendState` treats an id in `steering` as queued, so a dropped socket shows no error.

**Server gate** (`rpc/handlers.ts` `chats:send`, `TaskQueue.submit` with `SubmitOptions.steer`). The handler reads `steer` as a
boolean or absent (anything else is a `TypeError`; `false` is as absent) and never steers a `/todo` or a to-do command. Under the chat's lock, when the
chat is busy, `submit` asks `ChatService.steer` only for the user's own message (`from === 'user'`) in a single chat that is not
paused or pausing, not compacting, not waiting out a usage limit, with no command, `/todo`, `once`, `cardAsk` or `run`, and
whose text does not start with `/` (a typed skill or built-in the menu did not resolve would reach the CLI as plain text
mid-turn; it is read as a command only at a turn's start). Files are
committed first, as for a task. A refused steer falls through to today's task path with the same committed files, and resolves
`'queued'`; a taken one resolves `'steered'` at once (not at the turn's end). `TASKS_MAX` counts `tasks + steering`.

**Which turns take one** (`runTurn` sets `TurnSpec.steerable`): only a Claude turn the user started: not a routine's or a
process wake-up's (`auto`), not a workflow Agent step's chat (`meta.workflow`), not an asked A→B chat (`meta.asked`), not a card
comment (`cardAsk`), a Run result (`run`) or another agent's ask (`from`). Rooms never reach it (`GroupService` calls
`agentTurn` directly), nor a compaction. Codex, ACP and AG-UI handles have no `steer`, nor the Claude SDK adapter's, so their
messages queue. Such a turn passes `replayUser` to `buildArgs`, which adds `--replay-user-messages`; the side base keeps the
flag so it still mirrors the spawn, and `sideArgs` drops it (a side run takes no steers).

**The running turn** (`ChatService.agentTurn`, `core/chat/steer.ts`). `ChatService.steer` finds the chat's one running slot and
calls its `steer`, which `agentTurn` installs for a steerable turn. It refuses a non-image file when the run was started without
the attachments folder in `--add-dir` (images go in as content blocks and always work), builds the content with
`messagePrompt` (the same quote, file note and image blocks a turn's own prompt gets), stores the task with `ChatStore.addSteer`
and pushes the meta **before** writing (the echo may come back first), then writes it with `RunHandle.steer(content, task.id)`
(message ids are already uuids). A steer taken while no run is up (the turn still preparing it, or between attempts) waits in
`unsentSteers` and is written as the next run starts; `runClaude` itself buffers one written before its process is spawned and
writes it right after the prompt. On `userReplay` (`streamParser.ts`; a replay line yields no `entry`, so it never becomes the
turn's `tip`, a cut point) whose uuid is unread, `steeredItem` appends a user item with `steered: true` where the agent took it
in, and `dropSteer` takes the row away. Replays of other uuids (the turn's own prompt) are ignored.

**Stdin and the late case** (`claudeRunner.ts`). The runner keeps the uuids it wrote and has not seen echoed. At a `result`
stdin closes only when none is unread; otherwise it stays open, since the CLI's second turn may need approvals, question or plan
cards answered over stdin, and closes at the next `result` with none unread. A grace (`steerGraceMs`, 5 s) after such a result
closes it anyway unless a replay or `init` arrives first, so a message the CLI never reads cannot keep the process (and the
chat) running. `steer` returns false once stdin has closed or the run stopped. Each later `result` reports only what it added:
`costSince` (`usage/costBaseline.ts`) subtracts the attempt's previous result. The session's restored cost (`costBaseline`, a
resumed session) comes off the first result only, since every later one is measured from a result that already had it taken
off; the later report is chained after the first, so they land in order.

**Handing back.** Steers a run ends without reading (Stop, a crash, an error, a retry attempt) go to the **front** of the tray,
in send order (`ChatStore.returnSteers`), when the attempt ends, before the turn ends and the queue looks at the tray; `held` is
left as it was, so they follow whatever the tray does (a Stop lets the queue send the next task; an Edit or Resend holds the tray
before its stop). `holdTasks` counts unread steers as tasks the user can see, so an Edit with only a steer waiting still holds
the tray it lands in; `dropSteer` lets go of a hold nothing visible is left to keep, as the last task out does. Steers taken after the last run ended, or for a turn that never started one (no claude), are handed back when
the turn ends (`steersClosed`). At startup `ChatStore.recoverInterrupted` moves any leftover `steering` to the front of `tasks`.

**Edit, Resend, Fork.** A steered bubble sits inside its turn, so it has no Edit, Resend or Fork (`MessageList.tsx`), the server
refuses a rerun of it (`STEERED_ITEM_FIXED` in `TaskQueue.rerun`), and an agent bubble's Resend passes over it to the turn's own
message (`resendTarget`). Editing the turn's own message cuts before both: `droppedTurn` declares no dropped turn once a later
user item follows the message, so the cut runs at the previous turn's `end` without `--resume-drops-turn` (see
[Edit, Resend, Fork](edit-resend-fork.md)).

**The tray** (`TasksTray.tsx`, `ChatView.tsx`). Unread steers (`ChatMeta.steering`) are rows above the task rows, with a filled
accent dot and "Waiting for the agent's next step" (`STEER_WAITING`), no buttons (they are sent); the head counts both lists.
DOM hook: `steer-row`.

**Tests.** Unit: `streamParser.test.ts`, `claudeRunner.test.ts` (write, buffer before spawn, close rule, grace), `steer.test.ts`,
`costBaseline.test.ts`, `chatStore.test.ts`, `chatService.test.ts` ("mid-turn steers"), `taskQueue.test.ts`,
`rpc/handlers.test.ts`, `sideRun.test.ts`, frontend `sendKeys.test.ts`, `sendFailure.test.ts`, `messageEdit.test.ts`. The fake
claude takes later stdin user lines: `#WAIT_STEER` waits for one, `#STEER_REPLAY` waits for one and echoes it, and `#WAIT_FILE
<path>` holds the script until a file exists. `npm run e2e:steer` (`e2e/steer.e2e.mjs`, fake claude) drives the UI: the waiting
row, the bubble inside the reply with no Edit/Resend/Fork, Ctrl+Enter and a held Send queuing tasks that run as their own turns.
`npm run e2e` runs `e2e/steerProbe.mjs --soft` against the real CLI (one short Haiku run that sleeps in Bash and gets a steer
during it): PASS when the steer is echoed before the turn's one result; FAILED when it only comes as a turn of its own or never
echoes; `ZUMIBOT_SKIP_STEER_PROBE=1` skips it.
