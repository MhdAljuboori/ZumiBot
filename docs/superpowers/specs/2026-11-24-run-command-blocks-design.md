# Run button on shell blocks — design

Date: 2026-11-24. Status: draft for approval.

## Intent

Claude Code desktop puts a **Run** button on single-line shell blocks in Claude's replies. The user clicks it, the command runs, Claude gets the result and carries on. ZumiBot should feel the same. The case that matters most: a command the agent could not or should not run itself (auto mode's check blocked it, a deny rule, `git push`, deleting something). The agent hands it over as a block, the user's click is the decision, and the agent continues from the result.

### What Claude Code does (checked in the user's own transcripts)

From session `75476c59…` (the `v0.1.1` tag push, 2026-11-23):

1. Run executes the command in the app's Terminal panel and waits for it to finish.
2. The app then queues one user message in the CLI's `!command` (bash mode) format:
   `<bash-input>git tag v0.1.1 b20fbd0 && git push origin v0.1.1</bash-input><bash-stdout>…[new tag] v0.1.1 -&gt; v0.1.1</bash-stdout><bash-stderr></bash-stderr>`
3. Claude gets a turn on it at once and continues (there: it listed the release runs the tag started).
4. Long output starts with `[…earlier output truncated…]`; none at all reads `[No output was captured. …]`. `>` in output is escaped as `&gt;`.
5. The app's own system prompt tells Claude how to write such blocks: "put it in its own fenced code block tagged `bash` — the app adds a Run button to single-line shell-tagged blocks. Several commands meant to run one after another each get their own block …; a single command that spans lines (heredoc, `\` continuation, pipeline) stays one block. No leading `$` prompt and no interleaved output inside the fence."

Claude never watches the output while the command runs; it hears once, at the end.

## Goals

- A Run button beside Copy on runnable shell blocks in an agent's finished reply.
- The click runs the command on the server, in the chat's folder, with no approval card and nothing Claude can refuse: the click is the user's decision.
- When the command ends, the agent that wrote the block gets one message with the command, its output and how it ended, and continues.
- That message is **never shown to the user**. The block itself shows the run's state.
- Agents are told how to hand over commands, so blocks appear reliably (today they appear only sometimes).

## Non-goals

- Typing into a running command. Runs are hands-off: stdin is `/dev/null`, so `sudo` password prompts and `y/n` questions fail. The agent is told to send those to the user's own terminal.
- A terminal (pty, xterm.js) in ZumiBot.
- The agent watching output while the command runs.
- Runs on the user's own PC in VPS mode: the command runs where the server runs, as the agent's own Bash does.

## Anti-goals (a failure even if it works)

- A run that ZumiBot or Claude refuses on policy (classifier, card, deny rule, Plan mode, engine capability). Only resource limits may stop it.
- A visible bubble, chip or notice for the hidden message.
- The agent getting the result twice, or a turn the user did not cause.
- Command output able to break out of the message format (closing `</bash-stdout>` early) or leak vault secrets.

## Approaches considered

1. **Claude Code's own flow: run, then one message at the end (chosen).** The process runs; when it ends, one hidden message in the `<bash-input>/<bash-stdout>` format goes to the block's author. One turn per run, works for every engine (the agent needs no process tool), matches what the user knows.
2. **Watch now, plus a message at the end.** The click starts an agent turn at once that follows the output with `zumibot_processes wait/logs`, plus a wake at exit that is skipped when the watching turn already saw it. Rejected: not what Claude Code does (the first proposal wrongly said it was), costs an extra turn per run, needs a duplicate-suppression rule, and Codex/isolated agents have no process tool to watch with.
3. **Notify-on-exit wake as it exists.** Reuse `notify {on: 'exit'}` and `ProcessWakes`. Rejected as is: the wake message is visible, carries the "not typed by the user" framing, is under hourly caps and the spend-cap gate (which may drop it), and fires on no stop. The chosen design reuses the process service but sends its own message.
4. **A real terminal.** Rejected by the user: a native pty module in a single bundled `server.mjs` across Linux, Windows and Electron, for the password/prompt case only.

