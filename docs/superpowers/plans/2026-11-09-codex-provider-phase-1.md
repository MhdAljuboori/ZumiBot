# Codex Provider (Phase 0 and Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent file with `provider: codex` runs its single chats on the Codex CLI (`codex app-server`) behind the existing chat UI, with every Claude run unchanged byte for byte.

**Architecture:** A new `core/codex/` runner speaks JSON-RPC to one `codex app-server --listen stdio://` process per CLI attempt and maps its notifications and server requests onto the existing `RunEvent` union. Then `ChatService` consumes them unchanged. `ChatService.agentTurn` branches only at the spawn site. Bridges expose a structured `McpServerSpec` beside their unchanged Claude argv. Features Codex cannot do yet are gated by `engineCaps` on the server and in the UI.

**Tech Stack:** TypeScript, Node 22, vitest, React 19, the `codex` CLI 0.164.0 app-server protocol (no new npm dependency).

**Spec:** `docs/superpowers/specs/2026-11-09-codex-provider-design.md`. This plan implements probe checks 1–6 and Phase 1. Checks 7–13 gate Phases 2 and 3 and land with those plans.

## Global Constraints

- **Byte-identical Claude runs.** Every Claude run's argv, env and stdin stay exactly as they are today. Task 2 pins this with a test, and that test must pass after every task.
- **No bypass values.** Never send `--dangerously-bypass-approvals-and-sandbox`, sandbox `danger-full-access` or `approvalPolicy: "never"` to Codex.
- **Fixed error text.** Use these exact sentences:
  - `codex` missing: "Codex CLI not found. Install it and run `codex login` on this machine."
  - Not signed in: "Codex is not signed in on this machine. Run `codex login` in a terminal."
- **Gate refusals.** Use exact text from `CODEX_REFUSALS` (Task 1). Never pass CLI text through.
- **No secrets in output.** Codex tokens, `~/.codex/auth.json` contents and bridge capabilities never reach logs, errors or the UI. Capability values go through the same `privateValues` and scrub sets as Claude runs.
- **`provider` is ZumiBot-only.** Absent, or anything but the exact string `codex`, means Claude. The writer deletes the key and never writes `provider: claude`.
- **One process per attempt.** Each attempt spawns `codex app-server --listen stdio://` with `--disable multi_agent`. It never uses the shared daemon.
- **Permission modes.**
  - `manual` → `approvalPolicy: "untrusted"`, `approvalsReviewer: "user"`.
  - `auto` → `approvalPolicy: "on-request"`, `approvalsReviewer: "auto_review"`.
  - Both use sandbox `workspace-write` with network access on.
- **Answer mapping.** Allow → `accept` (never `acceptForSession`). Deny → `decline`.
- **Context tokens.** Context = `last.inputTokens + last.outputTokens`. Cached tokens are already inside `inputTokens`.
- **Tool output cap.** Tool result content is cut at `CODEX_TOOL_OUTPUT_MAX = 30_000` characters, followed by `\n[output cut]`.
- **Existing conventions.** Comments are short and say why. Dependencies are pinned. `devEnv()` dev hooks are unchanged.
- **No commits.** The user's global rule: never commit unless the user asks. Each task ends at a **checkpoint** (tests green, files listed), not a commit.

## Review Focus

1. **Non-JSON on stdout.** The app-server may print a banner or warning line to stdout. Expected: the line is ignored and the turn goes on. Tested in Task 4 (`ignores non-JSON lines`).
2. **Missing or signed-out `codex` on the VPS.** Expected: a routine or workflow step using a Codex agent fails at once with the fixed sentence, never hangs. Tested in Task 9 (`codex not found`) and Task 8 (`unauthorized maps to the sign-in sentence`).
3. **Agent provider changed mid-chat.** Expected: a Claude session id never reaches `thread/resume`, and a Codex thread id never reaches `--resume`. The next turn reseeds with the `expired` notice. Tested in Task 9 (`engine switch reseeds`).
4. **Card answered after the turn was interrupted.** Expected: the stale answer is dropped, nothing throws, and `serverRequest/resolved` cancels the card. Tested in Task 8 (`late answer after interrupt`).
5. **Huge command output (MBs from a build log).** Expected: the tool row holds at most 30 000 characters plus the note. Tested in Task 6 (`caps tool output`).

---

### Task 0: Codex probe, checks 1–6 (Phase 0)

**Files:**
- Create: `zumi-bot-server/e2e/codexProbe.mjs`
- Create: `zumi-bot-server/e2e/fixtures/probe-codex-mcp.mjs` (a stub stdio MCP server with one tool `probe_echo {text}`. It writes `marker-mcp.txt` in its cwd holding `text` and the value of env `PROBE_TOKEN`.)
- Create: `zumi-bot-server/backend/tests/codexProbe.test.ts`
- Modify: `package.json` (root): append `&& node zumi-bot-server/e2e/codexProbe.mjs --soft` to `e2e`. Add `"probe:codex": "node zumi-bot-server/e2e/codexProbe.mjs"`.

**Interfaces:**
- Produces: `export function judge(check: number, t: Transcript): 'pass' | 'fail' | 'inconclusive'`.
- Produces: `export interface Transcript { lines: Array<{dir: 'in' | 'out'; msg: any}>; files: Record<string, boolean>; exit: number | null }`.
- Produces: `--record <dir>`, which writes each check's transcript as `<dir>/codex-check<N>.jsonl`. Tasks 6 and 8 use those files as fixtures.

The probe follows the pattern of `e2e/sideAskProbe.mjs`:
- **Exit codes.** Exit 0 PASS, 1 FAILED, 2 INCONCLUSIVE. Each check is retried once on INCONCLUSIVE.
- **`--soft`.** Turns 2 into 0 with a loud warning.
- **Skipping.** `ZUMIBOT_SKIP_CODEX_PROBE=1` skips the probe.
- **Binary.** `ZUMIBOT_PROBE_CODEX` names the binary; the default is `codex`.
- **Model.** `PROBE_CODEX_MODEL` sets `model` when present.
- **Client.** It carries its own minimal JSON-RPC line client: `{id, method, params}` with no `jsonrpc` field, then the `initialized` notification after the `initialize` answer.
- **Isolation.** Each check runs in a fresh `mkdtemp` folder with `git init`, and kills its process group at the end.

