# Connectors Phase 3 (guardrails) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every call an agent makes to a claude.ai connector reaches ZumiBot. A read runs without a card. A write gets a card in a run the user started. In a run nobody typed (a routine, a workflow, or an ask they started), a write is refused at once. Allow-always memory for a connector exists only when the user turns on that service's **Remember** switch on the Connectors page.

**Architecture:**
- **Ask rules.** `buildAgentRunConfig` adds a `permissions.ask` glob (`mcp__<prefix>__*`) for each prefix of every connector that is on, so the CLI asks even in auto mode. It also returns a prefix → catalog-id map. The prefixes come from the catalog's names, from server names `ConnectorsService` has seen in the home-folder probe, and from the agent's own servers at catalog URLs.
- **Classification.** `ChatService`'s permission step uses that map to tell a connector call from any other tool:
  - a read is allowed;
  - a write in an unattended turn is denied with a fixed sentence;
  - a write in an attended turn gets a card stamped with the connector. Chat memory and agent rules apply to it only while its Remember switch is on.
- **Unattended.** "Unattended" is `TurnSpec.auto`. Today only single chats get it. This plan carries it into room runs that a non-typed message opened, and into A→B asked turns of an unattended asker.

**Tech Stack:** TypeScript, Node 22, React 19, vitest, the e2e harness (`zumi-bot-server/e2e/harness.mjs`), the fake CLIs `backend/tests/fixtures/fake-claude.mjs` (scripted `control_request` lines, `#WAIT_RESPONSE`, `FAKE_RESPONSES_FILE`) and `fake-extensions-claude.mjs`.

**Spec:** `docs/architecture/connectors.md`, sections "Unattended runs" and "Phase 3 — guardrails". The user approved them as written on 2026-11-17. Open question 4 is answered: unattended runs get reads only, and writes are refused, not left waiting. Phase 1 is built (section "Built (phase 1)"). Codex gets nothing here: route A gives Codex no connectors, and route B is not built.

## Global Constraints

- **No commits.** The user's global rule overrides the template's commit steps. Leave every change in the working tree.
- **Where to work.** Work in the main checkout. Another session owns `docs/architecture/engines.md`, `docs/architecture/protocol-engines.md`, `docs/superpowers/plans/2026-11-17-engine-seam-1a.md` and its own worktree: never touch them. Do not edit `CLAUDE.md`. It is at 16 300 of 16 384 bytes, and `shared/tests/repoDocs.test.ts` fails past the limit.
- **Permissions.** Never add `--dangerously-skip-permissions` or `bypassPermissions`.
- **Claude Code page.** Do not touch how Settings › Claude Code reads or edits servers. Its `oauth` refusal stays.
- **Only the user flips a switch.** That includes the new Remember switch. `connectors:setAgent` and `connectors:setRemember` are the only writers of `connectors.json`. No agent tool, workflow step or Zumi Bot action reaches them.
- **No secrets leak.** Secrets never go into logs, URLs or error messages. Server URLs never leave the sanitizer.
- **API methods.** A new API method touches `ZumiBotApi` in `shared/src/types.ts`, the handler in `backend/src/rpc/handlers.ts` and `frontend/src/net/api.ts`. Handlers check every argument.
- **Dependencies.** No new dependency.
- **No real accounts in tests.** No test reaches a real provider or the user's claude.ai account. The real-CLI probe and the hand check (Task 9) run only after the user says yes.
- **Docs in the same change.** Each task updates the doc it names.
- **Unattended refusal text** is exactly: `<Service> <tool> changes data outside this machine. Runs started by a routine or workflow may only read; ask the user to do this in a chat.`, where `<Service>` is the catalog `name`, e.g. `Gmail send_message changes data …`.
- **What counts as a write.** A tool the catalog does not list is a write (`isReadTool` is false).
- **Side runs (`/btw`).** No change: their guard already refuses every tool (`core/btw/sideRun.ts`).

## Review Focus