## Design

### Which blocks get Run

- Fenced blocks tagged `bash`, `sh`, `shell` or `zsh` (case-insensitive), whose text (without the parser's trailing newline) is **one line**, non-empty, and within the process command limit (4 000 characters). Multi-line blocks keep Copy only, as in Claude Code.
- Only in an agent's **finished** reply (`assistant` items) in a chat view: single chats and rooms, routine and workflow chats included. Not while the reply is still streaming (the live renderer), not in user messages, side threads (`/btw`), the island, the inbox, workflow notes, exports, or an **archived** chat.
- Engines: Claude, Codex and ACP agents (their tools run here, so the agent needs no tool of its own to get the result). **Not** engines with the `remote` cap (AG-UI): their tools run on the remote server, and running a remote endpoint's command on this host and sending the local output back to it is what `protocol-engines.md` rules out ("A remote agent receiving local tools, files … without a design that names a safe way"). *(My call.)*

### The click

- New API method (three places: `ZumiBotApi`, `rpc/handlers.ts`, `net/api.ts`): `processes:run(chatId, messageId, command)`.
- **The server only runs a command that is a runnable block of that stored message.** It loads item `messageId`, checks it is an `assistant` item of that chat whose author is not a remote agent, and checks with a shared pure helper (`shared/src/runBlocks.ts`, `messageHasRunBlock(text, command)`) that the item's text holds a shell-tagged fence whose one line is exactly `command`. A block is identified by its message and its command text, not by an index: this avoids making a line scanner agree with the Markdown parser on block positions. Two identical blocks in one message share a status, which is harmless.
- The process starts through `ProcessService` in the chat's folder, with these differences from an agent's `start`:
  - no engine-capability check, no Plan-mode refusal, no card, no remembered-approval lookup, no `notify` rule;
  - `startedBy` is the block's author (the item's `agent`, else the chat's agent), so the panel and the result message name the right agent;
  - a new record field, `run: {messageId}` (null for an agent's process), marks it as the user's run; with the record's `command` it ties the run to its block. It is stored in `index.json` with the rest of the record.
- Still applies: per-chat (5) and server (20) running limits, the command length rule, the archived/removed/closing chat refusal, server shutdown. Each refusal's existing sentence shows next to the button.
- Isolation: a Sandboxed or Container agent's block still runs, on the host, in the chat's folder. It is the user's own action, the same as typing it in a server terminal.
- Hidden characters: when the command holds characters the process card already escapes (control, bidi, zero-width), the click first shows the command with those escapes and asks to run it. Any other command runs on the click.
- Every click starts a new run, even of the same block.

### When it ends: the hidden message

- **Fires** on a natural exit (any code), an end by signal, a **user's Stop**, and the lifetime limit. Restart from the panel makes a new run of the same record, whose end sends again. The old run that Restart ends sends nothing (today `restart` ends it as a `'user'` stop, so the run-end hook must tell the two apart); it still gets its audit record, as `interrupted`.
- **Never fires** on an end by archive, remove or server shutdown, a stop by the agent (`stoppedBy: 'agent'`: it knows already), a record found `lost` at start, or a spawn failure (the button shows the failure).
- **The agent's own process tools** see run records like any of the chat's processes: `list`, `logs` and `wait` read them (`list` marks one as run by the user from a block, so the agent does not think it started it), and `stop` ends one. If the agent happens to `wait` on a run during a turn, the end message still goes at the next idle: one message per run is the contract, and that case is rare. *(My call.)*
- **Text** (built by a shared pure helper):

  ```
  <bash-input>COMMAND</bash-input><bash-stdout>[…earlier output truncated…]
  OUTPUT
  [exit code 1]</bash-stdout><bash-stderr></bash-stderr>
  ```

  - Output: ZumiBot keeps stdout and stderr as one interleaved stream, so all of it goes in `bash-stdout` and `bash-stderr` stays empty.
  - It is the **tail** of the output, ANSI stripped, cut to a size cap (the builder's pick, in line with the `logs` answer's 16 KiB), with the truncation marker when cut. No output reads `[No output]`.
  - The last line says how it ended: `[exit code N]`, `[ended by SIGNAL]`, `[stopped by the user]`, `[stopped at its time limit]`.
  - `&`, `<` and `>` in the command and the output are escaped as entities, so output cannot close a tag early.
  - The output is scrubbed with the author's vault values, as wake events are.
  - In a room the text leads with `@author` on its own line, so `GroupService` hands it to the block's author.
- **Sending**: a new `SendFrom` `'run'` through `TaskQueue.submit`:
  - like `'process'` in timing: it queues while a turn runs and goes at the chat's idle; it is held in a pausing or paused chat and never ends a pause (it arrives later than the click, so it is not the user's "send to continue"); it is held by a usage-limit wait (it never ends one: the wait's `continue` goes first);
  - never held by `held` (the tray state that waits for Send now, the × or Resume): the user cannot see its task, so nothing they could press would let it go. Only a pause, a pausing chat or a usage-limit wait stops it; *(added at the final review)*
  - like the user's own message in everything else: **no `auto`** on the task or the turn. `auto` would deny every connector write in that turn with the routine/workflow sentence, record the audit `runKind` as `routine`, skip the acknowledge line and make asks inherit `auto`; after the user's `git push`, "post the release note to Slack" must still work. Command output is untrusted, but so is every tool result in any turn, and connector writes keep their normal approvals. Today `TaskQueue` sets `auto` for every `from !== 'user'`; that becomes `routine` and `process` only. *(My call.)*
  - unlike wake-ups: no hourly caps and no spend-cap gate (the user's own typed messages are never refused either), no "not typed by the user" framing, and each run is its own message (never joined).
- **Hidden**: the stored `user` item and its `QueuedTask` (while it waits) carry a marker, e.g. `run: {processId}`. It is still in the chat's history and the agent's session. It gets no `ack` line and never sets the chat's title. Everything that shows or reads the chat for the user leaves it out:
  - the message list, including the queued-messages strip;
  - unread counts;
  - message search;
  - chat export;
  - Edit, Resend and the version switcher (it is not editable).

  The agent's reply then reads as the next part of the conversation. Notifications for that reply work as for any reply.

### Audit log (the user's decision: log every Run)

A Run runs an agent-written command on the host with no card, so it gets an audit record, though it is not an agent's tool call:

- **One record per run, written when it ends**, whatever ended it: exit, signal, Stop by anyone, lifetime, archive, remove, shutdown. A spawn failure is written at once. A record found `lost` at the next start is written then. A Restart is a new run and gets its own record. A click refused by a limit ran nothing and gets no record.
- **Fields:**
  - `tool` is a fixed pseudo-tool name for runs (e.g. `Run`);
  - `input` is `{command, cwd}`, through the same redaction as every record (`auditRedact.ts`);
  - `agent` and `engine` are the block's author;
  - `itemId` is the assistant message holding the block, so "Show in chat" lands on it;
  - `turnId`, `subagent` and `parentToolUseId` are null;
  - `isolation` is the author's level, though the run itself was on the host;
  - `durationMs` is start to end.
- **Decision:** a new `AuditDecision` kind, e.g. `{kind: 'runByUser'}`, added to `AUDIT_DECISION_KINDS`, with its words and filter entry on the audit page ("Run by you").
- **Outcome:**
  - exit 0 → `ok`;
  - any other exit or a signal → `error`, with `exit code N` or the signal as `error`;
  - a stop of any kind or a `lost` record → `interrupted`;
  - a spawn failure → `error` with its code.
- **No output is stored**, as for every record.
- Written through the existing `AuditLog` writer. A write failure only logs its code and counts on the page, as today. It never blocks the run or its message.

### The block's button

```
┌ bash ─────────────────────────────────── [▶ Run] [⧉] ┐
│ npm run build                                         │
└───────────────────────────────────────────────────────┘
after the click:                [● Running ›] [▶] [⧉]
after it ends:                  [✓ Exited 0 ›] [▶] [⧉]   or   [✕ Failed (1) ›] / [■ Stopped ›]
a refusal:                      [▶ Run] + the server's sentence beside it
```

- The status shows the block's latest run, read from the chat's process list (`useProcesses`, keyed by the record's `run` field), so it stays across reloads and follows the live `processes:changed` events.
- Clicking the status opens the side panel's Processes view on that process's log.
- Once the record is pruned (the newest 20 ended records per chat are kept), the block shows a plain Run again.
- Labels and tones reuse `stateLabel` and the panel's dot tones; the pure rules (which blocks run, the status for a block) live in `frontend/src/state/` with tests, the component only draws them.

### What agents are told

A fixed paragraph in the shared `system` text that `ChatService.agentTurn` builds (beside `PROCESS_SYSTEM`), so it reaches Claude (`appendSystemPrompt`), Codex (`baseInstructions`) and ACP (`systemPrompt`), and the fresh side bases that copy it. Its gate: on for every engine without the `remote` cap; not tied to `bridges`, processes or isolation. Compact goes through `agentTurn` too and keeps the paragraph, as it keeps the bridges, so the prompt cache never changes between a chat's turns. The moderator, room summary and bare workflow LLM/Condition calls use their own prompts and do not get it. It says:

- When you give the user a shell command to run, put it alone in a fenced `bash` block: one command per block, no leading `$`, no output inside the block. The app adds a Run button to single-line blocks; it runs the command in this chat's folder and sends you its output when it ends.
- When a command you need was blocked (auto mode's check, a deny rule) or is one you should not run yourself, hand it over this way instead of working around the block.
- Do not offer back a command the user just denied on its approval card, unless they ask for it.
- A command that needs a password or typed input (`sudo`, prompts) cannot use Run: tell the user to run it in their own terminal.
- When no user is in the conversation (a routine's or workflow step's run, or another agent asked you), still give the block, but say plainly that the command was not run and the work waits on it, so the result does not read as done. *(My call: one fixed text for every run kind keeps the prompt cache stable in chats that mix kinds, such as a user typing in a routine's chat.)*

The paragraph is the same in every run kind and every turn. Changing it misses every chat's prompt cache once.

## Constraints

- Never `--dangerously-skip-permissions` or `bypassPermissions` (unchanged: the run never goes through the CLI).
- A process's env stays as today: no vault keys, no `ZUMIBOT_*`, no capability tokens.
- ZumiBot's own logs: only codes and ids, never the command or output.
- Secrets never in logs, URLs or error messages.
- No new dependencies.
- Root `CLAUDE.md` stays under 16 KB (`repoDocs.test.ts`).

## Docs and tests

- New `docs/architecture/run-blocks.md`, an index line in root `CLAUDE.md`, a pointer from `processes.md` (the `run` field, user runs skip the engine cap and Plan refusal, the end message), and the new decision kind in `governance.md`. Also update `data.md` if the record or item shape changes what's on disk, and add a page or section in `zumi-bot-docs/`.
- Tests:
  - shared helpers: runnable blocks, message text, escaping, truncation;
  - backend: the `processes:run` handler checks, a run from a non-assistant or another chat's message refused, an AG-UI author refused, a user run skipping the cap and Plan checks, the end message on exit, signal, Stop and lifetime and none on archive, remove, shutdown, agent stop or lost, the queue behaviour of `'run'` (held in a paused chat, no `auto`), a room's mention, vault scrubbing, one audit record per run with each outcome;
  - frontend pure rules;
  - an e2e (new, or an extension of `e2e:processes`): click Run on a fake agent's block, the status goes Running then Exited, the fake agent's next turn receives the `<bash-input>` message, nothing new shows in the message list, no console or server errors.

## Left to the builder

- The output size cap (around 16 KiB) and line cut.
- Icons, tooltip text, and the phone layout of the button row.
- Whether the end message is built in `ProcessService` (an `onRunEnd` hook like `onWake`) or in a small sender beside `ProcessWakes`.
