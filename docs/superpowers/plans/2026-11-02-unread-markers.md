# Unread Markers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mark chats with agent output the user has not seen, in the sidebar and with a "New" line in the chat, cleared by looking at the chat on any device.

**Architecture:** Two optional `ChatMeta` times (`replyAt`, `seenAt`) written by a small server service, `ReadMarks`, fed by turn ends (single chats from `ChatService`, rooms from a new `GroupService` hook that knows about passes) and by the notifications feature's presence (`onStarted`/`onStopped`). The UI reads them from the chat list and `meta` pushes; all UI logic is in a pure `state/unread.ts`.

**Tech Stack:** TypeScript, Node 22, React 19, vitest, playwright-core e2e against the fake claude.

**Spec:** `docs/superpowers/specs/2026-11-02-unread-markers-design.md`

## Global Constraints

- **Never commit.** The user commits by hand. No `git add`/`git commit` in any task.
- Work only in the worktree `/home/mhdaljuboori/Developments/AI/ZumiBot/.claude/worktrees/unread-markers` (branch `unread-markers`). Run commands from its root.
- No new RPC method and no new data file. State rides on `ChatMeta`.
- Read-state writes never change `updatedAt`.
- Every read-state entry point is fire-and-forget: a failure is caught and logged, never reaches a turn, room or presence report. Log lines carry no chat text.
- The unread dot uses a neutral colour, never `--accent` (the approval badge) or `--warning` (the Routines tab dot). Where approval and unread both apply, only the approval badge shows.
- Comments short, say *why*; match the surrounding code's style (see CLAUDE.md, Conventions).
- Frontend logic goes in `frontend/src/state/` (the only frontend code with tests).

## Review Focus

1. **Room member passes** → no unread. A pass that keeps approval cards also no unread. (Task 4 tests both.)
2. **Reply ends while the user looks at the chat** → read in the same write, never a dot. (Task 3 test; Task 10 e2e.)
3. **Concurrent turn write and read write** → `updatedAt` never rolls back. (Task 2 test.)
4. **Chat deleted between the event and the write** → no throw, no push, nothing logged as failure. (Task 3 test.)
5. **The New line must not move when the server's read lands right after opening**, and must appear when the open chat goes unread → read while idle. (Task 7 tests on `sinceOnOpen`/`sinceOnChange`.)

---

### Task 1: `ChatMeta` fields and the shared unread check

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`ChatMeta`, after `compacting?`)
- Create: `zumi-bot-server/shared/src/unread.ts`
- Test: `zumi-bot-server/shared/tests/unread.test.ts`

**Interfaces:**
- Produces: `ChatMeta.replyAt?: number`, `ChatMeta.seenAt?: number`; `isUnread(c: Pick<ChatMeta, 'replyAt' | 'seenAt'>): boolean` from `@zumibot/shared/unread`.

- [ ] **Step 1: Write the failing test** `unread.test.ts`, `describe('isUnread')`:
  - `isUnread({})` → `false` (an old chat)
  - `isUnread({ seenAt: 5 })` → `false`
  - `isUnread({ replyAt: 5 })` → `true` (never seen)
  - `isUnread({ replyAt: 5, seenAt: 5 })` → `false` (same write)
  - `isUnread({ replyAt: 6, seenAt: 5 })` → `true`
  - `isUnread({ replyAt: 5, seenAt: 6 })` → `false`
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/shared/tests/unread.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement.** Add to `ChatMeta`:
  ```ts
  replyAt?: number // when an agent turn last ended with a reply or an error; absent = none since unread markers
  seenAt?: number // the user has seen the chat up to here (presence); absent = never marked
  ```
  `unread.ts`: `isUnread` = `replyAt !== undefined && replyAt > (seenAt ?? 0)`, with a one-line doc comment.
- [ ] **Step 4: Run** the test → PASS. Run `npm run typecheck` → clean.

---

### Task 2: `ChatStore.patchInPlace`

**Files:**
- Modify: `zumi-bot-server/backend/src/core/store/chatStore.ts` (next to `toggleReaction`)
- Test: `zumi-bot-server/backend/tests/core/chatStore.test.ts`

