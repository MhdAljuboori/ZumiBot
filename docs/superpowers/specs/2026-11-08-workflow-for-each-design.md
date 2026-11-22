# Workflow step: For each

A workflow step that runs one agent over a list, one item at a time, each item in its own fresh chat, and shows which
item it is on.

## Why

The first job for it is the W5 design audit. Done by hand in one chat (`8d0485f4`, ui-ux-specialist, 5–6 Nov), the
audit walked 36 parent areas of the W5 Backlog (Parent-107 Grid View … Parent-230 Org Chart View), shot design vs
product per area, consolidated the findings and filed 170 cards. The user wants the same job as a workflow they start
with an area name, a `Parent-` key, several of them, or nothing / `All` for every parent.

Three things stop today's workflows from carrying that job:

- **No progress at a glance.** The run view shows step states and visits. To know which area the audit is on, the user
  has to open the step's chat and read. The user asked for this first: "I would like to know on which area the workflow
  is."
- **The 20-visit cap.** A loop of Agent → Condition → back does one area per visit, and a step may run 20 times per run
  (`STEP_VISITS_MAX`). `All` is 36 areas, so the run stops at the 21st and waits for Retry.
- **One growing context.** A loop's revisits go on in the same chat. The hand-run audit reached 730K of context, and
  what finally worked was "one fresh reviewer at a time with a small scope (one parent area)".

## Goals

- A new step kind, **For each** (`foreach`), drawn, saved, run and retried like the other steps.
- It turns its input into a list, one item per line, and runs its agent once per item, in list order, one at a time.
- Every item runs in a fresh chat of its own, so no item carries another's context.
- Progress is visible without opening anything: `3 / 36 · Gallery View` on the step in the run view, in the run header
  and on the run's row in the Workflows sidebar; the visit panel lists every item with its state.