1. **A connector under a name the catalog does not know.** Examples: `claude.ai Gmail (2)`, or a GitHub custom connector the user named. Expected: its calls are still classified, and it still gets an ask rule, once the name has been seen in a home-folder probe. The longest matching prefix wins, so `mcp__claude_ai_Gmail__2___send_message` is Gmail's `send_message`, not a tool named `2___send_message`. Tests in Tasks 1–3.
2. **Remembered rules while Remember is off.** This covers an "Allow always" rule saved before phase 3, a rule saved while Remember was on, and an earlier "Allow for this chat" for the same tool. Expected: none of them applies, and the card shows again. Turning Remember back on makes them apply. Nothing is deleted. Tests in Task 5.
3. **A room opened by a routine or workflow message, then typed into by the user.** Expected: the room is unattended until the user's message enters, and attended from then on. A Resume or an edit/resend is attended. A user-opened room is never unattended. Tests in Task 6.
4. **A vendor adds a tool the catalog does not list.** Expected: a card in an attended run, refused in an unattended one, never auto-allowed as a read. Tests in Task 5.
5. **A non-connector tool that looks like a connector's.** A user server named `claude.ai Gmailx` (`mcp__claude_ai_Gmailx__…`), a `mcp__zumibot_*` bridge tool, `Bash`, or a Codex run's MCP call must all take the existing path, unchanged. Tests in Tasks 1 and 5.

## Calls made in this plan (not in the spec; flag them to the user)

- **Reads.** A read of a connector that is on runs without a card in every chat mode, Ask permissions and Plan included.
- **What Remember covers.** It covers both **Allow for this chat** and **Allow always for this agent**. The spec named only the second. With Remember off, the card offers Allow once and Deny, and the server turns any other answer into Allow once. **Allow for this step** is never offered for a connector call, and step rules never allow one.
- **One switch per service.** Remember is per service for every agent, stored as `remember: {<id>: true}`, as the spec's file shape says.
- **Old rules are kept.** Rules saved earlier stay listed in Remembered approvals and are inert while Remember is off.
- **Learned names.** Custom and renamed connector names come from home-folder probes: the switch-over, every Connectors page load, and one read at server start. A connector renamed on claude.ai after the last read has no ask rule and is not classified until the next read. It then behaves as today, and the off-switch deny still holds by URL.
- **What counts as unattended.** Unattended runs are:
  - `auto` turns: a routine's schedule, webhook and Run now; workflow Agent, Room, For-each and Chat steps; and the automatic continue after a usage-limit wait, even in the user's own chat;
  - room runs opened by such a message, until the user types into the room;
  - A→B asked turns of an unattended asker, nested asks included.

  The task board, attempt sets, PR-check messages and the workflow editor's Run step stay attended, as today.
- **A refused write leaves no card.** The tool row shows the refusal as its error result.
- **Side runs.** Side runs (`/btw`) stay stricter than the spec's "reads only": their guard already refuses every tool, connector reads included. Nothing changes there.
- **Ask-rule form.** The ask rule uses the glob form `mcp__<prefix>__*`. The probe (Task 8) confirms on the real CLI that it forces `can_use_tool` in auto mode, and that ask beats an allow rule for the same tool.

---

### Task 1: Catalog helpers for classification and ask rules

**Files:**
- Modify: `zumi-bot-server/shared/src/connectors.ts`
- Test: `zumi-bot-server/shared/tests/connectors.test.ts`

**Interfaces:**
- Consumes: `CONNECTORS`, `connectorById`, `toolPrefix` (from `./extensions`).
- Produces:
  ```ts
  export interface ConnectorServerName { name: string; connector: ConnectorId }
  /** Tool prefix (`mcp__<name as the CLI normalizes it>`) → catalog id, for every catalog name plus each given server. */
  export function connectorPrefixes(servers: Iterable<ConnectorServerName>): Record<string, ConnectorId>
  /** The connector call a tool name is: the LONGEST prefix p with toolName starting `${p}__` and a non-empty rest; else null. */
  export function connectorCallOf(toolName: string, prefixes: Readonly<Record<string, ConnectorId>>): { id: ConnectorId; tool: string } | null
  /** `${p}__*` for every prefix p mapped to an id in `on`; sorted, no duplicates. */
  export function askRules(on: readonly ConnectorId[], prefixes: Readonly<Record<string, ConnectorId>>): string[]
  /** The fixed refusal of a write in an unattended run (Global Constraints). */
  export function unattendedRefusal(id: ConnectorId, tool: string): string
  ```
  New `CONNECTOR_TEXT` keys, exact copy:
  - `cardAccount: 'As connected on claude.ai'`
  - `guardNote: 'Agents read with a connector without asking. Anything that sends, changes or deletes asks you first, and runs started by a routine or workflow may only read.'`
  - `rememberLabel: 'Remember approvals'`
  - `rememberNote: 'Off: every change asks you each time. On: its card also offers Allow for this chat and Allow always for this agent.'`

  `ConnectorCardView` gains `remember: boolean`.

