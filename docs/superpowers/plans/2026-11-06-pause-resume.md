# Pause and Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Pause action that lets running subagents finish while the main agent starts nothing new, then ends the reply cleanly and holds the chat until Resume. Also keep each chat's CLI temp files out of `/tmp` so they survive a reboot, and tell an agent which subagents a hard Stop killed.

**Architecture:** A `PreToolUse` hook, merged into every main run's one `--settings`, blocks main-thread tool calls while a per-chat flag file exists. It tells main-thread calls from subagent calls by the hook input's `agent_id`. `TaskQueue` orchestrates pause and resume across `ChatService`, `GroupService` and the store. `ChatMeta.pause` (`pausing` | `paused`) is the source of truth. Every CLI run of a chat gets `CLAUDE_CODE_TMPDIR=<data>/claude-tmp/<hash>`, and the flag file lives in that same folder.

**Tech Stack:** Node 22 + TypeScript (backend, shared), React 19 (frontend), vitest, playwright-core e2e with the fake claude.

**Spec:** `docs/superpowers/specs/2026-11-06-pause-resume-design.md` (read it first; this plan argues from it).

## Global Constraints

- **No commits.** The user commits. Leave every change uncommitted (user's global rule; overrides the skill's commit steps).
- Never add `--dangerously-skip-permissions` or `bypassPermissions`.
- **One `--settings` per run.** Every `--settings` goes through `claudeRunner.oneSettings` (`buildArgs` already merges them).
- **Side runs stay as they are.** They get no pause hook and no `ZUMIBOT_PAUSE_FILE`. Their `--settings` must stay byte for byte as today (`SIDE_GUARD_SETTINGS` / `SIDE_GUARD_ASKING`, plus desktop rules).
- **No prompt change.** Nothing is added to any system prompt or tool list for pause. Hooks and env only.
- **Pinned block text.** It is `PAUSE_BLOCK_TEXT`, verbatim: `The user paused this task (zumibot-pause). Do not start any tool or subagent. In a few lines, say where the task stands and what the next step is, then end your reply.`
- **Notice.** The kind is `userPaused` and its text is `Paused. Press Resume to continue.` The existing `paused` kind stays the room hop cap's.
- `RESUME_TEXT` is `Continue`.
- **Safety cap.** `PAUSE_BLOCK_CAP` is `3`: that many blocked main-thread rounds (a round = one model response's calls: calls with the same `message.id` on the parser's `toolUse` event are one round; without ids, a new round starts when a main `toolUse` follows a `toolResult`) while nothing runs, checked only on a blocked result, and the server ends the run.
- **Temp root.** It is `<data dir>/claude-tmp`, with one folder per chat named `sha256(chatId)` hex, first 16 chars. Folders are 0700. The pause flag is `<chat folder>/.zumibot-paused`.
- **Sync.** `claude-tmp` is never synced: add it to `LOCAL_ONLY_EXCLUDES` in `deploy/sync.mjs`.
- **Fake e2e costs no quota.** E2e suites added here use only the fake claude.
- **Code style.** Comments are short and say *why*. Dependencies are pinned to exact versions, and none are added here.

## Review Focus

1. **Parallel calls.** The main agent sends `Agent` and `Bash` in one message, and Pause lands between them, so one is allowed and one is blocked. The safety cap must not fire while the allowed call still runs. Test in Task 4.
2. **Main-thread approval card at Pause time.** The card stays pending, answering it runs the tool, and the pause lands after. Nothing auto-denies it. Test in Task 4.
3. **Restart mid-pause.** The chat comes back `paused`, with the `interrupted` notice then `userPaused`, the tray held, and Resume offered. Test in Task 8.
4. **An hourly routine into a chat paused for days.** Tasks pile up held until `TASKS_MAX` (50). The 51st routine run fails with the cap error, and nothing else breaks. Test in Task 7.
5. **A stale flag file** left by a crash must not block a later normal run. Test in Task 4.

---

### Task 1: Shared pause types, texts and the lost-subagent note

