# Servers, plugins, skills and hooks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show what MCP servers, plugins, skills and hooks a run really loads (globally and per agent), manage them globally, and turn them off or add them per agent, with an agent's own server secrets taken from the Vault.

**Architecture:** A model-free CLI probe (`claude -p` control requests `initialize`, `mcp_status`, `get_skills_dialog`, `get_hooks_listing`) feeds a sanitized `Loadout`. Global writes go through the CLI's own subcommands (`claude mcp`, `claude plugin`) or atomic edits of settings files, `.mcp.json` and skill folders. Per-agent choices live in the agent file and become one builder's `--disallowedTools`, `--settings` and `--mcp-config` args plus env, added at one place in `agentTurn` and in the side base, so every run of an agent (main, room, routine, workflow, A→B, Compact, side, keep-warm) gets the same set.

**Tech Stack:** TypeScript, Node 22, React 19, vitest, `yaml`, playwright-core e2e with fake CLIs.

**Spec:** `docs/superpowers/specs/2026-11-12-claude-code-extensions-design.md` (read it first; this plan argues from it).

## Global Constraints

- Never commit, push or open a PR unless the user says so (the user's global rule). Each task ends with a checkpoint instead of a commit.
- Worktree: before typecheck or build, the `node_modules` symlinks to the main checkout must exist (see memory "Worktree build links"); create them if missing.
- No new dependencies. Pinned versions unchanged.
- Never `--dangerously-skip-permissions`, `bypassPermissions` or `disableAllHooks`.
- The per-agent settings object holds only the keys `deniedMcpServers`, `enabledPlugins`, `skillOverrides`, `hooks`. Nothing from the agent file is copied into it except through those four.
- `deniedMcpServers` entries are `{"serverName": "<name exactly as the CLI lists it>"}`; the belt deny is `toolPrefix(name)` = `'mcp__' + name.replace(/[^A-Za-z0-9_-]/g, '_')`.
- `skillOverrides` value written is exactly `"off"`; turning a skill back on deletes its key.
- Vault references: `${vault:<ENV_NAME>}` with `<ENV_NAME>` matching `[A-Za-z_][A-Za-z0-9_]*`; rewritten to `${ZUMIBOT_MCP_VAULT_<n>}`, `n` from 0 in order of first appearance across the agent's servers (same reference → same n).
- Own server names starting with `zumibot_` are refused.
- Probe: `--no-session-persistence`, 30 s deadline, at most 2 at once server-wide (others queue), `mcp_status` re-asked every 500 ms until no server is `pending` or 15 s passed.
- `mcp_status`'s `config` is never passed on. Env and header values never reach the page, a log, an error or a URL.
- Settings files are written as `JSON.stringify(obj, null, 2) + '\n'`, key order kept, atomically (`writeFileAtomic`), mode kept; a file that does not parse is never written.
- Stale check: a write carries the `stamp` (sha256 hex of the file's text, or `'absent'`) it read; a mismatch fails with `EXT_TEXT.stale`.
- Fixed user-facing sentences live in `EXT_TEXT` (`shared/src/extensions.ts`); never CLI output in an error.
- Comments short and say why. Frontend logic in `src/state/` (pure, tested); components thin.
- Codex agents and Zumi Bot: view only.

## Review Focus

1. Server names with spaces, dots and colons (`claude.ai Google Drive`, `plugin:chrome-devtools-mcp:chrome-devtools`) must survive the agent file, `deniedMcpServers`, the belt deny and the UI toggle unchanged. Test in Task 3 (`round-trips odd server names`).
2. A missing `~/.claude/settings.json` or project `.claude/settings.local.json` must be created holding only the edited key; a file with invalid JSON must be refused, untouched. Test in Task 6 (`creates a missing settings file`, `refuses invalid JSON`).
3. An agent file with an `mcpServers` or `hooks` shape ZumiBot does not understand (a map form with unknown keys, a `type: prompt` hook) must keep its text byte for byte through a Save that changed another field, and the run must add none of it. Tests in Task 2 (`keeps an unknown hooks shape verbatim`) and Task 3 (`skips a non-editable hooks block`).
4. A probe whose CLI hangs (a server stuck `pending`, or no answer at all) must end at the deadline with its process group gone and per-section errors, not hang the page. Test in Task 5 (`ends a hung CLI at the deadline`).
5. A Vault key that loses its grant or is renamed must drop only that one server, identically in the main run and the side run. Test in Task 4 (`main and side runs drop the same unfillable server`).

---

### Task 1: Shared types, names and sentences

**Files:**
- Create: `zumi-bot-server/shared/src/extensions.ts`
- Test: `zumi-bot-server/shared/tests/extensions.test.ts`

**Interfaces:**
- Produces (exact):
  - `type McpTransport = 'stdio' | 'http' | 'sse'`
  - `interface McpServerDef { type?: McpTransport; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }`
  - `interface HookCommand { type: 'command'; command: string; timeout?: number }`
  - `interface HookGroup { matcher?: string; hooks: Array<HookCommand | Record<string, unknown>> }`
  - `type HooksConfig = Record<string, HookGroup[]>`
  - `interface AgentOwnServer { name: string; def: McpServerDef | null }` (null = a bare reference)
  - `interface AgentExtensions { serversOff: string[]; skillsOff: string[]; plugins: Record<string, boolean>; servers: AgentOwnServer[]; serversEditable: boolean; hooks: HooksConfig; hooksEditable: boolean }`
  - `const NO_EXTENSIONS: AgentExtensions` (all empty, both editable)
  - `toolPrefix(serverName: string): string`
  - `parseMcpDef(v: unknown): McpServerDef | null` (null for any key outside the six, a non-string value, or neither `command` nor `url`)
  - `parseHooks(v: unknown): { config: HooksConfig; editable: boolean } | null` (null when not an object of arrays; `editable` false when any hook is not `{type:'command', command: string, timeout?: number}` or a group has keys besides `matcher`/`hooks`)
  - `vaultRefs(def: McpServerDef): string[]` (env names referenced in `env` and `headers` values, first-appearance order, unique)
  - `const VAULT_REF_PATTERN = /\$\{vault:([A-Za-z_][A-Za-z0-9_]*)\}/g`
  - Loadout types: `ServerStatus = 'connected' | 'needs-auth' | 'failed' | 'pending' | 'disabled' | 'unknown'`; `ServerSource = 'user' | 'local' | 'project' | 'plugin' | 'claudeai' | 'agent' | 'zumibot' | 'other'`; `LoadoutServer { name; status; source; transport: string | null; plugin: string | null; tools: string[]; scope: McpScope | null; note: string | null }`; `McpScope = 'user' | 'local' | 'project'`; `LoadoutPlugin { id; enabled: boolean; skills: number; servers: number; hooks: number }`; `SkillSource = 'user' | 'project' | 'plugin' | 'claudeai' | 'bundled' | 'other'`; `LoadoutSkill { name; description; source; plugin: string | null; tokens: number | null; on: boolean; editable: boolean }`; `HookSource = 'user' | 'project' | 'local' | 'plugin' | 'agent' | 'zumibot' | 'other'`; `LoadoutHook { event; matcher; type; command; timeout: number | null; source; plugin: string | null; at: { group: number; hook: number } | null; stamp: string | null }`; `LoadoutSection = 'servers' | 'plugins' | 'skills' | 'hooks'`; `Loadout { engine: 'claude' | 'codex'; version: string | null; folder: string; agent: string | null; servers; plugins; skills; hooks; errors: Partial<Record<LoadoutSection, string>>; at: number }`
  - `McpServerView { name; scope: McpScope; def: McpServerDef; hidden: { env: string[]; headers: string[] }; stamp: string }` (`def.env`/`def.headers` values are `''` for hidden names)
  - `McpServerInput = McpServerDef with env/headers values `string | null`` (null = keep stored) — name it `McpServerInput`
  - `SkillView { scope: 'user' | 'project'; name; description; body; files: string[]; stamp: string }`
  - `HookFile = 'user' | 'project' | 'local'`
  - `EXT_TEXT` with at least: `stale`, `badJson(file: string)`, `notFound`, `unsupported(section: LoadoutSection)`, `cliMissing`, `timeout`, `badName`, `reservedName`, `vaultMissing(env: string)`, `vaultLocked`, `addFailedRestored`, `notEditable`, `machineOnly` ("Changes here apply to this machine only; sync does not copy them.")

- [ ] **Step 1: Write the failing tests** — `toolPrefix('claude.ai Gmail') === 'mcp__claude_ai_Gmail'`, `toolPrefix('plugin:chrome-devtools-mcp:chrome-devtools') === 'mcp__plugin_chrome-devtools-mcp_chrome-devtools'`; `parseMcpDef({command:'node', args:['a'], env:{A:'1'}})` round-trips, `parseMcpDef({command:'x', cwd:'/'})` and `parseMcpDef({args:[]})` are null; `parseHooks({PreToolUse:[{matcher:'Bash', hooks:[{type:'command', command:'echo'}]}]})` editable, with `{type:'prompt', prompt:'x'}` not editable, `parseHooks([])` null; `vaultRefs({headers:{Authorization:'Bearer ${vault:GH}'}, env:{A:'${vault:GH}', B:'${vault:X_1}'}})` equals `['GH', 'X_1']` (env before headers).
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/shared/tests/extensions.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `shared/src/extensions.ts` with the exports above.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Checkpoint** (no commit).

### Task 2: Agent file keys in the frontmatter

**Files:**
- Modify: `zumi-bot-server/shared/src/frontmatter.ts` (`AgentFields`, `fieldsOf`, `serializeAgent`)
- Modify: `zumi-bot-server/backend/src/core/agents/agentStore.ts` (new `extensionsOf`)
- Test: `zumi-bot-server/shared/tests/frontmatter.test.ts` (extend), `zumi-bot-server/backend/tests/core/agentStore.test.ts` (extend)

**Interfaces:**
- Consumes: Task 1 `parseMcpDef`, `parseHooks`, `AgentOwnServer`, `HooksConfig`, `AgentExtensions`.
- Produces:
  - `AgentFields` gains `serversOff: string[] | null`, `skillsOff: string[] | null`, `plugins: Record<string, boolean> | null`, `mcpServers: { entries: AgentOwnServer[]; editable: boolean } | null`, `hooks: { config: HooksConfig; editable: boolean } | null` (null = key absent).
  - `extensionsOf(fields: AgentFields): AgentExtensions` exported from `frontmatter.ts`.
  - `AgentStore.extensionsOf(name: string): Promise<AgentExtensions | null>` (fresh read like `definitionOf`; null for no loadable agent).

- [ ] **Step 1: Write the failing tests** — parse: `serversOff: [claude.ai Gmail]` → `['claude.ai Gmail']`; `plugins: {a@m: false, b@m: "yes"}` → `{ 'a@m': false }`; `mcpServers: [github, {db: {command: node}}]` → entries `[{name:'github', def:null}, {name:'db', def:{command:'node'}}]`, editable; a map form `mcpServers: {db: {command: node, cwd: /x}}` → editable false. Serialize: toggling `serversOff` on an agent whose `hooks:` block holds a `type: prompt` hook leaves the `hooks:` text byte for byte (`keeps an unknown hooks shape verbatim`); setting `mcpServers` writes a YAML list of `{name: def}` with keys in order `type, command, args, env, url, headers`; setting any of the five to null deletes the key; an unchanged agent splices verbatim (existing test style). AgentStore: `extensionsOf('x')` returns the parsed lists; unknown agent → null.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/shared/tests/frontmatter.test.ts zumi-bot-server/backend/tests/core/agentStore.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** parsing in `fieldsOf` (lists: arrays of non-empty strings, else null), the equality checks in `serializeAgent`'s fast path (compare by `JSON.stringify`), the five rewrites (only when changed; an `editable: false` value is never rewritten), `extensionsOf`, and `AgentStore.extensionsOf`.
- [ ] **Step 4: Run** the same command, then `npm run typecheck` — expect PASS (fix every `AgentFields` literal the typecheck flags: tests and `NEW_AGENT_TEMPLATE` users).
- [ ] **Step 5: Checkpoint.**

### Task 3: Per-agent run config builder

**Files:**
- Create: `zumi-bot-server/backend/src/core/extensions/agentRunConfig.ts`
- Test: `zumi-bot-server/backend/tests/core/extensions/agentRunConfig.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `toolPrefix`, `vaultRefs`, `VAULT_REF_PATTERN`; `VaultItem` (`shared/src/vault.ts`).
- Produces:
  - `interface AgentRunConfig { disallowedTools: string[]; extraArgs: string[]; env: Record<string, string>; dropped: Array<{ server: string; env: string | null; reason: 'vault-missing' | 'vault-locked' | 'reserved-name' }> }`
  - `const NO_RUN_CONFIG: AgentRunConfig`
  - `buildAgentRunConfig(ext: AgentExtensions, keys: readonly VaultItem[] | 'locked', opts?: { serversOff?: boolean }): AgentRunConfig` (`serversOff` default true; the probe passes false). `keys` are the agent's granted items; `'locked'` when the vault status is `keyMissing`/`keyMismatch`.
  - Output order: `extraArgs` = `['--settings', <json>]` (only when the object is non-empty) then `['--mcp-config', <json>]` (only with at least one inline server kept). The settings JSON keys in order `deniedMcpServers`, `enabledPlugins`, `skillOverrides`, `hooks`, each present only when non-empty; hooks only when `hooksEditable`. The mcp-config is `{"mcpServers": {<name>: <def with refs rewritten>}}`.

- [ ] **Step 1: Write the failing tests** — `round-trips odd server names` (`serversOff: ['claude.ai Google Drive', 'plugin:chrome-devtools-mcp:chrome-devtools']` → settings `deniedMcpServers` with both exact names and `disallowedTools` `['mcp__claude_ai_Google_Drive', 'mcp__plugin_chrome-devtools-mcp_chrome-devtools']`); `serversOff: false` option omits both; plugins and skillsOff map to `enabledPlugins` and `{"apple-design": "off"}`; `skips a non-editable hooks block`; a server with `headers: {Authorization: 'Bearer ${vault:GH}'}` and a granted apiKey `{env:'GH', value:'tok'}` → mcp-config has `Bearer ${ZUMIBOT_MCP_VAULT_0}` and `env` `{ZUMIBOT_MCP_VAULT_0: 'tok'}`, and `JSON.stringify(extraArgs)` does not contain `tok`; an unknown ref drops only that server with `reason: 'vault-missing'`; `'locked'` drops every server with a ref; a `zumibot_x` server is dropped `reserved-name`; bare references add nothing; when merged through `buildArgs` with a pause hook `--settings` (import `buildArgs` from `core/chat/claudeRunner.ts`), the single resulting `--settings` holds both the pause `PreToolUse` hook and the agent's hook.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/extensions/agentRunConfig.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `buildAgentRunConfig` (pure).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Checkpoint.**

### Task 4: Every run of the agent carries the config

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (`ChatServiceDeps`, `SideBase`, `agentTurn` near the `compactWindow` read and the `sideBase`/`buildArgs`/`envOf` code)
- Modify: `zumi-bot-server/backend/src/core/btw/sideRun.ts` (spawn env)
- Modify: `zumi-bot-server/backend/src/app.ts` (wire `agentRunConfig`; `baseFor`)
- Test: `zumi-bot-server/backend/tests/core/chatService.test.ts`, `zumi-bot-server/backend/tests/core/btw/sideRun.test.ts` (extend; use their existing fake `run` capturing `RunOptions`)

**Interfaces:**
- Consumes: Task 3 `buildAgentRunConfig`, `NO_RUN_CONFIG`; Task 2 `AgentStore.extensionsOf`; `VaultStore.grantedTo`, `VaultStore.status`.
- Produces:
  - `ChatServiceDeps.agentRunConfig?(agent: string): Promise<AgentRunConfig>`
  - `SideBase.env?: Record<string, string>` (the agent's `ZUMIBOT_MCP_VAULT_*` values)
  - In `app.ts`: `const agentRunConfig = async (agent: string, opts?: { serversOff?: boolean }): Promise<AgentRunConfig>` (Zumi Bot → `NO_RUN_CONFIG`; `extensionsOf` null → `NO_RUN_CONFIG`; vault `keyMissing`/`keyMismatch` → `'locked'`), passed to `ChatService` and used by `baseFor` and (Task 7) the probe.

- [ ] **Step 1: Write the failing tests** — chatService: with `agentRunConfig` returning `{disallowedTools:['mcp__x'], extraArgs:['--settings','{"skillOverrides":{"a":"off"}}','--mcp-config','{"mcpServers":{}}'], env:{ZUMIBOT_MCP_VAULT_0:'v'}}`, a send's spawned args end with `--disallowedTools … mcp__x`, contain one `--settings` holding both `skillOverrides` and the pause hook, the `--mcp-config` sits before the browser bridge's, and the spawn env has `ZUMIBOT_MCP_VAULT_0`; a Compact's spawn gets the same three; a Codex agent's run gets none; the side base saved for the chat holds the same `disallowedTools`, `extraArgs` and `env`. sideRun: `main and side runs drop the same unfillable server` (feed both from one `buildAgentRunConfig` result and compare the `--mcp-config` args), and the side spawn env includes `base.env`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/chatService.test.ts zumi-bot-server/backend/tests/core/btw/sideRun.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** — in `agentTurn`, beside `compactAt`: `const own = onCodex || !this.d.agentRunConfig ? NO_RUN_CONFIG : await this.d.agentRunConfig(spec.agentName).catch(err => { log code; return NO_RUN_CONFIG })`; append `own.disallowedTools` to `disallowedTools` and `own.extraArgs` right after `spec.extraArgs` in both the spawn and the side base; add `own.env` to `envOf` (Compact included; the `envOf` truthiness check must count it); `SideBase.env = own.env` when non-empty. In `sideRun.ts` add `...o.base.env` to the spawn env. In `app.ts` build `agentRunConfig`, pass it in `ChatService` deps, and in `baseFor` append its `disallowedTools`/`extraArgs` and set `env`. Log `dropped` once per attempt by server name and reason only.
- [ ] **Step 4: Run** the same tests, then `npm test` — expect PASS.
- [ ] **Step 5: Checkpoint.**

### Task 5: The probe and the fake extensions CLI

**Files:**
- Create: `zumi-bot-server/backend/src/core/extensions/sanitize.ts` (pure)
- Create: `zumi-bot-server/backend/src/core/extensions/probe.ts`
- Create: `zumi-bot-server/backend/tests/fixtures/fake-extensions-claude.mjs`
- Test: `zumi-bot-server/backend/tests/core/extensions/sanitize.test.ts`, `zumi-bot-server/backend/tests/core/extensions/probe.test.ts`

**Interfaces:**
- Consumes: Task 1 Loadout types; `LineSplitter` (`core/chat/streamParser.ts`).
- Produces:
  - `interface ProbeAnswers { version: string | null; mcp: unknown; skills: unknown; hooks: unknown; settings: unknown; errors: Partial<Record<'mcp' | 'skills' | 'hooks' | 'settings', string>> }`
  - `probeClaude(o: { bin: string; folder: string; agent: string | null; args: string[]; env: NodeJS.ProcessEnv; deadlineMs?: number; pendingMs?: number }): Promise<ProbeAnswers>` — `args` are the per-agent extra args (from `buildAgentRunConfig(…, {serversOff:false})`).
  - `probeCodex(o: { bin: string; folder: string; env: NodeJS.ProcessEnv; deadlineMs?: number }): Promise<ProbeAnswers>` (`mcpServerStatus/list`, `skills/list {cwds:[folder]}`, `hooks/list {cwds:[folder]}`; framing from `core/codex/codexRpc.ts`)
  - `toLoadout(a: ProbeAnswers, ctx: { engine: 'claude' | 'codex'; folder: string; agent: string | null; now: number; skillDirs: Map<string, 'user' | 'project'> }): Omit<Loadout, 'plugins'>` — drops `config`, `serverInfo`, OAuth fields; maps `scope`/`source` to `ServerSource` (`dynamic`+`plugin` → `plugin`, `claudeai` → `claudeai`); skill `source` `'claude.ai sync'` → `claudeai`; hook `source` `userSettings|projectSettings|localSettings|pluginHook` → `user|project|local|plugin`, and `flagSettings` → `agent` when `ctx.agent` is set (the probe passes only the agent's own settings), else `other`; any unexpected shape becomes that section's `EXT_TEXT.unsupported(section)` error.
  - Fake: argv without `mcp`/`plugin` and with `-p` answers `control_request`s from `FAKE_EXT_STATE` (a JSON file: `{version, mcpServers, skills, hooks, plugins}`), reports `pending` for the first `FAKE_EXT_PENDING_POLLS` `mcp_status` asks, hangs when `FAKE_EXT_HANG=1`; when stdin carries a `user` message it runs `fake-claude.mjs` as a child (pattern of `fake-workflow-claude.mjs`); `mcp add-json|remove` and `plugin enable|disable|list --json` update the state file and append argv (with the JSON argument's env/header values replaced by `<value>`) to `FAKE_EXT_CLI_OUT`.

- [ ] **Step 1: Write the failing tests** — sanitize: the real 2.1.322 answer shapes from the spec (copy a trimmed `mcp_status` entry with `config.env.SECRET='x'` and expanded `config.args`) give a server row without `x` anywhere in `JSON.stringify(loadout)`; status and source mapping table; a non-array `mcpServers` gives `errors.servers`. Probe (against the fake via `ZUMIBOT`-free env): returns all four answers; waits through 2 pending polls; `ends a hung CLI at the deadline` (`FAKE_EXT_HANG=1`, `deadlineMs: 500`) resolves with `errors` set and no process left (check the fake's pid file with `process.kill(pid, 0)` throwing); never writes a user message to stdin (fake asserts and exits 3 if one arrives without `FAKE_EXT_ALLOW_TURN`).
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/extensions/` — expect FAIL.
- [ ] **Step 3: Implement** — spawn `detached`, send `initialize` then the requests, poll `mcp_status`, end by closing stdin, SIGTERM to the group, SIGKILL 3 s later; drop every `hook_*`/system line; the Codex variant with the same ending.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Checkpoint.**

### Task 6: Settings files, skills and `.mcp.json`

**Files:**
- Create: `zumi-bot-server/backend/src/core/extensions/settingsFile.ts` (pure text edits)
- Create: `zumi-bot-server/backend/src/core/extensions/skillFiles.ts`
- Create: `zumi-bot-server/backend/src/core/extensions/mcpFiles.ts`
- Test: `zumi-bot-server/backend/tests/core/extensions/settingsFile.test.ts`, `skillFiles.test.ts`, `mcpFiles.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `EXT_TEXT`; `writeFileAtomic`, `assertInside` (`core/fsutil.ts`); `trashPath` (`core/trash.ts`).
- Produces:
  - `stampOf(text: string | null): string` (sha256 hex, `'absent'` for null)
  - `editSettings(text: string | null, edit: (s: Record<string, unknown>) => void): string` (throws `EXT_TEXT.badJson` on invalid JSON or a non-object root)
  - `hookRows(text: string | null, file: HookFile): Array<{ event; matcher; at: {group; hook}; type; command; timeout: number | null }>`
  - `setHook(s, input: { event: string; matcher: string; command: string; timeout?: number; at?: {group; hook} }): void`, `removeHook(s, event, at): void` (an emptied group and event are removed)
  - `setSkillOverride(s, name: string, on: boolean): void`
  - `settingsPath(file: HookFile, folder: string, home: string): string` (`~/.claude/settings.json`, `<folder>/.claude/settings.json`, `<folder>/.claude/settings.local.json`; respects `CLAUDE_CONFIG_DIR` for user)
  - `writeSettings(path: string, stamp: string, edit): Promise<void>` (reads, compares stamp, edits, writes atomically keeping mode; creates the folder for a missing file)
  - `listSkillDirs(root: string): Promise<Map<string, string>>` (frontmatter `name` → folder; skips `synced/` and `.trash/`)
  - `readSkill(dir: string, scope): Promise<SkillView>`, `saveSkill(root: string, input: { name; description; body; stamp?: string }): Promise<void>` (new: folder named by `NAME_PATTERN`; edit: only `name`-matching folder, `description` and body rewritten, other frontmatter keys kept), `removeSkill(dir: string, trash: (p: string) => Promise<void>): Promise<void>`
  - `readUserServers(claudeJson: string, folder: string): { user: Record<string, McpServerDef>; local: Record<string, McpServerDef> }` (read only), `readProjectServers(folder)`, `writeProjectServer(folder, name, def | null, stamp)`
  - `serverView(def: McpServerDef, scope, name, stamp): McpServerView` and `mergeInput(stored: McpServerDef, input: McpServerInput): McpServerDef` (null values keep the stored ones)

- [ ] **Step 1: Write the failing tests** — `creates a missing settings file` (`editSettings(null, s => setSkillOverride(s,'a',false))` → `{"skillOverrides":{"a":"off"}}\n`); `refuses invalid JSON` (`writeSettings` on `{bad` throws `badJson`, file unchanged); key order kept when only `hooks` changes; stale stamp refused; `removeHook` of a group's last hook removes the event; `setSkillOverride(...,true)` deletes the key and an empty `skillOverrides`; skills: create, edit keeps an `allowed-tools:` key and a sibling `script.sh`, remove calls the trash; `.mcp.json`: add keeps other servers, null removes, stale refused; `serverView` hides env and header values; `mergeInput` keeps a null value's stored text.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/extensions/` — expect FAIL on the new files.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Checkpoint.**

### Task 7: The service, the CLI writes and the RPCs

**Files:**
- Create: `zumi-bot-server/backend/src/core/extensions/extensionsService.ts`
- Create: `zumi-bot-server/backend/src/core/extensions/claudeCli.ts`
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.extensions`)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (`extensions:*`, `HandlerDeps.extensions`)
- Modify: `zumi-bot-server/frontend/src/net/api.ts`
- Modify: `zumi-bot-server/backend/src/app.ts` (build the service; `agents` watcher and agent save drop its cache)
- Test: `zumi-bot-server/backend/tests/core/extensions/extensionsService.test.ts`, `zumi-bot-server/backend/tests/rpc/extensionsHandlers.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 5, 6; `locate()` (claude), `codexLocator`, `runEnv.env()`, `AgentStore`, `SettingsStore` (`lastFolderByAgent`).
- Produces:
  - `claudeCli.ts`: `mcpAdd(o: {bin; folder; scope; name; def; env}): Promise<void>`, `mcpRemove(o: {bin; folder; scope; name; env}): Promise<void>`, `pluginSet(o: {bin; id; enabled; env}): Promise<void>`, `pluginList(o: {bin; env}): Promise<Array<{ id: string; enabled: boolean }>>` (parses `claude plugin list --json`: array of `{id, enabled, ...}`); errors are `EXT_TEXT` sentences plus an exit code in the log, never stderr text.
  - `class ExtensionsService` with `loadout(folder: string, agent: string | null, refresh: boolean): Promise<Loadout>` (cache key `folder\nagent\nsha256(agent file text)`, cleared by `forget()`; at most 2 probes, FIFO queue; plugins joined from `pluginList` and counted from the rows' `plugin`; adds the fixed "Added by ZumiBot" servers (`zumibot_browser`, `zumibot_todos`, `zumibot_vault`, `zumibot_agents` for an agent that is not Zumi Bot, `zumibot_automations` for Zumi Bot, `zumibot_desktop` for an agent with `computerUse`) and hooks (the pause hook, the vault guard, the desktop ask rules for a computer-use agent); for an agent, probe rows named in its `mcpServers` get source `agent`, and each `dropped` server of its `buildAgentRunConfig` result becomes a row with status `disabled` and `note` `EXT_TEXT.vaultMissing(env)`, `vaultLocked` or `reservedName`; user/project/local hook rows replaced by `hookRows` of the three files with `at` and `stamp`; for a Codex agent `probeCodex`), `server(folder, scope, name)`, `saveServer(folder, scope, name, input, prevName?, stamp?)` (user/local: remove then add, re-add the old def on failure and throw `addFailedRestored`; project: `writeProjectServer`), `removeServer`, `setPlugin`, `skill(scope, folder, name)`, `saveSkill`, `removeSkill`, `setSkill(name, on)`, `saveHook`, `removeHook`, `forget()`. Every write calls `forget()` and `onChanged()`.
  - `ZumiBotApi.extensions`: `loadout(folder: string, agent: string | null, refresh?: boolean): Promise<Loadout>`, `server(folder, scope, name): Promise<McpServerView>`, `saveServer(folder, scope, name, input: McpServerInput, prevName?: string, stamp?: string): Promise<void>`, `removeServer(folder, scope, name): Promise<void>`, `setPlugin(id, enabled): Promise<void>`, `skill(scope, folder, name): Promise<SkillView>`, `saveSkill(scope, folder, input: {name; description; body; stamp?}): Promise<void>`, `removeSkill(scope, folder, name): Promise<void>`, `setSkill(name, on): Promise<void>`, `saveHook(file: HookFile, folder, input, stamp): Promise<void>`, `removeHook(file, folder, event, at, stamp): Promise<void>`, `onChanged(cb): () => void`; RPC names `extensions:loadout|server|saveServer|removeServer|setPlugin|skill|saveSkill|removeSkill|setSkill|saveHook|removeHook`, event `extensions:changed` (no payload).
  - Handlers check every argument (`str()` etc.), refuse a folder that is not an existing absolute directory, names not matching `^[A-Za-z0-9_.:@ -]{1,100}$` for servers (`badName`), `zumibot_*` (`reservedName`), skill names not matching `NAME_PATTERN`, and Zumi Bot as `agent` in nothing but `loadout`.

- [ ] **Step 1: Write the failing tests** — service against the fake (Task 5) with a temp HOME: `loadout` lists the fake's rows plus ZumiBot's own; a second call is served from cache, `refresh` re-probes; three parallel loadouts start at most two fakes (count the fake's pid lines); `saveServer` user scope logs `mcp remove` then `mcp add-json` in `FAKE_EXT_CLI_OUT` and the logged JSON shows `<value>` not the value; a failing add (fake exit 1 on `FAKE_EXT_FAIL_ADD`) re-adds the old def and throws `addFailedRestored`; `setSkill('a', false)` writes the temp settings; handlers: a relative folder, `../x` names and `zumibot_x` are refused with fixed sentences.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/extensions/extensionsService.test.ts zumi-bot-server/backend/tests/rpc/extensionsHandlers.test.ts` — expect FAIL.
- [ ] **Step 3: Implement**, including the `api.ts` mapping and the `app.ts` wiring (the agents-folder watcher and `agents:save` call `extensions.forget()`).
- [ ] **Step 4: Run** the tests, `npm run typecheck`, `npm test` — expect PASS.
- [ ] **Step 5: Checkpoint.**

### Task 8: Frontend state, route and palette

**Files:**
- Create: `zumi-bot-server/frontend/src/state/extensions.ts`
- Modify: `zumi-bot-server/frontend/src/state/route.ts` (`SETTINGS_SECTIONS` gains `'claude-code'` after `'vault'`)
- Modify: `zumi-bot-server/frontend/src/state/settings.ts` (`settingsLabel` → `'Claude Code'`), `frontend/src/state/commandPalette.ts` (`SETTINGS['claude-code']` keywords `'mcp servers plugins skills hooks connectors tools extensions'`)
- Test: `zumi-bot-server/frontend/tests/extensions.test.ts`, extend `route.test.ts` and `commandPalette.test.ts`

**Interfaces:**
- Consumes: Task 1 types; `AgentFields` (Task 2).
- Produces:
  - `SOURCE_LABEL: Record<ServerSource | SkillSource | HookSource, string>` (`user` "You", `local` "This folder only", `project` "Project", `plugin` "Plugin", `claudeai` "claude.ai", `agent` "This agent", `zumibot` "Added by ZumiBot", `bundled` "Built in", `other` "Other")
  - `groupBySource<T extends { source: string }>(rows: T[]): Array<{ source: T['source']; rows: T[] }>` (fixed source order above)
  - `agentServerRows(l: Loadout, f: AgentFields): Array<LoadoutServer & { onForAgent: boolean; blockedByTools: boolean }>`; `agentSkillRows`, `agentPluginRows(l, f)` (`onForAgent` = `f.plugins?.[id] ?? enabled`)
  - `toggleServer(f: AgentFields, name: string, on: boolean): Partial<AgentFields>`, `toggleSkill`, `togglePlugin(f, id, on, globalEnabled: boolean)` (an override equal to the global state removes the entry; an empty list or map becomes null)
  - `blockedByTools(tools: string[] | null, serverName: string): boolean` (true when `tools` is a non-empty list with no entry starting `toolPrefix(name) + '__'` and no entry equal to `toolPrefix(name)`)
  - `totals(rows): { servers: number; connected: number; tools: number; skillsOn: number; skillTokens: number }`
  - `pluginHint(f: AgentFields, savedFields: AgentFields | null, id: string): 'save-to-see' | null`

- [ ] **Step 1: Write the failing tests** — grouping order; toggling a server off then on returns `serversOff: null`; `togglePlugin(f,'a@m',true,true)` removes an override; `blockedByTools(['Read'], 'github')` true, `blockedByTools(['mcp__github__x'], 'github')` false, `blockedByTools(null, 'github')` false; totals; `settingsFromPath('/settings/claude-code') === 'claude-code'`; a palette query "mcp" ranks the Claude Code section first among sections.
- [ ] **Step 2: Run** `npx vitest run --project frontend` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — expect PASS (and `npm run typecheck`: `ICONS` in `Settings.tsx` needs the new key; pick an existing `MenuIconName`).
- [ ] **Step 5: Checkpoint.**

### Task 9: Settings › Claude Code page

**Files:**
- Create: `zumi-bot-server/frontend/src/components/ExtensionsSettings.tsx`, `McpServerForm.tsx`, `HookForm.tsx`, `SkillEditor.tsx`
- Create: `zumi-bot-server/frontend/src/net/useLoadout.ts` (fetch, refetch on `extensions:changed`, an older answer never replaces a newer one)
- Modify: `zumi-bot-server/frontend/src/components/Settings.tsx` (render the section), `frontend/src/styles.css`

**Interfaces:**
- Consumes: Task 7 `api.extensions`, Task 8 state helpers, the existing `FolderPicker`, `ConfirmDialog`, unsaved-changes guard pattern of `VaultSettings.tsx`.
- Produces: `ExtensionsSettings` (no props beyond the section's), `McpServerForm({ view: McpServerView | null, scopes: McpScope[], vaultKeys?: Array<{ env: string; name: string }>, onSave(name, scope, input), onCancel })` (Task 10 reuses it with `vaultKeys`), `HookForm({ value?, onSave(input), onCancel })`, `useLoadout(folder: string, agent: string | null): { loadout: Loadout | null; loading: boolean; error: string | null; refresh(): void }`.

- [ ] **Step 1:** Build the page: folder picker (default home from `app` info already on the page) and Refresh; tabs Servers / Plugins / Skills / Hooks (`data-testid` `ext-tab-<name>`); rows grouped by `groupBySource` (`ext-server`, `ext-plugin`, `ext-skill`, `ext-hook`, each with `data-name`/`data-source`); per-row actions per the spec; Add per tab; `EXT_TEXT.machineOnly` under the header; a row that cannot change says where (`SOURCE_LABEL` plus the spec's hints: `claude mcp login <name>`, claude.ai › Settings › Connectors).
- [ ] **Step 2:** Run `npm run typecheck` and `npm run build:server` — expect success.
- [ ] **Step 3:** Run the app (`run` skill or `npm run dev`) and check the page in the browser pane against the real CLI: servers with status, plugins, skills with tokens, hooks; add a throwaway user-scope stdio server (`echo-test`, command `true`), see it listed, remove it. Kill every process the check started.
- [ ] **Step 4: Checkpoint.**

### Task 10: Agent Studio card

**Files:**
- Create: `zumi-bot-server/frontend/src/components/AgentLoadout.tsx`
- Modify: `zumi-bot-server/frontend/src/components/AgentEditor.tsx` (render after the form, like `AgentDesktop`, for any saved agent; view only for Zumi Bot and Codex)

**Interfaces:**
- Consumes: Task 8 helpers, Task 9 `useLoadout`, `McpServerForm`, `HookForm`; `api.vault.list()` filtered to `kind === 'apiKey'` items whose `agents` include the agent (for `vaultKeys`); `SettingsStore` `lastFolderByAgent` through the existing settings API.
- Produces: `AgentLoadout({ agentName, fields: AgentFields | null, savedFields: AgentFields | null, onFields(patch: Partial<AgentFields>), readOnly: boolean, engine: 'claude' | 'codex' })`.

- [ ] **Step 1:** Build the card (`data-testid="agent-loadout"`): folder picker defaulting to `lastFolderByAgent[agent]` else home, Refresh, totals, four groups with **On for this agent** switches (`agent-ext-switch`, `aria-checked`) calling `onFields(toggle…)`, "Not in this agent's tools list" where `blockedByTools`, "Save to see what it adds" from `pluginHint`, the cache note next to the switches ("Changing these makes the agent's next message re-read its whole context once."), and the two sub-cards for `mcpServers` and `hooks` (read-only with "Edit in the Raw view" when not editable), each env and header value with a **From Vault** picker writing `${vault:<env>}` and a plain value marked "Stored as plain text in the agent file"; dropped servers from the loadout's notes shown with their fixed sentence. The card re-probes after the editor saves (its `savedFields` changes).
- [ ] **Step 2:** `npm run typecheck`, `npm run build:server` — expect success.
- [ ] **Step 3:** In the running app: switch a server, a skill and a plugin off for a test agent, Save, check the file's YAML, Refresh, see the plugin's rows gone and the switched rows off; Discard restores. Kill what the check started.
- [ ] **Step 4: Checkpoint.**

### Task 11: e2e suite

**Files:**
- Create: `zumi-bot-server/e2e/extensions.e2e.mjs`
- Modify: `package.json` (`"e2e:extensions": "npm run build && node zumi-bot-server/e2e/extensions.e2e.mjs"`), `zumi-bot-server/e2e/harness.mjs` only if it needs a hook to put the fake extensions CLI in place (follow `fakeCodex`'s option style: `fakeExtensions: true`)

- [ ] **Step 1: Write the suite** covering the spec's Testing e2e bullet: the page lists the fake's servers, plugins, skills and hooks; add and remove a server (fake CLI log); create, edit and trash a skill under the temp HOME; add a hook to the temp `settings.json` while another key survives; Agent Studio switches a server, a skill and a plugin off and adds a hook, Save writes the keys; the agent's next chat run (`FAKE_INVOCATIONS_OUT`) has `--disallowedTools mcp__…`, one `--settings` with `deniedMcpServers` and the pause hook; a `/btw` side run has the same `--disallowedTools` and settings keys; an own server whose header picks a Vault key (saved over raw `/ws` `vault:save`, granted to the agent) gets `${ZUMIBOT_MCP_VAULT_0}` in argv and the value only in the fake's env (`FAKE_ENV_OUT`); the key's value is nowhere in the data dir, `h.output`, `h.errors` or the page text.
- [ ] **Step 2: Run** `npm run e2e:extensions` — expect PASS.
- [ ] **Step 3: Checkpoint.**

### Task 12: Real CLI probe

**Files:**
- Create: `zumi-bot-server/e2e/extensionsProbe.mjs` (+ `extensionsProbe.d.mts` like `vaultGuardProbe`)
- Modify: `package.json` (`e2e` script: append `&& node zumi-bot-server/e2e/extensionsProbe.mjs --soft`; add `"probe:extensions": "node zumi-bot-server/e2e/extensionsProbe.mjs"`)
- Test: `zumi-bot-server/backend/tests/extensionsProbe.test.ts`

**Interfaces:**
- Produces: `judgeExtensions(o: { answers: ProbeAnswers; denied: { name: string; present: boolean } | null; overrides: { skillOff: boolean; pluginOff: boolean } | null; model?: { toolsHidden: boolean; prefixOk: boolean; agentKeysIgnored: boolean } }): { verdict: 'PASS' | 'FAILED' | 'INCONCLUSIVE'; reasons: string[] }` exported from the `.mjs`.

- [ ] **Step 1: Write the failing test** — each verdict path: all shapes good → PASS; a request answered with an error or a changed shape → FAILED; a denied server still present → FAILED; no server to deny (the machine has none) → INCONCLUSIVE; `--soft` turns 2 into 0 with a warning (test the exit mapping function).
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/extensionsProbe.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the probe: model-free runs in a temp folder holding a `.mcp.json` stub server (so a server to deny always exists), one with `deniedMcpServers` naming it, one with `skillOverrides` and `enabledPlugins` for a temp project skill; `--model-check` adds the one haiku run (Checks made 1 to 3); exit 0/1/2; retried once; `ZUMIBOT_SKIP_EXTENSIONS_PROBE=1` skips. The `.mcp.json` stub must be approved for the run: pass `--settings {"enableAllProjectMcpServers": true}` on the probe's own runs.
- [ ] **Step 4: Run** the test, then `node zumi-bot-server/e2e/extensionsProbe.mjs` against the real CLI — expect PASS (report the output either way).
- [ ] **Step 5: Checkpoint.**

### Task 13: Zumi Bot, docs and the whole check

**Files:**
- Modify: `zumi-bot-server/backend/src/core/agents/zumiBot.ts` (one sentence in the agent-editing rules and in `/make-friendly`: never add, change or remove `serversOff`, `skillsOff`, `plugins`, `mcpServers` or `hooks`; keep them as they are)
- Modify: `CLAUDE.md` (a new **Servers, plugins, skills and hooks** paragraph in Architecture, the `e2e:extensions` and probe lines in Commands, the new keys in Agents)
- Test: `zumi-bot-server/backend/tests/core/agents/zumiBot.test.ts` (extend: the content holds the sentence)

- [ ] **Step 1:** Write the test, run it (FAIL), add the sentence, run it (PASS).
- [ ] **Step 2:** Update `CLAUDE.md` in the file's style (short, the why).
- [ ] **Step 3:** Run `npm run typecheck`, `npm test`, `npm run e2e:extensions`, `npm run e2e:vault`, `npm run e2e:btw`, `npm run e2e:pause` — expect PASS; report any failure with its output.
- [ ] **Step 4:** Kill every process the checks started; leave the worktree uncommitted for the user.