**Interfaces:**
- Produces: `patchInPlace(id: string, fn: (cur: ChatMeta) => Partial<Omit<ChatMeta, 'id' | 'updatedAt'>> | null): Promise<ChatMeta | null>`. Runs inside the store's `run` queue: reads the current meta, calls `fn`, writes `{ ...patch, updatedAt: cur.updatedAt }` through `updateLocked`. Resolves `null` with no write when the chat is gone or `fn` returns `null`.

- [ ] **Step 1: Write failing tests** in `chatStore.test.ts`, `describe('patchInPlace')`:
  - `'writes the patch and keeps updatedAt'`: create (clock 100), clock 200, `patchInPlace(id, () => ({ seenAt: 150 }))` → result `.seenAt === 150`, `.updatedAt === 100`; `get(id)` equal.
  - `'null from fn writes nothing'`: spy on the index file's mtime or `list()` before/after; result `null`, `fn` called with the current meta.
  - `'unknown chat resolves null'`: `patchInPlace('nope', fn)` → `null`, `fn` not called, no throw.
  - `'a concurrent update is not rolled back'`: clock 100 create; start `store.update(id, { title: 'x' })` at clock 300 and `patchInPlace(id, () => ({ seenAt: 1 }))` without awaiting between; after both, `get(id)` has `title 'x'`, `seenAt 1`, `updatedAt 300`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/chatStore.test.ts` → the new tests FAIL.
- [ ] **Step 3: Implement** `patchInPlace` as described.
- [ ] **Step 4: Run** the file → PASS.

---

### Task 3: `ReadMarks` service

**Files:**
- Create: `zumi-bot-server/backend/src/core/chat/readMarks.ts`
- Test: `zumi-bot-server/backend/tests/core/readMarks.test.ts`

**Interfaces:**
- Consumes: `ChatStore.patchInPlace` (Task 2); `isUnread` (Task 1); `TurnEnd` from `@zumibot/shared/notify`.
- Produces:
  ```ts
  export interface RoomTurnEnd extends TurnEnd { passed: boolean } // Task 4 imports it from here
  export interface ReadMarksDeps {
    store: Pick<ChatStore, 'patchInPlace'>
    lookingAt(chatId: string): boolean
    push(p: ChatPush): void
    now(): number
    log(line: string): void
  }
  export class ReadMarks {
    constructor(d: ReadMarksDeps)
    turnEnded(e: TurnEnd): Promise<void>        // ChatService's hook: ignores room chats (cur.group) and outcome 'stopped'
    roomTurnEnded(e: RoomTurnEnd): Promise<void> // GroupService's hook: ignores 'stopped' and passed
    started(chatId: string): Promise<void>      // presence onStarted: seenAt = now only when isUnread(cur)
    stopped(chatId: string): Promise<void>      // presence onStopped: seenAt = now only when cur.inFlight
  }
  ```
  Every method resolves (never rejects). A real write pushes `{ chatId, kind: 'meta', meta }`. A mark sets `replyAt = now` plus `seenAt = now` when `lookingAt(chatId)`, in one `patchInPlace`. A thrown store or push error is logged as `read marks: <turn end|room turn end|look start|look stop> failed` and swallowed (a throwing `log` is swallowed too, like `NotifyService.safeLog`).

- [ ] **Step 1: Write failing tests** with a real `ChatStore` in a `mkdtemp` dir, a fake clock, a `looking` set and a `pushes` array:
  - `'a reply marks the chat unread and pushes its meta'`: `turnEnded({ chatId, agent: 'a', outcome: 'ok' })` at clock 500 → stored `replyAt 500`, no `seenAt`, `updatedAt` unchanged, one `meta` push; `isUnread(meta)` true.
  - `'an error marks it too'`: outcome `'error'` → `replyAt` set.
  - `'a stopped turn changes nothing'`: outcome `'stopped'` → no write, no push.
  - `'a reply while someone looks is read at once'`: chat in `looking` → `replyAt 500`, `seenAt 500`, `isUnread` false.
  - `'ChatService turn ends for a room are ignored'`: a `createGroup` chat → `turnEnded` writes nothing.
  - `'a room reply marks the room'`: `roomTurnEnded({ chatId: room, agent: 'a', outcome: 'ok', passed: false })` → `replyAt` set.
  - `'a room pass changes nothing'`: `passed: true` → no write, no push.
  - `'started clears an unread chat'`: replyAt 500, clock 600, `started` → `seenAt 600`, push; `started` again → no second push.
  - `'started on a read chat writes nothing'`.
  - `'stopped stamps seenAt only while the chat runs'`: `inFlight: false` → nothing; `store.update(id, { inFlight: true })`, then `stopped` → `seenAt` = now, push.
  - `'a removed chat is ignored quietly'`: `store.remove(id)` then each method → resolves, no push, `log` not called.
  - `'a store failure is logged and swallowed'`: store stub whose `patchInPlace` rejects → method resolves, `log` called once with `'read marks: turn end failed'`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/readMarks.test.ts` → FAIL.
