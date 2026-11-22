# Engines

How ZumiBot runs an agent, what each engine is depended on for, and what a third engine would cost. Phase 1 of this work is a spike: everything below is a finding, not a change. The seam itself (phase 2) and any new adapter (phase 3) get their own sections as they land. ACP and AG-UI engines, and the seam work a third engine still needs, are designed in [Protocol engines](protocol-engines.md).

## Today

**Two engines, two runners.** `Engine` is `'claude' | 'codex'` (`shared/src/engine.ts`), picked per agent by the `provider:` key and per chat by `chatEngine`. `core/chat/claudeRunner.ts` spawns the `claude` CLI once per turn (`buildArgs`: `-p --agent <name> [--model] [--effort] [--resume <id> [--resume-session-at <uuid> --fork-session]] --permission-mode --permission-prompt-tool stdio --input-format stream-json --output-format stream-json --verbose --include-partial-messages [--thinking-display summarized] [--append-system-prompt … --system-prompt-snapshot off] [--settings …] [--disallowedTools …]`) and reads its stream-json with `streamParser.ts`; approvals, question cards and plan cards come back over stdio (`controlProtocol.ts`). `core/codex/codexRunner.ts` is the second engine and returns the same `RunHandle` (`{ stop, send, done }`) and `RunOutcome`, but takes its own options (`CodexStart`, `CodexAction`, `CodexThreadInput`, hook trust, request tags) and speaks JSON-RPC to `codex app-server`. See [Codex agents](codex.md).

**Where the engine's name is still read.** 62 sites in `zumi-bot-server/backend/src` test the engine by name (`isCodexChat`, `=== 'codex'`, `engine === …`, `onCodex`), 37 of them in `core/chat/chatService.ts`, the rest in `core/btw/sideQuestions.ts` (5), `core/chat/groupService.ts` (4), `core/extensions/extensionsService.ts` (3), `core/chat/sessionPoints.ts` (3), `app.ts` (3), `core/extensions/sanitize.ts` (2), `core/codex/isCodexChat.ts` (2), and one each in `core/groupMembers.ts`, `core/codex/codexAccount.ts`, `core/btw/sideRun.ts`. `EngineCaps` already covers nine of the per-feature gates; the declarative four (`desktop`, `plan`, `memory`, `keepWarm`) are explicit name checks by design.

**The undocumented surface.** Four things the runner depends on are not in `claude --help`: `--resume-session-at` and `--fork-session` (Edit, Resend, Fork, the version switcher — `sessionPoints.ts`, `fork.ts`, see [Edit, Resend, Fork](edit-resend-fork.md)), `--thinking-display` (see [Thinking](thinking.md)), and `--system-prompt-snapshot`. `chatService.ts` guards the first pair by comparing the resumed session id with the id in the run's `init`: equal means `--fork-session` was ignored, and the reply is stopped with `FORK_IGNORED` rather than written into the version being kept.

## Phase 1 — the spike

**How this was checked.** Against the published packages, not from memory: `@anthropic-ai/claude-agent-sdk@0.3.325` (its `package.json` reports `claudeCodeVersion: 2.1.325`), `@agentclientprotocol/sdk@2.7.0` (which ships `schema/v1/schema.json`, `schema/v1/schema.unstable.json`, `schema/v2/schema.json`, `schema/v2/schema.unstable.json`), `@zed-industries/claude-code-acp@0.16.2` and `@agentclientprotocol/codex-acp@2.6.0`. Live probes ran against `claude 2.1.325` on a throwaway install outside the repo (no dependency was added to any workspace): a turn, a plain resume, a fork at a message, `canUseTool` for `Write`, `AskUserQuestion` and `ExitPlanMode`, an `--agent` resolution check, an argv capture through a wrapper script, and a Vite bundle run with no `node_modules` present. Each claim below is marked **verified** (a probe did it) or **documented** (read from the shipped `.d.ts` or JSON schema).

### 1. Claude Agent SDK (TypeScript): what the runner does today, and whether the SDK has it

