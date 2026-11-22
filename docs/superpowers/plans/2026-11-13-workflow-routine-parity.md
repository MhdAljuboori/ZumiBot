# Workflow and Routine Parity (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Workflows learn everything a routine can do: a Chat step into an existing chat or room, a Room step built from agents, kept chats, `/commands` in step prompts, limit and missed-run skips, and a Jev condition on webhooks.

**Architecture:** Everything rides on today's workflow engine. The Chat step is one more slot kind of `WorkflowAgentSteps` (the code that already follows an Agent step's turn and a Room step's room), whose chat is given instead of made. Room from agents is a second source in `workflowRooms.ts`. Keep is a `keep` flag on the chat's `WorkflowLink` that the archive, notify and island rules read. The two run settings and the condition live on the workflow and are judged in `WorkflowRunner.start` and at a limit. Routines are not touched, except that their `startFresh` moves to a shared helper.

**Tech Stack:** TypeScript, Node 22, React 19, vitest (`node` environment), playwright-core e2e with the fake workflow claude.

**Spec:** `docs/superpowers/specs/2026-11-13-workflow-routine-parity-design.md`

## Global Constraints

- **No commits.** The user commits by hand (global rule). Every task ends with the tests green and the work left uncommitted.
- Worktree setup before the first `npm` command (all git-ignored), from the worktree root: `mkdir -p node_modules/@zumibot && ln -s ../../zumi-bot-server/{backend,frontend,shared} node_modules/@zumibot/`, then link `zumi-bot-server/frontend/node_modules` and `zumi-bot-server/backend/node_modules` to the main checkout's (`/home/mhdaljuboori/Developments/AI/ZumiBot/zumi-bot-server/...`).
- No new dependencies. Every new key is optional; absent means today's behaviour.
- New stored keys are written only when set (`keep` only `true`, `session` only `'fresh'`, `limitPolicy`/`missedPolicy` only `'skip'`, `condition` only non-blank), so `sameDef` finds older saved versions equal.
- Fixed texts (exported from `shared/src/workflows.ts`): `PICK_CHAT = 'Pick a chat'`, `CHAT_NOT_FOUND = 'Chat not found'`, `CHAT_READ_ONLY = 'This chat is read-only'`, `CHAT_OF_WORKFLOW = 'This chat belongs to a workflow'`, `PICK_MEMBERS = 'Pick at least two agents'`, `LIMIT_SKIP_TEXT = 'Skipped at the usage limit'`, `MISSED_TEXT = 'Missed while ZumiBot was off'`, `CONDITION_TEXT = 'Condition not met'`.
- Title cap is `ROUTINE_CHAT_TITLE_MAX` (100); condition cap is `JEV_CONDITION_MAX` (500); role cap is `ROLE_MAX_CHARS`.
- The Chat step never sets `ChatMeta.workflow` on its target and never adds `workflowSystem` to its system prompt.
- A `/name` is a command only when it leads the step's **saved** prompt (`CommandResolver.forRoutine`'s rule).
- Comments are short and say why. Frontend logic goes in `src/state/` (no component tests exist).
- Test commands: one file with `npx vitest run <path>`; all with `npm test`; types with `npm run typecheck`.

## Review Focus

1. **The Chat step's chat is deleted after the workflow was saved.** The visit fails with `Chat not found` (cause `step`, so On failure can catch it). Pinned in Task 5.
2. **The user's own turn is running in the target chat when the step fires.** The step's message waits in the tray, and the visit's output is its own turn's reply, never the user's. Pinned in Task 5.
3. **A webhook value starts with `/name`** (prompt `{{trigger.text}}`, text `/deploy now`). It is plain text, never a command. Pinned in Task 8.
4. **A webhook value holds `@member`** and a Chat step posts it into a room. It must not route to that member. Pinned in Task 4.
5. **The usage limit hits one For each item while the others still run, and the run is set to skip.** The run ends `skipped`, the other items stop, and no failure push goes out. Pinned in Task 9.

---

### Task 1: Shared types, parser and defaults

**Files:**
- Modify: `zumi-bot-server/shared/src/workflows.ts` (Step union, `StepKind`, `FAILING_KINDS`, `Workflow`, `WorkflowInput`, `WorkflowTrigger`, `WorkflowRun`, texts)
- Modify: `zumi-bot-server/shared/src/types.ts:164` (`WorkflowLink`), `:219` (user item), `:113` (`QueuedTask`)
- Modify: `zumi-bot-server/shared/src/workflowInput.ts` (`KINDS`, `parseStep`, `trigger`, `parseWorkflowInput`)
- Modify: `zumi-bot-server/shared/src/workflowDefaults.ts`
- Test: `zumi-bot-server/shared/tests/workflowInput.test.ts`, `zumi-bot-server/shared/tests/workflowDefaults.test.ts`

