# Run button on shell blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Run button on single-line shell blocks in an agent's finished reply. A click runs the command as a background process in the chat's folder; when it ends, the block's author gets one hidden `<bash-input>/<bash-stdout>` message and continues. Each run is written to the audit log.

**Architecture:**
- **Server:** user runs are `ProcessService` records with a `run` mark. Their end raises a `RunEndEvent`. `RunResults` turns that event into a hidden user message through `TaskQueue` (`from: 'run'`), and an audit writer turns it into one `AuditRecord`.
- **Client:** the client reads run state from the chat's process list. A per-bubble context turns `CodeBlock` into Run plus status.
- **Agents:** a fixed `RUN_SYSTEM` paragraph tells agents how to hand over commands.

**Tech Stack:** TypeScript, Node 22, React 19, react-markdown 10, vitest, headless-Chrome e2e harness.

**Spec:** `docs/superpowers/specs/2026-11-24-run-command-blocks-design.md`. Read it with this plan. All paths below are under `zumi-bot-server/` unless they start with `docs/` or are root files.

## Global Constraints

- **Do not commit.** The user commits by hand (global rule). Every "commit" point below is a "stop and report" point.
- No new dependencies; versions stay pinned.
- Never `--dangerously-skip-permissions` or `bypassPermissions`.
- Secrets never in logs, URLs or error messages.
- ZumiBot's own logs carry only codes and ids, never a command, cwd or output.
- A process env stays as today: no vault keys, no `ZUMIBOT_*`, no capability tokens.
- Command rule: 1–4 000 characters, no NUL (`commandError`), one line.
- Shell tags: `bash`, `sh`, `shell`, `zsh` (case-insensitive).
- Limits stay: 5 running per chat, 20 per server.
- End message output: tail, at most `16 * 1024` bytes, ANSI stripped, lines cut at 2 000 characters, scrubbed with the author's vault values.
- Comments are short and say why.
- Tooltips use `data-tip`, never `title` (`tests/noTitleAttribute.test.ts`).
- Root `CLAUDE.md` stays under 16 KB (`shared/tests/repoDocs.test.ts`).
- New API method touches `shared/src/types.ts` `ZumiBotApi`, `backend/src/rpc/handlers.ts` and `frontend/src/net/api.ts`.

## Review Focus

1. **Output that looks like markup** (`</bash-stdout>`, `<bash-input>`, a code fence, `&amp;`): the agent must receive it escaped. The format must stay intact. → Task 1 `escapes markup in command and output`.
2. **A run that ends while the agent's own turn runs:** the message waits in the queue, is not `auto`, is not in the tasks tray, and goes at the idle. → Task 3 `run message queues while busy and keeps its mark` and Task 8 `hidden tasks leave the tray list`.
3. **Server restart while a run is running:** no message, and one audit record `interrupted` / `lost at restart`. → Task 2 `lost run raises end with no message`.
4. **Chat archived while a run is running:** the tree is ended, no message is sent, an audit record is written. → Task 2 `archive ends run with no message`.
5. **A vault value printed by the command:** scrubbed in the message text. → Task 2 `run tail is scrubbed`.

---

### Task 1: Shared run-block helpers and types

**Files:**
- Create: `shared/src/runBlocks.ts`
- Modify: `shared/src/processes.ts` (add `ProcessRun`, `ProcessInfo.run`)
- Modify: `shared/src/types.ts` (user `ChatItem` and `QueuedTask` get `run?: RunMark`)
- Test: `shared/tests/runBlocks.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // shared/src/runBlocks.ts
  export const RUN_SHELL_LANGS: readonly ['bash', 'sh', 'shell', 'zsh']
  export const RUN_OUTPUT_MAX: number // 16 * 1024
  export interface RunMark { processId: string }
  export type RunEnd =
    | { kind: 'exit'; code: number }
    | { kind: 'signal'; signal: string }
    | { kind: 'stopped'; by: 'user' | 'lifetime' }
  export const RUN_REFUSALS: { notBlock: string; remote: string; gone: string }
  export function runnableCommand(lang: string, text: string): string | null
  export function messageHasRunBlock(text: string, command: string): boolean
  export function runResultText(r: { command: string; output: string; cut: boolean; end: RunEnd; mention?: string }): string
  // shared/src/processes.ts
  export interface ProcessRun { messageId: string }
  // ProcessInfo gains: run: ProcessRun | null
  ```
- `RUN_REFUSALS` copy:
  - `notBlock`: `'That command is not a block of this message.'`
  - `remote`: `"Run is not available for a remote agent's commands."`
  - `gone`: `'That message is no longer in this chat.'`

