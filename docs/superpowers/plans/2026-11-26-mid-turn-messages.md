# Mid-turn messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enter while a single Claude chat's reply runs sends the message into that reply (the agent reads it at its next tool step); Ctrl/Cmd+Enter queues it as today.

**Architecture:** The running `claude` process takes extra stream-json user messages on stdin; `--replay-user-messages` echoes each one back with our uuid when the CLI takes it in. `RunHandle.steer` writes the message, `ChatService` tracks it in `meta.steering` until the echo turns it into a `steered` user item, and hands back anything never read to the front of the task tray. `TaskQueue.submit` chooses steer or queue; the composer passes `steer: true` only for Enter.

**Tech Stack:** TypeScript, Node 22, vitest, React 19, Tiptap. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-26-mid-turn-messages-design.md`

## Global Constraints

- Never commit (the user's global rule): no `git commit` step runs unless the user asks.
- Only the composer's Enter steers; every other `chats:send` / `TaskQueue.submit` caller behaves exactly as today.
- Steer only into: a single chat (not a group), engine `claude` on the CLI adapter, a turn the user started (not `spec.auto`, not `meta.workflow`, not `meta.asked`, not a `cardAsk` turn), not a compaction, not pausing/paused, not compacting, no `command`, no `/todo`. Everything else queues.
- `--replay-user-messages` only on single-chat Claude turns (not rooms, side runs, keep-warm, compaction, the SDK adapter).
- A replay line never yields an `entry` event.
- `TASKS_MAX` (50) counts `tasks + steering`.
- Comments short, saying why. Secrets never in logs or errors. Fake CLIs only through `tests/support/fakeBin.ts` (tests run on Windows and macOS).
- Root `CLAUDE.md` stays ≤ 16 384 bytes (`shared/tests/repoDocs.test.ts`).

## Review Focus

1. **Enter in the gap between the reply's `result` and the process exit** — expected: queued as a task, never lost, never shown twice. Test in Task 4 (`steer after stdin closed falls back to a task`).
2. **Stop while a steered message is unread** — expected: it moves to the front of the tray, no bubble, `steering` empty, tray `held` untouched. Test in Task 4 (`stop hands unread steers back to the front of the tray`).
3. **Two steers sent quickly** — expected: both bubbles, in send order, each at the point it was read. Test in Task 4 (`two steers land in order`).
4. **The send's reply is lost (socket drop) while the message sits in `steering`** — expected: no error, no restored draft. Test in Task 6 (`rejectedSendState treats a steering id as queued`).
5. **`/command`, `/todo` or a non-image file sent with Enter mid-turn** — expected: queued, not steered. Tests in Task 5 (`command and todo messages queue`) and Task 4 (`a file steers only when the run has the attachments folder`).

---

### Task 1: Shared types, parser and CLI flag

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`SendResult`, `ChatMeta`, user `ChatItem`, `ZumiBotApi.chats.send`)
- Modify: `zumi-bot-server/backend/src/core/chat/streamParser.ts` (`RunEvent`, `case 'user'`)
- Modify: `zumi-bot-server/backend/src/core/chat/claudeRunner.ts` (`buildArgs`)
- Test: `zumi-bot-server/backend/tests/core/streamParser.test.ts`, `zumi-bot-server/backend/tests/core/claudeRunner.test.ts`

**Interfaces:**
- Produces:
  - `export type SendResult = 'sent' | 'queued' | 'steered'`
  - `ChatMeta.steering?: QueuedTask[]` — written into the running reply, not read yet, oldest first; absent = none
  - user item `steered?: true`
  - `ZumiBotApi.chats.send(chatId, text, attachmentIds?, replyTo?, messageId?, command?, steer?: true): Promise<SendResult>`
  - `RunEvent` member `{ kind: 'userReplay'; uuid: string }`
  - `buildArgs({ ..., replayUser?: boolean })` → adds `'--replay-user-messages'` right after `'--include-partial-messages'` when true

- [ ] **Step 1: Write the failing tests**

```ts
// streamParser.test.ts
it('turns a replayed user message into userReplay, with no entry', () => {
  const line = JSON.stringify({ type: 'user', isReplay: true, uuid: 'u-1', message: { role: 'user', content: 'more detail' } })
  expect(parseLine(line)).toEqual([{ kind: 'userReplay', uuid: 'u-1' }])
})
it('keeps entry for a non-replayed user line', () => {
  const line = JSON.stringify({ type: 'user', uuid: 'u-2', message: { role: 'user', content: [] } })
  expect(parseLine(line)).toEqual([{ kind: 'entry', uuid: 'u-2' }])
})
// claudeRunner.test.ts
it('adds --replay-user-messages only when asked', () => {
  const base = { agentName: 'a', resumeSessionId: null, permissionMode: 'default' as const }
  expect(buildArgs({ ...base, replayUser: true })).toContain('--replay-user-messages')
  expect(buildArgs(base)).not.toContain('--replay-user-messages')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run zumi-bot-server/backend/tests/core/streamParser.test.ts zumi-bot-server/backend/tests/core/claudeRunner.test.ts`
Expected: the three new tests FAIL.

- [ ] **Step 3: Implement**

In `case 'user'`: when `m.isReplay === true && typeof m.uuid === 'string' && m.uuid`, return `[{ kind: 'userReplay', uuid: m.uuid }]` before `entryOf`. Add the shared fields above; `npm run typecheck` shows every `SendResult` switch that needs the new case.

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run --project backend -t "replay" && npm run typecheck`
Expected: PASS, no type errors.

---

### Task 2: Runner `steer` and the stdin close rule

**Files:**
- Modify: `zumi-bot-server/backend/src/core/engines/engine.ts` (`RunHandle`)
- Modify: `zumi-bot-server/backend/src/core/chat/claudeRunner.ts` (`RunOptions`, `runClaude`)
- Test: `zumi-bot-server/backend/tests/core/claudeRunner.test.ts`
- Modify: `zumi-bot-server/backend/tests/fixtures/fake-claude.mjs` (new `#STEER_REPLAY` directive)

**Interfaces:**
- Consumes: `userReplay` (Task 1), `encodeUserMessage(content, uuid)` (`controlProtocol.ts`)
- Produces:
  - `RunHandle.steer?(content: UserContent, uuid: string): boolean` — optional; engines without it cannot take a mid-turn message
  - `RunOptions.steerGraceMs?: number` (default `5000`)
  - `runClaude(...)` returns a handle with `steer`; `claudeEngine` already returns `d.run(...)` unchanged, so the handle carries it
  - fake-claude `#STEER_REPLAY`: waits for the next stdin line of `type: 'user'` after the first, then writes `{ type: 'user', isReplay: true, uuid: <its uuid>, message: <its message> }`; non-control lines are recorded (today they are dropped in `onLine`)

Close rule (the algorithm the tests pin): keep a set of uuids written by `steer` and not yet seen in a `userReplay`. At a `result`, end stdin only when that set is empty; otherwise start a `steerGraceMs` timer that ends stdin unless a `userReplay` or `init` arrives first. After any later `result`, apply the same rule. `steer` returns false once stdin has ended, the run finished, or it was stopped.

- [ ] **Step 1: Write the failing tests** (fake bin from `tests/support/fakeBin.ts`, script via `FAKE_STDOUT_FILE`)

```ts
it('steer writes a stream-json user line with the uuid', async () => { /* FAKE_STDIN_OUT: second line parses to {type:'user', uuid:'s-1', message:{content:'x'}} */ })
it('steer returns false after the result closed stdin', async () => { /* call steer after done → false */ })
it('keeps stdin open past a result while a steer is unread, then closes at the next result', async () => {
  /* script: init, result, #STEER_REPLAY, assistant, result. steer('more','s-1') before the first result.
     expect events to include userReplay s-1 and two results; done resolves; exitCode 0 */
})
it('closes stdin after the grace when the unread steer never comes back', async () => {
  /* steerGraceMs: 50; script: init, result, then FAKE_EXIT_ON_STDIN_END=1; expect done to resolve */
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run zumi-bot-server/backend/tests/core/claudeRunner.test.ts -t "steer"`
Expected: FAIL (`steer` is not a function).

- [ ] **Step 3: Implement `steer` and the close rule in `runClaude`; add `#STEER_REPLAY` to fake-claude**

- [ ] **Step 4: Run the runner tests**

Run: `npx vitest run zumi-bot-server/backend/tests/core/claudeRunner.test.ts`
Expected: all PASS (old ones too: a run with no steer still closes stdin at its `result`).

---

### Task 3: Steer helpers, cost growth, store methods

**Files:**
- Create: `zumi-bot-server/backend/src/core/chat/steer.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (`runTurn` uses the shared prompt helper instead of its inline `noted`/`blocks`)
- Modify: `zumi-bot-server/backend/src/core/usage/runCost.ts`
- Modify: `zumi-bot-server/backend/src/core/store/chatStore.ts`
- Test: `zumi-bot-server/backend/tests/core/steer.test.ts` (new), `zumi-bot-server/backend/tests/core/runCost.test.ts` (or the existing runCost test file), `zumi-bot-server/backend/tests/store/chatStore.test.ts` (existing store test file)

**Interfaces:**
- Produces:
  - `messagePrompt(user: UserItem, items: readonly ChatItem[], agentName: string, bridges: boolean, pathOf: (a: Attachment) => string): Promise<{ noted: UserContent; blocks: ContentBlock[] }>` — what `runTurn` builds today from `readAs` → `withReply(…, repliedItem(items, user.replyTo), user.command?.engine === 'claude')` → `withNote(…, refs)` and `imageBlocks(refs)`; `runTurn` calls it and keeps `withImages(noted, blocks)`
  - `needsAttachmentDir(attachments: readonly Attachment[] | undefined): boolean` — true when any attachment is not an image block (same test `imageBlocks` uses)
  - `steeredItem(task: QueuedTask, ts: number): UserItem` → `{ type:'user', id, text, ts, attachments?, replyTo?, steered: true }`
  - `costSince(cost: RunCost, prev: RunCost | null): RunCost` — `prev` null returns `cost`; otherwise per-model `minusBaseline(cost, prev.models)` and `totalUsd: max(0, cost.totalUsd - prev.totalUsd)`
  - `ChatStore.addSteer(id: string, task: QueuedTask): Promise<ChatMeta>` (appends to `steering`)
  - `ChatStore.dropSteer(id: string, taskId: string): Promise<ChatMeta>` (removes; `steering` absent when empty)
  - `ChatStore.returnSteers(id: string, taskIds: string[]): Promise<ChatMeta>` (moves those, in `steering` order, to the **front** of `tasks`; `held` untouched)
  - `recoverInterrupted` moves any `steering` to the front of `tasks` for every chat

- [ ] **Step 1: Write the failing tests**

```ts
it('costSince subtracts the earlier result of the same process', () => {
  const a = { totalUsd: 0.0057, models: { m: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.0057 } } }
  const b = { totalUsd: 0.0094, models: { m: { input: 15, output: 30, cacheRead: 0, cacheWrite: 0, costUsd: 0.0094 } } }
  expect(costSince(b, a).totalUsd).toBeCloseTo(0.0037)
  expect(costSince(b, a).models.m.output).toBe(10)
  expect(costSince(b, null)).toEqual(b)
})
it('needsAttachmentDir is false for images only', () => { /* image/png → false; a .txt → true; undefined → false */ })
it('steeredItem marks the item steered and keeps replyTo and attachments', () => { /* … */ })
it('returnSteers puts unread steers ahead of queued tasks, keeping held', async () => {
  /* tasks [t1], held true, steering [s1, s2] → returnSteers([s1,s2]) → tasks [s1, s2, t1], held true, steering undefined */
})
it('recoverInterrupted hands leftover steering back to the tray', async () => { /* inFlight chat with steering [s1] → tasks [s1, …] */ })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run zumi-bot-server/backend/tests/core/steer.test.ts zumi-bot-server/backend/tests/store`
Expected: FAIL (module/methods missing).

- [ ] **Step 3: Implement; switch `runTurn` to `messagePrompt`**

- [ ] **Step 4: Run backend tests touching these files**

Run: `npx vitest run --project backend -t "steer|costSince|recoverInterrupted|runTurn"` then `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts`
Expected: PASS (the `runTurn` refactor changes no prompt).

---

### Task 4: ChatService steering

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (`TurnSlot`, `TurnSpec`, `runTurn`, `agentTurn`, new `steer`)
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts` (or a new `chatServiceSteer.test.ts` beside it, same harness)

**Interfaces:**
- Consumes: Tasks 1–3
- Produces:
  - `TurnSpec.steerable?: true` — set only by `runTurn` when `!t.extra?.auto && !meta.workflow && !meta.asked && !user.cardAsk && engine === 'claude'`; it also passes `replayUser: true` into the Claude run config
  - `TurnSlot.steer?: (task: QueuedTask) => Promise<boolean>` — installed by `agentTurn` for a steerable, non-compact turn
  - `ChatService.steer(chatId: string, task: QueuedTask): Promise<boolean>` — false unless the chat runs exactly one slot with `steer`, `r.reason === null`, and the meta is not `pause`/`compacting`

`slot.steer(task)`: false if the current `handle` has no `steer`, the cut run was ignored (`forkIgnored !== undefined`), or `needsAttachmentDir(task.attachments)` while the run's args lack the attachments dir; else `store.addSteer` + push meta, build content with `messagePrompt` over `ref.get()` and `withImages`, `handle.steer(content, task.id)`; on false `store.dropSteer` + push and return false. Keep the attempt's unread ids in a `Set`.

On `userReplay` with an unread id: `flushPartial()`, `add(steeredItem(task, now()))`, `later(dropSteer + push meta)`, `saveAndPush(false)`. Other uuids: ignore.

On `result`: report `costSince(e.cost, previousCostThisAttempt)` (after the baseline subtraction where one applies); remember `e.cost` as the previous one. Reset it per attempt.

After each attempt's `handle.done`: unread ids → `store.returnSteers` + push meta; clear the set.

- [ ] **Step 1: Write the failing tests** (fake claude scripts; `FAKE_STDIN_OUT` to read what was written)

```ts
it('a steer during a tool step becomes a steered user item after the tool result', async () => {
  /* script: init, tool_use, #STEER_REPLAY, tool_result, assistant, result.
     send(); once inFlight, steer({id:'s-1', text:'more', ts}) → true.
     items order: user, tool, {type:'user', id:'s-1', steered:true}, assistant; meta.steering undefined */
})
it('a late steer runs as a second CLI turn in the same process', async () => {
  /* script: init, assistant, result(cost .0057), #STEER_REPLAY, init, assistant, result(cost .0094) → both texts kept, one turn,
     onRunCost totals .0057 then ≈.0037 */
})
it('two steers land in order', async () => { /* two #STEER_REPLAY → items s-1 then s-2 */ })
it('stop hands unread steers back to the front of the tray', async () => {
  /* tasks [t1]; steer s-1 (never replayed); stop → meta.tasks [s-1, t1], steering undefined, no s-1 item, held unchanged */
})
it('steer after stdin closed falls back to a task', async () => { /* steer once the result came → false */ })
it('steer is refused for routine, workflow, asked and card turns, rooms and compaction', async () => { /* each → false */ })
it('a file steers only when the run has the attachments folder', async () => { /* .txt in a chat without attachments → false; image → true */ })
it('editing the original message cuts before both it and the steered message', async () => {
  /* after a steered turn, rerun the original: the next run's args have --resume-session-at at the previous turn's end
     (no --resume-drops-turn), and the shown items hide s-1 */
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts -t "steer"`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the whole backend project**

Run: `npx vitest run --project backend`
Expected: PASS.

---

### Task 5: TaskQueue and the RPC argument

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/taskQueue.ts` (`SubmitOptions`, `TaskQueueDeps.chats` Pick, `submit`)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (`chats:send`)
- Test: `zumi-bot-server/backend/tests/core/taskQueue.test.ts`, the backend HTTP/RPC test that covers `chats:send` (`tests/http/`)

**Interfaces:**
- Consumes: `ChatService.steer` (Task 4)
- Produces: `SubmitOptions.steer?: true`; `submit` resolves `'steered'` when the steer went in; `chats:send` 7th argument `steer` (`true` or absent, anything else rejected like other bad args)

In `submit`, under the lock, after the `waiting`/`idle` computation and before the task branch: when `opts?.steer && from === 'user' && !idle && !isGroup(meta) && meta.pause === undefined && !meta.compacting && meta.resume === undefined && !command && !todo && !opts.once && !opts.cardAsk && !opts.run`, check `TASKS_MAX` against `tasks + steering`, commit the files, build the `QueuedTask` as the task branch does, and `await chats.steer(chatId, task)`; true → `committed?.('steered')`, return `'steered'`; false → continue to the existing task path with the already committed attachments.

- [ ] **Step 1: Write the failing tests**

```ts
it('a user steer into a running single chat resolves steered', async () => { /* chats.steer → true; no addTask */ })
it('a refused steer queues as a task', async () => { /* chats.steer → false; addTask called once; resolves queued */ })
it('command and todo messages queue', async () => { /* steer opt + command → chats.steer not called */ })
it('without the steer option a busy chat still queues', async () => { /* routine-style submit unchanged */ })
it('groups never steer', async () => { /* group meta → chats.steer not called */ })
it('chats:send passes steer only when true', async () => { /* rpc arg true → submit opts {steer:true}; 'yes' → rejected */ })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run zumi-bot-server/backend/tests/core/taskQueue.test.ts -t "steer"`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run backend tests and typecheck**

Run: `npx vitest run --project backend && npm run typecheck`
Expected: PASS.

---

### Task 6: Frontend state helpers

**Files:**
- Create: `zumi-bot-server/frontend/src/state/sendKeys.ts`
- Modify: `zumi-bot-server/frontend/src/state/sendFailure.ts`, `zumi-bot-server/frontend/src/net/api.ts`
- Test: `zumi-bot-server/frontend/tests/sendKeys.test.ts` (new), `zumi-bot-server/frontend/tests/sendFailure.test.ts`

**Interfaces:**
- Produces:
  - `export type SendHow = 'steer' | 'queue'`
  - `sendKeyAction(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }, coarse: boolean): SendHow | null` — Enter without modifiers on a fine pointer → `'steer'`; Ctrl/Cmd+Enter anywhere → `'queue'`; Shift+Enter, composing, or plain Enter on a coarse pointer → `null`
  - `rejectedSendState(items, id, tasks, steering?: readonly QueuedTask[])` — an id in `steering` reads `'queued'`
  - `api.chats.send(..., command, steer)` passes `steer` as the 7th RPC arg

- [ ] **Step 1: Write the failing tests**

```ts
it('maps keys to how a message is sent', () => {
  const k = (o: Partial<{ key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }>) =>
    ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...o })
  expect(sendKeyAction(k({}), false)).toBe('steer')
  expect(sendKeyAction(k({ ctrlKey: true }), false)).toBe('queue')
  expect(sendKeyAction(k({ metaKey: true }), true)).toBe('queue')
  expect(sendKeyAction(k({}), true)).toBeNull()
  expect(sendKeyAction(k({ shiftKey: true }), false)).toBeNull()
  expect(sendKeyAction(k({ isComposing: true }), false)).toBeNull()
})
it('rejectedSendState treats a steering id as queued', () => {
  expect(rejectedSendState([], 's-1', [], [{ id: 's-1', text: 'x', ts: 1 }])).toBe('queued')
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project frontend -t "maps keys|steering id"`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run frontend tests**

Run: `npx vitest run --project frontend`
Expected: PASS.

---

### Task 7: Composer, tray and bubble

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/Composer.tsx` (keys, Send long-press, tooltip, `onSend` signature)
- Modify: `zumi-bot-server/frontend/src/components/ChatView.tsx` (`onSend` pass-through, tray gets `steering`)
- Modify: `zumi-bot-server/frontend/src/App.tsx` (`sendFromComposer`, `sendMessage` take `how?: SendHow`; `steer` only when `'steer'`; `rejectedSendState` gets `chat.steering`)
- Modify: `zumi-bot-server/frontend/src/components/TasksTray.tsx` (steering rows above task rows; tray shows when either list is non-empty)
- Modify: `zumi-bot-server/frontend/src/components/MessageList.tsx` (no Edit/Resend/Fork on `item.steered`)
- Modify: the stylesheet that holds `.tasks-tray` rows (find with `grep -rn "tasks-tray" zumi-bot-server/frontend/src/styles`)

**Interfaces:**
- Consumes: `sendKeyAction`, `SendHow` (Task 6)
- Produces: `Composer` / `ChatView` prop `onSend: (text: string, pick?: CommandPick, workflowId?: string, how?: SendHow) => void`; other `onSend` users (NewChatView, IslandView, MessageEditor) unchanged

Copy: steering row label "Waiting for the agent's next step"; Send tooltip while a reply runs and the box has text: "Send into this reply (Enter) · Hold or Ctrl+Enter to queue". Long press: 500 ms `pointerdown` timer on the Send button; firing sends with `'queue'` and swallows the click that follows. Steering rows have no buttons.

- [ ] **Step 1: Implement the wiring** (no DOM tests exist; logic stays in Task 6's helpers)

- [ ] **Step 2: Typecheck and run all unit tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 3: Check it in the browser preview**

Build and run the server against a fake or real `claude`; in a single chat, send a long task, press Enter with "also do X" mid-reply: a steering row shows, then a bubble lands mid-reply. Ctrl+Enter mid-reply: a task row. A steered bubble shows no Edit/Resend/Fork. Screenshot as proof.

---

### Task 8: Docs and the e2e probe

**Files:**
- Create: `docs/architecture/mid-turn-messages.md`
- Modify: `CLAUDE.md` (index line under Docs by area; shorten another line to stay ≤ 16 384 bytes)
- Modify: `docs/architecture/edit-resend-fork.md`, `docs/architecture/data.md` (`steering`), `docs/architecture/ui.md` (keys, tray), `docs/architecture/e2e.md`, `zumi-bot-server/backend/src/core/chat/CLAUDE.md` (pointer for `steer.ts`)
- Modify: the user docs page about sending and the task queue in `zumi-bot-docs/src/content/docs/chatting/` (find it with `grep -rln "queue" zumi-bot-docs/src/content/docs/chatting`)
- Create: `zumi-bot-server/e2e/steerProbe.mjs` (pattern: `thinkingProbe.mjs`), add `&& node zumi-bot-server/e2e/steerProbe.mjs --soft` to the root `e2e` script

**Interfaces:**
- Consumes: everything above
- Produces: `steerProbe.mjs` runs the installed `claude` with `--replay-user-messages`, sends a prompt that sleeps in Bash, writes a second message during the tool, and passes when the replay of that uuid arrives before the single `result`; `--soft` reports instead of failing when `claude` is missing

- [ ] **Step 1: Write the docs** (the area doc: the CLI behaviour with the probe's numbers, the close rule, the gate, hand-back, cost growth, Edit's cut)

- [ ] **Step 2: Write `steerProbe.mjs` and run it**

Run: `node zumi-bot-server/e2e/steerProbe.mjs`
Expected: a pass line naming the CLI version.

- [ ] **Step 3: Run the repo doc tests and the full suite**

Run: `npx vitest run --project shared && npm test && npm run typecheck`
Expected: PASS (root CLAUDE.md within 16 KB, every area doc named exists).
