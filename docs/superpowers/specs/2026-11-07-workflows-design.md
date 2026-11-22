# Workflows

A workflow is a fixed chain of steps you draw on a canvas: a trigger, then agent runs, cheap model calls, yes/no
branches, approvals, waits and notifications, with each step's text passed to the next. It sits beside Routines.

## Why

A routine is one trigger, one prompt and one agent, and the agent decides everything inside one long session. For
multi-step jobs that has four costs:

- **Price.** A yes/no check or a summary runs inside an Opus session that already holds a big context, when a bare Haiku
  call with no tools would do.
- **Order.** The agent can skip a step, reorder steps or wander off.
- **Gates.** Approval comes per tool call, not at the points that matter (before a PR opens, before a comment is posted).
- **Recovery.** When something fails partway, the whole run starts again.

A workflow splits the job into steps you can see, branch, approve and retry one at a time.

## The four jobs it must carry

The user wants all four. They are the acceptance test (see Success).

1. **Bug intake.** A new Workiom bug arrives by webhook. A Condition step asks "Is there enough info to fix this?" If no,
   an LLM step drafts a question comment, an Approval step shows it (editable), and an Agent step posts it with the
   Workiom CLI. If yes, an Agent step (workiom-master) fixes the bug, an Approval step gates the PR, and a Notify step
   reports the outcome.
2. **Release.** Started by hand with the release card link as input. Agent: merge master into the epic branch. Agent:
   check that the build passes. Approval. Agent: cut the release branch and open the PR. Then a loop: Agent checks the
   Azure build, Condition "Did it finish?", No → Wait 5 min → check again. Yes → Agent submits the approval form →
   Notify.
3. **Morning brief.** Schedule at 8:00 on weekdays. Agent (work-assistant) gathers mail, Slack and calendar. A Condition step asks
   "Anything urgent?" If yes, an LLM step writes a two-line summary and a Notify step pushes it. If no, nothing is sent.
4. **PR review.** A new GitHub PR arrives by webhook (filtered to `action = opened`). structure-reviewer and
   ui-ux-specialist run side by side. An LLM step merges their findings. Approval (editable). An Agent step posts the
   comment.

## Goals

- Draw, save, run and watch multi-step workflows in the app, on the same server that runs chats and routines.
- Steps: Trigger, Agent, LLM, Condition, Approval, Wait, Notify (below).
- Parallel branches, joins, and loops with a hard cap.
- Approve from a phone notification.
- Retry one failed step, and the run carries on from there.
- A run survives a server restart.
- Each step can be tested alone from the editor.

## Non-goals (v1)

- Shipped templates. The four jobs use the user's own agents, so they are built in the user's data after the feature
  works, not shipped in the product.
- Rooms as a step. Parallel Agent steps cover several agents.
- An existing chat as an Agent step's target (routines keep that). Each Agent step makes its own chat per run.
- Editing on a phone. A phone gets the run view, approvals, the on/off switch and Run workflow.
- Zumi Bot writing workflows from a chat.
- Importing n8n workflows. Code steps, HTTP steps, sub-workflows.
- Jev in workflows. Trigger filters and Condition steps take the place of the routine's Jev condition.
- Changing Routines. They stay exactly as they are.

## Anti-goals (failure even if it works)

- A workflow that silently does nothing. Every skip, failure or stuck join must show on the run, with a reason.
- A loop that runs up the bill. Every loop hits a cap.
- A step that acts without the approval the user drew. An Approval step blocks until the user answers, with no
  timeout and no auto-approve.
- Agent chats from workflow runs flooding the Agents sidebar.
- Push notifications that leak text the user did not put there on purpose.

## Where it lives

- **Rail.** A new **Workflows** entry (`mode-tab-workflows`) between Routines and To-dos. `RailMode` becomes
  `agents | routines | workflows`. It gets a waiting dot (`workflows-waiting`) while any run waits on the user: an
  Approval step, or a card in one of its Agent steps' chats.
