# Workflow Run Audit Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An Audit log tab on the workflow run page that, for a finished run, lists the trigger and every step visit in start order with its input and output, and only a note while the run is going.

**Architecture:** Frontend only. A pure module (`state/auditLog.ts`) turns a `WorkflowRun` from `workflows:getRun` into the log's entries; a component (`AuditLog.tsx`) draws them; the run view gets a Canvas | Audit log switch driven by a new `/audit` address.

**Tech Stack:** React 19, TypeScript, vitest (node env, pure modules only), playwright-core e2e against the fake workflow claude.

**Spec:** `docs/superpowers/specs/2026-11-08-workflow-audit-log-design.md`

## Global Constraints

- Build on the For each commit of `claude/workflow-for-each` (the loop work), never on master: this branch fast-forwards to that commit in Task 1, Step 1.
- No commits unless the user asks (the user's global rule). Steps below end with checks, not commits.
- No server, RPC or stored-data change.
- Agent, model and webhook text is drawn only through the existing `Markdown` component or as plain text.
- Fold: more than `FOLD_LINES = 6` lines or `FOLD_CHARS = 600` characters.
- Copy, verbatim: "The audit log shows once this run ends." · "No input." · "Empty." · "Show all" · "Show less" · "edited" · "from an earlier visit" · end line "Run done" / "Run failed" / "Run stopped" / "Run skipped".
- Comments are short and say why (repo convention). Dependencies unchanged.

## Review Focus

1. A run of up to 200 visits with 50 000-character outputs: only folded previews render until Show all (Task 2 test: a 50 000-character single line folds to ≤ 600 characters).
2. The run ends while the Audit log tab is open: the log replaces the note with no reload (Task 4 e2e, case 2 → 3).
3. Back after switching tabs returns to Canvas, and reload keeps `/audit` (Task 4 e2e).
4. `/audit` for an unknown run shows "This run is not available." like the canvas address (Task 4 e2e).
5. A visit with no `endedAt` in an ended run (stopped mid-turn): its end time falls back to the run's `endedAt`, never "now" (Task 2 test).

---

### Task 1: Branch from the loop and add the `/audit` address

**Files:**
- Modify: `zumi-bot-server/frontend/src/state/route.ts` (`workflowsFromPath`, `workflowsPath`)
- Modify: `zumi-bot-server/frontend/src/components/WorkflowsMode.tsx` (`WorkflowsRoute`, `ModeProps.onOpen`, the `WorkflowRunView` props)
- Modify: `zumi-bot-server/frontend/src/App.tsx` (`openWorkflowGuarded`, the `mode === 'workflows'` path in `wantPath`)
- Test: `zumi-bot-server/frontend/tests/workflowsRoute.test.ts`

**Interfaces:**
- Produces: `workflowsFromPath(pathname): { workflowId: string | null; runId: string | null; audit?: true } | null`; `workflowsPath(workflowId, runId = null, audit = false): string`; `WorkflowsRoute.audit?: boolean`; `ModeProps.onOpen(workflowId, runId?, audit?: boolean)`; `WorkflowRunView` props `audit: boolean` and `onTab: (audit: boolean) => void`.

- [ ] **Step 1: Branch from the loop's commit**

Once the For each session reports its commit hash: in this worktree (no commits of its own; the spec and plan are untracked and stay), `git merge --ff-only <hash>` (both start from master `170c2a0`; if it is not a fast-forward, stop and ask the user). Then check the shape the log reads: `grep -n "interface ItemRun" -A8 zumi-bot-server/shared/src/workflows.ts` must show `id, n, text, status, chatId?, output?, error?, costUsd?, carried?, startedAt?, endedAt?`, and `STEP_LABELS` in `frontend/src/state/workflowCanvas.ts` must have `foreach`. Note the loop's item helpers (`itemsCountText`, an item status label, the `wf-items` list in `VisitPanel.tsx`) for Task 3. If any field moved, update the spec's For each section and Task 2's `items` field first.

- [ ] **Step 2: Write the failing tests** in `workflowsRoute.test.ts`

```ts
expect(workflowsFromPath('/workflows/w1/runs/r9/audit')).toEqual({ workflowId: 'w1', runId: 'r9', audit: true })
expect(workflowsFromPath('/workflows/w1/runs/r9')).toEqual({ workflowId: 'w1', runId: 'r9' }) // no audit key
expect(workflowsPath('w1', 'r9', true)).toBe('/workflows/w1/runs/r9/audit')
expect(workflowsPath('w1', null, true)).toBe('/workflows/w1') // no run, no tab
// round trip: [['a b', 'c/d', true], ['w', 'r', false]] through workflowsPath → workflowsFromPath
```

Add to the "routes nothing else" list: `/workflows/w1/runs/r9/audit/`, `/workflows/w1/runs/r9/canvas`, `/workflows/w1/audit`, `/workflows/w1/runs//audit`.

- [ ] **Step 3: Run it to see it fail**

Run: `npx vitest run zumi-bot-server/frontend/tests/workflowsRoute.test.ts`
Expected: FAIL on the `/audit` cases.

- [ ] **Step 4: Implement**

`workflowsFromPath` accepts 4 parts when `parts[1] === 'runs'` and `parts[3] === 'audit'`, returning `audit: true` only then. `workflowsPath` appends `/audit` only with a run. `WorkflowsRoute` gains `audit?: boolean`. `openWorkflowGuarded(workflowId, runId = null, audit = false)`: its no-op check also compares `(workflowsRoute.audit === true) === audit`, and it sets `{workflowId, runId, ...(audit ? { audit: true } : {})}`. `wantPath` passes `workflowsRoute.audit === true`. `WorkflowsMode` passes `audit={route.audit === true}` and `onTab={(a) => p.onOpen(id, runId, a)}` to `WorkflowRunView`, which takes both props (unused until Task 3; prefix the destructured names with `_` if lint objects). Every other `setWorkflowsRoute` call stays as is (they land on Canvas, per the spec).

- [ ] **Step 5: Check**

Run: `npx vitest run zumi-bot-server/frontend/tests/workflowsRoute.test.ts && npm run typecheck`
Expected: PASS, no type errors.

---

### Task 2: The log model (`state/auditLog.ts`)

**Files:**
- Create: `zumi-bot-server/frontend/src/state/auditLog.ts`
- Test: `zumi-bot-server/frontend/tests/auditLog.test.ts`

**Interfaces:**
- Consumes: `timeline`, `approvalQuestion` (`state/workflowRun.ts`); `STEP_LABELS` (`state/workflowCanvas.ts`); `triggerOutput` (`@zumibot/shared/workflowTemplate`); `ItemRun`, `Step`, `StepKind`, `Visit`, `WorkflowRun`, `WorkflowRunStatus` (`@zumibot/shared/workflows`).
- Produces:

```ts
export const FOLD_LINES = 6
export const FOLD_CHARS = 600
export interface AuditTrigger {
  via: WorkflowRun['via']; late: boolean; at: number
  callLine: string | null // webhook only: 'POST' or 'POST ?a=1&b=2' (query keys in stored order)
  text: string | null     // manual: run input ('' when none); webhook: body JSON (triggerOutput); schedule: null
}
export interface AuditEntry {
  n: number                  // 2, 3, … (the trigger is 1)
  visit: Visit
  step: Step | undefined
  name: string               // step name trimmed, else STEP_LABELS[kind], else 'A step'
  kind: Exclude<StepKind, 'trigger'> | null
  visitLabel: string | null  // 'Visit 2' only when that step has more than one visit in the run
  answer: string | null      // port in words: 'Yes' | 'No' | 'Approved' | 'Rejected'
  question: string | null    // Approval: approvalQuestion(visit, step); else null
  showOutput: boolean        // false for condition, wait, notify
  edited: boolean            // approval: port approved and output less "\n\nNote from the user: <note>" !== input
  endedAt: number | null     // visit.endedAt, else the run's endedAt
  items: ItemRun[] | null    // foreach: visit.items sorted by n; else null
}
export interface AuditEnd { status: WorkflowRunStatus; at: number | null; error: string | null }
export interface AuditLogModel { trigger: AuditTrigger; entries: AuditEntry[]; end: AuditEnd }
export function auditLog(run: WorkflowRun): AuditLogModel | null // null while running or waiting
export function foldText(text: string): { preview: string; more: boolean }
export function clockTime(ms: number, timeZone: string): string // '14:02:11', en-GB, h23
```

- [ ] **Step 1: Write the failing tests** (`auditLog.test.ts`, fixtures in the style of `workflowRun.test.ts`: `steps` with trigger `t`, condition `c`, llm `l`, approval `a`, wait `w`, notify `n`, foreach `f`; `visit(stepId, n, status, startedAt, extra)`; `run(visits, status, extra)`)

```ts
it('gives no log while the run is going', () => {
  expect(auditLog(run([visit('t', 1, 'done', 0)], 'running'))).toBeNull()
  expect(auditLog(run([visit('t', 1, 'done', 0)], 'waiting'))).toBeNull()
})
it('lists visits by start time, ties in arrival order, numbered from 2, without the trigger visit', () => {
  const m = auditLog(run([visit('t', 1, 'done', 0), visit('l', 1, 'done', 5), visit('c', 1, 'done', 3), visit('w', 1, 'done', 3)], 'done'))!
  expect(m.entries.map((e) => [e.n, e.visit.stepId])).toEqual([[2, 'c'], [3, 'w'], [4, 'l']])
})
it('labels visits only for a step that ran more than once', () => {
  // l twice, c once → l entries 'Visit 1', 'Visit 2'; c null
})
it('builds the trigger for manual, schedule, webhook and a skipped run with no visits', () => {
  // manual input 'YES' → { via: 'manual', text: 'YES', callLine: null }; manual no input → text ''
  // schedule → text null; late flag carried
  // webhook call { method: 'POST', query: { a: '1', b: '2' }, body: { action: 'opened' } } → callLine 'POST ?a=1&b=2', text JSON.stringify(body, null, 2)
  // skipped, visits [] → trigger.at === run.startedAt, entries [], end { status: 'skipped', error: 'Filter did not match' }
})
it('hides Output for condition, wait and notify only', () => { /* showOutput per kind */ })
it('marks an approval edited only when the approved text changed', () => {
  // approved, input 'x', output 'y\n\nNote from the user: hi', note 'hi' → true
  // approved, input 'x', output 'x\n\nNote from the user: hi', note 'hi' → false
  // rejected, input 'x', output 'x' → false; answer 'Rejected'
})
it('names a blank step by its kind and a missing step as A step', () => {})
it('falls back to the run end for a visit that never ended', () => {
  // run stopped, endedAt 90; visit l stopped without endedAt → entry.endedAt 90
})
it('lists For each items in list order, carried ones kept', () => {
  // items given n 3, 1, 2 (2 carried) → items.map(i => i.n) = [1, 2, 3], items[1].carried === true; other kinds items null
})
it('folds long text', () => {
  expect(foldText('a\nb')).toEqual({ preview: 'a\nb', more: false })
  expect(foldText('1\n2\n3\n4\n5\n6\n7').preview).toBe('1\n2\n3\n4\n5\n6')
  const long = 'x'.repeat(50_000)
  expect(foldText(long).preview.length).toBeLessThanOrEqual(FOLD_CHARS)
  expect(foldText(long).more).toBe(true)
  // a break at 450 within the first 600 → preview ends there; a break at 100 only → cut at 600
})
it('formats clock times in the workflow time zone', () => {
  expect(clockTime(Date.UTC(2026, 10, 8, 12, 2, 11), 'Asia/Dubai')).toBe('16:02:11')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run zumi-bot-server/frontend/tests/auditLog.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `auditLog.ts`**

`foldText`: take the first `FOLD_LINES` lines; if that is over `FOLD_CHARS`, cut at the last `\n` inside the first `FOLD_CHARS` characters when it sits at or past `FOLD_CHARS / 2`, else at `FOLD_CHARS`; `more` when the preview is shorter than the text (after trimming trailing white space from the preview). The trigger's time is the trigger visit's `startedAt` when there is one, else `run.startedAt`; its webhook `text` is the trigger visit's `output` when present, else `triggerOutput(run.call ?? null, run.input ?? null)`.

- [ ] **Step 4: Check**

Run: `npx vitest run zumi-bot-server/frontend/tests/auditLog.test.ts && npm run typecheck`
Expected: PASS.

---

### Task 3: The Audit log view

**Files:**
- Create: `zumi-bot-server/frontend/src/components/AuditLog.tsx`
- Modify: `zumi-bot-server/frontend/src/components/WorkflowRunView.tsx` (header switch, desktop body, phone branch)
- Modify: `zumi-bot-server/frontend/src/styles.css` (new `.wf-audit…` rules beside the other `.wf-run-*` rules)

**Interfaces:**
- Consumes: Task 1's `audit`/`onTab` props; Task 2's `auditLog`, `foldText`, `clockTime`; `durationText`, `costText`, `runCostText` (`state/workflowRun.ts`); `runStatusLabel`; `StepIcon`, `TriggerKindIcon`; `ExpandButton`, `ExpandDialog`; `Markdown`; the loop's item status label and count helpers (named in Task 1 Step 1).
- Produces: `export function AuditLog({ run, timeZone, onOpenChat }: { run: WorkflowRun; timeZone: string; onOpenChat: (chatId: string) => void })` and `AuditText({ label, text, testId, title })`.

- [ ] **Step 1: Build `AuditText`**

A box with its label row (label, the existing `ExpandButton`), then `Markdown` of `foldText(text).preview` under a fade while folded, or of the whole text once **Show all** (`wf-audit-more`) is pressed; **Show less** folds it back. `''` reads "Empty.". The dialog title is passed in (`Output · Review PR · Visit 2`).

- [ ] **Step 2: Build `AuditLog`**

`auditLog(run) === null` → `<div data-testid="wf-audit" data-state="pending">` with `wf-audit-pending` "The audit log shows once this run ends." Otherwise `data-state="ready"`, an `<ol>` timeline as the spec's layout A: the trigger (`wf-audit-trigger`; "No input." for `''`; no box for `null`), one `wf-audit-entry` per entry (`data-step-id`, `data-kind`, `data-status`) with the head and boxes the spec lists per kind (`wf-audit-input`, `wf-audit-output`, `wf-audit-reason`, `wf-audit-note`, `wf-audit-sent`, `wf-audit-error`, missing fields, Asked, the **edited** tag, **Open chat →**, and for For each one `wf-audit-item` row per item with **from an earlier visit** on carried ones), then `wf-audit-end` (`data-status`) with "Run done" etc., `clockTime(end.at)`, `durationText(run.startedAt, end.at)`, `runCostText(run)` and the run error. Input and Output sit in a two-column grid that drops to one column under about 720 px of log width.

- [ ] **Step 3: Wire it into `WorkflowRunView`**

Header: `wf-run-tabs` (`role="tablist"`) after the status tag with `wf-tab-canvas` and `wf-tab-audit` (`role="tab"`, `aria-selected`), calling `onTab(false|true)`. Desktop: `audit` swaps `wf-body` (canvas plus inspector) for `<AuditLog>` in a scrolling column, at most about 1 100 px wide and centred. Phone: no switch; when `auditLog(run) !== null` the body shows `<AuditLog>` instead of `wf-timeline`, else today's list with the approval on top.

- [ ] **Step 4: Check**

Run: `npm run typecheck && npm test`
Expected: no type errors, every project PASS.

Then look at it: `npm run build:server`, start the built server with the fake workflow claude as `e2e:workflows` does (or the `run` skill), finish a run, open both tabs at desktop width and at 375 px, light and dark.

---

### Task 4: E2E and docs

**Files:**
- Modify: `zumi-bot-server/e2e/workflows.e2e.mjs` (cases 2, 3, 10; the DOM hooks comment)
- Modify: `CLAUDE.md` (the Workflows **UI.** paragraph and the `e2e:workflows` line under Commands)

- [ ] **Step 1: Add the checks**

- Case 2, run waiting: click `wf-tab-audit`; the URL ends `/audit`; `wf-audit[data-state="pending"]` holds "The audit log shows once this run ends."
- Case 3: before approving, click `wf-tab-canvas` so the approval box shows; after the run is done, click `wf-tab-audit` and check: `wf-audit-trigger` first holding `YES`; `wf-audit-entry` `data-step-id`s equal `done.visits` minus the trigger, sorted by `startedAt` (`check`, `yes-sum`, `approve`, `tell`); the `check` entry has `wf-audit-reason` and no `wf-audit-output`; the `approve` entry's output holds `EDITED` with the edited tag and its note holds `NOTE`; the `tell` entry has `wf-audit-sent` with "Triage done"; `wf-audit-end[data-status="done"]` shows `$0.01`. Reload: still the log. `page.goBack()`: canvas (`wf-canvas`). Open `runUrl(triage.id, 'nope') + '/audit'`: `workflow-run-unavailable`.
- Case 10, phone, after the phone approval: `wf-audit[data-state="ready"]` shows and `wf-timeline` is gone.
- If the loop's commit added a For each case, after its run ends: `wf-audit-item` count in its entry equals the visit's `items.length`.

- [ ] **Step 2: Run it**

Run: `npm run e2e:workflows`
Expected: every case PASS.

- [ ] **Step 3: Docs**

In `CLAUDE.md`'s Workflows **UI.** paragraph, after the `WorkflowRunView.tsx` sentence: the Canvas | Audit log switch, the `/workflows/<id>/runs/<runId>/audit` address, the pending note while running or waiting, the log's order and per-kind boxes (`state/auditLog.ts`, `AuditLog.tsx`), the fold, and the phone showing the log for a finished run; add `/audit` to the addresses list; add the audit checks to the `e2e:workflows` description. Add the new test ids to the e2e file's DOM hooks comment.

- [ ] **Step 4: Final check**

Run: `npm run typecheck && npm test && npm run e2e:workflows`
Expected: all PASS.