**Files:**
- Create: `zumi-bot-server/shared/src/pause.ts`
- Modify: `zumi-bot-server/shared/src/types.ts`: `ChatMeta`, `GroupInfo`, `NoticeKind`, `NOTICE_TEXT`, `ZumiBotApi.chats`
- Test: `zumi-bot-server/shared/tests/pause.test.ts` (match the folder the shared project's other tests use)

**Interfaces:**
- Produces, from `@zumibot/shared/pause`:
  - `PAUSE_MARKER = '(zumibot-pause)'`
  - `PAUSE_BLOCK_TEXT` (exact text in Global Constraints)
  - `RESUME_TEXT = 'Continue'`
  - `PAUSE_BLOCK_CAP = 3`
  - `type PauseState = 'pausing' | 'paused'`
  - `lostNote(descriptions: readonly string[]): string | null`
- Produces in `types.ts`:
  - `ChatMeta.pause?: PauseState`
  - `ChatMeta.lost?: string[]` (single chat: descriptions of subagents a stop killed)
  - `GroupInfo.paused?: { members: string[]; queue: <same entry type as GroupInfo.queue>[] }`
  - `GroupInfo.lost?: Record<string, string[]>` (by member)
  - `NoticeKind` gains `'userPaused'`, with `NOTICE_TEXT.userPaused = 'Paused. Press Resume to continue.'`
  - `ZumiBotApi.chats.pause(chatId: string): Promise<void>`
  - `ZumiBotApi.chats.resume(chatId: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
it('returns null for no lost subagents', () => expect(lostNote([])).toBeNull())
it('lists each lost subagent once, with a fallback for an empty description', () => {
  const t = lostNote(['Scan logs', ''])!
  expect(t).toContain('Your last reply was stopped while these subagents were running.')
  expect(t).toContain('- Scan logs')
  expect(t).toContain('- (no description)')
  expect(t).toContain('Run them again if you still need them.')
})
it('caps the list at 20 and says how many more', () => {
  const t = lostNote(Array.from({ length: 23 }, (_, i) => `job ${i}`))!
  expect(t).toContain('- job 19'); expect(t).not.toContain('- job 20'); expect(t).toContain('and 3 more')
})
it('marks the block text so the server can count blocked calls', () => expect(PAUSE_BLOCK_TEXT).toContain(PAUSE_MARKER))
```

- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run --project shared -t lostNote`. Expected: FAIL, the module is not found.
- [ ] **Step 3: Implement `pause.ts` and the type additions.** The note's first line is `Your last reply was stopped while these subagents were running. They are not running now and their results are lost:`, then one `- <description>` line each, then `Run them again if you still need them.`.
- [ ] **Step 4: Run the tests and see them pass.** Run `npx vitest run --project shared` and `npm run typecheck`. Expected: PASS. The typecheck may flag places that build `Record<NoticeKind, …>`; fix those.

---

### Task 2: Per-chat CLI temp folder (spec goal 7)

**Files:**
- Create: `zumi-bot-server/backend/src/core/chat/chatTmp.ts`
- Modify:
  - `backend/src/core/chat/chatService.ts`: deps, `SideBase`, the env in `attempt`
  - `backend/src/core/btw/sideRun.ts`: env
  - `backend/src/app.ts`: build `ChatTmp`, `baseFor`, the startup sweep
  - `backend/src/rpc/handlers.ts`: `chats:remove`
  - `deploy/sync.mjs`: `LOCAL_ONLY_EXCLUDES`
  - `backend/tests/fixtures/fake-claude.mjs`: `FAKE_INVOCATIONS_OUT` gains `tmpdir`
- Test:
  - `backend/tests/core/chatTmp.test.ts`
  - `backend/tests/core/chatService.test.ts`
  - `backend/tests/core/sideRun.test.ts`
  - `backend/tests/rpc/handlers.test.ts`
  - `backend/tests/sync.test.ts`: its `LOCAL_ONLY` list

**Interfaces:**
- Produces `class ChatTmp`:
  - `constructor(root: string)`
  - `dirOf(chatId: string): string`
  - `ensure(chatId: string): Promise<string>`: creates 0700 and returns `dirOf`.
  - `pauseFlagOf(chatId: string): string`
  - `remove(chatId: string): Promise<void>`
  - `sweep(liveIds: Iterable<string>): Promise<number>`: removes folders whose name matches no live id's hash, and returns the count.
- Produces `ChatServiceDeps.tmp?: Pick<ChatTmp, 'ensure' | 'pauseFlagOf'>`.
- Produces `SideBase.tmpDir: string | null`.

- [ ] **Step 1: Write the failing tests**
  - **chatTmp:**
    - `dirOf` is `join(root, sha256hex(id).slice(0, 16))`, the same for the same id and different for different ids.
    - `ensure` makes the folder with mode `0o700`.
    - `remove` deletes it and a missing one is fine.
    - `sweep(['a'])` removes the folder of `b` and keeps `a`'s, and a stray file in `root` is left alone.
    - `pauseFlagOf(id)` is `join(dirOf(id), '.zumibot-paused')`.
  - **chatService:** a turn's spawned env has `CLAUDE_CODE_TMPDIR === tmp.dirOf(chatId)`. So does a compact run's and an asked (`runAsked`) run's. `sideBase(chatId, agent).tmpDir` equals it.
  - **sideRun:** with `base.tmpDir = '/x'`, the run's env has `CLAUDE_CODE_TMPDIR: '/x'` even with no browser or desktop. With `null`, the env has no such key.
  - **handlers:** `chats:remove` calls `tmp.remove(id)` after the chat is stopped.
  - **sync:** `claude-tmp` is in the local-only list.
- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run --project backend chatTmp chatService sideRun handlers sync`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **chatService:** `attempt` awaits `tmp.ensure(chatId)` once per attempt and adds it to the merged env. The `env` is then always defined when `tmp` is wired.
  - **sideRun:** the run options always pass an env when `base.tmpDir` is set.
  - **app.ts:**
    - `const tmp = new ChatTmp(join(dataDir, 'claude-tmp'))`.
    - `baseFor` sets `tmpDir: await tmp.ensure(chatId)`.
    - After the chats load, at start: `step('sweeping chat temp folders', () => tmp.sweep((await chats.list()).map(c => c.id)))`. Log only the count.
  - **fake-claude:** add `tmpdir: process.env.CLAUDE_CODE_TMPDIR ?? null` to the invocation line.
  - Moderator, room summary and pick calls are unchanged.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command, then `npm run typecheck`. Expected: PASS.

---

### Task 3: The pause hook and its settings

**Files:**
- Create: `backend/src/core/chat/pauseSettings.ts` (pure)
- Create: `backend/src/core/chat/pauseHook.ts` (child entry)
- Modify: `backend/vite.config.ts`: `input.pauseHook`
- Modify: `backend/src/core/browser/browserRuntime.ts`: add `pauseHookEntry: entry('pauseHook')`, and keep it out of the browser `checkAssets`
- Test: `backend/tests/core/pauseSettings.test.ts`, `backend/tests/browserPackaging.test.ts` (the new entry is shipped)

**Interfaces:**
- Produces `blocks(input: string): boolean`. It is `false` only when the input parses as a JSON object with a non-empty string `agent_id` at the top level, and `true` otherwise (main thread, bad JSON).
- Produces `pauseSettings(o: { node: string; entry: string; electronNode: boolean }): string`. It returns the JSON `{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":CMD}]}]}}`, where CMD is `[ -e "$ZUMIBOT_PAUSE_FILE" ] || exit 0; [ELECTRON_RUN_AS_NODE=1 ]exec '<node>' '<entry>'`. Paths are single-quoted, with `'` written as `'\''`.
- The `pauseHook.ts` entry reads all of stdin. It writes `PAUSE_BLOCK_TEXT` to stderr and exits 2 when `blocks()`, and exits 0 otherwise. It deletes `ELECTRON_RUN_AS_NODE` from its own env first, as the bridges do.

- [ ] **Step 1: Write the failing tests**

```ts
it('lets subagent calls through', () => expect(blocks('{"tool_name":"Bash","agent_id":"a1"}')).toBe(false))
it('blocks main-thread calls, even with agent_type (an --agent session has it)', () => expect(blocks('{"tool_name":"Agent","agent_type":"helper"}')).toBe(true))
it('blocks unreadable input', () => expect(blocks('not json')).toBe(true))
it('ignores an agent_id nested in tool_input', () => expect(blocks('{"tool_input":{"agent_id":"x"}}')).toBe(true))
it('exits 0 without running node when the flag is absent', () => {
  const cmd = JSON.parse(pauseSettings({ node: '/nonexistent/node', entry: '/x.mjs', electronNode: false })).hooks.PreToolUse[0].hooks[0].command
  expect(spawnSync('sh', ['-c', cmd], { env: { ZUMIBOT_PAUSE_FILE: join(tmp, 'none') } }).status).toBe(0)
})
it('runs the entry when the flag exists (exit code passes through)', () => {
  // the entry is a fixture script that exits 2
  expect(spawnSync('sh', ['-c', cmdFor(process.execPath, exitTwoFixture)], { env: { ZUMIBOT_PAUSE_FILE: flag } }).status).toBe(2)
})
it('quotes paths with spaces and quotes', () => expect(cmdFor("/a b/it's/node", '/e.mjs')).toContain(`'/a b/it'\\''s/node'`))
it('prefixes ELECTRON_RUN_AS_NODE only for Electron node', () => expect(cmdFor('/n', '/e', true)).toContain('ELECTRON_RUN_AS_NODE=1 exec'))
```

- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run --project backend pauseSettings`. Expected: FAIL.
- [ ] **Step 3: Implement both files, the vite input and the runtime field.**
- [ ] **Step 4: Run the tests and see them pass.** Run the same command, then `npm run build:server` and `ls zumi-bot-server/backend/dist/pauseHook.mjs`. Expected: PASS, and the file exists.

---

### Task 4: ChatService: pause flag, hook wiring, safety cap, single-chat pause end

**Files:**
- Modify: `backend/src/core/chat/chatService.ts`
- Modify: `backend/src/app.ts`: pass `pauseSettings(...)`
- Test: `backend/tests/core/chatService.test.ts`

**Interfaces:**
- Consumes:
  - `ChatTmp.pauseFlagOf` (Task 2)
  - `pauseSettings` (Task 3)
  - `PAUSE_MARKER`, `PAUSE_BLOCK_CAP`, `NOTICE_TEXT.userPaused` (Task 1)
- Produces:
  - `ChatServiceDeps.pauseHook?: { settings: string }`
  - `ChatService.setPauseFlag(chatId: string, on: boolean): Promise<void>`: writes an empty file, or removes it with `force`.
  - `ChatService.finishPause(chatId: string): Promise<ChatMeta | null>`. When `meta.pause === 'pausing'` it:
    - appends a `userPaused` notice to the stored items (after whatever ended the turn),
    - sets `pause: 'paused'`,
    - calls `store.holdTasks`,
    - removes the flag,
    - and returns the meta. Otherwise it returns null.

    GroupService calls it at room end (Task 6). ChatService calls it for single chats where a single chat's turn ends, before `release`/`onIdle`.

- [ ] **Step 1: Write the failing tests**
  - **Main runs get the hook.** A single-chat turn's args hold exactly one `--settings`, whose merged JSON has a `PreToolUse` entry with the pause command. Its env has `ZUMIBOT_PAUSE_FILE === tmp.pauseFlagOf(chatId)`. A desktop agent's run still has the 8 ask rules in that same one settings.
  - **Compact and side runs do not.** A compact run has no pause hook and no `ZUMIBOT_PAUSE_FILE`. `sideBase().args.extraArgs` has no pause `--settings`, so side runs stay as today.
  - **Stale flag** (Review 5). A flag file left from before, with `meta.pause` unset, is gone once the attempt spawns.
  - **Clean pause end.** The fake runner emits a main tool result containing `PAUSE_MARKER`, then a result. With `meta.pause = 'pausing'`, the stored items end with a `userPaused` notice, `meta.pause === 'paused'`, tasks are held, and the flag is removed.
  - **Stop while pausing.** The items end `stopped` then `userPaused`, the pause is `paused`, and `onIdle` started no task (the tray is held).
  - **Safety cap.** Three main-thread blocked results while no main tool is open and no dispatch runs: the run is stopped with no `stopped` notice, then `userPaused`.
  - **Parallel calls** (Review 1). A main `Bash` tool use is open (no result yet) when the 3rd blocked result arrives: no stop. Once its result arrives with the cap reached, the run is stopped.
  - **Approval card at Pause** (Review 2). A pending main-thread approval stays `pending` after `setPauseFlag(chatId, true)`. Answering it allow sends the allow response unchanged.
- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run --project backend chatService -t pause`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - In `attempt`, for main runs only (`!spec.compact`), add `['--settings', pauseHook.settings]` after the desktop args and add `ZUMIBOT_PAUSE_FILE` to the env. Before the spawn, remove the flag unless the stored meta is `pausing`.
  - Count blocked calls from main-thread `toolResult` events whose text includes `PAUSE_MARKER`. Track open main-thread tool ids from `toolUse`/`toolResult`, and read running dispatches through `dispatched.entries()`.
  - The cap stop marks the turn so the end path adds no `stopped` notice.
- [ ] **Step 4: Run the tests and see them pass.** Run `npx vitest run --project backend chatService`. Expected: PASS, with every older test still green.

---

### Task 5: TaskQueue pause and resume, the RPCs, and sends while paused

**Files:**
- Modify:
  - `backend/src/core/chat/taskQueue.ts`
  - `backend/src/rpc/handlers.ts`: `chats:pause`, `chats:resume`, and both in `writable()`
  - `backend/src/core/store/chatStore.ts` (only if a helper is needed)
  - `frontend/src/net/api.ts`: map both
- Test: `backend/tests/core/taskQueue.test.ts`, `backend/tests/rpc/handlers.test.ts`

**Interfaces:**
- Consumes:
  - `ChatService.setPauseFlag` (Task 4)
  - `GroupService.requestPause` and `GroupService.resume` (Task 6). Stub them in these tests.
  - `RESUME_TEXT` (Task 1)
- Produces:
  - `TaskQueue.submit(chatId, text, stagedIds, replyTo?, messageId?, command?, todo?, from: 'user' | 'routine' = 'user')`
  - `TaskQueue.pause(chatId: string): Promise<void>`. It throws `Chat is not running` when idle, `Chat is compacting` while `meta.compacting` is set or a room member compacts, and `Chat is already paused` when `meta.pause` is set. Otherwise it:
    - sets `pause: 'pausing'`,
    - calls `setPauseFlag(true)`,
    - calls `holdTasks`,
    - calls `groups.requestPause` for a room,
    - and pushes the meta.
  - `TaskQueue.resumePaused(chatId: string): Promise<void>`. It throws `Chat is not paused` or `Chat is busy`. Otherwise it:
    - clears `pause` and `held` in one update,
    - pushes the meta,
    - and launches `chats.send(chatId, RESUME_TEXT, [])` for a single chat, or `groups.resume(chatId)` for a room.

    It resolves when that run ends, like `sendTask`.

- [ ] **Step 1: Write the failing tests**
  - **pump.** It never starts a task while `meta.pause` is `pausing` or `paused`.
  - **Routine sends.**
    - A `from: 'routine'` submit into an idle `paused` chat queues and leaves the chat `held`.
    - The same into a chat with no pause launches as today.
    - At 50 queued tasks a paused routine submit rejects with `A chat can hold at most 50 queued messages` (Review 4).
  - **User sends.**
    - A user submit into an idle `paused` chat launches at once and clears `pause`. Older tasks stay held, and the next idle pumps none. In a room it also clears `GroupInfo.paused`, because the user took over.
    - A user submit into a `pausing` (running) chat queues and holds.
  - **pause().** On an idle chat it throws `Chat is not running`. On a running one it sets `pausing`, writes the flag and holds.
  - **resumePaused().** On a paused single chat it sends `Continue`, and the held tasks pump after that run. On a room it calls `groups.resume`.
  - **Edits clear the pause.** `rerun` and `switchVersion` on a paused chat clear `pause`.
  - **handlers.** `chats:pause` and `chats:resume` check `chatId` and are refused in an A→B chat with `This chat is read-only`.
- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run --project backend taskQueue handlers`. Expected: FAIL.
- [ ] **Step 3: Implement.** Pass `from: 'user'` from `chats:send` implicitly (the default), and add the two handlers and the api mapping.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command, then `npm run typecheck`. Expected: PASS.

---

### Task 6: Rooms: pausing, saved queue, Resume addressing paused members

**Files:**
- Modify: `backend/src/core/chat/groupService.ts`
- Modify: `backend/src/core/store/chatStore.ts`: `renameAgent` moves names in `GroupInfo.paused` and the keys of `GroupInfo.lost`
- Test: `backend/tests/core/groupService.test.ts`, `backend/tests/core/chatStore.test.ts`

**Interfaces:**
- Consumes: `ChatService.finishPause` (Task 4), `RESUME_TEXT` (Task 1).
- Produces:
  - `GroupService.requestPause(chatId: string): boolean`. It is false when the room is not running.
  - `GroupService.resume(chatId: string): Promise<void>`. It posts `@m1 @m2 Continue` (plain `Continue` when `paused.members` is empty) as a user message. Once that message is routed, it appends the saved queue's entries for members not already queued, then clears `GroupInfo.paused`.
  - The existing private `pause` is renamed `hopPause`.

- [ ] **Step 1: Write the failing tests**
  - **While pausing.** After `requestPause` with members A (working) and B (queued): B never starts, A's finished reply is not routed to the moderator, and the room ends. Then:
    - `GroupInfo.paused` is `{members: ['A'], queue: [B's entry]}`,
    - the last item is a `userPaused` notice,
    - `meta.pause === 'paused'`,
    - and `queue` and `active` are empty.
  - **Moderator in flight.** If the moderator was routing when Pause was pressed, its planned queue is what gets saved.
  - **resume().** It posts `@A Continue`. After A's turn, B runs, and `GroupInfo.paused` is gone.
  - **Stop while pausing.** The items end `stopped` then `userPaused`, and `paused` is saved.
  - **Rename.** Renaming A to A2 moves it inside `GroupInfo.paused.members`, `paused.queue` and `lost`.
- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run --project backend groupService chatStore`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Add `pausing` and `pausedMembers` to `Room`.
  - `startReady` returns none while pausing, and agent inbox entries are dropped while pausing.
  - At loop end, when pausing, save `paused` before the queue is cleared, then call `chats.finishPause`.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command. Expected: PASS.

---

### Task 7: Routines and a paused chat

**Files:**
- Modify: `backend/src/core/routines/routineRunner.ts`
- Test: `backend/tests/core/routineRunner.test.ts`

**Interfaces:**
- Consumes: `TaskQueue.submit(..., from)` (Task 5) and `ChatMeta.pause` (Task 1).

- [ ] **Step 1: Write the failing tests**
  - **Paused target.** A run into a `paused` existing chat with `sessionPolicy: 'fresh'`:
    - `startFresh` is not applied (`next` unchanged),
    - the message is submitted with `from: 'routine'`,
    - and the run stays `running` while its message is in `tasks`.
  - **The user pauses the routine's own run.** The turn ends with a `userPaused` notice, so the run ends `failed` with error `Paused by you` and cause `user`, and no `routine-failed` fires.
  - **Limit wait.** A `limited` run whose chat is paused when the wait comes due ends `failed` `Continued by hand` (cause `user`), and no `continue` is submitted.
  - **The 51st run** into a paused chat holding 50 tasks fails with the cap error (Review 4).
- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run --project backend routineRunner`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Skip `startFresh` when `chat.pause` is set.
  - Pass `'routine'` on both `submit` calls.
  - In `resume()`, check the chat's pause first.
  - In `settle`, check the turn's items for a `userPaused` notice before deciding done or failed.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command. Expected: PASS.

---

### Task 8: Restart recovery of a pausing chat

**Files:**
- Modify: `backend/src/core/store/chatStore.ts`: `recoverInterrupted`
- Test: `backend/tests/core/chatStore.test.ts`

- [ ] **Step 1: Write the failing test** (Review 3). A chat stored with `inFlight: true`, `pause: 'pausing'` and two tasks recovers to:
  - items ending `interrupted` then `userPaused`,
  - `pause: 'paused'`,
  - `held: true`,
  - `inFlight: false`.

  A room recovers the same, keeping `GroupInfo.paused` if it is set, or saving `{members: [the members in active], queue: [the stored queue]}` when it is not. A chat with `pause: 'pausing'` and `inFlight: false` is moved to `paused` with a `userPaused` notice.
- [ ] **Step 2: Run the test and see it fail.** Run `npx vitest run --project backend chatStore -t pausing`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `recoverInterrupted`, after the interrupted handling.
- [ ] **Step 4: Run the tests and see them pass.** Run `npx vitest run --project backend chatStore`. Expected: PASS.

---

### Task 9: Telling the agent about subagents a stop killed (spec goal 6)

**Files:**
- Modify: `backend/src/core/chat/chatService.ts`: `TurnSpec`, turn end, note on the next attempt
- Modify: `backend/src/core/chat/groupService.ts`: per-member `lost`, via the member turn spec
- Test: `backend/tests/core/chatService.test.ts`, `backend/tests/core/groupService.test.ts`

**Interfaces:**
- Consumes: `lostNote` (Task 1).
- Produces:
  - `TurnSpec.lost?: string[]`
  - `TurnSpec.saveLost?(descriptions: string[] | null): Promise<unknown>`

  Single chats read and write `ChatMeta.lost`, and rooms `GroupInfo.lost[member]`.

- [ ] **Step 1: Write the failing tests**
  - **Recording.** A turn stopped while two top-level dispatches and one nested dispatch run stores `lost` as the two top-level descriptions only. The nested one's parent covers it.
  - **Next turn.** The next turn's stdin ends with `lostNote(...)`, after any to-do note, and `lost` is cleared once that attempt spawns.
  - **No note.** A cut run (`resumeAt`), a reseed and a compact add no note, and the cut run and reseed clear `lost`.
  - **Pause.** A pause end, the clean path or the cap stop, records no `lost`.
  - **Rooms.** Member A's `lost` reaches only A's next turn.
- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run --project backend chatService groupService -t lost`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Collect the descriptions before `dispatched.end(...)`.
  - Add the note the way `withTodoNote` does (`withTrailingText`).
  - A failed save is logged by its code only and never fails a turn.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command without `-t`. Expected: PASS.

---

### Task 10: Frontend: Pause button, pausing line, Resume pill

**Files:**
- Create: `frontend/src/state/pause.ts`
- Modify:
  - `frontend/src/components/Composer.tsx`
  - `frontend/src/components/ChatView.tsx`
  - `frontend/src/components/MessageList.tsx`: `OtherRow` and the `continueAt` logic
  - the working tray component (find where "working…" renders for a running chat)
  - `frontend/src/App.tsx`: wire `api.chats.pause` and `resume`, with errors through `failChat`
  - `frontend/src/styles.css`
- Test: `frontend/tests/pause.test.ts`, `frontend/tests/tasks.test.ts`

**Interfaces:**
- Consumes: `ChatMeta.pause` and `NOTICE_TEXT.userPaused` (Task 1), and `api.chats.pause`/`resume` (Task 5).
- Produces:
  - `pauseControl(chat: Pick<ChatMeta, 'inFlight' | 'pause' | 'compacting' | 'asked'>): 'pause' | 'pausing' | null`. It is null when not in flight, compacting or asked, `'pausing'` when `pause === 'pausing'`, and `'pause'` otherwise.
  - `resumeRow(items: readonly ChatItem[], chat: Pick<ChatMeta, 'inFlight' | 'pause'>): string | null`. It returns the id of the last `userPaused` notice, only when `pause === 'paused'` and not in flight.
  - `pausingLine(running: number): string`. It returns `Pausing…` for 0, `Pausing — waiting for 1 subagent` for 1, and `Pausing — waiting for N subagents` for more.

- [ ] **Step 1: Write the failing tests**
  - **pauseControl.** It returns null for an idle chat, a compacting chat and an asked chat; `'pause'` for a running chat; and `'pausing'` for a pausing one.
  - **resumeRow.** It finds the last `userPaused` notice of a paused chat, and returns null while in flight or once `pause` is cleared.
  - **pausingLine.** It returns the exact strings above for 0, 1 and 3.
  - **tasks.test.** `queues()` sends straight in for a paused idle chat with held tasks, and queues for a pausing (in flight) chat.
- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run --project frontend pause tasks`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Pause button.** A Pause button (`data-testid="pause-button"`, `aria-label="Pause"`) sits beside Stop whenever Stop shows and `pauseControl` is not null. It is disabled with the title `Pausing…` while pausing. It fits on a phone layout next to Stop.
  - **Resume pill.** `OtherRow` gets the Resume pill (`data-testid="resume-button"`, label `Resume`) on `resumeRow`, using the `continue-pill` styles.
  - **Pausing line.** The working tray shows `pausingLine(n)`, with `n` the running dispatch count the side panel's badge already uses.
- [ ] **Step 4: Run the tests and see them pass.** Run the same command, then `npm run typecheck`. Expected: PASS.

---

### Task 11: Fake-claude hooks, `e2e:pause`, the real-CLI probe, docs

**Files:**
- Modify: `backend/tests/fixtures/fake-claude.mjs`: the `#PRE_TOOL` directive and `FAKE_HOOKS_OUT`
- Create:
  - `zumi-bot-server/e2e/pause.e2e.mjs`
  - `zumi-bot-server/e2e/pauseProbe.mjs`
  - `backend/tests/pauseProbe.test.ts`
- Modify: the root `package.json`
  - Add `"e2e:pause": "npm run build && node zumi-bot-server/e2e/pause.e2e.mjs"`.
  - Append ` && node zumi-bot-server/e2e/pauseProbe.mjs --soft` to `e2e`.
- Modify: `CLAUDE.md`: a **Pause and Resume** paragraph in Architecture, a Data entry for `claude-tmp/`, the `e2e:pause` line under Commands, and the probe's sentence beside the other probes.
- Modify: the spec's `Status:` line to `approved`.

**Interfaces:**
- **`#PRE_TOOL {"id": string, "tool": string, "agentId": string | null, "parent"?: string}`.**
  - It runs each `PreToolUse` hook command from the merged `--settings` in argv whose matcher (`*` or a regex) matches `tool`. It uses `sh -c` with stdin `{"hook_event_name":"PreToolUse","tool_name":tool,"tool_input":{},"tool_use_id":id}`, plus `agent_id` and `agent_type` when `agentId` is set.
  - On exit 2 it writes a tool-result stream line for `id` with `is_error: true` and the hook's stderr as content, using `parent_tool_use_id: parent ?? null`, and then carries on with the script.
  - It appends `{id, tool, agentId, blocked}` to `FAKE_HOOKS_OUT` when that is set.
- **`pauseProbe.mjs`.** It exports `verdict(lines: string[]): 'PASS' | 'FAILED' | 'INCONCLUSIVE'`, which is pure over the CLI's stream lines.
  - **PASS:** a subagent tool result containing `sub-ok`, and a main-thread tool result containing `PAUSE_MARKER`.
  - **FAILED:** a main-thread `echo main-ok` result after the flag was set.
  - **INCONCLUSIVE:** anything else.
  - The script spawns the real CLI in auto mode with `--settings pauseSettings(...)`, asking for one subagent that runs `echo sub-ok`, then `echo main-ok` itself. It creates the flag file when the first `task_started` line or `Agent` tool use appears.
  - It exits 0 / 1 / 2, retries once on 2, turns 2 into 0 with a loud warning under `--soft`, and is skipped with `ZUMIBOT_SKIP_PAUSE_PROBE=1`.

- [ ] **Step 1: Write the failing tests.** `pauseProbe.test.ts` covers `verdict` against three canned line sets (pass, failed, inconclusive).
- [ ] **Step 2: Run the tests and see them fail.** Run `npx vitest run --project backend pauseProbe`. Expected: FAIL.
- [ ] **Step 3: Implement the fake directive, the probe and the e2e.** `pause.e2e.mjs` uses only the fake claude, so it costs no quota, and drives the built server with headless Chrome through `harness.mjs`.
  - **Script.** A main `Agent` dispatch with the CLI's task lines. The subagent runs `#PRE_TOOL` with `agentId` (allowed), then `#SLEEP 3000`, then its result. Then a main `#PRE_TOOL` for `Agent` (blocked, since the test pressed Pause during the sleep), then the status text and the result.
  - **Checks:**
    1. Pause is pressed mid-sleep and the subagent still finishes (`FAKE_HOOKS_OUT` shows the sub call allowed and the main call blocked).
    2. `userPaused` shows with a Resume pill.
    3. A message typed while pausing sits held, with Send now.
    4. A restart of the server keeps the chat paused.
    5. Resume sends `Continue`, and the held message goes after it.
    6. `FAKE_INVOCATIONS_OUT` shows `tmpdir` under the data dir's `claude-tmp`.
- [ ] **Step 4: Run all the checks and see them pass.**
  - Run `npx vitest run --project backend pauseProbe`, then `npm test`, then `npm run typecheck`, then `npm run e2e:pause`. Expected: all PASS.
  - Also run `npm run e2e:dispatch` and `npm run e2e:btw`: side runs and dispatches must be unchanged.
  - Last, ask the user before running `node zumi-bot-server/e2e/pauseProbe.mjs`, since it uses real quota. Expected: PASS.