- A failed item does not stop the others (the user's decision). Once every item has been tried, a step with failed items
  fails, and Retry runs only the failed items again.
- Each item behaves like an Agent step in every other way: approval cards, usage-limit waits, Stop, Pause, restart,
  cost, archive when done.

## Non-goals (v1)

- Items at the same time. One at a time only; the hand-run audit lost a whole round when 8 parallel reviewers hit the
  usage limit together.
- A loop body of several steps (n8n's "Loop Over Items"). The body is one agent; an item that needs a second pass sends
  its own subagents inside its chat.
- Lists in other shapes (JSON arrays, CSV). One item per line.
- LLM or Condition per item. Agent only.
- Changing the list while the step runs.
- A notification per item. The run's own notifications are unchanged.

## Anti-goals (failure even if it works)

- Progress that names an item other than the one running, or a count that disagrees with the item list.
- An item that quietly drops out: every item ends in the visit's item list with an outcome, and in the step's output.
- Retry that runs a finished item again (paying for it twice).
- One failed item halting the rest.
- Thirty-six item chats left in the Agents sidebar after a good run.
- Anything per-item in an item chat's system prompt (the item text, its number): the workflow paragraph is fixed for the
  prompt cache, as it is for Agent steps.

## The step

Inspector fields are the Agent step's: **Agent**, **Folder**, **Model** (optional) and **Prompt**, with the same rules
(no Zumi Bot, the agent must load, the folder must exist, prompt within `PROMPT_MAX`). A hint under the prompt names
the new fields. Its port is `out`. It sits in the editor's add menu after Agent, with its own icon.

### The list

- The visit's input (the joined deliveries, as for any step) is split on line breaks. Each line is trimmed; empty lines
  are dropped. Exact repeats are dropped, keeping the first (a model that lists an area twice must not run it twice).
  Order is kept.
- At most `FOREACH_ITEMS_MAX` = 100 items, each at most `FOREACH_ITEM_MAX` = 1 000 characters. A longer list or line
  fails the visit before any item runs: `The list has 140 items; the most is 100` / `Item 3 is over 1 000 characters`.
- No items: the visit ends done at once with an empty output and the item list says `No items`. (My call: the step
  before is where "nothing matched" should be decided and said.)

### Templates

The prompt is filled per item, in model mode, with three new fields beside the usual ones:

| Field | Value |
|---|---|
| `{{item}}` | the item's text, wrapped as `<input from="item">` like other material, since it came from a step's output or the trigger |
| `{{item.number}}` | 1-based place in the list, raw |
| `{{item.total}}` | the list's length, raw |

`{{input}}`, `{{steps.<handle>.output}}` and `{{trigger.…}}` fill as in any step. Unlike an Agent step, the visit's input
is **not** appended when the prompt does not name it: the item is the material, and appending the whole list to every
item's prompt would invite the agent to do them all. (My call.)

The editor's `{{` menu offers the three item fields in a For each prompt only. Outside a For each prompt they are unknown
fields, as today. A For each prompt that never uses `{{item}}` is a problem (`Use {{item}} in the prompt`): every item
would get the same prompt. (My call.)

### Running the items

- Items run in list order, one at a time. The next item starts when the one before has ended, whatever its outcome.
- Each item gets a new chat with the step's agent, folder and model, titled `<workflow> · <step> · <item> · <date>`
  (the item cut to 60 characters), and `ChatMeta.workflow` gains `item: {n, total}`. Its system prompt gets the same
  fixed `workflowSystem` paragraph an Agent step's chat gets; the item number never enters it.
- Inside its chat an item behaves exactly like an Agent step's turn today: sent through `TaskQueue.submit(…, 'routine')`;
  a card makes the item `waiting`, so the visit and the run show waiting; a usage limit waits for the reset and sends
  `continue`, at most 5 times per item; the outcomes Stopped, Interrupted by a restart, Replaced by an edit or resend,
  Removed from the queue and Chat was deleted end the item the same way; a turn the user pauses keeps the item open, as it
  keeps an Agent step's visit open (see Pause below); the item's output is the last reply.
- A done item's chat is archived; a failed item's chat stays in sight.
- A failed item is recorded and the next item starts (the user's decision: keep going, retry later). That includes a
  Stop pressed in the item's own chat and an item interrupted by a restart.
- **Pause.** (Changed when master's paused-step change, 919c206, was merged: a paused Agent step now stays open instead of
  failing `Paused by you`, and items follow it.) An item whose turn the user pauses does not fail: it stays open
  (`running`, `ItemRun.paused`), so no further item starts, since the next starts only once the current one has ended.
  Resume's Continue carries it on (`resumes` counts those) to done, and the list goes on. A message of the user's own in
  that chat fails it `Continued by hand`, silently, and the next item starts. Stop during a paused item stops the run
  without stopping the idle paused chat. The item row and the node show paused, and the summary's progress carries
  `paused`. No hold rule of its own is needed.

### How the step ends

- Every item done: the visit ends `done` and hands on its output.
- Any item failed: once every item has been tried, the visit ends `failed` with `2 of 36 items failed`. The run halts
  as for any failed step: nothing downstream starts until Retry.
- Stop: the running item's turn is stopped, no further item starts, and the visit ends `stopped`.

### Output

The step's output is every item's last reply, in list order, each under its item as a heading:

```
## Parent-120 Home Page

<reply>

## Parent-122 Inbox

<reply>
```

Each item keeps up to `FOREACH_ITEM_OUTPUT_MAX` = 20 000 characters of its reply (shown in the item list). The joined
output is capped at `FOREACH_OUTPUT_MAX` = 100 000 characters by giving each item an equal share, so every item appears
even when the replies are long; a cut reply ends with `… (cut; the full reply is in the run view)`. Jobs with big
results should write them to files and reply with a short summary, as the audit's reviewers did with `findings.md`.

### Retry

- **Retry on the failed visit** runs the failed items again, in list order. Done items
  are not run again: their outputs carry over, so the step's output after the retry is the whole list's.
- **Retry on one failed item** (its row in the item list, offered once the visit has failed) runs only that item; the
  other failed items stay failed, so the visit fails again unless that was the last one.
- A retried item goes on in its own chat when that chat still exists (the agent keeps what it found, like an Agent
  step's Retry), else in a new one.
- A Retry counts as a visit of the step against its cap, as today. A list of 100 items is still one visit.
- A new visit that reaches the step by an edge (a loop around it) is a fresh run of the whole list in fresh chats.

## Progress

- **`WorkflowRunSummary.progress`** (absent when no For each visit is open): one `{stepId, done, failed, total,
  current, paused?}` per open For each visit (`paused` while the current item is paused, shown as ` · paused`), in
  step order (two can be open on parallel branches; the header and the sidebar row show the first). `done` counts carried items too; `current` is the running or waiting item's text cut to 80
  characters. It rides `workflows:list` and `workflows:changed` like
  the rest of the summary. That puts one line of item text in a broadcast, where today only states and costs go; every
  tab is the same signed-in user, and an item is a line of the step's input, not an output. It is part of
  `summaryKey`, so the open run refetches as items move.
- **Run view, wide screen:** the For each node shows `3 / 36` and the current item under its name; the run header shows
  `Gallery View · 3 / 36` beside the status while it runs.
- **Workflows sidebar:** the run row shows the same short line while the run is unfinished.
- **Visit panel:** a counter (`31 done · 2 failed · 3 to go`) and the item list: number, item text, state dot,
  "Waits until" for a limit wait, cost, **Open chat**, the item's output (`VisitText`, with Expand), its error, and
  **Retry** on a failed item once the visit has failed. The running item is lit and kept in view.
- **Phone run view:** the For each visit's row shows `3 / 36 · Gallery View` and opens the same item list.
- **Item chat:** `WorkflowChatBar` reads `Item 3 of 36 · <step>` and links to the run.
- **Inbox:** an item's waiting card shows as any chat card does, under its chat's title, which already names the item;
  nothing changes there.

## Data

```ts
type Step = … | (StepBase & { kind: 'foreach'; agent: string; prompt: string; cwd: string; model?: ModelAlias })

interface ItemRun {
  n: number; text: string
  status: 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'
  chatId?: string; messageId?: string; until?: number
  paused?: true; resumes?: number // paused by the user: open until Resume's Continue, as an Agent step's visit
  output?: string; error?: string; costUsd?: number
  carried?: true // ended in an earlier visit of this step (done, or failed and not picked by a one-item Retry); not run in this one
  startedAt?: number; endedAt?: number
}
interface Visit { …; items?: ItemRun[] } // For each visits only
```

- `Visit.costUsd` is the sum of the item turns run in that visit (carried items keep their cost on the earlier visit),
  so `runCostUsd` and the per-step costs stay right without change.
- Item turns report their cost through `ChatService.onRunCost` → `WorkflowRunner.chatCost`, counted only while the
  turn answers the item's own message, as for Agent steps.
- `workflowInput.ts` accepts the new kind key by key; `problemsOf` checks it as an Agent step plus the `{{item}}` rule.
- An agent rename moves For each steps and run snapshots with Agent steps. Deleting a workflow stops its runs first, as
  now; item chats stay.
- `sync.mjs` needs no change: runs are newest-wins and a pulled unfinished run is marked stopped.

## Recovery

At start, `recover()` treats the running item like an open Agent visit today: a message still queued is followed, a
turn that ended is settled, an interrupted one fails (`Interrupted by a restart`), a stored limit wait is re-armed. Then
the step goes on with the next pending item. A crash between items (the last item settled, the next not yet written)
starts the next item.

## Editor and Run step

- Add menu, canvas node and inspector as above. The hint under the prompt: "Runs once per line of its input, each in a
  fresh chat. Use {{item}} for the line."
- **Run step** runs the first item of the test input only, in a test chat as Agent steps do, and says so: "Runs the
  first item only." (My call: a 36-item test is a real run.)

## Testing

- Shared, pure: list parsing (trim, empty lines, repeats, both caps), the joined output and its fair-share cut,
  progress in `summaryOf`, the retry carry-over, `problemsOf` rules.
- Backend, with the fake claude: items in order in their own chats; a failed item and the rest going on; the visit
  failing at the end; Retry running only the failed items and the output covering all; a per-item Retry; Stop between
  and during items; a card making the item, visit and run waiting; a usage-limit wait per item; a restart mid-item and
  between items; costs per item and per visit; archive of done item chats only; a paused item held open, carried on to
  done by Resume, failed `Continued by hand` by the user's own message, and kept paused across a restart.
- `e2e:workflows`: a manual run with three lines where the fake fails the second; the sidebar row and header show
  `2 / 3`; the item list; Retry of the failed item; the final output; the phone view.

## Success

The W5 audit's `All` run goes through all 36 parents in one run. At any moment the sidebar row and the run header say
which parent is running and how many are left. A parent that fails does not stop the rest, and Retry runs only that
parent again. No item chat is left in the Agents sidebar after a good run.

## Calls I made (check these)

- One item at a time, no parallel option in v1.
- At most 100 items of at most 1 000 characters; repeats dropped; an empty list ends done.
- The list is not appended to each item's prompt; `{{item}}` is required in the prompt.
- A retried item continues in its own chat; a loop's new visit starts fresh chats.
- A paused item stays open, as a paused Agent step does since master's 919c206, so the step waits on it until Resume
  carries it on; any item failure keeps going. (This replaced "Pause holds the whole step" at the merge.)
- Item output 20 000 characters each, joined output 100 000 with an equal share per item.
- The current item's text (80 characters) rides the run summary broadcast.
- Run step tests the first item only.

## Left to the builder

- How the runner follows items: generalise `WorkflowAgentSteps` to follow a slot (visit plus item) instead of a visit,
  or model items as child visits that the engine's caps, joins and summaries skip. Either must keep every write in the
  run's queue and keep the engine's join rule seeing one visit per step.
- The node badge, the item list's layout and the For each icon, within the run view's existing styles.
- Where the item list scrolls on a long list.
