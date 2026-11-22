# Workflow For each step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `foreach` workflow step that runs one agent per line of its input, one item at a time, each in a fresh chat, with `3 / 36 · <item>` progress and Retry of failed items only.

**Architecture:** Items live inside the For each visit (`Visit.items`), so the engine (joins, caps, deliveries) still sees one visit per step. `WorkflowAgentSteps` is generalised from "visit" to "slot" (a visit id or an item id) so one chat-following machine serves Agent visits and For each items. The runner starts items one by one inside its per-run queue and ends the visit when no item is left.

**Tech Stack:** TypeScript, React 19, vitest, playwright-core e2e with the fake workflow claude.

**Spec:** `docs/superpowers/specs/2026-11-08-workflow-for-each-design.md`

## Global Constraints

- Constants: `FOREACH_ITEMS_MAX = 100`, `FOREACH_ITEM_MAX = 1_000`, `FOREACH_ITEM_OUTPUT_MAX = 20_000`, `FOREACH_OUTPUT_MAX = 100_000`, `FOREACH_CURRENT_MAX = 80`.
- Copy, verbatim: `The list has ${n} items; the most is 100`, `Item ${k} is over 1 000 characters`, `${failed} of ${total} items failed`, `Use {{item}} in the prompt`, `No items in the input`, `… (cut; the full reply is in the run view)`, `Runs once per line of its input, each in a fresh chat. Use {{item}} for the line.`, `Runs the first item only.`
- Item chat title: `<workflow> · <step> · <item cut to 60> · <date>`; nothing per item enters the system prompt (`workflowSystem(name)` stays as is).
- Only the current item's text (≤ 80 characters) may ride `workflows:changed`; outputs never do.
- No new dependencies. Comments short and about *why*.
- **Do not commit.** The user's global rule: commits only when the user asks. Each task ends by staging its files.
- Run tests from the repo root: `npx vitest run <path>`; typecheck with `npm run typecheck`.

## Review Focus

1. **Item text as an attack:** an item holding `</input>` or `{{trigger.text}}` must stay literal inside its `<input from="item">` block (Task 2 test).
2. **Item chat deleted mid-item:** that item fails `Chat was deleted` and the next item starts (Task 5 test).
3. **Workflow deleted mid-loop:** `stopAllOf` stops the running item's chat and no later item starts (Task 5 test).
4. **Restart after an item was marked running but before its message was sent:** it is started again, not failed (Task 5 test).
5. **Step's agent deleted while the loop runs:** each later item fails `Agent "x" not found` without a chat, and the visit fails with the count (Task 5 test).

---

### Task 1: Shared model and pure helpers

**Files:**
- Modify: `zumi-bot-server/shared/src/workflows.ts` (StepKind, Step, ItemRun, Visit.items, constants, RunProgress, `progressOf`, `summaryOf`)
- Modify: `zumi-bot-server/shared/src/types.ts:151` (`WorkflowLink`)
- Create: `zumi-bot-server/shared/src/workflowForEach.ts`
- Test: `zumi-bot-server/shared/tests/workflowForEach.test.ts` (create), `zumi-bot-server/shared/tests/workflowGraph.test.ts` (summaryOf)

**Interfaces:**
- Produces (in `workflows.ts`; `progressOf` lives here, not in `workflowForEach.ts`, to avoid a value import cycle):
  ```ts
  export type StepKind = 'trigger' | 'agent' | 'foreach' | 'llm' | 'condition' | 'approval' | 'wait' | 'notify'
  // Step union gains:
  | (StepBase & { kind: 'foreach'; agent: string; prompt: string; cwd: string; model?: ModelAlias })
  export type ItemStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'
  export interface ItemRun {
    id: string; n: number; text: string; status: ItemStatus
    chatId?: string; messageId?: string; until?: number
    output?: string; error?: string; costUsd?: number
    carried?: true // ended in an earlier visit of this step; not run in this one
    startedAt?: number; endedAt?: number
  }
  // Visit gains: items?: ItemRun[]
  export interface RunProgress { stepId: string; done: number; failed: number; total: number; current: string | null }
  // WorkflowRunSummary gains: progress?: RunProgress[]  (absent when empty)
  export function progressOf(r: Pick<WorkflowRun, 'visits'>): RunProgress[]
  ```
