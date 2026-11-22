# Workflow Room Step Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workflow step kind `room` that posts its prompt into a fresh copy of a template group room, follows the room until it goes quiet, carries per-step approval rules, and waits for the user's post when the room stops at its turn limit.

**Architecture:** The Agent step's slot machinery (`WorkflowAgentSteps`) already follows any chat id plus message id; the Room step reuses it with a second target type whose chat comes from a new room copier (`workflowRooms.ts`, built on `cloneRoom`). Approval rules live on the step, are copied onto the room copy's `ChatMeta.workflowRules`, and are checked by `ChatService`'s permission decision as a third source after "Allow for this chat" and agent rules. A capped room turn becomes a new `turnOutcome` kind that holds the slot open until the user posts.

**Tech Stack:** TypeScript, Node 22, React 19, vitest (projects shared, frontend, backend), playwright-core e2e with the fake claude scripts.

**Spec:** `docs/superpowers/specs/2026-11-12-workflow-room-step-design.md`

## Global Constraints

- **No git commits.** The user's rule: never commit unless told. Tasks end with tests and typecheck, never `git commit`.
- Worktree setup before the first typecheck (from the repo root of this worktree): `mkdir -p node_modules/@zumibot && ln -s ../../zumi-bot-server/{backend,frontend,shared} node_modules/@zumibot/`, then link `zumi-bot-server/frontend/node_modules` and `zumi-bot-server/backend/node_modules` to the main checkout's (`/home/mhdaljuboori/Developments/AI/ZumiBot/zumi-bot-server/...`). Skip what already exists.
- Every task ends green: `npm run typecheck` and the task's vitest files pass. The frontend's `Record<Exclude<StepKind,'trigger'>, …>` maps make a new kind a compile error until each is filled, so Task 1 fills them.
- Fixed texts (copy exactly): `'Room'` (step label), `'Pick a room'`, `'Write a prompt'`, `'Room not found'`, `'This chat is not a room'`, `'Room hit its turn limit · post in the room to continue'`, `'Allow for this step'`, `'Allowed by the workflow'`, `'Allowed for this workflow step'`, inspector note `'Each run starts a fresh copy of this room: same members, role and folder, no history.'`
- Caps: `STEP_RULES_MAX = 100`, `STEP_RULE_TOOL_MAX = 200`, `STEP_RULE_COMMAND_MAX = 4_000`. The prompt follows the Agent step: parsed up to `SAVED_TEXT_MAX`, `problemsOf` flags over `PROMPT_MAX` (20 000). (The spec's "20 000 at parse" is wrong; this is the codebase's rule.) A room id is parsed with the existing `id()` helper (`ID_RE`, 64 characters; chat ids are UUIDs).
- A step rule never allows `AskUserQuestion` (`QUESTION_TOOL`), `ExitPlanMode` (`PLAN_TOOL`) or a `confirmOnly` tool. Zumi Bot never sees or sets `rules`.
- Never add `--dangerously-skip-permissions`, `bypassPermissions` or anything that widens a rule beyond what `agentAllowKey` matches.
- Comments short, saying *why*, as the codebase does.
- Run tests from the worktree root: `npx vitest run <path>`; typecheck: `npm run typecheck`.

## Review Focus

1. **Template room deleted, or archived, after the workflow was saved.** A deleted template fails the visit "Room not found" and shows red in the inspector. An archived template still works and stays listed. Tests: Task 6 (`ROOM_NOT_FOUND`), Task 10 (`roomOptions` keeps an archived current room, `roomStepNote`).
2. **The user posts twice into a capped copy before it goes quiet.** The step follows the latest user message and ends with that turn's reply. Test: Task 7 case "two posts".
3. **An editor tab has unsaved edits while a card's "Allow for this step" saves a rule.** The tab's next Save keeps the rule, and a rule the user removed in the draft does not come back. Test: Task 11 `mergeRuleAdditions`.
4. **The webhook body holds `@everyone` or a member's handle.** It routes nobody; only mentions typed in the step's prompt route. Test: Task 3.
5. **The server restarts while a copy is capped, or mid-turn with rules in force.** The visit stays waiting, and the rules still apply after the restart because they are read from `ChatMeta.workflowRules`. Tests: Task 5 ("rules after restart"), Task 7 (recover cases).

---

### Task 1: Shared model: the `room` kind, step rules, new statuses

**Files:**
- Modify: `zumi-bot-server/shared/src/workflows.ts` (StepKind :3, Step union :24-38, FAILING_KINDS :176, Visit)
- Create: `zumi-bot-server/shared/src/stepRules.ts`
- Modify: `zumi-bot-server/shared/src/workflowInput.ts` (KINDS :29, parseStep switch :63-134)
- Modify: `zumi-bot-server/shared/src/workflowDefaults.ts:4-17`, `zumi-bot-server/shared/src/workflowGraph.ts` (textFields :50-65, problemsOf :84-133)
- Modify: `zumi-bot-server/shared/src/types.ts` (ChatMeta :124-155, ApprovalStatus :176-188, ApprovalDecision :193)
- Modify (compile only): `frontend/src/state/workflowCanvas.ts` (STEP_LABELS :38-41, stepSummary :263-277), `frontend/src/components/WorkflowCanvas.tsx` (KIND_HINTS :106-117), `frontend/src/components/WorkflowIcons.tsx` (StepIcon), `frontend/src/state/approvals.ts` (LINES), `frontend/src/state/inbox.ts` (DECISION :121-126)
- Test: `zumi-bot-server/shared/tests/workflowNewSteps.test.ts`, `workflowGraph.test.ts`, `workflowDefaults.test.ts`

