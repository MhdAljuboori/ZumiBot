# `/btw` Side Questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/btw <question>` in a chat gets an answer from the chat's agent at once, forked from the run as it stands, while the main run carries on untouched. The answer is kept in a Side questions panel, with a chip in the chat.

**Architecture:** A side answer is its own `claude` process. It is resumed from the agent's live session with `--resume-session-at <clean entry> --fork-session --no-session-persistence`, and spawned with exactly the main run's other args, so it reuses the prompt cache. A deny-everything `PreToolUse` hook passed with `--settings` blocks every tool. Side questions live in `chats/<id>.btw.json`, never in chat items. A new `SideQuestions` service owns them. It takes the live point from `ChatService`, room context from `GroupService`, and a member pick from a small Haiku call. New `btw:*` RPCs and a `btw:changed` broadcast feed a side panel and chips in the UI.

**Tech Stack:** TypeScript, Node ≥ 22, React 19, vitest, playwright-core e2e with the fake claude.

**Spec:** `docs/superpowers/specs/2026-11-03-btw-side-questions-design.md`. Read it first: the plan argues from it.

## Global Constraints

- Never commit. The user's global rule overrides the skill's commit steps: every task ends with a check, not a commit. The user commits.
- Never add `--dangerously-skip-permissions` or `bypassPermissions`. Never retry a failed side run as a plain `--resume` (it would write into the main session).
- A side run's args equal the main run's `buildArgs(...)` for that agent and chat, except the session part and `--no-session-persistence` and the guard. Nothing else may differ (cache).
- Limits: at most 3 unfinished side questions per chat (`SIDE_MAX_OPEN = 3`), and 3 minutes per answer (`SIDE_TIMEOUT_MS = 180_000`).
- Copy, verbatim:
  - Limit refusal: `3 side questions are already running in this chat`
  - Timeout error: `Took too long`
  - Restart error: `Interrupted by a restart`
  - Guard reason: `No tools in a side answer`
  - Menu description: `Ask on the side; the run keeps going`
  - Panel header: `Side questions · N`
  - Picking state: `Picking who answers…`
- The agent never reads a side question: none of it goes into chat items, seeds, the moderator's thread, forks' items or `readAs`.
- Side answers set no `replyAt`, send no notification, and never touch `ChatMeta.context` / `GroupInfo.context`.
- A side run's cost record carries the side run's own `init` session id, never the main session id.
- Comments are short and say why. Dependencies stay pinned, and no new dependency is needed.

## Review Focus

1. **A `/btw` asked at the very start of a run, before any clean entry.** Expect an answer from the point the turn started from (the previous end), not an error and not a fork of a half-written turn. Test in Task 4 (`liveSidePoint` before the first clean entry) and Task 8.
2. **A `/btw` while the agent's newest entry is a pending tool call (a long Bash or subagent).** Expect the fork at the clean entry before that call, and the answer still comes. Test in Task 4 (`CleanPoint`).
3. **The user deletes the chat, or the server restarts, while a side answer streams.** Expect no file resurrected after delete, and after a restart an `error` entry with `Interrupted by a restart` plus Ask again. Test in Task 3 (save after remove) and Task 8 (lazy recovery).
4. **The agent is renamed while its side answer streams.** Expect the entry to end under the new name, with no write that puts back the old one. Test in Task 8 (`renameAgent` during a run).
5. **A `/btw` typed into a chat whose agent has its own `btw` command, or `/btw` with no question.** Expect the built-in to win, and nothing sent for an empty question. Test in Task 11 (`btwOf`).

---

### Task 1: Probe the real CLI

Settles what the spec cannot know from `claude --help`. It costs a little quota (Haiku). **Stop and report to the user if check 3 or 4 fails and no refusal keeps the request start unchanged.** Do not fall back to removing tools without the user's word (spec, *Tool lockout*).

**Files:**
- Create: `zumi-bot-server/e2e/btwProbe.mjs` (exports `probeSideRun({ bin, log }) : Promise<void>`, throws on a failed check; runs itself when called directly)
- Create: `zumi-bot-server/e2e/fixtures/probe-mcp.mjs` (a tiny stdio MCP server with one tool, `touch_marker`, that writes `marker.txt` in its cwd)
- Modify: `docs/superpowers/specs/2026-11-03-btw-side-questions-design.md` (add a short *Probe results* section: CLI version, what held, the guard used)

**Interfaces:**
- Produces: `SIDE_GUARD_SETTINGS` value proven here, used by Task 5. Expected:
  `{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"echo 'No tools in a side answer' >&2; exit 2"}]}]}}`