- Produces (in `workflowForEach.ts`):
  ```ts
  export const ITEM_CUT_NOTE = '… (cut; the full reply is in the run view)'
  export function parseItems(input: string): { items: string[] } | { error: string }
  export function newItems(texts: string[], newId: () => string): ItemRun[] // all pending, n from 1
  export function itemCounts(items: ItemRun[]): { done: number; failed: number; pending: number; total: number }
  export function nextPending(items: ItemRun[]): ItemRun | undefined
  export function joinItemOutputs(items: Pick<ItemRun, 'text' | 'output'>[]): string
  export function retryItems(items: ItemRun[], newId: () => string, only?: string): ItemRun[]
  export const itemsFailedText = (failed: number, total: number): string
  ```
- Produces (in `types.ts`): `WorkflowLink` gains `item?: { n: number; total: number }`.

- [ ] **Step 1: Write the failing tests** in `workflowForEach.test.ts`:
  - `parseItems trims lines, drops empty ones and exact repeats, keeps order`: `parseItems(' Parent-120 Home Page \n\n Inbox\nInbox\r\nGrid')` → `{ items: ['Parent-120 Home Page', 'Inbox', 'Grid'] }`; `parseItems('')` → `{ items: [] }`.
  - `parseItems refuses more than 100 items`: 101 distinct lines → `{ error: 'The list has 101 items; the most is 100' }`.
  - `parseItems refuses an item over 1 000 characters`: third line of 1 001 chars → `{ error: 'Item 3 is over 1 000 characters' }`.
  - `joinItemOutputs heads each reply with its item`: `[{text:'A',output:'x'},{text:'B',output:'y'}]` → `'## A\n\nx\n\n## B\n\ny'`.
  - `joinItemOutputs gives each item an equal share of 100 000`: three items with 60 000-char outputs → length ≤ 100 000, contains all three headings, each section ends with `ITEM_CUT_NOTE`.
  - `retryItems carries done items and resets failed and pending ones`: input `[done a (chatId c1, output 'x', costUsd 1), failed b (chatId c2, error, messageId), pending c]` → a `{status:'done', carried:true, output:'x', chatId:'c1'}`, b `{status:'pending', chatId:'c2'}` with no `error`/`output`/`messageId`/`until`/`startedAt`/`endedAt`, c pending; every id new, `n` kept.
  - `retryItems with one item id resets only that item`: two failed items b, c, `only = b.id` → b pending, c `{status:'failed', carried:true}` keeping its error.
  - `itemsFailedText(2, 36)` → `'2 of 36 items failed'`.
  - `progressOf counts an open for each visit and names its current item`: running visit with items `[done, running 'Gallery View', pending]` → `[{ stepId, done: 1, failed: 0, total: 3, current: 'Gallery View' }]`; a 200-char current is cut to 80; a done visit gives `[]`; carried done items count as done.
  
  And in `workflowGraph.test.ts`: `summaryOf carries progress only while a for each visit is open` (absent key when none).

- [ ] **Step 2: Run them to see them fail**
  Run: `npx vitest run zumi-bot-server/shared/tests/workflowForEach.test.ts zumi-bot-server/shared/tests/workflowGraph.test.ts`
  Expected: FAIL (module not found / missing exports).

- [ ] **Step 3: Implement** the types, constants and functions above. `parseItems`: split on `\r?\n`, trim, drop `''`, dedupe with a `Set`; check the count first, then each item's length; the number in the length error uses the same thin-space grouping as `workflowGraph.ts`'s `spaced` (move `spaced` into `workflows.ts` and import it in both). `joinItemOutputs`: share = `Math.floor(FOREACH_OUTPUT_MAX / items.length)` minus the heading's length; a reply longer than its share is cut and gets `\n${ITEM_CUT_NOTE}`. `progressOf`: one entry per visit whose status is running or waiting and that has `items`, in visit order; `current` = the running or waiting item's text cut to `FOREACH_CURRENT_MAX`, else null. `summaryOf` spreads `progress` only when non-empty.

