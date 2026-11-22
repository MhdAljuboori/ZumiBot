# Zumi Bot Routines and Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Zumi Bot creates, edits and deletes routines and workflows inside ZumiBot from a chat message, reads a chat to convert it, and replies with a link that opens the result in the app.

**Architecture:** A new stdio MCP bridge `zumibot_automations` (same shape as `zumibot_todos`) is given to Zumi Bot's runs only. Its IPC calls an `AutomationService` that converts an authoring format into the existing `RoutineInput` / `WorkflowInput`, then saves through save logic moved out of the RPC handlers so the editor and Zumi Bot share it. Deletes always ask through an approval card; writes are refused in turns the user did not type. The frontend turns app-path links into in-app navigation, and the Inbox keeps a Notify's full body.

**Tech Stack:** TypeScript, Node 22, `@modelcontextprotocol/sdk` (bridge only), React 19, vitest, playwright-core e2e with the fake claude.

**Spec:** `docs/superpowers/specs/2026-11-09-zumi-bot-routines-workflows-design.md`

## Global Constraints

- No git commits: the user commits only when they ask. Every task ends at green tests, not a commit.
- Dependencies stay pinned; add none.
- Only Zumi Bot (`ZUMI_BOT_NAME`) gets the bridge, on every attempt of its main runs and in its side runs, so its tool definitions never change between turns.
- Write refusal text, exactly: `Routines and workflows can only be changed from a message the user sends.`
- Stale refusal text, exactly: `It changed since you read it: read it again.`
- No webhook URL or secret in any tool result, log or error.
- Transcript cap `CHAT_READ_MAX = 150_000` characters, first user message and newest kept.
- `NOTIFY_INBOX_BODY_MAX = 20_000`; the push body stays `NOTIFY_BODY_MAX` (200).
- Delete card buttons: Allow and Deny only; never remembered (no chat memory, no agent rule).
- Card text: `Delete routine “<name>”` / `Delete workflow “<name>”` (curly quotes).
- Comments short and say why, as the codebase does. Pure logic in `shared/` or `frontend/src/state/` so it is unit tested.
- Resume's `Continue` counts as the user's turn (the user pressed Resume).

## Review Focus

- A link whose href is protocol-relative (`//evil.com/routines/x`), absolute to another origin, or `javascript:` must stay an ordinary new-tab link, never in-app navigation — Task 11 tests it.
- Zumi Bot named as a routine's target agent or a workflow step's agent must be refused by the service (today a routine may target Zumi Bot) — Task 7 tests it.
- A workflow with a loop edge (an edge back to an earlier step) must lay out without hanging and keep every step placed — Task 5 tests it.
- A time zone string from a page that is not a valid IANA zone must be ignored, keeping the last good one — Task 4 tests it.
- An `@` name that is a display name or differs in case (`X Expert` vs `x-expert`) must either resolve to one agent or be refused with the list of names; never saved as an unknown agent — Task 7 tests it.

---

### Task 1: Shared names, paths and step defaults

**Files:**
- Create: `zumi-bot-server/shared/src/automations.ts`, `zumi-bot-server/shared/src/appPaths.ts`, `zumi-bot-server/shared/src/workflowDefaults.ts`
- Modify: `zumi-bot-server/frontend/src/state/route.ts` (re-export `routinesPath`, `workflowsPath` from `appPaths`), `zumi-bot-server/frontend/src/state/workflowCanvas.ts:51-61` (use `stepDefaults`)
- Test: `zumi-bot-server/shared/tests/automations.test.ts`, `zumi-bot-server/shared/tests/workflowDefaults.test.ts`

