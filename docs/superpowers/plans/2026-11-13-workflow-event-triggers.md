# Workflow Event Triggers and /run-workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workflows start from in-app events (reply ended, to-do added, Inbox message, file changed, email arrived) and from a chat's `/run-workflow` command.

**Architecture:** Every event becomes a run shaped like a webhook call (`call.method = 'EVENT'`, JSON `body`) plus a text `input`, so templates, filters and the Audit log reuse webhook code. A server-side `WorkflowEventDispatcher` receives events from ChatService/GroupService/TodoService/WorkflowMessages and from two watchers (folder `fs.watch`, IMAP poll), applies filters, rate cap and loop guards, then calls `WorkflowRunner.run(w, 'event', …)`.

**Tech Stack:** TypeScript, Node 22, React 19, vitest; new pinned deps `imapflow` and `mailparser` (backend only, bundled by Vite).

**Spec:** `docs/superpowers/specs/2026-11-13-workflow-event-triggers-design.md`

## Global Constraints

- Never `git commit` (user rule): leave every change uncommitted; there are no commit steps.
- Run commands from `zumi-bot-server/`'s parent (repo root) unless a step says otherwise; vitest projects: `shared`, `frontend`, `backend`.
- Dependencies pinned to exact versions (no `^`/`~`), added to `zumi-bot-server/backend/package.json`; run `npm install` at repo root so `package-lock.json` follows.
- Secrets never in logs, URLs or error messages: an IMAP error names the host and folder, never the password.
- Comments short, say *why*. Match the existing code style (no semicolons, 2-space indent, single quotes).
- Event text is untrusted material: a model must read it inside `<input from="trigger">` blocks.
- Workflows run on the VPS only; `workflow-mail.json` is per machine (sync copies only named files, so add nothing to sync).
- Root `CLAUDE.md` must stay under 16 KB; feature detail goes to `docs/architecture/workflows.md`.
- Worktrees need `node_modules` symlinks to the main checkout before typecheck/build (memory: worktree-build-links); check `ls node_modules` first.

## Review Focus

1. **Self-trigger loops** — a reply-triggered workflow whose Agent step replies, a to-do workflow whose agent adds to-dos, an Inbox workflow that Notifies, a file workflow whose agent writes into the watched folder: none may start the same workflow again (Task 3 tests each).
2. **Event floods** — 50 replies in a minute, or a `git checkout` touching 2 000 files: at most `EVENT_RUNS_PER_MINUTE` runs, one run per file burst capped at 100 files, and no skipped run written for a filtered-out event (Tasks 3, 5).
3. **Mailbox first sight** — enabling an email trigger on a mailbox with 5 000 messages fires nothing; a changed UIDVALIDITY or account starts over silently (Task 6).
4. **Untrusted text** — an email body containing `</input>` or "ignore previous instructions" reaches a model wrapped and escaped, through both `{{trigger.text}}` and `{{trigger.body.text}}` (Task 2).
5. **Workflow names in /run-workflow** — names with spaces, a name that is a prefix of another ("Report" vs "Report weekly"), different case, and two workflows sharing a name (Task 7).

---

### Task 1: Shared trigger types, event helpers and parsing

**Files:**
- Modify: `zumi-bot-server/shared/src/workflows.ts` (WorkflowTrigger, TriggerFilter, WorkflowRun, WorkflowRunSummary, summaryOf)
- Create: `zumi-bot-server/shared/src/workflowEvents.ts`
- Modify: `zumi-bot-server/shared/src/workflowTemplate.ts` (`filtersMatch`)
- Modify: `zumi-bot-server/shared/src/workflowInput.ts` (`trigger()` parser)
- Test: `zumi-bot-server/shared/tests/workflowEvents.test.ts` (new), `shared/tests/workflowInput.test.ts`, `shared/tests/workflowTemplate.test.ts`

**Interfaces:**
- Produces (in `workflows.ts`):
  ```ts
  export type EventKind = 'reply' | 'todo' | 'inbox' | 'file' | 'email'
  export type FileChange = 'added' | 'changed' | 'removed'
  export interface TriggerFilter { field: string; equals: string; op?: 'contains' } // absent op = equals
  export type WorkflowTrigger =
    | { kind: 'manual' } | { kind: 'schedule'; schedule: Schedule }
    | { kind: 'webhook'; sample: WebhookCall | null; filters: TriggerFilter[] }
    | { kind: 'reply'; filters: TriggerFilter[] } | { kind: 'todo'; filters: TriggerFilter[] } | { kind: 'inbox'; filters: TriggerFilter[] }
    | { kind: 'file'; path: string; pattern: string; changes: FileChange[]; filters: TriggerFilter[] }
    | { kind: 'email'; account: string; host: string; port: number; folder: string; filters: TriggerFilter[] }
  // WorkflowRun: via adds 'event' | 'chat'; new optional fields
  event?: { kind: EventKind; depth?: number }   // depth only for inbox runs (1 = started by a message from a non-inbox run)
  chat?: { chatId: string; title: string }
  // WorkflowRunSummary: event?: EventKind (copied by summaryOf, part of summaryKey)
  ```
