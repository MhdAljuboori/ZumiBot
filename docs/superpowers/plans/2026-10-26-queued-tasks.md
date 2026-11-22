# Queued Follow-up Tasks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A message sent while a chat runs waits in a server-side "Tasks" queue shown above the composer and goes in, one per turn, the moment the current run ends (also after Stop), in single and group chats.

**Architecture:** Tasks live on `ChatMeta.tasks` in `chats.json`, so every meta push carries them to every tab. A new backend `TaskQueue` sits in front of `ChatService.send` / `GroupService.send`: it queues when the chat is busy and dispatches the next task when `ChatService.release` fires a new `onIdle` hook (both chat types release through it). The frontend renders a collapsible `TasksTray` above a now-collapsible `WorkingTray`.

**Tech Stack:** TypeScript, Node 22, vitest, React 19, playwright-core e2e with the fake claude.

**Spec:** `docs/superpowers/specs/2026-10-26-queued-tasks-design.md`

## Global Constraints

- Never commit. The user's global rule: commits only when the user asks. Every "commit" point below is "stop; leave changes in the working tree".
- Code style: match surrounding code. Short comments that say *why*. No new dependencies.
- New API method touches three places: `ZumiBotApi` in `shared/src/types.ts`, handler in `backend/src/rpc/handlers.ts`, mapping in `frontend/src/net/api.ts`. Handlers check every argument (`str()`, `strings()`, ...).
- Task cap: 50 per chat. Error copy: `A chat can hold at most 50 queued messages`.
- Header copy: `Tasks` and `Working now`; collapsed or not, the header shows the count as `· N`.
- Collapse state: one `localStorage` set under key `zumibot.collapsedTrays` holding `'tasks'` and/or `'working'`; both expanded by default; every read/write wrapped in try/catch.
- A collapsed Working now still shows rows in state `approval`.
- Queueing a task or dropping one does not change the chat's `updatedAt` (same as `toggleReaction`), so the sidebar order holds.
- Removing a task deletes its committed attachment folders.
- Paths below are relative to `zumi-bot-server/`.

## Review Focus

1. **Send racing the end of a run** — a send that lands while a task is being taken/dispatched must queue behind it, never run beside it or jump ahead. Test in Task 3 (`queues behind a dispatch in progress`).
2. **Group room that ends before `GroupService.send` resolves** — `onIdle` fires while the dispatch flag is still set; the queue must not stall. Test in Task 3 (`pumps again after a group dispatch settles`).
3. **Chat deleted with tasks queued** — `onIdle`/resume must not throw unhandled or loop. Test in Task 3 (`a removed chat ends the pump quietly`).
4. **× pressed on a task the server just dispatched** — `drop` finds nothing, resolves, deletes no files. Test in Task 3 (`dropping a task already taken is a no-op`).
5. **Double display** — a send the client makes while busy must not draw a pending bubble as well as a task row. Test in Task 5 (`sendsAsTask`).

---

### Task 1: Data layer — types, ChatStore task methods, attachment removal

**Files:**
- Modify: `shared/src/types.ts` (ChatMeta at ~45, `ZumiBotApi.chats` at ~190)
- Modify: `backend/src/core/store/chatStore.ts` (next to `toggleReaction`, ~153)
- Modify: `backend/src/core/attachments/attachmentStore.ts` (next to `removeChat`, ~150)
- Test: `backend/tests/core/chatStore.test.ts`, `backend/tests/core/attachmentStore.test.ts`

**Interfaces:**
- Produces (shared):
  - `export interface QueuedTask { id: string; text: string; attachments?: Attachment[]; replyTo?: string; ts: number }`
  - `ChatMeta.tasks?: QueuedTask[]` — comment: `// messages sent while the chat ran, oldest first; absent = none`
  - `export type SendResult = 'sent' | 'queued'`
  - `ZumiBotApi.chats.send(...)` now returns `Promise<SendResult>`; new `dropTask(chatId: string, taskId: string): Promise<void>`
- Produces (backend):
  - `ChatStore.addTask(id: string, task: QueuedTask): Promise<ChatMeta>` — appends.
  - `ChatStore.takeTask(id: string): Promise<{ task: QueuedTask | null; meta: ChatMeta }>` — removes and returns the first.
  - `ChatStore.dropTask(id: string, taskId: string): Promise<{ task: QueuedTask | null; meta: ChatMeta }>` — removes by id.
  - All three run under the store lock, keep `updatedAt` (pass `updatedAt: cur.updatedAt`), throw `Chat not found: <id>` like `update`, and write `tasks: undefined` when the list empties.
  - `AttachmentStore.removeFiles(chatId: string, ids: string[]): Promise<void>` — `rm -rf root/chatId/id` per id; ignores ids failing `ID_RE`.