- **Sidebar** (`WorkflowsSidebar.tsx`): the workflows by name, each with its trigger summary, an on/off switch and its
  last run's status dot, plus **New workflow**. The selected workflow lists its recent runs under it, like
  `RecentRuns.tsx`.
- **Main area**: the canvas editor, or a run (below).
- **Routes**: `/workflows`, `/workflows/<id>`, `/workflows/<id>/runs/<runId>` (`state/route.ts`), with Back and Forward
  working like they do for chats. A notification click opens the run's address.

## Data

Files in the data dir, written like the routine files:

- `workflows.json`: the definitions.
- `workflow-runs.json`: the runs. Each workflow keeps its newest 30, at most 10 of them skipped.
- `workflow-hooks.json`: webhook secrets, 0600.

```ts
type StepKind = 'trigger' | 'agent' | 'llm' | 'condition' | 'approval' | 'wait' | 'notify'
type Port = 'out' | 'yes' | 'no' | 'approved' | 'rejected'

interface Workflow {
  id: string; name: string; enabled: boolean; timeZone: string
  steps: Step[]; edges: Edge[]
  nextRunAt: number | null; createdAt: number; updatedAt: number
}
interface Edge { id: string; from: string; port: Port; to: string }
interface StepBase { id: string; kind: StepKind; handle: string; name: string; x: number; y: number }
```

`handle` is a short unique name for the step, such as `triage`, used in templates. It is made from the step's name and
can be edited.

Step settings by kind:

| Kind | Settings | Out ports |
|---|---|---|
| trigger | `trigger`: `manual` / `schedule` (routines' `Schedule`) / `webhook` (`sample`, `filters`) | out |
| agent | `agent`, `prompt`, `cwd`, `model?` (`opus`/`sonnet`/`haiku`, absent = the agent's own) | out |
| llm | `prompt`, `system?`, `model` (default `haiku`), `effort?` | out |
| condition | `question`, `model` (default `haiku`) | yes, no |
| approval | `question`, `editable` (default true) | approved, rejected |
| wait | `minutes` (1 to 1440) | out |
| notify | `title`, `body?` | out |

`filters` on a webhook trigger is a list of `{field, equals}` (for example `body.action` equals `opened`). Every filter
must match, else the call is recorded as a `skipped` run with the reason "Filter did not match" and nothing runs. They
are exact string compares and cost nothing.

## Steps

**Trigger.** Exactly one per workflow, the start. Its output is the manual input text (Run workflow opens a box with
an optional "Input" field), the webhook call's body as pretty JSON (capped at 20 000 characters), or empty for a
schedule. Run workflow on a webhook workflow uses the saved sample call, as Run now does for routines. The scheduler (`scheduler.ts`) is reused through a small interface, so one timer serves both routines and
workflows. A missed schedule run fires once late, as the routines' default does.

**Webhook.** The routines' `/hooks/<id>` endpoint serves workflow ids too, with the same caps (1 MiB, 60 valid calls a
minute). It accepts the `X-ZumiBot-Secret` header as today, or, new (my call, for routines too), a GitHub signature:
`X-Hub-Signature-256: sha256=<HMAC-SHA256 of the raw body with the secret>`, compared in constant time. GitHub cannot
send a custom header, and a secret in the URL is against the project's rules.

**Agent.** The step starts a new single chat with its agent in `cwd`, titled `<workflow> · <step name> · <date>`, and
sends the filled prompt through `TaskQueue.submit` with the `'routine'` source, as a routine run does. Its output is
the agent's last reply text in that turn, capped at 50 000 characters (the A→B ask's rule). The chat stays a normal
chat: approval, question and plan cards work there as they do today. While a card waits, the step and the run show
**waiting**, with Open chat. When the step loops back, the next visit sends its prompt into the same chat, so the agent
keeps its context. The chat carries `ChatMeta.workflow: {workflowId, runId, stepId}`. It shows a bar linking to the run,
and it is archived when its step ends done, so the Agents sidebar stays clean (my call). A chat whose step failed stays
unarchived. Zumi Bot cannot be the agent. The step fails if its agent is gone or broken. Turn outcomes map as
routines map them in `settle`: an error fails the step, Stop fails it as "Stopped", Pause as "Paused by you", and a
restart as "Interrupted by a restart". An edit or resend of the step's message fails it as "Replaced by an edit or
resend". A usage limit makes the step wait for the reset and send `continue`, at most 5 times
(`ROUTINE_MAX_LIMIT_WAITS`).