**Interfaces:**
- Produces:
  - `AUTOMATIONS_SERVER = 'zumibot_automations'`, `AUTOMATION_PREFIX = 'mcp__zumibot_automations__'`
  - `AUTOMATION_TOOLS = ['routines_list','routine_get','routine_save','routine_delete','workflows_list','workflow_get','workflow_save','workflow_delete','chat_read'] as const`, `type AutomationToolName`
  - `automationTool(fullName: string): boolean`
  - `CONFIRM_ONLY_TOOLS: readonly string[]` (the two full delete names), `confirmOnly(toolName: string): boolean`
  - `automationSummary(toolName: string, input: unknown): string | null` — the delete card text, null for anything else or a missing `name`
  - `WRITE_REFUSED`, `STALE_REFUSED`, `CHAT_READ_MAX`
  - `routinesPath(routine: {id: string | null} | null): string`, `workflowsPath(workflowId: string | null, runId?: string | null, audit?: boolean): string`, `chatIdFromPath`, `archivedFromPath`, `todosFromPath` (moved verbatim with the constants they need; `route.ts` re-exports them, so the backend can parse chat addresses)
  - `stepDefaults(kind: Exclude<StepKind,'trigger'>): Record<string, unknown>` (moved verbatim from `defaultsFor`)

- [ ] **Step 1: Write the failing tests**

```ts
test('confirmOnly is only the two deletes', () => {
  expect(confirmOnly('mcp__zumibot_automations__routine_delete')).toBe(true)
  expect(confirmOnly('mcp__zumibot_automations__workflow_delete')).toBe(true)
  expect(confirmOnly('mcp__zumibot_automations__routine_save')).toBe(false)
  expect(confirmOnly('mcp__other__routine_delete')).toBe(false)
})
test('automationSummary names the target', () => {
  expect(automationSummary('mcp__zumibot_automations__routine_delete', { id: 'a', name: 'Daily tech' })).toBe('Delete routine “Daily tech”')
  expect(automationSummary('mcp__zumibot_automations__workflow_delete', { id: 'a', name: 'W' })).toBe('Delete workflow “W”')
  expect(automationSummary('mcp__zumibot_automations__routine_delete', { id: 'a' })).toBeNull()
  expect(automationSummary('Bash', { name: 'x' })).toBeNull()
})
test('stepDefaults match the canvas', () => {
  expect(stepDefaults('llm')).toEqual({ model: 'haiku', effort: 'low', prompt: '' })
  expect(stepDefaults('foreach')).toEqual({ agent: '', prompt: '', cwd: '' })
})
```

- [ ] **Step 2: Run** `npx vitest run --project shared` — expect FAIL (modules missing).
- [ ] **Step 3: Implement the three modules; point `route.ts` and `workflowCanvas.ts` at them.**
- [ ] **Step 4: Run** `npx vitest run --project shared --project frontend` and `npm run typecheck` — expect PASS (the existing route and canvas tests too).

---

### Task 2: Move routine and workflow save logic out of the handlers

**Files:**
- Create: `zumi-bot-server/backend/src/core/routines/routineEditing.ts`, `zumi-bot-server/backend/src/core/workflows/workflowEditing.ts`
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts:797-835` and `:908-947` (handlers call the new functions), `zumi-bot-server/backend/src/app.ts` (build both once, pass to handlers)
- Test: `zumi-bot-server/backend/tests/core/routineEditing.test.ts`, `zumi-bot-server/backend/tests/core/workflowEditing.test.ts`; existing `tests/rpc/handlers.test.ts` must stay green

**Interfaces:**
- Produces:
  - `routineEditing(d: { store: RoutineStore; scheduler: { rearm(): Promise<void> }; changed(): void; newSecret(): string; now?: () => number }): { save(input: RoutineInput, o?: { webhookWithoutSample?: true }): Promise<Routine>; remove(id: string): Promise<void> }`
    - Same body as today's `routines:save` / `routines:remove`. With `webhookWithoutSample`, a webhook trigger with no hook `latest` saves with `sample: null` instead of throwing, and `store.ensureHook(id, newSecret, now)` runs after the routine exists.
  - `workflowEditing(d: { store: WorkflowStore; runner: Pick<WorkflowRunner, 'problems' | 'stopAllOf'>; scheduler: { rearm(): Promise<void> }; changed(): void; newSecret(): string; now?: () => number }): { save(input: WorkflowInput, o?: { ensureHook?: true }): Promise<{ workflow: Workflow; problems: Problem[] }>; remove(id: string): Promise<void> }`
    - Same body as today's `workflows:save` (including `withSample`) / `workflows:remove`; `problems` is `runner.problems(saved)` after the save. With `ensureHook`, a webhook workflow gets `store.hooks.ensureHook(id, newSecret, now)` after it exists.

- [ ] **Step 1: Write the failing tests** — routine: a new schedule routine is put with `nextRunAt` from `nextFor` and `rearm` + `changed` each called once; a webhook routine without a hook throws `Webhook needs a test call before saving` by default and, with `webhookWithoutSample`, saves `sample: null` and leaves a hook whose `latest` is null. Workflow: a save that would turn on a workflow with problems saves it off and returns those problems; `remove` calls `stopAllOf` before `store.remove`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/routineEditing.test.ts zumi-bot-server/backend/tests/core/workflowEditing.test.ts` — expect FAIL.
- [ ] **Step 3: Implement; make the four handlers one-line calls** (`workflows:save` returns `.workflow`).
- [ ] **Step 4: Run** `npx vitest run --project backend` — expect PASS, handler tests unchanged.