| What `claudeRunner` does | SDK equivalent | Status |
| --- | --- | --- |
| `--resume <id>` | `resume?: string` | documented |
| `--resume-session-at <uuid>` | `resumeSessionAt?: string` — "when resuming, only resume messages up to and including the message with this UUID" | **verified**: fork of a two-turn session at turn 1's assistant uuid answered from turn 1 only |
| `--fork-session` | `forkSession?: boolean`, with `sessionId?: string` to name the fork's id | **verified**: the fork came back with a new session id |
| no equivalent today | `resumeDropsTurn?: string` — names the prompt uuid of the turn the truncating resume means to discard; the CLI validates that everything past the fork point belongs to that turn and refuses with a message starting `Resume rejected by --resume-drops-turn:` | documented |
| `--permission-prompt-tool stdio` + `controlProtocol.ts` | `canUseTool(toolName, input, options)` returning `{behavior:'allow', updatedInput?, updatedPermissions?}` or `{behavior:'deny', message, interrupt?}`; `options` carries `suggestions`, `title`, `displayName`, `description`, `toolUseID`, `requestId`, `agentID`, `blockedPath`, `mcpServer`, `defaultToNo`, `suppressAlwaysAllowRule`, `matchedAskRule` | **verified** for `Write` (its `suggestions` were `[{type:'setMode',mode:'acceptEdits',destination:'session'}]`) |
| `AskUserQuestion` answers as `updatedInput.answers` | same path: `canUseTool` is called with the tool's `{questions}` and the answer rides in `updatedInput` | **verified**: the card arrived; the CLI validated the answer's shape and said `answers` must be a record, which is the shape ZumiBot already sends |
| `ExitPlanMode` approve / Keep planning | same: `canUseTool` is called with `{plan, planFilePath}`; `{behavior:'deny', message}` is Keep planning with feedback | **verified** (three rounds of deny-with-feedback, the agent revised each time) |
| plan approve's `updatedPermissions: [{type:'setMode', mode, destination:'session'}]` | `PermissionUpdate` has `{type:'setMode', mode: PermissionMode, destination}`, so the allow carries it unchanged; `Query.setPermissionMode(mode)` sets it mid-session | documented |
| `--agent <name>` | `agent?: string`, "equivalent to the `--agent` CLI flag"; `settingSources` defaults to all sources, so `~/.claude/agents/*.md` still resolve | **verified, with a trap** — see below |
| `--thinking-display summarized` | `thinking?: {type:'adaptive'\|'enabled', display?:'summarized'\|'omitted'}`; the SDK turns it into `--thinking=adaptive --thinking-display=summarized`. `'highlights'` is not in the option, only in `Query.setMaxThinkingTokens(tokens, display)` | **verified** (argv captured) |
| `--effort` | `effort?: EffortLevel`, the same `low \| medium \| high \| xhigh \| max` | **verified** (argv captured) |
| pause hook, vault guard as `PreToolUse` shell commands in `--settings` | two routes. Unchanged: the `settings` option (inline object or JSON) and `extraArgs`. New: `hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>` — **in-process JS callbacks** with `matcher`, `timeout` (seconds) and `onFailure: 'continue' \| 'block'`; a `PreToolUse` callback returns `{hookSpecificOutput:{hookEventName:'PreToolUse', permissionDecision:'deny', permissionDecisionReason}}` | documented |
| streaming input mid-turn (stdin `encodeUserMessage`) | `prompt` as `AsyncIterable<SDKUserMessage>` plus `Query.streamInput(stream)`; every control method needs streaming-input mode | documented |
| Stop (SIGINT ladder) | `Query.interrupt()`, which on a CLI advertising `interrupt_receipt_v1` resolves with `{still_queued, cancelled?}`; `Query.close()` terminates the process | documented |
| usage and cost from the `result` event | the result message carries `total_cost_usd`, `usage` (input/output, both cache kinds, `iterations`, `service_tier`), `modelUsage`, `permission_denials`, `num_turns`, `stop_reason`, `terminal_reason`, `subagent_stats` | **verified** (a real result read field by field) |
| the user's installed `claude`, so subscription login keeps working | `pathToClaudeCodeExecutable?: string`; the SDK spawns that path directly for a native binary and through the JS runtime for a `.js`/`.mjs` entry | **verified**: a turn ran through `/opt/node22/bin/claude` |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | `env` (which **replaces** the child's environment rather than merging, so `{...process.env, …}` is required) | documented |
| ending the run at the `result` event | the generator ends after the result; `close()` kills the process. The SDK owns stdin, so "close stdin at the result" becomes "stop consuming and close" | documented |
| `--system-prompt-snapshot off` | **not an `Options` field.** It exists only on the control-protocol initialize shape; from `query()` it has to go through `extraArgs: {'system-prompt-snapshot': 'off'}` | **verified** (argv captured) |
| `oneSettings`' merge of several `--settings` | there is one `settings` option, so the merge stays ZumiBot's job — which `oneSettings` already does before the spawn | documented |

**The `--agent` trap.** With the SDK's default system prompt (minimal, not Claude Code's), `agent: 'x'` is passed as `--agent=x` and the agent file is still *found* — but its body does not apply and nothing warns. A probe agent whose only instruction was to reply `PROBE-AGENT-LOADED` replied normally through `query()` and correctly through `claude -p --agent` directly. Adding `systemPrompt: { type: 'preset', preset: 'claude_code' }` fixed it (reply: `PROBE-AGENT-LOADED`), and `{…, append: '…'}` behaved exactly like `--append-system-prompt` (reply: `PROBE-AGENT-LOADED\n\n[APPENDED]`). Any Claude-on-SDK adapter must pass the preset, and `e2e` must assert an agent's body still reaches the model.

### 2. Does the SDK spawn the CLI? Yes

`sdk.mjs` calls `child_process.spawn`, and the argv it builds is the one `buildArgs` builds by hand. Captured from a real `query()` with a wrapper script in `pathToClaudeCodeExecutable`:

```
--output-format stream-json --verbose --input-format stream-json
--thinking=adaptive --thinking-display=summarized --effort=low --model=haiku
--agent=probe-engine --permission-prompt-tool=stdio --include-partial-messages
--system-prompt-snapshot off
```

With no `pathToClaudeCodeExecutable` the SDK needs a Claude Code **native binary** from its own `optionalDependencies` (`@anthropic-ai/claude-agent-sdk-linux-x64` and friends) and fails with `Native CLI binary for <platform>-<arch> not found` when they were skipped.