**Interfaces:**
- Produces:
  - `type ChatStep = StepBase & Fails & { kind: 'chat'; chat: string; prompt: string; session?: 'fresh'; command?: CommandPick }`
  - Agent step: `+ keep?: true; title?: string; command?: CommandPick`. For each: `+ command?: CommandPick`.
  - Room step: `+ keep?: true; title?: string; section?: string; command?: CommandPick; members?: string[]; role?: string; cwd?: string` (`room` stays `string`, `''` when built from agents)
  - `roomFromAgents(s: RoomStep): s is RoomStep & { members: string[]; role: string; cwd: string }` (true when `members !== undefined`)
  - `Workflow.limitPolicy?: 'skip'`, `Workflow.missedPolicy?: 'skip'`. `WorkflowInput` gets both (optional).
  - webhook `WorkflowTrigger` gets `condition?: string`. `WorkflowRun.condition?: ConditionCheck` (from `routines.ts`).
  - `WorkflowLink.keep?: true`
  - `interface WorkflowSent { workflowId: string; runId: string; stepId: string; name: string; step: string }` in `types.ts`, as `workflowSent?: WorkflowSent` on the `user` ChatItem and on `QueuedTask`
  - `'chat'` in `StepKind` and `FAILING_KINDS`. `stepPorts` gives it `out`, plus `error` with On failure.
  - `stepDefaults('chat')` returns `{ chat: '', prompt: '{{input}}' }`
  - the eight texts in Global Constraints

- [ ] **Step 1: Write failing parser tests** in `workflowInput.test.ts`, in a `describe('parity keys')`:

```ts
it('parses a chat step and keeps only fresh as a session', () => {
  const s = parseStep({ ...base('c'), kind: 'chat', chat: 'chat-1', prompt: 'hi', session: 'fresh' })
  expect(s).toMatchObject({ kind: 'chat', chat: 'chat-1', prompt: 'hi', session: 'fresh' })
  expect('session' in parseStep({ ...base('c'), kind: 'chat', chat: 'chat-1', prompt: 'hi', session: 'continue' })).toBe(false)
})
it('keeps keep and title on agent and room only, section only on a kept room', () => {
  expect(parseStep({ ...agentStep, keep: true, title: '  Daily  ' })).toMatchObject({ keep: true, title: 'Daily' })
  expect('keep' in parseStep({ ...foreachStep, keep: true })).toBe(false)
  expect('section' in parseStep({ ...roomStep, section: 'sec-1' })).toBe(false)
  expect(parseStep({ ...roomStep, keep: true, section: 'sec-1' })).toMatchObject({ section: 'sec-1' })
  expect('title' in parseStep({ ...agentStep, keep: true, title: '   ' })).toBe(false)
})
it('takes a room from agents with an empty room id', () => {
  const s = parseStep({ ...base('r'), kind: 'room', room: '', prompt: 'go', members: ['a', 'b'], role: 'Plan', cwd: '/w' })
  expect(s).toMatchObject({ room: '', members: ['a', 'b'], role: 'Plan', cwd: '/w' })
  expect(() => parseStep({ ...base('r'), kind: 'room', room: 'tpl', prompt: 'go', members: ['a', 'b'], role: '', cwd: '/w' })).toThrow('Invalid workflow')
  expect(() => parseStep({ ...base('r'), kind: 'room', room: '', prompt: 'go', members: ['a', 'a'], role: '', cwd: '/w' })).toThrow('Invalid workflow')
})
it('drops a command the prompt no longer starts with', () => {
  expect(parseStep({ ...agentStep, prompt: '/check now', command: { agent: 'x', name: 'check' } })).toMatchObject({ command: { agent: 'x', name: 'check' } })
  expect('command' in parseStep({ ...agentStep, prompt: 'check now', command: { agent: 'x', name: 'check' } })).toBe(false)
})
it('reads run settings and the webhook condition', () => {
  const w = parseWorkflowInput({ ...input, limitPolicy: 'skip', missedPolicy: 'skip', trigger: { kind: 'webhook', filters: [], condition: ' a new PR ' } })
  expect(w).toMatchObject({ limitPolicy: 'skip', missedPolicy: 'skip', trigger: { condition: 'a new PR' } })
  expect('limitPolicy' in parseWorkflowInput({ ...input, limitPolicy: 'wait' })).toBe(false)
  expect(() => parseWorkflowInput({ ...input, trigger: { kind: 'webhook', filters: [], condition: 'x'.repeat(501) } })).toThrow('Invalid workflow')
})
```