---

### Task 3: Carry "the user did not type this" to the turn

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts:105-113` (`QueuedTask.auto?: true`), `zumi-bot-server/backend/src/core/chat/taskQueue.ts:90-117,406-417`, `zumi-bot-server/backend/src/core/chat/chatService.ts:260-292,646-653` (and `sendTurn`)
- Test: `zumi-bot-server/backend/tests/core/taskQueue.test.ts`

**Interfaces:**
- Produces: `TurnSpec.auto?: true` (set for a turn started by `submit(..., 'routine')`, directly or from the queue); `ChatService.send(chatId, text, attachments?, replyTo?, messageId?, command?, todo?, auto?: true)`. Sends, edits, resends, Send now and Resume's Continue leave it unset.

- [ ] **Step 1: Write the failing tests** (in `taskQueue.test.ts`) — `submit(..., 'routine')` on an idle chat calls `chats.send` with `true` as its last argument; queued while busy, the stored task has `auto: true` and `pump` sends it with `true` last; a user submit stores no `auto` and sends without it. (That `ChatService` turns it into `writable: false` is tested in Task 9.)
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/taskQueue.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** `withTail` already drops trailing undefined, so other sends are unchanged.
- [ ] **Step 4: Run** `npx vitest run --project backend` — expect PASS.

---

### Task 4: The user's time zone on the server

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`AppSettings.timeZone?: string`; `ZumiBotApi.setTimeZone(tz: string): Promise<void>`), `zumi-bot-server/backend/src/core/store/settingsStore.ts`, `zumi-bot-server/backend/src/rpc/handlers.ts` (`'app:setTimeZone'`), `zumi-bot-server/frontend/src/net/api.ts`, `zumi-bot-server/frontend/src/App.tsx` (call once per connect with `Intl.DateTimeFormat().resolvedOptions().timeZone`, fire-and-forget)
- Test: `zumi-bot-server/backend/tests/core/settingsStore.test.ts`, `zumi-bot-server/backend/tests/rpc/handlers.test.ts`

**Interfaces:**
- Produces: `SettingsStore.setTimeZone(tz: string): Promise<void>` (ignores a string `new Intl.DateTimeFormat('en', { timeZone: tz })` throws on, or longer than 64; writes only on change), `SettingsStore.timeZone(): Promise<string | null>`.

- [ ] **Step 1: Write the failing tests** — `setTimeZone('Europe/Istanbul')` then `timeZone()` is `'Europe/Istanbul'`; `setTimeZone('Not/AZone')` afterwards leaves it `'Europe/Istanbul'`; the handler rejects a non-string.
- [ ] **Step 2: Run** the two test files — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project backend` and `npm run typecheck` — expect PASS.

---

### Task 5: Authoring format and layout (pure)

**Files:**
- Create: `zumi-bot-server/backend/src/core/automations/authoring.ts`, `zumi-bot-server/backend/src/core/automations/layout.ts`
- Test: `zumi-bot-server/backend/tests/core/automationAuthoring.test.ts`, `zumi-bot-server/backend/tests/core/automationLayout.test.ts`

