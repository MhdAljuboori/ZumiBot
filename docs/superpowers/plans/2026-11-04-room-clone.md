# Room Clone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clone a group room into a new empty room with the same members, role and folder, optionally carrying a user-reviewed handoff summary that every member reads in its system prompt.

**Architecture:** The handoff lives on `GroupInfo.handoff` and is appended to each member's briefing (`--append-system-prompt`). A separate Sonnet call (`roomSummary.ts`, modeled on `moderator.ts`) drafts it from the room's visible items; `roomClone.ts` (modeled on `fork.ts`) creates the room. Three RPCs connect a dialog whose logic is a pure state machine in `frontend/src/state/cloneRoom.ts`; the client places the new room under the old one in the sidebar.

**Tech Stack:** TypeScript, Node 22, vitest, React 19, `claude` CLI, playwright-core e2e.

**Spec:** `docs/superpowers/specs/2026-11-04-room-clone-design.md` (read it with this plan).

All paths below are relative to `zumi-bot-server/` unless they start with `docs/` or `package.json`/`CLAUDE.md` (repo root of the worktree).

## Global Constraints

- Worktree: `/home/mhdaljuboori/Developments/AI/ZumiBot/.claude/worktrees/group-clone`, branch `worktree-group-clone`. Never touch the main checkout.
- **No commits.** The user commits only on explicit request; skip every commit step a sub-skill suggests.
- `HANDOFF_MAX_CHARS = 12_000`, `CLONE_TITLE_MAX = 200`, `SUMMARY_INPUT_MAX_CHARS = 150_000`, `SUMMARY_TIMEOUT_MS = 180_000`, at most 2 summary calls server-wide, 1 per room.
- Summary call args exactly: `-p --model sonnet --tools '' --setting-sources '' --strict-mcp-config --no-session-persistence --output-format json --system-prompt <SUMMARY_SYSTEM_PROMPT>`.
- User-facing errors: `Couldn't write the summary. Try again.`, `Too many summaries running. Try again in a moment.`, `Cancelled`, `Nothing to summarize yet`. Never surface CLI text.
- Handoff text and transcript never go into logs, URLs or error messages.
- No new dependencies. Comments short, say why.
- Frontend unit tests cover only `src/state/` and `src/net/`; keep logic there.
- Copy: sentence case; "Clone room…", "Start over", "With summary", "Write summary", "Writing summary…", "Rewrite", "Back", "Create room", "Edit freely. Agents read exactly this.", "Handoff from <title>", "Show all", "Show less", "Discard this summary?".

## Review Focus

1. **A handoff containing `</handoff>`** (from the transcript or typed by the user) must not close the tag early in the system prompt: the briefing escapes it. Test in Task 2.
2. **A single first user message longer than the whole input cap** must still yield a prompt within `SUMMARY_INPUT_MAX_CHARS` (the pinned message is cut). Test in Task 4.
3. **Double-clicking Create room** must make one room: the machine ignores `create` while `creating`. Test in Task 8.
4. **An untitled source room** gives the default name `Room (2)` and `from.title` `Room`. Tests in Tasks 1 and 6.
5. **The socket dropping while writing** rejects the pending call (`rpc.ts` clears `pending` on close), so the dialog must land in `failed`, not hang. Test in Task 8 (`summaryFailed` from `writing`).

---

### Task 1: Shared types, constants and default name

**Files:**
- Create: `shared/src/roomClone.ts`
- Modify: `shared/src/types.ts` (`GroupInfo`, new `RoomHandoff`)
- Modify: `shared/src/usageReport.ts` (add `SUMMARY_AGENT`)
- Test: `shared/tests/roomClone.test.ts`

**Interfaces:**
- Produces:
  - `types.ts`: `export interface RoomHandoff { text: string; from: { chatId: string; title: string }; at: number }`; `GroupInfo.handoff?: RoomHandoff` (comment: absent = none).
  - `roomClone.ts`: `HANDOFF_MAX_CHARS = 12_000`, `CLONE_TITLE_MAX = 200`, `UNTITLED_ROOM = 'Room'`, `nextCopyTitle(title: string, taken: readonly string[]): string`.
  - `usageReport.ts`: `export const SUMMARY_AGENT = '#handoff'` (comment: reserved agent name on records; shown as "Room handoff").