- [ ] **Step 1: Write failing tests** in `chatStore.test.ts`:
  - `addTask appends in order and keeps updatedAt` — add t1, t2 → `meta.tasks.map(t => t.id)` equals `['t1','t2']`; `updatedAt` equals the value before.
  - `takeTask returns the oldest and removes it; empty list leaves tasks absent` — after taking t1 then t2, `task.id` is `'t1'` then `'t2'`, and final `meta.tasks` is `undefined`; a third take returns `{ task: null }`.
  - `dropTask removes by id; unknown id returns null and changes nothing`.
  - `tasks survive a reload` — new `ChatStore(dir)` lists the chat with its tasks.
  And in `attachmentStore.test.ts`: `removeFiles deletes only the named attachment folders` (commit two, remove one, `chatFile` of the removed is `null`, the other still resolves).
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/chatStore.test.ts zumi-bot-server/backend/tests/core/attachmentStore.test.ts` — expect FAIL (methods missing).
- [ ] **Step 3: Implement** the shared types and the four methods above.
- [ ] **Step 4: Run** the same command — expect PASS. Run `npm run typecheck` — expect errors only where `chats.send` callers ignore the new return type (fixed in Tasks 4 and 6); note them, don't patch yet.

### Task 2: ChatService `onIdle` hook

**Files:**
- Modify: `backend/src/core/chat/chatService.ts` (`ChatServiceDeps` ~15, `release` ~139)
- Test: `backend/tests/core/chatService.test.ts`, `backend/tests/core/groupService.test.ts`

**Interfaces:**
- Produces: `ChatServiceDeps.onIdle?(chatId: string): void` — called from `release()` only when it actually removed the claim, after the delete (so `isRunning(chatId)` is already `false` inside it). Comment why: it's the one "run ended" signal for both single turns and group rooms.

- [ ] **Step 1: Write failing tests:**
  - chatService: `onIdle fires once after a turn ends, with the chat already idle` — record `[chatId, svc.isRunning(chatId)]` inside the hook; after `await svc.send(...)` the record equals `[[id, false]]`.
  - chatService: `onIdle fires after a stopped turn too` (hang script, `stop`, await) → called once.
  - groupService: `onIdle fires once when the room ends` — build the group test's ChatService with an `onIdle` spy; after the room's `done`, spy called once with the chat id.
- [ ] **Step 2: Run** `npx vitest run --project backend -t "onIdle"` — expect FAIL.
- [ ] **Step 3: Implement** the optional dep and call it in `release`.
- [ ] **Step 4: Run** the same — expect PASS.

### Task 3: TaskQueue

**Files:**
- Create: `backend/src/core/chat/taskQueue.ts`
- Test: `backend/tests/core/taskQueue.test.ts`

**Interfaces:**
- Consumes: Task 1 store methods and `removeFiles`; Task 2 `onIdle`; `ChatService.isRunning/send`, `GroupService.send`, `AttachmentStore.commit`.
- Produces:
  ```ts
  export const TASKS_MAX = 50
  export interface TaskQueueDeps {
    store: Pick<ChatStore, 'get' | 'list' | 'addTask' | 'takeTask' | 'dropTask'>
    chats: Pick<ChatService, 'isRunning' | 'send'>
    groups: Pick<GroupService, 'send'>
    files: Pick<AttachmentStore, 'commit' | 'removeFiles'>
    push(p: ChatPush): void
    now(): number
    newId(): string
  }
  export class TaskQueue {
    constructor(d: TaskQueueDeps)
    /** Queues when busy, else sends as today. 'sent' resolves when a single chat's turn ends / a group message is posted. */
    submit(chatId: string, text: string, stagedIds: string[], replyTo?: string, messageId?: string): Promise<SendResult>
    drop(chatId: string, taskId: string): Promise<void>
    idle(chatId: string): void // wired to ChatServiceDeps.onIdle
    resume(): Promise<void>    // startup: pump every chat that holds tasks
  }
  ```
- Rules (the part the signature doesn't decide):
  - `submit` throws `Message is empty` for blank text with no ids, and `Chat not found: <id>` before any commit.
  - Busy = `chats.isRunning(id)` **or** the chat has tasks **or** `dispatching` holds the id. Busy → check cap (before commit), commit attachments, `addTask({ id: messageId ?? newId(), text, attachments?, replyTo?, ts: now() })`, push `{ chatId, kind: 'meta', meta }`, return `'queued'`.
  - The busy check and the start of a dispatch run inside a per-chat serial lock (same `serial` helper shape as `GroupService`), so two submits can't both see "idle". A single chat's turn promise is returned **outside** the lock (`ChatService.send` claims synchronously; holding the lock for the whole turn would block queueing).
  - Not busy → commit, then `groups.send` (awaited inside the lock, with `dispatching` set) or `chats.send` (claim is synchronous; await the turn outside the lock). Return `'sent'`. Rejections still reach the caller, as today.
  - `pump(id)` (private): under the lock, return if running/dispatching; set `dispatching`; `takeTask`; push meta; dispatch via the right service with the task's committed `attachments`, `replyTo`, and `task.id` as `messageId`. Clear `dispatching` in `finally`, then `void pump(id)` again (covers a room that ended before `groups.send` resolved). Errors from a dispatched task are logged with `console.error`; `Chat not found` ends quietly.
  - `idle(id)` defers with `queueMicrotask(() => void this.pump(id))` — never re-enters `release`.
  - `drop`: `dropTask`; if a task came back, push meta and `removeFiles(chatId, task.attachments ids)`.

- [ ] **Step 1: Write failing tests** with a real `ChatStore` in a temp dir and fake `chats`/`groups` objects (fake `isRunning` driven by a `running` set; fake `send` records calls and returns a controllable promise):
  - `sends straight away when idle and returns 'sent'` — one `chats.send` call with `messageId` `'m1'`; store has no tasks.
  - `queues while running, keeps order, returns 'queued'` — two submits → `tasks` ids `['m1','m2']`, zero `send` calls, two meta pushes.
  - `idle sends the oldest task with its id, files and replyTo, and removes it` — after `idle` + flush, `send` called with `(id, 'one', [att], 'r1', 'm1')`, tasks `['m2']`.
  - `one task per turn` — while the dispatched task's fake turn is "running", a second `idle` sends nothing.
  - `queues behind a dispatch in progress` (Review Focus 1) — a group dispatch whose `groups.send` hasn't resolved; a new submit returns `'queued'`.
  - `pumps again after a group dispatch settles` (Review Focus 2) — `groups.send` resolves after the fake run already ended (no later `idle`); next task still goes out.
  - `group chats dispatch through GroupService` — a group meta → `groups.send` called, `chats.send` not.
  - `refuses the 51st task before committing files` — `commit` spy not called; rejects with `A chat can hold at most 50 queued messages`.
  - `a removed chat ends the pump quietly` (Review Focus 3) — remove chat, `idle` → no throw, no `send`.
  - `dropping a task removes it and its files` / `dropping a task already taken is a no-op` (Review Focus 4) — `removeFiles` called with the task's ids / not called.
  - `resume pumps chats that hold tasks` — two chats, one with tasks → one `send`.
  - `a failed dispatch moves on to the next task` — first `chats.send` rejects; second task still sent.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/taskQueue.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `taskQueue.ts` per the rules above.
- [ ] **Step 4: Run** the same — expect PASS.

### Task 4: RPC handlers and server wiring

**Files:**
- Modify: `backend/src/rpc/handlers.ts` (`HandlerDeps` ~15, `chats:send` ~127, add `chats:dropTask`)
- Modify: `backend/src/app.ts` (~95–175)
- Test: `backend/tests/rpc/handlers.test.ts`, `backend/tests/app.test.ts` if it lists methods

**Interfaces:**
- Consumes: Task 3 `TaskQueue`.
- Produces: `HandlerDeps.tasks: TaskQueue`; `'chats:send'` validates args exactly as today, then `return tasks.submit(id, body, staged, quoted, picked)` (the "already running" throw and the group branch move into TaskQueue; keep the comment that a rejected send must reach the client). `'chats:dropTask': (chatId, taskId) => tasks.drop(str(chatId,'chatId'), str(taskId,'taskId'))`.
- Wiring in `app.ts`: declare `let tasks: TaskQueue` before `ChatService` (like `hub`), pass `onIdle: (id) => tasks.idle(id)`, construct `TaskQueue` after `GroupService`, pass to `createHandlers`, and after `recoverInterrupted` + `clearStaged`, `await tasks.resume()` inside a try/catch that logs `resuming queued messages failed:`.

- [ ] **Step 1: Write failing tests** in `handlers.test.ts` (build a real `TaskQueue` over the test's `svc`/`store`; `groups` may be `{}`-cast as today):
  - Add `'chats:dropTask'` to the method-list test (~83).
  - `chats:send while the chat runs queues the message and resolves 'queued'` — first send left pending (the test's `run` waits on an approval), second resolves `'queued'`, `store.get(id).tasks[0].text === 'two'`.
  - `chats:dropTask removes a queued message; a bad taskId type is refused`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/rpc/handlers.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** handler changes and app wiring.
- [ ] **Step 4: Run** `npx vitest run --project backend` — expect PASS. Any existing test that expected `Chat is already running` from `chats:send` now expects `'queued'`; `ChatService.send`'s own "already running" test stays (the service still refuses a second claim).

### Task 5: Frontend pure state

**Files:**
- Create: `frontend/src/state/tasks.ts`, `frontend/src/state/storedSet.ts`
- Modify: `frontend/src/state/groupChat.ts` (after `trayRowOpen`, ~150); `frontend/src/components/Sidebar.tsx` (~56–70, import the moved helpers)
- Test: `frontend/tests/tasks.test.ts` (new), `frontend/tests/groupChat.test.ts`

**Interfaces:**
- Produces:
  - `sendsAsTask(chat: Pick<ChatMeta, 'inFlight' | 'tasks'>, pending: readonly PendingSend[]): boolean` — `inFlight` or tasks non-empty or `isSending(pending)`.
  - `taskLabel(task: QueuedTask): string` — whitespace collapsed to single spaces and trimmed; blank text → first attachment's name.
  - `TRAYS_KEY = 'zumibot.collapsedTrays'`; `type TrayName = 'tasks' | 'working'`.
  - `storedSet.ts`: `loadSet(key: string): Set<string>` and `saveSet(key: string, values: Iterable<string>): void`, moved verbatim from `Sidebar.tsx` (Sidebar imports them).
  - `visibleTrayRows(rows: readonly TrayRow[], open: boolean): TrayRow[]` — all rows when open, else only `state === 'approval'`.

- [ ] **Step 1: Write failing tests:**
  - `sendsAsTask` (Review Focus 5): false for idle chat with no tasks and no pending; true for `inFlight`; true for tasks `[t]` with `inFlight: false`; true when a pending send has `error: null`; false when the only pending send failed.
  - `taskLabel`: `'a\n\n  b'` → `'a b'`; `''` with attachment `x.png` → `'x.png'`.
  - `visibleTrayRows`: open → all; collapsed with one approval and one working row → only the approval row.
- [ ] **Step 2: Run** `npx vitest run --project frontend` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same — expect PASS.

### Task 6: Frontend UI — send flow, TasksTray, collapsible WorkingTray

**Files:**
- Modify: `frontend/src/net/api.ts` (~49: `send` returns the result; add `dropTask`)
- Modify: `frontend/src/App.tsx` (`sendMessage` ~551; pass `onDropTask` to `ChatView` ~766)
- Create: `frontend/src/components/TasksTray.tsx`
- Modify: `frontend/src/components/WorkingTray.tsx`, `frontend/src/components/ChatView.tsx`, `frontend/src/styles.css` (~1097 and mobile rules ~1383, ~1439)

**Interfaces:**
- Consumes: Task 5 helpers; `QueuedTask`, `SendResult`, `api.chats.dropTask`.
- Produces:
  - `TasksTray({ tasks, open, onToggle, onDrop }: { tasks: QueuedTask[]; open: boolean; onToggle: () => void; onDrop: (taskId: string) => void })` — header button `data-testid="tasks-head"` with `aria-expanded`, text `Tasks`, count `· N`, caret (reuse `.tray-caret`); when open, one row per task `data-testid="task-row"` with a hollow circle, `taskLabel` text (one line, ellipsis), a reply mark when `replyTo`, a paperclip + count when attachments, and an × button `data-testid="task-drop"` `aria-label="Remove queued message"` (always visible on touch, on hover/focus on desktop).
  - `WorkingTray` gains `open: boolean; onToggleOpen: () => void`; `.tray-label` becomes a header button `data-testid="working-head"` with `aria-expanded`, `Working now · N` and caret; rows go through `visibleTrayRows(rows, open)`.
  - `ChatView` gains `onDropTask: (taskId: string) => void`; holds `collapsed` from `loadSet(TRAYS_KEY)` and saves on toggle; renders `TasksTray` (when `chat.tasks?.length`) above `WorkingTray` in the group branch and above `Composer` in the single branch; single-chat `Composer` gets `allowSendWhileRunning`.
- `sendMessage` changes: compute `asTask = sendsAsTask(chat, pendingSends[chatId] ?? [])` from `latest.current`; skip the pending bubble when `asTask`; after the call resolves, drop the bubble regardless of result (a `'queued'` result removes a bubble drawn in a race). On rejection when `asTask`: restore draft, reply and files as today, and `failChat(chatId, \`Message failed to send: ${errorMessage(e)}\`)`.
- `onDropTask` in App: `api.chats.dropTask(chatId, id).catch((e) => failChat(chatId, errorMessage(e)))`.
- CSS: `.tasks-tray` shares `.working-tray`'s container rules (add it to the selector) with its own `max-height: 30%`; header buttons reuse `.tray-label` type styles; mobile rules mirror `.working-tray`'s.

- [ ] **Step 1: Implement** the files above.
- [ ] **Step 2: Run** `npm run typecheck` — expect no errors. Run `npm test` — expect PASS.
- [ ] **Step 3: Build and look:** `npm run build:server`, then run the `run` skill / `npm run shot` path to see a single chat and a group with tasks queued, both trays collapsed and expanded, light and dark, desktop and 375px wide. Expected: Tasks above Working now; counts in headers; approval row stays visible with Working now collapsed; composer stays reachable on phone width.

### Task 7: E2E coverage

**Files:**
- Modify: `e2e/web.e2e.mjs` (single chat), `e2e/group.e2e.mjs`

**Interfaces:**
- Consumes: harness `start({ fake: true })` and its `script.jsonl` (the fake reads it on every run; a `#SLEEP <ms>` line slows the stream).

- [ ] **Step 1: Add single-chat case** `queued follow-up goes in after the reply`: write a script with `#SLEEP 2500` before the reply lines; send `one`; while the reply runs send `two` → one `[data-testid=task-row]` with text `two`, no `two` bubble in the thread; after the reply ends the row is gone and the thread holds `two` followed by its reply. Then queue `three` and `four`, click × on `four` → one row left; press Stop → `three` goes in.
- [ ] **Step 2: Add group case** `a message sent mid-run waits for the whole room`: same shape with the group fake; assert the task row exists while `[data-testid=working-tray]` is visible and the message appears only after the tray disappears.
- [ ] **Step 3: Add collapse case:** click `tasks-head` → rows hidden, header still reads `Tasks · N`; reload → still collapsed.
- [ ] **Step 4: Run** `npm run e2e` and `npm run e2e:group` — expect PASS. Kill any leftover browser/server processes afterwards (user rule).

---
## Amendments (user, after plan approval)
- Task 3: paused groups hold their tasks (last item is a `paused` notice); busy = running or dispatching only (an idle chat with held tasks sends a new message at once); new `TaskQueue.sendTask(chatId, taskId)`.
- Task 4: new handler `chats:sendTask(chatId, taskId)` -> `tasks.sendTask`; `ZumiBotApi.chats.sendTask(chatId, taskId): Promise<SendResult>` + `api.ts` mapping.
- Task 5: `sendsAsTask` = `chat.inFlight` or a send still on its way (tasks alone no longer qualify).
- Task 6: each task row gets an Enter button (`data-testid="task-send"`, `aria-label="Send now"`), shown only when `!chat.inFlight`; calls `api.chats.sendTask`; errors via `failChat`.
- Task 7: e2e for the paused-room hold is impractical with the fake; cover sendTask and "written message sends, tasks stay" instead.
- Task 5 (revised after Task 3): `sendsAsTask` = `chat.inFlight` || a send still on its way || (`chat.tasks` non-empty && not a group paused at its end), matching the server's busy rule; use the existing `pausedAtEnd` in `frontend/src/state/groupChat.ts`. Server returns 'sent' for a paused group, 'queued' otherwise.