**Interfaces:**
- Consumes: `stepDefaults` (Task 1), `parseRoutineInput`, `parseWorkflowInput`, `handleFor`, `portsOf`.
- Produces:
  - `interface AuthoringCtx { timeZone: string; folders: Record<string, string>; groupFolder: string | null; home: string; newId(): string }` — `folders` is `settings.lastFolderByAgent`; a missing folder is `folders[agent] ?? home`, a room's `groupFolder ?? home`
  - `routineFromAuthoring(raw: unknown, ctx: AuthoringCtx): RoutineInput` — fills `enabled` (true), `timeZone`, `target.cwd`, the three policies, `id`, drops any `command`, then runs `parseRoutineInput`. Throws plain sentences.
  - `routineToAuthoring(r: Routine): object` — `{id, updatedAt, name, enabled, timeZone, trigger (webhook without sample), target, prompt, limitPolicy, missedPolicy, sessionPolicy}`.
  - `workflowFromAuthoring(raw: unknown, before: Workflow | null, ctx: AuthoringCtx): WorkflowInput` — builds the trigger step (handle `trigger`, kept id and x/y from `before`), maps handles to ids (an existing handle keeps its id and x/y), edge ids new or kept by `(from,port,to)`, fills kind defaults and `cwd`, `enabled` true, then `layout` for steps with no position, then `parseWorkflowInput`.
  - `workflowToAuthoring(w: Workflow): object` — the authoring shape, no ids, no x/y, no trigger step.
  - `layout(steps: {id: string}[], edges: {from: string; to: string}[], triggerId: string, placed: Map<string, {x: number; y: number}>): Map<string, {x: number; y: number}>` — column = longest path from the trigger ignoring back edges (DFS colouring), `x = col * 320`, `y = row * 140` in reach order; a step already in `placed` keeps its place; on edit, a new step goes one column right of its first source, below the lowest step in that column. Unreachable steps go in a last column.

- [ ] **Step 1: Write the failing tests**

```ts
test('routine defaults', () => {
  const r = routineFromAuthoring({ name: 'Daily', trigger: { kind: 'schedule', schedule: { freq: 'daily', time: '09:00', days: [0,1,2,3,4,5,6] } },
    target: { kind: 'new-chat', agent: 'x-expert' }, prompt: 'p' }, ctx({ tz: 'Europe/Istanbul', folder: '/home/u/x' }))
  expect(r).toMatchObject({ enabled: true, timeZone: 'Europe/Istanbul', target: { cwd: '/home/u/x' }, limitPolicy: 'wait', missedPolicy: 'run-once', sessionPolicy: 'continue' })
})
test('workflow handles become ids and edits keep positions', () => {
  // hashtagWorkflow: find (agent) → filter (llm) → each (foreach) → links (llm) → tell (notify), from the spec's example
  const saved = asSaved(workflowFromAuthoring(hashtagWorkflow, null, ctx()))
  // the user moved `find` on the canvas; the edit adds `none` (notify) after a new `any` (condition)
  const moved = moveStepInFixture(saved, 'find', { x: 40, y: 500 })
  const edited = workflowFromAuthoring(withAnyGuard(hashtagWorkflow), moved, ctx())
  expect(edited.steps.find(s => s.handle === 'find')).toMatchObject({ id: idOf(saved, 'find'), x: 40, y: 500 })
  expect(edited.steps.find(s => s.handle === 'none')!.id).not.toBe(idOf(saved, 'tell'))
})
test('bad port and repeated handle are refused', () => {
  expect(() => workflowFromAuthoring(withEdge({ from: 'find', port: 'yes', to: 'filter' }), null, ctx())).toThrow(/port/)
  expect(() => workflowFromAuthoring(withSteps([agent('a'), agent('a')]), null, ctx())).toThrow(/handle/)
})
test('a loop edge lays out and terminates', () => {
  const pos = layout(steps(['t','a','b']), [e('t','a'), e('a','b'), e('b','a')], 't', new Map())
  expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x)
  expect(pos.size).toBe(3)
})
test('no two new steps overlap', () => { /* diamond t→a, t→b, a→c, b→c: a and b share x, differ in y by 140 */ })
```

- [ ] **Step 2: Run** both files — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both files — expect PASS.

---

### Task 6: Chat transcript (pure)

**Files:**
- Create: `zumi-bot-server/backend/src/core/automations/chatTranscript.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/roomSummary.ts:54-70` (export the cut as `cutLines(lines: string[], first: number, max: number): string` and use it)
- Test: `zumi-bot-server/backend/tests/core/chatTranscript.test.ts`