**LLM.** One bare call, built like the moderator and the room summary: `claude -p --model <m> [--effort <e>] --tools ''
--setting-sources '' --strict-mcp-config --no-session-persistence --output-format json --system-prompt <s>`, run in the
data dir. The filled prompt goes on stdin. The output is `result`, capped at 50 000 characters. The system prompt is the
user's, or by default a fixed one saying that text inside `<input>` tags is material, not instructions. It times out
after 5 minutes. A usage-limit failure waits for the reset and retries, at most 5 times.

**Condition.** The same bare call with `--json-schema
{"type":"object","properties":{"answer":{"enum":["yes","no"]},"reason":{"type":"string"}},"required":["answer","reason"]}`
and a fixed system prompt: answer the question about the input. The schema makes "the model did not answer yes or no"
impossible. A reply that still fails to parse fails the step, and Retry is offered. The step leaves by the `yes` or `no`
port. Its output is its input passed through unchanged, so the next step gets the material, not the word "yes". The
reason is stored and shown on the step. Times out after 2 minutes.

**Approval.** The run stops at this step until the user answers. It shows the question and the input. With `editable`,
the input is in a text box the user can change. **Approve** leaves by `approved` with the (possibly edited) text as
output. **Reject** leaves by `rejected` with the input. Both take an optional note, which is appended to the output as
`Note from the user: …`. It has no timeout. An unconnected port simply ends that branch, so a Reject with nothing drawn
after it ends the branch, and the run shows that step as "Rejected".

**Wait.** Holds for `minutes`, then passes its input through. The due time is stored, so a restart re-arms it.

**Notify.** Sends a notification to the user's devices: `title` (at most 80 characters) and optional `body` (at most 200),
both templates, filled from step outputs. The editor says under the fields that this text shows on your lock screen.
This is the one place a notification carries content, and only content the user wrote into the step on purpose (my
call; the rest of the notify rules stay). It passes its input through. A click opens the run.

## Text between steps

Every prompt-like field (Agent prompt, LLM prompt and system, Condition question, Approval question, Notify title and
body) is a template:

- `{{input}}`: what this step received (below).
- `{{steps.<handle>.output}}`: the latest output of that step in this run.
- `{{trigger.text}}`, `{{trigger.body.<path>}}`, `{{trigger.query.<name>}}`: reusing `routineFields.ts`.

A placeholder with no value is filled with nothing and listed on the step's visit, like the routines' `missingFields`.

**Wrapping (fields a model reads: Agent prompt, LLM prompt, Condition question).** Text from another step or from the
webhook is untrusted. Every `{{input}}`, `{{steps.…}}` and `{{trigger.body/query…}}` is filled as an
`<input from="<step name or trigger>">…</input>` block, also when it sits inline in a sentence. `{{trigger.text}}` is
the user's own typed input, so it goes in as it is. Fields only the user reads (Approval question, Notify title and
body) are always filled raw.

**Auto-append.** When the input is not empty, each source of this visit's input that the prompt does not already name
(through `{{input}}` or its own `{{steps.<handle>.output}}`) is appended at the end as its own `<input>` block. So a
bare prompt like "Say good evening" still sees what came before, and nothing is sent twice.