- [ ] **Step 1: Write the failing tests** (`describe('phase 3 helpers')`):
  - `connectorPrefixes([])`: maps `toolPrefix(n)` → id for every name in every catalog entry, e.g. `'mcp__claude_ai_Gmail'` → `'gmail'`. It has no other keys.
  - `connectorPrefixes([{ name: 'claude.ai Gmail (2)', connector: 'gmail' }, { name: 'My GitHub', connector: 'github' }])`: also has `'mcp__claude_ai_Gmail__2_'` → `'gmail'` and `'mcp__My_GitHub'` → `'github'`.
  - With `p` = that map:
    - `connectorCallOf('mcp__claude_ai_Gmail__send_message', p)` deep-equals `{ id: 'gmail', tool: 'send_message' }`.
    - `connectorCallOf('mcp__claude_ai_Gmail__2___send_message', p)` deep-equals `{ id: 'gmail', tool: 'send_message' }` (longest prefix wins).
    - `connectorCallOf('mcp__My_GitHub__create_pull_request', p)` deep-equals `{ id: 'github', tool: 'create_pull_request' }`.
    - Each of these is `null`: `'mcp__claude_ai_Gmailx__send_message'`, `'mcp__claude_ai_Gmail'`, `'mcp__claude_ai_Gmail__'`, `'mcp__zumibot_todos__add'`, `'Bash'`.
  - `askRules(['gmail'], p)` equals the sorted `['mcp__claude_ai_Gmail__2___*', 'mcp__claude_ai_Gmail__*']`, plus `${toolPrefix(n)}__*` for any other Gmail catalog name. `askRules([], p)` equals `[]`. `askRules(['github'], connectorPrefixes([]))` equals `[]`, because GitHub has no catalog name.
  - `unattendedRefusal('gmail', 'send_message')` equals `'Gmail send_message changes data outside this machine. Runs started by a routine or workflow may only read; ask the user to do this in a chat.'`.
  - The returned map is a fresh object. Mutating it does not change the next call's result.
- [ ] **Step 2: Run them and see them fail.** Run: `npx vitest run zumi-bot-server/shared/tests/connectors.test.ts`. Expected: FAIL, `connectorPrefixes is not a function`.
- [ ] **Step 3: Implement the four functions and the new text keys.** Add `remember` to `ConnectorCardView`. The TS errors this causes in the backend and frontend are fixed in Tasks 4 and 7. Until then, set `remember: false` where `connectorsService.list` builds cards and in any test fixture that builds a card view, so typecheck passes.
- [ ] **Step 4: Run.** `npx vitest run --project shared` and `npm run typecheck`. Expected: PASS.

---

### Task 2: ConnectorsService learns catalog server names

**Files:**
- Modify: `zumi-bot-server/backend/src/core/connectors/connectorsService.ts`, `zumi-bot-server/backend/src/app.ts`
- Test: `zumi-bot-server/backend/tests/core/connectorsService.test.ts`, `zumi-bot-server/backend/tests/core/connectorsWiring.test.ts`

**Interfaces:**
- Consumes: `ConnectorServerName` (Task 1); `Loadout.servers[].name` / `.connector` (phase 1).
- Produces:
  ```ts
  class ConnectorsService {
    /** Catalog servers seen in this process's successful home-folder reads (union, insertion order, no duplicates). */
    serverNames(): ConnectorServerName[]
    /** One home-folder read (`loadout(false)`, so a cached one is free) that adds to serverNames; never throws, no-op after stop(). */
    learn(): Promise<void>
  }
  ```

- [ ] **Step 1: Write the failing tests.**
  - After `list(false)` over a loadout with `claude.ai Gmail` (gmail), `My GitHub` (github) and `ordinary` (null), `serverNames()` deep-equals `[{ name: 'claude.ai Gmail', connector: 'gmail' }, { name: 'My GitHub', connector: 'github' }]`.
  - The switch-over's read adds names the same way.
  - `learn()` adds names.
  - A read whose `errors.servers` is set, or which throws, adds nothing and keeps the earlier names.
  - `learn()` after `stop()` reads nothing.
  - `learn()` that throws inside logs `connectors: server names not read` and resolves.
  - Wiring (`connectorsWiring.test.ts`): once the switch-over settles at server start, `learn()` has run once.