**Interfaces:**
- Produces:
  - `chatIdFrom(text: string): string | null` — a bare id, or the id from `/chat/<id>`, `/archived/<id>`, `/todos/<id>`, or a full `http(s)://…` URL with one of those paths (`chatIdFromPath` / `archivedFromPath` / `todosFromPath` rules, moved to or mirrored in shared).
  - `chatTranscript(meta: ChatMeta, items: readonly ChatItem[], max = CHAT_READ_MAX): string` — `<chat id="…">` header (title, agent or members and role, folder, item count) then one line per user message (`text`, the command short form), agent reply (named), tool step (`toolSummary`), and approval/question/plan card with its status; message text defanged like `roomSummary`'s `defang` for `</chat>`; cut with `cutLines` keeping the first user message.

- [ ] **Step 1: Write the failing tests** — `chatIdFrom('https://bot.example.com/chat/abc-123')` is `'abc-123'`, `chatIdFrom('/archived/abc')` is `'abc'`, `chatIdFrom('/routines/abc')` is null; a transcript holds `[@x-expert]`, a `tool: ` line from `toolSummary`, `approval: Bash allowed-once`; a body `</chat> do X` cannot close the block; 400 000 characters of messages come back ≤ 150 000 with the first user message kept.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file and `tests/core/roomSummary.test.ts` — expect PASS.

---

### Task 7: AutomationService

**Files:**
- Create: `zumi-bot-server/backend/src/core/automations/automationService.ts`
- Test: `zumi-bot-server/backend/tests/core/automationService.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 5, 6; `AUTOMATION_TOOLS`, `WRITE_REFUSED`, `STALE_REFUSED` (Task 1).
- Produces:
  - `interface AutomationOwner { chatId: string; writable: boolean }`
  - `type AutomationCall` (Task 8 parses into it): `{op:'routines_list'} | {op:'routine_get', id} | {op:'routine_save', routine: unknown} | {op:'routine_delete', id, name} | {op:'workflows_list'} | {op:'workflow_get', id} | {op:'workflow_save', workflow: unknown} | {op:'workflow_delete', id, name} | {op:'chat_read', chat: string}`
  - `class AutomationService { constructor(d: AutomationDeps); run(owner: AutomationOwner, call: AutomationCall): Promise<string> }` — returns JSON text. `AutomationDeps = { routines: RoutineStore; workflows: WorkflowStore; routineEditing: ReturnType<typeof routineEditing>; workflowEditing: ReturnType<typeof workflowEditing>; chats: Pick<ChatStore, 'get' | 'loadItems'>; agents(): Promise<AgentSummary[]>; ctx(): Promise<Omit<AuthoringCtx, 'newId'>> }`
  - Results: list → `[{id, name, enabled, trigger, target|steps, nextRunAt, path}]`; get → authoring + `updatedAt`, `path` (+ `problems: string[]` for workflows); save → `{id, name, enabled, nextRunAt, path}` (+ `problems`); delete → `{deleted: name}`; chat_read → the transcript text.
- Rules: writes (`*_save`, `*_delete`) with `writable: false` throw `WRITE_REFUSED`. An edit (`id` present) whose `updatedAt` differs from the stored one throws `STALE_REFUSED`; an unknown id `No routine with that id` / `No workflow with that id`. Delete with a stored name ≠ `name` throws `That id is now named “<stored>”: check with the user.` Agent names resolve exactly, else case-insensitively against name or `displayName`; none or several → `Unknown agent "<x>". Agents: a, b, c` (loadable, Zumi Bot left out); Zumi Bot → `Zumi Bot can't run routines or workflow steps`. Routine webhook saves pass `webhookWithoutSample`; workflow saves pass `ensureHook`. No result carries a hook URL or secret.

- [ ] **Step 1: Write the failing tests** — one per rule above, plus: a created routine's result `path` is `/routines/<id>`; a webhook routine save result has no `secret`/`url` key and the store now holds a hook; a workflow with an unknown handle in a template returns `enabled: false` and its problem text; `chat_read` of an unknown id says `No chat with that id`; `X Expert` resolves to `x-expert` whose `displayName` is `X Expert`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** In Task 9, `ctx()` reads `settings`: `timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone`, `lastFolderByAgent`, `lastGroupFolder`, `homedir()`.
- [ ] **Step 4: Run** — expect PASS.