**What moving to it buys us:** the four undocumented flags become typed, documented options that the SDK's own version pins against a CLI version (`claudeCodeVersion`); `resumeDropsTurn` turns "did `--fork-session` work?" from ZumiBot's own id comparison into a deterministic refusal from the CLI, which is the one real correctness gain in the whole list; `canUseTool`, `hooks` and the control methods (`interrupt`, `setPermissionMode`, `setModel`, `setMaxThinkingTokens`) are maintained wire-protocol code we would stop owning; the typed `SDKMessage` union (and `sdk-tools.d.ts`' tool input/output types) replaces hand-written parsing; and `prewarm()` exists if cold starts ever matter.

**What it does not buy us:** it is the same `claude` binary, spawned the same way, over the same stream-json protocol, so nothing about CLI availability, version drift, login, cost or crash behaviour changes. It is not an in-process engine and it is not an API client. The flags are no longer hidden, but their *behaviour* is still Claude Code's and still changes between versions — `npm run e2e` stays exactly as necessary. One flag ZumiBot needs (`--system-prompt-snapshot`) is still off the documented surface, so "no dependency on undocumented behaviour" is not reachable through the SDK alone.

### 3. Bundling and the packaged desktop: works

- Built with the repo's own `vite@8.3.5`, `ssr: { noExternal: true }`, `build.ssr`, `target: 'node22'`, ESM output: **one 1,343.77 kB chunk**, 369 kB gzipped, with only node builtins left as imports. No `import.meta.url` asset problem, because the native-binary resolution is only reached when `pathToClaudeCodeExecutable` is unset.
- The bundle was copied to an empty directory **with no `node_modules` at all** and ran a real turn with `NODE_ENV=production`. That is `dist/server.mjs`' deployment model exactly.
- `sdk.mjs` imports only node builtins; zod and the MCP types it uses are already inlined in the package. So the runtime bundle needs none of the three `peerDependencies` (`@anthropic-ai/sdk >=0.93.0`, `@modelcontextprotocol/sdk ^1.29.0`, `zod ^4.0.0`) — but npm installs peers by default, so a plain `npm ci` pulls them and their transitive tree (104 extra packages here) and each would have to be pinned exactly under the repo's rule.
- **Install weight is the real cost.** A default install is 414 MB, 349 MB of it the `linux-x64` native CLI binary. `npm install --omit=optional` gives 65 MB and the SDK still works **verified** as long as `pathToClaudeCodeExecutable` is set — which ZumiBot always can, from `claudeLocator.ts`. Adopting the SDK therefore comes with an install-flag requirement (or an npm config/override) that `deploy` and the desktop build must both honour, or every machine grows by a third of a gigabyte.

### 4. Agent Client Protocol

**Two live protocol versions.** `@agentclientprotocol/sdk@2.7.0` ships both. v1 stable is `initialize`, `session/new`, `session/load`, `session/list`, `session/delete`, `session/resume`, `session/close`, `session/set_mode`, `session/set_config_option`, `session/prompt`, `session/update`, `session/cancel`, `session/request_permission`, `fs/read_text_file`, `fs/write_text_file` and the five `terminal/*` methods; v1 **unstable** adds `session/fork`, `session/archive`, `session/unarchive`, `session/status`, `session/options`, `session/set_title`. v2 is a redesign: `session/resume` with an inclusive `replayFrom` cursor, `session/set_config_option` in place of modes, `tool_call/cancel`, `elicitation/create`, `auth/login`, and 24 `session/update` variants including `agent_thought_chunk`, `plan_update`, `subagent_update`, `compaction_update`, `usage_update` (`used`, `size`, `cost: {amount, currency}`) and `replay_complete`.

**Against ZumiBot's needs.** Session load and resume: yes (`session/load` in v1 behind the `loadSession` capability, `session/resume` in both, `session/list` to find them after a restart). Cancel: yes (`session/cancel`, a notification; a pending permission request then resolves `cancelled`). Permission requests: yes, but the shape is the agent's — the agent sends `title`, `description`, an optional `subject` and a list of `PermissionOption`s with kinds `allow_once | allow_always | reject_once | reject_always`, and the client answers with one `optionId`. There is no `updatedInput`, so a question card's answers and any client-side edit of a tool's input have no home; there is no client-sent `setMode` with an allow. Modes: v1 `session/set_mode` takes mode ids the *agent* advertises, so Plan and Accept edits are only reachable when that agent happens to name them. Fork: **nothing in either stable schema** — no fork, rewind, truncate, branch or checkpoint anywhere in v2, and v1's `session/fork` is unstable and forks a whole session, not a point in it.

**Who speaks it.** `@zed-industries/claude-code-acp@0.16.2` ("An ACP-compatible coding agent powered by the Claude Code SDK") is an ACP front end over the same SDK this spike measured: it reports `protocolVersion: 1` on `@agentclientprotocol/sdk@0.14.1`, advertises `loadSession: true` and `sessionCapabilities: {fork, list, resume}`, implements `unstable_forkSession` by calling the SDK with `resume` + `forkSession`, maps `session/set_mode` onto `query.setPermissionMode` for the ids `default | acceptEdits | bypassPermissions | dontAsk | plan`, surfaces `ExitPlanMode` as a permission request with a `reject_once` option named "No, keep planning" — and **puts `AskUserQuestion` in `disallowedTools`** with the comment "not a great way to expose this over ACP at the moment". Codex is an adapter too: `@agentclientprotocol/codex-acp@2.6.0`, published by the ACP org. For Gemini CLI (`@google/gemini-cli@0.68.0`) and opencode (`opencode-ai@1.19.5`) I could not confirm native support first-hand: their npm READMEs do not mention ACP, and `agentclientprotocol.com` is blocked by this session's network policy, so the only evidence is third-party write-ups saying `gemini --acp` and `opencode acp` are native. Treat that as unverified.

**What an ACP engine could honestly set true.** `rooms` (a member's turn is one prompt, which ACP does fine) and `files` (tool-call content carries diffs, and `FileTracker` could read them). Everything else is honestly false today: `rewind` (no fork at a point — Edit, Resend, version switches and Fork would all reseed), `btw` (its whole design is an ephemeral fork of the live thread), `questions` (no `updatedInput`; v2 elicitation might carry one later, but the reference Claude adapter disables the tool), `plan` (no client-driven mode change tied to an approval, and ZumiBot must never auto-allow or remember a plan), `pause` (no hook of any kind, so nothing can block a call mid-turn; declining permission requests cannot work, since reads an agent auto-approves never ask), `vaultKeys` (same — no guard means no keys), `compact` (v2 `compaction_update` only, nothing in v1), `dispatch` (v2 `subagent_update` only), `desktop`, `memory`, `keepWarm`.

### 5. Recommendation

**Claude Agent SDK: yes, as a second adapter behind the seam — not as a replacement for the CLI runner.** It cannot reduce the CLI dependency, because it *is* the CLI. What it does is move `--resume-session-at`, `--fork-session`, `--thinking-display` and the stdio permission protocol from "hidden flags we hope still exist" to typed options with a version pinned against a Claude Code version, and it adds `resumeDropsTurn`, whose deterministic refusal is strictly better than ZumiBot's own session-id comparison for catching a rewind that would have written into a kept version. That is worth having, and phase 3's shape (a second adapter chosen by a `devEnv()` hook, the CLI adapter kept until `npm run e2e` passes on the SDK one including the edit/resend/fork checks) is the right way to get it. Taken wholesale, nothing in the capability list regresses, with three caveats to carry into phase 3: `--system-prompt-snapshot off` still rides on `extraArgs`; the `systemPrompt` preset must be passed or every agent silently loses its body; and the install must use `--omit=optional` (and pin three peer dependencies) or grow by 349 MB per machine.

**ACP as a generic third engine: not yet.** An ACP engine would have to declare `rewind`, `btw`, `questions`, `plan`, `pause`, `vaultKeys`, `compact` and `dispatch` false — that is Edit/Resend/Fork reseeding every time, no side questions, no question cards, no plan cards, no Pause, no vault guard and no Compact. A third engine is cheap to *add* once phase 2's seam exists, but an ACP one would be the least capable engine in the product and would carry a protocol that is mid-redesign (the reference Claude adapter is still on v1 while the SDK ships v2). The honest order is: build the seam, take the SDK adapter if the `resumeDropsTurn` guard is wanted, and reach for ACP only when a user actually asks for Gemini CLI or opencode — at which point it should land as a deliberately thin engine with most caps off and the UI hiding the rest, exactly as `provider: codex` did for the caps it lacks.

## Phase 2 — the seam

**One interface (`core/engines/`).** `engine.ts` holds the vocabulary both engines share and nothing else: `TurnStart`
(`new` | `resume` | `fork` at a point, which keeps the old session as it was), `turnStart(sessionId, at?)` — the one reading of
a stored start point — `TurnAction` (`turn` | `compact`, each with the prompt), `EngineTurn` (bin, cwd, env, start, action,
`onEvent`), and `EngineAdapter<Config>`: `engine`, `caps()`, `locate(agent?)` and `start(turn, config): RunHandle`. `send` and `stop`
stay on the handle, so a caller drives either engine's run the same way, and `RunHandle`/`RunOutcome` now live here and are
re-exported from `claudeRunner.ts`, where every caller already imports them from.

`Config` is deliberately per adapter, not shared. `claudeEngine.ts` takes `ClaudeTurnConfig` — `buildArgs`' own fields minus the
session, derived with `Omit<Parameters<typeof buildArgs>[0], …>` so it cannot drift from the flags it builds — and translates the
start with `claudeResume`, the only place `--resume-session-at` and `--fork-session` are named. `codexEngine.ts` takes
`CodexTurnConfig` (`runCodex`'s options minus the lifecycle ones, plus `ephemeral`, which belongs to the fork) and translates
with `codexStartOf` and `codexActionOf`, the only places `thread/fork` and `thread/compact/start` are chosen. The lifecycle is
genuinely shared; the configuration genuinely is not, and giving them one type would have hidden which is which.

`locate(agent?)` takes the agent's name for an engine whose command is per agent: `acpEngine.ts` (`AcpTurnConfig`: args,
instructions, request tag; `acpStartOf` maps `new` and `resume` and throws on a fork, since ACP has no rewind) hands it to its
`locate` dep, which resolves that agent's command with `acpLocate`. Claude and Codex have one binary for every agent and ignore
it. In `ChatService` the adapter's `locate(agent)` answers only for a launch that would run (launch trust, no refused argument);
a turn itself locates the very launch it checked (`acpLaunch`), never the file read again in between. See protocol-engines.md.

**What now goes through it.** `ChatService` builds both adapters in its constructor over its existing deps (`run`, `locate`,
`codex.*` are unchanged, so every test's deps still work) and reads them for the turn launch, `locate` and Codex's
`definitionOf`. The launch is one `turnOf(env)` plus the engine's own config instead of two hand-built option objects.
`sideRun.ts` keeps its own injected `run`/`codexRun` — its callers and tests pass those directly — but now reads its point
through the same `turnStart` and the same two translators, so a side run cannot drift from a main run's reading of a point.

**Branches that moved to `EngineCaps`.** Four name checks in `ChatService` stood in for a cap that already existed and was
already false for Codex, so they now read it: the desktop turn (`caps.desktop`), `memory.begin` (`caps.memory`), the plan card's
`setMode` back out of Plan (`caps.plan`) and the contexts that arm keep warm (`caps.keepWarm`). That closes the caveat
[Codex agents](codex.md) carried, that a later phase flipping one of the four declarative caps would have to find these checks
by hand.

**Branches left alone, and why.** 59 engine-name sites remain (34 in `chatService.ts`), each carrying real engine-specific
logic:

- *Two different spawns.* The two pause hooks and two vault guards (`claudePause`/`codexPause`, `vaultGuard`/`codexVault`), the
  auto-compact limit (`CLAUDE_CODE_AUTO_COMPACT_WINDOW` env vs. `autoCompactTokenLimit` on the thread), `CLAUDE_CODE_TMPDIR`,
  the `--thinking-display` probe vs. `model_reasoning_summary`, `definitionOf` (Codex has no `--agent`, so the file's body leads
  its instructions), the per-agent run config Codex has no form of, and the vault-key rules (`isCodexOwnEnv`, and keys only
  beside a trusted guard). These are the configuration the seam deliberately keeps per engine.
- *Two different session vocabularies.* The `cut` stamp a Claude turn records per assistant message and a Codex turn cannot
  (its turn id exists only as the turn ends), the side base's two shapes, and the engine mark that keeps a thread id away from
  `claude --resume` (`sessionPoints.ts`, `groupService.ts`) — see [Edit, Resend, Fork](edit-resend-fork.md).
- *Two different failure signals.* `outcome.missingSession` vs. reading a missing session off Claude's error text, and the two
  fork-ignored sentences; also the CLI-not-found sentences and the "Codex/Claude exited with code" text.
- *Claude-only machinery.* The cost baseline and the cost-log search (a Codex result's cost is the turn's own already), Claude
  Bot's automations (it is a Claude agent by name), and the compaction sizes Codex does not report.
- *Already principled.* `groupMembers.ts`, `groupService.ts` and `sideQuestions.ts` read `caps` with an injectable override;
  `sanitize.ts` and `extensionsService.ts` parse two different CLIs' listings; `codexAccount.ts` is Codex-only by nature.
- *`isCodexChat`.* Left as it is: half of it (`sessionEngine === 'codex'`) is not a cap question — a chat holding a Codex
  session has no Claude session to ping whatever a cap says — and folding the other half into `keepWarm` would make the name
  lie the first time that cap was flipped.

**Tests.** `backend/tests/core/engines.test.ts` (11 tests) pins the seam: each `TurnStart` kind, that the hidden pair is named
for a fork alone, that `ephemeral` reaches the fork and never the runner's options, that a compaction keeps its prompt on Claude
and loses it on Codex, and that `caps()` reads the caller's own function. Every existing test and fixture passes unchanged.

## Phase 3 — the SDK adapter

**What it is.** `core/engines/claudeSdkEngine.ts` is a second `EngineAdapter<ClaudeTurnConfig>`: the same `claude` binary
(`pathToClaudeCodeExecutable`, from `claudeLocator.ts` as always), driven through `@anthropic-ai/claude-agent-sdk` instead of
hand-built argv and hand-read stdio control lines. It is off unless `ZUMIBOT_CLAUDE_SDK=1`, read through `devEnv()`
(`claudeSdkEngineOn`), so the packaged desktop (`NODE_ENV=production`) can never take it. `app.ts` imports the module
dynamically, only when the hook is on, so a normal server never loads the SDK at all; `ChatService` takes it as the
`claudeEngine` dep — a factory handed the service's own `caps` and `locate` — and uses it in place of the CLI runner. Nothing
else about a turn changes, and with the hook off not a line of the old path is different.

**What the SDK is actually asked for**, which is exactly the undocumented part: `resume` + `resumeSessionAt` + `forkSession`
(`sdkResume`, the third translator of `TurnStart` beside `claudeResume` and `codexStartOf`), `canUseTool` in place of
`--permission-prompt-tool stdio`, and the typed message stream. Everything else rides as the flag the CLI adapter already
sends, through the SDK's `extraArgs`: `--permission-mode` (ZumiBot's own `manual` is not one of the SDK's typed modes, and the
CLI takes it), `--thinking-display summarized` **alone** (the SDK's `thinking` option would also send `--thinking=adaptive`,
which changes what the model does — see [Thinking](thinking.md)), `--system-prompt-snapshot off` (no typed option exists), and
the merged `--mcp-config` and `--settings`. That is deliberate: a side-by-side adapter has to produce the argv the CLI adapter
would, or comparing the two proves nothing.

**The parts that needed real work.**
- *Argv the SDK cannot repeat.* Its `extraArgs` is one value per flag name, while ZumiBot passes `--mcp-config` once per
  bridge and `--settings` for the agent's own, the desktop's ask rules, the pause hook and the vault guard. `splitExtraArgs`
  sorts a turn's `extraArgs` into the repeated flags, `--add-dir` (which has a typed home, `additionalDirectories`), single
  flags, and whatever is left; `mergeInlineJson` — now exported from `claudeRunner.ts`, and what `oneSettings` itself uses —
  folds each repeat into one value. A flag that would have to be dropped is not dropped: the turn ends with a `spawnError`
  naming it, because a silently missing bridge or guard is worse than a turn that fails loudly.
- *The permission bridge.* A `canUseTool` call becomes a `permissionRequest` event carrying the SDK's own `requestId`, and
  `send()` — the same `control_response` object `ChatService` already builds — resolves that call through `sdkDecision`. An
  `errorResponse` denies, the SDK's abort signal emits `permissionCancel`, and every card still open when the run ends is
  denied, so no tool can run on an answer nobody gave. A plan is still never auto-allowed or remembered.
- *The event stream.* The SDK hands back the CLI's own stream-json objects, so the adapter re-serializes each one and feeds
  `parseLine`: one parser for both adapters, and `thinking`, `toolUse`, `entry`, `context`, `spend` and the rest keep their
  exact meaning.
- *The input.* One `SDKUserMessage`, then the input stays open until the `result` closes it, as the CLI runner keeps stdin open.
  The run spawns with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, and the run env goes under the turn's own, as the CLI dep
  merges them (the SDK *replaces* the child's environment rather than merging, so it is passed whole).

**What it does not do yet.**
- `resumeDropsTurn` is **wired**, on both paths — see [Edit, Resend, Fork](edit-resend-fork.md) for how a prompt's own id is
  kept and when a cut may declare the turn it discards. It is the gain phase 1 was after, and it came with a trap worth
  knowing: the CLI validates the *whole* discarded range against the one declared turn, so declaring a turn while discarding
  two is refused, and a refusal costs the session. ZumiBot therefore declares only where exactly one turn goes, per member in a room. The SDK
  adapter uses the typed `resumeDropsTurn` option; the CLI adapter passes the hidden flag only on a binary that a probe found
  takes it. Both keep ZumiBot's own `FORK_IGNORED` check beside it.
- The hook switches the main turn only. Side runs (`/btw`, keep-warm pings), the moderator, the room summary and the workflow
  bare calls still spawn through their own injected functions.
- The SDK owns the process, so `RunOutcome.exitCode`/`signal` are not the child's: a clean end reports `0`, a stopped run
  `null`, and anything else sets `spawnError`. `isMissingSession` still reads the CLI's stderr, which the SDK forwards through
  its `stderr` callback.

**Install and bundle cost.** `@anthropic-ai/claude-agent-sdk` is pinned to `0.3.325` (its `claudeCodeVersion` is 2.1.325) in
`zumi-bot-server/backend`. Installing it added 10 packages and took `node_modules` from 844 MB to **1.2 GB**: 349 MB of that
is the per-platform Claude Code **native binary** in the SDK's `optionalDependencies`, which it needs only when
`pathToClaudeCodeExecutable` is unset — and ZumiBot always sets it. `npm install --omit=optional` therefore works and keeps
the tree at about 65 MB for the SDK instead of 414 MB; a plain `npm ci` pulls the binary. The other 26 MB is
`@anthropic-ai/sdk`, which npm installs as a peer even though `sdk.mjs` imports only node builtins. Bundling is unaffected: the
adapter is its own chunk, and phase 1 verified a Vite bundle of the SDK runs with no `node_modules` present at all.

**Tests.** `backend/tests/core/claudeSdkEngine.test.ts` (16 tests) drives the adapter with a fake `query()`, so nothing spawns:
the options it builds (binary, agent, fork, the preset system prompt, the merged `--mcp-config` and `--settings`, the flags with
no typed home, the merged env), that it refuses a turn whose argv it would have to drop, that the SDK's messages come out of the
one stream parser as the right events, the permission bridge (card, answer, abort, and every open card denied at the end), that
a stop interrupts the query, and that a thrown query is a `spawnError`.

**Running the suites on it.** `harness.mjs` strips every `ZUMIBOT_*` from the environment it gives the server, so the hook is
passed through on purpose: `ZUMIBOT_CLAUDE_SDK=1 npm run e2e` runs every suite on the SDK adapter, and the suites that use the
fake claude work there too — the SDK needs no handshake the fake lacks, which was checked directly before any of this was wired.

**`npm run e2e` passes on it** (Claude Code 2.1.325, and again on 2.1.326 after the machine's CLI updated — so the adapter
also drove a CLI one version ahead of the `claudeCodeVersion` its SDK pins; with `ZUMIBOT_SKIP_CODEX_PROBE=1` since no codex
is installed): all 20
web checks, among them 7 (Stop with a pending card, no process left), 9 (an expired session reseeding, so `isMissingSession`
still reads the SDK's forwarded stderr), 13 (`--add-dir` with `--resume`, i.e. `additionalDirectories`), 16 (queued follow-ups
and a Stop mid-reply), **17 (edit and switch back on the real CLI — the rewind this whole seam exists for)**, 19 and 20 (the
to-do MCP bridge through the real CLI, i.e. the merged `--mcp-config`), and 18 (`/btw`, which still runs on the CLI runner even
with the hook on); then the desktop-ask, side-ask, pause, vault-guard, extensions and thinking probes. Two things had to give
first, and neither was the adapter:

- The step-7 process assertion matched the literal `--agent <name>`, while the SDK spells flags `--agent=<name>`. It now
  accepts either, and still requires a live `claude` child for that agent.
- `fake-claude.mjs` ignored everything that was not a `control_response`, so the SDK's interrupt — the `control_request` the
  real CLI honours by abandoning its turn, where the CLI runner sends SIGINT — went unread and the fake finished the reply the
  user had stopped. The fake now answers it and exits. The CLI runner never sends one, so nothing else changed, and
  `npm run e2e` was re-run on the default adapter afterwards to confirm that rather than argue it: both adapters pass the same
  20 checks and the same six probes.

So the condition for retiring the CLI adapter is met on this machine; what is still missing before that would be worth doing is
`resumeDropsTurn` above, and the fact that the hook covers the main turn only.

## Phase 4 — exhaustive engine checks

**Why.** Phase 2's seam left about 70 sites deciding by engine name, almost all a binary `onCodex ? codexThing : claudeThing`.
Adding a third member to `Engine` would have silently given that engine Claude's machinery at each one: the pause settings, the
vault guard, the cost baseline, the thinking probe, `CLAUDE_CODE_TMPDIR`, `cut` stamps and finally a `claude` spawn (see
[Protocol engines](protocol-engines.md)). This phase removes that trap with no behaviour change: every existing test and fixture
passes unchanged.

**The rule.** Every site now takes one of four forms:

| What the site does | Form |
| --- | --- |
| Both engines have their own version (texts, readers, the launch, locate, the session-gone test) | an exhaustive `switch (engine)` ending in `assertNever`, or a `Record<Engine, …>` |
| A Claude-only part (pause `--settings`, vault guard, cost baseline, tmp dir, thinking, drops, `cut`/`sent` stamps, extensions run config, the tools and model cards) | `engine === 'claude'` |
| A Codex-only part (its hooks, compact limit, `definitionOf`) | `engine === 'codex'` |
| A session mark ("holds another engine's session", carrying a stamp's engine) | generic: `sessionMark` / `markEngine` / `engineField`, `sessionEngine !== undefined` |

So a new engine either fails typecheck where a decision is due, or gets none of another engine's one-sided machinery — never the
wrong one. `shared/tests/engineChecks.test.ts` keeps `onCodex` and `!== 'codex'` out of `backend/src`, `shared/src` and
`frontend/src`.

**The vocabulary** (`shared/src/engine.ts`):
- `Provider` (every engine but Claude), the type of `provider:`, `ChatMeta.sessionEngine`, `SessionCut.engine` and
  `GroupInfo.sessionEngines`.
- `parseProvider`: exact names from a `Record<Provider, true>`. Anything else is still Claude, as before.
- `sessionMark` / `markEngine` / `providerOf`. `markEngine` keeps an unknown mark raw, so a mark this build does not know never
  reads as Claude's own session.
- `ENGINE_LABEL` and `ENGINES` (its keys), `assertNever`, and `engineCaps` as a `Record` lookup.
- `roomRefusal(engine, member)` and `capRefusal(engine, cap)`. Each engine's own fixed sentence, so a future engine never
  inherits Codex's "not available for Codex agents".
  - The room checks (`refuseCodexMembers`, `GroupService.refuseOn`) judge each member by its own engine's `rooms` cap.
  - The handlers' `refuseWithout` names the engine that lacks the cap.

**Where it shows.**
- `ChatService`.
  - `agentTurn` reads `const engine = spec.engine ?? 'claude'`.
  - Exhaustive switches cover the turn model, the vault key env (keys only beside a guard), the side base, the launch, whether
    the prompt reached the agent, locate, the session-gone test and `pauseReady`.
  - `notFoundText` (a switch: the ACP sentence names the agent's own command), `FORK_IGNORED_TEXT` and `ENGINE_LABEL` give
    the fixed texts.
- `sessionPoints.ts`: `END_IS_CUT` says whose turn-end stamp is a reply's cut point.
- `extensionsService.ts` / `sanitize.ts`: `VAULT_GUARD_ON`, the probe switch and `READERS`.
- `app.ts`: `baseFor` switches on the engine.
- The frontend.
  - `engineChoices` is built from `ENGINES`. `engineTag` and `engineTagOf` read a `Record`.
  - `cliMissing`, `vaultGrantNote`, `modelAfterEngineSwitch` and `readOnlyNote` are switches.
  - Agent Studio shows its Claude-only cards on `engine === 'claude'` or on the `memory` / `desktop` caps.
  - `CommandsCard` takes `claudeModels`.

**The proof.** With `'acp'` added to `Engine` (a scratch edit, reverted), `npm run typecheck` fails at exactly the places that
must decide:
- *shared*: `ENGINE_LABEL`, `PROVIDERS`, the caps `Record`, `roomRefusal`, `capRefusal` and `modelFits`.
- *backend*: `NOT_FOUND_TEXT`, `FORK_IGNORED_TEXT`, `pauseReady`, the turn model, the key env, the side base, locate and the
  session-gone test in `chatService.ts`; `END_IS_CUT`; `VAULT_GUARD_ON`; the probe switch; `READERS` and `unsupportedText`; and
  `app.ts`'s `baseFor`.
- *frontend*: `cliMissing`, `unavailable`, `ENGINE_TAG`, `apiKeyNote`, `modelAfterEngineSwitch`, `readOnlyNote`, the model
  picker's switch and `runPickers`' `MODE_HINT`.

The launch and "prompt reached" switches in the attempt appear once the side-base switch above them handles the new engine. That
one's `assertNever` narrows the rest of the attempt, so TypeScript reports them on the next pass.

**Left as it was.**
- Side bases are Claude's or Codex's by their shape (`base.codex`) in `sideRun.ts` and `sideQuestions.ts`. Only those two engines
  answer side questions, and a new engine with `btw` would need a base shape of its own anyway.
- `isCodexChat` keeps its name but now means any non-Claude session or engine.
- The new caps the protocol design names (`resend`, `fork`, `cost`, `models`, `remote`, `bridges`) land in Phase 1b, with the
  first engine that sets them false and the UI that reads them. Added here, they would have been read nowhere.

**Phase 1b.** `'acp'` is now a real member of `Engine`, and every place above has its `acp` case (the proof list was the work
list). The six new caps are on every engine (Claude and Codex: all but `remote`); `ChatService` reads `bridges` for its
bridges, their paragraphs and the board note. `NOT_FOUND_TEXT` became `notFoundText`. See
[Protocol engines](protocol-engines.md), "Phase 1b as built".

**The merge with master 10.5.7.** Master's governance work tested Codex by name for isolation (`a.provider === 'codex'`, and
`onCodex ? 'codex' : 'claude'` for the run's isolation and audit engine), which would have let an ACP or remote agent fall
into Claude's side. Those became the `isolation` cap (only Claude has it; `isolationRefusal` keeps Codex's sentences) and the
run's own `engine`; `AuditEngine` is `Engine`, and the audit tap reads the `remote` cap. Settings › Connectors' Codex note
became `connectorEngineNote`, a switch. See [Protocol engines](protocol-engines.md), "Governance, connectors and card comments".

## Honest limits

Of the SDK adapter (phase 3):

- What is unit-tested is the translation, not Claude Code's behaviour on the far side of it; the e2e run above is what
  exercises the real CLI, and it drives a chat through the UI rather than every feature ZumiBot has. The suites that are not
  part of `npm run e2e` (`e2e:group`, `e2e:routines`, `e2e:workflows`, `e2e:versions`, `e2e:pause`, ...) have not been run on
  the adapter, and nor has a room, a routine or a workflow.
- The declared cut was probed against Claude Code 2.1.325 only, and only through the SDK's option; the CLI flag's own
  behaviour is taken on the probe's word that the binary knows it, plus the unit tests over the argv.
- A user's installed `claude` being *older* than the SDK's `claudeCodeVersion` is still unprobed; a newer one is not, since the
  suite passed on 2.1.326 with the SDK pinning 2.1.325. The SDK's version pins a CLI version it expects, and
  `pathToClaudeCodeExecutable` deliberately points somewhere else.
- The 349 MB native binary is installed by a plain `npm ci` even though nothing uses it. `--omit=optional` is a flag, not a
  setting in the repo, so `deploy` and the desktop build do not yet pass it.

Of the seam (phase 2):

- The adapters wrap the same injected `run`/`codexRun` deps, so nothing about how either CLI is spawned changed — this is a
  seam, not a new runner. `npm run e2e` was not run for it: it needs the real CLIs.
- `sideRun.ts`, `moderator.ts`, `roomSummary.ts` and the workflow bare calls still spawn through their own injected functions.
  The moderator, the room summary and Zumi Bot stay on Claude by design, so only `sideRun` is a candidate for the seam later,
  and it shares the start translation already.
- The four caps that moved are only as honest as `engineCaps`: flipping `desktop`, `plan`, `memory` or `keepWarm` on for Codex
  now changes what `ChatService` runs, which is the point, but nothing in Codex has been probed to make any of them true.

Of the spike (phase 1):

- No production code changed and no dependency was added to any workspace; every probe ran in a throwaway install outside the repo.
- Probes ran against `claude 2.1.325` and SDK `0.3.325` on Linux x64 only. Nothing here was checked on macOS or Windows, in the packaged Electron shell, or against an older `claude` than the SDK's `claudeCodeVersion` — a user's installed CLI being behind the SDK is an untested combination and the obvious first thing for phase 3 to probe.
- `canUseTool` was exercised for `Write`, `AskUserQuestion` and `ExitPlanMode`. A `Bash` probe did not reach it (the model declined the prompt rather than calling the tool), so the Bash card path over the SDK is unverified.
- The SDK's `hooks` callbacks, `settings` option, `mcpServers` (the per-run bridges), `disallowedTools`, streaming input mid-turn and `interrupt()` were read from the shipped types but not run. The pause hook's and vault guard's fail-closed contract in particular would need its own probe: today's shell hooks run inside the CLI's process tree, while a callback runs in the server, and `onFailure: 'block'` is documented to fail the query at startup on a CLI that does not support it.
- ACP findings come from the published JSON schemas and the reference adapters' code. `agentclientprotocol.com` is blocked by this session's network policy, so the prose spec was not read and the claim that Gemini CLI and opencode speak ACP natively rests on third-party sources.
- No ACP agent was actually run, so nothing about a real agent's `session/update` stream, diff quality or permission-option vocabulary is verified.
