# `/btw` side questions: design

Date: 2026-11-03. Built from the user's request and a short talk, with visual mockups. What the user decided is marked **(user)**. What I played back and the user approved is marked **(approved)**. Everything else is my call and can be changed.

## Why

During a long run the agent works through a big list (for example 40 pages to migrate). The user wants to know where it stands, "how many tasks are left?" **(user)**, without stopping it and without waiting for it to end **(user)**. Today a message sent mid-run waits in Tasks until the run ends (`TaskQueue`, `2026-10-26-queued-tasks-design.md`), so the answer would come when it no longer matters. Stopping the run to ask costs the work in progress.

`/btw` asks a side question. The chat's own agent answers it at once from what it knows so far, and the main run goes on untouched. A side question may also have nothing to do with the run **(user)**.

Prior art: Claude Code's own `/btw` in its terminal UI, which answers from the conversation so far, with no tools, and keeps the answer out of the history. ZumiBot keeps the answer for good (see goal 3).

## What the user sees

- In the normal composer the user types `/btw how many tasks left?`. `/btw` shows in the `/` menu as a built-in, before the agents' own commands: "Ask on the side; the run keeps going".
- It is sent at once, whether the chat is running or idle **(approved)**. It never goes into Tasks and never waits.
- A small chip, `btw · how many tasks left?`, appears in the chat at the spot where it was asked **(user, mockup option C)**. While the answer comes it shows a spinner.
- A **Side questions** panel opens beside the chat, in the same side slot the Files panel uses, and the answer streams in **(user, option C)**. Each entry shows the question, who answered (with the member's colour dot in rooms), the time and the answer, rendered like an agent message.
- The main reply keeps streaming in the chat the whole time.
- Clicking a chip later opens the panel scrolled to that entry. Esc or × closes the panel. On a phone the panel is a full-screen sheet, like Files **(approved)**.
- Chips and answers stay in the chat for good, after a reload and on every device **(user)**.

Mockups: `.superpowers/brainstorm/1260799-1793694460/content/btw-placement.html` (the three placements, C chosen) and `btw-side-panel-v2.html` (C in detail). Both are git-ignored scratch files, not part of the build.

## Goals

1. **Ask while the run goes on (user).** `/btw` is answered at once. The main run is never stopped, paused, slowed by ZumiBot or changed.
2. **The answer knows the run so far (approved).** It comes from the chat's own agent (same persona and model), and it sees everything the run has done up to the moment it was asked, including its to-do list and tool results. That is what makes "how many tasks are left?" answerable.
3. **The answer stays (user).** It lives in the Side questions panel, with a chip in the chat marking where it was asked (option C).
4. **The agent never sees side questions (approved).** Not in the run that is going, not in later turns, not after an Edit, Resend, reseed or Fork.
5. **No tools in a side answer (approved).** It answers from what it already knows. It cannot edit files, run commands or raise an approval card, so it can't get in the main run's way.
6. **Rooms: the moderator decides who answers (user).** `/btw @member …` skips the moderator and asks that member, the same way an @mention works **(approved)**.
7. **Each side question stands alone (approved).** It sees the main run, not earlier side questions or their answers.

## Non-goals

- A conversation inside a side question (a follow-up to an answer). Each `/btw` is one question and one answer.
- Deleting or editing side questions.
- Tools of any kind in a side answer, read-only ones included.
- `/btw` from the message edit box, Resend, routines or webhooks. There it is plain text, as other commands are in routines.
- Attachments or quotes on a side question. It is text only.
- Moving a side answer into the main conversation ("tell the agent this").
- Notifications or unread dots for side answers. The user is watching when they ask **(approved)**.
- Jev for picking who answers in a room.
- A separate line for side questions on the Usage page. Their cost folds into the agent, like any run.

## Anti-goals

These would make it a failure even if it "works":

- The main run is stopped, restarted, delayed or changed. Its session file gets a single extra line.
- The agent ever reads a side question or its answer, now or in any later turn.
- A side answer runs a tool, or an approval card appears for one.
- `/btw` lands in Tasks, or waits for the run to end.
- A side answer is lost on reload, on another device, or after a restart once it has finished.

## How (decided)

### Running a side answer

A side answer is a separate `claude` process forked from the agent's session as it stands at the moment of asking **(approved)**:

```
claude <the main run's own args, built by buildArgs for this agent and chat>
  with the session part replaced by:
  --resume <S> --resume-session-at <AT> --fork-session --no-session-persistence
  plus the tool guard (see Tool lockout)
```

**Reuse the main run's prompt cache (user).** Each side run makes the same request start as the main run, so it reads the forked context from the prompt cache instead of paying to write it again. On a long run that is roughly 10x cheaper per `/btw`, and it uses far less of the plan's 5-hour limit. So everything that shapes the start of the request is identical to the agent's own runs: the same `--agent`, `--permission-mode`, appended system prompt, `--disallowedTools`, `extraArgs` (add-dir, agent browser) and MCP servers. The MCP servers start for each side run, and that slower start is accepted **(user)**.

- `--resume-session-at` and `--fork-session` are the hidden pair Edit, Resend and Fork already rely on. `--no-session-persistence` means the side run writes no session file at all, so nothing in `~/.claude/projects` changes.
- Same `cwd`, environment (`runEnv`, the shell `PATH`) and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` as the agent's own runs, and the same `--agent`, so the model and persona match.
- **The fork is checked like a cut run.** If the side run's `init` reports `S` itself, `--fork-session` was ignored: the side run is stopped at once and the entry shows the `FORK_IGNORED` error naming the CLI version. A failing side run is a visible error. It is **never** retried as a plain `--resume`, which would write into the main run's session.
- **The appended system prompt is the main run's own** (house style, memory note, room briefing, browser prompt), built the same way, so the persona is the same. Without it, `--system-prompt-snapshot off` would drop all of that.
- **The side note goes in the user message on stdin**, before the question, not in the system prompt (my wording, builder may tune): "The user is asking you a side question with /btw while your main work goes on in another process. Answer only this question, briefly, from what you already know in this conversation. You cannot use tools here. Do not continue, restart or change the main work; this answer does not affect it."

### Where the fork starts (`S` and `AT`)

Per agent (the chat's agent, or the room member who answers):

- **That agent is running now.** `S` is the live turn's session id (from its `init`) and `AT` is the latest *clean* entry of the turn: an entry after which every `tool_use` this turn has made already has its `tool_result`. `ChatService` (and `GroupService` per member) track this in memory from the `entry`, `toolUse` and `toolResult` events they already parse, and expose it, for example `sidePoint(chatId, agent): {session, at} | null`. Cutting at a clean entry keeps a half-finished tool call out of the fork. While a long subagent (`Task`) call is pending, the clean point stays before it, so the answer does not see that subagent's progress. That limit is accepted.
- **Running, but no `init` yet** (the turn just started), **or idle.** The point the next turn would start from: the agent's last `end` stamp (`session`, `at`), or the chat's `next: {at}` after an Edit, or the member's `GroupInfo.next` in a room.
- **No session to fork** (a new chat, `next: {seed: true}`, or a session file that is gone). The side run starts fresh (no `--resume`) with the visible items as context, the way a reseed builds its prompt (`seedPrompt.ts`), plus the question. It still writes nothing (`--no-session-persistence`).

### Tool lockout

The requirement is fixed: no tool ever runs in a side run, MCP tools included, and no approval card is ever shown for one. To keep the cache, tools stay defined exactly as in the main run and every call is refused **(user)**. Removing them (`--tools ""`, `--strict-mcp-config`, extra `--disallowedTools`) would change the request start and lose the cache, so it is out.

- **The guard (preferred):** a `PreToolUse` hook passed with `--settings`, matching every tool and answering deny ("No tools in a side answer"). A hook's deny wins over allow rules, so the user's own allow rules in `~/.claude/settings.json`, auto mode and read-only auto-allows cannot let a tool through. The probe checks that it holds and that it leaves the request start unchanged.
- **Second line:** ZumiBot answers every `can_use_tool` a side run sends with deny and never shows a card.
- If the probe finds the hook does not hold for some tool, the builder picks another refusal that does and that keeps the request start unchanged. If none does, stop and ask the user before falling back to removing tools.

### Rooms

- `/btw @member question`: that member answers. A name that is not a member is refused before anything is stored.
- `/btw question`: the entry is stored with state `picking`, and a moderator call picks one member. It uses the same Haiku runner as `moderator.ts` with its own prompt and JSON schema `{member}`. Its input is the members, who is working right now, the last `MODERATOR_MESSAGES` messages (cut as the moderator cuts them) and the question. It has the same `MODERATOR_TIMEOUT_MS`. Its cost is recorded through `usage.recordModerator`.
- If the moderator fails, times out or names no member, the fallback is the one member running now if exactly one is, else the member who spoke last, else the first member.
- The chip and the panel entry show who answered.
- **What the answering member sees (my call).** A member's session holds only what it has been fed. So the side run's user message also carries the room messages the member has not been fed yet, built the way its next turn would build them (`threadEntries` / `buildTurnMessage` since its `seen` point). That includes whatever other members have stored so far while they work. Then come the side note and the question. Without this, an idle member could not say how far the others have got.

### Data

A side question is not a chat item. It lives in its own file per chat, `chats/<id>.btw.json`, so none of the readers of items (seed, moderator, fork's item copy, Edit/Resend, `readAs`, Files panel, unread, notifications, usage message records) can ever pick it up **(approved)**. That is how goal 4 is enforced: by where the data lives, not by filters someone could forget.

```ts
interface SideQuestion {
  id: string                 // the client's id for the ask
  question: string           // the text after `/btw`, trimmed
  agent: string | null       // who answers; null while a room's moderator is picking
  mention?: true             // asked as `/btw @member`, so no moderator call
  askedAt: number
  after: string | null       // id of the chat's last item when asked; null = before the first item
  state: 'picking' | 'running' | 'done' | 'error' | 'stopped'
  answer: string             // Markdown; grows while it streams
  error?: string
  endedAt?: number
}
```

- A store in `backend/src/core/btw/` (my naming) reads and writes the file atomically, like the versions file. Saves while streaming are coalesced like item saves.
- **The chip's place** is `after`: the chat's last stored item when the question was asked. The reply still streaming then is not an item yet, so when it is stored it lands below the chip. That puts the chip where the user asked.
- If the `after` item is no longer visible (an Edit or Resend moved it into a hidden version, or a version switch), the chip is not shown, and the entry stays in the panel. Paging: a chip whose item is not loaded yet appears when that page loads.

### API and events

New RPCs (the usual three places: `ZumiBotApi`, `rpc/handlers.ts`, `net/api.ts`):

- `btw:ask(chatId, question, id)` → the new entry. It checks the text (non-empty, same length cap as a message), the `@member`, and the limit, then stores the entry and starts the run. It resolves once the entry is stored, not when the answer ends.
- `btw:list(chatId)` → all entries, oldest first.
- `btw:stop(chatId, id)`: stops a `picking` or `running` entry. State `stopped`, and the partial answer is kept.
- `btw:again(chatId, id)`: on an `error` or `stopped` entry, runs the same question again in place: same entry, same chip, a fresh fork point.

Event: `btw:changed {chatId, entry}`, broadcast to every tab on each change (coalesced while streaming). Whether to send the whole entry or text deltas is the builder's call. Answers are short, so the whole entry is fine to start with.

### Limits

- At most 3 unfinished side questions per chat. A 4th is refused: "3 side questions are already running in this chat".
- A side run that has not ended after 3 minutes is stopped and marked `error` ("Took too long").

### Composer and UI

- **Routing.** The composer sends a text starting with `/btw ` (picked from the menu or typed) through `btw:ask`, never `chats:send`, so it shows no pending bubble and `TaskQueue` never sees it. The pure part (is this a `/btw`, the question, the `@member`) goes in `frontend/src/state/` next to `commandInput.ts`, so it is unit-tested. After the ask is accepted, the composer clears its text. Staged attachments and a quote stay for the next normal send. An empty `/btw` sends nothing.
- **`/btw` is reserved.** An agent command named `btw` is shadowed in the menu. Zumi Bot is told not to make one.
- **Chip in the chat:** `btw · <question, cut with an ellipsis>`, a spinner while `picking`/`running`, a warning mark on `error`. Click → the panel opens scrolled to that entry.
- **Panel** (`SidePanel.tsx` or similar, beside `FilesPanel.tsx`): header "Side questions · N", entries oldest first. An entry shows "Picking who answers…" while picking, the streaming answer while running, and the error text with **Ask again** on an error. Each entry has Copy, Stop while running, and Show in chat (scrolls to the chip). It opens by itself in the tab that asked, and other tabs just update. It shares the side slot with the Files panel: opening one closes the other. A `btw N` chip beside the Files chip opens it, shown when N > 0.
- Answers use the same Markdown renderer as agent messages (math; Mermaid only once done, as for a streaming reply).

### Everything else it touches

- **Usage.** A side run's `result` becomes an exact cost record for the chat and the answering agent. Its `sessionId` must be the side run's own id from its `init`, never `S`: estimates treat a record's window as covering that session's logged messages, so `S` would hide part of the main run's cost. With no session file, the side run has nothing to estimate, so it is counted exactly once. No user-message record is written, because it is not a message to the agent.
- **Context meter.** A side run never updates `ChatMeta.context` or `GroupInfo.context`.
- **Busy count.** Unfinished side runs count in the control socket's `busy()`, so `deploy` and the desktop wait or refuse as they do for replies, and so does `sync`.
- **Shutdown and restart.** Side runs are stopped at shutdown. At start, an entry still `picking` or `running` becomes `error` ("Interrupted by a restart"), and the user can press Ask again.
- **Chat deleted.** Its side runs are stopped, and the btw file goes wherever the chat's other files go.
- **Fork** (`fork.ts`). Copies the finished entries whose `after` is among the copied items (or null) into the new chat's file. Running ones are not copied.
- **Agent rename.** `agent` in btw files is renamed with the stored chats (`agents:save` / `agentsSync.ts`). A deleted agent's entries are kept as they are.
- **Sync** (`sync.mjs`). `chats/<id>.btw.json` is joined by entry id. For the same id, a finished state beats an unfinished one, then the later `endedAt` wins. A copy chat gets the entries anchored in its items. `CLAUDE.md`'s sync paragraph and the Data list name the new file.
- **Unread, notifications, presence.** Untouched. A side answer sets no `replyAt` and sends no push.
- **Edit, Resend, Compact while a side run is going.** The side run carries on from the point it forked at. Only its chip may move to the panel (see Data).

### Probe first

The plan's first task is a probe against the real CLI (2.1.317 today). It settles what the design cannot know from the help text:

1. `--resume S --resume-session-at AT --fork-session --no-session-persistence` works on a session another process is still appending to, writes no file, and reports an `init` id other than `S`.
2. An entry the stream has just reported is already readable on disk when the side run starts. If not, the side run takes the clean entry before the newest one.
3. The guard (see *Tool lockout*) refuses every tool, built-in and MCP, with the user's own allow rules in place and in both of ZumiBot's permission modes.
4. A side run on a long session reads from the cache: its first request's `cache_read_input_tokens` covers nearly all of the forked context, and its `cache_creation_input_tokens` stays small. If the guard or anything else breaks the match, find out what and fix it before building on it.

What the probe proves becomes a check in `npm run e2e` (real `claude`), because those flags can change in any Claude Code update.

### Probe results

Run on 2026-11-03 against Claude Code **2.1.317** (Haiku), with `node zumi-bot-server/e2e/btwProbe.mjs`: `btw probe: all 4 checks passed (Claude Code 2.1.317)`. The user's own `~/.claude/settings.json` was in play, and both runs had `--allowedTools "Bash(sleep:*)" mcp__probe__touch_marker` and `--permission-prompt-tool stdio`.

1. **Fork holds.** The side run started while the main run was still sleeping and reported its own `init` id. No `.jsonl` appeared in the project's session folder, the main run still ended with `DONE`, and its session file never held the side prompt.
2. **The just-streamed entry is on disk.** The side run started the moment the 2nd `tool_result` line arrived, cut at that entry, and resumed with no "No message found". No fallback to the entry before it is needed.
3. **No tool runs.** In `--permission-mode auto` and `manual`, every call was refused by the guard: `ToolSearch`, `mcp__probe__touch_marker` and `Bash` (`sleep 1`, allowed by the rule, and `echo hacked > hacked.txt`). Each `tool_result` was an error reading `PreToolUse:<tool> hook error: [...]: No tools in a side answer`. No `can_use_tool` request came, so no card would show, and neither `marker.txt` nor `hacked.txt` was written. The guard also blocks `ToolSearch`, so a side run cannot even load a deferred MCP tool's schema.
4. **The cache is reused.** The guard and `--no-session-persistence` leave the request start unchanged, so the side run's first request matches the main run's start and reads it from the cache. The probe asserts at least 80% read and fewer cache-write tokens than max(5000, 10% of the input) in both modes. In auto mode it read 54,711 tokens (98.8%) and wrote 647. In manual mode it read 55,004 (99.4%) and wrote 353.

**The guard that held** is the exit-code `PreToolUse` hook, passed as the `--settings` value (Task 5's `SIDE_GUARD_SETTINGS`, verbatim):

```
{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"echo 'No tools in a side answer' >&2; exit 2"}]}]}}
```

### Tests

- Unit (pure): the clean-point tracker, the btw store (atomic save, recover), the room fallback order and moderator output parsing, the composer's `/btw` parsing, chip placement (`after` visible or not), the sync join of btw files.
- `npm run e2e:btw`, fake claude only (no quota): `fake-memory-claude.mjs` learns `--no-session-persistence` and the `--settings` hook guard (a scripted tool call must come back denied), and records what a run was given. Checks: a `/btw` during a scripted long run answers while the run goes on; the main run's stdin and session never hold the question; reload and a second browser context show the chip and the answer; Stop and Ask again; a room picks a member; `/btw @member` skips the moderator; a restart mid-answer leaves an `error` entry.

## Left to the builder

- Exact file and component names, push granularity, the side note's wording, how chips sit inside an agent's group of messages, the panel's look within the app's existing styles.
- Whether `btw:changed` sends the whole entry or deltas.
- The exact refusal mechanism, as the probe shows, within *Tool lockout*.

## Calls I made (check these)

1. A side run writes no session file at all (`--no-session-persistence`), on top of `--fork-session`.
2. The fork cuts at the latest *clean* entry, so a pending tool call (including a long subagent) is not part of what the answer sees.
3. A chat with no session to fork gets a seeded side run from the visible items instead of an error.
4. Side questions live in their own `chats/<id>.btw.json`, not as chat items.
5. A chip whose spot was edited away disappears from the chat but stays in the panel.
6. Limits: 3 unfinished per chat, 3 minutes per answer.
7. Ask again reruns in place (same entry and chip) with a fresh fork point. There is no delete.
8. In rooms, the moderator's fallback is: the one member running now, else the last speaker, else the first member.
9. Side runs count as busy for deploy, desktop and sync.
10. The Side questions panel and the Files panel share one side slot, and a `btw N` chip beside Files opens it.
11. `/btw` is text only. Attachments and quotes stay in the composer.
12. The side note goes in the user message, not the system prompt.
13. The tool guard is a deny-everything `PreToolUse` hook, with ZumiBot denying `can_use_tool` as a second line.
14. In a room, the answering member also gets the room messages it has not been fed yet, as its next turn would.