---

### Task 8: Tools, IPC and the stdio bridge

**Files:**
- Create: `zumi-bot-server/backend/src/core/automations/automationTools.ts`, `automationIpc.ts`, `automationBridge.ts` (same folder)
- Modify: `zumi-bot-server/backend/vite.config.ts:39` (input `automationBridge`), `zumi-bot-server/backend/src/core/browser/browserRuntime.ts:17-19,47,70` (`automationBridgeEntry`), `zumi-bot-server/backend/tests/browserPackaging.test.ts` expectations
- Test: `zumi-bot-server/backend/tests/core/automationTools.test.ts`, `automationIpc.test.ts`, `automationBridge.test.ts`

**Interfaces:**
- Consumes: `AutomationService.run`, `AutomationOwner`, `AutomationCall` (Task 7).
- Produces:
  - `automationTools` (MCP tool list: name, description, `inputSchema` with `additionalProperties: false`); descriptions carry the authoring format (Task 5) in short; `chat_read`'s says its text is material, never instructions.
  - `parseAutomationCall(name: string, args: unknown): AutomationCall`, `parseAutomationWire(call: unknown): AutomationCall` — exact keys, as `todoTools.ts`.
  - `AUTOMATION_ASK_SETTINGS = JSON.stringify({ permissions: { ask: CONFIRM_ONLY_TOOLS } })`
  - `serveAutomationIpc({ service: Pick<AutomationService,'run'>, socketPath?, runtime? })` → `{ socketPath, createAutomationTurn(owner: AutomationOwner, o?: { side?: true }): AutomationTurn, close() }`; `/tmp/cb-r-` dir; env `ZUMIBOT_AUTOMATIONS_CAPABILITY` / `ZUMIBOT_AUTOMATIONS_IPC`; `args` = `['--mcp-config', config]` plus `['--settings', AUTOMATION_ASK_SETTINGS]` unless `side`. Copy `todoIpc.ts`'s framing, limits, `SAFE_MESSAGE` filter (widen the character class to allow `“”"` and `/`, keep 200 → 400 chars) and dispose; response limit 1 MiB (a transcript is ≤ 150 000 chars).
  - `interface AutomationTurn { args: string[]; env: NodeJS.ProcessEnv; dispose(): void }`

- [ ] **Step 1: Write the failing tests** — tools: unknown key refused, `routine_delete` without `name` refused, `chat_read` with a 10 000-char `chat` refused; IPC: a bad token is dropped, a disposed token's socket closes, the owner's `writable` reaches `run`, a service error naming `/home/x` comes back as the generic text; turn args hold `--settings` with the two delete names, and not when `side`; the env token is not in `args`; bridge (spawned as `askBridge.test.ts` does): `tools/list` returns the nine names, a `routines_list` call returns the service's text.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three files and `npx vitest run zumi-bot-server/backend/tests/browserPackaging.test.ts` — expect PASS.

---

### Task 9: Wire the bridge into Zumi Bot's runs

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (deps `automationTurns?: { create(owner: AutomationOwner, o?: { side?: true }): AutomationTurn }`; `automationTurn()` helper like `todoTurn`; in `attempt` after asks: only when `spec.agentName === ZUMI_BOT_NAME && !spec.compact`, owner `{ chatId, writable: !spec.auto }`, args after `ask?.args` and before `desktop?.args`, env merged, token values into `privateValues`, disposed in the `finally`; in `sideBrowser`: when `agent === ZUMI_BOT_NAME`, a side turn after asks; permission: `ownAutomation(name)` allows without card when `!confirmOnly(name)`; for `confirmOnly` names skip both remembered-allow branches and the Jev risk call, place a pending card; in the decision path (`:1240`) treat `allow-chat`/`allow-agent` on a `confirmOnly` card as `allow-once`), `zumi-bot-server/backend/src/app.ts` (serve the IPC near `serveTodoIpc`, building `AutomationService` with closures to `routineEditing`, `workflowEditing`, the stores, `chats`, `agents.list`, `settings`; pass `automationTurns`; close it at stop like the others)
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 7, 8.

