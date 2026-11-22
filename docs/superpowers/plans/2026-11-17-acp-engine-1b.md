# ACP engine (Phase 1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run an agent whose file says `provider: acp` through Agent Client Protocol v1 (stable) as a third engine, with every feature it lacks hidden through `EngineCaps`.

**Architecture:**
- Hand-written, defensive modules in `backend/src/core/acp/`: JSON-RPC lines, update mapping, tool classification, answers and elicitation.
- An `acpRunner` that returns the shared `RunHandle`, and an `acpEngine` adapter.
- `Engine` gains `'acp'`. Every exhaustive switch from Phase 1a gets its `acp` case.
- Six new caps are added and read by the UI and handlers.
- Launch trust (`protocol-launch.json`) and `acp.authEnv` follow the design.

**Tech Stack:** TypeScript 5, Node 22 (`node:child_process`, process groups), vitest, React 19. No new dependency.

**Spec:** `docs/architecture/protocol-engines.md` (ACP sections, the capability table, "Where protocol agents can be used", the
session-id rules). Read it whole before any task.

## Global Constraints

- ACP v1 stable only: `protocolVersion: 1`, and no unstable methods (`session/fork`, cursors, `_meta` vendor keys).
- Client capabilities are exactly `fs: {readTextFile: false, writeTextFile: false}`, `terminal: false`,
  `auth: {terminal: false}`, `elicitation: {form: {}}` and `session: {}`.
- Never select `allow_always` or `reject_always`. Never call `session/set_mode`, `session/set_config_option` or `authenticate`.
- Refused arguments, from the design's list, block both save and run. Refused modes and config values end the turn.
- Secrets never go in logs, URLs or errors. Errors name the env var (`authEnv`), never its value. Args are never logged.
- Claude and Codex behaviour is unchanged. Their tests and fixtures pass unchanged apart from imports.
- A new API method touches `ZumiBotApi` (`shared/src/types.ts`), `rpc/handlers.ts` (every argument validated),
  `frontend/src/net/api.ts`, and the method list in `backend/tests/rpc/handlers.test.ts`.
- Never commit. Work in the worktree `.claude/worktrees/engine-seam-1a`. Run `npm run build:server` once before `npm test`:
  `app.test.ts` needs `dist/`.
- Comments are short and say why. Fixed user-facing sentences live in `shared/`.

## Review Focus

1. **Stop with a permission card open.** Answer `cancelled`, send `session/cancel`, and leave no process of the agent's group
   behind, even a grandchild `sleep`.
2. **A crash mid-turn** (exit 1 after one text chunk). The partial text is kept, the error item shows the stderr tail, and the
   next send resumes or reseeds; it never hangs.
3. **A resume of a session the agent no longer has** (`-32002`, or any error on `session/resume` / `session/load`). The turn
   reseeds once, with the `expired` notice.
4. **An agent whose session reports a `bypassPermissions` mode** (`current_mode_update` mid-turn). The turn ends with the fixed
   sentence, and no further tool call is approved.
5. **An agent file changed outside Agent Studio** (command, args or `authEnv`). The run is refused until it is saved in Agent
   Studio, and the Test button refuses it too.

---

### Task 1: Shared ACP vocabulary and the agent file key

**Files:** Create `shared/src/acp.ts`; modify `shared/src/frontmatter.ts`; tests `shared/tests/acp.test.ts`,
`shared/tests/frontmatter.test.ts`.

**Produces:**
- `interface AcpLaunch { command: string; args: string[]; authEnv: string[] }`
- `parseAcpLaunch(v: unknown): AcpLaunch | null`. Null when `command` is not a non-empty string of at most 4096 characters with
  no NUL. `args` is at most 64 strings of at most 4096 characters, with no NUL. `authEnv` holds names that pass
  `envNameError`, at most 16 of them.
- `refusedArg(args: readonly string[]): string | null` returns the refused flag. The list is the design's: `--yolo`, `-y`,
  `--approval-mode yolo`/`--approval-mode=yolo`, `--dangerously-skip-permissions`,
  `--dangerously-bypass-approvals-and-sandbox`, `--permission-mode bypassPermissions|dontAsk` (both spellings),
  `--allow-all-tools`, `--trust-all-tools`, `--auto-approve`, `--force` and `-f`.