- [ ] **Step 2: Run.** `npx vitest run zumi-bot-server/backend/tests/core/connectorsService.test.ts zumi-bot-server/backend/tests/core/connectorsWiring.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the names in a private `Map<string, ConnectorId>`, fed by one private `note(l: Loadout)` that `list`, `runMigration` and `learn` call on a successful read. In `app.ts`, chain `connectors.learn()` after the start-up `migrate()` settles either way, with no await on listen.
- [ ] **Step 4: Run** the same tests. Expected: PASS.

---

### Task 3: The run's ask rules and prefix map

**Files:**
- Modify: `zumi-bot-server/backend/src/core/extensions/agentRunConfig.ts`, `zumi-bot-server/backend/src/app.ts` (the `agentRunConfig` closure, ~line 527)
- Test: `zumi-bot-server/backend/tests/core/extensions/agentRunConfig.test.ts`, `zumi-bot-server/backend/tests/core/connectorsWiring.test.ts`

**Interfaces:**
- Consumes: `connectorPrefixes`, `askRules`, `connectorOf` (Task 1 / phase 1); `ConnectorsService.serverNames()` (Task 2).
- Produces:
  ```ts
  interface AgentRunConfig { /* existing fields */ connectorPrefixes: Readonly<Record<string, ConnectorId>> }
  buildAgentRunConfig(ext, keys, opts?: { serversOff?; skillsOff?; connectorsOff?: readonly ConnectorId[]; connectorServers?: readonly ConnectorServerName[] })
  ```
  - **When `opts.connectorsOff` is given:** `connectorPrefixes = connectorPrefixes([...connectorServers, ...own])`. Here `own` is each of `ext.servers` whose `def.url` gives `connectorOf(def.url, name) !== null`, kept only when `ext.serversEditable` is true. When `opts.serversOff !== false` and `askRules(on, prefixes)` is non-empty, the settings object gets `permissions: { ask: askRules(on, prefixes) }`, where `on` is `CONNECTOR_IDS` minus `connectorsOff`.
  - **Otherwise** (the probe's call), `connectorPrefixes` is `{}` and there are no ask rules.
  - `NO_RUN_CONFIG.connectorPrefixes` is `{}`. `CONNECTORS_ALL_OFF.connectorPrefixes` is `connectorPrefixes([])`, and it has no ask rules. Both stay deep-frozen.
  - `app.ts` passes `connectorServers: connectors.serverNames()` on the Claude branch. Zumi Bot keeps every connector off, so it gets no ask rule.

- [ ] **Step 1: Write the failing tests.**
  - An agent with `connectorsOff` = every id except `gmail`, `connectorServers: [{ name: 'claude.ai Gmail (2)', connector: 'gmail' }]` and an own server `linear` with `url: 'https://mcp.linear.app/mcp'`:
    - its `--settings` JSON has `permissions.ask` equal to `askRules(['gmail'], prefixes)`;
    - that includes `'mcp__claude_ai_Gmail__2___*'` and leaves out any Slack or Linear prefix;
    - `connectorPrefixes['mcp__linear']` is `'linear'`.
  - The same agent with `linear` also on: `'mcp__linear__*'` is in the ask list.
  - `connectorsOff: CONNECTOR_IDS` gives no `permissions` key.
  - With `serversOff: false` there are no ask rules.
  - Without `connectorsOff`, `connectorPrefixes` deep-equals `{}`.
  - `Object.isFrozen(CONNECTORS_ALL_OFF.connectorPrefixes)` is true, and `NO_RUN_CONFIG.connectorPrefixes` deep-equals `{}`.
  - Wiring: a main run's ONE `--settings` (after `oneSettings`) holds both `permissions.ask` (Gmail on) and the vault/connectors guard's `permissions.deny`.
- [ ] **Step 2: Run.** `npx vitest run zumi-bot-server/backend/tests/core/extensions/agentRunConfig.test.ts zumi-bot-server/backend/tests/core/connectorsWiring.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as specified. Fix the other places that build an `AgentRunConfig` literal (tests and fakes) so the field is always present.
- [ ] **Step 4: Run** `npm test` for the backend project and `npm run typecheck`. Expected: PASS.

---

### Task 4: The Remember switch — store, RPC, view

**Files:**
- Modify:
  - `zumi-bot-server/backend/src/core/connectors/connectorStore.ts`
  - `zumi-bot-server/backend/src/core/connectors/connectorsService.ts`
  - `zumi-bot-server/backend/src/rpc/handlers.ts` (~line 1773)
  - `zumi-bot-server/shared/src/types.ts` (`connectors` in `ZumiBotApi`, ~line 740)
  - `zumi-bot-server/frontend/src/net/api.ts`
  - `docs/architecture/data.md`
