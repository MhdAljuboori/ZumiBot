# Dispatched agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A side panel view, "Dispatched agents", that lists every subagent a chat's agents dispatched and shows each one's conversation live.

**Architecture:** `streamParser` stops dropping subagent traffic and emits text, every tool, results and the CLI's `task_*` lines. A per-turn `DispatchRecorder` (inside `ChatService.agentTurn`) builds one entry per dispatch; a `DispatchService` keeps live entries in memory, saves `chats/<id>.dispatch.json` coalesced, broadcasts `dispatch:changed`, and serves `dispatch:list`/`dispatch:get`. The frontend adds `'dispatch'` to the side panel, a list → detail panel, and a Watch/View link on Agent tool rows.

**Tech Stack:** TypeScript, Node 22, React 19, vitest, playwright-core e2e with the fake claude.

**Spec:** `docs/superpowers/specs/2026-11-06-dispatched-agents-design.md`

## Global Constraints

- UI name "Dispatched agents"; menu row "Open Dispatched agents"; code name `dispatch`; file `chats/<id>.dispatch.json` `{v: 1, entries}`, written 0600.
- Caps: tool input JSON 20 000 chars; result/text 20 000 chars plus "… N more characters"; prompt/report 50 000; 1 000 steps per entry (first 50 + newest 950 + one marker step); 200 entries per chat (newest by `startedAt`).
- Browser/desktop tools: input `{}`, result "Browser command completed./failed." / "Desktop command completed./failed." (same helpers as chat items).
- Never write entries to logs, URLs, errors or any agent prompt. A dispatch failure never fails a turn; log the error code only.
- No `git commit` (user rule: commits only when asked).
- New RPCs touch `shared/src/types.ts` `ZumiBotApi`, `backend/src/rpc/handlers.ts` (args checked), `frontend/src/net/api.ts`.

## Review Focus

- Two parallel dispatches interleaving lines: each step lands in its own entry (Task 3 test `parallel dispatches keep their own steps`).
- Stop mid-dispatch: running entries become `stopped`, never stay `running` (Task 5 test `stopped turn marks running entries stopped`).
- Server restart with a stored `running` entry: shown `interrupted` (Task 4 test `running entry with no live recorder reads interrupted`).
- Edit/Resend hides a message version: its agents disappear from the list, return on switch back (Task 4 test `list hides entries whose root tool item is not visible`).
- A huge tool result (a `Read` of a big file): capped, panel stays responsive (Task 1 test `capText keeps the head and counts the rest`).

---

### Task 1: Shared types and pure helpers

**Files:**
- Create: `zumi-bot-server/shared/src/dispatch.ts`
- Test: `zumi-bot-server/shared/tests/dispatch.test.ts`

**Interfaces:**
- Produces:
  - `DispatchStatus = 'running' | 'done' | 'failed' | 'stopped' | 'interrupted'`
  - `DispatchStep`, `DispatchEntry` exactly as the spec's "Entry shape", plus step `{ kind: 'gap'; dropped: number; ts: number }` for the dropped middle.
  - `DispatchSummary = Omit<DispatchEntry, 'steps' | 'prompt' | 'report'> & { stepCount: number; openTools: string[] }` (`openTools`: ids of tool steps with `result === null`).
  - `DispatchFile = { v: 1; entries: DispatchEntry[] }`, `emptyDispatch(): DispatchFile`
  - consts `DISPATCH_TEXT_MAX = 20_000`, `DISPATCH_LONG_MAX = 50_000`, `DISPATCH_INPUT_MAX = 20_000`, `DISPATCH_STEPS_MAX = 1_000`, `DISPATCH_STEPS_HEAD = 50`, `DISPATCH_ENTRIES_MAX = 200`
  - `capText(s: string, max: number): string`
  - `capInput(input: unknown): unknown` (JSON over max → the first max chars of the JSON string)
  - `capSteps(steps: DispatchStep[]): DispatchStep[]`
  - `pruneEntries(entries: DispatchEntry[]): DispatchEntry[]` (newest 200 by `startedAt`, input order kept)
  - `summaryOf(e: DispatchEntry): DispatchSummary`
  - `DISPATCH_TOOLS = new Set(['Agent', 'Task'])`