**Interfaces:**
- Produces:
  - `StepKind` gains `'room'`. The Step variant is `(StepBase & Fails & { kind: 'room'; room: string; prompt: string; rules?: StepRule[] })`.
  - `export interface StepRule { tool: string; command?: string; unsandboxed?: true; agent?: string }`, in `workflows.ts`.
  - `STEP_RULES_MAX`, `STEP_RULE_TOOL_MAX` and `STEP_RULE_COMMAND_MAX` go in `workflows.ts`.
  - `FAILING_KINDS` includes `'room'`.
  - `Visit.capped?: true`.
  - `stepRules.ts` exports:
    - `stepRuleRefused(tool: string): boolean`: true for `QUESTION_TOOL`, `PLAN_TOOL` and `confirmOnly(tool)`.
    - `sameStepRule(a: StepRule, b: StepRule): boolean`.
    - `withStepRule(rules: readonly StepRule[] | undefined, r: StepRule): StepRule[]`: appends unless `sameStepRule`.
  - `ChatMeta.workflowRules?: StepRule[]`.
  - `ApprovalStatus` gains `'auto-allowed-workflow' | 'allowed-step'`; `ApprovalDecision` gains `'allow-step'`.

- [ ] **Step 1: Write failing tests**
  - `workflowNewSteps.test.ts` → `describe('room step')`:
    - `parseStep` keeps `{kind:'room', room:<uuid>, prompt:'{{input}}', rules:[{tool:'Bash', command:'ls', agent:'a'}, {tool:'Edit'}]}` unchanged.
    - A room id `'bad id!'` throws `'Invalid workflow'`.
    - A missing or empty `room` parses as `''`.
    - These rules each throw `'Invalid workflow'`:
      - `{tool:'Bash'}` (no command)
      - `{tool:'Edit', command:'x'}`
      - `{tool:'Edit', unsandboxed:true}`
      - `{tool:'AskUserQuestion'}`
      - `{tool:'ExitPlanMode'}`
      - `{tool: CONFIRM_ONLY_TOOLS[0]}`
      - a 201-character tool name
      - a command of 4 001 characters
    - Two identical rules collapse to one.
    - 101 distinct rules throw.
    - `rules: []` is left out of the parsed step.
    - `onFailure:'branch'` is kept and `stepPorts` gives `['out','error']`.
  - `workflowDefaults.test.ts`: `stepDefaults('room')` equals `{room:'', prompt:'{{input}}'}`.
  - `workflowGraph.test.ts`:
    - A room step with `room:''` gives the problem `'Pick a room'`.
    - With `prompt:'  '` it gives `'Write a prompt'`.
    - A prompt naming `{{steps.nope.output}}` gives `No step has the handle "nope"`.
    - A prompt of 20 001 characters gives `Prompt is over 20 000 characters`. Copy the label format from the existing Agent case.
  - `stepRules.test.ts` (new):
    - `withStepRule` does not duplicate.
    - `sameStepRule` tells `{tool:'Bash',command:'ls'}` from `{tool:'Bash',command:'ls',unsandboxed:true}` and from `{…, agent:'a'}`.

- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/shared/tests/workflowNewSteps.test.ts zumi-bot-server/shared/tests/workflowGraph.test.ts zumi-bot-server/shared/tests/workflowDefaults.test.ts zumi-bot-server/shared/tests/stepRules.test.ts`
  - Expected: FAIL, with `room` an unknown kind.

- [ ] **Step 3: Implement**
  - `parseStep` `case 'room'`:
    - `room: x.room === undefined || x.room === '' ? '' : id(x.room)`
    - `prompt: text(x.prompt, SAVED_TEXT_MAX)`
    - `rules` through a local `parseRules(v)`. It uses `list`, `obj` and `text`, and takes each key separately:
      - `tool`: 1..200 characters, and not `stepRuleRefused`.
      - `command`: required for `Bash` (1..4 000), and refused for any other tool.
      - `unsandboxed`: Bash only, and only the value `true`.
      - `agent`: optional, `NAME_MAX`.
      - It drops duplicates and fails past `STEP_RULES_MAX`.
    - Spread `rules` only when non-empty.
  - `textFields` `case 'room'`: the prompt, labelled and capped like the Agent step's.
  - `problemsOf`: `'Pick a room'` when `room === ''`; `'Write a prompt'` as for Agent.
  - Frontend compile entries:
    - `STEP_LABELS`: `room: 'Room'`, placed right after `agent` (key order is the Add step menu order).
    - `KIND_HINTS.room`: `'Posts its prompt into a fresh copy of a room'`.
    - `stepSummary` `case 'room'`: `'Room'`. Task 10 replaces it.
    - `StepIcon`: a "users" glyph. Copy the paths from `MenuIcon`'s `users`.
    - `LINES['auto-allowed-workflow']`: `'Allowed by the workflow'`.
    - `LINES['allowed-step']`: `'Allowed for this workflow step'`.
    - `DECISION['allow-step']`: `'Allowed for this step'`.

- [ ] **Step 4: Run** the Step 2 command, then `npm run typecheck`
  - Expected: PASS and no type errors.

### Task 2: `turnOutcome` reads a turn-limit stop as `capped`

**Files:**
- Modify: `zumi-bot-server/shared/src/turnReply.ts` (TurnKind :3, kind order :31-35)
- Test: `zumi-bot-server/shared/tests/turnReply.test.ts`

**Interfaces:**
- Produces: `TurnKind` gains `'capped'`. The turn holds a notice of kind `'paused'`: the hop cap's notice, never `'userPaused'`.
- Order: error, then capped, then paused, then stopped, then interrupted, then ok.

- [ ] **Step 1: Failing tests:**
  - A turn of `[assistant 'half', notice 'paused']` gives `kind: 'capped'` and `reply: 'half'`.
  - `[error, notice 'paused']` gives `'error'`.
  - `[notice 'userPaused']` still gives `'paused'`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/shared/tests/turnReply.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement** the new kind. Then check every switch on `TurnKind`: `workflowAgentSteps.ts` `endOf` :66 and `chatService.ts` `runAsked` :823. A single chat never gets a `'paused'` notice, so `endOf` maps `capped` like its default (a failure), and Task 7 handles it before `endOf` is reached.
- [ ] **Step 4: Run** the tests and `npm run typecheck`
  - Expected: PASS.

### Task 3: Material in a room never routes, and the moderator knows it is material

**Files:**
- Modify: `zumi-bot-server/shared/src/workflowTemplate.ts` (next to `inputBlock` :21)
- Modify: `zumi-bot-server/backend/src/core/chat/groupService.ts` (`post` :404, `rerunPost` :467, `route` :937-959)
- Modify: `zumi-bot-server/backend/src/core/chat/moderator.ts` (`ModeratorInput` :14, `moderatorPrompt` :49)
- Test: `zumi-bot-server/shared/tests/workflowTemplate.test.ts`, `zumi-bot-server/backend/tests/core/groupService.test.ts`, the moderator prompt test file (`backend/tests/core/moderator.test.ts`, created if missing)

**Interfaces:**
- Produces:
  - `export function maskInputBlocks(text: string): string`. It removes every block `inputBlock` writes (`<input from="…">\n…\n</input>`; the escaping in `escapeMaterial` means a block's body can't hold `</input>`) and leaves the rest of the text as it is.
  - `ModeratorInput.material?: true`.

- [ ] **Step 1: Failing tests**
  - `maskInputBlocks('@a go\n\n<input from="trigger">\nping @b @everyone\n</input>')` contains `'@a go'`, and contains neither `'@b'` nor `'@everyone'`.
  - groupService: a room whose meta has `workflow: {workflowId:'w', runId:'r', stepId:'s', name:'WF'}` and members a and b gets that same text posted. Use the moderator stub that answers nobody.
    - Only a runs.
    - The `moderate` input it captured has `material: true` and `everyone: false`.
    - The same text in a room without `workflow` still routes b, as today.
  - `moderatorPrompt({...base, material: true})` contains `MATERIAL_RULE`; without `material` it doesn't.
- [ ] **Step 2: Run** the three files.
  - Expected: FAIL.
- [ ] **Step 3: Implement**
  - In a workflow room (`meta.workflow` set), `route()` reads `findMentions` and `mentionsEveryone` of a user entry from `maskInputBlocks(entry.text)`. `post()` and `rerunPost()` read their mention notices the same way.
  - `route()` passes `material: true` in the moderator input.
  - `moderatorPrompt` adds `MATERIAL_RULE` as its own line right before `'Thread (latest last):'` when `material` is set.
- [ ] **Step 4: Run** the tests and `npm run typecheck`
  - Expected: PASS.

### Task 4: Workflow room members read the workflow paragraph and end silently

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/groupService.ts` (runTurn spec :794-824)
- Test: `zumi-bot-server/backend/tests/core/groupService.test.ts`

**Interfaces:**
- Consumes: `workflowSystem(name)` from `backend/src/core/workflows/workflowPrompt.ts`; `TurnSpec.workflow?: true` (`chatService.ts:309-344`).

- [ ] **Step 1: Failing tests:** in a room whose meta has `workflow` with name `'WF'`:
  - Each member's spec `systemPrompt` starts with `workflowSystem('WF')` and still contains the room briefing.
  - `spec.workflow === true`.
  - ChatService's `onTurnEnd` event for a member turn carries `workflow: true`.
  - A room without `workflow` keeps `systemPrompt === buildBriefing(...)` byte for byte.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/groupService.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement**
  - Join `workflowSystem(meta.workflow.name)` and the briefing exactly as the room side base joins `firstPart` and the briefing in `app.ts` (~:615-640). This keeps a `/btw` side run's prompt-cache prefix equal to the main turn's.
  - Set `workflow: true` only when `meta.workflow` is set.
- [ ] **Step 4: Run** the tests and `npm run typecheck`
  - Expected: PASS.

### Task 5: Step rules in `ChatService`'s permission decision and the `allow-step` answer