- [ ] **Step 1: Write `codexProbe.test.ts` for `judge` with hand-written transcripts**
  - Check 1 passes only when all of the following hold:
    - a `thread/start` answer carries `thread.id`;
    - an `item/agentMessage/delta` arrives;
    - `turn/completed` has `turn.status === 'completed'`;
    - at least one `thread/tokenUsage/updated` arrives;
    - the sum of `tokenUsage.last.totalTokens` over the turn equals the last `total.totalTokens`.
  - Check 1 is INCONCLUSIVE when no `initialize` answer arrives.
  - Check 3 FAILS when the `outside-marker` file exists before the probe answers `decline`.
  - Check 3 PASSES when an `item/commandExecution/requestApproval` came, the file is absent after `decline` and present after the second run's `accept`.
  - Check 5 FAILS when `marker-mcp.txt` lacks the token, meaning `env_vars` did not forward it.
  - Check 6 PASSES when `turn/completed` has status `interrupted` within 10 s of `turn/interrupt`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/codexProbe.test.ts`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement `codexProbe.mjs` with the six checks:**
  - **Check 1, basics.** A text prompt plus a 1×1 PNG `{type: 'image', url: 'data:image/png;base64,…'}`. Ask the model to run `echo hi` once, so the turn makes two model requests.
  - **Check 2, instructions.** `baseInstructions: 'Always end every reply with the word KIWI.'`. Then resume the thread in a new process with `'…the word MANGO.'` and expect MANGO, not KIWI.
  - **Check 3, manual mode.** `untrusted` with reviewer `user`. The command is `touch ../outside-marker`. Answer `decline`, then repeat in a new turn and answer `accept`. Also `cat` a file made outside the workspace and record whether an approval came.
  - **Check 4, auto mode.** `on-request` with `auto_review`. Running `echo ok > inside.txt` must produce no client request. Running `curl -sI https://example.com` must succeed with config `{'sandbox_workspace_write.network_access': true}`.
  - **Check 5, MCP.** The `config` carries `mcp_servers.probe` = `{command: node, args: [stub], env_vars: ['PROBE_TOKEN'], tool_timeout_sec: 600}`, with `PROBE_TOKEN` set in the process env. The prompt also asks the model to reply with the exact name of the tool it called. Record:
    - the `mcpToolCall` item's `server` and `tool`;
    - the name the model reports, which is how the app's prompt texts must name tools;
    - whether an `mcpServer/elicitation/request` came, answered `accept`;
    - whether the token appears in any file under `$CODEX_HOME/sessions` (default `~/.codex`) that names the thread id. A token found there is FAILED.
  - **Check 6, Stop.** Run `sleep 30` and send `turn/interrupt` after `item/started`.
  - **Report.** Print a summary block naming each check's verdict and the recorded facts: the MCP tool name, whether an elicitation came, whether the outside read asked, and the `userAgent`.
- [ ] **Step 4: Run** `npx vitest run zumi-bot-server/backend/tests/codexProbe.test.ts`. Expected: PASS.
- [ ] **Step 5: Run the real probe:** `node zumi-bot-server/e2e/codexProbe.mjs --record zumi-bot-server/backend/tests/fixtures/codex`. This uses a few cents of the user's Codex quota. Paste the printed summary into a new section, `## Phase 0 results`, at the end of this plan.
- [ ] **Step 6: Gate.** Stop and report to the user if check 1, 3 or 4 FAILED. If check 5 FAILED, Phase 1 continues with Codex runs getting no MCP bridges: Task 9 passes `mcpServers: []` and the `askable`/to-do prompt texts are left out. Note it in the results.
  - **Elicitation finding.** If check 5 shows no elicitation, MCP calls never ask in Codex. Then the own-bridge auto answers are simply unused.
  - **Tool-name finding.** If the model reports a name other than `mcp__probe__probe_echo`, stop and extend this plan with a task. `TODO_SYSTEM`, `VAULT_SYSTEM`, `askSystem` and the browser prompt name tools as `mcp__<server>__<tool>`, so they need a per-engine rendering before Task 9.
  - **Outside-read finding.** If the outside read asked, Task 7 adds the chat's attachments folder to `sandbox_workspace_write.writable_roots`.
- [ ] **Step 7: Checkpoint.** Files: the four above plus the recorded fixtures.

### Task 1: Shared engine types, the `provider` key and `engineCaps`

**Files:**
- Create: `zumi-bot-server/shared/src/engine.ts`
- Modify: `zumi-bot-server/shared/src/frontmatter.ts`: add `AgentFields.provider` to `fieldsOf`, the `serializeAgent` fast-path equality and the set/delete block.
- Modify: `zumi-bot-server/shared/src/types.ts`:
  - `AgentSummary.provider?: 'codex'`;
  - `ChatMeta.sessionEngine?: 'codex'`;
  - a `ZumiBotApi.codexInfo(): Promise<CodexInfo>`.
- Modify: `zumi-bot-server/backend/src/core/agents/agentStore.ts`: the summary carries `provider`, plus a new method `definitionOf`.
- Test: `zumi-bot-server/shared/tests/engine.test.ts`, `zumi-bot-server/shared/tests/frontmatter.test.ts` (add cases), `zumi-bot-server/backend/tests/core/agentStore.test.ts` (add cases).

**Interfaces:**
- **Engine types.** `export type Engine = 'claude' | 'codex'`. `export interface CodexInfo { found: boolean; models: string[] }`.
- **Capabilities.** `export interface EngineCaps { pause: boolean; btw: boolean; compact: boolean; rewind: boolean; files: boolean; desktop: boolean; vaultKeys: boolean; rooms: boolean; questions: boolean; plan: boolean; memory: boolean; keepWarm: boolean; dispatch: boolean }`.
- **`engineCaps(engine: Engine): EngineCaps`.** Every flag is true for `claude` and false for `codex`.
- **Resolvers.**
  - `engineOfAgent(a: Pick<AgentSummary, 'provider'> | undefined): Engine`.
  - `chatEngine(chat: Pick<ChatMeta, 'agentName' | 'group'>, agents: readonly AgentSummary[]): Engine`. A room is always `claude`.
- **`export const CODEX_REFUSALS`**, holding this exact copy:
  - `btw: 'Side questions are not available for Codex agents yet.'`
  - `compact: 'Compact is not available for Codex agents yet.'`
  - `pause: 'Pause is not available for Codex agents yet.'`
  - `room: (name: string) => \`${name} runs on Codex, and Codex agents can't join a room yet.\``
  - `notFound: 'Codex CLI not found. Install it and run \`codex login\` on this machine.'`
  - `signedOut: 'Codex is not signed in on this machine. Run \`codex login\` in a terminal.'`
- **`AgentStore.definitionOf(name: string): Promise<{ body: string; model: string | null } | null>`.** Returns the parsed body and the `model:` of the agent with that name, or null when it is missing or broken. Codex has no `--agent`, so ZumiBot sends both itself.

- [ ] **Step 1: Write failing tests**
  - `engine.test.ts`:
    - `engineCaps('codex')` has every flag `false` and `engineCaps('claude')` every flag `true`;
    - `chatEngine` of a room whose members include a Codex agent is `'claude'`;
    - `chatEngine({agentName: 'x'}, [{name: 'x', provider: 'codex', …}])` is `'codex'`.
  - `frontmatter.test.ts`:
    - `provider: codex` parses to `'codex'`;
    - `provider: Codex`, `provider: claude` and `provider: "codex "` parse to `null`;
    - `serializeAgent` with `provider: null` on a file that had `provider: codex` removes the line;
    - setting `'codex'` adds `provider: codex`;
    - a file without the key, with only its body changed, comes back with its frontmatter verbatim.
  - `agentStore.test.ts`:
    - `list()` carries `provider: 'codex'` only for such a file;
    - `definitionOf('a')` returns `{body: <the text after the closing --->, model: 'gpt-x'}` for a file with `model: gpt-x`, and `model: null` without the key;
    - `definitionOf('missing')` is `null`.
