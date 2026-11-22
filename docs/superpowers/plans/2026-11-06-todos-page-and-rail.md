# Icon Rail and To-dos Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A vertical icon rail replaces the sidebar footer, and its new To-dos entry opens a page listing every chat's open to-dos, with a message box that sends into the selected chat and shows only the exchange it starts.

**Architecture:** The server keeps an in-memory overview (open count and oldest open time per chat), fed by a listener on every write of a `chats/<id>.todos.json` file and served by one new RPC. The client draws the rail and the page from that overview and the chat list, reuses the to-do list parts of the side panel, and reuses `ChatView` in a new "exchange" mode for the message box. All page rules are pure functions in `frontend/src/state/todosPage.ts`.

**Tech Stack:** TypeScript, Node 22 backend, React 19 frontend, vitest, `playwright-core` e2e with the fake claude.

**Spec:** `docs/superpowers/specs/2026-11-06-todos-page-and-rail-design.md`

## Global Constraints

- Do not commit. The user commits themself (their global rule). Leave changes in the working tree.
- Dependencies stay as they are: no new packages.
- `TodoService` and `ChatStore.updateTodos` stay the only writers of to-do items. `todos:changed` keeps firing as today; clients refetch on every event and never dedupe by rev.
- No new data files and no change to `deploy/sync.mjs`. The overview is derived from the existing to-dos files.
- CSP unchanged. Comments short and say why.
- New RPC touches exactly `ZumiBotApi` (`shared/src/types.ts`), `rpc/handlers.ts` (argument checks), `frontend/src/net/api.ts`, and the method list in `backend/tests/rpc/handlers.test.ts`.
- Frontend logic goes in pure modules under `frontend/src/state/` (there are no component tests).
- Keep these `data-testid`s on their new homes so existing e2e suites keep working: `mode-tab-agents`, `mode-tab-routines` (rail buttons, with `aria-pressed`), `mode-unread`, `mode-waiting`, `sidebar-user` (the rail's Usage button), `usage-popover`, `account-name`, `account-email`, `usage-see-all`, `archived-open` (rail Archived), `settings-open` (rail Settings).
- Exact values from the spec: amber after 3 days; badge `99+` above 99; badge hidden at 0; Undo 6 s; Done shows newest 100 then Show more; Ask inserts `> <text>` plus a new line and never sends.
- Run tests from the repo root.

## Review Focus

1. **A corrupt or unreadable to-dos file at server start** must not stop the overview build or the server: that chat is left out, the others are listed. (Test in Task 1.)
2. **The selected chat is deleted (here or on another device) while `/todos/<id>` is open:** the page falls back to the top row on a wide screen, or to nothing on a phone, and the address follows. (Test `pickSelected` in Task 2.)
3. **The socket drops and reconnects, or another device changes the list,** while the page is open: the badge and counts must not go stale. (`useTodosOverview` refetches whenever `connected` turns true, Task 5; Task 7 step 6 ticks from a second browser context and checks the first page updates without a reload; the reconnect path is checked by hand in Task 5 Step 4 by restarting the server.)
4. **Sending from the page to a chat that is already running:** the message queues (tasks tray shows it) and the exchange shows nothing from the running reply; it starts at the sent message once it lands. (Test `exchangeItems` with an id not yet present in Task 2; e2e in Task 7.)
5. **Ask when the box already holds text, or holds text ending without a new line:** the quote goes on its own line and the existing text is kept. (Test `askQuote` in Task 2.)

---

### Task 1: Server overview of open to-dos

**Files:**
- Modify: `zumi-bot-server/shared/src/todos.ts` (add `TodoOverviewEntry`, `overviewOf`)
- Modify: `zumi-bot-server/backend/src/core/store/chatStore.ts` (add `setTodosListener`; call it in `saveTodosRaw` callers and `remove`)
- Create: `zumi-bot-server/backend/src/core/todos/todoOverview.ts`
- Modify: `zumi-bot-server/backend/src/app.ts` (build it, wire the listener, pass to handlers)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (`HandlerDeps.todoOverview`, `'todos:overview'`)
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.todos.overview`)
- Modify: `zumi-bot-server/frontend/src/net/api.ts` (`overview: () => call('todos:overview')`)
- Test: `zumi-bot-server/shared/tests/todos.test.ts`, `zumi-bot-server/backend/tests/core/chatStore.test.ts`, `zumi-bot-server/backend/tests/core/todoOverview.test.ts` (new), `zumi-bot-server/backend/tests/rpc/handlers.test.ts`

**Interfaces:**
- Produces (shared): `interface TodoOverviewEntry { chatId: string; open: number; oldestAt: number }`; `overviewOf(f: TodoFile): { open: number; oldestAt: number } | null` (open = not done and not removed; `oldestAt` = smallest `from.at` among open; null when none open).
- Produces (store): `ChatStore.setTodosListener(fn: ((chatId: string, file: TodoFile | null) => void) | null): void`. Called after every to-dos file write with the written file, and after `remove(id)` with `null`. Not called when `updateTodos`'s `fn` returns its input. A throwing listener never fails the write.
- Produces (backend): `class TodoOverview { constructor(store: Pick<ChatStore, 'list' | 'loadTodos'>, log: (line: string) => void); build(): Promise<void>; apply(chatId: string, file: TodoFile | null): void; list(): TodoOverviewEntry[] }`. `list()` is sorted by `oldestAt` ascending, then `chatId`.
- Produces (API): `api.todos.overview(): Promise<TodoOverviewEntry[]>`; RPC `'todos:overview'` takes no arguments.

- [ ] **Step 1: Write the failing tests**

`shared/tests/todos.test.ts`:
```ts
it('overviewOf counts open items and finds the oldest', () => {
  // build a file with addTodos at at=100 ('a') and at=50 ('b'), then a third at=10 that is ticked, a fourth at=5 removed
  expect(overviewOf(file)).toEqual({ open: 2, oldestAt: 50 })
})
it('overviewOf is null when nothing is open', () => {
  expect(overviewOf(emptyTodos())).toBeNull()
  expect(overviewOf(allTickedOrRemoved)).toBeNull()
})
```

`backend/tests/core/chatStore.test.ts`, new `describe('todos listener')`:
```ts
it('tells every write and a removal', async () => {
  const s = mk(); const c = await s.create('alpha', '/a'); const seen: [string, number | null][] = []
  s.setTodosListener((id, f) => seen.push([id, f ? f.rev : null]))
  await s.updateTodos(c.id, (f) => addTodos(f, [{ text: 'x' }], 'user', src, 1, () => 't1').file)
  await s.updateTodos(c.id, (f) => f) // no change, no call
  await s.remove(c.id)
  expect(seen).toEqual([[c.id, 1], [c.id, null]])
})
it('a throwing listener never fails the write', async () => { /* listener throws; updateTodos resolves; file on disk */ })
```

`backend/tests/core/todoOverview.test.ts` (real `ChatStore` in a mkdtemp dir, as `todoService.test.ts` does):
```ts
it('build reads every chat with open items, oldest first', async () => {
  // chat A: open items at 300 and 200; chat B: open item at 100; chat C: only ticked items; chat D: no file
  await ov.build()
  expect(ov.list()).toEqual([{ chatId: B, open: 1, oldestAt: 100 }, { chatId: A, open: 2, oldestAt: 200 }])
})
it('apply follows a write and a removal', async () => { /* apply(A, fileWithOneOpen) then apply(A, null) */ })
it('a write during build wins over the stale read', async () => {
  // start build(); before awaiting it, store.updateTodos ticks A's last item with the listener wired to ov.apply
  // after build resolves, A is absent
})
it('a corrupt to-dos file leaves that chat out and keeps the rest', async () => {
  // write '{not json' to <dir>/chats/<A>.todos.json; B valid
  await ov.build()
  expect(ov.list().map((e) => e.chatId)).toEqual([B])
})
it('a read that throws is logged by chat id only and skipped', async () => {
  // store stub whose loadTodos rejects for one id; log receives a line containing that id and no item text
})
```

`backend/tests/rpc/handlers.test.ts`: add `'todos:overview'` to the method list; add
```ts
it('todos:overview returns the overview list', async () => {
  expect(await h['todos:overview']()).toEqual([{ chatId: 'c1', open: 2, oldestAt: 5 }])
})
```
(deps get `todoOverview: { list: () => [{ chatId: 'c1', open: 2, oldestAt: 5 }] }`).

- [ ] **Step 2: Run the tests and see them fail**

Run: `npx vitest run zumi-bot-server/shared/tests/todos.test.ts zumi-bot-server/backend/tests/core/chatStore.test.ts zumi-bot-server/backend/tests/core/todoOverview.test.ts zumi-bot-server/backend/tests/rpc/handlers.test.ts`
Expected: FAIL (`overviewOf` / `setTodosListener` / `TodoOverview` / `todos:overview` not defined).

- [ ] **Step 3: Implement**

- `overviewOf` in `shared/src/todos.ts` beside `openTodos`.
- `setTodosListener` in `ChatStore`, modelled on `setItemsListener`: one private `todosListener` field; call it after `saveTodosRaw` returns in `updateTodos` and in `renameAgent`'s todos rewrite, and after the `fs.rm` of the todos file in `remove`. Wrap each call in try/catch.
- `TodoOverview`: a `Map<string, {open, oldestAt}>` plus a `touched: Set<string>` filled by `apply` while `build` runs; `build` loads each chat from `store.list()` with `store.loadTodos`, skips ids in `touched`, catches per chat and logs `todo overview: skipped <chatId>` (never item text).
- `app.ts`: right after `chats` (the `ChatStore`) exists and before the hub serves RPCs: `const todoOverview = new TodoOverview(chats, (l) => console.error(l)); chats.setTodosListener((id, f) => todoOverview.apply(id, f)); await todoOverview.build()`. Pass `todoOverview` to the handler deps next to `todos`.
- Handler: `'todos:overview': () => d.todoOverview.list()`; `HandlerDeps.todoOverview: Pick<TodoOverview, 'list'>`.
- `ZumiBotApi.todos.overview(): Promise<TodoOverviewEntry[]> // every chat with an open item, oldest first`; map it in `net/api.ts`.

- [ ] **Step 4: Run the tests and see them pass**

Run: the Step 2 command, then `npm run typecheck`.
Expected: PASS, no type errors.

---

### Task 2: Pure page rules and routes

**Files:**
- Create: `zumi-bot-server/frontend/src/state/todosPage.ts`
- Modify: `zumi-bot-server/frontend/src/state/route.ts` (add `todosFromPath`, `todosPath`)
- Modify: `zumi-bot-server/frontend/src/state/usage.ts` (add `sessionPercent`)
- Test: `zumi-bot-server/frontend/tests/todosPage.test.ts` (new), `zumi-bot-server/frontend/tests/route.test.ts`, the existing usage test file in `frontend/tests/`

**Interfaces:**
- Consumes: `TodoOverviewEntry` (Task 1); `listedChats` from `state/unread.ts`; `TodoItem`, `ChatItem`, `ChatMeta`, `AgentSummary`, `ClaudeAccount`.
- Produces (`state/todosPage.ts`):
  - `interface TodoColumnRow { chat: ChatMeta; open: number; oldestAt: number }`
  - `todosColumn(overview: TodoOverviewEntry[], chats: ChatMeta[], agents: Pick<AgentSummary, 'name'>[]): TodoColumnRow[]` — joins by chat id, drops ids with no chat and single chats whose agent is gone (same rule as `listedChats`), keeps archived chats, orders by `oldestAt` then chat id.
  - `stickyRows(prev: TodoColumnRow[], next: TodoColumnRow[]): TodoColumnRow[]` — `next` plus every `prev` row missing from it with `open: 0` and its old `oldestAt`, same order rule; a prev row whose chat is gone from `next` and was deleted is the caller's to drop (it passes `prev` filtered to existing chats).
  - `badgeText(rows: TodoColumnRow[]): string | null` — sum of `open`; null at 0; `'99+'` above 99.
  - `ageLabel(at: number, now: number): string` — whole days elapsed: 0 → `'today'`, 1 → `'1 day'`, n → `` `${n} days` ``.
  - `isOld(at: number, now: number): boolean` — more than 3 days (`3 * 86_400_000` ms) elapsed.
  - `openOldestFirst(items: TodoItem[]): TodoItem[]` — open items (not done, not removed) sorted by `from.at`, then id.
  - `exchangeItems(items: ChatItem[], fromId: string | null): ChatItem[]` — `[]` when `fromId` is null or not in `items`; otherwise `items` from that id onward.
  - `askQuote(draft: string, text: string): string` — appends `> ${text}\n`, on a new line when `draft` is non-empty and does not end in `\n`.
  - `pickSelected(rows: TodoColumnRow[], wanted: string | null, chats: ChatMeta[], wide: boolean): string | null` — `wanted` when that chat still exists (listed or not in rows); else on a wide screen the first row's chat id, else null.
- Produces (`state/route.ts`): `todosFromPath(pathname: string): { chatId: string | null } | null` and `todosPath(chatId: string | null): string` for `/todos` and `/todos/<id>`, same decoding and rejection rules as `archivedFromPath`.
- Produces (`state/usage.ts`): `sessionPercent(account: ClaudeAccount | null, now: number): number | null` — `percentUsed` of `account.usage.session`, null when unknown.

- [ ] **Step 1: Write the failing tests**

```ts
describe('todosColumn', () => {
  it('lists chats oldest leftover first, keeps archived and rooms, drops gone agents and unknown ids', () => {
    // overview: [{x, 2, 300}, {room, 1, 100}, {arch, 1, 200}, {orphan(agent gone), 1, 50}, {missing id, 1, 10}]
    expect(todosColumn(ov, chats, agents).map((r) => r.chat.id)).toEqual(['room', 'arch', 'x'])
  })
})
describe('stickyRows', () => {
  it('keeps a cleared row at 0 in its place', () => {
    expect(stickyRows([row('a', 1, 100), row('b', 2, 200)], [row('b', 2, 200)])).toEqual([row('a', 0, 100), row('b', 2, 200)])
  })
})
describe('badgeText', () => {
  it('sums, hides at 0, caps at 99+', () => {
    expect(badgeText([])).toBeNull()
    expect(badgeText([row('a', 0, 1)])).toBeNull()
    expect(badgeText([row('a', 2, 1), row('b', 4, 2)])).toBe('6')
    expect(badgeText([row('a', 99, 1)])).toBe('99')
    expect(badgeText([row('a', 100, 1)])).toBe('99+')
  })
})
describe('ages', () => {
  const DAY = 86_400_000
  it('labels whole days', () => {
    expect(ageLabel(1000, 1000 + DAY - 1)).toBe('today')
    expect(ageLabel(0, DAY)).toBe('1 day')
    expect(ageLabel(0, 4 * DAY + 5)).toBe('4 days')
  })
  it('is old past 3 days', () => {
    expect(isOld(0, 3 * DAY)).toBe(false)
    expect(isOld(0, 3 * DAY + 1)).toBe(true)
  })
})
it('openOldestFirst drops ticked and removed, oldest first', () => { /* ids in order */ })
describe('exchangeItems', () => {
  it('is empty before a send and while the sent id has not landed', () => {
    expect(exchangeItems(items, null)).toEqual([])
    expect(exchangeItems(items, 'not-yet')).toEqual([])
  })
  it('starts at the sent message', () => {
    expect(exchangeItems([u1, a1, u2, a2], 'u2')).toEqual([u2, a2])
  })
})
describe('askQuote', () => {
  it('quotes into an empty box', () => expect(askQuote('', 'Check sync')).toBe('> Check sync\n'))
  it('keeps typed text and starts a new line', () => expect(askQuote('Please', 'Check sync')).toBe('Please\n> Check sync\n'))
  it('adds no blank line after a new line', () => expect(askQuote('Please\n', 'Check sync')).toBe('Please\n> Check sync\n'))
})
describe('pickSelected', () => {
  it('keeps a wanted chat that exists, even with nothing open', () => expect(pickSelected(rows, 'zero', chats, true)).toBe('zero'))
  it('falls back to the top row on a wide screen when the wanted chat is gone', () => expect(pickSelected(rows, 'deleted', chats, true)).toBe(rows[0].chat.id))
  it('falls back to nothing on a phone', () => expect(pickSelected(rows, 'deleted', chats, false)).toBeNull())
  it('picks nothing when there are no rows', () => expect(pickSelected([], null, chats, true)).toBeNull())
})
```

`route.test.ts`:
```ts
it('reads /todos and /todos/<id>', () => {
  expect(todosFromPath('/todos')).toEqual({ chatId: null })
  expect(todosFromPath('/todos/a%20b')).toEqual({ chatId: 'a b' })
  for (const p of ['/todos/', '/todos/a/b', '/todo', '/todos/%E0%A4%A', '/']) expect(todosFromPath(p)).toBeNull()
  expect(todosPath(null)).toBe('/todos')
  expect(todosPath('a b')).toBe('/todos/a%20b')
})
```

Usage test: `sessionPercent(null, now)` is null; an account without `usage.session` is null; one with a session window gives the same number as `percentUsed`.

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project frontend zumi-bot-server/frontend/tests/todosPage.test.ts zumi-bot-server/frontend/tests/route.test.ts`
Expected: FAIL (module / exports missing).

- [ ] **Step 3: Implement the functions above** in the files named, no React imports.

- [ ] **Step 4: Run them and see them pass**

Run: the Step 2 command plus the usage test file.
Expected: PASS.

---

### Task 3: Shared to-do list parts

No behaviour change: the side panel's To-dos view keeps working exactly as today, and the To-dos page (Task 5) reuses the same parts.

**Files:**
- Create: `zumi-bot-server/frontend/src/components/TodoParts.tsx`
- Modify: `zumi-bot-server/frontend/src/components/TodosPanel.tsx` (use the parts)

**Interfaces:**
- Produces (`TodoParts.tsx`):
  - `TodoRow` (moved as is; add an optional `extra?: ReactNode` drawn after the text, used by the page for age and Ask).
  - `useTodoActions(chatId: string, onRefresh: () => void): { error: string | null; tick(item: TodoItem): Promise<void>; remove(item: TodoItem): Promise<void>; undo: string[] | null; restore(ids: string[]): Promise<void>; draft: string; setDraft(s: string): void; dupe: boolean; add(): Promise<void> }` — the logic now inside `TodosPanel` (the 6 s Undo timer, grouping close removals into one toast, the add guard and duplicate note, clearing draft/dupe/error when `chatId` changes).
  - `TodoAddForm({ actions }: { actions: ReturnType<typeof useTodoActions> })`, `TodoDoneSection({ done, room, onTick, onRemove })` (owns the per-device open state under the same `zumibot.todos.doneOpen` key and Show more via `doneShown`), `TodoUndoToast({ actions })`.
  - Every `data-testid` stays as today (`todo-row`, `todo-check`, `todo-text`, `todo-by`, `todo-remove`, `todo-add`, `todo-add-input`, `todo-add-button`, `todo-add-note`, `todo-done`, `todo-done-toggle`, `todo-done-more`, `todo-toast`, `todo-undo`, `todos-error`).

- [ ] **Step 1: Move the code** from `TodosPanel.tsx` into `TodoParts.tsx` as above; `TodosPanel` keeps its header, groups, Show in chat, focus scrolling and empty/failed notes.

- [ ] **Step 2: Verify nothing changed**

Run: `npm run typecheck && npm run e2e:todos`
Expected: typecheck clean; `e2e:todos` passes (fake claude, no quota).

---

### Task 4: The rail replaces the sidebar footer

**Files:**
- Create: `zumi-bot-server/frontend/src/components/Rail.tsx`
- Modify: `zumi-bot-server/frontend/src/components/AccountMenu.tsx` (becomes the Usage popover body; trigger is the rail's ring)
- Modify or delete: `zumi-bot-server/frontend/src/components/SidebarFoot.tsx` (the footer has nothing left; remove it and the `foot` props of `Sidebar` and `RoutinesSidebar` if they end up empty)
- Modify: `zumi-bot-server/frontend/src/App.tsx` (render `<Rail>` as the first child of `.shell`; drop `sidebarFoot`)
- Modify: `zumi-bot-server/frontend/src/styles.css` (rail column; phone drawer)

**Interfaces:**
- Consumes: `sessionPercent` (Task 2), `percentUsed` etc. already used by `AccountMenu`, `RailMode`.
- Produces: `type RailEntry = 'agents' | 'routines' | 'todos' | 'archived' | 'settings'`;
  `Rail(p: { active: RailEntry; open: boolean; agentsPending: boolean; agentsUnread: boolean; routinesWaiting: boolean; todosBadge?: string | null; account: ClaudeAccount | null; claudeFound: boolean | undefined; onAccountOpen(): void; onAgents(): void; onRoutines(): void; onTodos?: () => void; onArchived(): void; onSettings(): void; onUsageDetails(): void })`.
  In this task `onTodos` is not yet passed: render the To-dos button only when `onTodos` is given (Task 5 passes it), so this task ships on its own.

- [ ] **Step 1: Build `Rail.tsx`**

- `<nav className="rail" data-testid="rail" aria-label="Main">`. Top: the logo `<img src="/favicon.png" alt="" class="rail-logo">` (not a button); then Agents (`data-testid="mode-tab-agents"`, `aria-pressed`, `title="Agents"`), Routines (`mode-tab-routines`), To-dos (`rail-todos`, count in `<span data-testid="rail-todos-count">` only when `todosBadge !== null`), Archived (`archived-open`). Bottom (pushed down with a flex spacer): Usage (`sidebar-user`) and Settings (`settings-open`).
- Agents shows the approval badge when `agentsPending` (class `approval-badge compact`, `data-testid="rail-agents-approval"`), else `mode-unread` dot when `agentsUnread` and Agents is not active, as `SidebarFoot` does today. Routines shows `mode-waiting` when `routinesWaiting`.
- Icons: the two `ModeIcon` drawings from `SidebarFoot`, plus a check-list glyph for To-dos, an archive-box glyph (reuse `MenuIcon name="archive"`) and a gear (reuse `MenuIcon name="settings"`).
- Each button has an `aria-label` equal to its title. `aria-current="page"` on the active entry.

- [ ] **Step 2: Turn `AccountMenu` into the Usage popover**

- Trigger: a ring button (`sidebar-user`, `aria-label="Usage"`) drawn as a conic ring filled to `sessionPercent` (empty when null), with a red dot `data-testid="claude-missing"` when `claudeFound === false`.
- Popup (`usage-popover`) opens beside the rail, aligned to its bottom. Its head keeps name and email and adds the status line (`Online` / `Claude not found`) that the old trigger showed. Remove **Archived…** and **Settings…**; add **Usage details** (`data-testid="usage-details"`) calling `onUsageDetails` and closing. Keep **See all** to `USAGE_PAGE_URL`.

- [ ] **Step 3: Wire it in `App.tsx`**

- `active`: `settings !== null ? 'settings' : archive ? 'archived' : mode`.
- `onAgents` / `onRoutines`: through `navigate`, close Settings and Archived, then `switchMode`. `onArchived` = `openArchived`; `onSettings` = `openSettings('general', null, true)`; `onUsageDetails` = `openSettings('usage')`.
- `agentsPending = pendingElsewhere(approvals, null)` and `agentsUnread = anyUnread(listedChats(live, agents))`, the values the footer and mobile bar use today.
- Remove `sidebarFoot` and the footer CSS that is no longer used.

- [ ] **Step 4: CSS**

- `.shell` gets the rail as its first column (`--rail-w: 52px`), colors from the existing tokens only (`--bg-sidebar`, `--bg-selected`, `--fg-muted`, `--border`, `--accent`, `--error`), light and dark both.
- Below the existing narrow breakpoint (`NARROW_QUERY`), the rail is hidden unless the drawer is open; then it is fixed at the left edge and the open drawer is offset by `--rail-w`, so rail and column slide in together. Pass `open={navOpen}` and add the class from it.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm test`
Then: `npm run e2e:archive`, `npm run e2e:routines`, `npm run e2e:commands`, `npm run e2e:notifications`, `npm run e2e:auth`, `npm run e2e:resilience`
Expected: all pass. A failure caused by the old click path (open account, then click an item inside it) is fixed in that suite by clicking the rail button directly; nothing else in the suites changes.
Then run the app (`npm run dev`, or the `run` skill) and check by eye at desktop width and at 375 px, light and dark: rail order, ring, popover, Usage details lands on Settings › Usage, drawer shows rail plus column.

---

### Task 5: The To-dos page (column, list, route, badge)

**Files:**
- Create: `zumi-bot-server/frontend/src/useTodosOverview.ts`
- Create: `zumi-bot-server/frontend/src/components/TodosNav.tsx`
- Create: `zumi-bot-server/frontend/src/components/TodosPage.tsx`
- Modify: `zumi-bot-server/frontend/src/App.tsx`
- Modify: `zumi-bot-server/frontend/src/styles.css`

**Interfaces:**
- Consumes: `api.todos.overview` (Task 1); everything in `state/todosPage.ts` and `todosFromPath`/`todosPath` (Task 2); `TodoRow`, `useTodoActions`, `TodoAddForm`, `TodoDoneSection`, `TodoUndoToast` (Task 3); `Rail` with `onTodos`/`todosBadge` (Task 4); `useTodos(chatId, connected)` (exists).
- Produces:
  - `useTodosOverview(connected: boolean, chatIds: string): TodoOverviewEntry[] | null` — fetches on connect, refetches on every `todos:changed` (debounced 300 ms, trailing) and whenever `chatIds` (the sorted ids joined, so a fork, delete or new chat is seen) changes; ignores an answer older than the latest request.
  - `TodosNav(p: { open: boolean; onClose(): void; rows: TodoColumnRow[]; agents: AgentSummary[]; selectedChatId: string | null; pendingByChat: Record<string, number>; onOpenChat(chatId: string): void })` — rows: icon (agent `BotIcon` or room `MemberStack`), title, `Archived` tag when `isArchived`, count, a spinner instead of the count while `chat.inFlight`, the approval badge when `pendingByChat[id] > 0`; empty state `No open to-dos.` (`data-testid="todos-page-empty"`). Row testid `todos-nav-row` with `data-chat-id`, count testid `todos-nav-count`.
  - `TodosPage(p: { chat: ChatMeta; agents: AgentSummary[]; items: TodoItem[] | null; failed: boolean; onRetry(): void; onRefresh(): void; now: number; waiting: boolean; onOpenChat(): void; onAsk: ((text: string) => void) | null; children?: ReactNode })` — `onAsk` null hides Ask (read-only chats); `children` is the message box area added in Task 6.
- App state: `const [todosPage, setTodosPage] = useState<{ chatId: string | null } | null>(loadedAtTodos)` where `loadedAtTodos = todosFromPath(location.pathname)` read at load like `loadedAtArchived`.

- [ ] **Step 1: `useTodosOverview`** as specified.

- [ ] **Step 2: `TodosNav` and `TodosPage`**

- Page header: title, the agent name or member names, `N open` (`data-testid="todos-page-count"`), `Waiting for you` (`data-testid="todos-page-waiting"`) when `waiting`, and **Open chat →** (`data-testid="todos-page-open-chat"`).
- Body: `TodoAddForm`, then the open items from `openOldestFirst(items)`, each a `TodoRow` whose `extra` is the age (`data-testid="todo-age"`, class `old` when `isOld`) and, when `onAsk` is given, an **Ask** button (`data-testid="todo-ask"`, shown on hover and always on touch via `@media (hover: none)`); then `TodoDoneSection` and `TodoUndoToast`. Failed/empty notes as the panel words them.

- [ ] **Step 3: Wire it in `App.tsx`**

- Rows: `rows = stickyRows(heldRows, todosColumn(overview ?? [], chats, agents))`, where `heldRows` is the last rows shown, kept in a ref and reset to `[]` when the selected chat changes or the page closes; drop held rows whose chat no longer exists.
- Rail: `onTodos` opens the page (through `navigate`, closing Settings and Archived, `setView({ kind: 'empty' })` so no chat view shows behind it, and `setNavOpen(window.matchMedia(NARROW_QUERY).matches)` so a phone opens on the column, as `openArchived` does); `todosBadge = badgeText(todosColumn(overview ?? [], chats, agents))` (not the sticky rows, so the badge counts only what is open); `active` is `'todos'` while `todosPage !== null && settings === null`.
- Selection: `selected = pickSelected(rows, todosPage.chatId, chats, !matchMedia(NARROW_QUERY).matches)`; when it differs from `todosPage.chatId`, set it with a history replace (not a push). Picking a row sets `todosPage.chatId` and closes the drawer on a phone.
- Address: extend `wantPath` (`todosPath(todosPage.chatId)` after Settings, before Archived) and the `popstate` handler (`todosFromPath` sets `todosPage` and clears `archive`; leaving `/todos` clears `todosPage`). Every other way to open a chat, Archived or a notification clears `todosPage`.
- Nav column: `todosPage !== null && settings === null` renders `TodosNav` in the sidebar's place (before the `archive` branch).
- Main area: same condition renders `TodosPage` for the selected chat (or a placeholder `Select a chat.` when none), with `items`/`failed`/`retry`/`refresh` from a second `useTodos(selected, connected)`, `waiting = (approvals[selected] ?? 0) > 0`, `onOpenChat` closing the page and opening the chat, and `onAsk` null for `chat.asked`. Ask's behaviour lands in Task 6; pass a no-op that Task 6 replaces.
- Mobile bar title `To-dos` while the page shows.
- Leaving the page keeps the remembered rail mode (`RailMode` is unchanged).

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm test`
Then run the app with a few to-dos (add them by hand in a chat's side panel): the badge counts them and hides at 0; the column orders chats by oldest leftover; ticking on the page updates the chat's side panel and the badge; a cleared chat stays at 0 until another chat is picked; `/todos/<id>` survives a reload; Back and Forward move between `/todos/<id>` and other views; a phone width opens on the column; restarting the server while the page is open brings the badge back correct after the reconnect.

---

### Task 6: Message box and the exchange

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/ChatView.tsx` (exchange mode)
- Modify: `zumi-bot-server/frontend/src/components/MessageList.tsx` (hide what an exchange must not show)
- Modify: `zumi-bot-server/frontend/src/App.tsx` (shared ChatView props, item loading, exchange start, Ask, presence)
- Modify: `zumi-bot-server/frontend/src/useNotifications.ts` (`viewOpens`)
- Modify: `zumi-bot-server/frontend/src/state/notifications.ts` only if its types need `openedAt?: number` widened (it already takes it optional)

**Interfaces:**
- Consumes: `exchangeItems`, `askQuote` (Task 2); `TodosPage.children` and `onAsk` (Task 5).
- Produces:
  - `ChatView` prop `exchange?: { from: string | null }`. When set: no top bar, no side-question chips, no older-page loading, no New line, no handoff card, no pickers row under the composer; items are `exchangeItems(state.items, exchange.from)` plus the pending sends; when that is empty, the list is not drawn at all (only trays and the composer). Tasks tray, working tray, approval/question/plan cards and errors behave as in the chat.
  - `MessageList` prop `exchange?: boolean` that hides the handoff card and the loading/empty placeholders.
  - `sendFromComposer(chatId, text, pick?, messageId?: string)` and `sendMessage(..., messageId?: string)` in `App.tsx`: the user item is created with `messageId ?? crypto.randomUUID()`.
  - `useNotifications({ ..., viewOpens?: boolean })` — default true; when false, a change of `viewChatId` sets `openedAt` to `undefined`, so no `openedAgoMs` is sent and a Mark unread is never ended.

- [ ] **Step 1: Shared props.** In `App.tsx`, move the props the main `ChatView` gets into a local `chatViewProps(chat: ChatMeta, agent: AgentSummary | null)` and use it for the main chat view (no behaviour change).

- [ ] **Step 2: Exchange start.** App keeps `exchangeFrom: Record<string, string>` (chat id → first message id sent from the page) in state for the tab's life; leaving the To-dos page clears it. The page's `onSend(text, pick)` makes an id, sends through `sendFromComposer(chatId, text, pick, id)`, and records it only if the chat has none yet and `routeSend(text).kind === 'send'` (a `/btw` starts no exchange).

- [ ] **Step 3: Items.** When the page selects a chat, start its item load the way `openChat` does (extract `ensureItems(chatId)` from `openChat` and call it from both), so sends decide queueing on real items and pushes land. Nothing is drawn before a send.

- [ ] **Step 4: Render.** Pass `<ChatView {...chatViewProps(chat, agent)} exchange={{ from: exchangeFrom[chat.id] ?? null }} onSend={pageSend} />` as `TodosPage`'s children, except for `chat.asked` (no box). It shares `drafts[chat.id]`.

- [ ] **Step 5: Ask.** `onAsk(text)`: `setDrafts((d) => ({ ...d, [id]: askQuote(d[id] ?? '', text) }))` and bump `composerFocus`. Never sends.

- [ ] **Step 6: Presence.** `viewChatId` becomes the existing expression, or the selected to-dos chat when the page shows (Settings closed) and `exchangeFrom[selected]` is set; `viewOpens` is false in the second case.

- [ ] **Step 7: Verify**

Run: `npm run typecheck && npm test && npm run e2e:unread && npm run e2e:todos`
Expected: PASS (unread proves presence is unchanged for normal chats).
Then by hand with the fake or a real agent: before a send the area under the list is empty; a send shows only the new message and its reply; a reply's approval card can be answered there; switching chats and back shows the exchange again; leaving the page and coming back shows none; Ask quotes into the box and focuses it; typing in the box shows the same draft in the chat itself.

---

### Task 7: End-to-end suite and docs

**Files:**
- Create: `zumi-bot-server/e2e/todosPage.e2e.mjs`
- Modify: `package.json` (root) — `"e2e:todos-page": "npm run build && node zumi-bot-server/e2e/todosPage.e2e.mjs"`
- Modify: `CLAUDE.md` (Commands list, a **Rail** paragraph, a **To-dos page** paragraph, the Settings paragraph: the account menu no longer holds Archived… and Settings…)

**Interfaces:**
- Consumes: every `data-testid` named in Tasks 4–6; the harness (`start({ fake: true, env: { ZUMIBOT_PERMISSION_MODE: 'manual' } })`) and the raw `/ws` `rpc(page, method, ...args)` helper pattern from `archive.e2e.mjs`; the fake claude script lines used by `e2e:routines` (`can_use_tool` plus `#WAIT_RESPONSE`).

- [ ] **Step 1: Write the suite** (fake claude only, no quota; same hard rules and 4 min timeout as `todos.e2e.mjs`; header comment listing the DOM hooks and stored files it relies on). Checks, in order:
  1. With no to-dos: `rail-todos-count` absent.
  2. Make chats A, B and room R by RPC; add to-dos by `todos:add`, B's first (oldest), then A's two, then R's one. Badge reads `4`.
  3. Click `rail-todos`: address `/todos/<B>` (top row auto-selected), `todos-nav-row` order B, A, R, counts 1, 2, 1.
  4. Tick B's item on the page: badge `3`; B's row stays with count `0`; the to-dos file of B has the item done by `user`.
  5. Select A: B's row is gone. Reload: still `/todos/<A>`.
  6. Second browser context (as `unread.e2e.mjs` makes one) ticks one of A's items by RPC; first page's badge reads `2` and A's count `1` without a reload.
  7. The exchange area under A's list has no `agent-message` and no `user-message` although A has history.
  8. Click `todo-ask`: the composer holds `> <text>` and has focus; nothing was sent (no new user item in A's `chats/<A>.json`).
  9. Send with a fake script whose reply asks `can_use_tool` and waits: the exchange shows exactly one `user-message` and the `approval-card`; Allow it from the page; the reply text appears.
  10. Switch to R and back to A: the exchange is still there. Click Agents in the rail, then To-dos again: the exchange is gone.
  11. Delete A by RPC while `/todos/<A>` shows: the page moves to the next top row and the address follows.
  12. `unexpectedErrors()` is empty.

- [ ] **Step 2: Run it**

Run: `npm run e2e:todos-page`
Expected: every `ok` line printed, exit 0.

- [ ] **Step 3: Docs.** Update `CLAUDE.md` as listed: the rail (entries, test ids kept, Usage popover with Usage details, phone drawer), the To-dos page (overview RPC and its listener on every to-dos write, column rules, sticky zero rows, ages and amber after 3 days, the exchange that starts at the first message sent from the page, presence that never ends a Mark unread, `/todos/<id>`), the new e2e script with "uses only the fake claude, so it costs no quota", and the spec path.

- [ ] **Step 4: Full check**

Run: `npm run typecheck && npm test && npm run e2e:todos && npm run e2e:todos-page`
Expected: all pass. Report the result to the user; do not commit.