- `refusedMode(id: string): boolean`: the exact ids `bypassPermissions`, `dontAsk`, `yolo`, or any id whose lower case
  contains `bypass`, `yolo` or `dangerous`.
- `launchRecord(l: AcpLaunch): string`: a stable JSON of the three fields, for launch trust.
- `ACP_TEXT`: the fixed sentences.
  - notFound(command)
  - notSignedIn(methods)
  - protocol
  - unreadable: "The agent sent a reply ZumiBot could not read"
  - refusedArg(flag)
  - refusedMode(id)
  - untrusted
  - authEnvMissing(name)
  - noImages
  - stopped(code)
  - stopReason(reason)
- `AgentFields.acp: AcpLaunch | null`. Parsed from the `acp:` key, and written by `serializeAgent` as a nested map (as
  `plugins` is). `null` deletes the key. A file whose `acp:` does not parse keeps it untouched, as `mcpServers` does.

- [ ] Tests:
  - parse: valid, each invalid shape, NUL, too long, a bad env name;
  - `refusedArg` for every listed spelling, and `--approval-mode default` not refused;
  - `refusedMode`: `bypassPermissions`, `BYPASS_x`, `default`, `plan`, `auto`;
  - frontmatter round-trip of `acp:`, and a Save of another field keeps `acp:` byte for byte.
- [ ] Implement.
- [ ] `npx vitest run --project shared` passes.

### Task 2: Pure ACP modules (backend)

**Files:** Create in `backend/src/core/acp/` `acpRpc.ts`, `acpTools.ts`, `acpEvents.ts`, `acpAnswers.ts`, `acpElicitation.ts`,
and `CLAUDE.md` (a pointer to `docs/architecture/protocol-engines.md`). Tests go in `backend/tests/core/acp*.test.ts`.

**Consumes:** `RunEvent` (`core/chat/streamParser.ts`), `UserContent` (`controlProtocol.ts`), `parseQuestions` and
`QUESTION_TOOL` (`shared/src/questions.ts`).

**Produces:**
- **`AcpRpc`**, modelled on `codexRpc.ts` but JSON-RPC 2.0: every message carries `"jsonrpc":"2.0"`.
  - `request(method, params)`, `notify`, `respond`, `respondError` and `receive(line) → incoming | null`. A response settles
    its promise. A non-object or non-JSON line returns null and is counted in `malformed`.
  - `close(err)`.
- **`classifyTool(tc: {kind?, title?, rawInput?, content?, locations?}, root: string): { toolName, input, rememberable: boolean }`**,
  following the design's table:
  - `execute` with a string `rawInput.command` → `Bash {command}`;
  - `edit` / `delete` / `move` → `AcpEdit {paths, diffs}`, each diff cut at 4000 characters and 20000 per card. `rememberable`
    only when every path is inside `root`;
  - `read` / `search` → `AcpRead`;
  - `fetch` → `AcpFetch`;
  - anything else → `AcpCall {title, rawInput}` with `rememberable: false`.
- **`AcpEventMapper`.** `update(u) → RunEvent[]`, `turnEnd() → RunEvent[]` (flushes text and thought). It joins text runs into
  `assistantText`, thought runs into `thinking`, and maps `tool_call` / `tool_call_update` to `toolUse` / `toolResult`.
  - A completed edit's `detail` is `{ acpDiffs: [{path, oldText: string | null, newText}] }`.
  - `plan` becomes a `Plan` toolUse plus toolResult (a markdown checklist).
  - `usage_update` becomes `context {model: null, tokens: used}`, with `size` remembered for `windows`.
  - `current_mode_update` and `config_option_update` come back through `onMode(id)` for the refused-mode check.
  - Unknown kinds are ignored.