- [ ] **Step 4: Run the tests to see them pass** (same command). Expected: PASS.

- [ ] **Step 5: Stage** `git add zumi-bot-server/shared/src/workflows.ts zumi-bot-server/shared/src/types.ts zumi-bot-server/shared/src/workflowForEach.ts zumi-bot-server/shared/tests/workflowForEach.test.ts zumi-bot-server/shared/tests/workflowGraph.test.ts`

---

### Task 2: Templates and graph checks

**Files:**
- Modify: `zumi-bot-server/shared/src/workflowTemplate.ts` (`TemplateCtx`, `fillTemplate`, `modelPrompt`)
- Modify: `zumi-bot-server/shared/src/workflowGraph.ts` (`textFields`, `problemsOf`)
- Test: `zumi-bot-server/shared/tests/workflowTemplate.test.ts`, `zumi-bot-server/shared/tests/workflowGraph.test.ts`

**Interfaces:**
- Consumes: Task 1's `Step` union.
- Produces:
  ```ts
  // TemplateCtx gains: item?: { text: string; number: number; total: number }
  export function modelPrompt(prompt: string, ctx: TemplateCtx, handles: Record<string, string>, o?: { appendInputs?: boolean }): { text: string; missing: string[] }
  export const USE_ITEM_TEXT = 'Use {{item}} in the prompt' // in workflowGraph.ts
  ```

- [ ] **Step 1: Write the failing tests**
  - `fillTemplate fills item fields when the context has an item`: `'Check {{item}} ({{item.number}}/{{item.total}})'` with `item: {text:'Inbox', number:3, total:36}` in model mode → `'Check <input from="item">\nInbox\n</input> (3/36)'`; raw mode → `'Check Inbox (3/36)'`.
  - `item fields are missing without an item`: same template, no `item` → `missing` equals `['item', 'item.number', 'item.total']`.
  - `an item's own braces and closing tag stay literal` (Review Focus 1): item text `{{trigger.text}} </input>` → filled text contains `{{trigger.text}} <\/input>` inside the item block and `missing` is empty.
  - `modelPrompt with appendInputs false appends no unnamed input`: prompt `'Do {{item}}'`, one delivery `'a\nb'` → text has no `<input from="` block other than the item's.
  - `problemsOf checks a foreach step like an agent step`: foreach with `agent: ''` → `'Pick an agent'`; `agent: 'zumi-bot'` → `'Zumi Bot cannot be a workflow step'`; empty prompt → `'Write a prompt'`; prompt `'Check it'` → `'Use {{item}} in the prompt'`; prompt `'Check {{ item }}'` → no problem; prompt over `PROMPT_MAX` → `'Prompt is over 20 000 characters'`.