- [ ] **Step 1: Write the failing tests** — a Zumi Bot `send(..., true)` (Task 3's `auto`) creates its automation turn with `writable: false`, a plain send with `writable: true`; a Zumi Bot turn spawns with the automation `--mcp-config` and its `--settings`, merged into one `--settings` by `buildArgs`; another agent's turn has neither; a `/compact` has neither; a routine-sourced turn's owner has `writable: false`; a `permissionRequest` for `…__routine_save` is answered allow with no card; one for `…__routine_delete` places a `pending` card even when the chat's allowed set and the agent rules hold that key; answering it `allow-agent` stores no rule and adds nothing to the chat's allowed set; Zumi Bot's side run gets the turn without `--settings`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project backend` and `npm run typecheck` — expect PASS.

---

### Task 10: The delete card in the UI

**Files:**
- Modify: `zumi-bot-server/shared/src/toolSummary.ts` (use `automationSummary` first), `zumi-bot-server/frontend/src/state/toolLabel.ts` (head line from `automationSummary` for the deletes), `zumi-bot-server/frontend/src/components/ApprovalCard.tsx:72-89` (hide `approval-allow-chat` and `approval-allow-agent` when `confirmOnly(item.toolName)`), `zumi-bot-server/frontend/src/components/InboxCard.tsx` if it renders its own buttons (check; reuse `ApprovalCard`)
- Test: `zumi-bot-server/shared/tests/toolSummary.test.ts`, `zumi-bot-server/frontend/tests/toolLabel.test.ts`

- [ ] **Step 1: Write the failing tests** — `toolSummary('mcp__zumibot_automations__workflow_delete', { id: 'x', name: 'Hashtags' })` is `Delete workflow “Hashtags”`; `toolLabel` of the same call has that head.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run --project shared --project frontend` — expect PASS.

---

### Task 11: In-app links

**Files:**
- Create: `zumi-bot-server/frontend/src/state/appLink.ts`
- Modify: `zumi-bot-server/frontend/src/components/Markdown.tsx:32-44` (`a` renderer)
- Test: `zumi-bot-server/frontend/tests/appLink.test.ts`

**Interfaces:**
- Produces: `appPath(href: string | undefined, origin: string): string | null` — `new URL(href, origin)`; null unless same origin, `http(s)`, and one of `chatIdFromPath`, `routinesFromPath`, `workflowsFromPath`, `inboxFromPath`, `todosFromPath`, `archivedFromPath`, `settingsFromPath` accepts its pathname; returns pathname + search + hash. `plainClick(e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
const o = 'https://bot.example.com'
expect(appPath('/routines/0f6c…', o)).toBe('/routines/0f6c…')
expect(appPath('https://bot.example.com/workflows/w1', o)).toBe('/workflows/w1')
expect(appPath('//evil.com/routines/x', o)).toBeNull()
expect(appPath('https://evil.com/routines/x', o)).toBeNull()
expect(appPath('javascript:alert(1)', o)).toBeNull()
expect(appPath('/api/files/x', o)).toBeNull()
expect(plainClick({ button: 0, metaKey: false, ctrlKey: true, shiftKey: false, altKey: false })).toBe(false)
```

- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** In `Markdown.tsx`, an `appPath` link renders without `target`; on a `plainClick` it calls `preventDefault()`, `history.pushState(null, '', path)` and `window.dispatchEvent(new PopStateEvent('popstate'))`, so `App.tsx`'s `onPop` runs it through `navigate` and the unsaved-changes guard. Others keep `target="_blank"`. The inline renderer uses the same `a`.
- [ ] **Step 4: Run** `npx vitest run --project frontend` — expect PASS.

---

### Task 12: Notify keeps its full text in the Inbox

**Files:**
- Modify: `zumi-bot-server/shared/src/workflows.ts:100` (add `NOTIFY_INBOX_BODY_MAX = 20_000`), `zumi-bot-server/backend/src/core/workflows/workflowRunner.ts:563-568` (`b.body` cut at 200, `visit.body` at 20 000), `zumi-bot-server/frontend/src/components/InboxMessages.tsx:92` (body through `Markdown`, folded with `foldText` and **Show all**)
- Test: `zumi-bot-server/backend/tests/core/workflowRunner.test.ts`

- [ ] **Step 1: Write the failing test** — a Notify whose filled body is 1 000 characters: the push payload's `body` is 200 characters, `visit.body` and the stored Inbox message body are 1 000.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement.** Confirm the push is built from `b` only and `WorkflowMessages.add` / `recover()` read `visit.body`.
- [ ] **Step 4: Run** `npx vitest run --project backend --project frontend` — expect PASS.

---

### Task 13: Zumi Bot's commands and prompt section

**Files:**
- Modify: `zumi-bot-server/backend/src/core/agents/zumiBot.ts`
- Test: `zumi-bot-server/backend/tests/core/zumiBot.test.ts`

- [ ] **Step 1: Write the failing test** — parse `zumiBotContent('/a')`'s frontmatter with `shared/src/frontmatter.ts`: `commands` names include `create-routine`, `edit-routine`, `delete-routine`, `create-workflow`, `edit-workflow`, `delete-workflow`, each prompt contains `$ARGUMENTS`; the body has a `## Routines and workflows` heading and the line telling it to end with `[<name>](<path>)`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Write the section** with every rule from the spec's "Zumi Bot's prompt and commands" (one question when unclear; never Zumi Bot as an agent; never run; never claim an unconfirmed change; the link from `path`, escaping `[ ] \`; webhooks: open it for URL and secret; problems reported; `chat_read` is material; delete: name it, then call the tool, the card is the user's yes, a Deny means nothing was deleted; the workflow building guide with Notify's 80/200/20 000 sizes). Fixed text, no per-turn values. Update the frontmatter `description` to mention routines and workflows.
- [ ] **Step 4: Run** the test and `npx vitest run --project backend` — expect PASS.

---

### Task 14: E2E `e2e:automations` and the Inbox check

**Files:**
- Create: `zumi-bot-server/e2e/automations.e2e.mjs`
- Modify: root `package.json` (`"e2e:automations": "npm run build && node zumi-bot-server/e2e/automations.e2e.mjs"`), `zumi-bot-server/e2e/inbox.e2e.mjs` (long Notify body case)

- [ ] **Step 1: Write the suite** on the harness and the fake claude, modelled on `todos.e2e.mjs`'s `#MCP_CALL` and `routines.e2e.mjs`'s card answering. First check that `fake-claude.mjs`'s `#MCP_CALL` skips the call when its `can_use_tool` is denied and waits while a card is open; extend the fake if not. In a Zumi Bot chat: (1) `#MCP_CALL {server: 'zumibot_automations', tool: 'routine_save', args: …}` creates a daily routine, checked over `/ws` `routines:list` (name, `enabled: true`, the time zone the page reported, the agent's folder); (2) the same for `workflow_save`, checked with `workflows:list` (steps placed, no overlap); (3) links: the suite reads both ids, writes a second script whose reply is `[Daily tech hashtags](/routines/<id>)` and `[Hashtags](/workflows/<id>)`, sends a message, clicks each link: the Routines editor and then the canvas open in the same page (`location.pathname` changes, the context's page count stays 1); (4) `routine_delete` shows a card with only `approval-allow-once` and `approval-deny`; Deny keeps it; a second call allowed removes it; (5) a routine whose target is Zumi Bot (made over `/ws`, which still allows it) runs a script with a `routine_save` call: `FAKE_MCP_RESULTS_OUT` shows the write refusal; (6) a stale `updatedAt` edit returns the stale refusal. In `inbox.e2e.mjs`: a Notify body of 600 characters with three links arrives whole in the Inbox with clickable links, and the decrypted push body is 200 characters.
- [ ] **Step 2: Run** `npm run e2e:automations` and `npm run e2e:inbox` — expect PASS.

---

### Task 15: Docs

**Files:**
- Modify: `CLAUDE.md` (Commands: `e2e:automations`, what it covers and that it costs no quota; Architecture: a **Zumi Bot automations** paragraph covering the bridge, Zumi Bot-only wiring, `writable`/`auto`, the authoring format, layout, delete card, time zone, `chat_read`, in-app links; the Notify/Inbox 20 000 rule under Workflows and Inbox)

- [ ] **Step 1: Write the docs** in the file's existing style.
- [ ] **Step 2: Run** `npm test` and `npm run typecheck` — expect PASS across all projects.