- [ ] **Step 2: Run** `npx vitest run --project shared && npx vitest run zumi-bot-server/backend/tests/core/agentStore.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the interfaces above. `fieldsOf` reads `data.provider === 'codex' ? 'codex' : null` (strict, like `computerUse`).
- [ ] **Step 4: Run** the same commands, then `npm run typecheck`. Expected: PASS. TypeScript flags every `AgentFields` literal in the code that lacks `provider`; give each `provider: null`.
- [ ] **Step 5: Checkpoint.**

### Task 2: Pin Claude argv, add `McpServerSpec` to every bridge

**Files:**
- Create: `zumi-bot-server/backend/src/core/ipc/mcpSpec.ts`
- Create: `zumi-bot-server/backend/tests/core/claudeArgsPinned.test.ts`
- Modify: these six bridges. Each turn type gains `mcp: McpServerSpec`, and `args` is built from `claudeMcpConfig(spec)`.
  - `zumi-bot-server/backend/src/core/todos/todoIpc.ts`
  - `zumi-bot-server/backend/src/core/vault/vaultIpc.ts`
  - `zumi-bot-server/backend/src/core/asks/askIpc.ts`
  - `zumi-bot-server/backend/src/core/automations/automationIpc.ts`
  - `zumi-bot-server/backend/src/core/browser/browserIpc.ts`
  - `zumi-bot-server/backend/src/core/desktop/desktopIpc.ts`

**Interfaces:**
- Produces: `export interface McpServerSpec { name: string; command: string; args: string[]; passEnv: string[]; fixedEnv: Record<string, string>; alwaysLoad?: true; timeoutMs?: number }`.
  - `passEnv` holds the names whose values the run's env carries (capability, IPC path).
  - `fixedEnv` holds literal values, such as `ELECTRON_RUN_AS_NODE: '1'`.
- Produces: `export function claudeMcpConfig(s: McpServerSpec): { mcpServers: Record<string, unknown> }`.
  - Key order: `type: 'stdio'`, `command`, `args`, then `alwaysLoad` when set, then `timeout` when set, then `env`.
  - `env` is `passEnv` mapped to `'${NAME}'`, followed by `fixedEnv`.
- Produces: `TodoTurn.mcp`, `VaultTurn.mcp`, `AskTurn.mcp`, `AutomationTurn.mcp`, `BrowserTurn.mcp`, `DesktopTurn.mcp`, all typed `McpServerSpec`.

- [ ] **Step 1: Write `claudeArgsPinned.test.ts` before touching any bridge.**
  - **Bridges.** For each bridge, build a turn with a fake runtime (`node: '/n'`, entries `'/b.mjs'`, `electronNode: false`, then `true`), using each file's existing test setup as the model. Assert `turn.args` equals the literal strings the current code produces; paste them from a first run.
  - **`buildArgs`.** Pin its output for:
    - a plain turn;
    - a resumed turn;
    - a cut turn (`resumeAt`);
    - a turn with `appendSystemPrompt`;
    - a turn with two `--settings` fragments;
    - a turn with `disallowedTools`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/claudeArgsPinned.test.ts`. Expected: PASS against today's code.
- [ ] **Step 3: Add a test** asserting each turn's `mcp` equals the expected spec. For example, todos gives `{name: 'zumibot_todos', command: '/n', args: ['/b.mjs'], passEnv: ['ZUMIBOT_TODOS_CAPABILITY', 'ZUMIBOT_TODOS_IPC'], fixedEnv: {}, alwaysLoad: true}`, and the ask bridge has `timeoutMs: 86400000`. Run it. Expected: FAIL.
- [ ] **Step 4: Implement** `mcpSpec.ts` and switch the six bridges to it.
- [ ] **Step 5: Run** `npx vitest run --project backend`. Expected: all PASS, the pinned test unchanged.
- [ ] **Step 6: Checkpoint.**

### Task 3: Codex pricing and run cost

**Files:**
- Modify: `zumi-bot-server/shared/src/pricing.ts`
- Create: `zumi-bot-server/backend/src/core/codex/codexCost.ts`
- Test: `zumi-bot-server/shared/tests/pricing.test.ts` (add cases), `zumi-bot-server/backend/tests/core/codexCost.test.ts`

**Interfaces:**
- Produces: `export interface CodexRates { input: number; cachedInput: number; output: number }` (USD per million tokens).
- Produces: `export const CODEX_PRICING: Record<string, CodexRates>`. Fill it from OpenAI's published price list on the day of building. The comment names the date and source, as the Claude table does. Include every model `model/list` returned in the Phase 0 results.
- Produces: `export interface CodexTokens { input: number; cachedInput: number; output: number }`. `input` includes `cachedInput`, as OpenAI reports it.
- Produces: `export function priceCodex(model: string, t: CodexTokens): number | null`.
- Produces: `export function codexRunCost(model: string | null, t: CodexTokens): RunCost`, from `backend/src/core/usage/runCost.ts`'s `RunCost`. Its one entry is keyed by the model name, or `'unknown'`.
  - `input`: `t.input - t.cachedInput`.
  - `cacheRead`: `t.cachedInput`.
  - `cacheWrite`: 0.
  - `output`: `t.output`.
  - `costUsd`: the price, or `null` when unpriced.
  - `totalUsd`: the price, or `0` when unpriced.

