# Pause and Resume a running reply

Date: 2026-11-06. Status: approved.

## Why

Long tasks run for a long time, often with a main agent that sends work to subagents. Sometimes the user wants to stop for now and pick the task up later (end of day, quota, another job first). Today the only way out is **Stop**:

- Stop kills the CLI at once. Subagents that are halfway through their work die with it, and that work is lost.
- On **Continue**, the main agent has subagent calls in its session that never got an answer. It then tries to collect answers from subagents that are no longer running (the user hit this).
- Messages typed while the reply runs go to the queue and are sent when it ends, so they can't stop it. A Stop also starts the oldest queued message right away. Side questions never touch the main run (by design).

The user wants a clean pause. Subagents already running are allowed to finish, the main agent starts nothing new, and the run ends at a point where everything is recorded. Later, Resume picks the task back up with nothing missing.

## Goals

1. A **Pause** action next to Stop while a reply runs, in single chats and rooms.
2. While pausing, subagents (and their nested subagents) that are already running finish normally, and so does a main-agent tool call that is already running. The main agent cannot start any new tool call, subagents included.
3. Once nothing is running, the main agent writes a short status (where it is, what's next) and the run ends. The chat shows a **Paused** marker.
4. Nothing starts by itself while paused. Queued messages stay held, after a server restart too.
5. **Resume** continues the task. The agent's session holds every subagent result, so it never goes looking for missing ones.
6. Separate fix: after a hard **Stop** (or a restart) that killed running subagents, the agent's next turn is told which subagents were killed and never returned. A graceful shutdown (a deploy, a systemd stop) counts as a restart here; a hard crash or reboot cannot be recorded, because the dispatch file is written only when a turn finishes.
7. A paused (or any) chat can be resumed after a PC or server reboot with its agents' working files intact. Today the CLI keeps them in `/tmp`, which a reboot wipes.

## Non-goals

- Freezing a process (SIGSTOP or similar). A pause ends the CLI run, and Resume is a new turn on the same session.
- Taking back a pause before it lands ("keep going"). Use Resume after it pauses.
- Pausing a `/btw` side answer, the moderator or a Compact.
- Changing Stop's own behavior, apart from the note in goal 6 and the Stop-while-pausing case below.

## Anti-goals (a failure even if it works)

- A subagent killed mid-run by Pause.
- A queued message, routine retry or room member starting on its own while the chat is paused.
- Any change to the prompt-cache prefix of normal runs. Hooks and env do not enter the prompt; nothing may be added to the system prompt or tools for this.
- A pause that can hang forever with no way out. Stop must always work while pausing.

## How it works

### Blocking new work: a PreToolUse hook

Every main run (single-chat turns, room member turns, routine runs, A→B asked runs) gets one more `--settings` entry: a `PreToolUse` hook (matcher `*`), merged by `claudeRunner.oneSettings` like the desktop ask rules and the side guard. The run's env gets a per-attempt pause flag path, for example `ZUMIBOT_PAUSE_FILE`, pointing into a 0700 run dir. Neither changes the prompt.

The hook command is cheap when the flag is absent. It is a shell test that exits 0 at once, so normal runs pay only a `sh` spawn per tool call. When the flag file exists it runs a small node script (launched with the same node binary and env handling as the existing MCP bridges, so Local mode's Electron node works). The script reads the hook input JSON from stdin:

- `agent_id` present at the top level means a call from inside a subagent. Exit 0, so subagents keep working. (CLI 2.1.317's own schema says: "Absent for the main thread, even in --agent sessions. Use this field (not agent_type) to distinguish subagent calls from main-thread calls.")
- Absent means a main-thread call. Block it (exit 2, reason on stderr) with a fixed message, for example: *"The user paused this task. Do not start any tool or subagent. In a few lines, say where the task stands and what the next step is, then end your reply."*

A parse failure blocks the call, since the flag is set and blocking is the safe side.

Calls already running when the flag appears are not touched. A main-thread `Agent` call that is running is exactly the subagent we want to finish.

### The pause lifecycle

1. **Pause pressed** (`chats:pause {chatId}`). The server writes the flag file for every live attempt of that chat (each running member in a room), and sets `held` on the chat right away, so a restart mid-pause keeps the tray held. The chat gets a `pausing` state that the UI can show. It is refused when the chat is not running.
2. **Pausing.** Running subagents and tool calls finish. The main agent's next tool call is blocked, it writes its status and the turn ends with a normal `result`. The working tray shows "Pausing — waiting for N subagents" (N from the live dispatch entries) and **Stop** stays available.
3. **Safety cap.** If the main agent keeps trying tools for 3 model responses in a row (3 blocked rounds, where a round is one response's worth of calls) and nothing is running in the main thread or any subagent, the server stops the run. It is checked only when a blocked result arrives, never when another call finishes, so the agent always gets a request after its last allowed call to read results and write its status. That is safe because no tool is mid-flight.
4. **Ended.** The turn ends with a new notice, kind `userPaused` ("Paused. Press Resume to continue."). The existing `paused` kind belongs to the room hop cap, so it is not reused. Unread and notifications treat it like a normal reply end (`replied`), so a user who walked away learns the pause landed.
5. A reply that finishes the whole task on its own while pausing still ends with the `userPaused` marker and a held tray, because the user asked for nothing new to start.
6. **Unclean ends still count as paused.** Once Pause is pressed, the chat is paused however the run ends: the user presses Stop while pausing, the server restarts mid-pause, or the turn ends with an error or usage limit. The `userPaused` marker goes after whatever item that end wrote (`stopped`, `interrupted`, the error), `held` stays, and Resume shows. Recovery at startup adds the marker for a chat that was pausing. This is the one change to Stop: a Stop while pausing keeps the tray held instead of starting the oldest queued message. The paused state is stored on the chat (for example `ChatMeta.pause`: `pausing` while the run ends, `paused` after), not read from the last item. Resume's visibility follows that state.

### Resume

- **Resume** shows where Continue shows, while the chat is paused. It clears the paused state and `held`, and sends `Continue` (the existing `CONTINUE_TEXT`) as a normal send. Queued messages go after that turn, as usual.
- If the user types a new message instead, it goes straight in and the held tasks stay held, the same as today's held tray (Send now per task).
- Resume works the same days later. Prompt-cache expiry is the cold-context notice's job, not this feature's.

### Rooms

Pause applies to the room. Every member run that is going gets the flag, and the moderator does not schedule another member. The pass ends once the running members end. The room's tray is held and the room shows the `userPaused` marker.

Members still waiting in the room's queue (for example ones the user @mentioned that had not started) are not dropped, unlike the hop-cap pause and Stop. The queue is saved with the paused state (in `GroupInfo`, with each queued member's turn reason, so a member the user @mentioned is still asked for a real reply after Resume) and survives a restart. Resume sends `@m1 @m2 … Continue`, addressing every member that was running when Pause was pressed, the same way the routine limit-wait addresses its stopped members. The saved queue is then restored, so the waiting members run after them as they would have. A message the user types instead of Resume clears the saved queue: the user has taken over, and the moderator routes the new message as usual.

### Other paths

- **Routines (decided by the user): a routine run into a paused chat or room waits for Resume.** Scheduled, webhook and manual runs that target a paused chat put their message in the held tray instead of starting the agent. Today `TaskQueue.submit` sends straight into an idle chat even when its tasks are held, so a paused chat must make every send that is not the user's own queue. The user's own typed message still goes straight in, as with today's held tray. The run stays `waiting` (or a new "queued" state) and counts toward the 5-unfinished cap; it ends when its message is finally sent and answered. A routine paused for several days leaves one queued message per run, and that is accepted.
  - `sessionPolicy: 'fresh'` must not touch a paused chat. `RoutineRunner.startFresh` is skipped for a run whose chat is pausing or paused, so the paused session and its subagent results survive. That run's message then continues the paused session after Resume.
  - A paused routine run, meaning the routine's own run is the one the user paused, ends like a user stop (silent, no `routine-failed`).
  - A `limit` wait that comes due in a paused chat or room does not send its `continue`. The run ends as "Continued by hand", the same as when a user message arrives meanwhile.
- **A→B asks.** Pausing A does not pause B. A's running `ask` call is a running tool, so it is allowed to finish. B's chat is not touched.
- **Approval cards while pausing.** They stay until answered. A main-thread card means the hook already allowed that call, so answering it lets it run, and the pause lands after it.
- **Side runs.** They do not get the pause hook. They already deny every tool with their own guard, and their settings stay byte for byte as today.

### Goal 6: telling the agent about killed subagents

When a turn ends stopped or interrupted, `DispatchRecorder` already marks its still-running entries `stopped` or `interrupted`. That alone is not enough: on SIGINT the CLI first aborts its running query, so it may close the running subagents `failed` before it exits. So the turn notes which of its own subagents are running at the moment the Stop is asked for, and at its end the killed ones are those that did not come back done, plus any started while the CLI wound down that still run. The next turn of that agent in that chat (single chat, or that member in a room) gets a one-time note at the end of its message, like the to-do state note and never a chat item. It lists each killed subagent's description: *"Your last reply was stopped while these subagents were running. They are not running now and their results are lost: … Run them again if you still need them."* The note is cleared once sent, and also by Edit, Resend and version switches, which rewind to before that turn. A Pause never produces it, because nothing is killed.

### Goal 7: working files that survive a reboot

**What is lost today.** The session log (`~/.claude/projects`) survives a reboot. The CLI's per-session temp folder does not: `/tmp/claude-<uid>/<cwd slug>/<session id>/`. It holds:

- `scratchpad/`: the CLI's system prompt tells agents to put intermediate notes and results here.
- `tasks/*.output`: the output files of subagents and long commands.
- `images/`

After a reboot a resumed agent reads paths from its own history that no longer exist. That folder held 73 MB after half a day of use on this PC.

**Fix.** CLI 2.1.317 honours `CLAUDE_CODE_TMPDIR`, which moves its temp root. Every CLI run ZumiBot starts for a chat gets `CLAUDE_CODE_TMPDIR=<data dir>/claude-tmp/<chatId>` (folders 0700, made before the spawn). That covers single-chat turns, room member turns, routine runs, A→B asked runs, Compact and `/btw` side runs. A side run uses the folder of the chat whose base it reuses, so its env matches the main run's. The moderator, room summary and other bare `--no-session-persistence` calls keep the default, since they write nothing worth keeping. `claude` run in a terminal is not touched.

**Why per chat (builder's call, user said "you decide").** Sessions change id on Edit, Resend, version switches and forks, and a later session's history can point at an earlier session's scratchpad. One folder per chat keeps all of a chat's sessions together, so clean-up can follow the chat and never has to work out which session ids are still referenced.

**Retention (builder's call).**

- A chat's folder lives as long as the chat. There is no age limit, so a chat paused for weeks still resumes with its files.
- Archiving keeps the folder.
- Deleting the chat deletes the folder. This is a direct delete, not the Trash, like `file-snapshots/<chatId>`.
- At server start, folders whose chat no longer exists are removed. That catches deletes made while the server was off or made by sync.
- Fork and Clone room start with no folder of their own. A fork's copied history may name paths in the source chat's folder, and those keep working while the source chat exists.
- `sync.mjs` never copies `claude-tmp/`. The paths differ between machines, and it is working state, not data, the same as `desktops/`.

**Things the builder must verify against the real CLI:**

- **Prompt cache.** The scratchpad path is written into the system prompt, so each existing chat's first turn after this ships writes the cache once at full price. This is accepted and one-time. Per chat, the path is stable from then on. Check that the main and side runs of one chat get the same path, so a side answer still reuses the main run's cache.
- **Socket path length.** The CLI may place Unix sockets under its temp root unless `XDG_RUNTIME_DIR` is set ("Point XDG_RUNTIME_DIR or CLAUDE_CODE_TMPDIR at a private (0700) directory"). `<data dir>/claude-tmp/<uuid>/claude-<uid>/…` may pass the 108-byte socket path limit. If it does, keep or set a short `XDG_RUNTIME_DIR` for sockets, or shorten the folder name (for example a short hash of the chat id). Check on the VPS service too, where `XDG_RUNTIME_DIR` may be unset. (Built: a 16-hex hash of the chat id. That shortens the path but can still pass the ~104-byte limit with a long data dir or user name; CLI 2.1.317 survives it: sandboxed Bash falls back to another `$TMPDIR` with a debug warning, and only the `[uds-messaging]` socket, which ZumiBot does not use, fails to start when `XDG_RUNTIME_DIR` is unset.)
- **Content.** Check what the CLI puts under the moved root beyond the per-session folder, for example `bash-edit-diff/` and `cache-break-state-*.json`. None of it may be shared state that another chat's runs expect to find.

## Testing

- **Unit:** the hook script (main-thread call blocked, `agent_id` allowed, bad JSON blocked, no flag allowed), the settings merge with the side guard and desktop rules, TaskQueue holding and Resume, the pause lifecycle in `ChatService` and `GroupService`, the safety cap, and the killed-subagent note (made, sent once, cleared by Edit/Resend).
- **Fake claude:** it learns to run the merged `PreToolUse` hook for scripted tool uses, with and without `agent_id`, and to honor a block as the CLI does. A new `e2e:pause` suite (fake only, no quota) presses Pause while scripted subagents run. It checks that they finish, that the main agent's next call is blocked, that the `userPaused` marker and held tray appear, that Resume sends Continue, and that a restart mid-pause keeps the tray held.
- **Temp folder:** unit tests check that the env is set for each run kind (and not for bare calls), that a side run gets its base chat's folder, that the folder is deleted with the chat, and that the startup orphan sweep works. The fake claude records `CLAUDE_CODE_TMPDIR` in `FAKE_INVOCATIONS_OUT`, so an e2e check can see it was set.
- **Real CLI probe:** `e2e/pauseProbe.mjs --soft` runs in `npm run e2e` like `desktopAskProbe`. With the flag set, a main-thread tool must be blocked, a subagent's tool must run, and the session must hold the subagent's result. Exit codes are PASS / FAILED / INCONCLUSIVE, with one retry. This guards against a CLI update dropping `agent_id`.

## Decided by the user

- Pause is separate from Stop. Running subagents finish, and no new subagents start.
- The picture above as played back: the Paused marker, held tray, Resume, rooms included, and approval cards staying until answered.
- Stop's killed-subagent problem gets its own fix (goal 6).
- A routine run into a paused chat or room waits in the held tray for Resume. It is not skipped and does not run anyway.

## Builder's calls (made while writing this; open to change)

- A PreToolUse hook with `agent_id` as the blocking mechanism, rather than permission prompts. Auto mode auto-allows most tools, so a permission prompt can't block them, and settings are fixed at spawn.
- The flag file plus a node script, run only while the flag is set.
- No "keep going" undo before the pause lands.
- The main agent writes a short status before ending, which costs one extra request.
- Resume sends the plain `Continue`.
- The safety cap of 3 blocked rounds (not calls; ruled during the build).
- The notice and RPC names (`userPaused`, `chats:pause`). The Pause button's exact place and its phone layout are left to the builder, next to Stop.
- Unclean ends still count as paused, and a Stop while pausing keeps the tray held.
- In rooms, members waiting in the queue are kept across a pause. Resume addresses every member that was paused, then the kept queue runs.
- A `limit` wait that comes due in a paused chat ends as "Continued by hand".
- Temp files (goal 7): one `CLAUDE_CODE_TMPDIR` folder per chat in the data dir, kept as long as the chat, deleted with it, orphans swept at start, never synced.
