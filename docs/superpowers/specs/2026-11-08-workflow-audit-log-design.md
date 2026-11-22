# Workflow run: Audit log

A second view of a workflow run, beside the canvas, that reads the whole finished run top to bottom: the trigger, then
every step in the order it ran, each with what went in and what came out.

## Why

To see what a run did today, the user clicks each node on the run's canvas, one at a time, and reads that step's visits
in the inspector. The user's words: "I wanted to see how each step ran, and what was the input and the output without
clicking on each node to check … I need it for a better visibility and readability."

Everything the log needs is already stored on the run (`WorkflowRun.visits`, `snapshot`, `call`, `input`) and already
reaches the page through `workflows:getRun`. This is a frontend change only.

## Goals

- An **Audit log** tab on the run page, next to **Canvas**, with its own address.
- A finished run's log lists, in order: the trigger, every visit of every step (a step that ran several times, by a loop
  or a Retry, shows each visit), and how the run ended.
- Each entry shows its input and output side by side, without any click to open it. Long text is folded to a preview
  with **Show all**.
- A run still in progress shows no log, only a note that it appears when the run ends (the user's decision).
- Works for the new **For each** step (branch `claude/workflow-for-each`): its entry lists every item with its outcome.

## Non-goals

- Exporting or downloading the log, searching it, or a log across several runs.
- Any server, RPC or stored-data change.
- A live log while the run is going.
- Changing the Canvas view or the step inspector.

## Anti-goals (failure even if it works)

- A log whose order disagrees with what happened (a visit shown before one that started earlier).
- A visit, or a For each item, that is missing from a finished run's log.
- A log that needs a click per step to read inputs and outputs, which is the problem this solves.
- Agent, model or webhook text drawn as anything but Markdown or plain text (it is untrusted, as everywhere in the run
  view).

## The page

### Address and tabs

- `/workflows/<id>/runs/<runId>` stays the Canvas view; `/workflows/<id>/runs/<runId>/audit` is the Audit log.
  `workflowsFromPath` reads the new shape as `{workflowId, runId, audit: true}` (the key is absent for the canvas, so
  existing routes compare equal), and `workflowsPath(workflowId, runId, audit)` writes it. `WorkflowsRoute` gains
  `audit?: boolean`. Reload, Back and Forward keep the tab.
- The run header gets a two-button tab switch, **Canvas | Audit log**, after the title and status. A click is an
  address change through the existing guarded `onOpen`, so history gets an entry as for any move.
- Opening a run from the sidebar, the editor's run list, a chat's workflow bar, the Inbox or a notification lands on
  Canvas, as today. (My call: the log is one click away and has its own address.)

### In progress

While the run is `running` or `waiting`, the Audit log tab shows one line: **The audit log shows once this run ends.**
The run view already refetches when the run's summary changes, so the log appears in place when the run ends, with no
reload.

### Finished

`done`, `failed`, `stopped` and `skipped` runs show the full log: a single column, at most about 1 100 px wide, centred,
scrolling inside the main area. Entries hang off a vertical line with a numbered dot each, coloured by status (layout A
of the mockups the user picked).

1. **Trigger**, numbered 1. Head: how it started (**Manual**, **Schedule** or **Webhook**, plus a `late` tag), and the
   start time. Body, one box:
   - Manual: the run's input text (`run.input`), or "No input." when empty.
   - Webhook: the method and the query fields on one line, then the body as JSON (`run.call`).
   - Schedule: no box (a schedule run has no input).
   The trigger visit (status `done`, made at run start) supplies the time; a skipped run whose filter did not match has
   no visits, so the trigger entry is built from the run itself.
2. **One entry per visit of a non-trigger step**, in start order (the existing `timeline()` order: by `startedAt`, ties
   in arrival order). Numbered on from 2. A Retry opens a new visit of the step, so the failed visit and its retry are
   two entries. Clock times are in the workflow's time zone, as the run title's are.
   - **Head:** the step's icon and name (the kind's name when blank), a kind tag, "Visit n" when that step ran more
     than once in the run, the visit status (`runStatusLabel`), the answer port in words (Yes / No / Approved /
     Rejected), the clock times `14:02:12 → 14:06:40`, the duration (`durationText`) and the cost (`costText`, hidden
     when none). Agent visits get **Open chat →** (the existing `onOpenChat`).
   - **Body:** Input and Output side by side when there is room (two columns from about 720 px of log width), stacked
     below that. Then the kind's extras:
     - **Agent, LLM:** Input, Output.
     - **Condition:** Input, then **Reason**. No Output box: a Condition passes its input on unchanged, and showing it
       twice is noise.
     - **Approval:** **Asked** (the question, `approvalQuestion`), Input (the text offered), Output (the text passed
       on), then **Your note**. The server appends `\n\nNote from the user: <note>` to the output, so the **edited** tag
       on Output shows when the port is `approved` and the output, less that suffix, differs from the input.
     - **Wait:** Input, and "Waited 5 min" in the head (the duration). No Output box (it passes its input on).
     - **Notify:** **Sent**: the title (bold) and body as filled (`Visit.title`/`body`), then Input. No Output box (it
       passes its input on).
     - **For each:** Input (the list), then **Items (n)**: one row per item, in list order, with its number, text,
       status, duration, cost and **Open chat →**, its output folded under it, its error in red; an item that ended
       in an earlier visit is marked **from an earlier visit** (`carried`). Then the step's joined Output, folded.
       Item status words, counts and any item-list helpers come from the For each work; the log reuses them rather
       than adding its own.
     - **Any step:** the error in red (`Visit.error`), and "Missing fields: …" (`Visit.missing`).