**Files:**
- Create: `zumi-bot-server/backend/src/core/workflows/stepRules.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/controlProtocol.ts` (`parseDecision` :77)
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (deps :117-121, `allowed` :364, `answer` :647 / slot.answer :1380-1411, decision :1651-1678, chat forget/remove)
- Modify: `zumi-bot-server/backend/src/core/chat/groupService.ts` (runTurn: note the rules before `agentTurn` :826)
- Test: `zumi-bot-server/backend/tests/core/stepRules.test.ts` (new), `zumi-bot-server/backend/tests/core/groupService.test.ts`

**Interfaces:**
- Consumes: `StepRule`, `stepRuleRefused`, `withStepRule` (Task 1); `agentAllowKey` (`controlProtocol.ts:63`).
- Produces, in `stepRules.ts`:
  - `stepRuleKey(r: StepRule): string`. It is `agentAllowKey(r.tool, r.tool === 'Bash' ? { command: r.command, ...(r.unsandboxed ? { dangerouslyDisableSandbox: true } : {}) } : {})`, so a rule matches exactly what an agent rule would.
  - `stepRulesAllow(rules: readonly StepRule[], agent: string, toolName: string, input: unknown): boolean`. It is false whenever `stepRuleRefused(toolName)`.
  - `stepRuleOf(toolName: string, input: unknown, agent: string): StepRule`. A Bash call gives `command`, plus `unsandboxed` when `input.dangerouslyDisableSandbox === true`.
- Produces, in `ChatService`:
  - `noteWorkflowRules(chatId: string, rules: readonly StepRule[]): void`.
  - The dep `onStepRule?(chatId: string, rule: StepRule): void`.
  - Card status `'auto-allowed-workflow'`.
  - The decision `'allow-step'`, which gives the status `'allowed-step'`.

- [ ] **Step 1: Failing tests**
  - `stepRules.test.ts`:
    - `{tool:'Edit'}` allows any Edit by any member.
    - `{tool:'Edit', agent:'a'}` allows a's Edit and not b's.
    - `{tool:'Bash', command:'ls'}` allows `{command:'ls'}`. It refuses `{command:'ls -la'}` and `{command:'ls', dangerouslyDisableSandbox:true}`.
    - `{tool:'Bash', command:'ls', unsandboxed:true}` allows only the unsandboxed call.
    - A rule list holding `{tool:'AskUserQuestion'}`, written past the parser, still never allows it.
    - `stepRuleOf('Bash', {command:'ls', dangerouslyDisableSandbox:true}, 'a')` gives `{tool:'Bash', command:'ls', unsandboxed:true, agent:'a'}`.
    - `stepRuleOf('mcp__w__x', {...}, 'a')` gives `{tool:'mcp__w__x', agent:'a'}`.
  - `groupService.test.ts` uses a workflow room (members a and b) with `workflowRules:[{tool:'Bash', command:'echo hi', agent:'a'}]`:
    - a's `can_use_tool` for `echo hi` is placed `'auto-allowed-workflow'` with no pending card.
    - b's same call is `'pending'`.
    - Answering b's card `'allow-step'`:
      - gives status `'allowed-step'`;
      - calls `onStepRule('<chat>', {tool:'Bash', command:'echo hi', agent:'b'})` once;
      - makes b's next identical call in the same room auto-allowed.
    - `'allow-step'` on an `AskUserQuestion`, or in a room without `workflow`, acts as allow-once and calls no `onStepRule`.
  - "Rules after restart": a fresh ChatService on the same store sees the meta's `workflowRules` at the next member turn.
- [ ] **Step 2: Run** both files.
  - Expected: FAIL.
- [ ] **Step 3: Implement**
  - `parseDecision` accepts `'allow-step'`.
  - ChatService keeps `private workflowRules = new Map<string, StepRule[]>()`, keyed by chat id and dropped where the chat's other per-chat memory is dropped.
  - The decision's third branch comes after the agent-rule branch. It checks `!askEveryTime && stepRulesAllow(this.workflowRules.get(chatId) ?? [], ruleAgent(), e.toolName, shownInput)`.
  - `allow-step` acts as allow-once unless:
    - the map has this chat, and
    - the tool is not `askEveryTime`.
  - Otherwise `allow-step`:
    - adds `stepRuleOf(tool, shown ?? input, ruleAgent())` to the map with `withStepRule`;
    - calls `onStepRule` inside a try/catch that logs only the error code.
  - GroupService `runTurn` calls `this.d.chats.noteWorkflowRules(chatId, meta.workflowRules ?? [])` only when `meta.workflow` is set. Widen its `chats` Pick.
  - `noteWorkflowRules` merges into what the map holds (`withStepRule` for each rule) and never replaces it. The saver writes the meta asynchronously, so a member turn that reads the meta before that write must not drop a rule the user just allowed. Test: answer `allow-step`, start a member turn with the old meta, and the rule still auto-allows.
- [ ] **Step 4: Run** the tests and `npm run typecheck`
  - Expected: PASS.

### Task 6: The room copier