- **`acpPermissionAnswer(controlResponse, options) → {outcome}`**:
  - allow → `allow_once`, else `cancelled`;
  - deny → `reject_once`, else `cancelled`;
  - anything else → `cancelled`.
- **`elicitationQuestions(params) → AskUserQuestion input | null`** and **`elicitationAnswer(controlResponse, params) → {action, content?}`**:
  - an enum / oneOf string → choice;
  - a boolean → choice of Yes / No;
  - an array of an enum → multiSelect;
  - a string → text;
  - a number or integer → number, with min and max.

  A nested or unknown schema gives null (the caller declines at once).

- [ ] Write the tests first: one per mapping row in the design's ACP message map and classification table; a JSON-RPC
  error-code test; the elicitation round trip; a malformed line.
- [ ] Implement.
- [ ] `npx vitest run zumi-bot-server/backend/tests/core/acp*.test.ts` passes.

### Task 3: Fake agent, runner and adapter

**Files:**
- Create `backend/tests/fixtures/fake-acp-agent.mjs`, `backend/src/core/acp/acpRunner.ts`,
  `backend/src/core/acp/acpLocator.ts` and `backend/src/core/engines/acpEngine.ts`.
- Tests: `backend/tests/core/acpRunner.test.ts`, `backend/tests/core/acpEngine.test.ts`.
- Modify `core/engines/engine.ts`: `locate(agent?: string)`. Claude and Codex ignore the argument.

**The fake** (`FAKE_ACP_SCRIPT` JSON).
- `initialize` caps and authMethods; `loadSession` / resume support; `failNew: -32000`; replay lines for `session/load`.
- Per-prompt steps: `text`, `thought`, `toolCall`, `toolUpdate`, `permission` (waits for its answer), `elicitation`, `usage`,
  `mode`, `sleep`, `hold` (spawns a child `sleep 60` in its group), `crash` (exit 1), `malformed`, `stopReason`.
- It honours `session/cancel` by answering the prompt `cancelled`.
- `FAKE_ACP_LOG` gets every message received; `FAKE_ACP_PIDS` gets the pids.

**Produces `startAcp(o: AcpRunOptions): RunHandle`.**
- `o = {bin, args, cwd, env, start: {kind:'new'} | {kind:'resume', sessionId}, prompt: UserContent, systemPrompt: string,
  requestTag, killGraceMs?, killForceMs?, maxLineBytes?, onEvent}`.
- Spawn with `detached: true`, then `initialize`. Refuse a `protocolVersion` other than 1 (`ACP_TEXT.protocol`).
- **Starting the session.**
  - New: `session/new {cwd, mcpServers: [], systemPrompt?}`. When `sessionCapabilities.systemPrompt` is absent, the text
    leads the prompt as a preamble instead.
  - Resume: `session/resume` when advertised, else `session/load` with replay discarded until its response, else
    `outcome.missingSession`. Any error there also sets `missingSession`.
- **Events.** `init {sessionId, version}`; the mapped events; refused modes. Images go as `image` blocks only when
  `promptCapabilities.image`; else the run fails with `ACP_TEXT.noImages`.
- **Requests.**
  - `session/request_permission` → `permissionRequest`, with `requestId` set to `<tag>:<id>` and the classified tool.
  - `elicitation/create` with form mode → an `AskUserQuestion` `permissionRequest`, or an immediate decline when no card
    maps.
  - Anything else → `-32601`.
  - `send(controlResponse)` answers only ids carrying its tag.
- **The prompt's response.**
  - `end_turn` → `result` success.
  - `cancelled` → stopped.
  - `max_tokens` / `max_turn_requests` / `refusal` → `result` isError, with `stderr` set to `ACP_TEXT.stopReason`.
- **Stop.** `session/cancel`; every pending request answered `cancelled`; a grace (5 s) for the prompt's response; then close
  stdin, `SIGTERM` to `-pid`, then `SIGKILL` to `-pid`.
- **Ending.** A line over `maxLineBytes` (8 MiB) or an unreadable reply to its own request kills the group, with `spawnError`.
  `-32000` gives `spawnError` `ACP_TEXT.notSignedIn`. `stderr` keeps a 64 KiB tail.