- [ ] **Step 3: Implement** `readMarks.ts` (one private `mark(what, chatId, fn)` that runs `patchInPlace`, pushes on a non-null result, and catches).
- [ ] **Step 4: Run** → PASS.

---

### Task 4: `GroupService` room turn hook

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/groupService.ts` (`GroupServiceDeps`; end of `endTurn`)
- Test: `zumi-bot-server/backend/tests/core/groupService.test.ts`

**Interfaces:**
- Consumes: `RoomTurnEnd` from `./readMarks` (Task 3).
- Produces: `GroupServiceDeps.onTurnEnd?(e: RoomTurnEnd): void`, doc comment: once per member turn, after its items are in the thread and saved; never for Compact; a throw never reaches the room. Fired at the end of `endTurn` (after the save `try`, before or inside the `finally` that calls `wake`), wrapped in `try {} catch {}`. `outcome`: `errored` → `'error'`, `replied` → `'ok'`, else `'stopped'`. `passed` is the existing `passed` local. Compact turns never reach `endTurn` with a reply; check that a compact run does not fire it (if it does, skip when compacting).

- [ ] **Step 1: Write failing tests** (add `roomEnds: RoomTurnEnd[]` to the `beforeEach`, `onTurnEnd: (e) => roomEnds.push(e)` on `svc`):
  - `'the room hook reports each member turn after its items are saved'`: `modAnswers = [seq('ui', 'ps')]`, send `'@ui check this'`, `idle` → `roomEnds` equals `[{ chatId, agent: 'ui', outcome: 'ok', passed: false }, { chatId, agent: 'ps', outcome: 'ok', passed: false }]`; inside the hook for `ui`, `store.loadItems(chatId)` already holds ui's reply (capture it in the callback).
  - `'a pass is reported as passed'`: as the existing `'a pass is hidden'` test (`scripts.ps = [{ text: '[[PASS]]' }]`) → the `ps` entry has `passed: true`.
  - `'a pass that kept its approval card is still passed'`: a `ps` script that asks for a tool approval (use the file's existing approval-script pattern) and then replies `[[PASS]]` → `passed: true`.
  - `'a failed member turn reports error'`: `scripts.ui = [<failing outcome as in the file's existing error tests>]` → `outcome: 'error'`.
  - `'a throwing hook does not break the room'`: hook throws → the room still goes idle and the reply is stored.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/groupService.test.ts` → the new tests FAIL.
- [ ] **Step 3: Implement** the hook.
- [ ] **Step 4: Run** the file → PASS.

---

### Task 5: Wire `ReadMarks` into the server

**Files:**
- Modify: `zumi-bot-server/backend/src/app.ts`

**Interfaces:**
- Consumes: `ReadMarks` (Task 3), `GroupServiceDeps.onTurnEnd` (Task 4), `Presence` options.

- [ ] **Step 1: Build `reads`** next to `notify`: `new ReadMarks({ store: chats, lookingAt: (c) => presence.lookingAt(c), push, now: () => Date.now(), log: (line) => console.error(line) })`. `push` is declared after `notify`; construct `reads` after `push`, and use a closure in the presence options (as the notify wiring does).
- [ ] **Step 2: Hook it up:** presence `onStarted: (c) => { notify.started(c); void reads.started(c) }`, `onStopped` likewise with `stopped`; `ChatService` `onTurnEnd: (e) => { notify.turnEnded(e); void reads.turnEnded(e) }`; `GroupService` deps `onTurnEnd: (e) => void reads.roomTurnEnded(e)`.
- [ ] **Step 3: Verify** `npm run typecheck` → clean; `npx vitest run --project backend` → all pass.

---

### Task 6: Sync keeps the later times

**Files:**
- Modify: `zumi-bot-server/deploy/sync.mjs` (`mergeChats`, `copyMeta`)
- Test: `zumi-bot-server/backend/tests/sync.test.ts`

**Interfaces:**
- Produces: in `mergeChats`, for a chat on both sides, the kept meta's `replyAt` and `seenAt` are each the larger of the two sides (absent < any number; both absent → field absent). `copyMeta` drops both fields.

- [ ] **Step 1: Write failing tests** in `sync.test.ts` (reuse its `meta(...)` helper):
  - `'mergeChats keeps the later replyAt and seenAt from either side'`: local `{ updatedAt: 900, replyAt: 10, seenAt: 50 }`, VPS `{ updatedAt: 100, replyAt: 40 }` → merged `replyAt 40`, `seenAt 50`, `updatedAt 900`.
  - `'both absent stays absent'`: neither side has the fields → merged meta has no `replyAt`/`seenAt` keys.
  - `'a kept copy starts read'`: a case that makes a copy (reuse an existing copy test's setup) with both fields set on the older side → the copy's meta has neither field.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/sync.test.ts` → the new tests FAIL.
- [ ] **Step 3: Implement** (a small `later(a, b)` helper; spread only defined fields).
- [ ] **Step 4: Run** → PASS.

---

### Task 7: Frontend unread state

**Files:**
- Create: `zumi-bot-server/frontend/src/state/unread.ts`
- Modify: `zumi-bot-server/frontend/src/state/messageGroups.ts` (add `rowIndexOf`)
- Test: `zumi-bot-server/frontend/tests/unread.test.ts`, `zumi-bot-server/frontend/tests/messageGroups.test.ts`

**Interfaces:**
- Consumes: `isUnread` (Task 1).
- Produces (`state/unread.ts`):
  ```ts
  type Marks = Pick<ChatMeta, 'replyAt' | 'seenAt'>
  export function agentHasUnread(chats: readonly (Marks & Pick<ChatMeta, 'agentName'>)[], agentName: string): boolean
  export function unreadElsewhere(chats: readonly (Marks & Pick<ChatMeta, 'id'>)[], openChatId: string | null): boolean
  export function anyUnread(chats: readonly Marks[]): boolean
  /** Where the New line starts when a chat opens: its seenAt if unread and ever seen, else null (no line). */
  export function sinceOnOpen(chat: Marks): number | null
  /** A held line stays; else the open chat going unread -> read sets it from the seenAt before the read. */
  export function sinceOnChange(since: number | null, prev: Marks, next: Marks): number | null
  /** Id of the first item after `since` that is not the user's (and is shown: not a 'kept' notice); null = no line. */
  export function newLineItem(items: readonly ChatItem[], since: number | null): string | null
  ```
  `messageGroups.ts`: `export function rowIndexOf(rows: readonly MessageRow[], itemId: string): number` (the row holding that item, else -1).

- [ ] **Step 1: Write failing tests:**
  - `agentHasUnread`: true only for a chat of that agent with `replyAt > seenAt`; group chats (`agentName ''`) never count for an agent.
  - `unreadElsewhere`: the open chat's own unread does not count; another's does; `null` open id counts all.
  - `sinceOnOpen`: `{ replyAt: 9, seenAt: 5 }` → `5`; `{ replyAt: 9 }` → `null`; `{ replyAt: 5, seenAt: 9 }` → `null`.
  - `sinceOnChange`: held `5` stays `5` whatever prev/next; `null` with prev `{replyAt: 9, seenAt: 5}` → next `{replyAt: 9, seenAt: 12}` gives `5` (**the idle case**); `null` with prev read → `null`; `null` with prev unread and never seen (`{replyAt: 9}`) → `null`; `null` with prev unread → next still unread → `null` (**the server's read not landed yet does not set it early**).
  - `newLineItem`: items `[user ts 1, assistant ts 3, user ts 7, tool ts 8, assistant ts 9]`, since `5` → the tool's id; since `null` → `null`; since `20` → `null`; a `notice` of kind `'kept'` at ts 6 is skipped; an `error` item qualifies.
  - `rowIndexOf`: an item inside an agent group returns that group's index; an unknown id → -1.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/frontend/tests/unread.test.ts zumi-bot-server/frontend/tests/messageGroups.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.

---

### Task 8: Sidebar, phone bar and Agents tab markers

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/Sidebar.tsx` (`chatStatus`, `chatRow`, `groupRow`, agent row badge near line 463, section toggle near line 584)
- Modify: `zumi-bot-server/frontend/src/components/MobileBar.tsx` (new prop `unread: boolean`)
- Modify: `zumi-bot-server/frontend/src/components/SidebarFoot.tsx` (new prop `chatsUnread: boolean`)
- Modify: `zumi-bot-server/frontend/src/App.tsx` (pass the two props)
- Modify: `zumi-bot-server/frontend/src/styles.css`

**Interfaces:**
- Consumes: `isUnread`, `agentHasUnread`, `unreadElsewhere`, `anyUnread` (Tasks 1, 7).
- DOM hooks the e2e uses: `data-testid="unread-dot"` (chat and group rows), `agent-unread-dot`, `section-unread-dot`, `nav-unread-dot`, `mode-unread`; rows get class `unread`.

- [ ] **Step 1: Rows.** `chatRow`/`groupRow` add class `unread` when `isUnread(chat)`. `chatStatus`: approval badge, else spinner, else when unread `<span className="unread-dot" role="status" aria-label="Unread" data-testid="unread-dot" />`.
- [ ] **Step 2: Rollups.** Collapsed agent row: when no approval badge shows and `agentHasUnread(p.chats, agent.name)`, `<span className="unread-dot" role="status" aria-label="Unread chats" title="Unread chats" data-testid="agent-unread-dot" />`. Collapsed section: same rule over `entries` with an `entryUnread` beside `entryPending` (group → `isUnread(e.row.chat)`, agent → `agentHasUnread`), `data-testid="section-unread-dot"`.
- [ ] **Step 3: Phone bar and tab.** `MobileBar`: when `!pending && unread`, `<span className="unread-dot nav-badge" role="status" aria-label="Unread messages in another chat" data-testid="nav-unread-dot" />`. App passes `unread={unreadElsewhere(chats, openChatMeta?.id ?? null)}`. `SidebarFoot`: on the Agents tab, `{p.mode === 'routines' && p.chatsUnread && <span className="mode-unread" data-testid="mode-unread" title="Unread chats" />}`; App passes `chatsUnread={anyUnread(chats)}`.
- [ ] **Step 4: CSS.** `.unread-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: color-mix(in srgb, var(--fg) 60%, transparent); }`; `.mode-unread` like `.mode-waiting` with the same neutral background; `.row.chat-item.unread, .row.chat-item.on.unread { color: var(--fg); font-weight: 600; }`; `.group-row.unread .group-title { color: var(--fg); }`. Check light and dark both read as neutral, not accent.
- [ ] **Step 5: Verify** `npm run typecheck` and `npx vitest run --project frontend` → clean.

---

### Task 9: The New line in the chat

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/ChatView.tsx`
- Modify: `zumi-bot-server/frontend/src/components/MessageList.tsx`
- Modify: `zumi-bot-server/frontend/src/styles.css`

**Interfaces:**
- Consumes: `sinceOnOpen`, `sinceOnChange`, `newLineItem` (Task 7), `rowIndexOf` (Task 7).
- Produces: `MessageList` prop `newLineBefore: string | null` (an item id). DOM hook `data-testid="new-line"`.

- [ ] **Step 1: ChatView state.** `ChatView` is keyed by chat id, so it remounts per chat. `const [since, setSince] = useState(() => sinceOnOpen(chat))`; keep the previous `chat` in a ref and on each new `chat` object `setSince((s) => sinceOnChange(s, prevRef.current, chat))`. Wrap `onSend`, `onContinue` and `onExplain` so each also `setSince(null)`. Pass `newLineBefore={newLineItem(state.items, since)}` to `MessageList`.
- [ ] **Step 2: Render.** In `MessageList`, `const lineAt = newLineBefore === null ? -1 : rowIndexOf(rows, newLineBefore)`; before `rows[lineAt]` render `<div className="divider new-line" role="separator" data-testid="new-line"><span>New</span></div>` (a `Fragment` with the row's key). The line sits above the row holding the item: when that item is inside an agent group, above the whole group. That is a small deviation from the spec's "first agent item" for half-watched replies, accepted to avoid splitting a group.
- [ ] **Step 3: Scroll.** When the list first lays out with a line, scroll it near the top (`line.offsetTop` minus the list's top padding) instead of the bottom, and set `stick` from the resulting position. Later renders keep today's behaviour. If the line's item is not in the loaded page, there is no line element and the list opens at the bottom as today.
- [ ] **Step 4: CSS.** `.divider.new-line { color: var(--fg); font-weight: 600; }` (the line in `--border` stays).
- [ ] **Step 5: Verify** `npm run typecheck`, `npx vitest run --project frontend` → clean.

---

### Task 10: E2E, scripts and docs

**Files:**
- Create: `zumi-bot-server/e2e/unread.e2e.mjs`
- Modify: `package.json` (root `scripts`)
- Modify: `CLAUDE.md`

- [ ] **Step 1: Script.** Root `package.json`: `"e2e:unread": "npm run build && node zumi-bot-server/e2e/unread.e2e.mjs"`, next to `e2e:notifications`.
- [ ] **Step 2: Write the e2e** on the fake claude (`start({ fake: true, ... })` from `harness.mjs`), modeled on `notifications.e2e.mjs` (header comment, temp dirs, `finally` cleanup, 3 min overall timeout, `unexpectedErrors`). Look at how that file makes a page visible and focused (`document.hasFocus()`, around line 216). Scenario:
  Messages to a chat nobody is on go by a raw `/ws` RPC `chats:send` (the way `notifications.e2e.mjs` makes raw `/ws` calls), so no page looks at it.
  1. One agent, two chats A and B. Page 1 on A (visible, focused, recent input). Page 2 open on the empty view.
  2. Raw-send in B; the fake claude replies. Page 1's B row gets `unread-dot` and class `unread`; `chats.json` has B's `replyAt` and no `seenAt`.
  3. Page 2 also shows B's `unread-dot`.
  4. Page 1 opens B: the dot is gone on both pages; no `new-line` (B was never seen, so all of it is new).
  5. Page 1 goes back to A. Raw-send in B again; after the reply, page 1 opens B: `new-line` shows, directly above the second reply's group.
  6. Page 1 sends in A and stays on it: after A's reply lands, A never shows `unread-dot` (keep checking for 2 s).
- [ ] **Step 3: Run** `npm run e2e:unread` → passes. Then run `npm run e2e:notifications` → still passes (presence wiring changed).
- [ ] **Step 4: CLAUDE.md.** Under Commands, add `e2e:unread` to the fake-claude list ("uses only the fake claude, so it costs no quota"). Under Architecture, add a short **Unread markers** paragraph: `ChatMeta.replyAt`/`seenAt`, `ReadMarks` (`core/chat/readMarks.ts`) fed by `ChatService.onTurnEnd` (single chats), `GroupService`'s `onTurnEnd` (rooms; a pass never marks), presence `onStarted`/`onStopped`; writes keep `updatedAt` via `ChatStore.patchInPlace`; `sync.mjs` keeps the later of each time, copies start read; UI in `state/unread.ts`; spec path.

---

### Final verification

- [ ] `npm test` → all pass (baseline was 2833 passed, 1 skipped).
- [ ] `npm run typecheck` → clean.
- [ ] `npm run e2e:unread` and `npm run e2e:notifications` → pass.
- [ ] Kill any Chrome or server processes the e2e runs left behind.
- [ ] Do not commit. Report the changed files to the user.