- [ ] **Step 2: Run them to see them fail**
  Run: `npx vitest run zumi-bot-server/shared/tests/workflowTemplate.test.ts zumi-bot-server/shared/tests/workflowGraph.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement.** In `fillTemplate`'s single replace pass, before the `missing` fallback: `item` → `wrap('item', ctx.item.text)`, `item.number` / `item.total` → `String(...)`, each only when `ctx.item` is set. `modelPrompt` returns `filled` without the extra blocks when `o.appendInputs === false`. In `problemsOf`, run the agent checks for `s.kind === 'agent' || s.kind === 'foreach'`, the prompt check for foreach too, and `USE_ITEM_TEXT` only when the trimmed prompt is non-empty and `/\{\{\s*item\s*\}\}/` does not match. `textFields` treats foreach as agent.

- [ ] **Step 4: Run the tests to see them pass.** Expected: PASS.

- [ ] **Step 5: Stage** the four files.

---

### Task 3: Save, validate and rename

**Files:**
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowInput.ts:26,60-95` (`KINDS`, `step()`)
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowStore.ts:166` (`renameAgent`)
- Test: `zumi-bot-server/backend/tests/rpc/handlers.test.ts`, `zumi-bot-server/backend/tests/core/workflowStore.test.ts`

**Interfaces:**
- Consumes: Task 1's foreach `Step`.

- [ ] **Step 1: Write the failing tests**
  - handlers: `workflows:save keeps a foreach step's agent, prompt, folder and model` (round-trip equal) and `workflows:save refuses a foreach step without a prompt string` → `Invalid workflow`.
  - store: `renameAgent moves foreach steps in workflows and run snapshots` (a foreach step with `agent: 'old'` reads `'new'` in `list()` and in a stored run's `snapshot`).

- [ ] **Step 2: Run them to see them fail**
  Run: `npx vitest run zumi-bot-server/backend/tests/rpc/handlers.test.ts zumi-bot-server/backend/tests/core/workflowStore.test.ts -t "foreach"`
  Expected: FAIL.

- [ ] **Step 3: Implement.** Add `'foreach'` to `KINDS` after `'agent'`; `step()`'s foreach case reads exactly the agent case's keys. `renameAgent` matches `s.kind === 'agent' || s.kind === 'foreach'`.

- [ ] **Step 4: Run the tests to see them pass.** Expected: PASS.

- [ ] **Step 5: Stage** the four files.

---

### Task 4: Generalise Agent steps from visits to slots (no behaviour change)

**Files:**
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowAgentSteps.ts`
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowRunner.ts` (host wiring at :150-163, `begin` :531, `resume` agent branch, new `agentTarget`/`chatTitle` helpers)
- Test: `zumi-bot-server/backend/tests/core/workflowRunner.test.ts` (unchanged; must stay green)

**Interfaces:**
- Produces (in `workflowAgentSteps.ts`):
  ```ts
  export type Slot = Pick<Visit, 'chatId' | 'messageId' | 'until'> & { status: ItemStatus }
  export type SlotEnd = { status: 'done'; output: string } | { status: 'failed'; error: string }
  export interface AgentTarget {
    slotId: string; agent: string; cwd: string; model?: ModelAlias
    title: string        // the new chat's title, made by the runner
    earlierChat?: string // reused when that chat still exists
    link: WorkflowLink
  }
  export interface AgentHost {
    serialize<T>(runId: string, op: () => Promise<T>): Promise<T>
    slotOf(r: WorkflowRun, slotId: string): Slot | null // the visit or item with that id, open or not
    patchSlot(runId: string, slotId: string, fn: (s: Slot) => Slot): Promise<boolean> // open slots of unfinished runs only
    finishSlot(runId: string, slotId: string, end: SlotEnd, cause?: Cause): Promise<boolean>
    addCost(runId: string, slotId: string, usd: number): Promise<void>
    arm(runId: string, slotId: string, at: number, fire: () => Promise<unknown>): void
    waits(runId: string): Map<string, number> | null // keyed by slot id
    stopped(): boolean
  }
  // WorkflowAgentSteps: start(r: WorkflowRun, t: AgentTarget, prompt: string): Promise<void>
  //                     recover(r: WorkflowRun, slotId: string, slot: Slot): Promise<void>
  ```
- Produces (in `workflowRunner.ts`, private): `chatTitle(runId: string, parts: string[]): string` — `parts.join(' · ')` plus ` · <date>` in the workflow's time zone, the format `chatFor` uses today.

- [ ] **Step 1: Refactor.** Inside `WorkflowAgentSteps` every `visitId` becomes `slotId`; `current()` reads `this.h.slotOf(r, slotId)` and keeps today's checks (run unfinished, slot running or waiting, same `chatId` and `messageId`). `chatFor(target)` reuses `target.earlierChat` when `chats.get` finds it, else creates the chat and writes `title`, `workflow: target.link` and `model`. `settle` calls `finishSlot(..., { status: 'done', output })` and archives when it returns true. The runner's host: `slotOf` finds a visit by id (later tasks add items); `patchSlot` writes the four `Slot` fields from `fn`'s result onto the visit, deleting any the result lacks (so `resume()`'s removal of `until` still works); `finishSlot` on a visit calls today's `finishVisit` with `port: 'out'` for done. `begin`'s agent case builds the target: `earlierChat` = the step's previous visit's `chatId` (today's rule), `title = chatTitle(runId, [name, step.name])`, `link = { workflowId, runId, stepId, name }`. `resume` calls `agentSteps.recover(r, v.id, v)`.

- [ ] **Step 2: Typecheck and run the runner tests**
  Run: `npm run typecheck && npx vitest run zumi-bot-server/backend/tests/core/workflowRunner.test.ts`
  Expected: no type errors; every existing test PASS.

- [ ] **Step 3: Stage** the two source files.

---

### Task 5: Run For each steps

**Files:**
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowRunner.ts` (`open`, `prepare`, `begin`, host `slotOf`/`patchSlot`/`finishSlot`/`addCost` for items, new `startItem`/`finishItem`, `halt`, `resume`, `retry`, `testStep`, `problems`)
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.workflows.retry`), `zumi-bot-server/backend/src/rpc/handlers.ts:965`, `zumi-bot-server/frontend/src/net/api.ts:177`
- Test: `zumi-bot-server/backend/tests/core/workflowRunner.test.ts`, `zumi-bot-server/backend/tests/rpc/handlers.test.ts`

