# Codex as an agent provider: design

Date: 2026-11-09. Written after a short conversation with the user. **(user)** marks what the user asked for or decided. **(seen)** marks a proposal of mine that the user read and accepted ("Write the spec") without changing it. It is still my call, but they have read it. Everything else is my call and can be changed.

Facts about Codex in this document come from the installed `codex-cli 0.164.0`: its `--help` output, `codex features list`, a real `codex exec --json` run, and the app-server protocol bindings from `codex app-server generate-ts`. Anything that only a live run can settle is a Phase 0 probe check, not an assumption.

## Why

Everything in ZumiBot runs on the `claude` CLI. The user asked what it would take to use other providers, "like using codex instead of claude or with it" **(user)**. The answer they accepted **(seen)**: make Codex a second agent provider, so an agent file can say it runs on Codex, behind the same chat UI, in phases, starting with a probe of the real Codex CLI.

## Goals

1. **An agent can run on Codex (seen).** A new ZumiBot-only frontmatter key, `provider: codex`, picks the engine. Absent means Claude, so every existing agent stays exactly as it is.
2. **The same chat UI (seen).** A Codex agent's chat streams text, shows tool rows and approval cards, and supports Stop, the to-do list, usage, limit waits and the context meter, through the existing `RunEvent` union. Downstream code (`ChatService`, the items feed, the UI) should not care which engine produced an event.
3. **Claude and Codex side by side (user: "or with it").** Both kinds of agents live in the same agents folder and sidebar. A Claude agent can ask a Codex agent (Agent asks) and the other way round, in Phase 1 if the probe allows it.
4. **Phased (seen).** Phase 0 probes the real CLI. Phase 1 ships single chats with the features listed below. Phase 2 adds rewinds, Compact, side questions and question cards. Phase 3 adds the features that rely on hooks (Pause, the vault guard, computer use), the Dispatched agents and Files panels, and rooms.
5. **Features that cannot work yet are off, visibly (seen).** The Pause button, `/btw`, computer use and the Files panel are hidden or refused with a fixed sentence for a Codex chat until their phase lands. Nothing is silently broken.

## Non-goals