- [ ] **Step 1: Write failing tests** — `capText keeps the head and counts the rest` (`capText('a'.repeat(25), 20)` → `'a'.repeat(20) + '… 5 more characters'`; under max returns same string); `capInput leaves small input and cuts big JSON` (result is a string of length 20 000); `capSteps keeps first 50 and newest 950 with a gap marker` (1 200 steps → length 1 001, `[50]` is `{kind:'gap', dropped: 200}`); `pruneEntries keeps newest 200 by startedAt`; `summaryOf drops steps, prompt, report and lists open tools`.
- [ ] **Step 2:** `npx vitest run --project shared shared/tests/dispatch.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement the module.
- [ ] **Step 4:** Same command → PASS.

### Task 2: Stream parser keeps subagent traffic

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/streamParser.ts` (`RunEvent`, `subagentEvents`, `system` case)
- Create: `zumi-bot-server/backend/tests/fixtures/stream/dispatch-nested.jsonl` (two parallel `Agent` calls; one subagent writes text, a failing `Bash`, dispatches a nested `Explore` agent; `task_started`/`task_progress`/`task_updated` lines; main results with `tool_use_result` totals — shape copied from `files-subagent.jsonl`)
- Test: `zumi-bot-server/backend/tests/core/streamParser.test.ts`

**Interfaces:**
- Produces new `RunEvent` kinds:
  - `{ kind: 'subText'; parent: string; text: string }`
  - `subToolUse` now for every tool name; `subToolResult` gains `detail?: unknown`
  - `{ kind: 'taskStarted'; toolUseId: string; taskId: string; description: string | null; subagentType: string | null; prompt: string | null }`
  - `{ kind: 'taskProgress'; toolUseId: string; description: string | null; tokens: number | null; toolUses: number | null; durationMs: number | null }`
  - `{ kind: 'taskUpdated'; taskId: string; status: string | null; endTime: number | null }`

- [ ] **Step 1: Write failing tests** — `emits subText for subagent text`, `emits subToolUse for Read and Bash`, `subToolResult carries detail`, `parses task_started, task_progress, task_updated`, and the existing `files-subagent.jsonl` assertions still hold (FileTracker ignores new names: run `backend/tests/core/fileChanges.test.ts` too).
- [ ] **Step 2:** `npx vitest run --project backend backend/tests/core/streamParser.test.ts` → FAIL.
- [ ] **Step 3:** Remove `SUB_TOOLS` filter; add the text and `task_*` branches (`task_*` lines have no `parent_tool_use_id`, so they go in `case 'system'`). Update the `subToolUse` comment.
- [ ] **Step 4:** Parser and fileChanges tests → PASS.

### Task 3: DispatchRecorder

**Files:**
- Create: `zumi-bot-server/backend/src/core/dispatch/dispatchRecorder.ts`
- Test: `zumi-bot-server/backend/tests/core/dispatchRecorder.test.ts`