**Interfaces:**
- Consumes: Task 1 (`parseItems`, `newItems`, `nextPending`, `itemCounts`, `joinItemOutputs`, `retryItems`, `itemsFailedText`, `FOREACH_ITEM_OUTPUT_MAX`), Task 2 (`modelPrompt(..., { appendInputs: false })`), Task 4 (`AgentTarget`, `Slot`, `SlotEnd`), `PAUSED_TEXT` from `workflowAgentSteps.ts`.
- Produces:
  ```ts
  retry(runId: string, visitId: string, itemId?: string): Promise<void>
  // ZumiBotApi: workflows.retry(runId: string, visitId: string, itemId?: string): Promise<void>
  export const NO_ITEMS = 'No items in the input'
  ```

Behaviour to implement (the spec's "Running the items", "How the step ends", "Retry", "Recovery"):
- `open()` for foreach: `parseItems(visit.input)`; an error fails the visit at once with that text and `halted: true` (as the cap does). Otherwise `items` = the retry's carried list when given, else `newItems`; the first pending item is set `running` with `startedAt`, and the `Begun` carries that item. `prepare()` fills the prompt once with a placeholder item only to record `missing`.
- `begin()` foreach: no items → finish the visit done with output `''` (as `passOn` does); else `startItem`.
- `startItem(r, visit, item, step)`: prompt = `modelPrompt(step.prompt, { ...ctx, item: { text, number: item.n, total } }, handles, { appendInputs: false }).text`; target: `slotId: item.id`, `earlierChat: item.chatId`, `title: chatTitle(runId, [name, step.name, item.text.slice(0, 60)])`, `link: { ..., item: { n, total } }`.
- `finishItem` (host `finishSlot` on an item id), in one `advance` write: end the item (output cut to `FOREACH_ITEM_OUTPUT_MAX`); a failure whose error is `PAUSED_TEXT` holds (no next item); else the next pending item is marked running. When none is started: all done → visit done, output `joinItemOutputs`, port `out`, deliver; else visit failed with `PAUSED_TEXT` when held, else `itemsFailedText(failed, total)`, `halted: true`. Failed items whose cause was not `'step'` go into `live.quiet` by item id; the visit is quiet when all its failed items are. After the write, start the marked item.
- `addCost` on an item adds to the item's and its visit's `costUsd`.
- `halt()`: an open foreach visit's open item joins `agentChats` and becomes `stopped`; pending items stay pending; the visit is `stopped`.
- `resume()`: an open item with a `messageId` → `agentSteps.recover(r, item.id, item)`; an open item without one is started again (Review Focus 4); no open item but a pending one → mark it running and start it.
- `retry(runId, visitId, itemId?)`: foreach opens the new visit with `retryItems(failed.items, newId, itemId)`; an `itemId` that is not a failed item of that visit throws `NOT_RETRYABLE`.
- `testStep` foreach: `parseItems(input)` error → `{ error }`; no items → `{ error: NO_ITEMS }`; else `agentSteps.test` with the first item's prompt.
- `problems()` checks the folder of foreach steps as of agent steps.

- [ ] **Step 1: Write the failing tests** (runner, using the existing `turns` / `playTurn` fakes; `FE = (id, prompt) => ({ ...base(id, id.toUpperCase()), kind: 'foreach', agent: 'helper', prompt, cwd: '/tmp' })`):
  - `for each runs its items in order, each in a fresh chat titled with the item, and joins the replies`: input `'a\nb\nc'`, prompt `'Do {{item}}'`; three sends to three different chat ids, in order a, b, c; each chat title starts `Flow · FE · a`; output `'## a\n\nok\n\n## b\n\nok\n\n## c\n\nok'`; each chat's `workflow.item` is `{n, total: 3}`.
  - `a failed item does not stop the rest; the visit fails "1 of 3 items failed" and the run halts`: second turn fails; third still sent; visit `failed`, `error: '1 of 3 items failed'`; a step after it never ran; `notify.failed` called once.
  - `retry of a failed for each visit runs only the failed items, in their own chats, and the output covers all`: after the above, `retry(runId, visitId)` sends once, into item b's old chat; run `done`; output has all three headings.
  - `retry of one item leaves the other failed items failed`: two failed items; `retry(runId, visitId, itemB)` → b runs, c stays failed and carried; visit fails `'1 of 3 items failed'`.
  - `pause in an item chat holds the step`: second turn ends `Paused by you` → no third send; visit failed `Paused by you`, third item `pending`; `notify.failed` not called; Retry runs b and c.
  - `stopRun during an item stops its chat and leaves later items pending`: held second turn; `stopRun` → `stoppedChats` has b's chat, item b `stopped`, c `pending`, visit `stopped`.
  - `an item card makes the item, the visit and the run waiting`: `chatPush({kind:'approvals', chatId, pending: 1})` during a held turn → item, visit, run `waiting`.
  - `an item usage limit waits for the reset and continues in the same chat`: turn ends with `failure('limit', resetsAt)` → item gets `until`, timer armed; firing it sends `continue` into the same chat.
  - `recover follows a running item, and starts the next pending item when none is open`.
  - `an item marked running but never sent is started again after a restart` (Review Focus 4).
  - `item costs count on the item and the visit`: `chatCost(chatId, 0.5)` during item a → item a and visit `costUsd` 0.5.
  - `a bad list fails the visit before any item; an empty list hands on an empty output`: 101 lines → `'The list has 101 items; the most is 100'`, no sends; `''` input → visit done, output `''`, next step ran.
  - `done item chats are archived, a failed item chat stays`.
  - `a deleted item chat fails that item and the next item starts` (Review Focus 2, via `chatRemoved`).
  - `stopAllOf mid-loop stops the item chat and starts no later item` (Review Focus 3).
  - `a step agent deleted mid-loop fails the later items without chats` (Review Focus 5): `agentList = []` after item a → b and c fail `Agent "helper" not found`, no new chats; visit `'2 of 3 items failed'`.
  - `testStep foreach runs the first item only`: input `'x\ny'` → one chat, its message holds `x` and not `y`; input `''` → `{ error: 'No items in the input' }`.
  - `the run summary carries progress while a for each visit is open`.
  
  Handlers: `workflows:retry passes an optional item id` (spy on `workflowRunner.retry` receives `(runId, visitId, itemId)`; a non-id `itemId` is refused).

- [ ] **Step 2: Run them to see them fail**
  Run: `npx vitest run zumi-bot-server/backend/tests/core/workflowRunner.test.ts zumi-bot-server/backend/tests/rpc/handlers.test.ts -t "for each|foreach|item"`
  Expected: FAIL.

- [ ] **Step 3: Implement** the behaviour above. Every write goes through `advance` inside the run's queue; `slotOf` / `patchSlot` / `finishSlot` / `addCost` find an item by id across the run's visits (`findSlot(r, id): { visit: Visit; item?: ItemRun } | null`). The handler validates `itemId` with `wid` only when present.

- [ ] **Step 4: Run the tests to see them pass**, then the whole backend project.
  Run: `npx vitest run --project backend && npm run typecheck`
  Expected: PASS, no type errors.

- [ ] **Step 5: Stage** the six files.

---

### Task 6: Frontend state

**Files:**
- Modify: `zumi-bot-server/frontend/src/state/workflowCanvas.ts` (`STEP_LABELS`, default config, subtitle)
- Modify: `zumi-bot-server/frontend/src/state/workflowEditor.ts` (`templateFields`)
- Modify: `zumi-bot-server/frontend/src/state/workflowRun.ts` (`summaryKey`, `chatBarText`, new helpers)
- Test: `zumi-bot-server/frontend/tests/workflowCanvas.test.ts`, `workflowEditor.test.ts`, `workflowRun.test.ts`

**Interfaces:**
- Consumes: Task 1 (`RunProgress`, `ItemRun`, `itemCounts`), `canRetry` (existing).
- Produces:
  ```ts
  export function progressText(p: RunProgress): string
  export function itemsCountText(items: ItemRun[]): string
  export function canRetryItem(run: Pick<WorkflowRun, 'visits' | 'status'>, visit: Visit, item: ItemRun): boolean
  ```

- [ ] **Step 1: Write the failing tests**
  - `STEP_LABELS lists For each right after Agent` (`Object.keys` order `agent, foreach, llm, …`); a new foreach step's config is `{ agent: '', prompt: '', cwd: '' }`; its subtitle is `'helper · for each line'` (or `'No agent · for each line'`).
  - `templateFields offers item fields in a foreach prompt only`: foreach → starts `['input', 'item', 'item.number', 'item.total', …]`; agent step → no `item`.
  - `progressText`: `{done: 2, failed: 0, total: 36, current: 'Gallery View'}` → `'3 / 36 · Gallery View'`; `current: null` → `'2 / 36'`.
  - `itemsCountText`: 31 done, 2 failed, 3 pending → `'31 done · 2 failed · 3 to go'`; zero parts other than done are left out.
  - `canRetryItem` only for a failed item (carried or not) of a visit `canRetry` allows.
  - `summaryKey changes when progress moves`.
  - `chatBarText with an item`: link `item: {n: 3, total: 36}`, step `Scan`, workflow `W5 audit` → lead `'Item 3 of 36 · Step "Scan" of workflow W5 audit'`.

- [ ] **Step 2: Run them to see them fail**
  Run: `npx vitest run zumi-bot-server/frontend/tests/workflowCanvas.test.ts zumi-bot-server/frontend/tests/workflowEditor.test.ts zumi-bot-server/frontend/tests/workflowRun.test.ts`
  Expected: FAIL.

- [ ] **Step 3: Implement** the helpers and the three changes. `summaryKey` adds `s.progress ?? null` to its array.

- [ ] **Step 4: Run the tests to see them pass.** Expected: PASS.

- [ ] **Step 5: Stage** the six files.

---

### Task 7: Frontend components

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/WorkflowIcons.tsx`, `WorkflowCanvas.tsx`, `StepInspector.tsx`, `StepTest.tsx`, `VisitPanel.tsx`, `WorkflowRunView.tsx`, `WorkflowsSidebar.tsx`, `WorkflowChatBar.tsx` (no change if `chatBarText` covers it), `zumi-bot-server/frontend/src/styles.css`

**Interfaces:**
- Consumes: Task 1 (`progressOf`), Task 5 (`api.workflows.retry(runId, visitId, itemId)`), Task 6 helpers.
- Produces these test ids (Task 8 relies on them): `wf-foreach-hint`, `wf-test-first`, `wf-node-progress`, `wf-run-progress`, `workflow-run-progress`, `wf-items`, `wf-items-count`, `wf-item` (with `data-status` and `data-item-n`), `wf-item-open-chat`, `wf-item-retry`, `wf-item-output`, `wf-item-error`, `wf-item-cost`, `wf-item-until`, `wf-timeline-progress`.

- [ ] **Step 1: Implement.**
  - Icon for `foreach` (a looped arrow), in the add menu via `ADD_KINDS`.
  - `StepInspector`: foreach shares the agent case's fields (pull them into one function), the folder default applies to foreach too, `wf-foreach-hint` shows the spec's hint, and `StepTest` is offered with `wf-test-first` reading `Runs the first item only.`.
  - Run view: the foreach node shows `wf-node-progress` (`3 / 36` and the current item) from `progressOf(run)`; the header shows `wf-run-progress` (`progressText` of the first entry) beside the status while the run is unfinished; the phone timeline row of a foreach visit shows `wf-timeline-progress` and opens the item list.
  - `VisitPanel` for a visit with `items`: `wf-items-count` (`itemsCountText`), then `wf-items` listing each `wf-item`: number, text, status dot, `wf-item-until` for a limit wait, `wf-item-cost`, `wf-item-open-chat`, `wf-item-output` (`VisitText`, with Expand), `wf-item-error`, and `wf-item-retry` when `canRetryItem`. The running item scrolls into view when it changes.
  - `WorkflowsSidebar` run rows show `workflow-run-progress` from `run.progress?.[0]` while the run is unfinished.

- [ ] **Step 2: Typecheck and build**
  Run: `npm run typecheck && npm run build:server`
  Expected: no errors.

- [ ] **Step 3: Stage** the changed files.

---

### Task 8: End to end, fixture and docs

**Files:**
- Modify: `zumi-bot-server/backend/tests/fixtures/fake-workflow-claude.mjs` (the `--agent` branch)
- Modify: `zumi-bot-server/e2e/workflows.e2e.mjs` (new case)
- Modify: `CLAUDE.md` (Workflows paragraph and the `e2e:workflows` line)

**Interfaces:**
- Consumes: Task 7's test ids.
- Produces: fake env `FAKE_AGENT_HOLD_FILE` (while the file exists, an agent turn whose first stdin line holds `#HOLD` waits) and `FAKE_AGENT_FAIL_FILE` (while it exists, a turn whose first stdin line holds `#FAIL` prints an error result and exits 1).

- [ ] **Step 1: Fixture.** In the `--agent` branch, when either env var is set: read stdin's first line, apply the hold (poll every 100 ms) and the fail rule, then spawn `fake-claude.mjs` as a child with the same argv and env, write that line to its stdin and pipe the rest both ways. Unset, keep today's `await import('./fake-claude.mjs')`.

- [ ] **Step 2: Write the e2e case** `a For each step runs one fresh chat per line, shows its progress, keeps going past a failed item and retries only it`:
  - Save `For each flow`: trigger → foreach `each` (agent `AGENT`, prompt `Check {{item}}`, folder). Create the hold and fail files. Run with input `'alpha\n#HOLD beta\n#FAIL gamma'`.
  - While beta holds: `wf-run-progress` and the sidebar's `workflow-run-progress` read `2 / 3 · #HOLD beta`; `wf-node-progress` reads `2 / 3`.
  - Remove the hold file. The run ends `failed`; `wf-items-count` reads `2 done · 1 failed`; gamma's `wf-item` has `data-status="failed"`; alpha's and beta's chats are archived, gamma's is not.
  - Remove the fail file, click gamma's `wf-item-retry`. The run ends `done`; gamma ran again in the same chat id; the output holds `## alpha`, `## #HOLD beta` and `## #FAIL gamma`.
  - Phone width: the run's foreach row shows the item list with three `wf-item`s.

- [ ] **Step 3: Run it**
  Run: `npm run e2e:workflows`
  Expected: every case PASS, the new one included.

- [ ] **Step 4: Docs.** In `CLAUDE.md`'s Workflows paragraph add the For each step in the steps list and one short block: one agent per input line, one at a time, fresh chat each (`ChatMeta.workflow.item`), keep going past failures, Retry of failed items only (`workflows:retry`'s `itemId`), progress in `WorkflowRunSummary.progress`, the five caps, and the spec path. In the `e2e:workflows` description add the For each case and the two fake env vars.

- [ ] **Step 5: Full check**
  Run: `npm test && npm run typecheck`
  Expected: PASS.

- [ ] **Step 6: Stage** the three files.