**`acpEngine({caps, locate, run})`** is an `EngineAdapter<AcpTurnConfig>`.
- `AcpTurnConfig = {args, systemPrompt, requestTag}`.
- It translates `TurnStart`: `new` → new, `resume` → resume, `fork` → never (it throws: the caller reseeds, since `rewind` is
  off).

**`acpLocate(command, env)`** resolves a bare name on the run env's `PATH`, or checks that an absolute path is executable.

- [ ] Write the tests first, against the fake:
  - text, thinking, a tool call with a diff;
  - a permission allowed and denied (the option chosen is checked in `FAKE_ACP_LOG`);
  - an elicitation answered;
  - resume and load (replay hidden), plus a missing session;
  - auth required, crash mid-turn, a malformed line, an oversize line;
  - refused mode;
  - Stop with a card open, after which no pid in `FAKE_ACP_PIDS` is alive;
  - a preamble when `systemPrompt` is unsupported;
  - images refused.
- [ ] Implement.
- [ ] Tests pass.

### Task 4: `acp` as an engine: caps, the turn, launch trust, `authEnv`

**Files:**
- `shared/src/engine.ts` (`Engine`, `PROVIDERS`, `ENGINE_LABEL` `acp: 'ACP'`, `ACP_CAPS`, the six new caps on every engine,
  refusal texts).
- `chatService.ts` (every switch gets its `acp` case), `app.ts` (deps, `baseFor` → null for acp),
  `core/files/fileChanges.ts` (`FileTracker.ownAcp(tool, detail)` turns `acpDiffs` into `FileChange`s).
- The extensions switches (an ACP agent gets no loadout probe: a fixed `acpUnsupported` section text).
- New `backend/src/core/acp/launchTrust.ts`: a `<data>/protocol-launch.json` 0600 store with `confirm(agent, record)`,
  `check(agent, record) → 'ok' | 'changed' | 'none'`, `rename`, `remove`, and a queue for writes.
- `rpc/handlers.ts` `agents:save`: an ACP save with a refused arg is rejected (`ACP_TEXT.refusedArg`); otherwise the launch is
  confirmed. The rename and removal pipelines move or drop the entry.

**New caps:** `resend`, `fork`, `cost`, `models`, `remote`, `bridges`.
- Claude and Codex: true, except `remote: false`.
- ACP: the design's column. In short, true only for `files`, `rooms` and `questions`.

**The turn for an ACP agent** (in the `acp` cases).
- **Launch.** Read from the agent file per attempt. Refused when not trusted (`ACP_TEXT.untrusted`) or holding a refused arg.
- **Locate.** `acpLocate`.
- **Env.** The base run env with `ZUMIBOT_*` stripped, plus each `authEnv` name's granted Vault value: from
  `vaultEnvOf(grantedTo(agent))`; a missing one fails the send with `ACP_TEXT.authEnvMissing(name)`. Those values join the scrub
  map.
- **Bridges.** None (`!caps.bridges` skips todo, vault, ask, browser and process; desktop is already off). No model, effort or
  tmp dir.
- **System prompt.** The agent body plus the turn's system text (no bridge paragraphs) as `systemPrompt`.
- **Prompts.** `promptReached` = `attemptSession !== null`. `sessionGone` = `outcome.missingSession`.
- **Other cases.** `pauseReady` false. The fork-ignored text is never reached. The side base is none.
- **Questions denied.** In A→B chats and task chats (`questionsDenied`), an elicitation is declined.

- [ ] Tests (chatService with the fake via the `run` deps, as the Codex tests do):
  - a turn records `sessionEngine: 'acp'`;
  - a resume is followed by a reseed on `missingSession`;
  - the approval card path goes through rules (Allow always for this agent auto-allows the next `AcpRead`; an `AcpCall` never
    does);
  - `authEnv` reaches the env and is scrubbed;
  - a run is refused when the launch is untrusted;
  - `launchTrust` unit tests.
- [ ] `npm run typecheck` and `npm test` pass.

