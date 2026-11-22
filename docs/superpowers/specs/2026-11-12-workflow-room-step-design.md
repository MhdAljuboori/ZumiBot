# Workflow Room step

Date: 2026-11-12. Status: built (see Deviations at the end), agreed with the user in chat. Choices the user made are marked **(user)**; everything
else is the builder's call, marked **(call)**.

## Why

The user keeps a room ("Workiom 5 (Create card)": four members, a role, the `WebFrontend` folder) as a template. For
every new card they clone it by hand (Clone room › Start over) and paste the card's details into the copy. They want a
workflow to do that: the card's details come in (typed into a manual run, or from a webhook) and a step posts them into
a fresh copy of that room, which works on them as it does today. Workflows can only reach single agents now (Agent, For
each); routines can already post into a room, so most of the room machinery exists.

## Goals

- A new step kind, **Room** (`kind: 'room'`), beside Agent on the canvas.
- The step names an existing room, the **template**. Each run makes a **fresh copy** of it **(user)**: same members
  (same order), role and folder, no history, no handoff, what Clone room › Start over makes (`cloneRoom` with
  `handoff: null`; its `copyAllowed` still copies whatever "Allow for this chat" the template holds in memory, which is
  usually nothing after a restart, so nothing relies on it). The template is never changed.
- The step carries its own **approval rules** **(user)**, saved in the workflow, which every copy starts with (below).
- When the room stops at its **turn limit** (`GROUP_HOP_CAP`, 15), the step **waits for the user's post** in the copy
  and then follows it **(user)** (below).
- The step's **Prompt** (a template, like the Agent step's) is posted into the copy as its first message. The room then
  runs as any room does: the moderator picks who speaks, members @mention each other, cards wait for the user.
- The step ends when the room goes quiet after that message (nobody working, nobody queued), and hands on the room's
  **last reply** **(call)**.
- When the step ends **done**, the copy is **archived**, exactly like an Agent step's chat **(user)**. A failed one stays
  in the sidebar.

## Non-goals

- No "post into the same room every run" mode. The user chose a fresh copy per card **(user)**.
- No For each over a room.
- No **Run step** for a Room step in this version **(call)**: a room's send settles when the message is posted, not when
  the room goes quiet, so the test path would need its own wait. The button is disabled with the tooltip "Run the
  workflow to try a Room step". A manual run with a typed input does the same job.
- No handoff summary from the template (Clone room's "With summary"). A template room's role is what carries its
  standing instructions; its own `handoff`, if it has one, is not copied, as Clone room does **(call)**.
- No per-step model: rooms ignore command models.
- No new Zumi Bot list tool for rooms.
- No approval rules on Agent or For each steps in this version **(call)**; the same mechanism fits them later.

## Anti-goals

- The template room must never be written to by a run: no message, no session, no approval change.
- A webhook caller's text must reach the room's members only as material inside `<input>` blocks, never as raw
  instructions, exactly as for an Agent step. Every member turn in a workflow room gets the workflow paragraph with the
  material rule.
- A Room step must not pass while the room still works (an early "done" with a half reply, including a stop at the
  turn limit) or hang forever once it is quiet.
- Nothing but the user may add approval rules: never Zumi Bot, a webhook or an agent. A rule must never allow more
  than the matching "Allow always for this agent" rule would.

## The step (shared)

`(StepBase & Fails & { kind: 'room'; room: string; prompt: string; rules?: StepRule[] })` in `shared/src/workflows.ts`.

- `room`: the template room's chat id. `prompt`: template, default `{{input}}` (`stepDefaults`).
- One `out` port (`portsOf` default). It is a failing kind: add `'room'` to `FAILING_KINDS`, so On failure › Take the
  failure path works as for Agent.
- `parseStep` (`shared/src/workflowInput.ts`) rebuilds it key by key: `room` a non-empty id string (at most 100
  characters, the chat id shape), `prompt` a string within the 20 000-character prompt cap.
- `problemsOf`: an empty `room` is the problem "Pick a room"; an empty prompt "Write a prompt"; unknown handles in the
  prompt as for Agent. Whether the picked id is still a room is **not** a pure check (the shared graph check has no chat
  list): the editor shows it (below) and the server checks it when the step starts.
- The visit's input is filled into the prompt exactly as for an Agent step (`modelPrompt`: `<input from="…">` blocks,
  unnamed sources appended, `MATERIAL_RULE`), since room members are models.

