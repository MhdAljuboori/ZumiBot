# Workflow and routine parity (Phase 1 of folding routines into workflows)

Date: 2026-11-13. Status: draft, not built. The user accepted the three-phase plan in chat and asked for this spec
without further questions, so the phase plan and the Phase 1 scope are **(user)**; every detail below is the writer's
call, marked **(call)** where it is a real choice.

## Why

Routines and workflows overlap: a routine is a trigger plus one "send a prompt" step. Each has its own editor, store,
runner, saved history, Zumi Bot tools and sync rules, so every cross-cutting feature lands twice (pause, spend caps,
saved history, Duplicate, Zumi Bot automations, usage-limit waits). The worst duplication is the code that follows an
agent's turn in a chat: `routineRunner.ts` (628 lines) and `workflowAgentSteps.ts` (488 lines) each handle limit waits,
Pause and Resume, spend caps, "Continued by hand" and cost.

The plan **(user)**:

1. **Phase 1 (this spec).** Workflows learn everything a routine can do, so any routine can be written as a workflow.
   Each piece is useful to workflows on its own. Routines are not touched.
2. **Phase 2.** The Routines form saves a workflow marked simple ("Open as workflow" moves it to the canvas). A one-time
   migration turns each routine into a workflow under the same id (webhook URLs and secrets keep working).
3. **Phase 3.** Remove `routineRunner`, `routineStore`, `routineEditing`, the routine Zumi Bot format (or keep it as a
   thin translation) and the routine sync rules.

You can stop after any phase. Phase 1 must leave Phase 2 a 1:1 mapping (see "Phase 2 mapping" at the end).

## The gaps this phase closes

| A routine can | A workflow today |
|---|---|
| Post into an **existing** chat or room, continuing or refreshing its sessions (`target.kind: 'chat'`, `sessionPolicy`) | Agent and Room steps always start a fresh chat or a fresh room copy |
| Make a new room from a **member list + role + folder** (`new-group`) | Room step needs a template room |
| Keep each run's chat in the sidebar, named by `title`, a room placed in a sidebar `section` | Agent and Room step chats are archived once the step is done, and their replies are silent |
| Start the prompt with a **`/command`** (with its model) | No commands in step prompts |
| **Skip** a run at the usage limit (`limitPolicy: 'skip'`) | Always waits for the reset (up to 5 times) |
| **Skip** a missed schedule run (`missedPolicy: 'skip'`) | A missed run always fires once late |
| Check a webhook call with **Jev** (`trigger.condition`) | Exact-match filters only |

## Goals

1. A new step kind, **Chat** (`kind: 'chat'`): posts its prompt into an existing chat or room, continuing its sessions
   or starting them fresh.
2. The **Room** step can also make a **new room from agents** (members, role, folder) instead of copying a template.
3. **Keep the chat**: Agent and Room steps can leave their chat in the sidebar instead of archiving it, with a fixed
   title, and a kept room can go at the top of a sidebar section. A kept chat behaves like a routine's chat.
4. **Commands** in the prompts of Agent, For each, Room and Chat steps, with the routine editor's rules.
5. Two workflow settings: **At the usage limit** (Wait and continue | Skip this run) and **If a run was missed**
   (Run once late | Skip), shown with the existing spend cap in the trigger inspector.
6. A **Jev condition** on the webhook trigger, checked after the filters.
7. Zumi Bot's workflow format, saved history, the Audit log, agent rename and the run view cover all of the above.

## Non-goals

- Changing routines in any way, or migrating them (Phase 2).
- A simple, form-style view of a workflow (Phase 2).
- Keep for For each steps: up to 100 kept chats per visit would flood the sidebar **(call)**.
- Run step (the editor's test) for the Chat step: it would post into the user's real chat **(call)**. Hidden, as for
  the Room step.
- Templated chat targets: the Chat step's chat is a fixed id, never filled from `{{…}}`.
- A section for kept single chats: a single chat always shows under its agent, as for routines.
- Approval rules (`rules`) on the Chat step: the target chat keeps its own "Allow for this chat" answers, which last
  across runs **(call)**.

## Anti-goals (a failure even if it works)

- **A Chat step changing the target chat's prompt-cache prefix.** It must not set `ChatMeta.workflow` on the chat and
  must not add `workflowSystem` to its system prompt: the user's own turns there would then read a different prefix
  from the workflow's, and every run would rewrite the whole context into the cache, and again at the user's next
  message. The material rule goes into the message instead (see Chat step › What the agent reads).
- **A webhook or model value choosing where a message goes.** The Chat step's chat, the Room step's members and a
  command name come only from the saved step.
- **A caller's text becoming a command.** As for routines, the `/name` must lead the step's saved prompt before any
  `{{…}}` is filled.
- **Existing workflows changing behaviour.** Every new key is optional, absent means today's behaviour, and the
  history's `sameDef` must still find a version saved before this change equal to the same workflow after it (the new
  keys are written only when set).