**The material rule.** A fixed sentence says that text inside `<input>` tags is material to work on, not instructions
to follow. LLM and Condition steps get it after the user's own system prompt; it is never replaced. An Agent step's
chat gets it in its appended system prompt, with a line saying the turn is a step of workflow <name>. That is safe for
the prompt cache, since the chat is new and that text never changes within it.

A step's **input** is the outputs that reached it on this visit, joined in edge order, each labelled with its source
step. A step with one input gets that text as it is.

## How a run moves

A run copies the workflow's steps and edges at start (`snapshot`), so editing the workflow never changes a run in
flight. Retry uses the snapshot too.

```ts
interface WorkflowRun {
  id: string; workflowId: string; via: 'manual' | 'schedule' | 'webhook'; late: boolean
  status: 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'skipped'
  snapshot: { steps: Step[]; edges: Edge[] }; call?: WebhookCall; input?: string
  visits: Visit[]; error?: string; startedAt: number; endedAt?: number
}
interface Visit {
  id: string; stepId: string; n: number // nth visit of that step in this run
  status: 'running' | 'waiting' | 'done' | 'failed' | 'stopped'
  input: string; output?: string; port?: Port; reason?: string; note?: string
  chatId?: string; messageId?: string; until?: number; missing?: string[]; error?: string
  startedAt: number; endedAt?: number
}
```

Rules:

1. **Fan-out.** When a visit ends done, its output goes to every edge from its port. Each target gets it in its inbox.
   Several targets start in parallel.