## Running it (backend)

The Agent step's slot machinery (`WorkflowAgentSteps`) already follows any chat id plus message id through `chatIdle`,
`chatPush`, `chatCost`, `taskDropped`, `chatRemoved`, `chatResumed`, `recover`, usage-limit waits and Stop, and
`turnOutcome` already reads a room's turn (the items after the message up to the next user item; its `reply` is the last
assistant item, whichever member wrote it). Rooms already fire ChatService's `onIdle` when their whole pass ends
(`GroupService.loop` → `release`), and routines already settle room runs that way. So the Room step reuses that class;
only where the chat comes from differs **(call)**:

- `AgentTarget` gains a room variant (or a sibling `RoomTarget`): `{slotId, room, title, earlierChat?, link}`.
- `chatFor` for a room: an `earlierChat` that still exists is reused (a loop's revisit and a Retry go on in the same copy,
  which keeps the members' context), else the copy is made with `cloneRoom(…, handoff: null)` and then updated with the
  title and the `ChatMeta.workflow` link in one write, as `chatFor` does for an Agent step.
- Before cloning, the server checks the template: it exists and `isGroup`, its members are loadable agents, none is
  Zumi Bot (`refuseZumiBot`), and Codex members pass `refuseCodexMembers` with the current caps. Each failure ends the
  visit `failed` with a fixed sentence: "Room not found", "This chat is not a room", `Agent "<name>" not found`, `Agent
  "<name>" has an error`, and the existing refusal texts.
- The send is `TaskQueue.submit(chatId, prompt, [], undefined, messageId, undefined, undefined, 'routine')`, as for an
  Agent step (a paused room holds it). `TaskQueue.launch` drops `auto` for a room (`withTail`, and `GroupService.send`
  takes none); that is harmless because Zumi Bot, the only agent the write gate guards, can never be a room member, so
  this design does not rely on it.
- `cloneRoom` writes the title itself; the `workflow` link goes in the next write (two writes is fine, or extend
  `cloneRoom` with an optional patch).
- Turn outcomes map as for Agent: Stopped, Interrupted by a restart, Replaced by an edit or resend, Paused by you /
  Resumed, Continued by hand, Chat was deleted. A usage limit waits and sends `continueText(limits)`, which already names
  the stopped members (`@member continue`).
- Output: the turn's `reply`, cut to `OUTPUT_MAX` (50 000). A quiet room that wrote no reply ends done with an empty
  output, as an Agent step does.
- Done: `archivePatch` on the copy. Failed: left as it is.
- **Title**: `<workflow> · <step> · <date>`, the Agent step's rule.
- **Sidebar spot**: the copy is put first in the sidebar section that holds the template room, through the same
  server-side placement routines use (`SidebarStore.placeFirst`, broadcast `sidebar:changed`; a failed write is logged
  and the step goes on). A template outside any section leaves the copy outside them too **(call)**. Since a done copy is
  archived, this matters while it runs or after it fails.
- **Cost**: members' turns already reach `workflowRunner.chatCost` through `onRunCost`. The moderator's calls are
  recorded by `usage.recordModerator`; the room step's visit cost should add them too (`workflowRunner.chatCost(chatId,
  usd)` from the moderator's `onCost`), so the run's cost covers the whole room **(call)**. `chatCost` already counts
  only while the step's own turn runs.
- **Recover**: as for an Agent step (a queued message is followed, an ended turn settled, a turn the restart cut fails
  with Retry). A visit whose copy was never made (crash before `chatFor` finished) fails "Interrupted by a restart" and
  Retry makes a new copy. A visit held at the turn limit stays held without a write.

## The turn limit **(user)**

A room ends its pass by itself after `GROUP_HOP_CAP` (15) agent turns in a row: `hopPause` adds a `paused` notice
(the hop cap's kind, not the user's `userPaused`), drops the queue and the room goes idle. Today `turnOutcome` reads that
as `ok`, so it would end the step done with a half-finished reply. Instead:

- `turnOutcome` gains a kind for it (say `'capped'`: a `paused` notice in the turn, checked after errors and before the
  user's pause, stop and restart). Routines keep treating it as done (they map the new kind to their present behaviour),
  so nothing else changes.
- A Room step's slot whose turn ends `capped` stays **open**: `Visit.capped: true`, status `waiting` (the run needs the
  user, so the run is `waiting` too and the sidebar shows its waiting dot), no output, no archive. The run view and the
  Audit log say "Room hit its turn limit · post in the room to continue" (`visitPauseText`-style), and Open chat is the
  way there. No new push: a hop-cap pause sends none today, and the copy stays in the sidebar (unarchived) **(call)**.
- The user's next message in the copy (typed, Send now, or any send that adds a `user` item) is **followed**, not
  "Continued by hand": the slot moves to that message's id (`messageId`, `capped` cleared, `resumes + 1`) and ends when
  the room goes quiet again, with that turn's reply. A second cap waits again. An Edit or Resend of the step's own
  message still ends it "Replaced by an edit or resend". Stop on the run stops the copy and ends the visit as for Agent.
- To see the user's message, the slot machinery needs a hook when a user item is added to a followed chat. The Agent
  step learns of "Continued by hand" through the turn being `over` at its next settle; for a capped slot, a new user
  item after its message moves it instead. The builder picks the hook (TaskQueue's `onNewTurn`, which already sees every
  new turn, is the likely place).

## Approval rules **(user)**

The step's `rules` are standing "allow" decisions for the room's copies, saved in the workflow.

- **Shape** (`StepRule` in `shared/src/workflows.ts`): `{ tool: string; command?: string; unsandboxed?: true; agent?:
  string }`. `agent` absent means every member. A `Bash` rule needs `command` (one exact command, as
  `agentAllowKey` matches it; `unsandboxed` marks one allowed only with `dangerouslyDisableSandbox`, and a sandboxed rule
  never allows the unsandboxed call, nor the other way round). Any other tool's rule allows any call of that tool, as an
  agent rule does. At most 100 rules a step; `tool` is a tool name (at most 200 characters), `command` at most 4 000.
  `parseStep` rebuilds them key by key and drops duplicates.
- **Never allowed by a rule**: the question and plan tools and `confirmOnly` tools (routine or workflow deletes), the
  same `askEveryTime` rule chat memory and agent rules obey; the parser refuses such a rule and the card never offers it.
- **Where they apply**: in ChatService's permission decision, after "Allow for this chat" and the agent rules, a third
  check: the chat's workflow rules match `agentAllowKey(tool, input)` for that member. The card is placed with a new
  status, `auto-allowed-workflow` ("Allowed by the workflow"). The rules come from the run's `snapshot` (a run in flight
  never changes when the workflow is edited), handed to the copy when it is made: stored on the copy as
  `ChatMeta.workflowRules` (durable, survives a restart, synced with the chat) **(call)**, and read by the room's turns.
  They apply only in that copy; the template and other chats never see them.
- **Adding one from a card**: a pending card in a copy (a chat whose `ChatMeta.workflow` names a Room step) offers one
  more choice, **Allow for this step**, beside Allow once / for this chat / always for this agent (never on a card the
  rules may not allow). It allows the call, adds the rule to the copy's `workflowRules` (so the rest of this run asks no
  more) and to the step in the saved workflow, through `workflowEditing.save` (its history version's source `editor`,
  since the user pressed it). If the workflow is gone or the step was removed since, the call is still allowed once and
  the save is skipped silently. An editor tab open on that workflow with unsaved edits must not lose either change: the
  rule is merged into the saved workflow server-side, and the editor merges a `workflows:changed` rule addition into its
  draft (or the builder finds an equally safe way). A new RPC (say `chats:answer` with `scope: 'step'`) carries it.
- **Inspector**: under the Prompt, **Approval rules**: one row per rule ("@member · Bash: `npm run build`", "Every
  member · mcp__workiom__create_record") with Remove, and an Add row (member select with Every member, a tool field, a
  command field shown for Bash, an "outside the sandbox" tick for Bash). Removing a rule changes only future runs.
- **Zumi Bot** never sees or sets `rules`: `workflow_get` leaves them out and a save keeps the stored ones, as an HTTP
  step's vault `key` is kept.

## What room members read

`ChatService` gives a single workflow chat's turns `systemPrompt: workflowSystem(meta.workflow.name)` and `workflow:
true` (silent `replied`/`error` notifications). A room member's turn is built in `GroupService` (`buildBriefing` as its
`systemPrompt`). For a room whose meta carries `workflow`, every member turn must:

- start its appended system text with `workflowSystem(meta.workflow.name)`, then the room briefing (the name is fixed at
  creation, so the prefix never changes between turns and the cache holds);
- carry `workflow: true`, so its turn end is silent as an Agent step's is. Cards still notify as `waiting`, and the room
  counts as `waiting` for the run while a card waits, through the `approvals` push the slot machinery already reads.

**Mentions inside material (call).** The step's message is posted as the user's, and `findMentions`/`mentionsEveryone`
mask only code, so an `@member` or `@everyone` inside an `<input from="…">` block would route members as a user mention
(which the moderator cannot drop). In a workflow room the router masks the step message's `<input>` blocks before
reading mentions, so only `@mentions` the user typed into the step's prompt route; text inside the blocks is material.
The moderator, which reads the raw message, gets the material rule in its prompt for a workflow room.

**A member's plain-text question (call).** When a member asks the user something in plain text, the pass ends and the
room goes quiet; the step ends done and hands the question on, exactly as an Agent step does. A question card
(`AskUserQuestion`) keeps the step waiting instead.

The moderator reads the room as usual otherwise. The side-run base (`sideFirstPart` in `app.ts`) already keys on `meta.workflow`;
check that a room member's side run gets the same first part, so a `/btw` in the copy keeps the cache prefix.

## UI (frontend)

- **Add step menu / palette**: "Room" with the room icon, after Agent.
- **Node**: the room's title (or "Pick a room"), its members' icons as the sidebar row shows them.
- **Inspector** (`WorkflowEditor`'s step inspector): a **Room** picker listing live, non-archived rooms by title with
  their members and folder (A→B chats and workflow-made copies left out: a copy carries `ChatMeta.workflow`), then
  **Prompt** with the `{{` menu and Expand, then On failure. A picked room that is gone or no longer a room shows the
  red line "Room not found" under the picker; the server checks again at run time. A note under the picker: "Each run
  starts a fresh copy of this room: same members, role and folder, no history." Then **Approval rules** (see above).
- **Run step**: disabled for a Room step (see Non-goals).
- **Run view / VisitPanel**: as for Agent: status, Open chat (opens the copy, archived or not), Retry, the paused
  lines, the turn-limit line, cost. The Audit log treats it like an Agent entry (Input and Output).
- **Cards in a copy**: the extra **Allow for this step** choice (see Approval rules), also on the Inbox's card.
- **The copy's chat view**: `WorkflowChatBar` (link to the run) shows in a room as in a single chat; the workflow's
  messages get the sender line and `<input>` boxes (`WorkflowPrompt`), which are already chat-generic.

## Zumi Bot

- Authoring format: a `room` step takes `room` as a chat id or a room link (`/chat/<id>` or a full URL, read by the
  existing `chatIdFrom`) and `prompt`. `workflow_get` returns the id plus the room's title in a read-only `roomTitle`
  field, dropped again on save, so Zumi Bot can say which room it is.
- On save the server checks the id names an existing room, else refuses "Room not found" (a fixed sentence).
- `zumiBotContent`'s workflow guide gains one line: a Room step posts its prompt into a fresh copy of a room the user
  names by link; ask for the link when the user names a room by title only.
- On an edit, an existing Room step's `room` is kept when left out, as Agent steps keep their `cwd`, and its `rules`
  are always kept (Zumi Bot never sees or sets them).

## Elsewhere

- **Agent rename**: nothing to move in the step (it names a room, not agents); the template's own members follow the
  rename through the existing room rename.
- **Template deleted**: the next run's visit fails "Room not found"; the editor shows it red.
- **Duplicate, History, copy/paste, sync**: the step is plain data; nothing new. A pasted Room step keeps its `room`.
- **Saved history** `workflowChanges`: "Step “<name>” changed" as for other kinds.

## Tests

- Unit (backend): a Room step's visit clones the template (members, role, folder; template items and sessions
  untouched), stores the snapshot's rules on the copy, posts the filled prompt, stays running while a member works,
  ends done with the last reply once idle, archives the copy, records member and moderator cost; Retry and a loop
  revisit reuse the copy; template gone / not a room / broken member / Zumi Bot member each fail with their sentence;
  failure path taken with `onFailure: 'branch'`; recover after a restart. Turn limit: a capped turn holds the visit
  `waiting` with `capped`, the user's post moves it to that message and it ends done with that turn's reply; a capped
  visit survives a restart; routines still read a capped turn as done. Rules: a matching rule auto-allows with
  `auto-allowed-workflow`, a Bash rule matches its exact command only and never across the sandbox flag, question,
  plan and delete tools are never allowed by a rule, Allow for this step adds the rule to the copy and the saved step
  (and only allows once when the step is gone).
- Unit (shared): `parseStep` (rules included: shapes, caps, duplicates, refused tools), `problemsOf`, `stepDefaults`,
  `FAILING_KINDS` for `room`; `turnOutcome`'s `capped`; Zumi Bot authoring round trip keeps `rules` out of `get` and
  the stored ones on save.
- Unit (frontend `state/`): the room picker's list rule (live rooms only, no workflow copies, no A→B); the rule row text;
  the card's Allow for this step offer rule.
- e2e (`e2e:workflow-room`, fake claude and `fake-clone-claude.mjs` for the moderator, no quota): a Room step over a
  two-member room made by raw `/ws` RPCs; the copy appears, two members answer, the visit ends done with the last reply,
  the copy is archived with the workflow bar, the template room has no new items. A second run whose member's script
  asks a `can_use_tool` card: Allow for this step, then a third run asks no card for the same call
  (`auto-allowed-workflow`).

## Left to the builder

- Whether the Room step shares `WorkflowAgentSteps` through a widened target type or a thin wrapper class.
- Node and inspector styling within the existing workflow canvas look.
- Exact wording of the inspector note and the Add step entry's description.

## Deviations

What was built differs from the text above in five places:

- The prompt cap is checked by `problemsOf`, not by `parseStep`, so a long prompt saves and refuses Run.
- Run step is hidden for a Room step, not disabled with a tooltip.
- The Audit log shows nothing for a Room step's visit while the run is open, as for every step (it shows once the run
  ends).
- The node has no member icons: it shows the room's title only.
- A card's rule names its member: Allow for this step saves `agent` with the member that asked, so a rule never allows
  another member's call.