(`base`, `agentStep`, `roomStep`, `foreachStep` and `input` are small fixtures at the top of the block. Members must be unique and there must be at least 2, else it throws. `room` must be `''` when `members` is given.)

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/shared/tests/workflowInput.test.ts`. Expected: the new cases fail, with `kind` rejected or keys missing.
- [ ] **Step 3: Add the types and texts in `workflows.ts` and `types.ts`.** Export `roomFromAgents`, and add `'chat'` to `StepKind` and `FAILING_KINDS`.
- [ ] **Step 4: Extend `parseStep`, `trigger` and `parseWorkflowInput`.** Each value is rebuilt key by key with the existing `text`, `id` and `optText` helpers:
  - titles are trimmed, and a blank one is dropped;
  - `members` go through `id`;
  - `role` uses `ROLE_MAX_CHARS` and `cwd` uses `PATH_MAX`;
  - `command` keeps `{agent, name}` only while `leadingCommand(prompt)?.name === name` (import from `shared/src/commands.ts`);
  - a `condition` over `JEV_CONDITION_MAX` fails.
- [ ] **Step 5: Add `chat` to `stepDefaults`.** Add a case to `workflowDefaults.test.ts` asserting `stepDefaults('chat')` equals `{ chat: '', prompt: '{{input}}' }`.
- [ ] **Step 6: Run, expect PASS.** `npx vitest run zumi-bot-server/shared/tests/workflowInput.test.ts zumi-bot-server/shared/tests/workflowDefaults.test.ts`, then `npm run typecheck`. Expected: PASS. Typecheck errors may only come from switches over `Step['kind']` that need a `'chat'` case: add `case 'chat':` beside `case 'room':` where the code is generic, and leave real behaviour to later tasks.

### Task 2: Problems, history and agent rename

**Files:**
- Modify: `zumi-bot-server/shared/src/workflowGraph.ts` (`problemsOf`, `textFields`)
- Modify: `zumi-bot-server/shared/src/definitionHistory.ts` (`workflowDef`, `workflowTrigger`, `workflowChanges`)
- Create: `zumi-bot-server/shared/src/workflowRename.ts`
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowStore.ts:163` (`renameAgent`), `zumi-bot-server/backend/src/core/history/renameAgent.ts` (`renameWorkflowDef`)
- Test: `zumi-bot-server/shared/tests/workflowGraph.test.ts`, `zumi-bot-server/shared/tests/definitionHistory.test.ts`, `zumi-bot-server/backend/tests/core/workflowStore.test.ts`, `zumi-bot-server/backend/tests/core/historyStore.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `renameStepAgent(step: Step, from: string, to: string): Step | null` (null when untouched). It renames an agent or For each step's `agent`, a room's `members`, and any `command.agent`.

- [ ] **Step 1: Write failing tests.**

```ts
// workflowGraph.test.ts
it('asks for a chat and for two agents', () => {
  const p = problemsOf(flow([trigger, { ...base('c'), kind: 'chat', chat: '', prompt: 'x' }, { ...base('r'), kind: 'room', room: '', prompt: 'x', members: ['a'], role: '', cwd: '/w' }]), agents, 'zumi-bot')
  expect(p.map(x => x.text)).toEqual(expect.arrayContaining([PICK_CHAT, PICK_MEMBERS]))
})
it('judges each room member as an agent step', () => {
  const p = problemsOf(flow([trigger, { ...base('r'), kind: 'room', room: '', prompt: 'x', members: ['a', 'zumi-bot', 'gone'], role: '', cwd: '/w' }]), agents, 'zumi-bot')
  expect(p.map(x => x.text)).toEqual(expect.arrayContaining(['Zumi Bot cannot be a workflow step', 'Agent "gone" not found']))
})
// definitionHistory.test.ts
it('a workflow saved before run settings equals its next save', () => {
  expect(sameDef(workflowDef(old), workflowDef({ ...old }))).toBe(true)
  expect(workflowChanges(workflowDef(old), workflowDef({ ...old, limitPolicy: 'skip' }))).toEqual(['Run settings changed'])
  expect(workflowDef({ ...hook, trigger: { ...hook.trigger, condition: 'a PR' } }).trigger).toEqual({ kind: 'webhook', sample: null, filters: [], condition: 'a PR' })
})
// workflowStore.test.ts
it('renames room members and command agents in workflows and run snapshots', async () => { /* save one with members ['a','b'] and command {agent:'a'}; renameAgent('a','z'); both read 'z' in the workflow and a stored run's snapshot */ })
```

- [ ] **Step 2: Run, expect FAIL.** Run those four files with `npx vitest run`.
- [ ] **Step 3: Implement.**
  - `problemsOf`: `chat` with an empty `chat` gives `PICK_CHAT`.
  - `problemsOf`: a room from agents with fewer than 2 members gives `PICK_MEMBERS`. Each member is checked as an agent step's agent is: `'Zumi Bot cannot be a workflow step'`, `Agent "x" not found`, or `Agent "x" has an error`.
  - The chat and room prompt rule joins `'Write a prompt'`, and `textFields` covers the chat prompt.
  - `workflowDef` appends `limitPolicy`, then `missedPolicy`, each only when set. `workflowTrigger` keeps `condition` when set.
  - `workflowChanges` pushes `'Run settings changed'` when either policy differs.
  - `renameStepAgent` lives in its own file. `workflowStore.renameAgent` and `renameWorkflowDef` both call it.
- [ ] **Step 4: Run, expect PASS.** Run those files, then `npm run typecheck`.

### Task 3: Shared fresh-session helper

**Files:**
- Create: `zumi-bot-server/backend/src/core/chat/freshStart.ts`
- Modify: `zumi-bot-server/backend/src/core/routines/routineRunner.ts:155,404-417` (call the helper, delete the private method)
- Test: `zumi-bot-server/backend/tests/core/freshStart.test.ts`; `zumi-bot-server/backend/tests/core/routineRunner.test.ts` stays green

**Interfaces:**
- Produces: `startFresh(chats: Pick<ChatStore, 'update' | 'updateGroup'>, chat: ChatMeta): Promise<void>`. The body moves unchanged from `RoutineRunner.startFresh`.

- [ ] **Step 1: Write failing tests.** Three cases:
  - a single chat with a `sessionId` gets `next: {seed: true, fresh: true}` and `context: undefined`;
  - a single chat without one is left alone;
  - a room sets `next` only for members whose `sessions[m]` is set, and drops only their `context` entries.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/freshStart.test.ts`. Expected: cannot find module.