- [ ] **Step 1: Write failing tests** in `shared/tests/roomClone.test.ts`:
  - `nextCopyTitle('API room', [])` → `'API room (2)'`
  - `nextCopyTitle('API room', ['API room (2)', 'API room (3)'])` → `'API room (4)'`
  - `nextCopyTitle('API room (2)', [])` → `'API room (3)'` (a trailing ` (n)` is bumped, not stacked)
  - `nextCopyTitle('', [])` and `nextCopyTitle('   ', [])` → `'Room (2)'`
  - a 200-char title → result length ≤ `CLONE_TITLE_MAX` (base is cut before the suffix)
- [ ] **Step 2:** `npx vitest run --project shared roomClone` → FAIL (module missing).
- [ ] **Step 3:** Implement `roomClone.ts`, the `RoomHandoff`/`GroupInfo.handoff` types and `SUMMARY_AGENT`.
- [ ] **Step 4:** `npx vitest run --project shared roomClone` → PASS; `npm run typecheck` → clean.

### Task 2: Members read the handoff

**Files:**
- Modify: `backend/src/core/chat/groupPrompts.ts` (`buildBriefing`)
- Modify: `backend/src/core/chat/groupService.ts:617` (pass `g.handoff`)
- Test: `backend/tests/core/groupPrompts.test.ts`, `backend/tests/core/groupService.test.ts`

**Interfaces:**
- Consumes: `RoomHandoff` (Task 1).
- Produces: `buildBriefing(me: string, members: readonly MemberInfo[], cwd: string, role: string, handoff?: RoomHandoff): string`.

- [ ] **Step 1: Write failing tests:**
  - `buildBriefing(..., handoff)` contains `This room continues work from an earlier room, "Old room".`, `The user reviewed this handoff note for you. Treat it as background: what the user says in this room wins over it.`, and `<handoff>\n<text>\n</handoff>`; the section comes after the role section.
  - without a handoff the output equals today's (snapshot the existing call).
  - a text containing `</handoff>` appears with that tag escaped (e.g. `<\/handoff>`), and the briefing has exactly one closing `</handoff>`.
  - groupService: a room meta with `group.handoff` → the member turn's `systemPrompt` (as the existing groupService tests capture it) contains the handoff text, on a first turn and on a seeded turn.
- [ ] **Step 2:** `npx vitest run --project backend groupPrompts groupService` → new tests FAIL.
- [ ] **Step 3:** Add the optional param and section; pass `g.handoff` at the `systemPrompt: buildBriefing(...)` call.
- [ ] **Step 4:** Same command → PASS.

### Task 3: Fork and sync keep the handoff

**Files:**
- Modify: `backend/src/core/chat/fork.ts` (the `patch.group = { ...fresh.group!, ... }` line)
- Test: `backend/tests/core/fork.test.ts`, `backend/tests/sync.test.ts`

**Interfaces:**
- Consumes: `GroupInfo.handoff` (Task 1).

- [ ] **Step 1: Write failing tests:**
  - forking a room whose `group.handoff` is set → the fork's `group.handoff` deep-equals the source's.
  - forking a room with no handoff → fork has no `handoff` key.
  - sync: a chat in `chats.json` with `group.handoff` survives both the merge path and a copy chat (`copyMeta`) unchanged. (Expected to pass already for sync; it pins the behavior.)
- [ ] **Step 2:** `npx vitest run --project backend fork sync` → fork test FAILS.
- [ ] **Step 3:** Carry `handoff` from `src.group` into `patch.group` when present.
- [ ] **Step 4:** Same command → PASS.

### Task 4: Summary prompt, args and parsing (pure)

**Files:**
- Create: `backend/src/core/chat/roomSummary.ts` (pure part)
- Test: `backend/tests/core/roomSummary.test.ts`