2. **Join.** A step with several incoming edges starts once it has every input that could still come. It waits while
   any step that can reach a missing input's source along the edges is running, waiting, or has an inbox about to fire.
   Once none can, it starts with the inputs it got. Then its inbox empties, so a loop can start it again. This one rule
   covers a branch not taken (a Condition's other port, a Reject), parallel branches of different speeds, and loops,
   with no "skipped" marks to propagate. It is pure and lives in `shared/src/workflowEngine.ts` with the graph checks.
3. **Loops.** An edge may point back to an earlier step. Each step runs at most 20 times per run, and a run makes at
   most 200 visits in all. Past either cap the step fails with "Ran too many times". A step runs one visit at a time.
   An inbox that fires while a visit of that step is still running waits until that visit ends.
4. **End.** The run ends when nothing is running or waiting and no inbox can fire. It is **done**, or **failed** when
   some step's latest visit failed. A failure later retried successfully no longer counts.
5. **Failure.** A failed visit stops the run from starting new steps. Steps already running finish and record their
   outputs. Then the run is **failed**, and the failed step offers **Retry**. Retry runs a new visit of that step with
   the same input, the run is **running** again, and it carries on from there with the inboxes as they were. A Retry
   of "Ran too many times" is a deliberate click, so it gives 20 more visits to that step and to every other step that
   used up its allowance (a loop's other steps), and 200 more to the run (my call): a slow release poll can be pushed
   on by hand, with one Retry for the whole loop, instead of the run being dead.
6. **Status.** The run shows **waiting** while any visit waits on the user (an Approval, or a card in an Agent step's
   chat), else **running**.
7. **Stop.** Stop in the run view stops every running Agent visit's turn (`ChatService.stop`), kills bare calls, clears
   waits and closes open approvals. The run becomes **stopped**, silently.
8. **Limits.** At most 5 unfinished runs per workflow, as for routines. Bare calls (LLM and Condition) run at most 4 at
   once server-wide, and the rest queue.

**Restart.** `recover()`:
- Re-runs an LLM or Condition visit that was running. They are side-effect free.
- Re-arms waits from `until`.
- Keeps approvals waiting.
- Keeps following an Agent visit whose message is still queued, and fails one whose turn was interrupted (Retry
  offered).
- Marks a Notify visit that was running as done without sending again, since a duplicate is worse than a missing one.

Shutdown clears timers and keeps state, like `RoutineRunner.stop()`.

## Editor

The canvas uses React Flow (`@xyflow/react`, pinned exact, MIT, loaded as a lazy chunk like noVNC). It works under the
current CSP, which allows inline styles. It is themed with the app's CSS variables for light and dark.

- **Top bar:** name, the on/off switch, **Run workflow**, **Save** (Ctrl+S), and a menu with Delete.
- **Add step:** a **+** button opens a menu of the six step kinds (the trigger is always there and cannot be removed),
  and the new step lands at the centre of the view. Dragging from a port onto empty canvas also opens the menu, and
  the new step comes already connected.
- **Steps on the canvas** are compact: kind icon and label, name, a one-line summary (agent and model, model and
  effort, the question, "Wait 5 min", the notification title), and labelled ports (Yes/No, Approved/Rejected). Edges
  from those ports carry the label.
- **Inspector:** a panel on the right edits the selected step: name and handle, then the kind's fields. Prompt fields
  reuse `PromptField.tsx`. A template field offers step handles and trigger fields after `{{`.
- **Run step** in the inspector tests that one step. The input is taken from the step's latest visit in the newest run,
  or typed into a box. The result shows in the inspector and is not stored as a run. An Agent step's test makes a real
  chat, and the inspector says so. Approval, Wait and Notify have no test.
- **Delete, Esc,** and the unsaved-changes guard work as in the routine editor.
- **Validation.** Save always works, so a half-drawn workflow is kept. **Run workflow** and turning the workflow on
  refuse while it has problems, and each problem shows on its step:
  - not exactly one trigger, or an edge into the trigger
  - a step no edge reaches from the trigger
  - a missing, broken or Zumi Bot agent
  - a folder that does not exist
  - an empty prompt or question
  - a duplicate handle
  - a `{{steps.x…}}` that names no step
  - fields over their caps (prompts 20 000 characters)

## Run view

The same canvas, read-only, drawn from the run's snapshot. Each step shows its state: not run, running (spinner),
waiting (amber), done (check), failed (red), stopped. A visit count shows when a step ran more than once. Selecting a
step lists its visits in the inspector, newest first, each with:
- input and output (Markdown)
- reason (Condition) and note (Approval)
- missing fields and error
- **Open chat** (Agent)
- **Retry** (on a failed visit)

An Approval visit that is waiting shows the question, the editable box and Approve / Reject with a note field at the
top of the inspector. That step is selected when the run opens. **Stop** sits in the top bar while the run is
unfinished.

On a phone (`useNarrow`) the run view is a vertical list of visits in time order instead of the canvas, with the same
details and the approval box. The editor shows a note saying to edit on a larger screen, and keeps the on/off switch and
Run workflow.

## Notifications

- An Approval step waiting sends a notification of kind `waiting` (same per-device toggle), tag
  `workflow:<runId>:waiting`, titled "<workflow> needs your approval". Once the run has no approval left waiting
  (answered, or the run stopped), that notification is cleared like a chat's `waiting` (`notify:clear`).
- A run that fails sends one of kind `routine-failed`. The toggle's label becomes "A routine or workflow failed". A
  stop or a restart sends none.
- A Notify step sends its title and body, kind `workflow` (new), always on while the device has notifications on,
  inside the existing 10 a minute cap.
- The payload gets an optional `run: {workflowId, runId}` (added to `PAYLOAD_KEYS`) and, for Notify only, `body`. A
  click opens `/workflows/<id>/runs/<runId>`. Presence does not apply, since there is no chat to look at.
- An Agent step's chat sends `waiting` as any chat does. Its `replied` and `error` are silent, like an A→B chat's
  (`asked: true`): the workflow reports for itself.

## Elsewhere

- **Agent rename** moves `agent` in steps and in run snapshots (after routines, caught and logged). **Agent delete**
  leaves the step broken (red on the canvas), and a run fails at that step.
- **Deleting a workflow** stops its unfinished runs first (as Stop does), then drops its runs and secret. The chats
  it made stay, like routines.
- **Usage.** Agent steps cost on their chats, as today. Bare calls record their cost as a workflow's (shown as
  "Workflow: <name>" in Usage), in the same way `#handoff` records the room summary's.
- **Sync (`sync.mjs`)** treats the files like the routine files:
  - `workflows.json` stays enabled on the VPS only, and the local copy is switched off.
  - `workflow-runs.json` is newest-wins.
  - `workflow-hooks.json` follows `routine-hooks.json`.
  - `ChatMeta.workflow` travels with the chat.
- **RPCs:** `workflows:list | getRun | save | remove | setEnabled | run | stop | retry | approve | testStep | webhook |
  newSecret`, and the `workflows:changed` event. Handlers check every argument, as all handlers do. `list` and the
  event carry run summaries only (status, times, which steps wait or failed). `getRun` returns one run with every
  visit's input and output, so outputs are never broadcast to every tab.

## Security

- Webhook bodies and agent outputs are untrusted text. They go into prompts inside `<input>` tags, and the LLM and
  Condition system prompts say to treat them as material. Agent steps run with the agent's normal permission mode and
  cards. No step gets more rights than the same agent has in a chat. Never `--dangerously-skip-permissions`.
- Secrets never go in logs, URLs, errors or the UI after creation, as for routines. The HMAC compare is constant time.
- Bare calls get no tools, no settings, no MCP and no session.
- Outputs and the Notify text stay out of server logs.

## Testing

- **Pure (shared, frontend `state/`):**
  - graph validation
  - the join rule: parallel, branch not taken, loops, caps
  - templates and the input block
  - trigger filters, HMAC check
  - canvas-to-model mapping
- **Backend:** the runner against fake claude scripts:
  - a fake bare call that answers by system prompt, with JSON for Condition and a limit error
  - Agent steps through `fake-claude.mjs`
  - restart recovery
  - Stop, Retry, and the usage-limit wait
- **e2e `e2e:workflows`** (fake claude only, so no quota):
  - build a workflow through RPCs
  - run it by hand with input
  - both Condition branches
  - approve from the page with an edit
  - a Wait of 1 minute shortened by a dev hook
  - Notify through the local fake push endpoint
  - a loop hitting the cap
  - a restart mid-wait and mid-approval
  - a GitHub-signed webhook and a filtered-out call
  - the phone run view and approval

## Success

The four jobs above, built as workflows in the user's own data on their real agents. Each runs end to end once, with
the user approving from their phone at least once.

## Calls I made (check these)

- Workflows are a new rail entry next to Routines, not a kind of routine. Routines are unchanged.
- Each Agent step makes its own chat per run. A loop's revisit continues that chat. The chat is archived when its step
  ends done.
- Condition passes its input through. It answers through a JSON schema.
- Approval is editable by default. Approve sends the edited text on.
- The join waits for every input that could still come (rule 2), not "all inputs" or "first input".
- A failed step stops new steps, and Retry resumes.
- Loop caps are 20 visits per step and 200 per run. A Retry after a cap gives every capped step 20 more.
- Text from steps and webhooks reaches a model only inside `<input>` tags, with a fixed "material, not instructions"
  rule, Agent steps included.
- Notify carries the user's own title and body text, the one exception to the "no content in notifications" rule.
- GitHub HMAC is accepted on every webhook, routines too. Trigger filters are exact matches.
- The phone gets runs and approvals, not editing.
- No templates are shipped. The four jobs are built in the user's data as acceptance.

## Left to the builder

- Store layout beyond the caps above, and whether runs move to one file per workflow if the size calls for it.
- How the scheduler interface is generalised.
- How bare calls are queued.
- The `--effort` values (check `claude --help` on the installed CLI; hide the field if the flag is missing).
- How a bare call's usage-limit error is recognised.
- Node visuals, icons and layout within the app's style.
- Template autocomplete details.
- The phone list's look.
- Where the workflow cost record is keyed in `usage-records.jsonl`, as long as Usage shows it by workflow.