- Produces (in `workflowEvents.ts`):
  ```ts
  export const EVENT_KINDS: readonly EventKind[]                 // ['reply','todo','inbox','file','email']
  export const isEventKind = (k: string): k is EventKind
  export const EVENT_METHOD = 'EVENT'
  export const EVENT_RUNS_PER_MINUTE = 30
  export const INBOX_CHAIN_MAX = 3
  export const FILE_BURST_MS = 2_000, FILE_BURST_MAX = 100
  export const MAIL_POLL_MS = 120_000, MAIL_PER_CHECK = 10, MAIL_TEXT_MAX = 20_000, REPLY_TEXT_MAX = 20_000
  export const MAIL_PORT_DEFAULT = 993, MAIL_FOLDER_DEFAULT = 'INBOX'
  export interface ChatRef { id: string; title: string; folder: string }
  export interface EventBodies {
    reply: { chat: ChatRef; agent: string; outcome: 'ok' | 'error'; room: boolean; reply: string }
    todo: { chat: ChatRef; by: string; count: number; todos: { text: string; group: string | null }[] }
    inbox: { message: { id: string; title: string; body: string }; workflow: { id: string; name: string }; step: string; runId: string }
    file: { folder: string; count: number; files: { path: string; name: string; change: FileChange }[] }
    email: { from: { name: string; address: string }; to: string; subject: string; date: string; messageId: string; text: string }
  }
  export interface ChatRunBody { chat: ChatRef; text: string; lastReply: string }
  export type WorkflowEvent = { [K in EventKind]: { kind: K; body: EventBodies[K] } }[EventKind]
  export function eventText(e: WorkflowEvent): string
  export function eventCall(body: unknown, at: number): WebhookCall   // { method: EVENT_METHOD, query: {}, body, receivedAt: at }
  export const EVENT_SAMPLES: { [K in EventKind]: EventBodies[K] }    // realistic example bodies, for the field list
  export function eventLabel(kind: EventKind): string
  export function nameMatches(pattern: string, name: string): boolean
  export function defaultTrigger(kind: EventKind): WorkflowTrigger    // empty filters; file: path '', pattern '', changes all three; email: account '', host '', port 993, folder 'INBOX'
  ```

- [ ] **Step 1: Write failing tests** in `shared/tests/workflowEvents.test.ts`:

```ts
it('eventText per kind', () => {
  expect(eventText({ kind: 'reply', body: { ...EVENT_SAMPLES.reply, reply: 'Done.' } })).toBe('Done.')
  expect(eventText({ kind: 'todo', body: { ...EVENT_SAMPLES.todo, todos: [{ text: 'a', group: null }, { text: 'b', group: 'g' }] } })).toBe('a\nb')
  expect(eventText({ kind: 'inbox', body: { ...EVENT_SAMPLES.inbox, message: { id: 'm', title: 'T', body: 'B' } } })).toBe('T\n\nB')
  expect(eventText({ kind: 'inbox', body: { ...EVENT_SAMPLES.inbox, message: { id: 'm', title: 'T', body: '' } } })).toBe('T')
  expect(eventText({ kind: 'file', body: { folder: '/f', count: 2, files: [{ path: '/f/a', name: 'a', change: 'added' }, { path: '/f/b', name: 'b', change: 'removed' }] } })).toBe('/f/a\n/f/b')
  expect(eventText({ kind: 'email', body: { ...EVENT_SAMPLES.email, from: { name: 'Ann', address: 'a@x.io' }, subject: 'Hi', text: 'Body' } })).toBe('From: Ann <a@x.io>\nSubject: Hi\n\nBody')
})
it('nameMatches globs case-insensitively; empty matches all', () => {
  expect(nameMatches('', 'x.txt')).toBe(true)
  expect(nameMatches('*.pdf', 'Invoice.PDF')).toBe(true)
  expect(nameMatches('*.pdf', 'a.pdf.tmp')).toBe(false)
  expect(nameMatches('report-??.csv', 'report-07.csv')).toBe(true)
  expect(nameMatches('a+b(1).txt', 'a+b(1).txt')).toBe(true) // regex characters are literal
})
it('eventCall makes an EVENT call whose body flattens', () => {
  expect(flattenCall(eventCall({ agent: 'x' }, 5))['body.agent']).toBe('x')
})
```
In `workflowTemplate.test.ts`: `filtersMatch([{ field: 'body.subject', equals: 'inv', op: 'contains' }], call)` true for subject "Invoice 12"? No — contains is case-sensitive exact substring: assert `'Your invoice'` matches `'invoice'` and `'Invoice'` does not; and an absent `op` keeps equals.
In `workflowInput.test.ts`: each new kind round-trips through `parseWorkflowInput`; `op: 'contains'` kept, `op: 'regex'` refused; file `changes` deduped and must be non-empty subset of the three (else refused); file `path`/`pattern` capped at 1 000 / 200 chars; email `port` integer 1–65535 (else refused), `host` ≤ 253 chars, `folder` ≤ 200, `account` ≤ 64; an unknown kind refused.