- [ ] **Step 3: Move the body.** Make `routineRunner.ts:155` call `startFresh(this.d.chats, chat)`.
- [ ] **Step 4: Run, expect PASS.** Run `freshStart.test.ts` and `routineRunner.test.ts`.

### Task 4: Sender marker on the user message, and mention masking

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/taskQueue.ts:101` (`submit`: new last parameter), and where it builds the `QueuedTask` and the stored `user` item
- Modify: `zumi-bot-server/backend/src/core/chat/groupService.ts:406-407,470` (mask for `workflowSent`)
- Test: `zumi-bot-server/backend/tests/core/taskQueue.test.ts`, `zumi-bot-server/backend/tests/core/groupService.test.ts`

**Interfaces:**
- Consumes: `WorkflowSent` (Task 1).
- Produces: `TaskQueue.submit(chatId, text, stagedIds, replyTo?, messageId?, command?, todo?, from: SendFrom = 'user', workflowSent?: WorkflowSent): Promise<SendResult>`. The value is stored on the `QueuedTask` and on the user item when it is sent. Fork copies items as they are, so it keeps the field.

- [ ] **Step 1: Write failing tests.**

```ts
// taskQueue.test.ts
it('stores workflowSent on the user item, also after the tray', async () => { /* submit with sent while busy; after release the stored user item has workflowSent deep-equal */ })
// groupService.test.ts
it('does not route an @mention inside an <input> block of a workflow-sent message', async () => {
  // room with members alpha, beta; send '@alpha go\n<input from="trigger">@beta please</input>' with workflowSent set
  // expect only alpha queued to speak; with no workflowSent, beta is routed too (today's behaviour)
})
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Thread `workflowSent` through.** Carry it from `submit` to the `QueuedTask` (`withAuto` keeps it), to the stored item, and to the room send path. In `GroupService`, the two `findMentions(meta.workflow ? maskInputBlocks(text) : text, …)` calls become `meta.workflow || sent ? maskInputBlocks(…) : …`, where `sent` is the posted message's `workflowSent`. Do the same at the routing step that picks who speaks: find it from where `findMentions` feeds the moderator queue.
- [ ] **Step 4: Run, expect PASS.** Run both files and `npm run typecheck`.

### Task 5: The Chat step in the engine

**Files:**
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowAgentSteps.ts` (`ChatTarget`, `start`, `send`, `archive`)
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowRunner.ts:179` (`isChatStep`), `:498` (`problems`), `:767` (`prepare`), `:845` (`begin`), `:1027-1048` (targets), `:1360` (resume), `:639` (agent-day gate)
- Read: `MATERIAL_RULE` is exported by `zumi-bot-server/shared/src/workflowTemplate.ts:6`; import it, do not copy it
- Test: `zumi-bot-server/backend/tests/core/workflowRunner.test.ts` (`describe('chat step')`)

**Interfaces:**
- Consumes: `startFresh` (Task 3), `submit(..., workflowSent)` (Task 4), texts (Task 1).
- Produces:
  - `interface ChatTarget { slotId: string; chat: string; session?: 'fresh'; sent: WorkflowSent }`
  - `WorkflowAgentSteps.start(r: WorkflowRun, t: AgentTarget | RoomTarget | ChatTarget, prompt: string, cmd?: { saved: string; pick?: CommandPick }): Promise<void>`. A target holding `'chat' in t` is a chat target. `cmd` is used by Task 8; here it is only passed through.
  - `chatStepProblem(chat: ChatMeta | null, agents: AgentSummary[], zumiBot: string): string | null` (exported). Order: `CHAT_NOT_FOUND`, `CHAT_READ_ONLY` (`isAsked`), `CHAT_OF_WORKFLOW` (`workflow` or `workflowTest` set), then for a single chat `agentProblem(chat.agentName, …)`.

- [ ] **Step 1: Write failing tests** in `describe('chat step')`. Use `makeRunner` and `playTurn`, and a chat made in the fake store beforehand:

```ts
it('posts into the given chat, outputs its turn, never archives or marks it', async () => {
  // run → only(r,'c').status 'done', output 'reply'; chat.archivedAt undefined; chat.workflow undefined;
  // the stored user item has workflowSent {workflowId, runId, stepId:'c', name, step:'Chat'}
})
it('starts sessions fresh when asked, but not in a paused chat', async () => { /* next {seed:true,fresh:true} set; with pause:'paused' it is not, and the message is held */ })
it('ends the material rule after the blocks', async () => { /* prompt '{{trigger.text}}' on a webhook call → sent text ends with MATERIAL_RULE */ })
it('follows its own turn when the user’s turn runs first', async () => { /* chat busy with a user turn; step message queued; output is the step turn’s reply */ })
it('fails Chat not found when the chat was deleted', async () => { /* problems() lists it; a run reaching the step after delete fails the visit CHAT_NOT_FOUND, cause step */ })
it('Stop drops a queued step message and leaves the user’s turn running', async () => { /* tasks.drop called, stopChat not called */ })
it('counts the turn toward the run cost', async () => { /* chatCost(chatId, 0.5) while following → visit costUsd 0.5 */ })
```

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run zumi-bot-server/backend/tests/core/workflowRunner.test.ts -t "chat step"`.
- [ ] **Step 3: Implement the engine paths.**
  - `isChatStep` includes `'chat'`.
  - `prepare` fills the chat prompt with `modelPrompt` like `agent`/`room`. When the text holds an `<input` block, it appends `'\n\n' + MATERIAL_RULE`.
  - `begin` builds a `ChatTarget`: `sent` uses the run's workflow name and the step's name. It then calls `agentSteps.start`.
  - In `start`, the chat branch reads the chat and runs `chatStepProblem`, failing the slot with its text. It calls `startFresh` when `session === 'fresh'` and `chat.pause === undefined`. Then it patches the slot and sends with `t.sent`.
  - `archive` returns early unless `cur.workflow` is set and `!cur.workflow.keep`. This also covers Task 7.
  - `problems()` adds `chatStepProblem(await this.d.chats.get(s.chat), …)` for chat steps with a chat.
  - The agent-day gate at `:639` judges the chat's agent, or each room member.
  - `resume` recovers chat visits through `agentSteps.recover`, as for `room`.
  - A room target posts as a Room step and ends on quiet. The existing settle path reads room items, so add no special case.
- [ ] **Step 4: Run, expect PASS.** Run the file, then `npm run typecheck`.

### Task 6: Room step from agents

**Files:**
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowRooms.ts` (`RoomTarget`, a new `newRoom`, dispatch in the `rooms.copy` dep)
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowRunner.ts:1039` (`roomTarget`), `:498` (folder problem), and the `rooms` dep in `zumi-bot-server/backend/src/app.ts`
- Test: `zumi-bot-server/backend/tests/core/workflowRooms.test.ts`, `zumi-bot-server/backend/tests/core/workflowRunner.test.ts`

**Interfaces:**
- Produces:
  - `RoomTarget` gains `agents?: { members: string[]; role: string; cwd: string }` and `section?: string`
  - `newRoom(d: RoomCopyDeps & { store: Pick<ChatStore, 'createGroup' | 'update' | 'remove'> }, t: RoomTarget & { agents: NonNullable<RoomTarget['agents']> }): Promise<{ chatId: string } | { error: string }>`. It runs `refuseZumiBot`, then `refuseCodexMembers`, then each member through `agentProblem`, then `createGroup(members, cwd, role)`, then the update that sets title, `workflow` and `workflowRules`, removing the room if that update throws.
  - The `rooms.copy(t)` dep calls `newRoom` when `t.agents` is set, else `copyRoom`.
  - Placement: `t.section` wins when set (kept room); otherwise a copy goes where its template is, as today, and a room from agents goes in no section.

- [ ] **Step 1: Write failing tests.** In `workflowRooms.test.ts`:
  - `newRoom` makes a group with those members, role and folder, carrying `workflow` and `workflowRules`;
  - a Zumi Bot member returns its refusal text;
  - a failed update removes the room;
  - `section` places it.

  In `workflowRunner.test.ts`, a Retry reuses the visit's room.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `roomTarget` passes `agents` when `roomFromAgents(step)`, plus `section` when `step.keep`.
  - `problems()` adds `FOLDER_MISSING` for a room from agents whose `cwd` does not exist.
  - Agent rename is already covered by Task 2.
- [ ] **Step 4: Run, expect PASS.** Run both files.

### Task 7: Keep the chat

**Files:**
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowRunner.ts:1027-1048` (title and link)
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts:1131`, `zumi-bot-server/backend/src/core/chat/groupService.ts:829` (turn end `workflow` flag)
- Modify: `zumi-bot-server/frontend/src/state/island.ts:16`
- Test: `zumi-bot-server/backend/tests/core/workflowRunner.test.ts`, `zumi-bot-server/backend/tests/core/chatService.test.ts`, `zumi-bot-server/frontend/tests/island.test.ts`

**Interfaces:**
- Consumes: the `archive` early return from Task 5.
- Produces: `link.keep = true` on kept Agent and Room steps. Title is `step.title ?? chatTitle(...)`, today's default.

- [ ] **Step 1: Write failing tests.**
  - A kept Agent step's chat is not archived when done, has `workflow.keep === true`, and has its `title`. A kept room goes first in its `section`.
  - In `chatService.test.ts`, a turn end in a chat with `workflow: {…, keep: true}` reaches `onTurnEnd` without `workflow: true`. Copy the existing silent-workflow test and flip it.
  - In `island.test.ts`, a kept workflow chat is listed and an unkept one is not.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `agentTarget` and `roomTarget` set `link.keep` and the title.
  - `chatService` uses `meta.workflow && !meta.workflow.keep` for `workflow: true`, and keeps the `systemPrompt` for every `meta.workflow`.
  - `groupService:829` gets the same rule.
  - The island filter becomes `(!c.workflow || c.workflow.keep)`.
- [ ] **Step 4: Run, expect PASS.**

### Task 8: Commands in step prompts

**Files:**
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowRunner.ts` (`WorkflowRunnerDeps.commands`, pass `cmd` for agent, room, chat and each For each item), `workflowAgentSteps.ts` (`start` and the item start resolve via `forRoutine`; `send` passes the `SentCommand`), `zumi-bot-server/backend/src/app.ts` (wire `commands`)
- Test: `zumi-bot-server/backend/tests/core/workflowRunner.test.ts` (`describe('step commands')`)