**Interfaces:**
- Consumes: Task 1 helpers/types, Task 2 events.
- Produces:
  ```ts
  class DispatchRecorder {
    constructor(o: { turn: string; member?: string; now: () => number; onChange: () => void;
      privateTool: (name: string) => 'browser' | 'desktop' | null })
    event(e: RunEvent): void        // ignores kinds it does not use
    end(reason: 'stopped' | 'interrupted'): void // every running entry gets that status
    entries(): DispatchEntry[]      // all entries this turn touched, capped
    has(id: string): boolean
    rename(from: string, to: string): void // member
  }
  ```
  Rules: main `toolUse` with name in `DISPATCH_TOOLS` opens a top-level entry (`input.description`, `input.subagent_type`, `input.prompt`); `subToolUse` of those names opens a nested entry (`parent` = the subagent's entry id) and appends `{kind:'agent'}` to the parent; other `subToolUse` appends a tool step to `entries[e.parent]`; `subToolResult` patches it (`doneTs`), or ends a nested entry; `subText` appends text; main `toolResult` ends a top-level entry (`done`/`failed`; `detail.totalTokens/totalToolUseCount/totalDurationMs` → usage, `detail.content` text → `report`); `taskStarted` maps `taskId → toolUseId`, fills empty prompt/type; `taskProgress` sets `now` and usage; `taskUpdated` with status `completed` → `done`, `failed`/`killed`/`error` → `failed`. Ending clears `now`, sets `endedAt`. Every change calls `onChange`. `member` comes from the constructor. Browser/desktop tools stored with input `{}` and the fixed result strings.

- [ ] **Step 1: Write failing tests** — feed `parseLine` output of `dispatch-nested.jsonl`: `opens one entry per dispatch with prompt, description, type`; `parallel dispatches keep their own steps`; `nested dispatch has parent and an agent step`; `tool result patches the step and failed Bash is isError`; `main tool result ends entry with totals and report`; `task_progress sets now and usage`; `end('stopped') marks running entries stopped`; `browser tool input and result are hidden`; `onChange fires per change`.
- [ ] **Step 2:** `npx vitest run --project backend backend/tests/core/dispatchRecorder.test.ts` → FAIL.
- [ ] **Step 3:** Implement; cap text/input/result on write with Task 1 helpers; `entries()` returns `capSteps` applied.
- [ ] **Step 4:** Same command → PASS.

### Task 4: Storage and DispatchService

**Files:**
- Modify: `zumi-bot-server/backend/src/core/store/chatStore.ts` (`dispatchPath`, `loadDispatch(id)`, `updateDispatch(id, fn)` like `updateTodos`, `remove` deletes the file, `renameAgent` moves `member`)
- Create: `zumi-bot-server/backend/src/core/dispatch/dispatchService.ts`
- Test: `zumi-bot-server/backend/tests/core/chatStore.test.ts`, `zumi-bot-server/backend/tests/core/dispatchService.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 3.
- Produces:
  ```ts
  class DispatchService {
    constructor(d: { store: Pick<ChatStore, 'loadDispatch' | 'updateDispatch' | 'loadItems'>;
      onChanged: (chatId: string) => void; now: () => number; delayMs?: number /* default 1000 */ })
    begin(chatId: string, o: { turn: string; member?: string }): DispatchRecorder // registered live, onChange → schedule
    finish(chatId: string, rec: DispatchRecorder): Promise<void> // flush now, unregister; never throws (logs code)
    list(chatId: string): Promise<DispatchSummary[]>
    get(chatId: string, id: string, from?: number): Promise<{ entry: DispatchEntry; from: number } | null>
    renameAgent(from: string, to: string): void // live recorders
  }
  ```
  `schedule(chatId)`: one timer per chat, `delayMs`; on fire: `updateDispatch` merging live entries by id then `pruneEntries`, then `onChanged`. Reads overlay live entries over stored ones. A stored `running` entry with no live recorder reads `interrupted`. `list` keeps entries whose root (follow `parent` to the top) id is a `tool` item id in `loadItems(chatId)` or is live. `get` with `from` returns `steps.slice(from)` and `from`.

- [ ] **Step 1: Write failing tests** — chatStore: `dispatch file is 0600, removed with the chat, member renamed`; `updateDispatch rejects a removed chat`. Service (fake timers, in-memory store): `saves and broadcasts once per burst`; `list overlays live entries`; `running entry with no live recorder reads interrupted`; `list hides entries whose root tool item is not visible`; `nested entries follow their root`; `get from returns only newer steps`; `finish flushes and a store failure does not throw`.
- [ ] **Step 2:** `npx vitest run --project backend backend/tests/core/dispatchService.test.ts backend/tests/core/chatStore.test.ts` → FAIL.
- [ ] **Step 3:** Implement store methods (0600 like `saveTodosRaw`, corrupt file → `.bak-<time>` and empty) and the service.
- [ ] **Step 4:** Same command → PASS.

### Task 5: Wire into turns, RPC and API

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (deps `dispatch?: Pick<DispatchService, 'begin' | 'finish'>`; in `agentTurn`: `const recorder = this.d.dispatch?.begin(chatId, { turn: spec.turnId ?? randomUUID(), ...(spec.author ? { member: spec.author } : {}) })` before the attempts; `recorder?.event(e)` at top of `onEvent` after the `forkIgnored` guard; in `finally` before `await pending`: `recorder?.end(stopped ? 'stopped' : 'interrupted')` then `await this.d.dispatch?.finish(chatId, recorder)` — `stopped` is assigned before `finally`, `end` only touches entries still running; skip for `spec.compact`)
- Modify: `zumi-bot-server/backend/src/app.ts` (build `DispatchService` with `onChanged: (chatId) => hub.broadcast({ event: 'dispatch:changed', payload: { chatId } })`; pass to ChatService and handlers; agent rename calls `dispatch.renameAgent`)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (`'dispatch:list': (chatId) => d.dispatch.list(str(chatId,'chatId'))`, `'dispatch:get': (chatId, id, from) => …` with `from` an optional non-negative integer)
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.dispatch: { list(chatId): Promise<DispatchSummary[]>; get(chatId, id, from?): Promise<{ entry: DispatchEntry; from: number } | null>; onChanged(cb: (chatId: string) => void): () => void }`)
- Modify: `zumi-bot-server/frontend/src/net/api.ts` (mapping)
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts`, `zumi-bot-server/backend/tests/rpc/handlers.test.ts` (or wherever todos handlers are tested)

- [ ] **Step 1: Write failing tests** — chatService with fake claude stdout = `dispatch-nested.jsonl`: `records dispatches of a turn`; `stopped turn marks running entries stopped` (fixture cut before the main results + stop); room turn stamps `member`. Handlers: `dispatch:get rejects a bad from`.
- [ ] **Step 2:** Run those files → FAIL.
- [ ] **Step 3:** Implement wiring.
- [ ] **Step 4:** Run them → PASS; `npm run typecheck` → clean.

### Task 6: Sync

**Files:**
- Modify: `zumi-bot-server/deploy/sync.mjs` (`export function mergeDispatch(local, vps)`: join `entries` by id, later `updatedAt` wins, then newest 200 by `startedAt`; added to the per-chat join loop, `fromVps` copy list, copy-chat ext list, writes 0600)
- Test: `zumi-bot-server/backend/tests/sync.test.ts`

- [ ] **Step 1: Write failing tests** — `mergeDispatch joins by id and later updatedAt wins`; `mergeDispatch applies the 200 cap`; `null side returns the other`.
- [ ] **Step 2:** `npx vitest run --project backend backend/tests/sync.test.ts` → FAIL.
- [ ] **Step 3:** Implement (plain `.mjs`, no imports from shared; copy the cap value with a comment pointing to `shared/src/dispatch.ts`).
- [ ] **Step 4:** Same command → PASS.

### Task 7: Frontend pure state

**Files:**
- Create: `zumi-bot-server/frontend/src/state/dispatchPanel.ts`
- Modify: `zumi-bot-server/frontend/src/state/sidePanel.ts` (`SideView` adds `'dispatch'`; `chatViews` includes it)
- Test: `zumi-bot-server/frontend/tests/dispatchPanel.test.ts`, `zumi-bot-server/frontend/tests/sidePanel.test.ts` (existing file, if present)

**Interfaces:**
- Produces:
  - `interface DispatchGroup { turn: string; label: string; member?: string; rows: { s: DispatchSummary; depth: number }[] }`
  - `groupDispatch(list: DispatchSummary[], fmtTime: (ms: number) => string): DispatchGroup[]` — groups by `turn`, newest group first (by max `startedAt`), first group label `"This reply"`, others `fmtTime(start)`; within a group roots by `startedAt`, each followed by its descendants depth-first (`depth` 0, 1, …); an orphan (parent missing) is a root.
  - `usageLine(s: DispatchSummary, nowMs: number): string` — parts joined by " · ": `"N tool uses"` (1 → "1 tool use"), tokens `"41k tokens"` (`<1000` → `"950 tokens"`, else rounded k), time `"1m 12s"` / `"48s"` (running: `nowMs - startedAt`; ended: `usage.durationMs ?? endedAt - startedAt`); missing parts left out; ended prefixed `"Done"`, `"Failed"`, `"Stopped"`, `"Interrupted"`.
  - `dispatchBadge(list): { text: string; live: boolean } | null` — any running → `{ text: "N running", live: true }`; else total `> 0` → `{ text: String(total), live: false }`; else null.
  - `waitingIds(list, pendingToolIds: Set<string>): Set<string>` — summaries whose `openTools` hit a pending approval's `toolUseId`.
  - `linkState(list, toolId): 'running' | 'ended' | null` — for Watch/View.

- [ ] **Step 1: Write failing tests** for each function with the mockup's values ("7 tool uses · 41k tokens · 1m 12s", "Done · 12 tool uses · 63k tokens · 2m 05s" — seconds zero-padded after minutes, "2 running").
- [ ] **Step 2:** `npx vitest run --project frontend frontend/tests/dispatchPanel.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** → PASS.