- Test: `zumi-bot-server/backend/tests/core/connectorStore.test.ts`, `zumi-bot-server/backend/tests/core/connectorsService.test.ts`, `zumi-bot-server/backend/tests/rpc/connectorsHandlers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  class ConnectorStore {
    remembers(id: ConnectorId): boolean
    remembered(): ConnectorId[]                                // CONNECTOR_IDS order
    setRemember(id: ConnectorId, on: boolean): Promise<void>   // same queue, re-read and fixed failure as set()
  }
  class ConnectorsService { setRemember(id: ConnectorId, on: boolean): Promise<void> }   // store write, then onChanged()
  // ZumiBotApi.connectors:
  setRemember(id: ConnectorId, on: boolean): Promise<void>     // RPC 'connectors:setRemember'
  ```
- **File shape.** The file is `{ v: 1, agents, migration, remember: { <id>: true } }`. A missing `remember` reads as `{}`. Inside `remember`, an entry whose key is not a catalog id, or whose value is not `true`, is dropped on read. It does not make the file corrupt. `replace()` (the switch-over) keeps `remember`. The corrupt and unreadable paths behave as in phase 1, so a corrupt file resets `remember` to `{}`.
- **`list()`** sets each card's `remember` from `store.remembers(id)`, including when the probe failed.

- [ ] **Step 1: Write the failing tests.**
  - Store:
    - round trip `setRemember('gmail', true)`, then a reload gives `remembers('gmail') === true`, and the file has `"remember": { "gmail": true }` at mode 0600;
    - `setRemember('gmail', false)` removes the key;
    - a phase-1 file without `remember` loads with every id false;
    - `remember: { gmail: true, nope: true, slack: 'yes' }` loads as gmail only, with no `.corrupt-*` file;
    - `replace({}, 'kept')` keeps `remember`;
    - on an unreadable file, `setRemember` rejects with the same fixed message `set` uses.
  - Service: `list()` shows `remember: true` for gmail after `setRemember('gmail', true)`, and `onChanged` was called.
  - Handlers:
    - `connectors:setRemember('gmail', true)` reaches the service;
    - `'nope'`, `1`, `null` as the id, or `'yes'` as `on`, throws a `TypeError` with no write.
- [ ] **Step 2: Run** those three files. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the `ZumiBotApi`, handler and `api.ts` mapping (the three places). In `docs/architecture/data.md`, document the `remember` field on the `connectors.json` line.
- [ ] **Step 4: Run** the backend tests and `npm run typecheck`. Expected: PASS.

---

### Task 5: The permission step classifies connector calls