- [ ] **Step 2: Run** `npx vitest run --project shared` — new tests FAIL (missing module/exports).
- [ ] **Step 3: Implement** the types, `workflowEvents.ts`, `filtersMatch` (`op === 'contains' ? flat[f.field].includes(f.equals) : ===`) and the parser branches (rebuild key by key as the webhook branch does; filters parsed by one shared helper, keeping `op` only when `'contains'`). `nameMatches`: escape regex specials, `*`→`.*`, `?`→`.`, anchored, flag `i`. Fix every exhaustive switch the new union breaks (`npm run typecheck` lists them; `definitionHistory.ts` needs none).
- [ ] **Step 4: Run** `npx vitest run --project shared` and `npm run typecheck -w zumi-bot-server/shared` — PASS (frontend/backend typecheck may still fail until their tasks).

---

### Task 2: Runner accepts event and chat runs

**Files:**
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowRunner.ts` (`run`, `start`, `problems`, template ctx building)
- Test: `zumi-bot-server/backend/tests/core/workflowRunner.test.ts`

**Interfaces:**
- Consumes: Task 1 types, `eventCall`.
- Produces:
  ```ts
  run(w: Workflow, via: WorkflowRun['via'], o?: { late?: boolean; call?: WebhookCall; input?: string; event?: { kind: EventKind; depth?: number }; chat?: { chatId: string; title: string } }): Promise<WorkflowRunSummary>
  export const EVENT_SKIPPED_BUSY = TOO_MANY_RUNS // same text, skipped status for via 'event'
  export const ACCOUNT_MISSING = 'Pick an email account the Vault shares with workflows'
  busy(workflowId: string): boolean   // public: a run of it is unfinished or reserved (the activeCount rule > 0); the dispatcher's file guard
  // deps gain: mailAccount(id: string): { username: string; password: string } | null   (Task 6 wires it; tests pass a stub)
  ```

- [ ] **Step 1: Write failing tests** (follow the file's existing harness):
  - `via 'event'` with `call: eventCall(body, t)` and `input: 'the text'`: the trigger visit's output is `'the text'` (not the JSON), `run.event` and `run.call` stored, summary carries `event`.
  - An Agent/LLM step prompt `{{trigger.text}}` on an event run reads `<input from="trigger">\nthe text\n</input>`; on a `'chat'` run it reads `the text` raw; `{{trigger.body.subject}}` on an event run is wrapped.
  - A body text holding `</input>` is escaped in both `{{trigger.text}}` and `{{trigger.body.text}}` fills.
  - At 5 unfinished runs, a 6th `'event'` run ends `skipped` with `TOO_MANY_RUNS` and `notify.failed` is NOT called; a 6th `'manual'` still ends `failed` as before.
  - `busy(id)` is false with no runs, true while a run waits on an Approval, false again after it ends.
  - `problems()` for a `file` trigger whose `path` is missing (`dirExists` false) gives `{stepId: trigger.id, text: FOLDER_MISSING}`; for an `email` trigger whose `mailAccount(account)` is null gives `ACCOUNT_MISSING`; blank `host` gives `'Enter the mail server'`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/workflowRunner.test.ts` — FAIL.