- [ ] **Step 1: Write tests**
  - For a model `m` in `CODEX_PRICING`, `priceCodex(m, {input: 2_000_000, cachedInput: 500_000, output: 1_000_000})` is close to `1.5*r.input + 0.5*r.cachedInput + 1*r.output`.
  - `priceCodex('nope', …)` is `null`.
  - `codexRunCost('nope', t).models.nope.costUsd` is `null` with `totalUsd === 0`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/codexCost.test.ts --project shared`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 4: JSON-RPC line client

**Files:**
- Create: `zumi-bot-server/backend/src/core/codex/codexRpc.ts`
- Test: `zumi-bot-server/backend/tests/core/codexRpc.test.ts`

**Interfaces:**
- **Types.**
  - `export type RpcId = string | number`.
  - `export type RpcIncoming = { kind: 'notification'; method: string; params: any } | { kind: 'request'; id: RpcId; method: string; params: any }`.
  - `export class RpcError extends Error { constructor(readonly code: number, message: string) }`.
- **`export class CodexRpc { constructor(write: (line: string) => boolean) }`**, with these methods:
  - `request<T>(method: string, params: unknown): Promise<T>`;
  - `notify(method: string, params?: unknown): void`;
  - `respond(id: RpcId, result: unknown): void`;
  - `respondError(id: RpcId, code: number, message: string): void`;
  - `receive(line: string): RpcIncoming | null`;
  - `close(err: Error): void`.
- **Wire format.** One JSON object per line, with no `jsonrpc` field unless the Phase 0 results say the server needs one. Ids are integers from 1.

- [ ] **Step 1: Write tests:**
  - `request` writes `{"id":1,"method":"m","params":{}}\n`;
  - a response line `{"id":1,"result":{"a":1}}` resolves it, and `receive` returns `null`;
  - an `{"id":2,"error":{"code":-32600,"message":"bad"}}` line rejects with `RpcError` code `-32600`;
  - a line with `method` and no `id` is a notification;
  - a line with both is a request;
  - **ignores non-JSON lines:** `receive('codex starting…')` returns `null` and throws nothing;
  - `close(new Error('x'))` rejects every pending request;
  - `write` returning `false` rejects that request at once.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/codexRpc.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 5: Thread parameters, input and answer translation

**Files:**
- Create: `zumi-bot-server/backend/src/core/codex/codexParams.ts`
- Create: `zumi-bot-server/backend/src/core/codex/codexAnswers.ts`
- Test: `zumi-bot-server/backend/tests/core/codexParams.test.ts`

**Interfaces:**
- Consumes: `McpServerSpec` (Task 2), `PermissionMode` (`core/chat/claudeRunner.ts`), `UserContent` (`core/chat/controlProtocol.ts`).
- Produces: `export interface CodexThreadInput { cwd: string; model?: string; baseInstructions: string; permissionMode: PermissionMode; mcpServers: McpServerSpec[] }`.
- Produces: `export function threadParams(i: CodexThreadInput): Record<string, unknown>`. It returns `{cwd, model?, baseInstructions, approvalPolicy, approvalsReviewer, sandbox: 'workspace-write', config}`.
  - `config` is `{'sandbox_workspace_write.network_access': true, 'features.multi_agent': false, ...mcp}`.
  - `mcp` maps each spec to `'mcp_servers.<name>': {command, args, env: fixedEnv, env_vars: passEnv, tool_timeout_sec?}`, where `tool_timeout_sec` is `Math.ceil(timeoutMs / 1000)`.
  - Use the key form the Phase 0 results proved.
- Produces: `export function codexInput(c: UserContent): Array<Record<string, unknown>>`. Text becomes `{type: 'text', text, text_elements: []}`. A base64 image becomes `{type: 'image', url: 'data:<media_type>;base64,<data>'}`.
- Produces: `export type CodexRequestKind = 'command' | 'fileChange' | 'permissions' | 'elicitation' | 'userInput'`.
- Produces: `export function codexAnswer(kind: CodexRequestKind, controlResponse: object, request: any): { result: unknown } | { error: { code: number; message: string } }`. It translates the objects `allowResponse`, `denyResponse` and `errorResponse` build (`core/chat/controlProtocol.ts`):

  | kind | allow | deny |
  |---|---|---|
  | `command`, `fileChange` | `{decision: 'accept'}` | `{decision: 'decline'}` |
  | `permissions` | `{permissions: request.permissions, scope: 'turn'}` | `{permissions: {}, scope: 'turn'}` |
  | `elicitation` | `{action: 'accept', content: null, _meta: null}` | `{action: 'decline', content: null, _meta: null}` |
  | `userInput` | always `{error: {code: -32601, message: 'ZumiBot does not handle this request'}}` | same |

  `errorResponse` maps to `{error: {code: -32603, message}}`.

- [ ] **Step 1: Write tests:**
  - **manual mode:** `threadParams` gives `approvalPolicy: 'untrusted'` and `approvalsReviewer: 'user'`;
  - **auto mode:** `'on-request'` and `'auto_review'`;
  - **forbidden values:** for both modes, `JSON.stringify(threadParams(...))` contains none of `danger-full-access`, `"never"` or `bypass`;
  - `model` is absent when not given;
  - the ask bridge's spec turns into `tool_timeout_sec: 86400` and `env_vars: ['ZUMIBOT_ASKS_CAPABILITY', 'ZUMIBOT_ASKS_IPC']`;
  - `codexInput([{type: 'text', text: 'a'}, {type: 'image', source: {type: 'base64', media_type: 'image/png', data: 'QQ=='}}])` returns the two inputs above;
  - `codexInput('hi')` is one text input;
  - `codexAnswer('command', allowResponse('7', {}), {})` is `{result: {decision: 'accept'}}`;
  - `codexAnswer('fileChange', denyResponse('7', 'no'), {})` is `{result: {decision: 'decline'}}`;
  - `codexAnswer('userInput', allowResponse('7', {}), {})` is an error.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/codexParams.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 6: Event mapper

**Files:**
- Create: `zumi-bot-server/backend/src/core/codex/codexEvents.ts`
- Test: `zumi-bot-server/backend/tests/core/codexEvents.test.ts`. It uses the recorded `backend/tests/fixtures/codex/codex-check*.jsonl` from Task 0, plus inline notifications.

**Interfaces:**
- Consumes: `RunEvent` (`core/chat/streamParser.ts`), `codexRunCost` (Task 3), `RpcId` (Task 4), `CodexRequestKind` (Task 5).
- Produces: `export const CODEX_TOOL_OUTPUT_MAX = 30_000`.
- Produces: `export class CodexEventMapper`, with these members:
  - **`started(threadId: string, model: string | null, version: string | null): RunEvent[]`** returns `[{kind: 'init', sessionId: threadId, version}]`.
  - **`notification(method: string, params: any): RunEvent[]`** maps by the table in the spec section "Event mapping", with these Phase 1 rules:
    - Drop `collabAgentToolCall`, `reasoning`, `plan`, `turn/plan/updated`, `turn/diff/updated`, `hook/*` and `account/rateLimits/updated`. Phase 1 emits no `rateLimit` event, so Claude's account readings are never overwritten. The mapper keeps the latest snapshot internally.
    - `error` with `codexErrorInfo === 'usageLimitExceeded'`, or a snapshot with `rateLimitReachedType` set, emits `limited`. Its `resetsAt` is the exhausted window's `resetsAt * 1000`, or the later of the two non-null windows, or `null`.
    - `turn/completed` emits `result`:
      - `uuid` is `turn.id`;
      - `sessionId` is the thread id;
      - `subtype` is `turn.status`;
      - `isError` is `turn.status === 'failed'`;
      - `windows` is `{[model]: modelContextWindow}` when known;
      - `cost` is `codexRunCost(model, Σ last over the turn's token updates)`, or `null` when no update came.
  - **`serverRequest(id: RpcId, method: string, params: any): { events: RunEvent[]; kind: CodexRequestKind | null }`** maps approval requests to `permissionRequest`:
    - `requestId` is `String(id)`;
    - `toolName` is `'Bash'`, `'ApplyPatch'`, `'SandboxPermissions'` or `` `mcp__${server}__${tool}` ``;
    - `toolUseId` is `params.itemId`.
    - A `fileChange` request's `input` is `{changes: [{path, kind: kind.type}]}`, read from the item it saw start.
    - An elicitation that is not a tool-call approval gives `kind: 'elicitation'` and no events. The runner declines it.
    - An unknown method gives `controlUnknown`.
  - **`get lastError(): string | null`** is the last `error` notification's `message`, for the outcome's `stderr`.
  - **`get model(): string | null`.**

- [ ] **Step 1: Write tests.**
  - **Replays.** Replay each recorded fixture and assert the event kinds in order. For example, check 1 gives `init`, then `textDelta`+, `toolUse(Bash)`, `toolResult`, `context`+, `assistantText`, `result` with `isError: false`.
  - **Inline cases:**
    - **caps tool output:** a `commandExecution` completed item with 100 000 characters of `aggregatedOutput` gives `content.length === 30_000 + '\n[output cut]'.length`;
    - `exitCode: 2` gives `isError: true`;
    - an `mcpToolCall` on server `zumibot_todos`, tool `add`, gives `toolUse` name `mcp__zumibot_todos__add`;
    - `thread/tokenUsage/updated` with `last {inputTokens: 1000, cachedInputTokens: 800, outputTokens: 50}` gives `context {tokens: 1050}`;
    - the `usageLimitExceeded` error after a snapshot with `primary {usedPercent: 100, resetsAt: 1900000000}` gives `limited {resetsAt: 1900000000000}`;
    - a `serverRequest` with `item/commandExecution/requestApproval` gives `permissionRequest {toolName: 'Bash', input: {command, cwd}}`, kind `command`;
    - `serverRequest/resolved` for an open request id gives `permissionCancel`;
    - an `account/rateLimits/updated` alone gives `[]`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/codexEvents.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 7: Fake Codex app-server fixture

**Files:**
- Create: `zumi-bot-server/backend/tests/fixtures/fake-codex.mjs`
- Test: `zumi-bot-server/backend/tests/core/fakeCodex.test.ts`

**Interfaces:**
- **Invocation.** The fixture is spawned as `fake-codex.mjs app-server --listen stdio://`, with any other args ignored. It answers these requests:
  - `initialize` → `{userAgent: 'fake-codex/0.0.0', codexHome: <tmp>, platformFamily: 'unix', platformOs: 'linux'}`;
  - `thread/start` → a new thread id;
  - `thread/resume` → the same id if `<FAKE_CODEX_HOME>/threads/<id>` exists, else error `{code: -32600, message: 'thread not found: <id>'}`;
  - `turn/start` → `{turn: {id}}`, then the script runs;
  - `turn/interrupt` → ends the script with `turn/completed` status `interrupted`.
- **Script.** It comes from `FAKE_CODEX_SCRIPT`: one JSON line per step, with these forms:
  - `{"notify": {method, params}}`;
  - `{"request": {method, params}}`, which waits for the client's answer and writes it to `FAKE_CODEX_ANSWERS` (a JSONL file);
  - `{"sleep": ms}`;
  - `{"mcpCall": {server, tool, args}}`, which starts the server named in the thread's `config` with its `env_vars` from the process env, calls the tool over MCP stdio, and emits `mcpToolCall` started and completed items. Model it on `fake-claude.mjs`'s `#MCP_CALL`.
  - The placeholders `$THREAD` and `$TURN` are filled in.
- **Logs and switches.**
  - `FAKE_CODEX_LOG` appends every request the fixture received (method plus params), so tests can assert `threadParams` and `codexInput`.
  - `FAKE_CODEX_UNAUTHORIZED=1` makes `turn/start` emit `error {codexErrorInfo: 'unauthorized'}` and then `turn/completed` status `failed`.

- [ ] **Step 1: Write `fakeCodex.test.ts`.** Spawn the fixture, send `initialize`, `thread/start` and `turn/start` by hand, and assert:
  - the script's notifications arrive in order;
  - a `request` step waits until it is answered;
  - the answer lands in `FAKE_CODEX_ANSWERS`;
  - `turn/interrupt` ends with `interrupted`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/fakeCodex.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 8: Codex runner

**Files:**
- Create: `zumi-bot-server/backend/src/core/codex/codexRunner.ts`
- Create: `zumi-bot-server/backend/src/core/codex/codexLocator.ts`
- Modify: `zumi-bot-server/backend/src/core/chat/claudeRunner.ts`: add the optional `missingSession?: true` to `RunOutcome`. Claude never sets it.
- Test: `zumi-bot-server/backend/tests/core/codexRunner.test.ts`, `zumi-bot-server/backend/tests/core/codexLocator.test.ts`

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces: `export interface CodexRunOptions { bin: string; cwd: string; env?: NodeJS.ProcessEnv; threadId: string | null; thread: CodexThreadInput; prompt: UserContent; killGraceMs?: number; killForceMs?: number; onEvent(e: RunEvent): void }`.
- Produces: `export function runCodex(o: CodexRunOptions): RunHandle`, using `RunHandle` and `RunOutcome` from `claudeRunner.ts`.
  - **Spawn.** Spawn `bin` with `['app-server', '--listen', 'stdio://', '--disable', 'multi_agent']` in `cwd` and `o.env`, then run `initialize` and the `initialized` notification.
  - **Thread.** Call `thread/start(threadParams(thread))`, or `thread/resume({threadId, ...threadParams(thread)})`, then `mapper.started(thread.id, response.model, userAgent)`.
  - **Turn.** Send `turn/start({threadId, input: codexInput(prompt)})`.
  - **`send(msg)`.** Takes a `control_response`, finds the open request by `response.request_id` and answers it with `codexAnswer`. It returns false when no such request is open.
  - **`stop()`.** Sends `turn/interrupt`, then the same SIGINT/SIGTERM/SIGKILL ladder as `runClaude`, sets `outcome.stopped`, and spawn-checks `cwd` the same way.
  - **End.** At `result`, close stdin. The outcome's `result` is the mapped result, and `stderr` is the mapper's `lastError`, else the process stderr (capped at 64 KiB like Claude's).
  - **Missing thread.** A `thread/resume` error whose message contains `not found`, or the wording the Phase 0 results recorded, sets `outcome.missingSession = true` and ends the run without a turn.
  - **Signed out.** An `unauthorized` error sets `stderr` to `CODEX_REFUSALS.signedOut`.
- Produces: `export function locateCodex(d: LocateDeps): Promise<string | null>`, mirroring `locateClaude`. The candidates are the override, PATH entries, `~/.local/bin/codex`, then `bash -lc 'command -v codex'`. `defaultCodexLocateDeps(override)` reads `ZUMIBOT_CODEX_BIN`.

- [ ] **Step 1: Write tests against `fake-codex.mjs`** (spawned through `process.execPath`, with a tmp `FAKE_CODEX_HOME`):
  - **A plain turn** emits `init`, `textDelta`, `assistantText` and `result` with `isError: false`. The outcome's `exitCode` is 0 and `result` is set.
  - **Resume** sends `thread/resume` with the given id, checked through `FAKE_CODEX_LOG`.
  - **A missing thread** ends with `outcome.missingSession === true` and no `turn/start` in the log.
  - **Approval round trip.** A script request `item/commandExecution/requestApproval` emits `permissionRequest`. `handle.send(allowResponse(id, {}))` writes `{decision: 'accept'}` to `FAKE_CODEX_ANSWERS`.
  - **Stop.** `stop()` during a `sleep` step gives `outcome.stopped === true`, and the log holds `turn/interrupt`.
  - **Late answer after interrupt.** After `turn/interrupt` and a `serverRequest/resolved`, `handle.send(allowResponse(id, {}))` returns false and throws nothing.
  - **Unauthorized maps to the sign-in sentence.** `FAKE_CODEX_UNAUTHORIZED=1` gives `outcome.stderr === CODEX_REFUSALS.signedOut` and `result.isError === true`.
  - **A missing folder** gives `outcome.spawnError === 'Folder not found: <cwd>'`.
  - **Locator.** `codexLocator.test.ts` mirrors `claudeLocator.test.ts`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/codexRunner.test.ts zumi-bot-server/backend/tests/core/codexLocator.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 9: ChatService engine branch

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts`:
  - `ChatServiceDeps`;
  - `TurnSpec`;
  - `runTurn` (around line 940);
  - `compactTurn` (around line 883);
  - `agentTurn`, around the spawn site at lines 1640–1790 and the turn start at lines 1820–1900.
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts`. Add a `describe('codex engine')` block that uses its `makeService` helper.

**Interfaces:**
- Consumes: `Engine`, `CODEX_REFUSALS` (Task 1); `McpServerSpec` (Task 2); `CodexRunOptions` (Task 8).
- Produces: these `ChatServiceDeps` additions:
  - `engineOf?(agent: string): Promise<Engine>` (absent: always `claude`);
  - `codex?: { locate(): Promise<string | null>; run(o: CodexRunOptions): RunHandle; definitionOf(agent: string): Promise<{ body: string; model: string | null } | null> }`.
- Produces: `TurnSpec.engine?: Engine`.
- Produces: `export const COMPACT_UNAVAILABLE = CODEX_REFUSALS.compact`, thrown by `compactTurn` for a Codex agent.

Behaviour:

- **`runTurn`.**
  - Resolve `engine = await engineOf(meta.agentName)`.
  - A session is stale when `meta.sessionId !== null && (meta.sessionEngine ?? 'claude') !== engine`.
  - When stale, the spec gets `sessionId: null` and `reseed: true`. The existing reseed path adds the `expired` notice.
  - `saveSession` patches `sessionEngine: engine === 'codex' ? 'codex' : undefined` with every session it saves.
  - `spec.engine = engine`.
  - **No command models for Codex.** `turnModelOf` is skipped, `spec.model` is `undefined` and nothing is saved to `ChatMeta.model`. A `meta.model` left by an earlier Claude command is ignored.
- **`agentTurn` for `spec.engine === 'codex'`:**
  - **Skipped:** `memory.begin` and `memory.end`, `desktopTurns`, `vaultEnv` env (the key values still go into `scrub`), pause settings, the vault guard, `costBaseline`, `compactWindow`, and `onContext` (no keep warm).
  - **No side base.** No side base is published (`sideBases.set` skipped).
  - **Binary.** It comes from `codex.locate()`. When missing, `addError(CODEX_REFUSALS.notFound)`.
  - **Instructions and model.** Read `def = await codex.definitionOf(agent)` per attempt, so an Agent Studio edit applies from the next attempt. `baseInstructions` is `[def?.body ?? '', system, browser?.prompt].filter(Boolean).join('\n\n')`. The thread's `model` is `def?.model ?? undefined`.
  - **MCP servers.** `mcpServers` is `[browser?.mcp, todo?.mcp, vault?.mcp, ask?.mcp].filter(Boolean)` in that order. Automations never apply, since Zumi Bot is a Claude agent. A `noBrowserTurn()` without `mcp` gives none. Use `[]` when the Phase 0 results say check 5 FAILED.
  - **Env.** The same assembled `env`, minus `pauseEnv`, `tmpEnv`, `compactEnv` and `keyEnv`.
  - **Run.** Call `this.d.codex.run({bin, cwd, env, threadId: resumeId, thread: {cwd, model, baseInstructions, permissionMode: this.d.permissionMode, mcpServers}, prompt, onEvent})`.
  - **Missing session.** `outcome.missingSession` reseeds, as `isMissingSession` does for Claude.
  - **Rewinds.** `spec.resumeAt` is never set for Codex, since no `entry` events means no stamps. Assert it, and reseed if it ever is.

- [ ] **Step 1: Write tests** in `chatService.test.ts`. The fake `codex.run` records its options and plays scripted `RunEvent`s, like the existing `run` fake.
  - **A Codex send** calls `codex.run` and not `run`:
    - `thread.baseInstructions` starts with the body `definitionOf` returned and contains `TODO_SYSTEM`;
    - `thread.model` is the definition's model;
    - after a `/cmd` whose command names `model: opus`, `thread.model` is still the definition's model and `ChatMeta.model` stays unset;
    - `thread.mcpServers.map(s => s.name)` equals `['zumibot_browser', 'zumibot_todos', 'zumibot_vault', 'zumibot_agents']` when every bridge dep is given;
    - no `env` key starts with `ZUMIBOT_PAUSE` or `CLAUDE_CODE_AUTO_COMPACT`.
  - **The meta after the turn** has `sessionId: 's1'` and `sessionEngine: 'codex'`.
  - **Engine switch reseeds.** A chat with `sessionId: 'claude-s'` and no `sessionEngine`, whose agent is now Codex, calls `codex.run` with `threadId: null` and the seed prompt, and an `expired` notice is added. The reverse case (`sessionEngine: 'codex'`, agent now Claude) gives `buildArgs` no `--resume`.
  - **Codex not found:** `codex.locate()` resolving `null` adds an error item with `CODEX_REFUSALS.notFound` and calls nothing.
  - **Missing session.** An outcome with `missingSession: true` on a resumed send triggers one reseed run.
  - **Approvals unchanged.** A `permissionRequest` from the Codex fake gives a card, and answering it sends `allowResponse` through the fake handle's `send`.
  - **No keep warm.** `onContext` is not called for a Codex `context` event.
  - **Compact refused.** `compact(chatId)` on a Codex chat rejects with `COMPACT_UNAVAILABLE`.
  - **Asks reach Codex.** `runAsked` with a Codex B goes through `codex.run`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts`. Expected: the new tests FAIL and the old ones PASS.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command, then `npx vitest run zumi-bot-server/backend/tests/core/claudeArgsPinned.test.ts`. Expected: all PASS.
- [ ] **Step 5: Checkpoint.**

### Task 10: Server gates, wiring and the `codexInfo` RPC

**Files:**
- Modify: `zumi-bot-server/backend/src/app.ts`:
  - build `engineOf` from `agents.list()`;
  - `codex.locate` (cached like `claude.locate`, after `runEnv.ready()`), `codex.run` (`runCodex` with `runEnv.env()` merged in) and `codex.definitionOf` (`agents.definitionOf`);
  - pass these to `ChatService`;
  - pass a `CodexInfo` provider to the handlers.
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts`:
  - `btw:ask` and `btw:follow` refuse `CODEX_REFUSALS.btw`;
  - `chats:compact` refuses `CODEX_REFUSALS.compact`;
  - `chats:pause` refuses `CODEX_REFUSALS.pause` (for the chat's agent when single; rooms cannot hold Codex agents);
  - `chats:setMembers` refuses `CODEX_REFUSALS.room(name)` for any Codex member;
  - new `agents:codexInfo` handler.
- Modify: `zumi-bot-server/backend/src/core/groupMembers.ts`: `validateNewGroupMembers` refuses `CODEX_REFUSALS.room(name)` for any agent with `provider === 'codex'`.
- Create: `zumi-bot-server/backend/src/core/codex/codexInfo.ts`. `createCodexInfo({locate, list})` caches the first successful model list for the server's life, and retries a failed list on the next call.
- Modify: `zumi-bot-server/frontend/src/net/api.ts`: map `codexInfo` to `agents:codexInfo`.
- Test: `zumi-bot-server/backend/tests/rpc/handlers.test.ts`, `zumi-bot-server/backend/tests/core/groupMembers.test.ts`, `zumi-bot-server/backend/tests/core/codexInfo.test.ts`

**Interfaces:**
- Consumes: Task 1 (`CodexInfo`, `CODEX_REFUSALS`), Task 8 (`runCodex`, `locateCodex`), Task 9 (deps).
- Produces: `createCodexInfo(d: { locate(): Promise<string | null>; list(bin: string): Promise<string[]> }): () => Promise<CodexInfo>`.
  - `list` spawns `codex app-server`, runs `initialize` and `model/list {}`, then closes.
  - It returns the `model` of every entry with `hidden: false`, and gives up after 15 s.

- [ ] **Step 1: Write tests:**
  - `btw:ask` on a chat whose agent has `provider: 'codex'` rejects with `CODEX_REFUSALS.btw`; the same for `chats:compact` and `chats:pause`;
  - `chats:createGroup` with a Codex member rejects with `CODEX_REFUSALS.room('x')`, and `chats:setMembers` likewise;
  - `codexInfo` with `locate → null` gives `{found: false, models: []}`;
  - with a list that throws once, the first call gives `{found: true, models: []}` and the second retries;
  - a successful list is not fetched again.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/rpc/handlers.test.ts zumi-bot-server/backend/tests/core/groupMembers.test.ts zumi-bot-server/backend/tests/core/codexInfo.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same tests, then `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 11: UI: Agent Studio engine, chat gates and tool labels

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/AgentForm.tsx`: the **Engine** select and hidden controls.
- Modify: `zumi-bot-server/frontend/src/components/AgentEditor.tsx`: fetch `codexInfo()` once on open.
- Modify: these chat views, which read `engineCaps(chatEngine(chat, agents))`:
  - `zumi-bot-server/frontend/src/components/ChatView.tsx`
  - `SidePanelMenu.tsx`
  - `ContextMeter.tsx`
  - `ColdNotice.tsx`
  - `Composer.tsx`
- Modify: these pure modules, each covered by its own test:
  - `zumi-bot-server/frontend/src/state/pause.ts`
  - `state/commandInput.ts`
  - `state/contextMeter.ts`
  - `state/groupChat.ts`
  - `state/toolLabel.ts`
  - `zumi-bot-server/shared/src/toolSummary.ts`
- Test: in `zumi-bot-server/frontend/tests/`, the files `pause.test.ts`, `commandInput.test.ts`, `contextMeter.test.ts`, `groupChat.test.ts` and `toolLabel.test.ts`. Plus `zumi-bot-server/shared/tests/toolSummary.test.ts`.

**Interfaces:**
- Consumes: Task 1 (`engineCaps`, `chatEngine`, `CodexInfo`), Task 10 (`api.codexInfo`).
- **Changed signatures:**
  - `pauseControl(chat, caps?: Pick<EngineCaps, 'pause'>)` returns null when `caps?.pause === false`;
  - `filterCommands(query, agents, opts: { afterTodo?: boolean; btw?: boolean })` leaves out the `btw` built-in when `opts.btw === false`;
  - `coldContexts(chat, agents, now)` returns `[]` when `chat.sessionEngine === 'codex'`;
  - `memberOptions(...)` gives a Codex agent `{disabled: true, note: "can't join"}`, like Zumi Bot.
- **Tool labels:**
  - `toolLabel('ApplyPatch', {changes: [{path: '/a/b.ts', kind: 'update'}]})` is `{title: 'Apply patch', detail: 'b.ts'}`; with several files the detail is `'b.ts +2 more'`;
  - `toolLabel('SandboxPermissions', {...})` is `{title: 'Sandbox permissions', detail: null}`;
  - `toolSummary('ApplyPatch', …)` is `'ApplyPatch b.ts'`.
- **AgentForm behaviour:**
  - The Engine control has options Claude and Codex. Picking one calls `onFields({provider: 'codex' | null})`.
  - Codex is disabled with the title `CODEX_REFUSALS.notFound` when `codexInfo.found === false`.
  - With Codex picked:
    - the Model choices become `codexInfo.models` plus Custom, so it is still free text;
    - the Tools card, Memory section (`AgentMemory.tsx`), Compact at row, Computer use switch (`AgentDesktop.tsx`) and the commands card's Model select are hidden;
    - in their place one line reads "Tools, memory, Compact at, computer use and command models are not used by Codex agents."
- **Agent rows:** a `Codex` tag (`agent-engine-tag`) beside a Codex agent's name, in the sidebar and in Agent Studio's list.
- **Vault editor** (`VaultSettings.tsx`, "Agents that can use this"): on an API key item, a Codex agent's checkbox carries the note "API keys need a later version for Codex agents". The grant can still be saved, since logins and cards work through browser fills. Task 9 never injects the key's env for a Codex run.

- [ ] **Step 1: Write the pure tests listed above,** with the exact values given.
- [ ] **Step 2: Run** `npx vitest run --project frontend --project shared`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** the pure changes, then the components (no DOM tests in this repo).
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Checkpoint.**

### Task 12: `e2e:codex`, the docs and a real-CLI smoke

**Files:**
- Modify: `zumi-bot-server/e2e/harness.mjs`. A `fakeCodex` option (path or `true`) writes a `codex` shim beside the fake `claude` shim, `exec`-ing `fake-codex.mjs`, and sets `FAKE_CODEX_SCRIPT`, `FAKE_CODEX_LOG`, `FAKE_CODEX_ANSWERS` and `FAKE_CODEX_HOME` under the temp root.
- Create: `zumi-bot-server/e2e/codex.e2e.mjs`
- Modify: `package.json` (root): `"e2e:codex": "npm run build && node zumi-bot-server/e2e/codex.e2e.mjs"`.
- Modify: `CLAUDE.md`. In Commands, add one line for `e2e:codex` and one for `probe:codex`. In Architecture, add a **Codex agents** paragraph:
  - the `provider` key and `engineCaps`;
  - the runner over `codex app-server`;
  - the event and answer mapping;
  - the session engine rule;
  - that auto mode trusts Codex's own `auto_review` reviewer, as it trusts Claude's classifier;
  - what is off in Phase 1;
  - a link to the spec.

  Add `sessionEngine` to Data.
- Modify: `zumi-bot-server/deploy/SETUP-VPS.md`. Add a "Codex (optional)" section: install, `codex login --device-auth` as the service user, `codex login status`. Add the note that routines and workflows using a Codex agent need it on the VPS.

The e2e cases use the fake only, so they cost no quota:
1. An agent created in Agent Studio with Engine Codex. Its file has `provider: codex`, and the row shows the `Codex` tag.
2. A send streams the fake's reply.
3. A Bash card:
   - allowed once (`FAKE_CODEX_ANSWERS` holds `accept`);
   - then "Allow for this chat" auto-answers the same command next turn with no card;
   - a declined card gives `decline`.
4. Stop during a sleep step gives the `stopped` notice.
5. The fake's `mcpCall` to `zumibot_todos` `add` puts an item in the To-dos panel.
6. Edit of the first message reseeds. The log shows `thread/start`, not `thread/resume`, with the seeded history in the input.
7. A Claude agent (fake claude, `#MCP_CALL` to `zumibot_agents`/`ask`) asks the Codex agent. The A→B chat shows the Codex reply.
8. A usage-limit script (`error usageLimitExceeded` after a snapshot) shows the limit notice with Don't continue.
9. In a Codex chat:
   - no Pause button;
   - no `/btw` in the `/` menu;
   - no Side questions, Files or Desktop entries;
   - a typed `/btw x` shows `CODEX_REFUSALS.btw`.
10. Switching the agent to Claude, then sending, adds the `expired` notice, and the fake claude gets no `--resume`.

- [ ] **Step 1: Write `codex.e2e.mjs`** with the cases above, following `ask.e2e.mjs`'s structure.
- [ ] **Step 2: Run** `npm run e2e:codex`. Expected: FAIL on the first missing piece, then fix forward until all pass.
- [ ] **Step 3: Run the full regression:** `npm test && npm run typecheck && npm run e2e:ask && npm run e2e:todos && npm run e2e:routines && npm run e2e:workflows`. Expected: all PASS, Claude behaviour unchanged.
- [ ] **Step 4: Real-CLI smoke (manual, a few cents of quota).**
  - Run `npm run dev`.
  - Create a Codex agent and send "run `ls` and tell me how many files".
  - Approve the card, check the reply, then press Stop on a second, long request.
  - Record the result under `## Phase 0 results` as "Phase 1 smoke".
- [ ] **Step 5: Checkpoint.** Tell the user Phase 1 is ready to review; they decide on a commit, the version bump and a deploy.

## Phase 0 results

Probe run on `codex-cli 0.164.0` (`node zumi-bot-server/e2e/codexProbe.mjs --record zumi-bot-server/backend/tests/fixtures/codex`), exit 0, all six checks PASS. Fixtures: `codex-check1..6.jsonl` and `codex-check5-manual.jsonl` (an MCP call in manual mode), one `{dir, msg, t}` line per message and a last `{meta: {files, exit}}` line. They carry no auth data (home, host name and install id are scrubbed).

| Check | Verdict | Facts |
|---|---|---|
| 1 Turn basics | PASS | `initialize` answer has `userAgent`, `codexHome`, `platformFamily`, `platformOs`. `thread/start` answer is `{thread: {id, ...}}`. A turn with one `echo hi` call made 2 `thread/tokenUsage/updated` (one per model request); the sum of `last.totalTokens` equals the final `total.totalTokens`; `modelContextWindow` 258400. `cachedInputTokens` is inside `inputTokens` (last: input 14416, cached 12160). Image input (`{type:'image', url:'data:image/png;base64,...'}`) accepted. Commands arrive as `/bin/bash -lc '<cmd>'`. |
| 2 Instructions | PASS through `baseInstructions` only | `developerInstructions` given on `thread/resume` is IGNORED (a thread started with none, resumed with MANGO, never says MANGO; a thread started with KIWI keeps saying KIWI even with "KIWI is cancelled"). `baseInstructions` given on `thread/start` and again on `thread/resume` replaces the old text, and tools still work with it set. The probe's verdict is the first mechanism that works, and prints which. |
| 3 Manual mode | PASS | `untrusted` + `user`: `touch ../outside-marker` sent `item/commandExecution/requestApproval` (params: `kind, threadId, turnId, itemId, startedAtMs, environmentId, command, cwd, commandActions, proposedExecpolicyAmendment, availableDecisions`; no `reason`); the file was absent before and after `decline` (item `status: "declined"`, `exitCode: null`) and present after `accept`. |
| 4 Auto mode | PASS | `on-request` + `auto_review`: `echo ok > inside.txt` and `curl -sI https://example.com` (config `{'sandbox_workspace_write.network_access': true}`) ran with no client request. A write outside the writable roots (`/var/tmp`, since `/tmp` is writable in `workspace-write`) sent `item/autoApprovalReview/started` (`reviewId, targetItemId, review {status: "inProgress", ...}, action {type: "command", command, cwd}`), `guardianWarning` (`message`), then `item/autoApprovalReview/completed` (`decisionSource: "agent"`, `review {status: "approved", riskLevel, userAuthorization, rationale}`), and ran. A reviewer decline was not produced. |
| 5 MCP | PASS | `config: {'mcp_servers.probe': {command, args, env_vars: ['PROBE_TOKEN'], tool_timeout_sec: 600}}` (dotted key, object value) works. `mcpToolCall` item: `server: "probe"`, `tool: "probe_echo"`, `namespace: null`. **The model names the tool `mcp__probe__probe_echo`**, so the prompt texts need no per-engine rendering. `env_vars` forwarded the token. The token is not in the session log under `$CODEX_HOME/sessions`. **Elicitation: none in auto mode; in manual mode (`untrusted` + `user`) `mcpServer/elicitation/request` comes** with `mode: "form"`, `serverName: "probe"`, `message: 'Allow the probe MCP server to run tool "probe_echo"?'`, `_meta {codex_approval_kind: "mcp_tool_call", persist: ["session","always"], tool_params, tool_params_display, tool_description}`, an empty `requestedSchema`; `accept` with `content: null, _meta: null` ran the tool. |
| 6 Stop | PASS | `turn/interrupt {threadId, turnId}` during `sleep 30` ended the turn with `status: "interrupted"` well inside 10 s. A usage-limit `error` was not produced (Phase 1 maps it from the bindings). |

Findings for the tasks:

- **Instructions on resume (needs a decision before Task 7).** `developerInstructions` cannot change on resume. Task 7 must send the whole text (agent body plus the appended prompt) as `baseInstructions` on `thread/start`, `thread/resume` and `thread/fork`, or else leave `developerInstructions` for the first turn and reseed when the text changes. Verify `thread/fork` the same way in Phase 2.
- **Tool-name finding.** The name is `mcp__<server>__<tool>`: no new task, `TODO_SYSTEM`, `VAULT_SYSTEM`, `askSystem` and the browser prompt stay as they are.
- **Elicitation finding.** MCP calls elicit only in manual mode, with the shape above; `permissionRequest {toolName: 'mcp__<server>__<tool>'}` must be built from `serverName` and `_meta.tool_params`'s tool (the tool name itself is only in `message`; the `mcpToolCall` item started just before carries `server` and `tool`). In auto mode the own-bridge auto answers are unused.
- **Outside-read finding.** In manual mode every shell call asks (they run through `bash -lc`, nothing counts as known safe), an outside read and the same read inside the workspace alike, so no `writable_roots` is needed for attachments in manual mode. In auto mode an outside read ran with no request. Task 7 adds nothing for the attachments folder.
- `userAgent` reads `<clientInfo.name>/<codex version> (<os>) ...`, so the app should take the version from the part after the first `/`.
- Stdout carried only JSON lines in these runs; the non-JSON line ignore stays in Task 4 as planned.

### Phase 1 smoke

Run on 2026-11-09 with `codex-cli 0.164.0` as `npm run smoke:codex` (`zumi-bot-server/e2e/codexSmoke.mjs`: the built server and the web UI in headless Chrome through the e2e harness, `fake: false` so the real HOME and its `~/.codex` login are used, manual permission mode, a Codex agent file with no `model:` (the Codex config's default), a temp git folder holding three files). Not part of `npm run e2e`.

**Card gate.** Cards go through `zumi-bot-server/e2e/smokeGate.mjs`, tested in `backend/tests/smokeGate.test.ts`. The command is read from the approval item the server stored for the card. It is unwrapped from Codex's `/bin/bash -lc '<cmd>'`, or `/bin/bash -lc <word>` for a one-word command. A card is allowed once only when the unwrapped command fully matches its step's allowlist:
- step `ls`: `ls` with plain flags and an optional `.`, then optionally `| wc -l` or `; find . -maxdepth 1 -type f | wc -l`;
- step `sleep`: `sleep 60` alone;
- the to-do step allows nothing.

A belt also refuses `~`, `$`, backticks, redirects, `&`, `..` and credential places (`.codex`, `.ssh`, `.aws`, `.claude`, `.config`, auth). Every other card, and one whose request can't be read, is denied and printed, and makes its step INCONCLUSIVE.

**Final runs.** The last two runs with this gate (one as `node`, one as `npm run smoke:codex`, both exit 0) passed every step:

| Step | Verdict | Facts |
|---|---|---|
| 1 `ls` with an approved card | PASS | One Bash card, `/bin/bash -lc ls`, allowed once on the page. The reply streamed (`[data-streaming]` seen) and read "There are 3 files in this folder: alpha.txt, beta.txt, and notes.md." The chat keeps `sessionEngine: 'codex'`. |
| 2 To-do bridge | PASS | "use your to-do tool to add the item 'smoke test'" put the item on the chat's list, with no card (the server answered the manual-mode elicitation itself), no tool row and no error. This proves on real Codex that `mcp_servers.<name>.env_vars` hands the bridge its capability and socket and that the bridge works. `mcp_servers.<name>.env` (fixed values) is empty for the to-do bridge outside the Electron shell, so it was not exercised. |
| 3 Stop during `sleep 60` | PASS | The `/bin/bash -lc 'sleep 60'` card was allowed and Stop was pressed about 4 s later. The stopped notice landed about 4.3 s after the approval. 2 s later no `codex app-server` and no `sleep` was left with a working folder in the temp folder (4 sleep-related processes ran before Stop). |

**Earlier runs.**
- Runs 1 and 2 used the first, loose gate; both passed every step. The step 1 command was `/bin/bash -lc 'ls; find . -maxdepth 1 -type f | wc -l'`. In run 1 the model first tried to `cat` a skill file of a curated plugin under `~/.codex/plugins/cache`, and that gate allowed it.
- Run 3, with the strict gate, was INCONCLUSIVE on step 1. The gate denied `/bin/bash -lc 'cat ~/.codex/plugins/cache/openai-curated-remote/superpowers/7.0.1/skills/using-superpowers/SKILL.md'`: the user's Codex plugins load, as the spec says user settings do. It also denied `/bin/bash -lc ls`, an unquoted one-word form the gate did not yet unwrap.

Since then the gate unwraps that one-word form, and the smoke agent's body asks it to run only the named commands and read no skill, plugin or config files.

Not verified at runtime: whether `features.multi_agent: false` (and `--disable multi_agent`) keeps Codex from spawning subagents; nothing in these runs asked for one.
