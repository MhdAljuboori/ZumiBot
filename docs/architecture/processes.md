# Background processes

**Status: all three phases built**: the service and the agent tool (1), the UI (2), and waking the agent on a process's event (3). Each phase updates this doc as it lands.

**Goal.** An agent can keep a process running past its turn (a dev server, a test watcher, a long build) without Claude Code's own background tasks, which stay off: `claudeRunner.ts`, `browserIpc.ts` and `desktopIpc.ts` keep `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. The server owns these processes; the user sees, reads and stops them in the chat's side panel. A process belongs to one chat (a room counts as one chat) and never outlives it, the server, or its lifetime cap.

## Async subagents (spike)

**Question.** Can a subagent outlive its turn under one `claude` process per turn? **No, and nothing is built for it.** Read from CLI 2.1.326's own code (the binary's strings, not a model run): with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` set, the checks that gate a background agent launch and moving a foreground agent to the background both return true, so every `Agent`/`Task` call is foreground and its result arrives before the parent's `result` event. Without the flag a background subagent is still a task inside that one CLI process: its conversation lives in the process's memory and a sidechain transcript, and the next turn's `--resume` restores only the parent session. Outliving the turn would mean keeping the CLI alive past `result`, which is exactly what made a chat stay "running" after its reply. A subagent that needs something to outlive it uses this feature instead: subagents share the parent's MCP servers, so one can `start` a process (through the same card); it is recorded as started by the chat's agent, since the bridge cannot tell a subagent from its parent. Checked with the real CLI (2.1.326, Haiku): a general-purpose subagent's `start` reached the card in auto mode, the process outlived the subagent and the turn, and its row read the chat's agent. A long-lived subagent would need a persistent CLI per chat, a different architecture and out of scope.

## Settled decisions

Chosen in Phase 0 and kept after review: a `start` asks in every mode, auto included (without the ask rule the CLI ran it with no card at all, see Permissions); a tree left by a crash is ended at start only when `/proc` proves it is the same one (Lifecycle); a process gets no vault API keys (Spawning); a `/btw` side run carries the tool definitions but every call is refused (The agent tool); `wait`, `grep` and `notify` patterns are plain text, never regex; Codex agents get no tool (Engines); running processes never count as `busy`, they only warn (Busy check).

## Data model

Pure rules, types and limits in `shared/src/processes.ts`; the service in `backend/src/core/processes/`: `processService.ts` (records, limits, spawn, lifecycle, the agent's answers), `processOutput.ts` (ring and log files with cursors), `processTree.ts` (`endTree`, `groupAlive`, the `/proc` identity), `processIpc.ts`, `processBridge.ts`, `processTools.ts`, `processPrompt.ts`.

```ts
type ProcessState = 'running' | 'exited' | 'stopped' | 'lost' | 'failed'
interface ProcessInfo {
  id: string                 // 'p_' + 10 hex, unique on this machine
  chatId: string
  name: string               // agent's, else derived from the command; unique among the chat's running processes
  command: string            // exactly as the agent asked (scrubbed copy on the wire)
  cwd: string                // absolute, resolved, inside the chat's folder
  startedBy: string          // the agent (a room member) whose call started it
  startedAt: number; endedAt: number | null
  state: ProcessState
  exitCode: number | null; signal: string | null
  stoppedBy: 'agent' | 'user' | 'archive' | 'remove' | 'lifetime' | 'shutdown' | null
  restarts: number           // user Restarts of this record
  until: number              // startedAt + its lifetime
  out: number                // bytes of output ever produced (the cursor end)
  wake: ProcessWake | null   // the notify rule, see Wake-ups
  run: { messageId: string } | null // the user's Run of a shell block of that message, see Run button
}
```

`running` (the group leader is alive; `note` holds a spawn error code or "ended at start"), `exited` (ended by itself, `exitCode` or `signal`), `stopped` (ended by someone, `stoppedBy`), `lost` (the server restarted while it ran, see Lifecycle), `failed` (spawn failed, the error code only). The pid, process group, `/proc` start time and boot id are stored in the file but never sent to a client or an agent.

**Files.** `<data>/processes/index.json` (0600, through `writeFileAtomic`): every record, current and ended, written on each state change (never per output chunk). Output: `<data>/processes/<chatId>/<id>.log` plus `<id>.log.1` (folders 0700, files 0600). Kept: every running record plus the newest 20 ended ones per chat; an older one goes with its log files. Per machine, never synced: `sync.mjs` adds `processes` to `LOCAL_ONLY_EXCLUDES` (out of the pull, the backup copy and the push lists), as `claude-tmp/` is. Not in `chats/`, which sync pushes whole. See also [Data folder](data.md).

**Output.** stdout and stderr are read as bytes into one stream (interleaved in arrival order) with a cursor: the byte offset since the record's first start (`out`). Each process keeps a 256 KiB ring in memory and writes the same bytes to its log file; at 2 MiB the file rotates to `.log.1` (one generation), so a process holds at most 4 MiB on disk. Reads strip ANSI escapes and cut lines at 2 000 characters; the file keeps the raw bytes. A read from a cursor older than what is retained starts at the oldest byte kept and says how many bytes were dropped. Restart appends to the same stream after a marker line, so cursors stay valid. At exit the pipes get up to 1 s to drain before they are dropped (`PIPE_DRAIN_MS`): 'exit' can come before the last output is read, nearly always on Windows, while a grandchild that left the group may hold them open for good.

## Run button

A record with `run` is the user's own Run of a shell block ([Run button](run-blocks.md)): `ProcessService.run()` is `start` with `{run}`, and it skips the engine cap, the Plan-mode refusal, the card, remembered approvals and the `notify` rule, while the per-chat and server limits, the command length rule, the closed-chat refusal and shutdown still apply. `startedBy` is the block's author. The agent's own tools see it like any process (`list` marks it "run by the user from a block"), and `stop` ends it. When it ends the service raises one `RunEndEvent` through `onRunEnd` (the table is in the Run button doc); a Restart sets `restarting` on the old run first, so that end sends nothing and only the new run's end does. Archive, remove, shutdown, an agent stop, a `lost` record and a spawn failure send no message.

## Limits

All enforced in `ProcessService`, each refusal one plain sentence the agent and the UI show as is.

| Limit | Value | Refusal |
| --- | --- | --- |
| Running per chat | 5 | "This chat already runs 5 processes. Stop one first." |
| Running on the server | 20 | "The server already runs 20 processes. Stop one first." |
| Command | 1–4 000 characters, no NUL | "The command is empty or too long." |
| Name | `[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}` | "Names use letters, digits, space, dot, dash and underscore, up to 40." |
| Same name running in the chat | refused | "A process named dev is already running (p_…). Stop it or pick another name." |
| Lifetime | default 12 h; `timeoutMinutes` 1–720 | ended `stopped`/`lifetime` when due |
| Ring / log | 256 KiB / 2 × 2 MiB per process | oldest output dropped |
| All logs | 200 MiB | oldest ended records' logs pruned first |
| `logs` answer | 16 KiB, `tail` ≤ 500 lines | cut with "N bytes not shown; read from cursor X" |
| `wait` | 1–120 s (default 30), ≤ 5 patterns of ≤ 200 characters | — |
| Ended records kept | 20 per chat | oldest pruned with its log |

A start is refused when the chat is archived, removed, or being archived or removed, while the server shuts down, and on an agent whose engine lacks the `processes` cap.

## Spawning

`ProcessService.start` runs `spawn('/bin/bash', ['-c', command], {cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']})`: the agent's command is the only shell text, the server adds no wrapper, prefix or redirection. `detached` makes the shell the leader of its own process group, as in `probe.ts` and `claudeCli.ts`. stdin is `/dev/null`, so a command that waits for input sees EOF (the prompt says so).

**cwd.** The chat's own folder (`meta.cwd`, which is the worktree checkout for an isolated chat, and the room's folder for a room), or the agent's `cwd` resolved against it. Both are `realpath`ed and the result must be that folder or under it, so neither `..` nor a symlink leaves it; it must exist and be a folder. Zumi Bot's chats (fixed to the agents folder) get the tool like any agent. An agent set to Sandboxed or Container isolation gets neither the tool nor its prompt: the server would start its processes on the host, outside the isolation (see [Governance](governance.md) 2.4).

**Env.** Built the way a turn's base env is, never the server's own `process.env`: `runEnv.env()` (the server's env less `SERVER_ONLY_ENV`, with the login shell's `PATH`), less every `ZUMIBOT_*` name (dev hooks, data dir, vault key file, and the capabilities a turn's env carries) and every `CLAUDE_CODE_*` and `CLAUDECODE`. None of the turn's additions: no capability tokens, no `CLAUDE_CODE_TMPDIR`, no pause flag, and no vault API keys (a long-lived process nobody watches gets no secret; a dev server that needs a key reads it from the project as it would by hand). Settled: no vault keys.

**Ending a tree.** `endTree`: SIGTERM to the group, wait up to 5 s for the group to be gone, SIGKILL, wait up to 2 s. Gone means `kill(-pgid, 0)` fails or, on Linux, no process in `/proc` with that group is anything but a zombie: an orphan re-parented to a PID 1 that never reaps (a container without an init) stays a zombie for good, and counting it made every stop wait out the whole grace. When the leader exits by itself, what is left of its group gets the same treatment, so nothing the UI cannot see stays behind. A grandchild that called `setsid` leaves the group and is out of reach, as it is for any Bash call; the approval card is the boundary. On Windows there are no groups or signals: `endTree` is `taskkill /T /F` on the leader's tree, then kills every Git Bash process whose env carries the record's id in `ZUMIBOT_PROCESS` (set at spawn there only), which reaches the `&` jobs a forked bash left with no Windows parent ([install.md](install.md), "Windows: native").

**ZumiBot's own logs.** Only codes and ids (`process p_… spawn failed: ENOENT`), never a command, cwd, name, env or output.

## The agent tool

`zumibot_processes` is a stdio MCP server built like `zumibot_todos` (it reuses `ipc/lineIpc.ts`'s framing; requests up to 64 KiB, answers up to 256 KiB): `processBridge.ts` (its own `input` in `backend/vite.config.ts`, beside `todoBridge`) talks over a Unix socket in a 0700 `/tmp/cb-p-*` dir (`processIpc.ts`, the to-do IPC's framing and limits) with a capability token issued per CLI attempt, bound to `{chatId, agent, turn}` and revoked when the attempt ends; the bridge names no chat or process of its own and can reach only its chat's processes. `alwaysLoad: true` as for to-dos, and `timeoutMs` 150 000 so `wait` is not cut by the CLI's MCP timeout. It goes in every main run of a Claude agent (single chats, room members, routines, workflow Agent steps, A→B asked runs) so the tool list and prompt-cache prefix never vary; never Compact, the moderator or the room summary. A `/btw` side run gets the same server (same definitions, only when its base main run had one, `SideBase.processes`) under its own capability whose every call the IPC refuses; the side guard (`SIDE_GUARD_SETTINGS`, matcher `*`) blocks them before that anyway, and the side run's args carry no ask rule, since its one settings object must stay the guard's. (Phase 0 planned to let `list` and `logs` through; that needs a new guard matcher and its probe, so it waits.) `AgentStore.save` adds the tool names to every non-empty `tools:` list, as `withTodoTools` does, and Zumi Bot and `/make-friendly` add them where they write a `tools:` list.

**Tools.**
- `start {command, name?, cwd?, timeoutMinutes?, notify?}` → its id and name, a hint to `wait` for its ready line, and what its notify rule will do (see Wake-ups).
- `list {}` → the chat's processes: running first, then ended newest first; id, name, state, exit code, uptime, started by, the command cut at 200.
- `logs {id, tail?, from?, grep?}` → output from cursor `from`, or the last `tail` lines (default 100); `grep` a literal substring filter; the answer ends with the cursor to pass as `from` next time and the state.
- `wait {id, patterns?, timeoutSeconds?, from?}` → returns at the first line after `from` (default 0, so a ready line printed before the call still counts) that contains one of `patterns` (literal substrings, case-sensitive: no regex, so no pattern can stall the server), at exit, or at the timeout; with the line, the state and the last 20 lines. A turn's Stop closes the bridge's socket and the server drops the waiter.
- `stop {id}` → ends the tree; the record reads `stopped`/`agent`.

Every answer that holds output is scrubbed with the agent's vault values (`scrubText`, as browser results are) before it leaves the server. The calls show as ordinary tool rows.

**Permissions.** `start` is the one call that runs something, so it goes through the normal card, built like a Bash call:
- The turn's `--settings` gets `PROCESS_ASK_SETTINGS` (an ask rule for `mcp__zumibot_processes__start`) merged by `oneSettings` beside the desktop's, so the CLI sends `can_use_tool` in every mode, auto included. This is stricter than Bash in auto mode, where the CLI's classifier may approve a command with no card: a process outlives the turn, so the user sees each one start. The rule is also the only thing that makes a card appear at all: without it, CLI 2.1.326 in auto mode ran `start` with no `can_use_tool` (no classifier stop, no card). `e2e/processAskProbe.mjs` (in `npm run e2e`) checks the real CLI asks in auto and Plan mode; it passed on 2.1.326.
- The card (`ApprovalCard.tsx`, pure parts `processStartOf` in `shared/src/processes.ts` and `allowScope`/`ruleLabel` in `state/approvals.ts`) reads "Start a background process" and shows the whole command in a code block (never cut, hidden characters as escapes), the folder as the agent wrote it ("the chat folder" when absent), the name, and that it keeps running after the reply. Both remembering buttons say "this exact command in this folder", and a remembered rule is listed as "Start process: <command> (in <folder>)". The Jev risk hint gets the call's input as for any tool.
- Remembered approvals and "Allow for this chat" match the exact command and cwd: `allowKey` and `agentAllowKey` key `start` on `[tool, command, cwd]`, never on the tool name alone (today every non-Bash tool is keyed by name, which would let one "Allow always" run any command). A Bash rule never allows a `start`, nor the reverse; a workflow step rule can never name `start` (`stepRuleRefused`, so the editor refuses it rather than saving a rule that never matches). The process runs outside the CLI's Bash sandbox, so a sandboxed Bash rule could never stand for it anyway.
- Plan mode: `start` is refused while the turn is still planning (started in Plan on an engine with the `plan` cap, its plan card not yet approved in this turn): `ChatService` denies the permission request before any card, and the bridge owner carries the same `planning()` check, so a call that bypassed the card is refused too, with "Start processes after the plan is approved."
- `list`, `logs`, `wait` and `stop` touch only this chat's processes and run nothing new: `ChatService` answers them itself (`ownProcess`, as `ownTodo`): no card, rule or risk hint.
- Never `--dangerously-skip-permissions` or `bypassPermissions`.

The same limit as computer use applies: the agent's Bash children inherit `ZUMIBOT_PROCESSES_CAPABILITY`/`_IPC` and could reach the socket, so a Bash command the user approved can start a process without a second card. Bash approval is the boundary there, and such a Bash call could background a command itself anyway.

**Prompt.** The appended system prompt gets the fixed `PROCESS_SYSTEM` paragraph (`processPrompt.ts`), only for runs that carry the server, so it never varies between a chat's turns: use `zumibot_processes` only for what must keep running after the reply (dev servers, watchers); run a build or test run whose result the turn needs with Bash, with a timeout up to 30 minutes, since every `start` asks; after `start`, `wait` for its ready line; read output with `logs`; `stop` what is no longer needed; only a build or test run that should go on after the reply is started with `notify`; never background a command any other way (`&`, `nohup`, `setsid`, `disown`, `run_in_background`); a process gets no input and ends when the chat is archived, the server stops, or its lifetime runs out. Changing it misses every chat's prompt cache once.

**Bash timeouts.** Every Claude run (`claudeRunEnv` in `core/chat/runEnv.ts`, used by `claudeRunner.ts` and `claudeSdkEngine.ts`, and passed into a container run) sets `BASH_DEFAULT_TIMEOUT_MS=600000` and `BASH_MAX_TIMEOUT_MS=1800000`, unless the server's own env sets them. With the CLI's 2-minute default and background tasks off, a build longer than 2 minutes had no route but `start`, and rooms filled with process cards for one-shot builds.

## Engines

**Codex agents do not get the tool.** New `EngineCaps.processes`: Claude true, Codex false, read where the run is built (`caps.processes`) so a later Codex probe can turn it on. Reason: a Codex MCP call gets no client review in auto mode (`codex.md`, probe check 12), so the `start` card could not be forced, the same reason Codex has no `desktop`. A Codex member of a room gets no server or prompt paragraph; the room's panel still lists what the Claude members started, and the user can stop any of it.

## Server API

A new method touches `ZumiBotApi` (`shared/src/types.ts`), `rpc/handlers.ts` (every argument checked with `str()` and friends; ids must match `p_[0-9a-f]{10}` and belong to the named chat) and `frontend/src/net/api.ts`.

- `processes:list(chatId)` → `ProcessInfo[]` (commands scrubbed).
- `processes:logs(chatId, id, from?)` → `{text, from, to, dropped, state}`; at most 256 KiB, ANSI stripped, scrubbed with the starting agent's vault values.
- `processes:stop(chatId, id)` → `ProcessInfo` (`stoppedBy: 'user'`).
- `processes:restart(chatId, id)` → `ProcessInfo`: ends the tree if running, then starts the stored command in the stored cwd under the same id (`restarts + 1`, a fresh lifetime). The user's click is the approval; the limits still apply. Refused for an archived chat or on a Codex chat.
- `processes:forget(chatId, id)` → removes an ended record and its log.
- `processes:counts()` → `{[chatId]: running}` for the header marks, fetched on connect.

**Events**, broadcast to every tab:
- `processes:changed {chatId, running}` on every start, exit, stop, restart, forget and lost; clients refetch (never dedupe).
- `processes:output {chatId, id, to}`: the cursor only, about 4 times a second per process at most, never the text. Output reaches only a client that asks for it with `processes:logs`.

Nothing goes into `ChatMeta`, so `chats.json` does not churn and nothing of it syncs.

## Lifecycle

- **Server stop.** `ProcessService.shutdown()` is in `app.ts`'s undo chain: it refuses new starts first, then ends every tree in parallel (each bounded by 5 + 2 s), and writes each record `stopped`/`shutdown` before the server exits. systemd's default `KillMode=control-group` ends what a crash leaves on the VPS anyway.
- **Server start.** Before the hub serves a call, every record still `running` becomes `lost`. A pid is never adopted or re-attached: no output is read from it and it never shows as running again. After a hard crash (Local mode killed, OOM) such a tree may still be alive and hold its port. Settled: on Linux only, if the stored boot id matches `/proc/sys/kernel/random/boot_id`, `/proc/<pid>/stat` shows the same start time and the pid still leads its group, that group is ended (`endTree`) and the record says so ("ended at start", "Lost at restart (ended)" in the panel); otherwise it is marked lost and left alone. On Windows the proof is the record's id in the env of each Git Bash process (`ZUMIBOT_PROCESS`), which names nothing else, so what carries it is ended the same way. The start-time check rules out a reused pid. Ending is not adopting: nothing is read from it and it never shows as running.
- **Archive.** `chats:archive`, the handlers' `archiveChat` (Keep this one in a set of attempts), and `workflowAgentSteps`' archive of a step's chat each `await processes.endChat(id, 'archive')` before `releaseInBackground`, so a dev server writing into the worktree cannot make the release refuse a tree it is still dirtying. `endChat` marks the chat closed first, so a start racing the archive is refused. Unarchive starts nothing.
- **Remove.** `chats:remove` and `workflowRooms`' removal of a temporary room end the chat's processes (`'remove'`) before the worktree release, then delete `processes/<chatId>/` and the chat's records. A `ChatStore` removal listener calls `endChat` too, as a backstop for any path that removes a chat without it.
- **Stop.** Stopping a reply (Stop, Stop while pausing, Edit or Resend stopping a reply) ends no process. That is the point of the feature.
- **Pause.** Pause and Resume do not touch processes. Phase 3 wake-ups wait in a paused chat (below).
- **Fork, Clone room, Edit, Resend, version switches** never copy, restart or move a process; a fork or a clone starts with none.
- **Agent rename.** `startedBy` moves with the other renames, after stored chats (`ProcessService.renameAgent`, caught and logged by code like voice).
- **Agent deleted.** Its processes keep running until stopped; the row shows the old name.

## Busy check

Running processes **do not count** in the control socket's `busy` answer: the installer, sync and the desktop treat `busy` as running replies, and a dev server may run for hours, so counting it would block an update until the user stops it. Processes only produce a warning:
- `control.ts` answers a new line, `processes`, with the running count; an older server answers `error`, read as 0. `zumibot-server processes` prints it.
- `sync.mjs` (it restarts the server) prints "N background processes will be stopped by the restart." and goes on; `busy` and its refusals are unchanged, as is `install.sh`.
- The desktop shell's quit (Local mode stops the server) asks too: it polls `processes()` (the control line) beside `busy()`, and `decideClose` asks when either is above 0. With processes only, the dialog reads "N background processes will stop. Quit?" with Cancel and Quit; with replies too, "N replies still running, and M background processes will stop. Stop them and quit?" with Stop & Quit (`runningMessage` in `quitGuard.ts`). An older server answers `error` to the line, read as none. "Switch server…" away from Local mode asks the same way (`createSwitchServer`'s `processes`, `switchMessage`: "2 background processes will stop. Switch server?" with Cancel and Switch; with replies too, Stop & Switch).

## UI (Phase 2)

- **Side panel.** `SideView` has `'processes'` (a chat view, so Esc and the live-view rules treat it like Dispatched agents). `SidePanelMenu` shows **Open Processes** (`side-open-processes`, a terminal glyph) with `processesBadge`: "N running", marked `live`, while any runs, else how many there are, nothing for none. The row shows when the chat's engine has the `processes` cap (a room: any member), or while its list holds anything, so a room whose Claude member started one still lists it.
- **List** (`ProcessesPanel.tsx`, `processes-panel`). Rows (`process-row`, `data-id`, `data-state`, Dispatched agents' row look) in `processRows` order, running first then ended newest first: a dot by tone, the name, the state in words (`stateLabel`: Running, Exited (code N), Ended by SIGNAL, Stopped by you / by the agent / at archive / at its time limit / with the server, Lost at restart, Failed to start (CODE)), the command on one line (whole on hover), the starter's display name and "up 5m" or "3m ago" (a clock ticks only while one runs). `useProcesses` fetches `processes:list` when the chat changes or the socket returns, and again on every `processes:changed` for the chat.
- **Log view** (a row's click, `process-log-panel`). The state, starter and uptime, the whole command in a code block, the folder, then **Stop** (while running; ends the whole tree), **Restart** (unless the chat is archived; ends a running one first) and **Forget** (once ended; back to the list), from `processActions`; an error shows the server's sentence. The output (`process-log`, monospace) is `useProcessLog`: the newest part first (`processes:logs` without a cursor), then each `processes:output` past what it holds is read from its cursor, one read at a time, an event during a read caught up after it, and a `processes:changed` reads again (a restart, a missed event). `joinLog` appends a read that starts where the view ends and starts over on anything else (a gap: "earlier output is no longer kept"), and keeps the newest 512 KiB of whole lines (`LOG_VIEW_MAX`). It follows the end while the reader is at the bottom and stays put once they scroll up.
- **Header mark** (`ProcessMark`, `process-mark`, beside the side panel's toggle; on a phone in the mobile bar). While the chat has running processes: a live dot, the terminal glyph and the count past one, titled "N processes running"; a click opens the panel on Processes. `useProcessCounts` fetches `processes:counts` on connect and keeps each chat's count from the change events (`countsAfter`); the island page never asks. The sidebar row, the composer's Stop, `inFlight`, unread and notifications are untouched: a live process is not a running reply.
- **Pure rules** are `frontend/src/state/processes.ts` (`stateLabel`, `processRows`, `processesBadge`, `processMark`, `countsAfter`, `processActions`, `joinLog`, `logBehind`), tested in `frontend/tests/processes.test.ts`; the components only draw them.

## Wake-ups (Phase 3)

- **Rule.** `start`'s optional `notify {on: 'exit' | 'fail' | 'match', patterns?, times?}` (`NotifyRule`, checked by `parseNotify` and the tool parser: `match` needs `patterns`, which only it takes; `times` 1–5, default 1). `exit` fires on any natural end, `fail` on a non-zero code or a signal (`exitFires`), `match` on each new output line holding one of the patterns (literal, as `wait`). A stop by anyone (agent, user, archive, lifetime, shutdown) and a spawn that failed never fire. The record keeps it as `wake {on, patterns, times, fired, note}` (in `index.json`, so it outlives a server restart; a lost process fires nothing). `fired` counts at once when an event is raised, so a burst of matching lines in one chunk stops at `times`; the user's Restart sets it back to 0. The agent's `start` answer says what it set up ("You will get a message in this chat if it fails (at most 3 times); a stop by anyone never sends one."), and `PROCESS_SYSTEM` tells it to use `notify` for a build or test run that should go on after the reply (one it needs the result of runs in Bash).
- **The event** (`WakeEvent`, `ProcessService.raise`): the process, its starter, how it ended or the matching line, and the last 40 lines of output (at most 4 KiB, lines cut at 300 characters, scrubbed with the starter's vault values), handed to `ProcessWakes` (`core/processes/processWakes.ts`) through the service's `onWake`.
- **Sending.** `ProcessWakes` keeps each chat's events in memory and sends them as one message: at once in an idle chat, else at the chat's next idle (the last step of ChatService's `onIdle` in `app.ts`), so never while a turn runs; events that came meanwhile are joined (`wakeMessage`: the newest 10 events, then the newest tail of each process once). While an earlier wake message of the chat still waits in its queue (a paused chat, a usage-limit wait), new events wait for the idle after it. The message goes through `TaskQueue.submit` with the new `SendFrom` `'process'`, which acts as `'routine'` does: the chat's normal claim and queue, `auto` on the queued task and the turn (so Zumi Bot cannot change automations in it), held in a pausing or paused chat and never ending a pause. Unlike a routine's, it never ends a usage-limit wait either: while `meta.resume` stands it queues, so the wait's continue goes first and the wake-up follows that turn. In a room it leads with the starters' `@mentions`, so the room hands it to them through `GroupService`, never `ChatService.send`. As with a routine's message, the stored user item is a plain one: its first line, "Background process update (sent by ZumiBot for a process's notify rule, not typed by the user):", says who sent it, and it ends with what is expected ("Act on it if it needs you …; the user may not be watching.").
- **Gates, checked when the message would go.** An archived chat drops its events; a deleted one forgets them (`forget`, from the store's removal listener). An agent past its daily spend cap (`SpendCaps.gate`) has its own events dropped while the others' still go. Hard caps: per process `times` (≤ 5), per chat 6 wake messages an hour, per server 30 an hour (`WAKE_PER_CHAT_HOUR`, `WAKE_PER_SERVER_HOUR`), so a crash loop cannot run up cost. A dropped event writes its reason on the process (`noteWake`: `WAKE_NOTES`, "Wake-up skipped: daily spend cap", "… this chat had 6 in the last hour", "… the server had 30 in the last hour", "… the chat is archived"), and the next wake message sent for it clears it (`wakeSent`). Waiting events live in memory only: a restart loses them, as it loses the processes.
- **UI.** A process with a rule shows it under its row and in its log view (`process-wake`, `wakeLabel`: "Wakes the agent when it exits", "… if it fails", "… on lines with "FAIL"", then "· 1 of 3 used" or "· used"), and a skipped wake-up's note beside it in the warning colour (`process-wake-note`).
- **Checked with the real CLI** (2.1.326, a Haiku agent, auto mode): asked to run a test suite in the background and hear if it fails, the agent set `notify {on: 'fail'}` itself; the process failed while that turn still ran, so the event waited and went out at the idle as one message with the exit code and the last lines, and the agent answered it on its own turn.

## Tests

- **Service** (`backend/tests/core/processes/`), with real short-lived children: a tree (bash → sleep → sleep) is gone after `stop` and after leader exit; SIGTERM-ignoring trees get SIGKILL; per-chat and server caps and their sentences; lifetime; cwd escape by `..` and symlink refused; env has no `ZUMIBOT_*`, capability or vault key; ring and log rotation and cursors across a restart; `running` → `lost` on a new service over the same file (and the boot id / start-time rule); archive ends processes before the release is called; remove deletes logs; rename moves `startedBy`.
- **Wake-ups**: `processService.test.ts` (exit once with its tail and never after a stop, fail only on a failure, match per line up to `times` and again after Restart, refused rules, the rule across a restart), `processWakes.test.ts` (joined while a turn runs, sent at the idle, waiting behind its own queued message, room mentions, the spend cap, an archived or gone chat, both hourly caps), `taskQueue.test.ts` (a `'process'` message held in a paused chat, auto, the pause kept; queued behind a usage-limit wait, in a single chat and a room, the wait kept, and sent after the continue's turn), and `processesApp.test.ts` (a single chat's wake-up turn, and a room's reaching its member).
- **Bridge and IPC**, as the to-do bridge's: bad token, revoked token, another chat's id, framing limits, `wait` aborted by a closed socket.
- **ChatService**: `start` takes a card and its rules key on command and cwd; `list`/`logs`/`wait`/`stop` answered without one; Plan refuses; Codex runs get no server.
- **Fake claude fixture** `fake-process-claude.mjs` runs the real injected bridge from `--mcp-config`, checks the merged `--settings` holds the ask rule, sends `can_use_tool` before `start`, and calls the tools.
- **Built bundle** (`processesApp.test.ts`, Phase 1): the real server bundle, `fake-process-claude.mjs` and the real bridge. One turn starts a process behind its card and waits for its ready line, the next reads its log, an "Allow for this chat" rule lets the same command and folder start again while another command asks, `processes:stop` ends the tree, archive ends the rest, a Plan turn is refused before any card, `busy` stays 0 while `processes` counts, and SIGTERM to the server ends every tree and writes it `stopped`.
- **By hand with the real CLI** (Phase 1, 2.1.326, a Haiku agent, the server's own auto mode): the card showed the exact command; the agent called `start` then `wait` as `PROCESS_SYSTEM` asks; the server served the folder after the turn ended; the next turn's `logs` read back the request made meanwhile; `processes:stop` closed the port; the server wrote nothing to its stderr.
- **E2E** `e2e:processes` (`e2e/processes.e2e.mjs`, the built server, headless Chrome, `fake-process-claude.mjs` running the real bridge): a start behind its card, which shows the whole command and what "Allow for this chat" covers; the agent's `wait` sees the ready line; the header mark shows while the composer offers Send and the sidebar shows no working agent; the next turn reads the log; Open Processes · 1 running; the row's log grows live; Stop ends the shell and the mark goes; Restart runs it again under the same row after its marker; Forget empties the list; a `notify: fail` process that fails after the reply posts its wake message, the agent answers it, and its row reads "Wakes the agent if it fails · used"; a reload shows nothing running; no console or server errors.
- **Frontend** pure modules: `state/processes.ts`, `state/processLog.ts`.

## Docs and repo rules

This doc, [Run button](run-blocks.md), a pointer `core/processes/CLAUDE.md`, an index line in root `CLAUDE.md` (which stays under 16 KB), `data.md`, `deploy-and-sync.md`, and the remembered-approvals paragraph of `agents.md`. Dependencies: none new.