- **A kept chat that still acts like a background chat**: silent replies, missing from the island, archived.

## Shared types (`shared/src/workflows.ts`)

```ts
type Session = { session?: 'fresh' }             // absent = continue each agent's session
type Kept = { keep?: true; title?: string }      // title: the kept chat's or room's name, at most ROUTINE_CHAT_TITLE_MAX
type Cmd = { command?: CommandPick }             // the editor's `/` pick, kept only while the prompt still starts with it

| (StepBase & Fails & Kept & Cmd & { kind: 'agent'; agent: string; prompt: string; cwd: string; model?: ModelAlias })
| (StepBase & Fails & Cmd & { kind: 'foreach'; … as today })
// room: the template's id, '' when the step builds its room from agents (members set). Kept a plain string, so every
// reader of step.room today stays as it is; roomFromAgents(step) says which source a step has.
| (StepBase & Fails & Kept & Cmd & { kind: 'room'; room: string; prompt: string; rules?: StepRule[]; section?: string;
    members?: string[]; role?: string; cwd?: string })
| (StepBase & Fails & Session & Cmd & { kind: 'chat'; chat: string; prompt: string })

interface Workflow {
  …
  limitPolicy?: 'skip'    // absent = wait for the reset and continue (today)
  missedPolicy?: 'skip'   // absent = a missed schedule run fires once late (today)
}
type WorkflowTrigger = … | { kind: 'webhook'; sample; filters; condition?: string }  // at most JEV_CONDITION_MAX
interface WorkflowLink { …; keep?: true }        // on a kept chat
interface WorkflowRun { …; condition?: ConditionCheck }
```

- `chat` joins `StepKind` and `FAILING_KINDS` (an `error` port with On failure), with ports `out` and `error`.
- `parseStep` (`shared/src/workflowInput.ts`) rebuilds the new keys key by key: `keep` only as `true` and only on
  agent and room, `title` trimmed, empty dropped, at most 100; `section` only on a kept room; `session` only as
  `'fresh'`; a room step holds exactly one of `room` or the `members`/`role`/`cwd` trio (members unique, 2 to the
  member limit `createGroup` already enforces); `command` as `CommandPick` with both names non-empty, dropped when the
  prompt does not start with `/<name>` (the routine rule).
- `parseWorkflowInput` takes `limitPolicy`, `missedPolicy` and the trigger's `condition` the same way (wrong values
  dropped, not refused).
- `stepDefaults` gains `chat` (`chat: ''`, `prompt: '{{input}}'`).

## Problems (`problemsOf`, `shared/src/workflowGraph.ts`)

Added, each refusing Run and turning on, as today's problems do:

- Chat step: no chat picked; a chat the page's list does not hold ("Chat not found", checked again by the server when
  the step starts); an A→B chat ("This chat is read-only"); a workflow's own chat (`ChatMeta.workflow` or
  `workflowTest`); a single chat of Zumi Bot ("Zumi Bot cannot be a workflow step", today's text); a single chat whose
  agent is missing or broken. A room is judged at start by the members it has left, as a routine does.
- Room step from agents: fewer than two members; a member missing, broken or Zumi Bot; a Codex member while
  `engineCaps('codex').rooms` is off (`refuseCodexMembers`); a folder that does not exist.
- A `section` on a step that is not a kept room, or a `keep` on any other kind, never reaches here: `parseStep` drops it.
- Prompts of the new kinds within 20 000 characters, as today.

## Chat step (backend)

The Chat step is a slot of `workflowAgentSteps.ts` whose chat is given rather than made. **(call)** No new runner: the
slot machinery already follows a message in a single chat (Agent step) and a room until it goes quiet (Room step).

**Start.** Inside the run's queue: read the chat (`Chat not found` or `This chat is read-only` fail the visit with
cause `step`, so On failure can take them); if `session: 'fresh'` and the chat is not pausing or paused, start its
sessions fresh with the routine's rule, moved out of `RoutineRunner.startFresh` into a shared helper in `core/chat/`
(`startFresh(chats, chat)`), which both runners then call; fill the template (below); resolve the command
(`CommandResolver.forRoutine`, see Commands); `TaskQueue.submit(chatId, text, [], undefined, messageId, command,
undefined, 'routine')`. The visit then follows `messageId`.