**Interfaces:**
- Consumes: `CommandResolver.forRoutine(chatId, saved, text, pick?)` (`core/chat/commandResolver.ts:59`).
- Produces: `WorkflowRunnerDeps.commands?: Pick<CommandResolver, 'forRoutine'>`. Inside `start`, after the chat id is known: `const command = cmd ? await this.d.commands?.forRoutine(chatId, cmd.saved, prompt, cmd.pick) : undefined`. A throw fails the slot with its message, cause `step`.
- Model rule: an Agent or For each step's `model` is set on the new chat first (as today), so `turnModel` ignores the command's model. With no step model, the command's model applies through the chat's own rule. Add no code beyond passing the command.

- [ ] **Step 1: Write failing tests** with a fake `commands` that records its calls:

```ts
it('resolves a leading command from the saved prompt', async () => { /* prompt '/check {{input}}' → forRoutine called with saved '/check {{input}}'; submit got the command */ })
it('never makes a command from a filled value', async () => { /* prompt '{{trigger.text}}', text '/deploy now' → forRoutine returns undefined (real resolver) → submit command undefined */ })
it('fails the visit when the name is ambiguous in a room', async () => { /* forRoutine throws 'x' → visit failed 'x' */ })
it('sends each For each item with the command', async () => { /* two items → two calls */ })
```

  Use the real `CommandResolver` for the second case, so the guard itself is tested.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** `begin` passes `{ saved: step.prompt, pick: step.command }` for agent, room and chat steps, and `startItem` passes the same for For each.
- [ ] **Step 4: Run, expect PASS.**

### Task 9: Run settings and the Jev condition