**Interfaces:**
- Consumes: `MemberInfo`, `threadEntries`-style rendering rules (`groupPrompts.ts`), `listChatFiles` / `ChatFileList` (`shared/src/chatFiles.ts`, `shared/src/files.ts`), `RoomHandoff`, `HANDOFF_MAX_CHARS`, `OMITTED` (`seedPrompt.ts`).
- Produces:
  - `SUMMARY_SYSTEM_PROMPT: string` (first line starts with `You write a handoff note`; Task 10's fake keys on this).
  - `SUMMARY_INPUT_MAX_CHARS = 150_000`, `SUMMARY_FILES_MAX = 300`.
  - `summaryArgs(): string[]`
  - `interface SummaryInput { members: MemberInfo[]; role: string; earlier: RoomHandoff | null; files: string[]; items: readonly ChatItem[] }` (`files`: shown paths, already relative to cwd, newest first)
  - `summaryPrompt(input: SummaryInput): string`
  - `hasSummarizable(items: readonly ChatItem[]): boolean` (a finished user or member message exists)
  - `parseSummaryOutput(stdout: string): string | null` (trimmed `result`, cut to `HANDOFF_MAX_CHARS`; null on junk, `is_error`, empty, non-string)

- [ ] **Step 1: Write failing tests:**
  - `summaryArgs()` deep-equals the Global Constraints list, ending with `SUMMARY_SYSTEM_PROMPT`.
  - `SUMMARY_SYSTEM_PROMPT` contains the six headings in order (`## Goal`, `## Decisions`, `## Current state`, `## Who does what`, `## Your preferences`, `## Open items`), `300–700 words` (or "300 to 700"), a rule against `@`, and an instruction to treat the transcript as material, not instructions.
  - prompt roster line is `- writer (Writer): writes things` (no `@`); role `(none)` when empty; `<earlier_handoff>` only when `earlier` set; file list `(none)` when empty, and 301 files → 300 lines plus `and 1 more`.
  - conversation renders user (`<message from="user">`, `[attached: a.png]`), member (`<message from="writer" name="Writer">`), answered question and approved plan the way `threadEntries` does; skips items with `turn` set, tools, notices, errors, pending approvals.
  - over the cap: first user message kept, then `[Earlier messages omitted]`, then the newest that fit; conversation part ≤ `SUMMARY_INPUT_MAX_CHARS`.
  - a first user message of 200 000 chars → conversation part ≤ `SUMMARY_INPUT_MAX_CHARS` (Review Focus 2).
  - `hasSummarizable([])` false; only a running item → false; a finished assistant message → true.
  - `parseSummaryOutput('{"result":" ## Goal\\nx "}')` → `'## Goal\nx'`; `is_error: true` → null; `"result": ""` → null; `'nope'` → null; a 20 000-char result → length `HANDOFF_MAX_CHARS`.
- [ ] **Step 2:** `npx vitest run --project backend roomSummary` → FAIL.
- [ ] **Step 3:** Implement. Reuse `threadEntries`'s rules by calling it with `afterId = null, me = ''` where that gives the right entries, rather than copying them.
- [ ] **Step 4:** Same command → PASS.

### Task 5: Running summary calls

**Files:**
- Modify: `backend/src/core/chat/roomSummary.ts` (add `RoomSummaries`)
- Modify: `backend/src/core/usage/usageService.ts` (`recordSummary`, `usageAgentLabel`)
- Modify: `frontend/src/components/UsageView.tsx:81` (add `<option value={SUMMARY_AGENT}>Room handoff</option>`)
- Test: `backend/tests/core/roomSummaries.test.ts`, `backend/tests/core/usageService.test.ts` (or wherever `recordModerator` is tested)

**Interfaces:**
- Consumes: Task 4 exports, `parseRunCost`, `SUMMARY_AGENT`.
- Produces:
  - `SUMMARY_TIMEOUT_MS = 180_000`, `SUMMARY_MAX_RUNNING = 2`, error constants `SUMMARY_FAILED = "Couldn't write the summary. Try again."`, `SUMMARY_BUSY = 'Too many summaries running. Try again in a moment.'`, `SUMMARY_CANCELLED = 'Cancelled'`, `NOTHING_TO_SUMMARIZE = 'Nothing to summarize yet'`.
  - `class RoomSummaries { constructor(d: RoomSummariesDeps); summarize(chatId: string): Promise<string>; cancel(chatId: string): void; stopAll(): void }`
  - `interface RoomSummariesDeps { store: Pick<ChatStore, 'get' | 'loadItems'>; agents(): Promise<AgentSummary[]>; bin(): Promise<string | null>; env(): Promise<NodeJS.ProcessEnv>; home: string; claudeDir?: string; timeoutMs?: number; onCost?(chatId: string, cost: RunCost, id: string | null): void }`
  - `UsageService.recordSummary(chatId: string, cost: RunCost, id: string | null, at: number): void` (same shape as `recordModerator`, agent `SUMMARY_AGENT`); `usageAgentLabel(SUMMARY_AGENT)` → `'Room handoff'`.

- [ ] **Step 1: Write failing tests** with `backend/tests/fixtures/fake-moderator.mjs` as `bin` (`FAKE_MODERATOR_OUT` = the JSON, `FAKE_MODERATOR_HANG=1` to hang):
  - resolves with the parsed draft for a room with one finished message (the prompt itself is Task 4's job).
  - not found → rejects `Chat not found: <id>`; single chat → `Not a group chat`; no finished messages → `NOTHING_TO_SUMMARIZE`; `bin()` null or bad output → `SUMMARY_FAILED`.
  - second `summarize` for the same room while the first hangs → first rejects `SUMMARY_CANCELLED`, second resolves.
  - third concurrent call on a third room → rejects `SUMMARY_BUSY`.
  - `cancel(id)` on a hanging call → rejects `SUMMARY_CANCELLED` well before the timeout, and a new `summarize` on another room is no longer counted against `SUMMARY_MAX_RUNNING`; `stopAll()` rejects every running call the same way.
  - `timeoutMs: 50` with hang → rejects `SUMMARY_FAILED`.
  - `onCost` called once with the parsed cost when stdout held `total_cost_usd`, also when the exit code is non-zero; not called when nothing was printed.
  - `recordSummary` writes a cost record with `agent: '#handoff'`; `usageAgentLabel('#handoff') === 'Room handoff'`.
- [ ] **Step 2:** `npx vitest run --project backend roomSummaries usageService` → FAIL.
- [ ] **Step 3:** Implement; spawn and kill like `runModerator` (stdio `['pipe','pipe','ignore']`, SIGTERM). Build `files` from `listChatFiles(items, cwd, home, claudeDir).changed.map(f => f.shown)`, members from `agents()` (description of a missing agent: empty). Pass the source's `group.handoff` as `earlier`.
- [ ] **Step 4:** Same command → PASS.

### Task 6: Creating the room

**Files:**
- Create: `backend/src/core/chat/roomClone.ts`
- Modify: `backend/src/core/chat/chatService.ts` (add `copyAllowed` beside `forget`, line ~244)
- Test: `backend/tests/core/roomClone.test.ts`, `backend/tests/core/chatService.test.ts`

**Interfaces:**
- Consumes: `ChatStore.createGroup/get/update`, `RoomHandoff`, `UNTITLED_ROOM`.
- Produces:
  - `ChatService.copyAllowed(from: string, to: string): void` (copies the in-memory "Allow for this chat" set of scope `from` to `to`; no-op when absent).
  - `interface CloneDeps { store: ChatStore; allowed: Pick<ChatService, 'copyAllowed'>; now(): number }`
  - `cloneRoom(d: CloneDeps, chatId: string, title: string, handoff: string | null): Promise<ChatMeta>`

- [ ] **Step 1: Write failing tests:**
  - result has the source's `members` (same order), `role`, `cwd`, the given `title`; `sessions`/`seen` empty, no `next`/`context`/`reactions`/`tasks`/`held`/`replyAt`/`seenAt`/`mark`; `loadItems(new)` is `[]`.
  - `handoff` string → `group.handoff = { text, from: { chatId: src.id, title: src.title }, at: now }`; untitled source → `from.title === 'Room'`; `null` → no `handoff` key (also when the source has one).
  - the source's meta (via `store.get`) and items deep-equal what they were before.
  - `copyAllowed` called once per member with `${src}:${m}` → `${new}:${m}`.
  - missing source → `Chat not found: <id>`; single chat → `Not a group chat`.
  - chatService: after an allow-chat answer in scope `a:writer`, `copyAllowed('a:writer','b:writer')` makes the same request in `b:writer` auto-allowed; `forget('a')` leaves `b:writer` intact.
- [ ] **Step 2:** `npx vitest run --project backend roomClone chatService` → FAIL.
- [ ] **Step 3:** Implement; set `title` and `group` in one `store.update` after `createGroup`.
- [ ] **Step 4:** Same command → PASS.

### Task 7: RPC methods and wiring

**Files:**
- Modify: `shared/src/types.ts` (`ZumiBotApi.chats`)
- Modify: `backend/src/rpc/handlers.ts` (`HandlerDeps.summaries`, three handlers beside `chats:fork`)
- Modify: `backend/src/app.ts` (build `RoomSummaries` near `GroupService`; `summaries.stopAll()` next to `tasks.shutdown()` in both shutdown paths, lines ~445 and ~506; pass to `createHandlers`)
- Modify: `frontend/src/net/api.ts` (three mappings beside `fork`)
- Test: `backend/tests/rpc/handlers.test.ts`, `frontend/tests/net/api.test.ts`, `backend/tests/app.test.ts` if it lists deps

**Interfaces:**
- Consumes: Tasks 5 and 6.
- Produces (`ZumiBotApi.chats`):
  - `summarizeRoom(chatId: string): Promise<string>`
  - `cancelSummary(chatId: string): Promise<void>`
  - `cloneRoom(chatId: string, title: string, handoff: string | null): Promise<ChatMeta>`
  - `HandlerDeps.summaries: Pick<RoomSummaries, 'summarize' | 'cancel'>`

- [ ] **Step 1: Write failing tests:**
  - handlers: `chats:cloneRoom` trims title; rejects empty title, a 201-char title, a non-string title; handoff `null` passes; empty/whitespace handoff, a 12 001-char handoff and a number reject; on success pushes `{ chatId: new.id, kind: 'meta', meta }` once.
  - handlers: `chats:summarizeRoom` / `chats:cancelSummary` validate `chatId` with `str()` and call through.
  - api: each method sends `chats:summarizeRoom` / `chats:cancelSummary` / `chats:cloneRoom` with its args in order.
- [ ] **Step 2:** `npx vitest run --project backend handlers` and `npx vitest run --project frontend api` → FAIL.
- [ ] **Step 3:** Implement. In `app.ts`, `bin` is `claude.locate()`, `env` awaits `runEnv.ready()` then returns `runEnv.env()`, `onCost` is `usage.recordSummary(chatId, c, id, Date.now())`, `claudeDir` is `process.env['CLAUDE_CONFIG_DIR'] || undefined`.
- [ ] **Step 4:** Both commands → PASS; `npm run typecheck` → clean.

### Task 8: Dialog state machine and sidebar placement (pure)

**Files:**
- Create: `frontend/src/state/cloneRoom.ts`
- Modify: `frontend/src/state/sidebarLayout.ts` (add `placeAfter`)
- Test: `frontend/tests/cloneRoom.test.ts`, `frontend/tests/sidebarLayout.test.ts`

**Interfaces:**
- Consumes: `nextCopyTitle`, `HANDOFF_MAX_CHARS`, `CLONE_TITLE_MAX` (Task 1); `moveItem`, `unassignedOrder`, `sectionOf` (existing).
- Produces:
  - `type CloneOption = 'fresh' | 'summary'`
  - `type CloneStep = 'choose' | 'writing' | 'review' | 'failed' | 'creating'`
  - `interface CloneState { step: CloneStep; name: string; option: CloneOption; draft: string | null; text: string; edited: boolean; error: string | null; from: 'choose' | 'review' }` (`from`: where `creating` returns on failure)
  - `type CloneEvent = { type: 'name'; name: string } | { type: 'option'; option: CloneOption } | { type: 'write' } | { type: 'summaryReady'; text: string } | { type: 'summaryFailed'; error: string } | { type: 'edit'; text: string } | { type: 'rewrite' } | { type: 'back' } | { type: 'create' } | { type: 'createFailed'; error: string } | { type: 'cancelWriting' }`
  - `initialClone(title: string, taken: readonly string[]): CloneState` (step `choose`, option `fresh`)
  - `cloneReducer(s: CloneState, e: CloneEvent): CloneState`
  - `canCreate(s: CloneState): boolean` (name trimmed non-empty and ≤ `CLONE_TITLE_MAX`; in `review` also text trimmed non-empty and ≤ `HANDOFF_MAX_CHARS`; false in `writing`/`creating`)
  - `handoffOf(s: CloneState): string | null` (`null` for `fresh`, else `text`)
  - `placeAfter(layout: SidebarLayout, keys: readonly string[], key: string, afterKey: string): SidebarLayout`

- [ ] **Step 1: Write failing tests:**
  - `initialClone('API room', [])` → `{ step: 'choose', name: 'API room (2)', option: 'fresh', draft: null, ... }`.
  - `write` → `writing`; `summaryReady` → `review` with `draft = text = 'x'`, `edited` false; `edit` → `text` changed, `edited` true; `back` → `choose`, draft and text kept; `write` again with a draft → straight to `review` with the kept text, no `writing`.
  - `rewrite` → `writing`, `draft` cleared on the next `summaryReady`; `cancelWriting` → `choose`.
  - `summaryFailed` from `writing` → `failed` with the error (Review Focus 5); `write` from `failed` → `writing`; `back` from `failed` → `choose`.
  - `create` from `choose` (fresh) and `review` → `creating` with `from` set; `create` while `creating` → same state object (Review Focus 3); `createFailed` → back to `from` with `error`.
  - `canCreate`: empty name false; 201-char name false; `review` with whitespace text false; 12 001-char text false; `writing` false.
  - `handoffOf`: fresh → null; summary in review → the edited text.
  - `placeAfter`: anchor in a section → key right after it there and removed from unassigned; anchor stored in `unassigned` → right after it; anchor never placed (layout empty, `keys` = `['group:new','group:a','group:old','group:b']`) → `unassigned` written out as `['group:a','group:old','group:new','group:b']`; anchor not in `keys` → layout returned unchanged.
- [ ] **Step 2:** `npx vitest run --project frontend cloneRoom sidebarLayout` → FAIL.
- [ ] **Step 3:** Implement. `placeAfter`: find the anchor's list (`sectionOf` → that section's `items`, else `unassignedOrder(layout, keys)`), take the item after the anchor (skipping `key` itself) as `before`, then `moveItem(layout, keys, key, { section, before })`.
- [ ] **Step 4:** Same command → PASS.

### Task 9: UI

**Files:**
- Create: `frontend/src/components/CloneRoomDialog.tsx`
- Create: `frontend/src/components/HandoffCard.tsx`
- Modify: `frontend/src/components/Sidebar.tsx` (row menu, `menu.kind === 'chat'` block ~line 826; new prop `onCloneRoom(chat: ChatMeta): void`)
- Modify: `frontend/src/components/ContextMeter.tsx` (optional prop `onCloneRoom?: () => void`; button under the member rows, rooms only)
- Modify: `frontend/src/components/ChatView.tsx` (pass `onCloneRoom` to the meter; pass handoff data to `MessageList`)
- Modify: `frontend/src/components/MessageList.tsx` (render `HandoffCard` first when `!hasOlder`, also in the empty state)
- Modify: `frontend/src/App.tsx` (dialog state; `onCreated` flow)
- Modify: `frontend/src/styles.css`

**Interfaces:**
- Consumes: Tasks 7 and 8; `MenuIcon`, `Markdown`, `useDismiss`, `ConfirmDialog`.
- Produces:
  - `CloneRoomDialog({ chat, takenTitles, memberCount, canSummarize, onClose, onCreated }: { chat: ChatMeta; takenTitles: string[]; memberCount: number; canSummarize: boolean; onClose(): void; onCreated(meta: ChatMeta): void })`
  - `HandoffCard({ handoff, sourceExists, onOpenSource }: { handoff: RoomHandoff; sourceExists: boolean; onOpenSource(): void })`

- [ ] **Step 1:** Dialog drives `cloneReducer`; `write`/`rewrite` call `api.chats.summarizeRoom(chat.id)` and dispatch `summaryReady`/`summaryFailed` (ignore a `Cancelled` rejection after the user left `writing`); Cancel in `writing`, Esc, backdrop and unmount call `api.chats.cancelSummary(chat.id)`; Rewrite and closing with `edited` text ask "Discard this summary?" with `ConfirmDialog`; Create calls `api.chats.cloneRoom(chat.id, name.trim(), handoffOf(state))`. "With summary" is disabled with the reason `Nothing to summarize yet` when `!canSummarize`. Text box gets `dir="auto"`; show the count once text passes 90 % of `HANDOFF_MAX_CHARS`. Phone width: full-width sheet. `data-testid`s: `clone-dialog`, `clone-name`, `clone-option-fresh`, `clone-option-summary`, `clone-write`, `clone-create`, `clone-cancel`, `clone-text`, `clone-rewrite`, `clone-back`, `clone-error`.
- [ ] **Step 2:** `canSummarize` in the UI: the chat's loaded items contain a finished user or assistant message, or `hasOlder`; the server's `NOTHING_TO_SUMMARIZE` is the real check.
- [ ] **Step 3:** App `onCreated`: `setChats(upsertChat(...))`, then `sidebarLayout.save(placeAfter(layout, itemKeys(agents, nextChats), groupKey(meta.id), groupKey(source.id)))` when `layout` is not null, then `openChat(meta.id)`.
- [ ] **Step 4:** Sidebar: "Clone room…" (`MenuIcon` copy-like icon; add one to `MenuIcon` if missing) between Rename and Move to, only for `menu.chat.group`; `data-testid="chat-menu-clone"`. ContextMeter: `data-testid="context-clone"`, rooms only.
- [ ] **Step 5:** HandoffCard: `data-testid="handoff-card"`, collapsed shows "Handoff from <title>" (a button opening the source when `sourceExists`) and the first two lines; "Show all"/"Show less" toggles a `Markdown` render; `dir="auto"`; no message actions.
- [ ] **Step 6:** `npm run typecheck` → clean; `npm test` → all pass.

### Task 10: E2E and docs

**Files:**
- Create: `backend/tests/fixtures/fake-clone-claude.mjs`
- Create: `e2e/clone.e2e.mjs`
- Modify: `package.json` (`"e2e:clone": "npm run build && node zumi-bot-server/e2e/clone.e2e.mjs"`)
- Modify: `CLAUDE.md` (Commands: `e2e:clone` sentence like the other fake-claude suites; Architecture: **Room clone** paragraph)

**Interfaces:**
- Consumes: everything above; `start({ fake: <path> })` from `e2e/harness.mjs`.
- Produces: the fake answers a call whose `--system-prompt` value starts with `You write a handoff note` by draining stdin and printing `{"type":"result","is_error":false,"result":<FAKE_SUMMARY_TEXT or a fixed "## Goal\n..." default>,"total_cost_usd":0.01,"uuid":"<random>"}`; while the file named by `FAKE_SUMMARY_HANG_FILE` exists it hangs instead (so one server run can test both); every other call is `import('./fake-claude.mjs')`. Invocations are logged with `FAKE_INVOCATIONS_OUT`.

- [ ] **Step 1:** Write `clone.e2e.mjs` checking, in order:
  1. A room made by `chats:createGroup` (never placed in the sidebar) with one finished exchange; row menu → Clone room… → Start over → Create room: new room opens, empty, same members/role/folder, its row directly under the source row.
  2. Clone with summary: Write summary → review shows the fake text; edit it (append `EDITED-MARK`) → Create room: `handoff-card` shows `Handoff from <name>`; send a message; the member's invocation args contain `--append-system-prompt` whose value includes `EDITED-MARK`, and none contain the unedited default without it.
  3. Create the `FAKE_SUMMARY_HANG_FILE` file: Write summary → "Writing summary…" shows → Cancel → dialog back at choose; close → chat list unchanged. Remove the file afterwards.
  4. Usage has a `#handoff` record for the source room (via `usage:query` RPC).
- [ ] **Step 2:** `npm run e2e:clone` → PASS. Kill any Chrome it leaves (user rule).
- [ ] **Step 3:** Docs: CLAUDE.md paragraph (what is copied, `GroupInfo.handoff` in the briefing, `roomSummary.ts` call and caps, `roomClone.ts`, client sidebar placement, UI entry points, the spec path).
- [ ] **Step 4:** Final: `npm run typecheck` clean, `npm test` all pass, `npm run e2e:clone` pass.