**Files:**
- Modify:
  - `zumi-bot-server/shared/src/types.ts` (the `approval` ChatItem, ~line 382)
  - `zumi-bot-server/backend/src/core/chat/chatService.ts` (deps; per-attempt state near `todoBridged`, ~line 1385; `slot.answer`, ~1598; `case 'permissionRequest'`, ~1852; the attempt's `own` read, ~2139)
  - `zumi-bot-server/backend/src/app.ts` (wire the dep)
  - `docs/architecture/agents.md` (remembered approvals)
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts`

**Interfaces:**
- Consumes: `connectorCallOf`, `isReadTool`, `unattendedRefusal` (Task 1); `AgentRunConfig.connectorPrefixes` (Task 3); `ConnectorStore.remembers` (Task 4).
- Produces:
  - On the `approval` item: `connector?: { id: ConnectorId; tool: string; remember: boolean }`. `remember` is the switch at card time. The UI uses it to pick buttons; the server re-reads it on answer.
  - `ChatServiceDeps.connectorRemembers?(id: ConnectorId): boolean`, which `app.ts` wires to `connectorStore.remembers`. When absent, it reads as false.
- **Rules.**
  1. **Where the map comes from.** Each attempt sets `let runPrefixes` from `own.connectorPrefixes`, beside `todoBridged`. On Codex it is always `{}`.
  2. **Where the branch sits.** It goes after the duplicate-id guard (`slot.pending.has(...) || approvalOf(...)`) and before the card code. It runs only when `call = connectorCallOf(e.toolName, runPrefixes)` is not null:
     - `isReadTool(call.id, call.tool)` → `reply(allowResponse(...))`, with no item and no card;
     - otherwise, if `spec.auto` → `reply(denyResponse(e.requestId, unattendedRefusal(call.id, call.tool)))`, with no item and no card;
     - otherwise the card path continues with `remembering = this.d.connectorRemembers?.(call.id) === true`.
  3. **Memory in the card path.** For a connector call, chat memory (`this.allowed`) and agent rules (`agentRules`) auto-allow only when `remembering` is true. Workflow step rules never do. The card is stamped `connector: { id, tool, remember: remembering }`. The pending entry keeps `connector: call.id`.
  4. **On answer.** For a pending connector entry, `allow-step` becomes `allow-once`, and so do `allow-chat` and `allow-agent` unless `connectorRemembers(id)` is true at answer time. The status line follows the kept decision, so no rule or chat key is stored.
  5. **Everything else is unchanged**: non-connector tools, the stop path (`r.reason`), and Jev's risk hint, which still runs for connector write cards.

- [ ] **Step 1: Write the failing tests.**
  - **Harness.** Use a fake `agentRunConfig` dep that returns `{ ...NO_RUN_CONFIG, connectorPrefixes: connectorPrefixes([]) }` and a `connectorRemembers` dep backed by a Set. Script the fake CLI with `control_request` `can_use_tool` lines.
  - **Each case:**
    1. Attended turn, `mcp__claude_ai_Gmail__search_threads` → the response is allow, and no `approval` item exists.
    2. Attended turn, `mcp__claude_ai_Gmail__send_message` → a pending card with `connector` deep-equal to `{ id: 'gmail', tool: 'send_message', remember: false }`. Answering `allow-agent` gives status `allowed-once`, and `agentRules.has` stays false. Answering `allow-step` on another such card gives `allowed-once`.
    3. With gmail in the remember Set: the card has `remember: true`. `allow-agent` gives `allowed-agent` and a stored rule. In the next turn, the same tool is `auto-allowed-agent`.
    4. A rule stored as in case 3, then gmail removed from the Set → the next call is a pending card, and the rule is still stored.
    5. With remember off, an earlier `allow-chat` key for the tool (put in by a test helper) → still a pending card.
    6. An `auto` turn (`send(..., auto=true)`):
       - `send_message` → the response is deny with message `unattendedRefusal('gmail', 'send_message')`, and no `approval` item;
       - `search_threads` → allow;
       - `mcp__claude_ai_Gmail__brand_new_tool` → deny with `unattendedRefusal('gmail', 'brand_new_tool')`.
    7. Attended turn, `brand_new_tool` → a pending card.
    8. A Codex turn's `mcp__claude_ai_Gmail__send_message` request → the old path: a card with no `connector` field, and `allow-agent` is kept.
    9. `mcp__other__do` → the old path, unchanged.
- [ ] **Step 2: Run.** `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts -t connector`. Expected: FAIL.
- [ ] **Step 3: Implement the rules.** In `docs/architecture/agents.md`'s remembered-approvals text, add: a connector write is remembered only while that service's Remember switch is on, and its earlier rules are inert while it is off.
- [ ] **Step 4: Run** the whole backend project. Expected: PASS.

---

### Task 6: "Unattended" reaches rooms and asked turns

**Files:**
- Modify:
  - `zumi-bot-server/backend/src/core/chat/taskQueue.ts` (`launch`, ~line 475; the `withAuto` comment)
  - `zumi-bot-server/backend/src/core/chat/groupService.ts` (`send` 257, `post` 378, `enter` 429, `interface Room` 82, member `TurnSpec` ~790–830)
  - `zumi-bot-server/backend/src/core/asks/askIpc.ts` (`AskOwner`)
  - `zumi-bot-server/backend/src/core/asks/askService.ts` (`AgentAsksDeps.run`, the call ~line 55)
  - `zumi-bot-server/backend/src/core/chat/chatService.ts` (`runAsked` 953, `askedTurn` extra, `askTurn({...})` ~2152)
  - `zumi-bot-server/backend/src/app.ts` (if the `run` wiring needs the field)
  - `docs/architecture/agent-asks.md`
- Test: `zumi-bot-server/backend/tests/core/taskQueue.test.ts`, `groupService.test.ts`, `askService.test.ts`, `chatService.test.ts`

**Interfaces:**
- **Rooms.**
  - `GroupService.send(chatId, text, attachments?, replyTo?, messageId?, command?, todo?, workflowSent?, auto?: true)`.
  - `TaskQueue.launch` passes `auto` to rooms too, keeping the "no trailing undefined" rule: a call without it is unchanged.
  - `Room.unattended: boolean`. The message that opens the room sets it to `auto === true`. A message joining an open room sets it to `room.unattended && auto === true`. Resume and edit/resend posts carry no `auto`.
  - A member's `TurnSpec` gets `auto: true` while `room.unattended` is true.
- **Asks.**
  - `AskOwner.auto?: true`, set from the asking turn's `spec.auto`.
  - `AgentAsksDeps.run` and `ChatService.runAsked` take `o.auto?: true`.
  - `askedTurn` puts `auto: true` in `extra` when set.
  - The asked turn's own asks inherit it through its `spec.auto`.

- [ ] **Step 1: Write the failing tests.**
  - **taskQueue:** a `'routine'` submit to a room reaches `groups.send` with `auto` true. A user submit's `groups.send` call has the same arguments as before.
  - **groupService:**
    - a room opened by an `auto` message → every member turn's spec has `auto: true`, including turns after an @mention hand-off;
    - a user message joining that open room → later member turns have no `auto`;
    - a user-opened room never has it;
    - Resume never has it.
  - **askService:** an owner with `auto: true` → `run` gets `auto: true`. Without it, there is no `auto` key.
  - **chatService:**
    - `runAsked(..., { ..., auto: true })` → the asked turn refuses `mcp__claude_ai_Gmail__send_message` with `unattendedRefusal`;
    - in an `auto` turn, the owner passed to the `askTurn` dep has `auto: true`.
- [ ] **Step 2: Run** those four files. Expected: FAIL.
- [ ] **Step 3: Implement.** In `docs/architecture/agent-asks.md`, add one line: an asked turn whose asker is unattended is unattended too (connector writes refused), down the whole ask chain.
- [ ] **Step 4: Run** the backend project. Expected: PASS.

---

### Task 7: UI — connector cards and the Remember switch

**Files:**
- Modify:
  - `zumi-bot-server/frontend/src/state/approvals.ts`
  - `zumi-bot-server/frontend/src/components/ApprovalCard.tsx`
  - `zumi-bot-server/frontend/src/state/connectors.ts`
  - `zumi-bot-server/frontend/src/components/ConnectorsSettings.tsx`
  - `zumi-bot-server/frontend/src/styles.css`
- Test: `zumi-bot-server/frontend/tests/approvals.test.ts`, `zumi-bot-server/frontend/tests/connectors.test.ts`

**Interfaces:**
- **Buttons.** `approvalChoices(toolName, o?: { step?; input?; voice?; connector?: { remember: boolean } })`. When `o.connector` is given: `chat` and `agent` are false unless `o.connector.remember`, and `step` is always false.
- **Summary.** `connectorSummary(item: ApprovalItem): string | null` gives `` `${connectorById(id).name} · ${tool}` `` for a connector card, and null otherwise.
- **Optimistic flip.** `withRemember(view: ConnectorsView, id: ConnectorId, on: boolean): ConnectorsView` sets that card's `remember`, as `withSwitch` does for agents.
- **Card.** A connector card shows the summary as its head, a line `CONNECTOR_TEXT.cardAccount` (`data-testid="approval-connector"`) and the input panel open by default. Its buttons come from `approvalChoices(..., { connector })`. Every other card is unchanged.
- **Page.**
  - `CONNECTOR_TEXT.guardNote` sits under the intro (`data-testid="connector-guard-note"`).
  - Each card gets a `Switch` (the one exported from `AgentLoadout.tsx`) labelled `rememberLabel`, with `rememberNote` under it (`data-testid="connector-remember"`, `aria-checked`).
  - A flip shows at once; a failure reloads the view and shows the error, as agent switches do.

- [ ] **Step 1: Write the failing tests.**
  - `approvalChoices('mcp__claude_ai_Gmail__send_message', { connector: { remember: false }, step: true })` deep-equals `{ chat: false, agent: false, step: false }`.
  - With `remember: true` it deep-equals `{ chat: true, agent: true, step: false }`.
  - Without `connector` the result is unchanged.
  - `connectorSummary` gives `'Gmail · send_message'` for a stamped card and null for an unstamped one.
  - `withRemember` flips only the named card and returns a new object.
- [ ] **Step 2: Run.** `npx vitest run --project frontend`. Expected: FAIL.
- [ ] **Step 3: Implement** the helpers, the card variant, the page switch and the note.
- [ ] **Step 4: Run** the frontend project, `npm run typecheck` and `npm run build:server`. Expected: PASS.

---

### Task 8: E2E checks, the real-CLI probe check, and the connectors doc

**Files:**
- Modify:
  - `zumi-bot-server/e2e/connectors.e2e.mjs`
  - `zumi-bot-server/e2e/connectorsProbe.mjs`, `zumi-bot-server/e2e/connectorsProbe.d.mts`
  - `zumi-bot-server/backend/tests/connectorsProbe.test.ts`
  - `docs/architecture/connectors.md`, `docs/architecture/e2e.md`
  - `zumi-bot-server/backend/tests/fixtures/fake-probe-claude.mjs` (only if the probe test needs a new mode)
- Test: `npm run e2e:connectors`, `npx vitest run zumi-bot-server/backend/tests/connectorsProbe.test.ts`

**E2E checks** (numbering continues the suite's). Drive turns as the suite does today: `FAKE_EXT_ALLOW_TURN` runs `fake-claude.mjs` with a script of `control_request` `can_use_tool` lines and `#WAIT_RESPONSE`. Read the answers from `FAKE_RESPONSES_FILE`.

- **Ask rules.** The run's one `--settings` has `permissions.ask` with `mcp__claude_ai_Gmail__*` for an agent with Gmail on, has no Slack prefix when Slack is off, and still has the file guard.
- **Read.** In an attended chat, a Gmail read is answered allow and no card appears.
- **Write card.** A Gmail write shows a card with `approval-connector` text `As connected on claude.ai`, head `Gmail · send_message`, and the input visible. It has `approval-allow-once` and `approval-deny`, and no `approval-allow-chat`, `approval-allow-agent` or `approval-allow-step`. Allow once answers allow.
- **Remember.** Turn on `connector-remember` for Gmail, and `connectors.json` gets `remember.gmail === true`. A new write card offers `approval-allow-agent`. Pressing it makes the next turn's same call `auto-allowed-agent`.
- **Unattended.** A routine's Run now whose script asks for a Gmail read then a Gmail write: the read is answered allow, and the write is answered deny with the exact refusal sentence. No pending card is ever shown in that chat.

**Probe check** (`ask`; real CLI, Haiku, run only with the user's yes):
- **Setup.**
  - Pick the first connected catalog connector the CLI lists that has a catalog read tool in its listed tools, preferring Gmail `list_labels`, then Google Calendar `list_calendars`, then Slack `slack_search_channels`, then Google Drive `list_recent_files`.
  - Run `-p --permission-mode auto --permission-prompt-tool stdio` in stream-json, with `--settings` set to `{ permissions: { ask: ['<prefix>__*'], allow: ['<prefix>__<read tool>'] } }`, and a prompt to call that read tool once.
  - Model the run on `desktopAskProbe.mjs`.
- **Verdicts.**
  - PASS: a `can_use_tool` for that tool arrives. The probe answers deny, so nothing is read.
  - FAILED: its tool result arrives with no `can_use_tool` first.
  - INCONCLUSIVE: anything else, after one retry.
- **Merged run.** The existing merged-settings check's settings gain `permissions.ask` for every connected connector, and it still asserts the file deny rule is in effect.
- **Output.** Print no token, tool payload or URL beyond its host.
- **Unit test.** It covers the three verdicts against the fake.

**Docs.**
- `connectors.md`:
  - the status line now says phases 1 and 3 are built;
  - a **Built (phase 3)** section after "Built (phase 1)" covers what this plan does, the calls listed above, the name-learning gap and the probe result line (filled after Task 9);
  - the phase 3 heading says built, see Built (phase 3);
  - remove "Nothing of phase 3 is built" from phase 1's calls paragraph;
  - Open question 4 is marked settled.
- `e2e.md`: the new suite checks and the probe's `ask` check.

- [ ] **Step 1: Write the probe's unit test** for the three verdicts. Run it and see it fail.
- [ ] **Step 2: Implement the probe check.** Run the unit test. Expected: PASS.
- [ ] **Step 3: Add the e2e checks.** Run `npm run e2e:connectors`. Expected: every check PASS, including the existing ones.
- [ ] **Step 4: Update the two docs.**

---

### Task 9: Verify, then stop for review

- [ ] **Step 1:** Run `npm test`, `npm run typecheck`, `npm run build:server`, and the e2e suites touched: `npm run e2e:connectors`, `npm run e2e:extensions`, `npm run e2e:ask`, plus the rooms and workflows suites named in `docs/architecture/e2e.md`. Expected: all PASS. Name any failure that also fails on HEAD (e.g. `e2e:computer`) as pre-existing; do not fix it here.
- [ ] **Step 2:** Ask the user before using their real accounts. Then run `npm run e2e:connectors-probe` and record the `ask` verdict in `connectors.md`.
- [ ] **Step 3:** Hand check, also only with the user's yes. Run the new build on a throwaway data dir with the user's agents copied in, as in phase 1. Every card is denied, so nothing on the account changes.
  - In a chat with an agent that has Gmail on, ask for a search: no card.
  - Ask it to draft an email: a card offering Allow once and Deny only. Press Deny.
  - Run a routine whose prompt asks the same agent to draft an email: the run reports the refusal, and no card waits.
- [ ] **Step 4:** Stop and report to the user:
  - what changed;
  - what could not be verified;
  - for each catalog service, whether it works on route A, route B or neither;
  - the calls listed above.

  Do not start phase 2.