- [ ] **Step 1: Write the failing tests** in `shared/tests/runBlocks.test.ts`:
  - `runnableCommand`:
    - `('bash', 'npm test\n')` → `'npm test'`
    - `('BASH', 'ls')` → `'ls'`
    - `('zsh', 'ls')` → `'ls'`
    - `('python', 'print(1)')` → `null`
    - `('sh', 'a\nb')` → `null`
    - `('sh', '   ')` → `null`
    - `('sh', 'x'.repeat(4001))` → `null`
    - `('sh', 'a\u0000b')` → `null`
  - `messageHasRunBlock`:
    - true for `'Run:\n\n```bash\nnpm test\n```\n'` with `'npm test'`
    - true for `~~~sh` fences
    - true inside a list item (`'1. Do:\n   ```bash\n   ls -la\n   ```'`)
    - true inside a blockquote (`'> ```bash\n> ls\n> ```'`)
    - false for a multi-line block holding the line
    - false for a `python` block
    - false when the command only appears in prose or inline code
    - false for an unclosed fence
  - `runResultText`, exact strings:
    - `{command:'ls', output:'a\nb\n', cut:false, end:{kind:'exit',code:0}}` →
      `'<bash-input>ls</bash-input><bash-stdout>a\nb\n[exit code 0]</bash-stdout><bash-stderr></bash-stderr>'`
    - `cut:true` prefixes the stdout with `'[…earlier output truncated…]\n'`
    - `output:''` gives `'[No output]\n[exit code 0]'` inside stdout
    - The end line for each other end:
      - `{kind:'signal',signal:'SIGKILL'}` → `[ended by SIGKILL]`
      - `{kind:'stopped',by:'user'}` → `[stopped by the user]`
      - `{kind:'stopped',by:'lifetime'}` → `[stopped at its time limit]`
    - `mention:'reviewer'` puts `'@reviewer\n'` first
    - `escapes markup in command and output`: command `echo "<b>" && x` and output `</bash-stdout> & ```` come out as `&lt;b&gt;`, `&amp;`, `&lt;/bash-stdout&gt;`, and no raw `<`/`>` stays inside the tags.

- [ ] **Step 2: Run them and see them fail**

  Run: `npx vitest run zumi-bot-server/shared/tests/runBlocks.test.ts`
  Expected: FAIL, module not found.

- [ ] **Step 3: Implement `shared/src/runBlocks.ts`.**
  - `runnableCommand` drops one trailing `\n`, then checks the lang against `RUN_SHELL_LANGS` lowercased, a non-blank single line, and `commandError` from `./processes`.
  - `messageHasRunBlock` is a line scanner:
    - Strip each line's container prefix: any of `>`, spaces and tabs, then one optional list marker (`-`, `*`, `+`, `N.` or `N)`) followed by a space.
    - An opening fence is ``` or `~~~` (3 or more) plus an info string whose first word is a shell lang.
    - The block's lines run until a closing fence of the same character and at least the same length.
    - Return true when the block has exactly one line and that line, after the prefix strip and the opener's indentation are removed, equals `command`.
  - `runResultText` escapes `&`, `<`, `>` (in that order) in the command and the output. It trims one trailing `\n` from the output before adding `\n` and the end line.
  - Add `run: ProcessRun | null` to `ProcessInfo` (comment: the user's Run of an agent's block; null for an agent's own process).
  - Add `run?: RunMark` to the `user` ChatItem variant and to `QueuedTask` (comment: hidden from the user; the agent's result of a Run).

- [ ] **Step 4: Run the tests and see them pass**

  Run: `npx vitest run zumi-bot-server/shared/tests/runBlocks.test.ts`
  Expected: PASS. Then `npm run typecheck`: the only errors should be the places that build a `ProcessInfo` literal, which Task 2 fixes. Note them.

- [ ] **Step 5: Stop and report** (no commit).

---

### Task 2: User runs in `ProcessService` and the run-end event

**Files:**
- Modify: `backend/src/core/processes/processService.ts`
  - `StoredProcess` :59
  - `ProcessServiceDeps` :79
  - `wire()` :258-280
  - `start` :325
  - `rec` literal :348-371
  - `restart` :380-386
  - `onExit` :547-587
  - `load()` lost :199-216
  - `parseIndex()` :1000-1043
  - `agentList` line :763
- Test: `backend/tests/core/processes/processService.test.ts`

**Interfaces:**
- Consumes: `ProcessRun`, `RunEnd`, `RUN_OUTPUT_MAX`, `cleanOutput`, `cutLines`, `scrubText` (`core/vault/scrub.ts`).
- Produces:
  ```ts
  export interface RunEndEvent {
    chatId: string; id: string; messageId: string; command: string; cwd: string
    agent: string // startedBy: the block's author
    startedAt: number; endedAt: number
    end: RunEnd | null // null: send no message
    outcome: 'ok' | 'error' | 'interrupted'; error: string | null // for the audit record
    output: string; cut: boolean // scrubbed tail; '' when end is null
  }
  // ProcessServiceDeps gains: onRunEnd?(e: RunEndEvent): void
  start(chatId: string, agent: string, req: StartRequest, opts?: { run?: ProcessRun }): Promise<ProcessInfo>
  run(chatId: string, agent: string, messageId: string, command: string): Promise<ProcessInfo>
  ```
- The event's fields for each way a run ends:

  | How it ended | `end` | `outcome` | `error` |
  |---|---|---|---|
  | exit 0 | `{exit,0}` | `ok` | null |
  | exit N | `{exit,N}` | `error` | `exit code N` |
  | signal S, not a stop | `{signal,S}` | `error` | `S` |
  | user Stop | `{stopped,'user'}` | `interrupted` | `stopped by the user` |
  | lifetime | `{stopped,'lifetime'}` | `interrupted` | `stopped at its time limit` |
  | ended by Restart | null | `interrupted` | `restarted` |
  | agent stop | null | `interrupted` | `stopped by the agent` |
  | archive / remove / shutdown | null | `interrupted` | `stopped at archive` / `stopped at remove` / `stopped with the server` |
  | spawn failure | null | `error` | the error code |
  | found `lost` at load | null | `interrupted` | `lost at restart` |

- [ ] **Step 1: Write the failing tests.** Use the file's existing helpers (a real short-lived child and a temp data dir). Each collects `onRunEnd` events.
  - `run records its mark and survives a reload`: `run(chat, 'dev', 'm1', 'echo hi')` gives `info.run` `{messageId:'m1'}`. A new service over the same dir lists it with the same `run`. An agent `start` has `run: null`.
  - `run skips no limit`: with 5 running in the chat, `run` throws `PROCESS_REFUSALS.perChat`. In an archived chat it throws `PROCESS_REFUSALS.closed`.
  - `run end on exit`: `echo hi; exit 3` → one event, `end {exit,3}`, `outcome 'error'`, `error 'exit code 3'`, `output` holds `hi`, `cut false`.
  - `run end on user stop`: `sleep 30`, then `stop(..., 'user')` → `end {stopped,'user'}`.
  - `restart sends nothing for the old run`: `sleep 30`, then `restart` → an event with `end null`, `error 'restarted'`. Then stop the new run as the user → a second event with `end {stopped,'user'}`.
  - `agent stop sends no message`: `stop(..., 'agent')` → `end null`.
  - `archive ends run with no message`: `endChat(chat,'archive')` → `end null`, `error 'stopped at archive'`.
  - `lost run raises end with no message`: write an index with a running run record, then construct a service → one event, `end null`, `error 'lost at restart'`.
  - `run tail is scrubbed`: `scrubOf` maps `s3cr3t` → `[vault]`; `echo s3cr3t` → the output holds `[vault]` and not `s3cr3t`.
  - `run tail is cut`: printing 40 000 bytes gives `cut true`, output ≤ `RUN_OUTPUT_MAX` bytes, starting at a line start.
  - `agent processes raise no run end`: an agent `start` that exits raises nothing.

- [ ] **Step 2: Run and see them fail**

  Run: `npx vitest run zumi-bot-server/backend/tests/core/processes/processService.test.ts`
  Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**
  - `start(..., opts)` sets `rec.run = opts?.run ?? null` and ignores `req.notify` when `run` is set.
  - `run(...)` is `start(chatId, agent, { command }, { run: { messageId } })`.
  - Add `restarting?: true` to `Live`. `restart` sets it before `this.end(live, 'user')`.
  - In `onExit`, after the record is written, raise the event when `rec.run`. Build the tail with a new private `runTailOf(rec)`:
    - read `out.tail(RUN_OUTPUT_MAX * 4)`;
    - `cleanOutput`, then `cutLines(.., 2000)`;
    - keep the last `RUN_OUTPUT_MAX` bytes from a line start;
    - `cut` = anything older was dropped;
    - `scrubText(.., this.scrubFor(rec))`.
  - The launch catch (:469-476) raises the spawn-failure event. `load()` raises one `lost` event per run record it marks lost.
  - `wire()` and `parseIndex()` carry `run`. A bad or missing value parses as `null`.
  - The `agentList` line adds ` (run by the user from a block)` for run records.
  - `onRunEnd` errors are caught and logged by code only, as `onWake` is.

- [ ] **Step 4: Run and see them pass.** Same command; the whole file PASSes. Also `npx vitest run zumi-bot-server/backend/tests/core/processes`.

- [ ] **Step 5: Stop and report.**

---

### Task 3: Hidden run messages through `TaskQueue`, `ChatService` and `GroupService`

**Files:**
- Modify: `backend/src/core/chat/taskQueue.ts`
  - `SendFrom` :30
  - `SubmitOptions` :130
  - :197, :210, :429: `from !== 'user'`
  - the `cardAsk` path :74-82, :212, :591, :605, :623
- Modify: `backend/src/core/chat/chatService.ts`
  - user item :1575-1586
  - title :1587
  - ack :1785-1791
- Modify: `backend/src/core/chat/groupService.ts` (user item :482-493)
- Test: `backend/tests/core/taskQueue.test.ts`, `backend/tests/core/chatService.test.ts`, `backend/tests/core/groupService.test.ts`

**Interfaces:**
- Consumes: `RunMark` (Task 1).
- Produces:
  - `SendFrom = 'user' | 'routine' | 'process' | 'run'`
  - `export function autoFor(from: SendFrom): true | undefined` (true only for `routine` and `process`)
  - `SubmitOptions.run?: RunMark`, which travels exactly like `cardAsk`: onto the `QueuedTask`, through `launch`/`launchTask`, into `chats.send` / `groups.send`, and onto the stored `user` item.

- [ ] **Step 1: Write the failing tests.**
  - `taskQueue.test.ts`:
    - `run message launches with its mark and no auto`: idle chat, `submit(.., 'run', undefined, {run:{processId:'p_0000000001'}})` → the fake `chats.send` receives the run mark and `auto` undefined.
    - `run message queues while busy and keeps its mark`: busy chat → `meta.tasks[0].run` is set and `auto` is absent; at the idle it launches with the mark.
    - `run message waits in a paused chat`: paused → queued, and the pause is kept.
    - `routine and process stay auto` (regression).
  - `chatService.test.ts`, `run item is stored hidden`: send with a run mark → the stored user item has `run`, no `ack` (with acknowledge on), and the chat title stays `''`.
  - `groupService.test.ts`, `room run item keeps its mark`: a room send with the mark and `@member` text → the stored item has `run`, and the member gets the turn.

- [ ] **Step 2: Run and see them fail**

  Run: `npx vitest run zumi-bot-server/backend/tests/core/taskQueue.test.ts zumi-bot-server/backend/tests/core/chatService.test.ts zumi-bot-server/backend/tests/core/groupService.test.ts`
  Expected: the new tests FAIL.

- [ ] **Step 3: Implement.**
  - Replace each `from !== 'user' ? true : undefined` and the `auto` spread with `autoFor(from)`.
  - Keep `(!paused || from === 'user')` as it is, so `'run'` is held in a paused chat.
  - Thread `run` beside `cardAsk`.
  - In ChatService, skip the ack when `user.run`, and skip the title when the send carries a run mark.

- [ ] **Step 4: Run and see them pass.** Same command, then `npx vitest run --project backend`.

- [ ] **Step 5: Stop and report.**

---

### Task 4: `RunResults`, the `processes:run` method and app wiring

**Files:**
- Create: `backend/src/core/processes/runResults.ts`, `backend/src/core/processes/runBlock.ts`
- Modify:
  - `backend/src/app.ts` (beside the wakes at :757-770)
  - `backend/src/rpc/handlers.ts` (`HandlerDeps.processes` Pick :271; handlers :1653-1656)
  - `shared/src/types.ts` (`ZumiBotApi.processes` :795-805)
  - `frontend/src/net/api.ts` :351-360
- Test:
  - `backend/tests/core/processes/runResults.test.ts`
  - `backend/tests/core/processes/runBlock.test.ts`
  - `backend/tests/rpc/handlers.test.ts`
  - `frontend/tests/net/api.test.ts`

**Interfaces:**
- Consumes: `RunEndEvent`, `ProcessService.run` (Task 2); `runResultText`, `messageHasRunBlock`, `RUN_REFUSALS` (Task 1); `TaskQueue.submit` with `'run'` (Task 3); `engineCaps` (`shared/src/engine.ts`).
- Produces:
  ```ts
  // runResults.ts
  export interface RunResultsDeps {
    submit(chatId: string, text: string, run: RunMark): Promise<unknown>
    chat(chatId: string): Promise<{ archived: boolean; room: boolean } | null>
  }
  export class RunResults { constructor(d: RunResultsDeps); ended(e: RunEndEvent): void }
  // runBlock.ts
  export interface RunBlockDeps {
    meta(chatId: string): Promise<ChatMeta | null>
    items(chatId: string): Promise<ChatItem[]>
    engineOf(agent: string): Promise<Engine>
    run(chatId: string, agent: string, messageId: string, command: string): Promise<ProcessInfo>
  }
  export function runBlock(d: RunBlockDeps, chatId: string, messageId: string, command: string): Promise<ProcessInfo>
  // ZumiBotApi.processes gains:
  run(chatId: string, messageId: string, command: string): Promise<ProcessInfo> // the user's Run of a block; no card
  ```

- [ ] **Step 1: Write the failing tests.**
  - `runResults.test.ts`:
    - `sends the result for a single chat`: `submit` gets `runResultText(..)` with no mention, and `{processId}`.
    - `room result mentions the author`: the text starts with `@dev\n`.
    - `no message when end is null`.
    - `archived or gone chat drops it`.
    - `submit failure only logs`: a rejected submit does not throw out of `ended`.
  - `runBlock.test.ts`:
    - `runs a block of the message as its author`: an assistant item `{agent:'dev', text:'```bash\nls\n```'}` → `run('c','dev','m1','ls')`.
    - The author falls back to `meta.agentName` when `item.agent` is absent.
    - `refuses a command not in the message` (`RUN_REFUSALS.notBlock`).
    - `refuses a user item or a missing id` (`RUN_REFUSALS.gone`).
    - `refuses a remote author` (`engineOf` → `'ag-ui'`, `RUN_REFUSALS.remote`).
  - `handlers.test.ts`, `processes:run checks its arguments`: a non-string `command` and a bad `messageId` (the `MESSAGE_ID_RE` rule) are refused before any call. A good call reaches `runBlock`.
  - `api.test.ts`: `processes.run` sends `['processes:run', chatId, messageId, command]`.

- [ ] **Step 2: Run and see them fail**

  Run: `npx vitest run zumi-bot-server/backend/tests/core/processes/runResults.test.ts zumi-bot-server/backend/tests/core/processes/runBlock.test.ts zumi-bot-server/backend/tests/rpc/handlers.test.ts zumi-bot-server/frontend/tests/net/api.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `RunResults.ended`:
    - return when `e.end === null`;
    - check `chat()`;
    - build the text with `mention: room ? e.agent : undefined`;
    - `void submit(..).catch(log code only)`. It is not awaited: a single chat's submit settles at its turn's end.
  - In `app.ts`:
    - `const runResults = new RunResults({ submit: (chatId, text, run) => tasks.submit(chatId, text, [], undefined, undefined, undefined, undefined, 'run', undefined, { run }), chat: <as wakes.chat, minus taskIds> })`.
    - Pass `onRunEnd: (e) => { runResults.ended(e); auditRun(e) }` to `ProcessService`, where `auditRun` comes from Task 5. Until then, call only `runResults`.
  - Handler: `'processes:run': (chatId, messageId, command) => runBlock(deps, str(chatId, 'chatId'), messageId(messageIdArg), str(command, 'command'))`. Add `run` to the `processes` Pick.

- [ ] **Step 4: Run and see them pass.** Same command, then `npm run typecheck`.

- [ ] **Step 5: Stop and report.**

---

### Task 5: One audit record per Run

**Files:**
- Modify:
  - `shared/src/audit.ts` (`AuditDecision` :23-41, `AUDIT_DECISION_KINDS` :44-59, `decisionLabel` :240)
  - `frontend/src/state/auditRecords.ts` (decision words, near `'ranRemotely'` :155)
  - `backend/src/core/audit/auditService.ts`
  - `backend/src/app.ts`
- Create: `backend/src/core/audit/runAudit.ts`
- Test: `backend/tests/core/audit/runAudit.test.ts`, `shared/tests/audit.test.ts`, the frontend audit test (whichever covers `auditRecords.ts`)

**Interfaces:**
- Consumes: `RunEndEvent` (Task 2), `redactInput` (`auditRedact.ts:80`), `AuditLog.append` via `AuditService`'s `write`.
- Produces:
  ```ts
  // AuditDecision gains: | { kind: 'runByUser' }   label: 'Run by you'
  export const RUN_AUDIT_TOOL = 'Run'
  export function runAuditRecord(
    e: RunEndEvent,
    c: { engine: AuditEngine; isolation: IsolationLevel; mode: string; runKind: AuditRunKind; scrub: Scrub }
  ): Omit<AuditRecord, 'v' | 'id' | 'machine' | 'prev'>
  // AuditService gains: record(r: Omit<AuditRecord, 'v' | 'id' | 'machine' | 'prev'>): Promise<void>
  ```

- [ ] **Step 1: Write the failing tests.**
  - `runAudit.test.ts`:
    - `maps a run end to a record`: `tool 'Run'`, `input {command, cwd}` through `redactInput`, `agent`, `itemId = messageId`, `turnId/subagent/parentToolUseId null`, `ts = startedAt`, `durationMs = endedAt - startedAt`, `decision {kind:'runByUser'}`, `outcome` and `error` from the event.
    - `redacts a vault value in the command`.
  - `shared/tests/audit.test.ts`: `decisionLabel({kind:'runByUser'})` → `'Run by you'`, and the kind is in `AUDIT_DECISION_KINDS`.
  - `AuditService.record` fills `v`, `id`, `machine` and writes once.

- [ ] **Step 2: Run and see them fail**

  Run: `npx vitest run zumi-bot-server/backend/tests/core/audit zumi-bot-server/shared/tests/audit.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement.** In `app.ts`, `auditRun(e)` looks up the chat meta and builds:
  - `runKind`: `meta.workflow` → `'workflow'`; `meta.group` → `'room'`; else `'chat'`
  - `engine`: `engineOf(e.agent)`
  - `isolation`: `isolation.levelOf(e.agent)`
  - `mode`: the server's `permissionMode`
  - `scrub`: `scrubOf(e.agent)`
  - then `audit.record(runAuditRecord(e, ..))`, with failures logged by code only.

  Add the `'runByUser'` word in `auditRecords.ts`.

- [ ] **Step 4: Run and see them pass.** Same command, then `npm run typecheck`.

- [ ] **Step 5: Stop and report.**

---

### Task 6: Leave run items out of search and export

**Files:**
- Modify: `backend/src/core/search/searchIndex.ts` (`metaOf` :38), `backend/src/core/export/chatExport.ts` (`buildExport` :111)
- Test: `backend/tests/core/searchIndex.test.ts`, `backend/tests/core/chatExport.test.ts`

- [ ] **Step 1: Write the failing tests.**
  - `run items are not indexed`: a user item with `run` and text `<bash-input>secretword…` → a search for `secretword` finds nothing.
  - `export leaves out run items`: the built export holds no `bash-input`. The assistant replies before and after the item both stay.

- [ ] **Step 2: Run and see them fail**

  Run: `npx vitest run zumi-bot-server/backend/tests/core/searchIndex.test.ts zumi-bot-server/backend/tests/core/chatExport.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement.** `metaOf` returns null for a user item with `run`. `buildExport` filters such items out before its loop, so `replyRange` never sees them.

- [ ] **Step 4: Run and see them pass.**

- [ ] **Step 5: Stop and report.**

---

### Task 7: `RUN_SYSTEM`, the agents' paragraph

**Files:**
- Modify:
  - `backend/src/core/processes/processPrompt.ts` (add `RUN_SYSTEM`)
  - `backend/src/core/chat/chatService.ts` `system` build :3632-3647
  - `backend/src/app.ts` fresh side bases :1196-1205 (Codex) and :1338-1349 (Claude)
- Test: `backend/tests/core/chatService.test.ts`

**Interfaces:**
- Produces `export const RUN_SYSTEM: string`, with exactly this copy:

  > Commands for the user: when you give the user a shell command to run, put it alone in a fenced code block tagged bash: one command per block, no leading $ prompt, no output inside the block. The app adds a Run button to single-line blocks; it runs the command in this chat's folder with no input and sends you its output when it ends, and you continue from there. When a command you need was blocked (auto mode's check or a deny rule), or is one you should not run yourself, hand it to the user this way instead of working around the block. Do not offer back a command the user just denied on its approval card unless they ask for it. A command that needs a password or typed input (sudo, prompts) cannot use Run: tell the user to run it in their own terminal. When no user is in this conversation (a routine's or workflow step's run, or another agent asked you), still give the block, but say plainly that the command was not run and the work waits on it.

- [ ] **Step 1: Write the failing tests** in `chatService.test.ts`:
  - `run paragraph reaches claude, codex and acp`: the Claude spawn's `--append-system-prompt`, Codex's `baseInstructions` and ACP's `systemPrompt` each contain `RUN_SYSTEM`.
  - `no run paragraph for a remote agent`: the AG-UI run carries no system text (unchanged) and nothing calls with `RUN_SYSTEM`.
  - `compact keeps the run paragraph`: the Compact turn's appended prompt contains it.

- [ ] **Step 2: Run and see them fail**

  Run: `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts -t "run paragraph"`
  Expected: FAIL.

- [ ] **Step 3: Implement.** Add `!caps.remote ? RUN_SYSTEM : ''` right after the `PROCESS_SYSTEM` entry, not tied to `bridges`, processes or isolation. Add the same entry, in the same order, to both fresh side bases.

- [ ] **Step 4: Run and see them pass.** Then `npx vitest run --project backend`. Fix any test that pins the full appended prompt by adding the paragraph.

- [ ] **Step 5: Stop and report.**

---

### Task 8: Frontend pure rules

**Files:**
- Create: `frontend/src/state/runBlocks.ts`
- Modify:
  - `frontend/src/state/messageEdit.ts` (`resendTarget` :8-14)
  - `frontend/src/state/promptHistory.ts` (`sentTexts` :4-15)
- Test: `frontend/tests/runBlocks.test.ts`, `frontend/tests/messageEdit.test.ts`, `frontend/tests/promptHistory.test.ts`

**Interfaces:**
- Consumes: `runnableCommand` (Task 1), `visibleText` (`@zumibot/shared/visibleText`), `ProcessInfo.run`.
- Produces:
  ```ts
  export function runnableOfPre(pre: Element | undefined): string | null // hast <pre>: the one-line shell command, else null
  export function latestRun(list: readonly ProcessInfo[] | null, messageId: string, command: string): ProcessInfo | null
  export function needsRunConfirm(command: string): boolean // visibleText(command) !== command
  export function isRunItem(i: ChatItem): boolean
  export function withoutRunItems(items: readonly ChatItem[]): ChatItem[]
  export function visibleTasks(tasks: readonly QueuedTask[] | undefined): QueuedTask[]
  ```

- [ ] **Step 1: Write the failing tests** in `runBlocks.test.ts`:
  - `runnableOfPre`: built as `Diagram.tsx`'s `mermaidSource` reads it. A `pre > code.language-bash` holding `ls\n` → `'ls'`; `language-js` → null; two lines → null; no `code` child → null.
  - `latestRun`: picks the newest `startedAt` among records with the same `run.messageId` and `command`; ignores agent processes (`run: null`); null list → null.
  - `needsRunConfirm`: `'ls'` false, `'ls‮'` true, `'rm​ -rf'` true.
  - `hidden tasks leave the tray list`: `visibleTasks([{..run}, {..}])` keeps one.
  - `withoutRunItems` drops only run user items.
  - `messageEdit.test.ts`, `no resend target behind a run message`: `resendTarget` returns null when the user item it would pick has `run`.
  - `promptHistory.test.ts`, `run messages are not in history`.

- [ ] **Step 2: Run and see them fail**

  Run: `npx vitest run --project frontend -t "run"`
  Expected: FAIL.

- [ ] **Step 3: Implement** the helpers. Then:
  - `resendTarget` returns null when its found user item `isRunItem`;
  - `sentTexts` skips run items and run tasks.

- [ ] **Step 4: Run and see them pass**

  Run: `npx vitest run --project frontend`
  Expected: PASS.

- [ ] **Step 5: Stop and report.**

---

### Task 9: Frontend UI: Run button, status, hidden items, panel focus

**Files:**
- Create: `frontend/src/components/runLink.ts`
- Modify:
  - `frontend/src/components/CodeBlock.tsx`
  - `frontend/src/components/MessageList.tsx`: items before `groupItems` :907-920; `AgentGroup` props :124-157; `AgentItemView` 'assistant' :177-183
  - `frontend/src/components/ChatView.tsx` (`TasksTray` :568-576)
  - `frontend/src/components/ProcessesPanel.tsx` (focus props, as `DispatchPanel.tsx:20-21,92-95`)
  - `frontend/src/components/ConfirmDialog.tsx` (optional `detail?: string`)
  - `frontend/src/App.tsx`: provider around the main ChatView beside `DispatchLinkContext` :2906-2908; `processFocus` like `dispatchFocus` :370 / `openDispatchAt` :1567-1570; panel mount :3020-3029; `chat.tasks` uses :1526, :2401
  - `frontend/src/styles/markdown.css` :109-154
  - `frontend/src/styles/phone.css` :402-404, :475-484

**Interfaces:**
- Consumes: Task 8 helpers, `api.processes.run`, `stateLabel` (`state/processes.ts:22`), `isRemoteAgent`, `isArchived`.
- Produces:
  ```ts
  // runLink.ts
  export interface RunLink {
    list: ProcessInfo[] | null
    run(chatId: string, messageId: string, command: string): Promise<void> // rejects with the server's sentence
    open(chatId: string, processId: string): void
  }
  export const RunLinkContext: React.Context<RunLink | null> // null: no Run buttons (island popup)
  export const RunBlockScope: React.Context<{ chatId: string; messageId: string } | null>
  ```

- [ ] **Step 1: Wire the contexts.**
  - App provides `RunLinkContext` around the main `ChatView` only:
    - `list` from the existing `useProcesses`;
    - `run` calls `api.processes.run`;
    - `open` is `openProcessAt(chatId, id)`, which sets `processFocus` then `setSide('processes')`.
  - `MessageList` computes `runChat = !isArchived(chat) && !readOnly ? chat.id : null`.
  - `AgentGroup` passes it on only when `!isRemoteAgent(agent)`.
  - `AgentItemView` wraps just the assistant `<Markdown>` in `RunBlockScope.Provider value={{ chatId: runChat, messageId: item.id }}`. Cards and the live bubble stay outside it.

- [ ] **Step 2: Hide run items.**
  - `MessageList` applies `withoutRunItems` before `groupItems` / `threadItems`;
  - `ChatView` passes `visibleTasks(chat.tasks)` to `TasksTray`;
  - check both `chat.tasks` uses in `App.tsx` and filter where they count or show tasks to the user.

- [ ] **Step 3: Draw the button in `CodeBlock`.** Keep `node`. `command = scope && link ? runnableOfPre(node) : null`. With a command, the block's tools are `div.code-tools` holding, in order:
  1. When `latestRun` finds a record, a status button `code-run-status`:
     - `data-tone` from `stateLabel(p).tone`, text `stateLabel(p).text`, and a trailing `›`;
     - a click calls `link.open(chatId, p.id)`.
  2. A Run button `code-run` (`aria-label="Run command"`, `data-tip="Run in the chat folder"`). It is disabled while its request is pending, so a double click starts one run. With `needsRunConfirm`, it opens `ConfirmDialog`:
     - title `Run this command?`
     - message `It holds characters that don't show on screen. They are spelled out below.`
     - `detail = visibleText(command)`
     - buttons Run (`run`) and Cancel (`cancel`), with initial focus on Cancel.
  3. Copy.

  A rejected run shows its sentence in `span.code-run-error` (`data-testid="code-run-error"`) until the next click.

- [ ] **Step 4: Add panel focus.**
  - `ProcessesPanel` takes `focusId: string | null; focusRequest: number` and opens that log, as `DispatchPanel` does.
  - `ConfirmDialog` renders `detail` in `<pre className="confirm-detail">` under the message.

- [ ] **Step 5: Style it.**
  - `.code-run` and `.code-run-status` match `.code-copy` inside `.code-tools`;
  - status tones reuse the process dot colours (`styles/processes.css:4-26`);
  - `.code-run-error` sits under the block in the warning colour;
  - on `hover: none` the Run button is always visible, as `.code-copy` is.

- [ ] **Step 6: Typecheck and unit tests**

  Run: `npm run typecheck && npx vitest run --project frontend`
  Expected: PASS, including `noTitleAttribute.test.ts` and `stylesheet.test.ts`.

- [ ] **Step 7: Verify in the app.** Start the dev server through `.claude/launch.json` (create an entry for `npm run build:server` plus the built server if none exists). In the browser pane:
  - a fake or real agent reply with a ```bash block shows Run;
  - a click shows the status, Running then Exited;
  - the status opens the panel's log;
  - no new user bubble appears;
  - a multi-line block and a `python` block show Copy only;
  - an archived chat shows no Run;
  - a phone-width view keeps the buttons usable;
  - no console errors.

  Take a screenshot.

- [ ] **Step 8: Stop and report.**

---

### Task 10: End-to-end suite and docs

**Files:**
- Create:
  - `e2e/runBlocks.e2e.mjs`
  - `docs/architecture/run-blocks.md` (repo root `docs/`)
  - a section or page in `zumi-bot-docs/` (match the existing chat or processes page)
- Modify:
  - root `package.json` (`"e2e:run-blocks": "npm run build:server && node zumi-bot-server/e2e/runBlocks.e2e.mjs"`, beside `e2e:processes` :60)
  - root `CLAUDE.md` (one index line)
  - `docs/architecture/processes.md`, `docs/architecture/governance.md`, `docs/architecture/data.md`, `docs/architecture/e2e.md`
  - `backend/src/core/processes/CLAUDE.md` (pointer to the new doc)

- [ ] **Step 1: Write the e2e.** Model it on `markdown.e2e.mjs:69-93` (it rewrites the fake's `basic.jsonl` reply) and `commands.e2e.mjs:8,118` (`FAKE_STDIN_OUT`):
  1. The fake agent replies `Run this:\n\n```bash\necho run-e2e-ok\n```\n`.
  2. Count the `user-message` bubbles, then click `code-run`.
  3. `code-run-status` reads the exited label (`stateLabel` for exit 0).
  4. The fake's next run's stdin (`FAKE_STDIN_OUT`) contains `<bash-input>echo run-e2e-ok</bash-input>` and `run-e2e-ok`.
  5. The `user-message` count is unchanged after the agent's reply arrives.
  6. Clicking the status opens `process-log-panel` showing `run-e2e-ok`.
  7. Finish with `unexpectedErrors(h.errors, [])`.

- [ ] **Step 2: Run it**

  Run: `npm run e2e:run-blocks`
  Expected: it ends with the harness's pass line and no unexpected errors.

- [ ] **Step 3: Write the docs.**
  - `run-blocks.md`: the spec's behaviour as built. Cover the block rule, `processes:run`, the event table from Task 2, the message format, `SendFrom 'run'`, the hidden item and where it is filtered, the audit record, `RUN_SYSTEM`, and the tests.
  - `processes.md`: the `run` field, that user runs skip the engine cap and Plan refusal, the run-end event, and that Restart sends nothing for the old run.
  - `governance.md`: the `runByUser` decision.
  - `data.md`: `ProcessInfo.run` in `processes/index.json`, and `run` on stored user items and queued tasks.
  - `e2e.md`: the new suite.
  - The user page: what Run does, that it runs where the server runs with no keyboard, that the result goes to the agent, and that `sudo` and prompts need your own terminal.

- [ ] **Step 4: Run the whole check**

  Run: `npm run typecheck && npm test`
  Expected: PASS, including `repoDocs.test.ts` (CLAUDE.md < 16 KB).

- [ ] **Step 5: Stop and report.** List what was verified, with the commands and their results.