### Task 5: Reading the new caps (UI and handlers)

- **resend / fork.**
  - Hidden: `ChatView` passes `chatCaps` to `MessageList`, and `UserMessageActions` / `MessageActions` drop Edit, Resend and
    Fork when the cap is off. The `VersionSwitcher` hides.
  - The engine chip tooltip lists what the engine can't do.
  - `chatCaps` treats `resend`, `fork` and `cost` like `pause` (every member).
  - Server: `refuseWithout` on `chats:edit`, `chats:resend`, `chats:switchVersion` and `chats:fork`, with `RefusedCap` gaining
    `resend` and `fork`, and `capRefusal` texts.
- **models.** `modelPicker` returns null when `!caps.models`. `chats:setModel` is refused by `modelFits` (`acp` → false).
- **cost.**
  - `AgentForm` hides the daily cap when `!caps.cost`, and `agents:save` refuses a `dailySpendCap` on such an engine.
  - `routineEditing.save` / `workflowEditing.save`, and Zumi Bot's authoring path, refuse a `spendCap` whose routine or
    workflow steps use an agent without `cost`, with a fixed sentence naming the agent.
- **bridges.**
  - `givableAgents`, `TodoAttempts`' `usable` and the backend `TaskCards.assign` / `AttemptSets.start` exclude or refuse agents
    without `bridges`.
  - The ask tool is not offered to a chat whose agent lacks `bridges`; an ACP agent may still be asked.
- [ ] Frontend unit tests for each pure rule. Handler tests for each refusal.

### Task 6: Agent Studio, `agents:testAcp`, Zumi Bot

- **Engine select.** It offers **ACP agent**.
- **The ACP card.** Command, Arguments (one per line) and Sign-in keys (`authEnv`, picked from the API keys granted to this
  agent), with the design's notes.
  - It hides the model, tools, Compact at, daily cap, loadout, memory and desktop cards through caps.
  - It shows the confirmed launch beside the file's current one when they differ.
- **`agents:testAcp(name)`** checks the name as `agents:save` does. It runs the saved file's launch only when it is trusted. It
  spawns in a temporary empty folder, sends `initialize`, ends the group, and has a 20 s deadline.
  - It returns `{agentInfo, protocolVersion, loadSession, resume, systemPrompt, image, authMethods (names and terminal hints), caps, hidden: string[]} | {error}`.
  - It never calls `session/new`.
- **Zumi Bot.** Its prompt writes `provider: acp` only when asked, and never `acp:`.
- [ ] Tests: the handler (refused when untrusted, a fake agent's initialize answer), `engineChoices` with acp, and the form's pure
  rules.

### Task 7: Rooms with an ACP member

- `GroupService` runs an ACP member through `agentTurn` with `engine: 'acp'`, and the room briefing goes in `systemPrompt`.
- Room rewinds: a room with an ACP member offers no Edit, Resend or Fork (Task 5). A member's `sessionEngines` mark is `acp`.
- [ ] A `groupService` test with an ACP member answering through the fake.

### Task 8: E2E, smoke run, docs

- **`e2e:acp`.** `zumi-bot-server/e2e/acp.e2e.mjs`, run with the harness option `fakeAcp`. Each check goes through the UI:
  - a chat, a card answered, a question answered;
  - Stop with a card open, then no process left;
  - a crash, and a reseed after a failed load;
  - no Edit, Resend or Fork;
  - a refused launch after an outside edit;
  - a room with an ACP member.
- **`smoke:acp`.** An opt-in run against a real agent named by `ZUMIBOT_SMOKE_ACP` (`<command> <args…>`), never part of
  `npm run e2e`.
- **Docs.**
  - `protocol-engines.md` marked built, with its limits.
  - `codex.md` and `agents.md` (the Engine select), `data.md` (`protocol-launch.json`), `e2e.md`, `vault.md` (`authEnv`) and
    `chat-mode-and-effort.md`.
  - `core/acp/CLAUDE.md`.
- [ ] `npm run build:server`, `npm test`, `npm run typecheck` and `npm run e2e:acp` all pass.