**Files:**
- Create: `zumi-bot-server/backend/src/core/workflows/workflowRooms.ts`
- Modify: `zumi-bot-server/backend/src/core/store/sidebarStore.ts` (add `sectionOf`)
- Test: `zumi-bot-server/backend/tests/core/workflowRooms.test.ts` (new; follow `roomClone.test.ts`'s store setup)

**Interfaces:**
- Consumes: `cloneRoom(d: CloneDeps, chatId, title, handoff: null)` (`roomClone.ts:13`); `refuseZumiBot` and `refuseCodexMembers` (`groupMembers.ts:19,24`); `groupKey` (`shared/src/sidebarLayout.ts`).
- Produces:
  - `export interface RoomTarget { slotId: string; room: string; rules: StepRule[]; title: string; earlierChat?: string; link: WorkflowLink }`
  - `export const ROOM_NOT_FOUND = 'Room not found'` and `export const NOT_A_ROOM = 'This chat is not a room'`
  - `export function roomProblem(template: ChatMeta | null, agents: AgentSummary[], zumiBot: string): string | null`. It gives `ROOM_NOT_FOUND`, `NOT_A_ROOM`, then the `agentProblem` texts for the first bad member.
  - `export interface RoomCopyDeps { store: Pick<ChatStore,'get'|'createGroup'|'update'|'remove'>; allowed: Pick<ChatService,'copyAllowed'>; agents(): Promise<AgentSummary[]>; zumiBot: string; caps?: EngineCapsFn; sectionOf(chatId: string): Promise<string | null>; placeRoom?(chatId: string, sectionId: string): Promise<void>; now(): number }`. Take `EngineCapsFn` from the signature `refuseCodexMembers` uses.
  - `export async function copyRoom(d: RoomCopyDeps, t: RoomTarget): Promise<{ chatId: string } | { error: string }>`
  - `SidebarStore.sectionOf(key: string): Promise<string | null>`

- [ ] **Step 1: Failing tests:**
  - A two-member template (role `'R'`, cwd `/tmp/x`) copies to a new room with:
    - members in the same order, role `'R'` and cwd `/tmp/x`;
    - title `t.title`;
    - `workflow` equal to `t.link`;
    - `workflowRules` equal to `t.rules` (left out when `[]`).
  - The template's meta and items are unchanged.
  - `copyAllowed` is called with the template's and the copy's member scopes.
  - A template in section `S` calls `placeRoom(copyId, 'S')`. One in no section doesn't call it. A `placeRoom` that throws still returns `{chatId}`.
  - These each give `{error}`:
    - a missing template: `'Room not found'`
    - a single chat: `'This chat is not a room'`
    - a member with no agent file: `'Agent "x" not found'`
    - a broken member: `'Agent "x" has an error'`
    - a `zumi-bot` member: `refuseZumiBot`'s text
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/workflowRooms.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement**
  - Refusals thrown by `refuseZumiBot`/`refuseCodexMembers` become `{error: err.message}`.
  - Any other failure throws; the caller turns it into `START_FAILED`.
  - Write the `workflow` and `workflowRules` patch right after `cloneRoom`.
  - Log the placement failure as the routine runner does (`routineRunner.ts:336-340`).
- [ ] **Step 4: Run** the tests and `npm run typecheck`
  - Expected: PASS.

### Task 7: The runner and slots run Room steps, including the turn-limit wait

**Files:**
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowAgentSteps.ts` (Slot :26, `start`, `chatFor` :230, `check` :258, `settle` :296, `recover`)
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowRunner.ts` (`WorkflowRunnerDeps` :26-61, `prepare` :653-657, `begin` :710-728, a new `roomTarget` beside `agentTarget` :895, `resume` :1199-1212, `halt` :1166)
- Test: `zumi-bot-server/backend/tests/core/workflowRunner.test.ts` (new `describe('room steps')`; `makeRunner` gets a default fake `rooms`)

**Interfaces:**
- Consumes: `RoomTarget`, `copyRoom`'s result shape (Task 6); `TurnKind 'capped'` (Task 2).
- Produces:
  - `WorkflowRunnerDeps.rooms: { copy(t: RoomTarget): Promise<{ chatId: string } | { error: string }> }`.
  - `WorkflowAgentSteps.start(r, t: AgentTarget | RoomTarget, prompt)`, told apart by `'room' in t`.
  - `Slot` adds `'capped'`.

- [ ] **Step 1: Failing tests** (`describe('room steps')`, with `playTurn`, `said` and `notice` from the file):
  - "starts a copy and ends done":
    - `rooms.copy` is called with `{room:'tpl', rules:[...], title:'<wf> · <step> · <date>', link:{workflowId, runId, stepId, name}}`.
    - The filled prompt is submitted to the returned chat as `'routine'`.
    - A turn `[said('a','x'), said('b','final')]` ends the visit done with output `'final'`.
    - The copy is archived.
  - "copy error": `{error:'Room not found'}` fails the visit with that text. With `onFailure:'branch'` and an error edge, the run follows it.
  - "capped":
    - A turn `[said('a','half'), notice('paused')]` leaves the visit `waiting` with `capped: true`, the run `waiting`, no output, and the copy not archived.
    - The user then posts in the copy and the turn ends `[said('b','done')]`. The visit ends done with output `'done'`, `resumes: 1` and `capped` cleared.
  - "two posts": two user messages arrive while capped. When the room goes quiet the visit follows the second message's turn.
  - "capped again": the post's turn ends capped too, so the visit waits again (`capped: true`, `resumes: 1`).
  - "retry reuses the copy": a failed visit's Retry sends into the same chat id, and `rooms.copy` is called once in total.
  - "recover":
    - A capped visit whose turn is still the last one stays `waiting` and is not written.
    - A capped visit whose copy has a finished later user turn ends done with that reply.
    - An open visit with no `chatId` fails `'Interrupted by a restart'`.
  - "stop": Stop on the run calls `stopChat(<copy id>)`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/workflowRunner.test.ts -t "room steps"`
  - Expected: FAIL.
- [ ] **Step 3: Implement**
  - `prepare`: fill the room prompt with `modelPrompt`, as for Agent.
  - `roomTarget`: `earlierChat` uses `agentTarget`'s rule; `rules: step.rules ?? []`.
  - `start`:
    - For a room target, reuse an `earlierChat` that still exists.
    - Otherwise call `rooms.copy`. An `{error}` result goes to `finishSlot` failed with that error.
    - Skip `agentProblem` for a room target.
  - `settle`: `kind === 'capped'` patches `{status:'waiting', capped:true}` and stays followed.
  - `check`, for a capped slot whose turn is `over`:
    - Move the slot to the latest `user` item after its message: `messageId` set to it, `capped` cleared, `resumes + 1`, status `running`.
    - Follow that message, then check again against it: running means nothing yet, an ended turn settles.
    - This replaces the BY_HAND failure for capped slots only; paused and limit-wait slots keep BY_HAND.
  - `recover`: for `slot.capped`, follow it. When the turn is `over`, move as `check` does; otherwise write nothing.
  - Runner:
    - Add `'room'` wherever `kind === 'agent'` alone picks a chat-following visit: `resume`'s waiting skip (:1199), its `agentSteps.recover` call (:1211) and `halt`'s chat list (:1166).
- [ ] **Step 4: Run** the whole `workflowRunner.test.ts`, `workflowNewSteps.test.ts` and `npm run typecheck`
  - Expected: PASS, with no change in the existing agent and for-each cases.

### Task 8: Saving a rule from a card, and the app wiring

**Files:**
- Create: `zumi-bot-server/backend/src/core/workflows/stepRuleSave.ts`
- Modify: `zumi-bot-server/backend/src/app.ts`:
  - ChatService deps: `onStepRule`
  - WorkflowRunner deps (:751-783): `rooms`
  - the moderator's `onCost` (:538)
  - `copyRoom` deps (`sectionOf` from SidebarStore, `placeRoom` as at :729-732)
- Test: `zumi-bot-server/backend/tests/core/stepRuleSave.test.ts` (new)

**Interfaces:**
- Consumes: `WorkflowEditing.save(raw: WorkflowInput, {source:'editor'})` (`workflowEditing.ts`); `withStepRule`, `sameStepRule` (Task 1).
- Produces: `export function stepRuleSaver(d: { chats: Pick<ChatStore,'get'|'update'>; workflows: Pick<WorkflowStore,'get'>; save(input: WorkflowInput): Promise<unknown> }): (chatId: string, rule: StepRule) => Promise<void>`. Each chat has its own queue, so two answers close together both land.

- [ ] **Step 1: Failing tests:**
  - A copy whose `workflow` link names room step `s` of workflow `w`:
    - The rule is added to the copy's `workflowRules`.
    - `save` gets `w` with step `s`'s `rules` holding the rule; every other field equals the stored workflow, turned into a `WorkflowInput`.
  - The same rule again changes neither the copy nor the workflow, and doesn't call `save`.
  - If `w` is deleted, the copy is still updated, `save` is not called, and nothing throws.
  - If step `s` is gone, or is no longer `room`, `save` is not called.
  - A chat without `workflow` makes no writes at all.
  - Two rules saved at once both end up in the copy and in the step.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/stepRuleSave.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement** `stepRuleSaver`, then wire it in `app.ts`:
  - ChatService's `onStepRule` calls the saver with `void`. A failure logs only its code.
  - `WorkflowRunnerDeps.rooms.copy` is `copyRoom({ store: chats, allowed: chatService, agents: () => agents.list(), zumiBot: ZUMI_BOT_NAME, caps, sectionOf: id => sidebar.sectionOf(groupKey(id)), placeRoom, now: Date.now }, t)`. Reuse the routine runner's `placeRoom` body.
  - The moderator's `onCost` adds `workflowRunner.chatCost(chatId, c.totalUsd)` after `usage.recordModerator`.
- [ ] **Step 4: Run** the tests, `npm run typecheck` and `npx vitest run --project backend`
  - Expected: PASS.

### Task 9: Zumi Bot can write Room steps

**Files:**
- Modify: `zumi-bot-server/backend/src/core/automations/authoring.ts` (STEP_KINDS :112, FIELDS :153, `workflowFromAuthoring` :199-250, `workflowToAuthoring` :294-304)
- Modify: `zumi-bot-server/backend/src/core/automations/automationService.ts` (`workflowKept` :107, `workflowGet` :241, `workflowSave` :246)
- Modify: `zumi-bot-server/backend/src/core/agents/zumiBot.ts:248`
- Test: `zumi-bot-server/backend/tests/core/automationAuthoring.test.ts`, `automationService.test.ts`

**Interfaces:**
- Consumes: `chatIdFrom(text)` (`automations/chatTranscript.ts:15`).
- Produces: the authoring Room step is `{handle, name, kind:'room', room: string, prompt: string}`. `workflow_get` adds a read-only `roomTitle: string | null` and leaves out `rules`.

- [ ] **Step 1: Failing tests:**
  - authoring:
    - `room: '/chat/<uuid>'` and a full URL both save `room: <uuid>`.
    - The prompt defaults to `'{{input}}'`.
    - `workflowToAuthoring` never has `rules`.
    - An edit leaving out `room` keeps the stored one.
    - An edit always keeps the stored `rules`, even when the authoring step sends `rules`.
    - `roomTitle` sent back is dropped.
  - service:
    - A save naming an id that is no room is refused with `'Room not found'`.
    - `workflow_get` gives `roomTitle` as the room's title, or null once it is gone.
- [ ] **Step 2: Run** both files.
  - Expected: FAIL.
- [ ] **Step 3: Implement**
  - Add the room fields to the authoring tables.
  - Keep `room` and `rules` as `key` and `cwd` are kept (`authoring.ts:247-250`, `workflowKept`).
  - The service checks each room step with the chat store before saving, and adds `roomTitle` in `workflowGet`.
  - Add one guide line in `zumiBot.ts`: `Room: posts its prompt into a fresh copy of a room the user names by link (\`room\`: the link or its id). Ask for the room's link when the user names it only by title.`
- [ ] **Step 4: Run** the tests and `npm run typecheck`
  - Expected: PASS.

### Task 10: The editor: room picker, rules editor, node summary

**Files:**
- Create: `zumi-bot-server/frontend/src/state/workflowRoom.ts`
- Modify: `frontend/src/App.tsx` (pass `chats` at :2523), `components/WorkflowsMode.tsx` (props :24-35), `components/WorkflowEditor.tsx` (props :43-60, `StepInspector` :826, canvas data), `components/StepInspector.tsx` (body switch :224-453, a `room` case after `agent`), `state/workflowCanvas.ts` (`stepSummary`, `toFlow`)
- Test: `zumi-bot-server/frontend/tests/workflowRoom.test.ts` (new)

**Interfaces:**
- Consumes: `isGroup` (`shared/src/types.ts:170`), `isArchived` (`shared/src/archive.ts:9`), `isAsked` (`shared/src/agentAsk.ts:34`), `stepRuleRefused`, `withStepRule` (Task 1).
- Produces, in `workflowRoom.ts`:
  - `roomOptions(chats: ChatMeta[], current: string): ChatMeta[]`: group, not archived, not asked, no `workflow`, sorted by title. The current room is kept even when it is archived.
  - `roomStepNote(room: string, chats: ChatMeta[]): string | null`: `'Room not found'` when `room` is set and no group chat has that id.
  - `ruleText(r: StepRule): string`.
  - `ruleDraftError(d: { tool: string; command: string }): string | null`.
  - `roomTitleOf(room: string, chats: ChatMeta[]): string | null`.

- [ ] **Step 1: Failing tests:**
  - `roomOptions` leaves out single chats, archived rooms, A→B chats and workflow copies, but keeps the archived room passed as `current`.
  - `roomStepNote('', …)` is null; a missing id or a single chat's id gives `'Room not found'`.
  - `ruleText({tool:'Bash', command:'npm run build', agent:'a'})` is `'@a · Bash: npm run build'`.
  - `ruleText({tool:'Edit'})` is `'Every member · Edit'`.
  - `unsandboxed` appends `' (outside the sandbox)'`.
  - `ruleDraftError`:
    - `{tool:'', …}` gives `'Write a tool name'`.
    - `{tool:'Bash', command:''}` gives `'Write the exact command'`.
    - `{tool:'AskUserQuestion', …}` gives `'Questions, plans and deletes always ask'`.
    - A valid draft gives null.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/frontend/tests/workflowRoom.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement** the pure module and the UI:
  - Pass `chats` down from App through WorkflowsMode and WorkflowEditor to StepInspector.
  - Room inspector:
    - `<select data-testid="wf-room">` over `roomOptions`, each option labelled by its title.
    - The fixed inspector note.
    - `wf-room-missing` showing `roomStepNote`.
    - The prompt `TemplateField` (`testId="wf-prompt"`), as for Agent.
  - **Approval rules** section:
    - `wf-rule` rows showing `ruleText`, each with a `wf-rule-remove` button.
    - An add row:
      - `wf-rule-agent`: Every member plus the template's members;
      - `wf-rule-tool`;
      - `wf-rule-command`, shown only for Bash;
      - `wf-rule-unsandboxed`, shown only for Bash;
      - `wf-rule-add`;
      - the error line `wf-rule-error`.
    - Edits go through `set({rules}, 'rules')`.
  - Run step stays absent for `room`: it is not in `StepInspector.tsx:484`'s list, so make no change there.
  - `stepSummary`/`toFlow` take an optional `roomTitle(id): string | null`. A room node reads its title, else `'Pick a room'` or `'Room not found'`.
  - Member icons on the node are left out (builder's call; the spec's member icons are dropped to keep the canvas without agent data).
- [ ] **Step 4: Run** the tests, `npm run typecheck` and `npx vitest run --project frontend`
  - Expected: PASS.

### Task 11: Run view, room chat bar, "Allow for this step" card, editor merge

**Files:**
- Modify: `frontend/src/state/workflowRun.ts` (`visitPauseText` :55, its `Pick` takes `'capped'`), `components/ChatView.tsx` (room branch :415-466: `WorkflowChatBar` as at :476), `state/approvals.ts` (`approvalChoices` :10), `components/ApprovalCard.tsx`, `components/MessageList.tsx:154` and `components/InboxCard.tsx:124` (pass the chat so a card knows it is in a workflow room), `components/WorkflowEditor.tsx` (merge rule additions on `workflows:changed`)
- Modify: `frontend/src/state/workflowRoom.ts` (add `mergeRuleAdditions`)
- Test: `frontend/tests/workflowRun.test.ts`, `frontend/tests/approvals.test.ts`, `frontend/tests/workflowRoom.test.ts`

**Interfaces:**
- Produces:
  - `approvalChoices(toolName: string, o?: { step?: boolean }): { chat: boolean; agent: boolean; step: boolean }`, with `step = !!o?.step && !stepRuleRefused(toolName)`.
  - `stepChoiceFor(chat: ChatMeta | undefined): boolean`, which is `!!chat?.workflow && isGroup(chat)`.
  - `mergeRuleAdditions(draft: Step[], base: Step[], latest: Step[]): Step[]`. For each room step id in all three, the rules that `latest` has and `base` lacks are added to the draft's step with `withStepRule`. The draft is otherwise untouched.

- [ ] **Step 1: Failing tests:**
  - `visitPauseText({status:'waiting', capped:true})` is `'Room hit its turn limit · post in the room to continue'`.
  - `approvalChoices('Bash', {step:true}).step` is true; `approvalChoices('AskUserQuestion', {step:true}).step` and `approvalChoices('Bash').step` are false.
  - `stepChoiceFor` is true for a group chat with `workflow`, and false for a single workflow chat and for a plain room.
  - `mergeRuleAdditions`:
    - A rule added on the server reaches the draft.
    - A rule the draft removed, which was already in `base`, does not come back.
    - A step deleted in the draft is ignored.
    - A rule already in the draft is not duplicated.
- [ ] **Step 2: Run** the three test files.
  - Expected: FAIL.
- [ ] **Step 3: Implement:**
  - `ApprovalCard` takes `stepChoice: boolean` and shows `approval-allow-step` ("Allow for this step", with the same sub-line as the agent choice). It answers `'allow-step'`.
  - The `chat` reaches the card in MessageList (through the room tray's `AgentGroup` too) and InboxCard.
  - WorkflowChatBar renders in a room.
  - WorkflowEditor: when a `workflows:changed` list carries this workflow with a newer `updatedAt` while the draft is dirty, apply `mergeRuleAdditions` to the draft's steps and take the new saved workflow as the base. A clean draft reloads as it does today.
- [ ] **Step 4: Run** the tests, `npm run typecheck` and `npx vitest run --project frontend`
  - Expected: PASS.

### Task 12: End-to-end run and docs

**Files:**
- Create: `zumi-bot-server/e2e/workflowRoom.e2e.mjs`
- Modify: root `package.json` (script `"e2e:workflow-room": "npm run build && node zumi-bot-server/e2e/workflowRoom.e2e.mjs"`)
- Modify: `CLAUDE.md` (Workflows section: a **Room step** paragraph; the Commands section: the new e2e, which uses no quota)
- Modify: `docs/superpowers/specs/2026-11-12-workflow-room-step-design.md`. Change its status to built, and note the deviations:
  - the prompt cap is checked by `problemsOf`;
  - Run step is hidden, not disabled;
  - the Audit log shows nothing while a run is open;
  - the node has no member icons;
  - a card's rule names its member.

**Setup:**
- Use `start({mode:'vps', fake: 'backend/tests/fixtures/fake-clone-claude.mjs', ...})` from `harness.mjs`. Its moderator answers `{}`, and member turns run `fake-claude.mjs`.
- Give per-agent scripts through `FAKE_STDOUT_DIR` (`<dir>/<agent>.jsonl`).
- Agents `alpha` and `beta` are written to `agentsDir`.
- Make the template with `rpc('chats:createGroup', ['alpha','beta'], folder, 'Make cards')`.
- The workflow is a manual trigger, then a Room step with prompt `@alpha @beta {{input}}`, saved with `rpc('workflows:save', …)`.

- [ ] **Step 1: Write the suite** with these cases:
  1. "a run copies the room":
     - `rpc('workflows:run', id, 'card one')`; wait for an ended run.
     - The visit is done, and its output equals the last reply in the copy.
     - The copy is a room with `workflow.runId` set to the run, and is archived.
     - The template has no items.
  2. "allow for this step":
     - beta's script sends a `can_use_tool` for Bash `echo hi`, then `#WAIT_RESPONSE`.
     - The run goes `waiting`.
     - Open the copy in the page and click `approval-allow-step`.
     - The run ends done.
     - The saved workflow's step has `rules` equal to `[{tool:'Bash', command:'echo hi', agent:'beta'}]`.
  3. "the next run asks nothing":
     - Run again.
     - The copy's approval item for `echo hi` has status `auto-allowed-workflow`, and the run never shows `waiting`.
  4. "the room bar shows":
     - The copy opened in the page shows `WorkflowChatBar`. Use its existing test id.
- [ ] **Step 2: Run** `npm run e2e:workflow-room`
  - Expected: all four PASS.
  - The fake processes and the server are gone afterwards (the harness checks).
- [ ] **Step 3: Final check:** `npm test`, `npm run typecheck`, `npm run e2e:workflows`. Expected: all PASS. The existing workflows suite is unchanged by the new kind.