- [ ] **Step 3: Implement.** In `start`: store `event`/`chat`; trigger output = `o.input ?? ''` when `via` is `'event'` or `'chat'`, else `triggerOutput(...)` as now; the cap branch returns `endAs('skipped', TOO_MANY_RUNS)` for `'event'` (extend `endAs`'s status union is already `'skipped'|'failed'`). Where the runner builds `TemplateCtx.trigger`, set `material: true` when `run.via === 'event'` (keep the existing parent rule). Webhook filter check stays webhook-only.
- [ ] **Step 4: Run** the test file — PASS.

---

### Task 3: Event dispatcher with filters, rate cap and loop guards

**Files:**
- Create: `zumi-bot-server/backend/src/core/workflows/workflowEvents.ts`
- Test: `zumi-bot-server/backend/tests/core/workflowEvents.test.ts`

**Interfaces:**
- Consumes: Task 1 (`WorkflowEvent`, `eventText`, `eventCall`, `EVENT_RUNS_PER_MINUTE`, `INBOX_CHAIN_MAX`, `filtersMatch`), Task 2 `run`.
- Produces:
  ```ts
  export interface EventDispatcherDeps {
    workflows(): Promise<Workflow[]>                       // WorkflowStore's list
    run: WorkflowRunner['run']
    chatMeta(chatId: string): Promise<ChatMeta | null>
    getRun(runId: string): Promise<WorkflowRun | null>
    busy(workflowId: string): boolean                       // a run of it is unfinished (file guard)
    now(): number
    log(line: string): void
  }
  export class WorkflowEventDispatcher {
    constructor(d: EventDispatcherDeps)
    emit(e: WorkflowEvent, o?: { only?: string }): Promise<void>   // only: one workflow id (file and email watchers fire per workflow); never throws
  }
  export const workflowChat = (m: ChatMeta): boolean  // m.workflow || m.workflowTest !== undefined || m.asked
  ```

- [ ] **Step 1: Write failing tests:**
  - Fires `run(w, 'event', { call, input, event: { kind } })` for each enabled workflow of that kind; skips disabled ones and other kinds.
  - Filters: a `body.agent` equals filter that fails → `run` not called and nothing written (no `addRun`-like dep exists, so `run` call count 0).
  - Reply/to-do events from a chat whose meta has `workflow`, `workflowTest` or `asked` fire nothing.
  - Inbox: a message whose `workflow.id` is the listening workflow's own id fires nothing for it but fires for another inbox workflow; depth: message from a run with `via: 'event', event: {kind: 'inbox', depth: 2}` fires with depth 3; depth 3 source → no fire (`> INBOX_CHAIN_MAX`); a source run with `parent` walks up via `getRun` to the root's depth.
  - File events for a workflow where `busy(id)` is true fire nothing.
  - Rate cap: the 31st event within 60 s for one workflow fires nothing; at `now + 60_001` it fires again.
  - `run` rejecting is logged, not thrown.
- [ ] **Step 2: Run** the test file — FAIL.
- [ ] **Step 3: Implement.** Rate window: per-workflow array of start times pruned to the last 60 s. Chat skip is read once per event (the meta of `body.chat.id`). `emit` awaits every `run` with `Promise.allSettled`.
- [ ] **Step 4: Run** — PASS.

---

### Task 4: Wire reply, to-do and Inbox sources

**Files:**
- Modify: `zumi-bot-server/shared/src/notify.ts` (`TurnEnd` gains `reply?: string`)
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts:2296` (pass `texts.join('\n\n')` as `reply`), `backend/src/core/chat/groupService.ts:897` (the member's reply text; skip `passed` at the dispatcher)
- Modify: `zumi-bot-server/backend/src/core/todos/todoService.ts` (deps `onAdded?(chatId: string, items: TodoItem[], by: string): void` after `userAdd`/`agentAdd` that added ≥1)
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowMessages.ts` (constructor dep `onAdded?(m: WorkflowMessage): void`, only when `add` stored a new message)
- Modify: `zumi-bot-server/backend/src/app.ts` (build the dispatcher; map each source to a `WorkflowEvent` with `ChatRef` from chat meta: `{id, title, folder: meta.cwd}`; reply text cut to `REPLY_TEXT_MAX`)
- Test: `backend/tests/core/todoService.test.ts`, `backend/tests/core/workflowMessages.test.ts`, `backend/tests/core/chatService.test.ts`

**Interfaces:**
- Consumes: Task 3 `WorkflowEventDispatcher.emit`.
- Produces: `TurnEnd.reply?: string`; `RoomTurnEnd` (readMarks.ts) inherits it.

- [ ] **Step 1: Write failing tests:** `userAdd` of a new item calls `onAdded(chatId, [item], 'user')`; a repeat calls nothing; `agentAdd` of 2 items calls it once with both and `by` = agent. `WorkflowMessages.add` twice with one id calls `onAdded` once. A chatService turn that replies "Hi" calls `onTurnEnd` with `reply: 'Hi'`.
- [ ] **Step 2: Run** those three files — FAIL.
- [ ] **Step 3: Implement** the deps and the app wiring. In `app.ts` the reply handler skips `outcome === 'stopped'`, `e.workflow`, `e.asked`, and a room end with `passed`; it reads meta for title/folder and `room` = `meta.group !== undefined` (check the actual group marker on `ChatMeta`). All handlers are fire-and-forget (`void dispatcher.emit(...)`).
- [ ] **Step 4: Run** — PASS; `npm run typecheck` for backend passes for these files.

---

### Task 5: Folder watcher for file triggers

**Files:**
- Create: `zumi-bot-server/backend/src/core/workflows/fileWatchers.ts`
- Modify: `zumi-bot-server/backend/src/app.ts` (start after recovery; `sync()` on every `workflowsChanged`; `stop()` at shutdown)
- Test: `zumi-bot-server/backend/tests/core/fileWatchers.test.ts`

**Interfaces:**
- Consumes: Task 1 (`FILE_BURST_MS`, `FILE_BURST_MAX`, `nameMatches`, `EventBodies['file']`), Task 3 `emit(e, { only })`.
- Produces:
  ```ts
  export interface FileWatchDeps {
    watch(dir: string, onChange: (relPath: string) => void, onError: (e: Error) => void): { close(): void } // fs.watch recursive in app.ts
    stat(path: string): Promise<'file' | 'dir' | null>
    emit(e: Extract<WorkflowEvent, { kind: 'file' }>, workflowId: string): void
    setTimer(fn: () => void, ms: number): { clear(): void }
    log(line: string): void
  }
  export class FileWatchers { constructor(d: FileWatchDeps); sync(workflows: Workflow[]): void; stop(): void }
  ```

- [ ] **Step 1: Write failing tests** (fake `watch`, `stat`, timer):
  - `sync` opens one watch per enabled `file` workflow; a second `sync` with the same `path` keeps it; a changed `path`, a disabled or deleted workflow closes it.
  - Three changes within the burst, then the timer → one `emit` with `count: 3`, files sorted by path; `stat` null → `removed`; a path absent at the burst's first sight and present after → `added`; present before (first `stat` at sight is `'file'`) → `changed`. (Implement classification by stat-at-first-sight vs stat-at-flush.)
  - Paths under `.git/` or `node_modules/` are ignored; directories (stat `'dir'`) are dropped; `pattern: '*.pdf'` drops `a.txt`; `changes: ['added']` drops changed/removed files; a burst with nothing left emits nothing.
  - 150 changed files → one emit with 100 files and `count: 100`.
  - `onError` (folder deleted) closes the watch and logs; the next `sync` reopens it.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.** In `app.ts`, `watch` = `fs.watch(dir, { recursive: true }, (_t, name) => name && onChange(String(name)))` with `.on('error', onError)`; `stat` via `fs.stat` → `isDirectory()`. The busy guard lives in the dispatcher (Task 3), not here.
- [ ] **Step 4: Run** — PASS.

---

### Task 6: Email trigger (Vault login switch, IMAP poller, Check mailbox)

**Files:**
- Modify: `zumi-bot-server/shared/src/vault.ts` (`LoginBody.workflows?: true`, list item `workflows: boolean`, input validation), `backend/src/core/vault/` store read (`workflowLogin(id)` returning `{username, password} | null` only when the item is a live login with `workflows`)
- Modify: `zumi-bot-server/frontend/src/components/VaultSettings.tsx` (a "Workflows may use it (email trigger)" switch on logins, matching the API key one)
- Create: `zumi-bot-server/backend/src/core/workflows/mailWatchers.ts`
- Modify: `zumi-bot-server/backend/package.json` (`"imapflow": "<exact>"`, `"mailparser": "<exact>"`; pick current stable versions at least two weeks old; `npm view imapflow version`), `backend/src/app.ts` (wire `mailAccount`, the poller, `sync` on change, `stop`), `backend/src/rpc/handlers.ts` + `shared/src/types.ts` + `frontend/src/net/api.ts` (`workflows:checkMail`)
- Test: `backend/tests/core/mailWatchers.test.ts`, `shared/tests/vault.test.ts`, `backend/tests/core/vaultStore.test.ts`

**Interfaces:**
- Consumes: Task 1 (`MAIL_*`, `EventBodies['email']`), Task 2 dep `mailAccount`, Task 3 `emit`.
- Produces:
  ```ts
  export interface MailClient { open(): Promise<{ uidValidity: string; uidNext: number }>; fetchSince(uid: number, max: number): Promise<{ uid: number; source: Buffer }[]>; close(): Promise<void> }
  export interface MailDeps {
    connect(o: { host: string; port: number; user: string; password: string; folder: string }): Promise<MailClient> // imapflow, TLS, logger false, mailboxOpen readOnly
    parse(source: Buffer): Promise<EventBodies['email']>   // mailparser simpleParser; text cut to MAIL_TEXT_MAX
    account(id: string): { username: string; password: string } | null
    state: { read(): Promise<MailState>; write(s: MailState): Promise<void> }   // <data>/workflow-mail.json, 0600
    emit(e: Extract<WorkflowEvent, { kind: 'email' }>, workflowId: string): void
    setTimer(fn: () => void, ms: number): { clear(): void }; now(): number; log(line: string): void
  }
  export type MailState = Record<string, { key: string; uidValidity: string; lastUid: number }> // key = `${host}|${user}|${folder}`
  export class MailWatchers { constructor(d: MailDeps); sync(ws: Workflow[]): void; checkNow(workflowId: string): Promise<void>; stop(): void }
  export function checkMailbox(d: Pick<MailDeps, 'connect' | 'account'>, t: Extract<WorkflowTrigger, { kind: 'email' }>): Promise<{ messages: number } | { error: string }>
  // RPC: workflows.checkMail(trigger): Promise<{ messages: number } | { error: string }>
  ```

- [ ] **Step 1: Write failing tests** (fake client, fake state):
  - First check for a workflow with no state records `lastUid = uidNext - 1` and emits nothing.
  - Next check with 3 new messages emits 3 events oldest first and stores the highest uid; with 25 new it emits `MAIL_PER_CHECK` (10) and the next check the next 10.
  - A different `uidValidity`, or a changed host/user/folder (key), resets to the baseline and emits nothing.
  - `account()` null → no connect, log names the workflow, never a password; a `connect` rejection whose message contains the password → logged text has it replaced by `***` (scrub with the password before logging).
  - `sync` arms one `MAIL_POLL_MS` timer per enabled email workflow and clears it for disabled/removed ones; `stop` clears all.
  - `checkMailbox` returns `{ messages: uidNext - 1 }`-style count from `open()` (use the `exists` count if you add it to `open`'s result; pick one and assert it) or `{ error }` with the password scrubbed.
  - Vault: a login saved with `workflows: true` lists `workflows: true`; `workflowLogin` returns null for a login without it, for an API key, and for a deleted item.
- [ ] **Step 2: Run** those files — FAIL.
- [ ] **Step 3: Implement**, then `npm install` and `npm run build:server` to confirm both packages bundle into `dist/server.mjs` (watch for dynamic requires; mark nothing external).
- [ ] **Step 4: Run** the tests and `npm run build:server` — PASS.

---

### Task 7: /run-workflow server side

**Files:**
- Create: `zumi-bot-server/shared/src/runWorkflow.ts`
- Modify: `zumi-bot-server/shared/src/types.ts` (`workflows.runFromChat`), `backend/src/rpc/handlers.ts`, `frontend/src/net/api.ts`
- Test: `zumi-bot-server/shared/tests/runWorkflow.test.ts`, `backend/tests/rpc/` (the workflows handler test file that exists, else the one covering `workflows:run`)

**Interfaces:**
- Produces:
  ```ts
  export const RUN_WORKFLOW_NAME = 'run-workflow'
  export const RUN_WORKFLOW_DESCRIPTION = 'Start a workflow; the text after its name is its input'
  export const NO_WORKFLOW_NAMED = 'No workflow has that name'
  export const sameNameText = (name: string): string => `Several workflows are named "${name}"`
  export function runWorkflowRest(text: string): string | null       // text after a leading `/run-workflow` (same boundary rule as /btw), trimmed; null if not that command
  export function resolveRunWorkflow(rest: string, ws: { id: string; name: string }[]): { id: string; input: string } | { error: string }
  // ZumiBotApi.workflows.runFromChat(chatId: string, text: string): Promise<WorkflowRunSummary>
  ```
- [ ] **Step 1: Write failing tests:** `runWorkflowRest('/run-workflow Daily report go')` = `'Daily report go'`; `'/run-workflowx a'` → null; `' /run-workflow a'` → null. `resolveRunWorkflow`: longest case-insensitive name prefix followed by whitespace or end wins (`Report` vs `Report weekly` with rest `report weekly now` → Report weekly, input `now`); `Reporting` does not match `Report`; no match → `{error: NO_WORKFLOW_NAMED}`; two workflows with the winning name → `{error: sameNameText(name)}`; input trimmed. Handler: starts `run(w, 'chat', { input, chat: {chatId, title}, call: eventCall({ chat, text: input, lastReply }, now) })` where `lastReply` is the chat's last assistant item text (≤ `REPLY_TEXT_MAX`); unknown chat throws `'Chat not found'`; problems throw as a manual run does.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** (handler checks args with `str()`; text capped at `TRIGGER_BODY_MAX`).
- [ ] **Step 4: Run** — PASS.

---

### Task 8: /run-workflow in the composer

**Files:**
- Modify: `zumi-bot-server/frontend/src/state/commandInput.ts` (builtin `'run-workflow'` option; `workflowQuery(before: string): string | null`; `filterWorkflowNames(query: string, ws: {id,name}[]): {id,name}[]` — case-insensitive prefix first then word prefix, max 8)
- Modify: `frontend/src/state/sideQuestions.ts` (`routeSend` returns `{ kind: 'workflow' }` for a leading `/run-workflow`)
- Modify: `frontend/src/components/CommandMenu.tsx` and the composer that opens it (a Workflows list when `workflowQuery` matches; a pick inserts `/run-workflow <Name> `), `frontend/src/App.tsx` (`sendFromComposer`: `kind 'workflow'` → `api.workflows.runFromChat(chatId, text)`, clear the draft, show "Started <name> · Open run" in the chat's notice slot; on error `failChat`); `startChat` treats it like `/btw` (no new chat from `/run-workflow`: refuse with the notice "Open a chat first")
- Test: `frontend/tests/commandInput.test.ts`, `frontend/tests/sideQuestions.test.ts`

**Interfaces:**
- Consumes: Task 7 `RUN_WORKFLOW_NAME`, `RUN_WORKFLOW_DESCRIPTION`, `api.workflows.runFromChat`.
- [ ] **Step 1: Write failing tests:** `filterCommands('run', agents)` includes `{ builtin: 'run-workflow', description: RUN_WORKFLOW_DESCRIPTION }`; not after `/todo `; `workflowQuery('/run-workflow dai')` = `'dai'`, `workflowQuery('/run-workflow')` = null (menu shows commands until the space), `workflowQuery('/run-workflow Daily report x')` still returns the text (the menu filters to none and closes); `filterWorkflowNames('rep', [...])` orders prefix matches first; `routeSend('/run-workflow x').kind === 'workflow'`.
- [ ] **Step 2: Run** `npx vitest run --project frontend -t "run-workflow|workflowQuery|filterWorkflowNames|routeSend"` — FAIL.
- [ ] **Step 3: Implement.** The notice reuses the send-error slot with an info style (add `sendNotices` state beside `sendErrors`, cleared on the next send); "Open run" navigates to `/workflows/<id>/runs/<runId>`. Not offered in the island (`btw: false` path) nor in `PromptField`.
- [ ] **Step 4: Run** — PASS.

---

### Task 9: Trigger inspector, editor fields, sidebar

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/TriggerInspector.tsx` (select options in this order with these labels: By hand, On a schedule, From a webhook, When a reply ends, When a to-do is added, When an Inbox message arrives, When a file changes, When an email arrives; per-kind panels; filters component extracted to `TriggerFilters.tsx` with an equals/contains select; event kinds list fields from `EVENT_SAMPLES` with Filter buttons)
- Modify: `frontend/src/state/workflowEditor.ts` (`switchTrigger` uses `defaultTrigger` for event kinds; template field list: event kinds offer `trigger.text` plus `trigger.<path>` for every leaf of `sampleCall` = `eventCall(EVENT_SAMPLES[kind], 0)`)
- Modify: `frontend/src/state/workflows.ts` (`triggerSummary`: `eventLabel(kind)`; file adds ` · <folder basename>`), `frontend/src/components/WorkflowIcons.tsx` (`TriggerKindIcon` gets five shapes), `frontend/src/components/WorkflowsSidebar.tsx` (run tag: event label lowercased, `chat` → "from chat")
- Modify: `frontend/src/components/RunWorkflowDialog.tsx` (event kinds: hint "A run by hand hands on only this text; trigger.body fields stay empty.")
- Test: `frontend/tests/workflowEditor.test.ts`, `frontend/tests/workflowsState.test.ts`

Per-kind panel copy (hints, exact):
- reply: "Runs when an agent's reply ends in any chat or room (replied or failed). Chats a workflow made never start it."
- todo: "Runs when you or an agent add to-dos to any chat. Its output is the new to-dos, one per line."
- inbox: "Runs when another workflow's Notify step files an Inbox message. Its own messages never start it."
- file: folder picker (`FolderPicker`), Pattern input (placeholder `*.pdf`, hint "Leave empty for every file."), three checkboxes Added / Changed / Removed, hint "Watches the folder and its subfolders on the machine the workflow runs on. Changes made while a run of this workflow is going are ignored."
- email: account select (Vault logins with `workflows`), Server, Port, Folder, **Check mailbox** button (`workflows.checkMail`, shows "N messages" or the error), hint "Checks every 2 minutes. Mail already there when you turn it on never starts a run. Nothing is marked read."
- [ ] **Step 1: Write failing tests:** `switchTrigger('file', {})` deep-equals `defaultTrigger('file')`; switching back restores the earlier one (existing `earlier` rule); the field list for an `email` workflow contains `trigger.body.subject` and `trigger.text`; `triggerSummary({kind:'file', path:'/home/u/inv', ...})` = `'File changed · inv'`; `triggerSummary({kind:'reply', filters: []})` = `'Reply ended'`.
- [ ] **Step 2: Run** those files — FAIL.
- [ ] **Step 3: Implement.** Labels from `eventLabel`: reply 'Reply ended', todo 'To-do added', inbox 'Inbox message', file 'File changed', email 'Email arrived'.
- [ ] **Step 4: Run** — PASS; `npm run typecheck` clean for frontend.

---

### Task 10: Audit log trigger entry

**Files:**
- Modify: `zumi-bot-server/frontend/src/state/auditLog.ts` (trigger model), `frontend/src/components/AuditLog.tsx`, `frontend/src/state/promptFields.ts:75` (event/chat runs are not 'manual')
- Test: `frontend/tests/auditLog.test.ts`

**Interfaces:** trigger model gains `label: string` (Manual, Schedule, Webhook, `eventLabel(kind)`, `From chat <title>`, Sub-workflow as today) and `body: unknown | null` (event and chat runs: `run.call.body`), `text` = `run.input`.
- [ ] **Step 1: Write failing tests:** an event run (`via: 'event', event: {kind: 'email'}`) yields `label: 'Email arrived'`, its body and text; a chat run yields `label: 'From chat Plans'` and `text` = input; existing webhook/schedule cases unchanged.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (body box titled "Event", JSON). **Step 4: Run** — PASS.

---

### Task 11: Zumi Bot authoring knows the new triggers

**Files:**
- Modify: `zumi-bot-server/backend/src/core/automations/authoring.ts` (`WORKFLOW_TRIGGERS` keys, `WorkflowTriggerAuthoring`, `workflowTrigger()` parse, the reverse mapping at ~line 336), `backend/src/core/automations/automationService.ts` (`scheduleText`: `eventLabel`), Zumi Bot's prompt text in `shared/src/zumiBot.ts` if it lists trigger kinds
- Test: `backend/tests/core/automationAuthoring.test.ts`

Rules: `reply`/`todo`/`inbox` keys `['kind','filters']`; `file` `['kind','path','pattern','changes','filters']`; `email` `['kind','host','port','folder','filters']` and the `account` is taken from `before` when it was an email trigger, else `''` (the workflow then has a problem and saves off). Filters accept `op`. The reverse mapping never drops a kind (today it maps unknown kinds to manual).
- [ ] **Step 1: Write failing tests:** each new kind round-trips authoring → input → authoring; an email edit keeps the saved account; an email trigger never shows `account` in the authored form; the error for a bad kind lists all eight kinds.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS.

---

### Task 12: Docs and full verification

**Files:**
- Modify: `docs/architecture/workflows.md` (a **Triggers** paragraph: kinds, event shape, dispatcher, loop guards, rate cap, watchers, mail state, `/run-workflow`), `docs/architecture/vault.md` (login `workflows` switch), `docs/architecture/data.md` (`workflow-mail.json`), `docs/architecture/agent-commands.md` (built-in `/run-workflow`), `docs/architecture/inbox.md` (Inbox messages can start workflows), `docs/architecture/zumi-bot-automations.md` (authoring kinds)
- [ ] **Step 1: Run** `npm test` — all projects PASS.
- [ ] **Step 2: Run** `npm run typecheck` — no errors.
- [ ] **Step 3: Run** `npm run build:server` — succeeds; `grep -c imapflow zumi-bot-server/backend/dist/server.mjs` > 0.
- [ ] **Step 4: Run** `npx vitest run zumi-bot-server/shared/tests/repoDocs.test.ts` — PASS (root CLAUDE.md < 16 KB).
- [ ] **Step 5:** Manual check with the `run` skill or the e2e harness if time allows: a reply-triggered workflow with a Notify step fires once per reply in a plain chat and not for its own runs.