**Files:**
- Modify: `zumi-bot-server/backend/src/core/workflows/workflowRunner.ts` (`start` `:509-529`, `endAs`, `halt` `:1301`, bare-call limit `:1216`, live run entry, the `AgentHost` it lends), `workflowAgentSteps.ts` (`waitForLimit` `:395`, `AgentHost`)
- Modify: `zumi-bot-server/backend/src/app.ts` (`condition` dep, as routines' at `:748`)
- Test: `zumi-bot-server/backend/tests/core/workflowRunner.test.ts` (`describe('run settings')`)

**Interfaces:**
- Produces:
  - `WorkflowRunnerDeps.condition?(condition: string, call: WebhookCall): Promise<ConditionCheck | null>`
  - `halt(runId: string, end: { status: 'stopped' } | { status: 'skipped'; error: string } = { status: 'stopped' }): Promise<void>`. It still stops every open visit and chat silently, and writes `status` and `error`.
  - `AgentHost.limitSkip(runId: string): boolean` (the live run's `limitPolicy === 'skip'`)
  - `AgentHost.skipRun(runId: string): Promise<void>`. It is called inside the run's queue, so it calls `halt(runId, { status: 'skipped', error: LIMIT_SKIP_TEXT })` directly, never through `stopRun`, which would queue behind itself.
  - `endAs(status, error, extra?: Pick<WorkflowRun, 'condition'>)`

- [ ] **Step 1: Write failing tests.**

```ts
it('skips a late schedule run when missed runs are skipped', async () => { /* run(w,'schedule',{late:true}) with missedPolicy 'skip' → status 'skipped', error MISSED_TEXT, no visit */ })
it('skips the run at the usage limit, stopping the other items, with no failure push', async () => {
  // For each with concurrency 2 and limitPolicy 'skip'; item 1's turn ends with failure('limit', resetAt)
  // → run 'skipped', error LIMIT_SKIP_TEXT, item 2 'stopped', notes.failed empty, no timer armed
})
it('skips at a bare call limit too', async () => { /* llm returns {ok:false, limit:{resetsAt}} → run skipped */ })
it('waits as before without the setting', async () => { /* existing limit test stays green */ })
it('checks the Jev condition after the filters, real calls only', async () => {
  // condition dep returns {met:false,p:0.1} → run skipped CONDITION_TEXT with condition {met:false,p:0.1}
  // returns {met:null} or throws → run starts; via 'manual' with the sample → dep not called
})
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
  - `start`: first `if (via === 'schedule' && o.late && w.missedPolicy === 'skip') return endAs('skipped', MISSED_TEXT)`. After the filter check comes the condition check, before the active-run cap; its failure counts as `{met: null}`.
  - Keep `limitPolicy` on the live run entry where `timeZone` is kept, and set it in `recover()` too.
  - In `waitForLimit`, before any wait: `if (this.h.limitSkip(f.runId)) { await this.h.skipRun(f.runId); return true }`.
  - At `:1216`, the same check, calling `halt` directly.
  - Wire `condition` in `app.ts` exactly as the routine runner's.
- [ ] **Step 4: Run, expect PASS.** Run the whole `workflowRunner.test.ts` and `npm run typecheck`.

### Task 10: Zumi Bot's workflow format

**Files:**
- Modify: `zumi-bot-server/backend/src/core/automations/authoring.ts` (`STEP_KINDS`, `FIELDS`, `WORKFLOW_TRIGGERS`, workflow keys, the conversion back)
- Modify: `zumi-bot-server/backend/src/core/automations/automationService.ts:250-273` (`workflowKept`: keep `section` and `command`; the chat and room checks)
- Modify: `zumi-bot-server/backend/src/core/agents/zumiBot.ts` (two sentences in "Routines and workflows")
- Test: `zumi-bot-server/backend/tests/core/automationAuthoring.test.ts`, `zumi-bot-server/backend/tests/core/automationService.test.ts`

**Interfaces:**
- Format additions:
  - `chat: { chat: chatRef, prompt, session: oneOf(['continue', 'fresh']) }`. `chatRef` takes an id or an app link through `chatIdFrom`; `'continue'` is stored as absent.
  - room adds `members` (a list of agent names, resolved like `agent`), `role`, `cwd`, `keep` (flag) and `title`.
  - agent adds `keep` and `title`.
  - workflow keys add `limitPolicy` (`'wait' | 'skip'`) and `missedPolicy` (`'run-once' | 'skip'`).
  - the webhook trigger adds `condition`.
- `workflow_get` returns the same keys. `section` and `command` are never in the format; an edit keeps the stored ones while the step keeps its handle and the prompt still starts with the command's name.
- The service refuses a chat that `chatStepProblem` refuses, with its text. A missing room `cwd` defaults as a routine's new room does (`lastGroupFolder`, else home).

- [ ] **Step 1: Write failing tests.**
  - A create with a chat step by link, a room from agents, a kept agent and both settings round-trips through save and `workflow_get`.
  - An edit without `section` keeps it.
  - A chat id that is an A→B chat is refused with `CHAT_READ_ONLY`.
  - `members: ['zumi-bot', 'a']` is refused with today's Zumi Bot sentence.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Add the prompt sentences, verbatim: "A Chat step posts into a chat or room the user names; never pick one yourself." and "Use Keep only when the user wants to read the step's chat afterward."
- [ ] **Step 4: Run, expect PASS.** Run both files and `zumi-bot-server/backend/tests/core/zumiBot.test.ts`.

### Task 11: Chat step in the editor

**Files:**
- Create: `zumi-bot-server/frontend/src/state/workflowChat.ts`
- Modify: `zumi-bot-server/frontend/src/components/StepInspector.tsx` (`case 'chat'`; hide Run step for `chat`, as for `room`), `zumi-bot-server/frontend/src/state/workflowCanvas.ts:39,267` (label `'Chat'`, node line), `zumi-bot-server/frontend/src/components/WorkflowIcons.tsx` (chat icon)
- Test: `zumi-bot-server/frontend/tests/workflowChat.test.ts`, `zumi-bot-server/frontend/tests/workflowCanvas.test.ts`

**Interfaces:**
- Produces:
  - `chatOptions(chats: ChatMeta[], current: string): { rooms: ChatMeta[]; singles: ChatMeta[] }`. It leaves out A→B chats, `workflow`/`workflowTest` chats and archived chats (unless the chat is `current`), and sorts each group by title.
  - `chatStepNote(chatId: string, chats: ChatMeta[]): string | null` (`CHAT_NOT_FOUND` when set and missing)
  - `chatStepTitle(chatId: string, chats: ChatMeta[], agents: AgentSummary[]): string | null` (through `chatTitle`)

- [ ] **Step 1: Write failing tests** for the three functions, and for the node line (`'Pick a chat'`, the chat's title, `'Chat not found'`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The inspector holds:
  - a select with two `<optgroup>`s (`wf-chat`);
  - the note (`wf-chat-missing`);
  - Prompt (`wf-prompt`);
  - a Session select (`wf-chat-session`: "Continue each agent's session" | "Start fresh each run"), with the routine PolicyCard's help line;
  - On failure.
- [ ] **Step 4: Run, expect PASS.** Run the files and `npm run typecheck`.

### Task 12: Agent and Room inspectors: Keep, title, section, room from agents, commands

**Files:**
- Create: `zumi-bot-server/frontend/src/state/workflowStepCommands.ts`
- Modify: `zumi-bot-server/frontend/src/components/StepInspector.tsx` (`TemplateField` gains `commandAgents?`, `grouped?`, `pick?`, `onPick?`, passed to both `PromptField`s; agent and room cases)
- Test: `zumi-bot-server/frontend/tests/workflowStepCommands.test.ts`

**Interfaces:**
- Produces:
  - `stepCommandAgents(step: Step, agents: AgentSummary[], chats: ChatMeta[]): { agents: AgentSummary[]; grouped: boolean }`. Agent and For each give their agent. A room from agents gives its members, grouped. A copied room gives the template's members, grouped. A chat gives its agent, or its members (grouped). Anything else gives `{agents: [], grouped: false}`.
  - `withPrompt(step, prompt): Step`. It drops `command` once the prompt no longer starts with `/<name>`, using `keepPick` from `state/commandInput.ts`.

- [ ] **Step 1: Write failing tests** for both functions: each source kind, and the command dropped or kept.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement the inspector parts.**
  - Agent step: "After the step" select (`wf-keep`: "Archive the chat" | "Keep it in the sidebar"), plus a Title input (`wf-title`, max 100, placeholder today's default) when kept.
  - Room step: a source switch (`wf-room-source`: "Copy a room" | "New room from agents"). The second shows `MembersMenu` (`wf-room-members`, `memberOptions(caps)`), Role (`wf-room-role`, `ROLE_MAX_CHARS`) and a Folder button (`wf-room-folder`).
  - Room step: Keep and Title, then a Section select for a kept room (`wf-room-section`, "Outside sections", `shownSection`). Switching source clears the other source's keys.
  - Prompt fields of agent, foreach, room and chat pass `stepCommandAgents`, `pick = step.command`, and `onPick` that saves `command`.
- [ ] **Step 4: Run, expect PASS.** Run the test and `npm run typecheck`.

### Task 13: Trigger settings, run view and the sender line

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/TriggerInspector.tsx` (two selects and the condition), `WorkflowEditor.tsx` (pass the Jev status, as `RoutineEditor` does)
- Modify: `zumi-bot-server/frontend/src/state/auditLog.ts` (a condition skip shows Jev's verdict in the trigger entry)
- Modify: `zumi-bot-server/frontend/src/state/workflowMessage.ts` and its bubble use (a user item with `workflowSent` gets the `wf-from` line naming `name › step`, linking to `workflowsPath({workflowId, runId})`, and its blocks drawn)
- Test: `zumi-bot-server/frontend/tests/auditLog.test.ts`, `zumi-bot-server/frontend/tests/workflowMessage.test.ts`

**Interfaces:**
- Consumes: Task 1 keys and texts.
- Produces:
  - `senderOf(item: ChatItem, chat: ChatMeta, firstLoaded: boolean): { name: string; step?: string; path?: string } | null`. Extend or wrap today's sender rule so `workflowSent` wins.
  - Trigger inspector test ids: `wf-limit-policy`, `wf-missed-policy` (schedule only), and `wf-condition` (webhook, shown while Jev is on or a condition is saved, as `TriggerCard` does).

- [ ] **Step 1: Write failing tests.**
  - `senderOf` returns the workflow and step for a `workflowSent` item in a plain chat, and keeps today's answers otherwise.
  - The audit model shows `CONDITION_TEXT` and `p` for a condition skip.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Help lines are copied from `PolicyCard.tsx`, adjusted for a run instead of a routine run. The run end line already prints `error`.
- [ ] **Step 4: Run, expect PASS.** Run the files, `npm test` and `npm run typecheck`.

### Task 14: End to end and CLAUDE.md

**Files:**
- Modify: `zumi-bot-server/e2e/workflows.e2e.mjs` (new cases at the end)
- Modify: `CLAUDE.md` (Workflows section and the `e2e:workflows` entry)

- [ ] **Step 1: Add e2e cases** with the fake workflow claude and `FAKE_INVOCATIONS_OUT`:
  - (a) A Chat step into a chat made by a raw `/ws` RPC, with Start fresh: the second run's invocation has no `--resume`, and the chat shows the `wf-from` line.
  - (b) A kept Agent step: its chat is not archived, and the sidebar lists it under its title.
  - (c) A Room step from two agents: both answer, and the run ends done.
  - (d) A `/command` step: the fake's stdin shows the command's filled prompt.
  - (e) `limitPolicy: 'skip'` with a rejected `rate_limit_event`: the run reads skipped with `LIMIT_SKIP_TEXT`.
- [ ] **Step 2: Run, expect PASS.** `npm run e2e:workflows`.
- [ ] **Step 3: Update `CLAUDE.md`.** In the Workflows section, one paragraph naming the Chat step, Room from agents, Keep, step commands and the three settings, with their file names. Extend the `e2e:workflows` description with the five cases.
- [ ] **Step 4: Run the whole suite.** `npm test`, `npm run typecheck` and `npm run e2e:workflows`. Expected: all PASS.