3. **End line**: "Run done", "Run failed", "Run stopped" or "Run skipped", the end time, the run's total duration and
   total cost (`runCostText`), and the run's error (`run.error`, for example "Filter did not match") in red.

### Text blocks

- Every input, output, reason, note and question is drawn through the existing `Markdown` component, never raw HTML.
- A text longer than the fold (more than 6 lines or about 600 characters) shows a preview: its first part, cut at a
  line break when one is near, under a fade, with **Show all** (and **Show less** once open). Only the preview is
  rendered until Show all, so a run of 200 visits with 50 000-character outputs stays light.
- Each box keeps the existing **Expand** button, opening the read-only `ExpandDialog`, titled with the step, the visit
  and the box (`Output · Review PR · Visit 2`).
- An empty text reads "Empty.", as in the visit panel.

### Phone

The phone has no canvas and no tabs. A finished run shows the audit log (stacked boxes) in place of today's visit list;
a run in progress keeps today's list with the approval on top. (My call.) The `/audit` address on a phone shows the
same as the plain one.

## How it is built

- `frontend/src/state/auditLog.ts` (pure, unit tested): `auditLog(run)` returns `null` for an unfinished run, else
  `{trigger, entries, end}`, where each entry carries the visit, its step, its number, its visit label, its port word,
  its edited flag and which boxes it shows. Also the fold rule (`foldText`: preview text and whether there is more) and
  the trigger's text (method and query line, body JSON).
- `frontend/src/components/AuditLog.tsx`: draws the log from `auditLog(run)`; `AuditText` for a folded box with Expand.
  New CSS under `.wf-audit` in `styles.css`.
- `WorkflowRunView.tsx`: the tab switch in the header and the Audit log body; the phone branch switches to the log for a
  finished run. `WorkflowsMode.tsx` and `App.tsx` pass `audit` through the route.
- Test ids: `wf-run-tabs`, `wf-tab-canvas`, `wf-tab-audit` (with `aria-selected`), `wf-audit` (with
  `data-state="pending"|"ready"`), `wf-audit-pending`, `wf-audit-trigger`, `wf-audit-entry` (with `data-step-id`,
  `data-kind`, `data-status`), `wf-audit-input`, `wf-audit-output`, `wf-audit-reason`, `wf-audit-note`,
  `wf-audit-sent`, `wf-audit-error`, `wf-audit-item`, `wf-audit-end` (with `data-status`), `wf-audit-more`.

## Tests

- Unit (`frontend/tests/auditLog.test.ts`, `workflowsRoute.test.ts`): unfinished runs give no log; order follows start
  time with ties in arrival order; trigger built for manual, schedule, webhook and a skipped run with no visits; visit
  labels only for steps that ran more than once; Condition and Wait without Output; Approval's edited flag; For each
  items in list order with carried ones marked; the fold rule; the `/audit` route round trip and its bad shapes.
- E2E (`e2e:workflows`): on a finished run, the Audit log tab shows the trigger first, every visit in start order with
  its input and output, and the end line; a run waiting on an approval shows only the pending note, and its log appears
  after approving; reload keeps `/audit`; the phone view of a finished run shows the log.

## Calls I made (not the user's)

- Canvas stays the default tab; the log has its own `/audit` address.
- Condition, Wait and Notify show no Output box; For each shows both its items and its joined Output.
- The For each section follows the loop's spec and staged types; it is checked against the loop's commit before it is
  built, and this section changes if that shape moved.
- The fold is 6 lines or about 600 characters, and only the preview renders until Show all.
- On a phone, a finished run shows the log instead of the visit list.