### Task 8: Frontend UI

**Files:**
- Create: `zumi-bot-server/frontend/src/useDispatch.ts` (summaries, like `useTodos`: fetch on chat/connected change and on every `dispatch:changed` for the chat; a 1 s tick only while any is running, for timers)
- Create: `zumi-bot-server/frontend/src/useDispatchEntry.ts` (one entry; first fetch whole, then `get(chatId, id, steps.length)` on each change event and appends; refetch whole if `from` mismatches)
- Create: `zumi-bot-server/frontend/src/components/DispatchPanel.tsx` (list and detail per mockup `layout-v2`; `data-testid`s: `dispatch-panel`, `dispatch-row` (+`data-id`, `data-status`), `dispatch-now`, `dispatch-usage`, `dispatch-detail`, `dispatch-prompt`, `dispatch-show-all`, `dispatch-step` (+`data-kind`), `dispatch-report`, `dispatch-working`, `dispatch-close`, uses `SideBackButton`; text via `Markdown`; tool steps via `ToolCallRow` with an adapted item; agent step opens the child)
- Create: `zumi-bot-server/frontend/src/components/dispatchLink.ts` (React context `{ state(toolId): 'running' | 'ended' | null; open(toolId): void }`, default returns null)
- Modify: `zumi-bot-server/frontend/src/components/ToolCallRow.tsx` (for `Agent`/`Task`: `Watch ›` / `View ›` button, `data-testid="dispatch-watch"`, beside the head, not inside it)
- Modify: `zumi-bot-server/frontend/src/components/SidePanelMenu.tsx` (row `side-open-dispatch`, badge `side-dispatch-count` with `.live` class; props `dispatchBadge`, `onOpenDispatch`)
- Modify: `zumi-bot-server/frontend/src/App.tsx` (`useDispatch(shownChat?.id)`; `dispatchFocus` `{chatId, id, n}`; render `DispatchPanel` for `shownSideView === 'dispatch'`; add `'dispatch'` to the two list checks at the `side !== 'files' …` guard and `listShown`; provide `dispatchLink` around the chat view, `open` sets focus + `setSide('dispatch')`; pending approval `toolUseId`s from the open chat's items for `waitingIds`)
- Modify: `zumi-bot-server/frontend/src/styles.css` (status dots, nested indent, blue now line, group heading, prompt/report boxes; existing tokens only)

- [ ] **Step 1:** Implement hooks, panel, link, menu row, App wiring, styles.
- [ ] **Step 2:** `npm run typecheck` and `npx vitest run --project frontend` → clean/PASS.

### Task 9: e2e and docs

**Files:**
- Create: `zumi-bot-server/e2e/fixtures/dispatch-script.jsonl` (two parallel dispatches, one nested, `#SLEEP` gaps so the list is seen live, then results and a final text)
- Create: `zumi-bot-server/e2e/dispatch.e2e.mjs` (copy `files.e2e.mjs` setup: fake claude with `FAKE_STDOUT_FILE`)
- Modify: `package.json` (`"e2e:dispatch": "npm run build && node zumi-bot-server/e2e/dispatch.e2e.mjs"`)
- Modify: `CLAUDE.md` (a **Dispatched agents** paragraph in Architecture; `e2e:dispatch` in the E2E list, costs no quota)

- [ ] **Step 1:** e2e checks: badge reads "2 running" during the sleeps; two rows plus one indented; open a row shows prompt, text step, tool steps; `dispatch-watch` on the chat's Agent row opens that entry; after the reply, rows `data-status="done"`, report shown; reload keeps them.
- [ ] **Step 2:** `npm run e2e:dispatch` → all `ok`, exit 0.
- [ ] **Step 3:** Write the CLAUDE.md paragraph.

### Task 10: Whole check

- [ ] `npm run typecheck` → clean.
- [ ] `npm test` → all PASS.
- [ ] `npm run e2e:files` and `npm run e2e:todos` → PASS (subagent parser and side panel regressions).
- [ ] Run the built app against the fake script and look at the panel in the browser pane, light and dark, desktop and phone width.