- [ ] **Step 1: Write the probe.** In a temp dir with `HOME` left as is (the user's real allow rules must be in play), start a main run in the background: `claude -p --model haiku --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode auto --allowedTools "Bash(sleep:*)" mcp__probe__touch_marker --mcp-config <probe-mcp json>`, with a prompt that asks for `sleep 2` with Bash four times, one call per message, then `DONE`. Read its stream and track `entry` uuids and open tool calls the way Task 4's `CleanPoint` will. After the second `tool_result`, start the side run with the same args, plus `--resume <S> --resume-session-at <clean> --fork-session --no-session-persistence --settings <guard>`. Its prompt asks it to call `touch_marker`, run `echo hacked > hacked.txt` with Bash, and then say how many sleeps have run.
- [ ] **Step 2: Check, and throw with a clear message on each failure:**
  1. The side `init` session id ≠ `S`. No new `.jsonl` appears in the project's folder under `~/.claude/projects/` during the side run. The main run still ends with `DONE`, and its session file holds no line with the side prompt.
  2. The side run did not fail with "No message found" (the clean entry was on disk).
  3. `marker.txt` and `hacked.txt` do not exist, though Bash is allowed by `--allowedTools` and by auto mode. Every tool result in the side stream is an error.
  4. The side run's first `assistant` message's `usage.cache_read_input_tokens` ≥ 80% of `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`.
- [ ] **Step 3: Run it.**
  Run: `node zumi-bot-server/e2e/btwProbe.mjs`
  Expected: `btw probe: all 4 checks passed (Claude Code <version>)`.
- [ ] **Step 4: Record the results** in the spec's new *Probe results* section: version, each check, and the exact guard string. If the guard string differs from the one above, Task 5 uses the recorded one.

---

### Task 2: Shared types, constants and `/btw` parsing

**Files:**
- Create: `zumi-bot-server/shared/src/btw.ts`
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.btw`)
- Test: `zumi-bot-server/shared/tests/btw.test.ts`

**Interfaces:**
- Produces (in `@zumibot/shared/btw`):
  ```ts
  export type SideState = 'picking' | 'running' | 'done' | 'error' | 'stopped'
  export interface SideQuestion {
    id: string; question: string; agent: string | null; mention?: true
    askedAt: number; after: string | null; state: SideState
    answer: string; error?: string; endedAt?: number
  }
  export const BTW_NAME = 'btw'
  export const SIDE_MAX_OPEN = 3
  export const SIDE_TIMEOUT_MS = 180_000
  export const SIDE_LIMIT_TEXT = '3 side questions are already running in this chat'
  export const SIDE_TIMEOUT_TEXT = 'Took too long'
  export const SIDE_RESTART_TEXT = 'Interrupted by a restart'
  export const BTW_DESCRIPTION = 'Ask on the side; the run keeps going'
  export const isOpen = (q: SideQuestion): boolean  // picking or running
  /** What follows `/btw `: an optional leading `@member`, then the question (trimmed). Empty question → null. */
  export function sideParts(rest: string): { question: string; mention: string | null } | null
  /** `/btw [@member] question` at index 0 of the untrimmed text, else null: `sideParts` of what follows `/btw`. */
  export function btwOf(text: string): { question: string; mention: string | null } | null
  ```
- Produces (in `ZumiBotApi`):
  ```ts
  btw: {
    ask(chatId: string, question: string, id: string): Promise<SideQuestion>
    list(chatId: string): Promise<SideQuestion[]>
    stop(chatId: string, id: string): Promise<void>
    again(chatId: string, id: string): Promise<SideQuestion>
    onChanged(cb: (p: { chatId: string; entry: SideQuestion }) => void): () => void
  }
  ```

- [ ] **Step 1: Write the failing tests** in `shared/tests/btw.test.ts`:
  - `btwOf('/btw how many left?')` → `{ question: 'how many left?', mention: null }`
  - `btwOf('/btw @coder-agent how far?')` → `{ question: 'how far?', mention: 'coder-agent' }`
  - `btwOf('/btw')`, `btwOf('/btw   ')`, `btwOf('/btw @x')` → `null`
  - `btwOf(' /btw x')`, `btwOf('/btwx y')`, `btwOf('hi /btw x')` → `null`
  - `btwOf('/btw line one\nline two')` → question `'line one\nline two'`
  - `sideParts('@a  x ')` → `{ question: 'x', mention: 'a' }`. `sideParts('x')` → `{ question: 'x', mention: null }`. `sideParts('  ')` → `null`.
  - `isOpen` is true only for `picking` and `running`.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/shared/tests/btw.test.ts` → module not found.
- [ ] **Step 3: Implement `shared/src/btw.ts`** and add `btw` to `ZumiBotApi`. The mention handle uses the same characters `leadingCommand`'s name allows plus `_`. Look at how `shared/src/mentions.ts` reads a handle and reuse that pattern.
- [ ] **Step 4: Run, expect PASS.** Same command. Then `npm run typecheck`. Expected: errors only where `ZumiBotApi` now lacks `btw` (`frontend/src/net/api.ts`). Task 9 fixes those. Note them and move on.

---

### Task 3: Store side questions next to the chat

**Files:**
- Modify: `zumi-bot-server/backend/src/core/store/chatStore.ts`
- Test: `zumi-bot-server/backend/tests/core/chatStore.test.ts`

**Interfaces:**
- Produces on `ChatStore`:
  ```ts
  loadSide(id: string): Promise<SideQuestion[]>          // [] when no file; a corrupt file is renamed .bak-<now>, like versions
  saveSide(id: string, list: SideQuestion[]): Promise<void> // empty list removes the file; no write once the chat is removed
  ```
  The file is `chats/<id>.btw.json`, holding `{ "v": 1, "items": SideQuestion[] }`, written with `writeFileAtomic` through the store's `run` queue. `remove(id)` also deletes it. `renameAgent(old, new)` also rewrites `agent` in every btw file whose entries name `old`.

- [ ] **Step 1: Write failing tests:**
  - `saveSide then loadSide round-trips` (two entries, same order).
  - `loadSide of a chat with no file is []`.
  - `saveSide after remove does not recreate the file` (Review Focus 3): `remove(id)`, then `saveSide(id, [q])`, then `existsSync(chats/<id>.btw.json)` is false.
  - `remove deletes the btw file`.
  - `renameAgent rewrites agent in btw files`: an entry with `agent: 'old'` → `'new'`, and others unchanged.
  - `a corrupt btw file is set aside`: write `{`, then `loadSide` → `[]`, and a `.bak-` file exists.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/chatStore.test.ts`
- [ ] **Step 3: Implement** using `sidePath(id)` next to `versionsPath(id)` (same `ID_RE` check) and the same patterns as `loadVersionsRaw` / `saveVersionsRaw`.
- [ ] **Step 4: Run, expect PASS.**

---

### Task 4: Clean fork point and spawn capture in `ChatService`

**Files:**
- Create: `zumi-bot-server/backend/src/core/btw/cleanPoint.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`
- Test: `zumi-bot-server/backend/tests/core/cleanPoint.test.ts`, `zumi-bot-server/backend/tests/core/chatService.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // cleanPoint.ts: pure. Fed the turn's events in order; a clean entry has no tool call of the turn left open after it.
  export class CleanPoint {
    entry(uuid: string): void
    toolUse(id: string): void
    toolResult(id: string): void
    get(): string | null
  }
  ```
  Rule: on `entry`, if nothing is open and there was a previous entry, that previous entry becomes clean; then the new one is the tip. `get()` returns the tip when nothing is open, else the last clean. (A line's `entry` event comes before its content events, so "clean" is judged after a line's tool events.)
- Produces on `ChatService`:
  ```ts
  /** What a side run of `agent` in `chatId` copies from the agent's own runs. null: no spawn of it since start. */
  sideBase(chatId: string, agent: string): SideBase | null
  export interface SideBase {
    bin: string; cwd: string
    args: { agentName: string; permissionMode: PermissionMode; disallowedTools: string[]; extraArgs: string[]; appendSystemPrompt: string }
    browser: boolean           // the run had a browser turn: the side run makes its own the same way
    live: { session: string; at: string } | null  // a running turn's clean point; null when idle or none yet
    start: { session: string; at: string } | null // where the running (or last) turn started from: its resumeAt, else the last `end` of that session in its items
  }
  /** Same browser turn a spawn would make (the `--no-chrome` one when the agent has no profile); null without browserTurns.
   *  Its handoff callback does nothing: the guard refuses every browser tool, and a side run never adds a card. */
  sideBrowser(chatId: string, agent: string): Promise<BrowserTurn | null>
  ```
  `args.extraArgs` and `args.appendSystemPrompt` exclude the browser parts. The side run adds back its own browser turn's `args` and `prompt` in the same order as `attempt()` does (`[system, browser.prompt].filter(Boolean).join('\n\n')`).
- Implementation note: inside `attempt()`, right before `this.d.run(...)`, record `{ bin, cwd, args: buildArgs input minus the session and browser parts, browser: !!browser }` in a map keyed `${chatId}\n${agent}`. It is kept after the turn ends (memory only). Keep a `CleanPoint` per attempt, fed from `onEvent` (`entry`, `toolUse`, `toolResult`), and `live = { session: attemptSession, at: clean.get() }` while the turn runs and both are known. Clear `live` in the turn's `finally`. Compute `start` once at turn start: `spec.resumeAt` with `spec.sessionId`, else the last item in `ref.get()` with `end.session === spec.sessionId` (and `end.agent === author` in rooms), else null. `renameAgent` moves map keys too.

- [ ] **Step 1: Write `cleanPoint.test.ts`:**
  - `text-only entries are each clean`: `entry(a)`, `entry(b)` → `get() === 'b'`.
  - `an entry with an open tool call is not clean` (Review Focus 2): `entry(a)`, `entry(b)`, `toolUse(t1)` → `get() === 'a'`. Then `entry(c)`, `toolResult(t1)` → `get() === 'c'`.
  - `parallel calls stay open until all results`: `entry(a)`, `toolUse(t1)`, `entry(b)`, `toolUse(t2)`, `entry(c)`, `toolResult(t1)` → `get()` is the last entry before `a` was opened (null here). Then `entry(d)`, `toolResult(t2)` → `'d'`.
  - `nothing yet` → `get() === null`.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/cleanPoint.test.ts`
- [ ] **Step 3: Implement `CleanPoint`.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Write ChatService tests** with the existing fake `run` in `chatService.test.ts`:
  - `sideBase is null before any turn`.
  - `sideBase mirrors the spawn args`: after a turn spawned with house style on, `args.appendSystemPrompt` contains `HOUSE_STYLE`, and `args.disallowedTools` / `extraArgs` / `agentName` / `permissionMode` equal what `buildArgs` got (read them back from the fake run's `args`).
  - `live point follows clean entries while running`: the fake emits `init(S)`, assistant entry `e1` (text), entry `e2` with a `tool_use` and no result yet. `sideBase(...).live` is `{ session: S, at: 'e1' }`. After the result line (entry `e3`) it is `'e3'`. After the turn ends, `live` is null.
  - `start is the previous end before the first clean entry` (Review Focus 1): a chat whose items end with an item stamped `end: {session: S0, at: x}`, and a new turn resuming `S0` that has emitted only `init`. `live` is null and `start` is `{ session: S0, at: 'x' }`.
- [ ] **Step 6: Run, expect FAIL, implement, run, expect PASS.** `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts`

---

### Task 5: Run one side answer

**Files:**
- Create: `zumi-bot-server/backend/src/core/btw/sideRun.ts`
- Test: `zumi-bot-server/backend/tests/core/sideRun.test.ts`

**Interfaces:**
- Consumes: `SideBase` (Task 4), `buildArgs` / `RunOptions` / `RunHandle` (`claudeRunner.ts`), `denyResponse` (`controlProtocol.ts`), `FORK_IGNORED` (`chatService.ts`), the guard from Task 1.
- Produces:
  ```ts
  export const SIDE_GUARD_SETTINGS: string // Task 1's proven JSON
  export interface SideRunOptions {
    base: SideBase
    point: { session: string; at: string } | null // null: no resume (seeded message)
    message: string                                // stdin text (Task 6 builds it)
    browser: BrowserTurn | null
    run(o: RunOptions): RunHandle
    onText(answer: string): void                   // the whole answer so far, on each delta and each complete message
    onCost(e: { sessionId: string | null; window: [number, number]; cost: RunCost; id: string | null }): void
    now(): number
    timeoutMs?: number                             // default SIDE_TIMEOUT_MS
  }
  export interface SideRunEnd { ok: boolean; stopped: boolean; error: string | null; answer: string }
  export function sideArgs(base: SideBase, point: SideRunOptions['point'], browser: BrowserTurn | null): string[]
  export function startSideRun(o: SideRunOptions): { stop(): void; done: Promise<SideRunEnd> }
  ```
- `sideArgs` = `buildArgs({ ...base.args, resumeSessionId: point?.session ?? null, resumeAt: point?.at, extraArgs: [...base.args.extraArgs, ...(browser?.args ?? []), '--no-session-persistence', '--settings', SIDE_GUARD_SETTINGS], appendSystemPrompt: [base.args.appendSystemPrompt, browser?.prompt].filter(Boolean).join('\n\n') })`. With `point` null there is no `--resume` at all.
- Behaviour: an `init` whose session equals `point.session` → stop, error `FORK_IGNORED(version)`. Every `permissionRequest` → `handle.send(denyResponse(id, 'No tools in a side answer'))`, and nothing else. The answer is the concatenation of complete `assistantText`s (joined with a blank line), with in-progress `textDelta`s appended until their message completes. `result` with `cost` → `onCost` with the `init` session id. Timeout → stop, error `SIDE_TIMEOUT_TEXT`. Exit without result → error = stderr trimmed, else `Claude exited with code N`. A `limited` event's text is the error as `chatService` words it (reuse its message builder if one exists, else stderr).

- [ ] **Step 1: Write failing tests** (fake `run` capturing `args` and stdin, emitting scripted `RunEvent`s):
  - `sideArgs keeps the main args and only swaps the session`: for a base with every field set, the result equals `buildArgs(main)` with `--resume S --resume-session-at A --fork-session` in the session slot and `--no-session-persistence --settings <guard>` placed before `--disallowedTools`. Assert `--disallowedTools` is still last.
  - `sideArgs with no point has no --resume`.
  - `denies every permission request`: one `permissionRequest` → the handle got exactly one `denyResponse(req, 'No tools in a side answer')`.
  - `fork ignored stops with FORK_IGNORED`.
  - `streams the answer`: deltas `"17 "`, `"done"` → `onText('17 ')`, `onText('17 done')`. Then `assistantText('17 done')` → end `answer === '17 done'`.
  - `cost uses the side session`: `init(F)` then `result` with cost → `onCost.sessionId === 'F'`.
  - `times out`: with fake timers and `timeoutMs: 1000`, a run that never ends → `{ ok: false, error: 'Took too long' }` and `stop()` was called on the handle.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/sideRun.test.ts`
- [ ] **Step 3: Implement `sideRun.ts`.**
- [ ] **Step 4: Run, expect PASS.**

---

### Task 6: Side message, room thread, and the member picker

**Files:**
- Create: `zumi-bot-server/backend/src/core/btw/sidePrompt.ts`
- Create: `zumi-bot-server/backend/src/core/btw/sidePicker.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/moderator.ts` (extract the spawn into `runJsonCall`; `runModerator` keeps its signature and behaviour)
- Modify: `zumi-bot-server/backend/src/core/chat/groupPrompts.ts` (export `threadLines(entries)` used by `buildTurnMessage`)
- Test: `zumi-bot-server/backend/tests/core/sidePrompt.test.ts`, `zumi-bot-server/backend/tests/core/sidePicker.test.ts`, `zumi-bot-server/backend/tests/core/moderator.test.ts` (unchanged tests must still pass)

**Interfaces:**
- Produces:
  ```ts
  // sidePrompt.ts
  export const SIDE_NOTE: string // the spec's side note, verbatim
  /** stdin for a side run: [room thread lines], the note, then <btw>question</btw>. */
  export function sideMessage(question: string, thread: ThreadEntry[] | null): string
  /** A seeded side run (no session to fork): the visible items as earlier conversation, then the side message. */
  export function seededSideMessage(items: ChatItem[], question: string): string // buildSeedPrompt(items, sideMessage(question, null))
  /** Room entries a member has not been fed: after `afterId`, other members' live items included. */
  export function unseenEntries(items: readonly ChatItem[], afterId: string | null, me: string): ThreadEntry[]

  // moderator.ts
  export function runJsonCall<T>(o: { bin: string; cwd: string; env?: NodeJS.ProcessEnv; args: string[]; stdin: string; signal: AbortSignal; timeoutMs?: number; parse(stdout: string): T | null; onCost?(cost: RunCost, id: string | null): void }): Promise<T | null>

  // sidePicker.ts
  export interface PickInput { members: MemberInfo[]; messages: ThreadEntry[]; working: string[]; question: string }
  export function pickArgs(): string[]   // like moderatorArgs(): haiku, no tools, no settings, no MCP, no persistence, json schema {member: string}
  export function pickPrompt(i: PickInput): string
  export function parsePick(stdout: string, members: readonly string[]): string | null
  /** When the pick fails: the one member working now, else the last member who spoke in `messages`, else members[0]. */
  export function fallbackPick(i: PickInput): string
  ```
- `unseenEntries` = `threadEntries(items.map(dropTurnUnlessMine), afterId, me)`, where `dropTurnUnlessMine` removes `turn` from items whose `agent !== me`.

- [ ] **Step 1: Write failing tests:**
  - `sideMessage without a thread ends with <btw>q</btw> and holds SIDE_NOTE`.
  - `sideMessage with a thread starts with the thread lines` (same format as `buildTurnMessage`'s lines, with no reason lines).
  - `unseenEntries includes another member's live text but not my own`: items = user msg, `a` assistant with `turn: 't1'` (live), `me` assistant with `turn: 't2'` → entries: the user message and `a`'s text.
  - `unseenEntries starts after afterId`.
  - `parsePick accepts a member and rejects others`: `'{"member":"a"}'` → `'a'`; `'{"member":"zz"}'` → null; garbage → null.
  - `fallbackPick` order: working `['b']` → `'b'`. Working `['a','b']`, last speaker `c` → `'c'`. Nothing → `members[0].name`.
  - Existing `moderator.test.ts` passes unchanged.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/sidePrompt.test.ts zumi-bot-server/backend/tests/core/sidePicker.test.ts`
- [ ] **Step 3: Implement.** `pickPrompt` lists members like `moderatorPrompt` does (`- @name (Display): description`), the last `MODERATOR_MESSAGES` messages cut to `MODERATOR_MESSAGE_CHARS`, `Working now: …`, then the question. The system prompt is one paragraph: pick the single member best placed to answer this side question about the group's work, preferring the member doing the work it asks about.
- [ ] **Step 4: Run, expect PASS**, including `moderator.test.ts` and `groupPrompts.test.ts`.

---

### Task 7: Room view for side questions in `GroupService`

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/groupService.ts`
- Test: `zumi-bot-server/backend/tests/core/groupService.test.ts`

**Interfaces:**
- Consumes: `unseenEntries`, `PickInput` (Task 6).
- Produces on `GroupService`:
  ```ts
  /** What a side run of `member` reads: room entries it was not fed (after its running turn's start, else its `seen`). */
  sideThread(chatId: string, member: string): Promise<ThreadEntry[]>
  /** The moderator-style input for picking who answers. */
  pickInput(chatId: string, question: string): Promise<PickInput>
  ```
  Record the running turn's `startId` (already computed in the member turn) on its `Work`, so `sideThread` can read it while the member works. `pickInput.working` = `[...room.working.keys()]` (empty when the room is idle). `messages` = `unseenEntries(items, null, '')`. Members come from `memberInfo(available, agents)`.

- [ ] **Step 1: Write failing tests:**
  - `sideThread of an idle member starts after its seen item`.
  - `sideThread of a working member starts after its turn's start and includes another member's live text`.
  - `pickInput lists working members`.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/groupService.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**

---

### Task 8: The `SideQuestions` service

**Files:**
- Create: `zumi-bot-server/backend/src/core/btw/sideQuestions.ts`
- Test: `zumi-bot-server/backend/tests/core/sideQuestions.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 7.
- Produces:
  ```ts
  export interface SideQuestionsDeps {
    store: Pick<ChatStore, 'get' | 'loadItems' | 'loadSide' | 'saveSide'>
    chats: Pick<ChatService, 'sideBase' | 'sideBrowser'>
    groups: Pick<GroupService, 'sideThread' | 'pickInput'>
    pick(input: PickInput, cwd: string, signal: AbortSignal, chatId: string): Promise<string | null> // null → fallbackPick
    baseFor(chatId: string, agent: string): Promise<SideBase | null> // a fresh base when chats.sideBase is null (Step 3)
    run(o: RunOptions): RunHandle
    broadcast(chatId: string, entry: SideQuestion): void
    recordCost(e: RunCostEvent): void
    now(): number
  }
  export class SideQuestions {
    ask(chatId: string, question: string, id: string): Promise<SideQuestion>   // the raw text after `/btw `, read with sideParts
    list(chatId: string): Promise<SideQuestion[]>                            // lazy recovery here
    stop(chatId: string, id: string): void
    again(chatId: string, id: string): Promise<SideQuestion>
    stopChat(chatId: string): void
    stopAll(): Promise<void>
    runningCount(): number
    renameAgent(from: string, to: string): void
  }
  ```
- Rules (each is a test):
  - `ask` refuses an empty question, refuses `@x` not in the room (`<Display> is not in this chat`, like `CommandResolver`), and refuses a 4th open entry with `SIDE_LIMIT_TEXT`. It stores the entry before starting the run, with `after` = the last stored item id (or null) and `askedAt = now()`. Single chat: `agent` = the chat's agent and state `running`. Room with a mention: that member, `mention: true`, `running`. Room without one: `agent: null`, state `picking`, then the pick (deps.pick, else `fallbackPick`), then `running`.
  - Point: `base.live` if set, else `base.start`, else (idle) the point from the items: `startBefore(items, items.length)` for a single chat, `memberStartsBefore(items, items.length, [m])[m]` for a member, using `{session, at}` only when `next` is `{at}`. No point → seeded: `point: null` and `message = seededSideMessage(items, …)`. In rooms the message carries `sideThread(chatId, m)`.
  - When `base.browser` is true, the side run gets its own browser turn from `chats.sideBrowser(chatId, agent)`, so the browser tools are defined as in the main run. The turn is disposed when the side run ends, however it ends.
  - Saves and broadcasts are coalesced while streaming (at most one save in flight; the latest entry wins), and always flushed at the end.
  - The entry ends `done` with `endedAt`, or `error` with the run's error, or `stopped` (by `stop`, `stopChat` or `stopAll`) keeping the partial answer.
  - `again` only on `error`/`stopped`: resets `answer`, `error` and `endedAt`, keeps `id`, `after` and `askedAt`, and runs with a fresh point.
  - `list` turns any `picking`/`running` entry with no run in this process into `error: SIDE_RESTART_TEXT` and saves that once (Review Focus 3).
  - `renameAgent` during a run changes the in-memory entry's `agent`, so the next save writes the new name (Review Focus 4).
  - `recordCost` gets `{ id, chatId, agent, sessionId: <side init id>, window, cost }`.
- `baseFor` (wired in Task 9) builds what a turn of that agent would spawn now, with no side effects: `bin` from `locate()`, `cwd` the chat's, `permissionMode`, `disallowedToolsFor(agent)` (plus the room's `Agent(<other>)` rules for a member, as `groupService` adds them), `extraArgs: addDirArgs(items, dirOf(chatId))`, `appendSystemPrompt` = `[briefing (rooms), HOUSE_STYLE when on, memory note]`, and `browser: true` whenever the server has browser turns (every spawn makes one). The memory note comes from a new side-effect-free `memoryNote(agent)` built like `memory.begin` in `app.ts`, without `repairIndex` and without `memoryTurns.started`. A cache miss right after a restart is accepted.

- [ ] **Step 1: Write failing tests** for every rule above, with fake deps (a fake `run` that streams a scripted answer, an in-memory store). Name them after the rule, e.g. `refuses a fourth open side question`, `forks at the live clean point`, `falls back to the turn's start point`, `seeds when there is no session`, `room picks with the moderator then runs`, `room pick failure uses fallbackPick`, `mention skips the picker`, `stop keeps the partial answer`, `again reruns in place`, `list marks orphaned runs as interrupted`, `rename during a run writes the new name`, `cost record carries the side session`.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/sideQuestions.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**

---

### Task 9: Wire it into the server and the client API

**Files:**
- Modify: `zumi-bot-server/backend/src/app.ts` (build `SideQuestions`; `memoryNote`; `baseFor`; busy count; shutdown)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (`btw:ask`, `btw:list`, `btw:stop`, `btw:again`; `chats:remove` calls `side.stopChat(id)`; agent rename calls `side.renameAgent`)
- Modify: `zumi-bot-server/frontend/src/net/api.ts` (map `btw`)
- Modify: `zumi-bot-server/backend/src/core/agents/zumiBot.ts` (one line in its prompt: never name a command `btw`, which is a built-in)
- Test: `zumi-bot-server/backend/tests/rpc/handlers.test.ts`, `zumi-bot-server/backend/tests/app.test.ts` (busy count), `zumi-bot-server/backend/tests/core/zumiBot.test.ts` (the prompt names `btw` as reserved)

**Interfaces:**
- Event: `hub.broadcast({ event: 'btw:changed', payload: { chatId, entry } })`.
- `serveControl`'s `busy` becomes `chatService.runningCount() + side.runningCount()`.
- Shutdown stops side runs (`side.stopAll()`) next to where chat runs are stopped.
- The `pick` dep calls `runJsonCall` with `pickArgs()` / `pickPrompt` / `parsePick` and records cost with `usage.recordModerator(chatId, …)`. Jev is not used.
- Handlers check every argument (`str(...)`). `btw:ask` caps `question` at the same length `chats:send` allows for text (find the existing cap; if there is none, use `COMMAND_PROMPT_MAX`).

- [ ] **Step 1: Write failing handler tests:** `btw:ask rejects a non-string question`, `btw:ask returns the stored entry`, `chats:remove stops the chat's side runs`, `busy counts side runs`.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run --project backend -t "btw"`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** Then `npm run typecheck`. Expected: clean.

---

### Task 10: Fork and sync carry side questions

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/fork.ts` (`ForkDeps.store` gains `loadSide`/`saveSide`)
- Modify: `zumi-bot-server/deploy/sync.mjs` (export `mergeSide(local, vps)`; join `chats/<id>.btw.json` for chats on both sides; copy it for `fromVps` chats and for copy chats)
- Modify: `CLAUDE.md` (Data list and the `npm run sync` paragraph name `chats/<id>.btw.json`)
- Test: `zumi-bot-server/backend/tests/core/fork.test.ts`, `zumi-bot-server/backend/tests/sync.test.ts`

**Interfaces:**
- `mergeSide(local: SideQuestion[] | null, vps: SideQuestion[] | null): SideQuestion[]`: union by `id`. For the same id, a finished state (`done`/`error`/`stopped`) beats an open one, then the later `endedAt` wins, then local. Ordered by `askedAt`.

- [ ] **Step 1: Write failing tests:**
  - `fork copies finished side questions anchored in the copied items`: entries anchored at a copied item, at a later item, at null, and one `running` → the fork gets the first and the null one.
  - `mergeSide joins by id and prefers finished`.
  - `sync copies the btw file of a VPS-only chat and of a copy chat` (extend the existing `mergeChats` / copy tests the same way `versions.json` is covered).
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/fork.test.ts zumi-bot-server/backend/tests/sync.test.ts`
- [ ] **Step 3: Implement.** In `sync.mjs` add `btw.json` to the extension lists where `versions.json` is copied, and write `mergeSide` results for chats present on both sides.
- [ ] **Step 4: Run, expect PASS.**

---

### Task 11: Frontend pure state

**Files:**
- Create: `zumi-bot-server/frontend/src/state/sideQuestions.ts`
- Modify: `zumi-bot-server/frontend/src/state/messageGroups.ts` (`groupItems(items, sides?)` adds side rows)
- Modify: `zumi-bot-server/frontend/src/state/commandInput.ts` (built-in `/btw` option first; an agent command named `btw` is dropped)
- Test: `zumi-bot-server/frontend/tests/sideQuestions.test.ts`, `zumi-bot-server/frontend/tests/messageGroups.test.ts`, `zumi-bot-server/frontend/tests/commandInput.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // sideQuestions.ts
  export function upsertSide(list: readonly SideQuestion[], entry: SideQuestion): SideQuestion[] // by id, kept in askedAt order
  export function chipText(q: SideQuestion, max = 48): string                                    // 'btw · ' + question cut with '…'
  export function panelOrder(list: readonly SideQuestion[]): SideQuestion[]                       // oldest first
  /** What Send does with the composer text: a side question, or a normal send. */
  export function routeSend(text: string): { kind: 'btw'; question: string } | { kind: 'send' }  // question = text after '/btw ' (mention kept: the server parses it)

  // messageGroups.ts
  export type MessageRow = ... | { kind: 'side'; key: string; entry: SideQuestion }
  export function groupItems(items: readonly ChatItem[], sides?: readonly SideQuestion[], fromStart = true): MessageRow[]
  ```
  Side rows go right after the row holding their `after` item, in `askedAt` order. `after: null` rows go first, but only when `fromStart` is true (the oldest page is loaded). An agent item after a side row starts a new agent group. Entries whose `after` is not in `items` are left out of the rows (they stay in the panel).
- `commandInput.ts`: the `/` menu gets a built-in option `{ builtin: 'btw', description: BTW_DESCRIPTION }` before agents' commands when `'btw'.startsWith(query)`. Extend `CommandOption` as a union, keeping `groupOptions` working for agent options.

- [ ] **Step 1: Write failing tests:**
  - `routeSend('/btw x')` → `{ kind: 'btw', question: 'x' }`. `routeSend('/btw @a x')` → question `'@a x'`. `routeSend('/btw')` and `routeSend('/btw   ')` → `{ kind: 'btw', question: '' }`, which the composer drops without sending (Review Focus 5). `routeSend('/btwx y')` and `routeSend('hello')` → `{ kind: 'send' }`.
  - `groupItems places a side row after its anchor and splits the agent group`: items `[u1, a1, a2]` with a side after `a1` → rows `user, agent[a1], side, agent[a2]`.
  - `groupItems puts after:null first only from the start, and drops unknown anchors`.
  - `upsertSide replaces by id and keeps askedAt order`.
  - `chipText cuts long questions`.
  - `filterCommands lists /btw first and hides an agent's own btw` (Review Focus 5).
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run --project frontend -t "side|routeSend|groupItems|btw"`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**

---

### Task 12: Frontend UI

**Files:**
- Create: `zumi-bot-server/frontend/src/components/SidePanel.tsx`, `zumi-bot-server/frontend/src/components/SideChip.tsx` (the timeline chip), `zumi-bot-server/frontend/src/net/useSideQuestions.ts` (or next to `useChatFiles.ts`, wherever that hook lives)
- Modify: `App.tsx` (replace `filesOpen: boolean` with `sidePanel: 'files' | 'btw' | null`; the Esc handler and the browser-takes-the-slot rule cover both; `/btw` send path), `components/ChatView.tsx` (a `btw N` chip beside `FilesChip`, shown when N > 0; pass sides to the list), `components/MessageList.tsx` (render `side` rows with `SideChip`), `components/CommandMenu.tsx` / `Composer.tsx` (the built-in option; picking it inserts `/btw `), `styles.css`
- Test: none beyond Task 11 (there are no component tests); checked in Task 13's e2e.

**Interfaces:**
- `useSideQuestions(chatId: string | null, connected: boolean): { list: SideQuestion[]; failed: boolean; retry(): void }`. It loads with `api.btw.list` and applies `api.btw.onChanged` with `upsertSide`. It refetches on reconnect, like `useChatFiles`.
- Send: in `App.sendMessage`'s caller for the composer (ChatView's `send`), `routeSend(text)`. For `btw`: an empty question does nothing. Otherwise call `api.btw.ask(chatId, question, crypto.randomUUID())`, clear only the composer text (files and quote stay), set `sidePanel = 'btw'`, and scroll the panel to the new entry. A refusal shows as the composer's send error. No pending bubble is created.
- `SidePanel` props: `{ chat, list, agents, focusId, onClose, onShowInChat(entryId), onStop(id), onAgain(id) }`. Each entry: question in bold, who (member colour dot in rooms) and time, then `Picking who answers…` / streaming Markdown (`Markdown` component, diagrams only when done, as for a streaming reply) / error text with **Ask again**. Copy, Stop (open only), Show in chat. Header `Side questions · N`, and × closes. On a narrow screen it is the same full-screen sheet as `FilesPanel` (reuse its sheet classes).
- `SideChip`: `chipText(entry)`, a spinner while open, a warning mark on `error`. Click → `sidePanel = 'btw'` with `focusId = entry.id`.

- [ ] **Step 1: Implement the hook and the panel.** Run `npm run typecheck` → clean.
- [ ] **Step 2: Implement the chip, the rows, the composer route and the menu option.** Run `npm run typecheck` and `npm test` → all pass.
- [ ] **Step 3: Look at it.** `npm run build:server`, then start the server with the fake claude the way `e2e/harness.mjs` does (or `npm run shot`). Ask a `/btw` during a scripted run, and check the chip, the panel, Esc, the phone sheet (375 px wide) and dark mode by eye.

---

### Task 13: Fake claude, e2e, and docs

**Files:**
- Modify: `zumi-bot-server/backend/tests/fixtures/fake-memory-claude.mjs`
- Create: `zumi-bot-server/e2e/btw.e2e.mjs`
- Modify: `package.json` (`"e2e:btw": "npm run build && node zumi-bot-server/e2e/btw.e2e.mjs"`)
- Modify: `zumi-bot-server/e2e/web.e2e.mjs` (runs `probeSideRun` from Task 1, since it already drives the real `claude`)
- Modify: `CLAUDE.md` (a **`/btw` side questions** paragraph in Architecture: where it lives, the fork flags, the guard, the cache rule, the btw file; plus `e2e:btw` in Commands, "uses only the fake claude, so it costs no quota")

**Interfaces:**
- Fake memory claude learns:
  - `Work N steps`: writes entries progressively. Per step it writes an assistant entry with a `tool_use` named `Step`, saves the file, sleeps `FAKE_STEP_MS` (default 400), then writes a user entry with its `tool_result` and saves again. It streams each line as the real CLI would (`assistant` / `user` with `uuid`). It ends with `Done N steps`.
  - `<btw>…</btw>` in the prompt: answers `Steps done: K`, where K = completed `Step` results in the (cut) entries, or `Side: <question>` for other questions.
  - `--no-session-persistence`: never writes a file.
  - `--settings` holding a `PreToolUse` deny hook: a `<btw>use a tool</btw>` prompt emits a `tool_use` and then an error `tool_result` with the hook's stderr text, and writes no marker. Without the hook it writes `$HOME/tool-ran.txt` (so the e2e can tell).
  - A `--json-schema` call whose stdin contains `<pick>` answers `{"member":"<first working member named in the prompt>"}`.
- `btw.e2e.mjs` checks, each a named step:
  1. In a single chat, `Work 8 steps`. After 3 steps, `/btw how many steps done?`. The panel opens, the answer says `Steps done: 3`, and the main run then still ends with `Done 8 steps`.
  2. The main run's later stdin and session file never contain `how many steps done`.
  3. Reload: the chip is at the spot and the panel shows the answer. A second browser context sees the same.
  4. `/btw use a tool` → no `tool-ran.txt`, no approval card.
  5. Stop on a running side question keeps the partial answer, and Ask again reruns it.
  6. In a room with two members, `/btw` picks the working member, and `/btw @other x` answers as `other`.
  7. Restart the server mid-answer → the entry shows `Interrupted by a restart`.
  8. A 4th open side question is refused with the limit text (use `FAKE_STEP_MS` to keep answers slow).

- [ ] **Step 1: Extend the fake** and run the existing versions e2e to be sure nothing broke: `npm run e2e:versions` → pass.
- [ ] **Step 2: Write `btw.e2e.mjs`** on `harness.mjs`.
- [ ] **Step 3: Run it.** `npm run e2e:btw` → every step passes. Kill any Chrome the harness left behind.
- [ ] **Step 4: Add the probe to `web.e2e.mjs`** and run `npm run e2e` → pass (real `claude`, small quota).
- [ ] **Step 5: Final checks.** `npm test` → all pass. `npm run typecheck` → clean. `git status` shows only this plan's files (not committed).