- **Moving ZumiBot's own one-off model calls to Codex.** The moderator, the room summary, workflow LLM and Condition steps, Jev and every other bare `claude -p` call stay on Claude. A `provider` per workflow step could come later.
- **Zumi Bot on Codex.** Zumi Bot stays a Claude agent; its file is written by the server.
- **Other providers (Gemini, local models).** The seam is built so a third engine could be added, but only Codex is designed here. (Codex's own `--oss` mode is not wired either.)
- **A ZumiBot screen for OpenAI keys or Codex login.** The user signs in with `codex login` on each machine, as they do with `claude` today. ZumiBot never handles OpenAI credentials.
- **Syncing Codex sessions between the PC and the VPS** (`~/.codex/sessions`). A Codex chat continued on the other machine reseeds from its visible messages, the existing fallback for a missing session.
- **Codex's own memories feature** (`memories`, off by default). `memory: user` stays a Claude feature.
- **Keep warm and the cold-context notice for Codex.** Both are built on Claude's one-hour prompt cache. OpenAI caches prompts on its own terms.

## Anti-goals

These would make the work a failure even if Codex chats run:

- **Any change to what a Claude run receives.** The Claude argv, env and stdin must stay byte for byte as they are today, so the prompt cache, the probes and every e2e suite keep their meaning. A test pins this (see Testing).
- **Running Codex with approvals or the sandbox bypassed.** Never `--dangerously-bypass-approvals-and-sandbox`, never sandbox `danger-full-access`, and never `approvalPolicy: never`. This mirrors the existing rule against `--dangerously-skip-permissions`.
- **Turning on a security feature for Codex on trust.** Pause, the vault guard and computer use's forced cards rest on hook and ask-rule behaviour that is proven against the real Claude CLI. They stay off for Codex agents until a probe proves the Codex equivalent.
- **Secrets in logs.** Codex tokens and the contents of `~/.codex/auth.json` never reach logs, errors or the UI, like every other secret here.

## Constraints

- Node 22, npm workspaces, exact pinned dependencies. No new runtime dependency is needed: the app-server speaks JSON-RPC over stdio lines, which the backend can do by hand, as it does with the Claude stream. (My call: no OpenAI SDK, no `@openai/codex-sdk`.)
- The Codex app-server is marked **[experimental]**. Treat its protocol like Claude's hidden flags: a probe in `npm run e2e` checks the parts ZumiBot relies on, and a mismatch is a visible error, never a silent retry.
- `codex` must be on the PATH, or set by `ZUMIBOT_CODEX_BIN` (my call, mirrors `claudeLocator.ts`). Codex agents are simply unavailable on a machine without it; nothing else changes.
- Ask the user before touching the VPS (installing Codex there, running `codex login --device-auth`).

## Phase overview

| Phase | Ships | Depends on |
|---|---|---|
| 0 | `codexProbe.mjs`: checks the real CLI's behaviour (below). Nothing user-facing. | — |
| 1 | `provider: codex` in agents; single chats on Codex: streaming, tool rows, approval cards with remembered rules, Stop, to-dos, vault listing and browser fills, Agent asks, routines and workflow Agent/For each steps, usage and cost, limit waits, the context meter, Edit/Resend/Fork by reseeding. | Phase 0 checks 1–6 |
| 2 | Real rewinds through `thread/fork`, Compact, `/btw` side questions, question cards, the Files panel, Codex usage limits in the Usage popover, Zumi Bot creating Codex agents. | Phase 0 checks 7–10 |
| 3 | Pause, vault API keys with the guard, computer use, the Dispatched agents panel (Codex subagents), Codex members in rooms. | Phase 0 checks 11–13 |

Each phase gets its own plan and its own approval. This document covers all three so the seam is built once; Phase 1 is the one to plan first.

## Phase 0: the probe

`zumi-bot-server/e2e/codexProbe.mjs`, built like `sideAskProbe.mjs`: real CLI, a temp `cwd`, stub MCP servers where needed, exit 0 PASS, 1 FAILED, 2 INCONCLUSIVE (no `codex`, not logged in, the model never made the call; retried once), `--soft` turns 2 into 0 with a loud warning, `ZUMIBOT_SKIP_CODEX_PROBE=1` skips it. `npm run e2e` runs it last. It also prints what it learned (tool names, field values) so the builder can pin them in code and in the fake.

Each check, and what fails it:

1. **Turn basics.** `initialize`, `thread/start`, `turn/start`; text arrives as `item/agentMessage/delta` and `item/completed`, the turn ends with `turn/completed`, and `thread/tokenUsage/updated` carries `last`, `total` and `modelContextWindow`.
2. **Instructions.** `developerInstructions` given at `thread/start` reach the model, and a changed value given at `thread/resume` replaces the old one (ZumiBot's appended prompt changes between turns: house style, the to-do note's paragraph). FAILED if the resumed thread still follows the old text.
3. **Approvals, manual mode.** With `approvalPolicy: "untrusted"`, sandbox `workspace-write` and reviewer `user`, a command that writes outside the workspace arrives as `item/commandExecution/requestApproval`; `decline` keeps it from running and `accept` runs it. FAILED if the command runs before the answer. Also checks that reading a file outside the workspace (standing in for the chat's attachments folder, which Claude runs get through `--add-dir`) needs no approval; if it does, the attachments folder goes into `sandbox_workspace_write.writable_roots` or the Codex form of an extra readable root.
4. **Approvals, auto mode.** With `approvalPolicy: "on-request"` and reviewer `auto_review`, a harmless command runs without a request reaching the client, and the run never needs `danger-full-access`. Records what an escalation the reviewer declines looks like on the wire.
5. **MCP bridges.** A stub stdio MCP server passed through `thread/start`'s `config` (`mcp_servers.<name>` with `command`, `args`, `env`) is started with that env, the model can call its tool without a tool search, the call shows as an `mcpToolCall` item, and the probe records the tool name the model sees (expected `mcp__<server>__<tool>`; `non_prefixed_mcp_tool_names` is off) and whether the call asks for approval (expected through `mcpServer/elicitation/request`, since `tool_call_mcp_elicitation` is on). Also checks that a long call is not cut by a default MCP timeout when `tool_timeout_sec` is set.
6. **Stop and limits.** `turn/interrupt` ends the turn with status `interrupted` and the process can then be closed; the probe records the `error` notification shape for a usage limit if one can be produced (else INCONCLUSIVE for this check only, and Phase 1 maps it from the bindings: `codexErrorInfo: "usageLimitExceeded"` plus the latest `account/rateLimits/updated`).
7. **Fork at a turn.** `thread/fork` with `lastTurnId` set to turn 1 of a three-turn thread gives a new thread id that remembers turn 1 and not turns 2–3, and the source thread is unchanged. FAILED if the id equals the source's (the Codex form of `FORK_IGNORED`) or the source changed.
8. **Ephemeral fork.** The same with `ephemeral: true` leaves no rollout file under `CODEX_HOME`.
9. **Compact.** `thread/compact/start` emits `thread/compacted` (and a `contextCompaction` item), and the `config` key for the auto-compact limit (expected `model_auto_compact_token_limit`) is accepted.
10. **File changes.** A file edit arrives as a `fileChange` item whose `changes[].diff` lets the old text be rebuilt from the new file on disk.
11. **PreToolUse hook.** A `preToolUse` command hook configured through `config` runs before a shell call and before an MCP call, gets the call on stdin, and blocks it with a non-zero exit, the model seeing the hook's stderr; records what trust the hook needs without `--dangerously-bypass-hook-trust` (preferred) and whether a subagent's call can be told apart from the main thread's (needed by Pause).
12. **Forced MCP approval.** Some config makes a named MCP tool always ask, in auto mode too (computer use's forced cards). INCONCLUSIVE if no such config exists, which keeps computer use off for Codex.
13. **Subagents.** With `multi_agent` on, a `spawnAgent` collab call shows as `collabAgentToolCall` and `subAgentActivity` items, and `turn/completed` does not come while a spawned agent still works (or the probe records that it does).

## How it works

### Choosing the engine

- `AgentFields` (`shared/src/frontmatter.ts`) gets `provider: 'codex' | null`, a ZumiBot-only key like `computerUse` and `memoryLimit`: absent or anything but `codex` reads as null (Claude), and the writer removes the key rather than writing `claude`. `AgentSummary` gets `provider?: 'codex'`.
- Codex agents are ordinary files in the agents folder. `--agent` does not exist in Codex, so ZumiBot sends the file's **body** as the start of `developerInstructions` (below). `model:` holds a Codex model name; absent means the Codex config's default.
- Keys that mean nothing to Codex are kept in the file but ignored, and Agent Studio hides their controls for a Codex agent with one line saying why: `tools:` (Codex has no per-tool allow list; its sandbox and approvals govern tools), `memory`, `memoryLimit`, `computerUse` (until Phase 3). `autoCompactWindow` maps to the Codex auto-compact limit in Phase 2.
- A command's `model` (`opus`, `sonnet`, `haiku`) is ignored for a Codex agent (`turnModel` sees no change), and the model chip never shows.
- Changing an agent's provider is allowed. The next turn of its chats starts a fresh session seeded from the visible items, with the `expired` notice (see Sessions). (My call.)

### The seam

Today `ChatService.agentTurn` builds Claude argv with `buildArgs` and calls `this.d.run(RunOptions)` (`runClaude` in `app.ts`). The change, kept as narrow as possible:

1. **Bridges return structure, not argv.** Each bridge (`browserIpc`, `todoIpc`, `vaultIpc`, `askIpc`, `automationIpc`, `desktopIpc`) builds `{mcpServers: {name: {command, args, env, …}}}` and then wraps it as `['--mcp-config', JSON]`. Split that: the bridge returns an `McpServerSpec` (`{name, command, args, env, alwaysLoad?, timeoutMs?}`), and a Claude helper turns it into exactly the argv it produces today. The `--settings` fragments (pause hook, vault guard, desktop and automation ask rules) stay Claude-only strings for now.
2. **A run request.** At the spawn site `ChatService` assembles one engine-neutral request: agent name, model, resume point, permission mode, the appended system text, the MCP specs, the env, `cwd`, the prompt, `onEvent`, plus the Claude-only parts (settings fragments, disallowed tools, add-dir args). The Claude engine renders it with `buildArgs` exactly as now; the Codex engine renders it as below. The engine is the agent's `provider`, read per attempt.
3. **The handle is shared.** Both engines return `RunHandle` (`stop`, `send`, `done`) and emit `RunEvent`s. `send` keeps taking the Claude `control_response` objects that `controlProtocol.ts` builds; the Codex handle translates them into JSON-RPC answers (see Approvals). So `ChatService`'s approval code does not change in Phase 1. (My call; a typed `answer()` can replace `send` later.)
4. **Per-feature gates.** A small `engineCaps(provider)` (pure, in `shared/`) says what a chat on that engine supports: `pause`, `btw`, `compact`, `rewind`, `files`, `desktop`, `vaultKeys`, `rooms`, `questions`, `plan`, `memory`, `keepWarm`. `ChatService.canPause`, the `/btw` handlers, `chats:compact`, Agent Studio and the side panel read it, so each phase flips flags instead of hunting for branches. The gates hold on the server, not only in the UI: `createGroup` and the room member edits refuse a Codex agent while `rooms` is off; the desktop turn, vault key env and memory note (`memory.begin`) are never built for a Codex run while their flag is off, whatever the agent file says; `KeepWarm.note` is skipped for a Codex context, and `coldContexts` leaves out a chat whose `sessionEngine` is `codex`.

The builder decides how far to go beyond this (an `Engine` interface object per provider is fine), as long as the Claude path's output is unchanged.

### The Codex runner (`core/codex/`)

New files (names are my call): `codexLocator.ts`, `codexRpc.ts` (JSON-RPC 2.0 over stdio lines: requests, responses, notifications, server-to-client requests, the same line splitter and stderr cap as the Claude runner), `codexEvents.ts` (pure: one notification or server request in, `RunEvent`s out), `codexRunner.ts`.

- **One process per attempt** (my call): `codex app-server --listen stdio://` in the chat's `cwd`, with the run's env. Not the shared app-server daemon, so each run gets its own env (capabilities, vault keys) and dies with its turn, like a Claude run. `--disable multi_agent` until Phase 3, so no subagent outlives the turn (the role `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` plays for Claude). Other user settings in `~/.codex/config.toml` still load, as a Claude run loads the user's settings; every field ZumiBot depends on is set per request and overrides them.
- **Sequence:** `initialize` (record `userAgent` as the version), then `thread/start`, `thread/resume` or `thread/fork` (below), then `turn/start` with the prompt. `init` is emitted with the thread id once known.
- **Prompt:** `UserContent` text becomes `{type: 'text', text, text_elements: []}`; an image block becomes `{type: 'image', url: 'data:<media type>;base64,<data>'}`. (Probe check 1 sends one image.)
- **End:** at `turn/completed` emit `result` and close stdin, then expect the process to exit; the existing kill ladder (SIGINT, SIGTERM, SIGKILL) applies if it does not.
- **Stop:** send `turn/interrupt`; if no `turn/completed` comes within the grace period, kill as today. `outcome.stopped` is set the same way.

### Thread parameters

Sent on `thread/start`, `thread/resume` and `thread/fork`:

- `cwd`: the chat's folder.
- `model`: the chat's model if set, else the agent file's `model:`, else omitted.
- `developerInstructions`: the agent file's body, a blank line, then the same appended system text the Claude run gets (house style, briefing, the to-do, vault and ask paragraphs, the browser prompt), built in the same order. Prompt texts that name a tool (`TODO_SYSTEM`, `VAULT_SYSTEM`, `askSystem`, the browser prompt) must name it as Codex shows it; probe check 5 records the form, and if it differs from `mcp__server__tool`, those texts get a per-engine rendering. Same discipline as Claude: the text must be byte-stable between turns that do not change it.
- **Permission mode** (my call, confirmed by probe checks 3–4): ZumiBot `manual` → `approvalPolicy: "untrusted"`, `approvalsReviewer: "user"`; `auto` → `approvalPolicy: "on-request"`, `approvalsReviewer: "auto_review"` (Codex's own reviewer, the closest match to Claude's auto-mode classifier). Both use sandbox `workspace-write` with network on (`config: {"sandbox_workspace_write.network_access": true}`), because Claude agents have network today and agents that run `gh`, `npm` or `curl` would otherwise break.
- `config`: the MCP servers as `mcp_servers.<name>` (command, args, env, and `tool_timeout_sec` for the ask bridge, which can wait for a long time: the Codex form of its `timeout: 86400000`), `features.multi_agent: false`, and in Phase 2 the auto-compact limit.
- `ephemeral`: only for side runs (Phase 2).

### Event mapping (`codexEvents.ts`)

| Codex | `RunEvent` |
|---|---|
| thread id from the start, resume or fork response | `init {sessionId: thread.id, version}` |
| `item/agentMessage/delta` | `textDelta` |
| `item/completed` of `agentMessage` | `assistantText` |
| `item/started` of `commandExecution` | `toolUse {id: item.id, name: 'Bash', input: {command, cwd}}` |
| `item/completed` of `commandExecution` | `toolResult {toolUseId, content: output, isError: exit code ≠ 0 or failed}` |
| `fileChange` started / completed | `toolUse {name: 'ApplyPatch', input: {changes: [{path, kind}]}}` / `toolResult` |
| `mcpToolCall` started / completed | `toolUse {name: 'mcp__<server>__<tool>', input: arguments}` / `toolResult` (content text; `isError` on `failed`) |
| `webSearch` | `toolUse {name: 'WebSearch', input: {query}}` and its result |
| `collabAgentToolCall` | Phase 1: off (`multi_agent` disabled). Phase 3: `toolUse {name: 'Agent'}` plus `taskStarted`/`taskUpdated`, `subText`, `subToolUse`, `subToolResult` from `subAgentActivity` |
| `reasoning`, `plan`, `turn/plan/updated`, `turn/diff/updated`, `hook/*` | dropped in Phase 1 |
| `thread/tokenUsage/updated` | `context {model, tokens}` from `last`; the window from `modelContextWindow` is kept for the `result`'s `windows`. OpenAI counts cached input inside `inputTokens` (the `exec` run here reported 15 469 input with 12 160 cached), so tokens = `inputTokens + outputTokens`, never plus `cachedInputTokens`. Probe check 1 confirms. |
| `thread/compacted`, `contextCompaction` item | `compacted` (Phase 1 shows it; Codex compacts on its own near the window) |
| `account/rateLimits/updated` | `rateLimit` (stored per provider, see Usage) |
| `error` with `codexErrorInfo: "usageLimitExceeded"` (or `rateLimitReachedType` set on the snapshot) | `limited {resetsAt}` from the snapshot's window that is exhausted, `resetsAt` seconds × 1000 |
| `turn/completed` | `result {subtype: status, isError: status 'failed', sessionId: threadId, numTurns: 1, denials, windows, uuid: turn.id, cost}` |
| server request `item/commandExecution/requestApproval` | `permissionRequest {requestId: <JSON-RPC id>, toolName: 'Bash', input: {command, cwd}, reason, toolUseId: itemId}` |
| server request `item/fileChange/requestApproval` | `permissionRequest {toolName: 'ApplyPatch', input: {changes}, reason}` (the changes come from the item already started) |
| server request `item/permissions/requestApproval` | `permissionRequest {toolName: 'SandboxPermissions', input: {permissions, cwd}, reason}` |
| server request `mcpServer/elicitation/request` that is a tool-call approval | `permissionRequest {toolName: 'mcp__<server>__<tool>'}`, so the own-bridge auto answers (`ownTodo`, `ownAsk`, vault, automations) match unchanged; any other elicitation is declined |
| server request `item/tool/requestUserInput` | Phase 1: answered with an error (the feature is off by default). Phase 2: question card |
| `serverRequest/resolved` for a request still open | `permissionCancel` |
| anything else | ignored, or `controlUnknown` for an unknown server request (answered with an error, as today) |

Tool names map onto names ZumiBot already knows, so `toolLabel`, `allowKey`, `agentAllowKey` and the cards work with few changes: `Bash` needs nothing, `ApplyPatch` and `SandboxPermissions` need a label and a summary (`state/toolLabel.ts`, `toolSummary`), keyed like any other tool (by identical input for "Allow for this chat", by name for "Allow always for this agent"). (My call.)

### Approvals

`ChatService` keeps deciding exactly as today (remembered rules, own bridges, Jev hint, cards). The Codex handle's `send` translates the answer:

| ZumiBot sends | Codex answer |
|---|---|
| `allowResponse` | `accept` (never `acceptForSession`: ZumiBot stays the only keeper of rules, so "Allow for this chat" and "Allow always" behave the same on both engines) |
| `denyResponse` | `decline` (the deny message cannot be passed through; the model sees a declined call) |
| `errorResponse` | a JSON-RPC error |
| an elicitation | `accept` or `decline` in the elicitation result shape |

`updatedInput` is ignored: Codex cannot run a changed command. The plan card and question card never appear in Phase 1 (`engineCaps`).

### Sessions, stamps and rewinds

- The Codex thread id is stored where the Claude session id is (`ChatMeta.sessionId`, later the room's member sessions). To keep a Codex id from ever being passed to `claude --resume` (or the other way round), the chat also stores `sessionEngine: 'codex'` beside it (absent = Claude, so stored chats need no migration). A turn whose agent's engine differs from `sessionEngine` drops the session and reseeds with the `expired` notice.
- **Phase 1** emits no `entry` events, so Codex turns record no `end` or `cut` stamps. `sessionPoints.ts` already falls back to `{seed: true}` when no stamp is found, so Edit, Resend, version switches and Fork work by reseeding from the visible items. Correct, only costlier.
- **Phase 2** (after probe checks 7–8): at `turn/completed` emit `entry {uuid: turn.id}`, so the last item of each turn gets an `end` stamp whose `at` is a turn id; stamps carry `engine: 'codex'`. A `{at}` start on a Codex session runs `thread/fork {threadId, lastTurnId: at}` instead of `--resume-session-at … --fork-session`, and a fork that answers with the source's id is stopped as `FORK_IGNORED`. `cut` stamps (one per assistant message inside a turn) have no Codex equivalent: a rewind that would need one reseeds.
- **Usage limit waits** need nothing new: they act on `limited` errors and send `continue` as a new turn.

### Usage and limits

- **Cost records.** Codex reports tokens, not USD. `turn/completed` is paired with the last `thread/tokenUsage/updated` of the turn; the run's own usage is the change in `total` since the turn began (the resumed thread's totals already count earlier turns, the same problem `costBaseline` solves for Claude). The record is written with the existing `recordRun` path plus `provider: 'openai'`, the model, and a cost priced from a table of Codex models added to `shared/src/pricing.ts` (input, cached input, output per million). A model missing from the table records tokens with no cost, and the Usage page shows "—" for it rather than $0. The builder fills the prices from OpenAI's published list at build time. (My call.)
- **Estimates** from session logs stay Claude-only. Codex sessions that no exact record covers are not estimated.
- **Plan limits.** `account/rateLimits/updated` readings are stored per provider. The Usage popover's rings stay Claude's in Phase 1; Phase 2 adds a Codex block (primary and secondary windows, `usedPercent`, `resetsAt`) when any Codex agent exists.

### Locator, sign-in, health

- `codexLocator.ts` mirrors `claudeLocator.ts` (override env, PATH, `~/.local/bin`, login shell `command -v codex`).
- No `codex` found: Codex agents show an error in the agent list ("Codex CLI not found"), a send to one fails with that fixed sentence, and nothing else changes. Not signed in: the run's first error (`unauthorized`) is shown as "Codex is not signed in on this machine. Run `codex login` in a terminal." (fixed text, never CLI output).
- `SETUP-VPS.md` gains a short "Codex (optional)" section: install, `codex login --device-auth` as the service user, check with `codex login status`. This matters because routines and workflows run on the VPS only (`sync.mjs` switches the local copies off): a routine or workflow step that uses a Codex agent fails on a VPS without a signed-in `codex`, with the "not found" or "not signed in" sentence as the run's error.

## Features by phase

Phases 1 and 2 have shipped: Phase 2 on 2026-11-09, with every probe gate GO (see "Phase 2 probe results" and "Phase 2 smoke" in `docs/superpowers/plans/2026-11-09-codex-provider-phase-2.md`). Phase 3 is built and awaiting review (2026-11-10): every gate GO but computer use, whose probe check 12 was INCONCLUSIVE (see "Phase 3 probe results" and "Phase 3 smoke" in `docs/superpowers/plans/2026-11-10-codex-provider-phase-3.md`). "✓ shipped" marks what Phase 2 turned on, "✓ built" what Phase 3 turned on.

| Feature | Phase 1 | Phase 2 | Phase 3 | Notes |
|---|---|---|---|---|
| Single chat: stream, tool rows, Stop | ✓ | | | |
| Approval cards, remembered rules | ✓ | | | `Bash`, `ApplyPatch`, `SandboxPermissions`, MCP |
| To-dos, vault listing, browser (incl. vault fills) | ✓ | | | MCP bridges; needs probe check 5 |
| Agent asks (Claude → Codex and Codex → Claude) | ✓ | | | B's turn uses B's engine through `runAsked`; Codex as A needs check 5 |
| Routines, workflow Agent and For each steps | ✓ | | | they run through `TaskQueue`/`ChatService` |
| Usage records, limit waits, context meter | ✓ | | | |
| Edit, Resend, version switch, Fork | ✓ by reseed | ✓ shipped: `thread/fork {lastTurnId}` | ✓ built: `excludeTurns` | `lastTurnId` is inclusive; a missing thread, or any error a main turn's fork answers with, reseeds once; a Codex reply has no `cut` stamp, so Fork from the reply that ends its turn forks at its `end` stamp, and one mid-turn reseeds |
| Compact | auto only | ✓ shipped: button, `autoCompactWindow` | | `thread/compact/start` (no `thread/compacted`: the `contextCompaction` item is the notice); no note field; Compact at is `model_auto_compact_token_limit`, sent only below the model's window (or below 200 000 while the window is not known), else codex compacts near its window by itself |
| `/btw` side questions | refused | ✓ shipped | ✓ built: deny hook | ephemeral fork (`excludeTurns` required) of the last completed turn, `untrusted` and `read-only`; every request declined without a card, so a Codex agent's own side answer asks nobody; Phase 3 adds `CODEX_SIDE_DENY_HOOK` (check 11), which also blocks the reads `untrusted` runs without asking, and falls back to decline-all alone when codex never trusts it |
| Question cards | — | ✓ shipped | | `item/tool/requestUserInput` behind `default_mode_request_user_input`, passed to every app-server; an A→B Codex B's question gets an empty answer |
| Plan card (ExitPlanMode) | — | — | — | no Codex equivalent of an approval gate |
| Files panel | — | ✓ shipped | | from `fileChange` diffs plus the file on disk, null with a `why` when it cannot be exact; the patch card also names a move's destination |
| Codex limits in the Usage popover | — | ✓ shipped | | in memory only: none after a restart until the next Codex turn |
| Zumi Bot writes `provider: codex` | — | ✓ shipped | | its prompt and `/make-friendly` learn the key and skip Claude-only keys |
| Pause | hidden | | ✓ built | the pause hook as a trusted `-c` hook (check 11), exit 0 or 2 only; a subagent's call carries `agent_id` as on Claude, and the main thread may wait for its subagents |
| Vault API keys as env | not injected | | ✓ built | only beside the vault guard as a trusted Codex hook on every tool (check 11), never under a `CODEX_*`/`OPENAI_*` name; a run whose hooks codex never trusts goes on with no hook and no keys; the Vault editor no longer marks Codex agents |
| Computer use | control hidden/unavailable | | not shipped | check 12 INCONCLUSIVE: no setting forces a client approval for an MCP tool in auto mode (`approval_mode = "prompt"` goes to Codex's own auto reviewer, which approved the call), so the desktop's forced cards could not hold; the control stays hidden/unavailable and a Codex run gets no desktop bridge |
| Dispatched agents panel | — | | ✓ built | `--enable multi_agent` on main runs; `subAgentActivity` and the child threads mapped (check 13), child approvals as labelled cards, child cost in the turn's; Stop ends children through the process exit |
| Rooms with Codex members | not offered | | ✓ built | each member on its own agent's engine, `GroupInfo.sessionEngines` per member; the moderator, room summary and side picker stay Claude |
| Agent memory | — | — | — | Claude only |
| Keep warm, cold notice | — | — | — | Claude only |

## UI

- **Agent Studio** (`AgentEditor.tsx`, `AgentForm.tsx`): an **Engine** select (Claude, Codex) near Model. With Codex picked, the Model field suggests the names from the app-server's `model/list` (fetched once per server start, cached; free text still allowed), and the Tools, Memory, Compact at (Phase 1), Computer use and command Model controls hide behind one line, "Not used by Codex agents". The Codex option is disabled with a tooltip when no `codex` binary is found.
- **Agent rows and the chat header:** a small engine mark on Codex agents (my call: a short "Codex" tag beside the name, not a new icon set).
- **Chat:** the Pause button, the Compact entry, `/btw` in the composer menu, the Side questions, Files and Desktop entries in the side panel follow `engineCaps`. In Phase 1 a typed `/btw` in a Codex chat was refused with "Side questions are not available for Codex agents yet."; Phase 2 answers it.
- **Usage page:** costs priced from the table are shown as usual; a Codex model missing from the table shows "—".

## Data changes

All additive; absent means today's behaviour.

- Agent file: `provider: codex` (ZumiBot-only key).
- `AgentSummary.provider?: 'codex'`.
- `ChatMeta.sessionEngine?: 'codex'` (and the room's per-member equivalent in Phase 3).
- `TurnEnd` and `SessionCut` stamps: `engine?: 'codex'` (Phase 2).
- Usage records: `provider?: 'openai'` and the token fields Codex reports (`cachedInputTokens`, `reasoningOutputTokens`).
- Account readings: per provider.

## Sync

- Agent files, chats and usage records sync as today. The `codex` session files under `~/.codex` are not synced (non-goal), and `~/.codex/auth.json` must never be: `sync.mjs` does not touch `~/.codex` at all.
- A chat whose `sessionEngine` is `codex` and whose thread is missing on this machine reseeds, the existing fallback for a session file that is gone. The resume error that tells "thread not found" apart from other failures is pinned by the probe.

## Security

- No bypass flags, no `danger-full-access`, no `never` approval policy (anti-goals). A unit test asserts the request builder can produce none of them.
- Every value in the run's env that is a capability, socket path or vault key goes into the same `privateValues` and scrub sets as a Claude run's, and the Codex runner's errors pass through the same redaction, so nothing leaks through Codex's stderr or JSON-RPC error messages.
- Codex's own reviewer (`auto_review`) is trusted in auto mode the way Claude's classifier is today. That is a judgment the user accepts by turning on auto mode; the Settings text says the reviewer depends on the agent's engine.
- Until Phase 3 a Codex agent gets no vault API keys and no desktop, because the guards that make those acceptable for Claude agents are unproven for Codex.

## Testing

- **Claude unchanged:** a test snapshots the argv `buildArgs` produces for a set of representative turns (plain, resumed, cut, with every bridge, with settings fragments) before the refactor, and asserts the same after. The existing e2e suites must pass untouched.
- **Pure units:** `codexEvents.ts` against recorded app-server transcripts saved by the probe (`backend/tests/fixtures/codex-*.jsonl`); the answer translation; `engineCaps`; the thread-parameter builder (including the forbidden values); the frontmatter key; the pricing of token records; the `sessionEngine` mismatch rule.
- **Fake Codex:** `backend/tests/fixtures/fake-codex.mjs`, an app-server stand-in that answers `initialize`/`thread/*`/`turn/*` and replays a script file (text deltas, items, approval requests that wait for an answer, token usage, a usage-limit error, an MCP call that starts the real bridge from the `config` it was sent, like `fake-claude.mjs`'s `#MCP_CALL`). `ZUMIBOT_CODEX_BIN` points the server at it.
- **`npm run e2e:codex`:** fake only, no quota. A Codex agent created in Agent Studio; a reply streams; a Bash card allowed once, then "Allow for this chat"; a declined card; Stop; a to-do added by the agent; Edit reseeds (the fake logs the seeded prompt); a Claude agent asks the Codex agent; a usage limit waits and continues; Pause, `/btw` and Desktop absent; switching the agent's engine reseeds the next turn.
- **`npm run e2e`** runs `codexProbe.mjs --soft` after the existing probes.

## Open questions settled by the probe

These are not decisions for the user; the probe answers them and the code follows:

- The MCP tool name the model sees, and whether bridge tools are deferred behind a search (the Claude `alwaysLoad` problem).
- Whether MCP calls ask through elicitation in each permission mode, and the exact shape.
- Whether `developerInstructions` can change on resume.
- The usage-limit error shape and where `resetsAt` comes from.
- The auto-compact config key, fork semantics of `lastTurnId`, hook trust and subagent identity in hook input.

If check 5 fails (MCP bridges unreliable), Phase 1 still ships, but a Codex agent gets no to-do, vault or ask tools, can only be asked (never ask), and the probe's report says so.

## Left to the builder

- How deep the engine abstraction goes beyond the narrow seam described, as long as the Claude path is unchanged.
- File names and module layout under `core/codex/`.
- The JSON-RPC client's internals (id allocation, timeouts for requests that never answer).
- How the `model/list` cache is kept and refreshed.
- The exact wording of the fixed sentences, in the house style.
- Which Phase 1 pieces land first, and how the work splits into commits.
