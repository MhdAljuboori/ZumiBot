# Run button on shell blocks

**Goal.** A single-line shell block in an agent's finished reply gets a **Run** button, as in Claude Code's desktop app. The click runs the command on the server, in the chat's folder, with no approval card and nothing the agent or the engine can refuse: the click is the user's decision. When the command ends, the agent that wrote the block gets one hidden message with the command, its output and how it ended, and carries on. The case that matters most is a command the agent could not or should not run itself (auto mode's check blocked it, a deny rule, `git push`). Design: `docs/superpowers/specs/2026-11-24-run-command-blocks-design.md`; plan: `docs/superpowers/plans/2026-11-25-run-command-blocks.md`.

A Run is an ordinary record of [Background processes](processes.md) (same service, limits, panel and logs), marked as the user's own, plus a hidden message when it ends. Stdin is `/dev/null`: `sudo` and prompts fail, and `RUN_SYSTEM` tells the agent to send those to the user's terminal.

## Which blocks get Run

Pure rules in `shared/src/runBlocks.ts`:

- `runnableCommand(lang, text)`: a fence tagged `bash`, `sh`, `shell` or `zsh` (any case) whose text, less the parser's last newline, is one non-empty line within the process command limit (4 000 characters, `commandError`). Multi-line blocks keep Copy only.
- `messageHasRunBlock(text, command)`: the server's own scan of the stored message for a shell fence whose one line is exactly `command` (backtick or tilde fences, inside a blockquote or list item, an unclosed fence never counts). A block is identified by its message and its command text, never by an index, so the scanner need not agree with the Markdown parser on positions. Two equal blocks of one message share a status.

The UI shows the button only in an agent's **finished** reply of a chat view (single chats and rooms, routine and workflow chats included): not in the streaming bubble, user messages, side threads, the island, the inbox, workflow notes, exports, an archived or read-only (asked) chat, nor a remote (AG-UI) agent's reply. `RunLinkContext` (`components/runLink.ts`) is provided only around the main `ChatView`, and `RunBlockScope` only around an assistant message's Markdown (`MessageList.tsx`); `CodeBlock.tsx` draws the button when both are set and `state/runBlocks.ts` finds a command.

## The click: `processes:run`

`processes:run(chatId, messageId, command)` (`ZumiBotApi`, `rpc/handlers.ts`, `net/api.ts`) calls `runBlock` (`core/processes/runBlock.ts`), which reads the stored chat itself:

1. the chat exists, and `messageId` is an `assistant` item of it, else `RUN_REFUSALS.gone`; an asked (A→B) chat, which the UI shows read-only (`chat.asked`), is refused with `RUN_REFUSALS.asked` (`isAsked`), as the UI shows no Run there;
2. `messageHasRunBlock` holds for that item's text, else `RUN_REFUSALS.notBlock`, so a client cannot run what the agent never wrote;
3. the author (`item.agent`, else the chat's agent) has no `remote` cap, else `RUN_REFUSALS.remote`: a remote agent's commands never run here (`protocol-engines.md`).

Then `ProcessService.run()` starts it as `start(chatId, author, {command}, {run: {messageId}})`. A user run skips the engine cap, the Plan-mode refusal, the approval card, remembered approvals and the `notify` rule. The per-chat (5) and server (20) limits, the command length rule, the archived or closing chat refusal and shutdown still apply, and each refusal's sentence shows beside the button (`code-run-error`). Isolation does not apply: a Sandboxed or Container agent's block runs on the host, as if typed in a server terminal. Every click is a new run. When the command holds hidden characters (control, bidi, zero-width), the UI first shows it with them spelled out and asks (`needsRunConfirm`, `ConfirmDialog` `detail`).

## When it ends: the event

`ProcessService` raises one `RunEndEvent` per run through `onRunEnd`, however it ended (`app.ts` hands it to the audit and to `RunResults`). `end` is what the message says; `null` sends no message.

| How it ended | `end` | `outcome` | `error` |
|---|---|---|---|
| exit 0 | `{exit, 0}` | `ok` | null |
| exit N | `{exit, N}` | `error` | `exit code N` |
| signal S, not a stop | `{signal, S}` | `error` | `S` |
| user Stop | `{stopped, 'user'}` | `interrupted` | `stopped by the user` |
| lifetime limit | `{stopped, 'lifetime'}` | `interrupted` | `stopped at its time limit` |
| ended by Restart (the `restarting` flag) | null | `interrupted` | `restarted` |
| agent stop | null | `interrupted` | `stopped by the agent` |
| archive / remove / shutdown | null | `interrupted` | `stopped at archive` / `stopped at remove` / `stopped with the server` |
| spawn failure | null | `error` | the error code |
| found `lost` at load | null | `interrupted` | `lost at restart` |

Restart makes a new run of the same record whose end sends again; the old run it ends sends nothing. `onExit` reads how the run ended, its times and its end cursor before its first await: a Restart that lands while the end is saved resets those fields on the record and appends to the same stream, and the old run must still report its own. The event carries the scrubbed output tail (`output`, `cut`): the last `RUN_OUTPUT_MAX` (16 KiB) of this run's bytes (up to that end cursor), ANSI stripped, scrubbed with the author's vault values before lines are cut at 2 000 characters (a secret across the cut would leave its prefix), from a line start.

## The message

`runResultText` (shared, pure) builds the CLI's own `!command` format:

```
<bash-input>COMMAND</bash-input><bash-stdout>[…earlier output truncated…]
OUTPUT
[exit code 1]</bash-stdout><bash-stderr></bash-stderr>
```

stdout and stderr are one interleaved stream, so all output is in `bash-stdout` and `bash-stderr` stays empty. No output reads `[No output]`. The last line is `[exit code N]`, `[ended by SIGNAL]`, `[stopped by the user]` or `[stopped at its time limit]`. `&`, `<` and `>` are escaped as entities in the command and the output, so output cannot close a tag. In a room the text starts with `@author` on its own line, so `GroupService` hands it to the block's author. Routing reads only that first line (`routedText`, the post's missing-member notices and `route`'s mentions and `@everyone`, through `InboxEntry.run`): the output is material, as a workflow's `<input>` blocks are, so a log line saying `@other` or `@everyone` addresses nobody.

## Sending: `SendFrom 'run'`

`RunResults` (`core/processes/runResults.ts`) drops the event for an archived or gone chat, else calls `TaskQueue.submit` with `from` `'run'` and `{run: {processId}}` in its options. In `taskQueue.ts`:

- like `'process'` in timing: it queues while a turn runs and goes at the chat's idle, waits in a pausing or paused chat and never ends a pause;
- a usage limit wait (`meta.resume`): it never calls `newTurn`, so it never ends the wait, and while the wait stands it queues even on an idle chat; the wait's `continue` goes first and the result follows that turn (the pump already orders them so). A `'process'` wake-up does the same (see [Usage limit waits](usage-limit-waits.md));
- never held (`held`): the user cannot see its task to press Send now or the × on it, and Resume exists only in a paused chat. Only tasks without `run` count for `held` (`holdsVisibleTask`): `takeOverPatch`, `ChatStore.holdTasks` (Edit/Resend on a running chat, a pause landing, a limit nothing continues), `addTask`'s hold, `LimitResumes.dontContinue` and the restart's `heldPatch` set it only for a visible task, and the last visible task out clears it (`tasksPatch`). The pump takes the oldest run task out of a held tray, or of a room the hop cap paused (whose tasks wait for a message as held ones do; `submit` lets a run result into such an idle room too), with `dropTask`, unless the chat is pausing, paused or in a limit wait; visible tasks stay held as before. `dontContinue` and a version switch that freed one (it ended a pause or a wait) wake the queue for it, and a restart's `resume()` sends it, so none is stranded;
- like the user's own message otherwise: `autoFor('run')` is undefined, so no `auto` on the task or the turn. `auto` would deny every connector write in that turn, record the audit `runKind` as routine, skip the ack line and make asks inherit it; after the user's `git push`, "post the release note to Slack" must still work. `autoFor` is true only for `'routine'` and `'process'`;
- unlike wake-ups: no hourly caps, no spend-cap gate, no "not typed by the user" framing, and each run is its own message, never joined.

## Hidden

The stored `user` item and the `QueuedTask` carry `run?: RunMark` (`{processId}`). The item stays in the chat file and in the agent's session. It gets no ack line and never sets the chat's title. Left out where the user looks:

- **message list:** `MessageList` draws `groupItems(withoutRunItems(...))` (`state/runBlocks.ts`). The turn rules (`resendTarget`, Allow, ask, limit waits, pause) read the full list, because a run item does start a turn;
- **queue strip:** `ChatView` feeds the tray `visibleTasks(chat.tasks)`;
- **search:** `searchIndex.ts` `metaOf` returns null for it;
- **export:** `chatExport.ts` `buildExport` filters it out;
- **Edit, Resend and the version switcher:** a run item is not editable, and Resend is not offered behind one. The server refuses both too (`RUN_ITEM_FIXED`, in `TaskQueue.rerun` before any stop and in `ChatService.rerunTurn`).

Notifications for the agent's reply work as for any reply.

## Audit

One record per run, written when it ends (any way, archive, remove and shutdown included; a spawn failure at once; a `lost` record at the next start), by `core/audit/runAudit.ts` through `AuditService.record`. Tool `Run` (`RUN_AUDIT_TOOL`), input `{command, cwd}` through `redactInput`, decision `{kind: 'runByUser'}` (labelled "Run by you"), `agent` and `engine` the block's author, `itemId` the message holding the block, `ts` the start. Outcome from the table above. No output is stored. See [Governance](governance.md).

## What agents are told

`RUN_SYSTEM` (`core/processes/processPrompt.ts`) is one fixed paragraph, gated `!caps.remote`, added beside `PROCESS_SYSTEM` in `ChatService`'s turn system text (and in the two fresh side bases in `app.ts`), so it reaches Claude, Codex and ACP and Compact. It asks for one command per `bash` block (no `$`, no output), says Run executes it in the chat's folder and sends the output back, to hand over a blocked or risky command that way, not to re-offer one the user denied, to send `sudo` and prompts to the user's own terminal, and to say plainly that nothing ran when no user is in the conversation. It is the same in every run kind and turn: changing it misses every chat's prompt cache once.

## UI

`CodeBlock.tsx`: the runnable block's one line wraps (`white-space: pre-wrap; overflow-wrap: anywhere` on `.code-block.runnable > pre`, `markdown.css`) instead of scrolling sideways, so the whole command is on screen before a click that asks for no approval; other blocks still scroll. `code-run` (the button; disabled while its request is pending, with a ref guard so a double click starts one run), `code-run-status` (the block's latest run from `useProcesses`, `stateLabel(p).text` plus ` ›`, with `data-tone`; a click calls `RunLink.open`, which opens the side panel's Processes view on that log through `ProcessesPanel`'s `focusId`/`focusRequest`; `process-log-panel`), `code-run-error`. Once the record is pruned (newest 20 ended per chat), the block shows plain Run again. Rules live in `frontend/src/state/runBlocks.ts`.

## Tests

- **Shared** `runBlocks.test.ts`: runnable lines, `messageHasRunBlock` cases, exact message text, escaping and truncation.
- **Backend** `tests/core/processes/` (`runBlock` with the asked refusal, `runResults`), `processService.test.ts` (record, limits, each row of the event table, tail scrubbing also across the 2 000-character cut, a Restart landing while the end is saved), `tests/core/audit/runAudit.test.ts`, `taskQueue.test.ts` (`'run'` waits in a paused chat, no auto; "Run results are never held": a paused or spend-capped chat the user types into, Edit and Resend while a result waits, Don't continue, a held tray at the pump and at a restart, a room the hop cap paused, a version switch, a limit wait that the result neither ends nor jumps, and a refused rerun of a run item), `chatStore.test.ts` and `limitResumes.test.ts` (no `held` for run tasks alone), `groupService.test.ts` (routing on the first line only), `chatService.test.ts` (a refused rerun), the prompt, search and export tests, `tests/rpc/handlers.test.ts` (`processes:run` checks).
- **Frontend** `runBlocks.test.ts` (pure rules), `api.test.ts`.
- **E2E** `npm run e2e:run-blocks` (`e2e/runBlocks.e2e.mjs`, [E2E](e2e.md)): Run on a fake agent's block (a command wider than the reply, which must wrap with no sideways scroll), the status reads Exited (code 0) with no approval card, the next run's stdin holds `<bash-input>` and `<bash-stdout>` with the output before its `[exit code 0]` line (JSON-escaped, as the stream-json line holds it), the agent's reply shows and the user-message count is unchanged, and the status opens the log. `RUN_E2E_SHOTS=<dir>` also saves four PNGs.