**Ends.** A single chat: as an Agent step (the turn that answers the message ends; the output is its last reply, 50 000
characters). A room: as a Room step (quiet: nobody working, nobody queued; the output is the room's last reply; a room
at its turn limit holds the visit `waiting` until the user's own post, which the slot then follows). Outcomes map as
an Agent step's do: Stopped, Interrupted by a restart, Replaced by an edit or resend, Continued by hand, a usage-limit
wait sending `continue` (or the workflow's limit policy, below), a paused turn keeping the visit open until Resume.
The chat's own usage-limit wait (`LimitResumes`) leaves the step's turn alone, as it leaves a routine's: the slot is
in `messagesOf`, read before the idle settles it.

**Never archived, never marked.** The chat is the user's: the step sets no `ChatMeta.workflow`, so its system prompt,
`WorkflowChatBar`, island listing and notifications stay exactly as they are, and a reply notifies as any reply in that
chat does (as a routine's run into a chat does today). Sending into an archived chat unarchives it, as every send does.

**Pause, queue, two writers.** A chat that is pausing or paused takes the message held, as a routine's does (the visit
stays `running` until Resume carries the message on), and gets no fresh start. Two workflows, a routine and the user can
all post into one chat; `TaskQueue` orders them and each follows its own message id. The visit is never ended by
another sender's turn.

**Stop.** As an Agent step: the turn answering the step's message is stopped; a message still in the tray is only
dropped, so a turn ahead of it (the user's) runs on.

**Spend.** The turn answering the step's message counts toward the run's cost and spend cap, as an Agent step's does
(`runMessages`). The daily cap gate (`capGate`) judges the chat's agent, or the room's members.

**What the agent reads.** The prompt is filled with `modelPrompt`, as an Agent step's is (each untrusted value inside an
`<input from="…">` block, unnamed inputs appended). Since the chat's system prompt must not change, a message holding
any block ends with the fixed `MATERIAL_RULE` sentence on its own line, after the blocks, so a leading `/command` stays
first **(call)**. A message holding no block is sent as filled.

**Mentions.** In a room, an `@handle` inside an `<input>` block neither routes nor gets a notice, as in a workflow's own
room: `GroupService` masks the blocks (`maskInputBlocks`) for a user message that carries `workflowSent`, as it does for
a chat with `ChatMeta.workflow`. Otherwise a webhook value could pick which members answer.

**Showing who sent it.** The stored user item records the sender, `workflowSent: {workflowId, runId, stepId, name,
step}` (`name` and `step` as they were then) **(call)**. The bubble shows the existing `wf-from` sender line and draws
the `<input>` blocks as `WorkflowPrompt` boxes, as in a step's own chat, with a link to the run while it exists. Fork
keeps the field; export writes "You" as today; `chat_read` leaves it out.

## Room step from agents (backend)

`workflowRooms.ts` gains the second source: a visit with `members` makes its room through `ChatStore.createGroup(members,
cwd, role)` (after `refuseZumiBot` and `refuseCodexMembers`, read at start as the routine runner does), then sets the
title and `ChatMeta.workflow`, then copies the step's `rules` onto it as `workflowRules`. Everything after that (posting,
quiet, turn limit, archive, Retry and loop reusing the visit's room) is today's Room step. A template room is copied as
today.

## Keeping the chat

On an Agent or Room step with `keep: true`:

- The chat is **not archived** when the step ends done (`workflowAgentSteps.archive` skips it).
- Its title is the step's `title` when set, else today's `<workflow> · <step> · <date>`.
- `ChatMeta.workflow.keep` is set. Readers that treat a workflow chat as background read it **(call)**:
  - `notifyService` sends `replied` and `error` (the turn end's `workflow` flag is false for a kept chat);
  - the island lists it (`state/island.ts` drops only non-kept workflow chats);
  - `WorkflowChatBar` and `workflowSystem` stay, since the chat was made by the workflow from its first turn, so its
    prefix never changes.
- A kept room with `section` is put first in that section (`SidebarStore.placeFirst`, broadcast as `sidebar:changed`;
  a failed write is logged and the step goes on; a section deleted since leaves it outside them), as a routine's
  `new-group` run does.

## Commands

The routine rules, applied to Agent, For each, Room and Chat steps:

- Only a `/name` that leads the step's **saved** prompt is a command; it is resolved before `{{…}}` is filled, so no
  filled value can make one. `$ARGUMENTS` is the filled text after the name.
- At start, `CommandResolver.forRoutine(chatId, savedPrompt, filledText, step.command)` resolves it from the agent
  file as it is then. A stale pick falls back to the name; a name several room members share without a pick fails the
  visit (cause `step`). An unknown name is sent as typed.
- Its model: an Agent or For each step's own `model` wins (the step sets it on its new chat); with none, the command's
  model applies to the chat's first turn through `turnModel`, as for a new chat. In a Chat step the target chat's own
  rule applies (a by-hand pick wins; in a running session only a stronger model switches up).
- A command's `todos: true` is ignored, as in routines, which never set the to-do flag **(call)**.

## Workflow settings

**At the usage limit.** `limitPolicy: 'skip'`: the first time a usage limit stops any visit of the run (an Agent, For
each, Room or Chat turn, or a bare LLM or Condition call), the run stops as Stop does (silently, every open visit
stopped, running turns stopped) and ends `skipped` with the error `Skipped at the usage limit`. No failure push, no
Retry **(call)**. Absent: today's wait and continue, up to 5 times.

**If a run was missed.** `missedPolicy: 'skip'`: a schedule run that would fire late is stored as a `skipped` run with
the error `Missed while ZumiBot was off` and starts nothing. It counts among the 10 skipped runs kept.

**Jev condition.** On a webhook trigger, `condition` (plain words, at most `JEV_CONDITION_MAX`) is checked by
`checkCondition` (`core/jev/webhookCondition.ts`) after the filters pass and before the run starts, only for real calls
(not Run with the saved sample), only while Jev's webhook feature is on. `met: false` stores a `skipped` run with
`Condition not met` and its `condition`; `met: null` or any Jev failure runs, as for routines. The 60-calls-a-minute
count is unchanged (it counts before `fire`).

## UI (frontend)

- **Add step menu:** **Chat** ("Send to an existing chat or room"), its own icon.
- **Chat step inspector:** a chat picker, a select like the Room step's (single chats and rooms in two groups, by
  title through `chatTitle`; A→B, workflow and archived chats left out, an archived one kept only while it is the
  current pick; a gone one reads "Chat not found"); Prompt with the `/` command
  menu at its start and the `{{` menu; **Session**: Continue (default) | Start fresh each run, with the routine
  PolicyCard's one-line help; On failure. No Run step.
- **Agent step inspector:** **After the step**: Archive the chat (default) | Keep it in the sidebar; with Keep, a
  **Title** field (placeholder: today's default).
- **Room step inspector:** **Room**: Copy a room | New room from agents. The second shows the members picker
  (`memberOptions(caps)`), Role and Folder, as the new group chat screen does. Then Keep, Title and, for a kept room,
  **Sidebar section** (with "Outside sections", `shownSection`).
- **Prompt fields** of Agent, For each, Room and Chat steps get the routine editor's `/` menu (no `/btw`; in a room the
  members' commands grouped), saving `command` while the prompt starts with its name.
- **Trigger inspector:** beside the spend cap, **At the usage limit** and, for a schedule, **If a run was missed**, with
  the routine PolicyCard's labels; for a webhook, **Condition** when Jev's webhook feature is on (the routine editor's
  field and wording).
- **Canvas node:** a Chat step shows the chat's title; a Room step from agents shows its members' display names.
- **Run view and Audit log:** a Chat step's visit shows Input, Output and Open chat; a skipped run's end line reads its
  error (limit, missed, condition), and a condition skip shows Jev's verdict as the routine's Recent runs do.

## Zumi Bot

The workflow authoring format (`authoring.ts`) takes and returns:

- `{kind: 'chat', handle, chat, prompt, session?}`, `chat` a chat id or an app link to one (`chatIdFrom`);
- on a room step either `room` or `members` + `role` + `cwd` (a missing `cwd` defaults as a routine's new room does);
- `keep` and `title` on agent and room steps (`section` is never set by Zumi Bot; an edit keeps the stored one, as
  routines do);
- `limitPolicy` and `missedPolicy` on the workflow, `condition` on a webhook trigger.

There is no `command` key, as for routines: an edit keeps the editor's pick while the prompt still starts with its
name. `workflow_get` returns the new keys; an edit that leaves one out keeps the stored value (`workflowKept`). The
"Routines and workflows" prompt section gains two sentences: a Chat step posts into a chat the user names, and Keep is
for a chat the user wants to read afterward. The authoring checks refuse a chat that `problemsOf` would refuse, with
the same sentences.

## Elsewhere

- **Saved history:** `workflowDef` carries `limitPolicy`, `missedPolicy` and the trigger's `condition` only when set,
  so older versions still compare equal; `workflowChanges` adds "Run settings changed" when a policy differs (a step's
  new keys already read as "Step … changed", a condition as "Trigger changed").
- **Agent rename:** Room step `members` and every step's `command.agent` move with the agent, in the workflow, its run
  snapshots and its history (`renameWorkflowDef`).
- **Chat deleted:** a Chat step naming it becomes a problem in the editor; a run reaching it fails the visit
  `Chat not found`.
- **Duplicate** copies the new keys. **Sync:** nothing new (all keys live in `workflows.json`; chat ids are stable
  across machines once chats sync).
- **Spend caps:** the hold and Continue rules are unchanged; the Chat step's chat and the new room's members are
  judged by the agent-day gate.
- **Inbox:** a card in a Chat step's chat shows as that chat's card (it has no workflow link), which is right: the user
  answers it in their own chat.
- **CLAUDE.md:** the Workflows section gains the Chat step, Room from agents, Keep, commands in steps and the three
  settings; the `e2e:workflows` entry names the new cases.

## Tests

- **shared:** `parseStep` for each new key and its drops; `problemsOf` for each new problem; ports of `chat`; the
  history's `sameDef` for a workflow saved before this change.
- **backend (unit):** the Chat step in a single chat and in a room (output, fresh start, paused chat held, Stop with
  the message still queued, cost counted, a deleted chat); Room from agents (made, rules copied, retry reuses it);
  keep (not archived, `replied` sent, section placed, title); commands (leading only, a filled value never one, stale
  pick, step model wins); limit skip (run `skipped`, other visits stopped, no failure push); missed skip; Jev condition
  (met false skipped with its check, null runs, sample run not checked); Zumi Bot authoring round trips; rename.
- **e2e:** extend `e2e:workflows` (fake workflow claude, no quota): a Chat step into an existing chat with Start fresh
  (`FAKE_INVOCATIONS_OUT` shows no `--resume`) and its `wf-from` line; a kept Agent step's chat left in the sidebar; a
  Room step from two agents; a `/command` step whose stdin shows the filled prompt; a limit skip driven by a rejected
  `rate_limit_event`.

## Left to the builder

- Names of helpers and test ids, and where the shared `startFresh` lives in `core/chat/`.
- Whether the Chat step's picker reuses the Room step's picker component with a wider filter or gets its own.
- The exact help text under each new control, kept to one line and matching the routine editor's where a setting
  matches.

## Phase 2 mapping (what this phase must make possible)

| Routine | Workflow after Phase 1 |
|---|---|
| `trigger` schedule / manual | same trigger |
| `trigger` webhook + `condition` | webhook trigger, `filters: []`, same `condition` |
| `target: new-chat {agent, cwd, title}` | Agent step `{agent, cwd, keep: true, title}` |
| `target: new-group {members, role, cwd, title, section}` | Room step `{members, role, cwd, keep: true, title, section}` |
| `target: chat {chatId}` + `sessionPolicy` | Chat step `{chat, session}` |
| `prompt` + `command` | the step's `prompt` + `command` (`{{body.x}}` becomes `{{trigger.body.x}}`) |
| `limitPolicy`, `missedPolicy`, `spendCap` | the workflow's own |

Two known differences Phase 2 must decide on: a routine fills `{{body.x}}` raw while a workflow wraps it in an
`<input>` block for the model (safer, slightly different text), and a routine's default run title is
`<routine> · <date>` while a step's is `<workflow> · <step> · <date>`.
