# Connectors Phase 1 (route A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings › Connectors: one card per catalog service (Gmail, Google Calendar, Google Drive, Notion, GitHub, Slack, Linear) read from the claude.ai connectors the CLI already loads, a Connect link to claude.ai, and per-agent switches where every connector is off until the user turns it on.

**Architecture:** A pure, frozen catalog in `shared/src/connectors.ts` matches the probe's servers by URL pattern (name as fallback). The sanitizer adds a derived `connector` id to each `LoadoutServer`. A new `core/connectors/` keeps the per-agent on lists in `connectors.json` (data dir, 0600) and builds the page's view from the home-folder loadout. At spawn, `buildAgentRunConfig` denies every catalog connector the agent does not have on, through the same `deniedMcpServers` + `--disallowedTools` path `serversOff` uses.

**Tech Stack:** TypeScript, Node 22, React 19, vitest, the e2e harness (`zumi-bot-server/e2e/harness.mjs`), the fake CLI `backend/tests/fixtures/fake-extensions-claude.mjs`.

**Spec:** `docs/architecture/connectors.md` (approved as written on 2026-11-17: route A only; switches in `connectors.json`; keep today's on-state at the switch-over; unattended runs read-only is phase 3, not this plan).

## Global Constraints

- Never commit (the user's global rule overrides the template's commit steps). Leave every change in the working tree.
- Work in the main checkout. Another session owns `docs/architecture/engines.md`, `docs/architecture/protocol-engines.md`, `docs/superpowers/plans/2026-11-17-engine-seam-1a.md` and its own worktree: never touch them. In `CLAUDE.md` change only the Connectors index line.
- Never add `--dangerously-skip-permissions` or `bypassPermissions`.
- Do not change how Settings › Claude Code reads or edits servers, except a link to the new page. Its `oauth` refusal stays.
- Only the user flips a switch: the two RPCs are the only writers of `connectors.json`; no agent tool, workflow step or Zumi Bot action gets them; the file is behind deny rules in every main run.
- Secrets never go into logs, URLs or error messages. The key notice names the variable (`keyVarInUse`), never its value. Server URLs never leave the sanitizer; only the catalog id does.
- A new API method touches `ZumiBotApi` in `shared/src/types.ts`, the handler in `backend/src/rpc/handlers.ts` and `frontend/src/net/api.ts`. Handlers check every argument.
- No new dependency.
- No test reaches a real provider or the user's claude.ai account. The real-CLI probe (Task 10) runs only after the user says yes.
- Docs in the same change. `CLAUDE.md` stays under 16 384 bytes (`shared/tests/repoDocs.test.ts`).
- Every catalog URL and pattern is `https:`; every Connect link starts `https://claude.ai/`.

## Review Focus

1. **A connector renamed on claude.ai** (`claude.ai Gmail (2)`, or a user-named GitHub custom connector): still matched (URL first, name with a trailing ` (<digits>)` stripped) and still denied by its `serverUrl` entry. Tests in Task 1.
2. **An agent renamed or deleted** while it has connectors on: the on list follows the rename (synchronously, before the first await) and is dropped on delete. Tests in Task 3.
3. **`connectors.json` corrupt or unreadable:** corrupt is moved aside and reads as everything off; unreadable reads as everything off and is never overwritten until a read succeeds. Tests in Task 3.
4. **The switch-over probe fails** (CLI missing, timeout, an error answer): nothing is kept, every connector starts off, the page says why. A run that starts while the switch-over is still running gets no connector deny (today's behaviour), never a wait. Tests in Tasks 5 and 6.
5. **A switch request for Zumi Bot, a Codex agent, a broken agent, an unknown agent or an unknown id:** refused by the handler with a fixed sentence or `TypeError`; nothing written. Tests in Task 6.

## Calls made in this plan (not in the spec; flag them to the user)

- Zumi Bot never has a connector: its runs deny every catalog connector, and it gets no switch.
- During the first-start switch-over, runs carry no connector deny (as before phase 1) rather than waiting.
- The switch-over skips the probe when no Claude agent besides Zumi Bot exists (fresh install: nothing to keep).
- `connectors.json` is guarded by deny rules for the six file tools only (no Bash hook). The store reads the file only at start, so a Bash write changes nothing until a restart and the next switch overwrites it.
- The page probes again on focus or on becoming visible, at most once every 5 s.
- A probe status of `pending` or `unknown` shows as **Needs attention**; a probe that failed outright shows every card as **Not checked**.
- The e2e harness seeds an all-off `connectors.json` (unless a suite passes its own), so no other suite runs the switch-over probe.

---

### Task 1: The catalog module

**Files:**
- Create: `zumi-bot-server/shared/src/connectors.ts`
- Test: `zumi-bot-server/shared/tests/connectors.test.ts`

**Interfaces:**
- Consumes: `toolPrefix`, `type LoadoutServer` from `./extensions`.
- Produces:
  ```ts
  export const CONNECTOR_IDS = ['gmail', 'google-calendar', 'google-drive', 'notion', 'github', 'slack', 'linear'] as const
  export type ConnectorId = (typeof CONNECTOR_IDS)[number]
  export interface Connector {
    readonly id: ConnectorId; readonly name: string; readonly blurb: string
    readonly urls: readonly string[]      // deniedMcpServers serverUrl patterns, `*` = any run of characters
    readonly names: readonly string[]     // claude.ai display names
    readonly connectUrl: string           // what Connect / Reconnect / Manage opens
    readonly customUrl: string | null     // GitHub only: the URL to add as a custom connector
    readonly read: readonly string[]; readonly write: readonly string[]
  }
  export const CONNECTORS: readonly Connector[]            // deep-frozen, CONNECTOR_IDS order
  export function isConnectorId(v: unknown): v is ConnectorId
  export function connectorById(id: ConnectorId): Connector
  export function urlMatches(pattern: string, url: string): boolean
  export function connectorOf(url: string | null, name: string): ConnectorId | null
  export type ConnectorState = 'connected' | 'needs-attention' | 'not-connected' | 'off-in-claude-code' | 'unknown'
  export function connectorState(servers: ReadonlyArray<Pick<LoadoutServer, 'connector' | 'status'>>, id: ConnectorId): Exclude<ConnectorState, 'unknown'>
  export function connectorTools(servers: ReadonlyArray<Pick<LoadoutServer, 'connector' | 'tools'>>, id: ConnectorId): string[]
  export function isReadTool(id: ConnectorId, tool: string): boolean
  export function unknownTools(id: ConnectorId, tools: readonly string[]): string[]
  export function denyEntries(off: readonly ConnectorId[]): { deniedMcpServers: Array<{ serverUrl: string } | { serverName: string }>; disallowedTools: string[] }
  export interface ConnectorCardView { id: ConnectorId; state: ConnectorState; tools: string[]; unknownTools: string[]; on: string[] }
  export interface ConnectorAgent { name: string; engine: 'claude' | 'codex' }
  export type ConnectorMigration = 'running' | 'kept' | 'failed'
  export interface ConnectorsView { keyVar: string | null; migration: ConnectorMigration; error: string | null; agents: ConnectorAgent[]; connectors: ConnectorCardView[]; at: number }
  export const CONNECTOR_TEXT: { … }   // every sentence below
  ```

**Catalog values** (from the spec's tables; copy exactly):

| id | name | urls | names | connectUrl | customUrl |
| :- | :- | :- | :- | :- | :- |
| gmail | Gmail | `https://gmailmcp.googleapis.com/*`, `https://gmail.mcp.claude.com/*` | `claude.ai Gmail` | `https://claude.ai/directory/2701e52f-b826-4aaf-8b25-11f2a97c98b0` | null |
| google-calendar | Google Calendar | `https://calendarmcp.googleapis.com/*`, `https://gcal.mcp.claude.com/*` | `claude.ai Google Calendar` | `https://claude.ai/directory/2a838eaa-f7b4-4bc2-bd47-c326f3c813c5` | null |
| google-drive | Google Drive | `https://drivemcp.googleapis.com/*` | `claude.ai Google Drive` | `https://claude.ai/directory/b89f7865-a755-4f86-8062-c3bd651740ce` | null |
| notion | Notion | `https://mcp.notion.com/*` | `claude.ai Notion` | `https://claude.ai/directory/69f3a300-cc60-48c4-b237-dfac56530dbf` | null |
| github | GitHub | `https://api.githubcopilot.com/mcp*` | (none) | `https://claude.ai/customize/connectors` | `https://api.githubcopilot.com/mcp/` |
| slack | Slack | `https://mcp.slack.com/*` | `claude.ai Slack` | `https://claude.ai/directory/597f662f-36de-437e-836e-5a81013cbfbe` | null |
| linear | Linear | `https://mcp.linear.app/*` | `claude.ai Linear` | `https://claude.ai/directory/fa50c30c-9f62-4f94-b851-217868185db6` | null |

Blurbs: Gmail "Search, read and draft email in your Gmail." · Google Calendar "Read your calendars, find free time and manage events." · Google Drive "Search and read files in your Google Drive." · Notion "Search, read and edit pages in your Notion workspace." · GitHub "Read and change repositories, issues and pull requests on GitHub." · Slack "Search, read and send messages in your Slack workspace." · Linear "Read and update issues and projects in Linear."

Read and write lists: the spec's "Read and write tools (route A)" table, exactly, with two expansions:
- Notion write = every `notion-*` tool this list names: `notion-calendar-cancel-events`, `notion-calendar-create-events`, `notion-calendar-update-events`, `notion-complete-mcp-setup`, `notion-convert-page-to-skill`, `notion-convert-to-meetings-database`, `notion-create-attachment`, `notion-create-comment`, `notion-create-database`, `notion-create-file-upload`, `notion-create-folder`, `notion-create-meeting-note`, `notion-create-pages`, `notion-create-suggested-edit`, `notion-create-view`, `notion-delete-comment`, `notion-delete-databases`, `notion-delete-pages`, `notion-duplicate-page`, `notion-link-meeting-note-to-calendar-event`, `notion-move-pages`, `notion-resolve-suggested-edit`, `notion-restore-pages`, `notion-restore-version`, `notion-send-message-to-session`, `notion-set-comment-reaction`, `notion-set-discussion-resolved`, `notion-spawn-session`, `notion-stop-session`, `notion-update-comment`, `notion-update-data-source`, `notion-update-folder`, `notion-update-page`, `notion-update-page-favorites`, `notion-update-sidebar-tabs`, `notion-update-skill-settings`, `notion-update-view`, `notion-upload-skill`.
- GitHub: take the tool list from `github/github-mcp-server`'s README (Tools section). Read = a name starting `get_`, `list_` or `search_`, or one of `issue_read`, `pull_request_read`, `actions_get`, `actions_list`, `get_job_logs`, `projects_get`, `projects_list`, `custom_properties_read`, `repository_ruleset_read`, `get_copilot_space`, `list_copilot_spaces`, `github_support_docs_search`. Write = every other tool listed there. Name the README commit or date in a comment.

**Rules the functions follow:**
- `urlMatches`: the whole URL must match; every character literal except `*`.
- `connectorOf`: URL first (any entry's pattern); else the name with a trailing ` (<digits>)` removed equals one of an entry's `names`; else null. A null or non-`https:` URL skips the URL step.
- `connectorState`: the best of the matching rows, in the order connected > needs-attention > off-in-claude-code; none → `not-connected`. Status `connected` → connected; `needs-auth`, `failed`, `pending`, `unknown` → needs-attention; `disabled` → off-in-claude-code.
- `connectorTools`: the union of the matching rows' tools, first-seen order.
- `isReadTool`: true only for a name in `read`. `unknownTools`: names in neither list, in input order.
- `denyEntries`: for each id in catalog order: its urls as `{serverUrl}`, then its names as `{serverName}`; `disallowedTools` = `toolPrefix` of every name, deduped. Ids not in the catalog are ignored.

**CONNECTOR_TEXT** (exact copy):
- `intro`: "Services your agents can use, connected through your claude.ai account. Each one is off for every agent until you turn it on here."
- `machines`: "Connections belong to your claude.ai account, so every machine signed in to it sees the same ones. The switches sync with the rest of ZumiBot."
- `keyVar(v)`: `` `Claude Code is using the key in ${v}, so it loads no claude.ai connectors. To use them, sign in with claude /login on a Claude subscription and remove ${v} from this server's environment.` ``
- `running`: "Reading your connectors for the first time. Switches open in a moment."
- `migrationFailed`: "Claude Code could not list your connectors when this page was first set up, so every connector starts off for every agent."
- `probeFailed`: "Claude Code could not list your connectors just now. Try again in a moment."
- `labels`: connected "Connected", needs-attention "Needs attention", not-connected "Not connected", off-in-claude-code "Turned off in Claude Code", unknown "Not checked".
- `needsAttention`: "Reconnect it on claude.ai. If every connector shows this, run claude /login on this machine."
- `notConnected`: "Connect it on claude.ai, then come back here."
- `offInClaudeCode`: "It is connected but turned off in Claude Code's own settings."
- `github`: "Add this URL as a custom connector on claude.ai (Customize › Connectors › Add custom connector)."
- `unknown(list)`: `` `Tools ZumiBot does not know yet: ${list.join(', ')}.` ``
- `codex`: "Codex agents cannot use claude.ai connectors."
- `zumiBot`: "Zumi Bot never uses connectors."
- `onFor(names)`: names empty → "Off for every agent"; else `` `On for ${names.join(', ')}` ``.
- `notSwitchable`: "Only a Claude agent other than Zumi Bot can have a connector."
- `settingUp`: "Connectors are still being set up. Try again in a moment."
- `toClaudeCode`: "Servers you set up yourself are on Settings › Claude Code."
- `toConnectors`: "claude.ai connectors (Gmail, Slack, Notion and others) are turned on per agent in Settings › Connectors."
- `agentRow`: "Set on the Connectors page"

- [ ] **Step 1: Write the failing tests** in `shared/tests/connectors.test.ts`:
  - `ids are fixed`: `CONNECTORS.map(c => c.id)` deep-equals `CONNECTOR_IDS`; names as in the table.
  - `every url and pattern is https and every link is on claude.ai`: each `urls[i]` and `customUrl` starts `https://`; each `connectUrl` starts `https://claude.ai/`.
  - `no pattern or name in two entries`.
  - `read and write are disjoint per entry`, and no entry has an empty `read`.
  - `catalog cannot be extended`: `Object.isFrozen` on the array, each entry and each inner array; `expect(() => (CONNECTORS as Connector[]).push(CONNECTORS[0])).toThrow(TypeError)`.
  - `connectorOf matches URL first`: `('https://mcp.notion.com/mcp', 'whatever')` → `'notion'`; `('https://api.githubcopilot.com/mcp/', 'My GitHub')` → `'github'`; both Gmail hosts → `'gmail'`; `('https://example.invalid/mcp', 'claude.ai Gmail')` → `'gmail'` (name fallback); `(null, 'claude.ai Gmail (2)')` → `'gmail'`; `('http://mcp.notion.com/mcp', 'x')` → null; `(null, 'claude.ai Fake Drive')` → null.
  - `urlMatches is literal outside *`: `urlMatches('https://mcp.notion.com/*', 'https://mcpXnotion.com/a')` → false.
  - `connectorState`: rows `[{connector:'gmail',status:'needs-auth'},{connector:'gmail',status:'connected'}]` → `'connected'`; `pending` → `'needs-attention'`; `disabled` → `'off-in-claude-code'`; no row → `'not-connected'`.
  - `unknown tool is a write`: `isReadTool('gmail', 'send_message')` false, `('gmail', 'search_threads')` true, `('gmail', 'brand_new')` false; `unknownTools('gmail', ['search_threads', 'brand_new'])` → `['brand_new']`.
  - `denyEntries`: `denyEntries(['gmail'])` deep-equals `{ deniedMcpServers: [{serverUrl:'https://gmailmcp.googleapis.com/*'},{serverUrl:'https://gmail.mcp.claude.com/*'},{serverName:'claude.ai Gmail'}], disallowedTools: ['mcp__claude_ai_Gmail'] }`; `denyEntries(['github'])` has one serverUrl entry and no disallowedTools; `denyEntries([])` is empty.
- [ ] **Step 2:** Run `npx vitest run zumi-bot-server/shared/tests/connectors.test.ts` — FAIL (module missing).
- [ ] **Step 3:** Implement `shared/src/connectors.ts` (no `node:` imports; `import type { LoadoutServer }` plus the value `toolPrefix`). Deep-freeze `CONNECTORS` with a local helper, as `agentRunConfig.ts` does.
- [ ] **Step 4:** Run it again — PASS. Then `npx vitest run --project shared` — PASS.

### Task 2: `connector` on every LoadoutServer

**Files:**
- Modify: `zumi-bot-server/shared/src/extensions.ts` (`LoadoutServer`)
- Modify: `zumi-bot-server/backend/src/core/extensions/sanitize.ts` (`claudeServers`, `codexServers`)
- Modify: every other `LoadoutServer` literal the typecheck names (`extensionsService.ts` dropped rows, `zumiBotAdds`, tests)
- Test: `zumi-bot-server/backend/tests/core/extensions/sanitize.test.ts`

**Interfaces:**
- Consumes: `connectorOf`, `type ConnectorId` (Task 1).
- Produces: `LoadoutServer.connector: ConnectorId | null` (set from the raw `config.url` and the name for Claude rows; always null for Codex rows, ZumiBot's own rows and dropped rows).

- [ ] **Step 1: Failing tests** in `sanitize.test.ts`:
  - The existing `toEqual` for `plugin:playwright:playwright` gains `connector: null`.
  - `claude.ai Gmail` with `config.url: 'https://example.invalid/mcp'` → `connector: 'gmail'` (name fallback).
  - New row `{ name: 'claude.ai Notion', config: { type: 'claudeai-proxy', url: 'https://mcp.notion.com/mcp' }, scope: 'claudeai', source: 'claudeai', status: 'connected' }` → `connector: 'notion'`; a user-scope `{ name: 'my linear', config: { type: 'http', url: 'https://mcp.linear.app/mcp' }, scope: 'user' }` → `connector: 'linear'`.
  - The sanitized row still holds no `url` key and the serialized loadout contains no `https://mcp.notion.com` (the URL never leaves the sanitizer).
- [ ] **Step 2:** `npx vitest run zumi-bot-server/backend/tests/core/extensions/sanitize.test.ts` — FAIL.
- [ ] **Step 3:** Add `connector: ConnectorId | null` to `LoadoutServer` (`import type { ConnectorId } from './connectors'`). In `claudeServers` set `connector: connectorOf(nonEmpty(obj(s.config)?.url), name)`; in `codexServers` `connector: null`. Run `npm run typecheck` and add `connector: null` at each literal it names.
- [ ] **Step 4:** Sanitize test PASS; `npx vitest run --project backend zumi-bot-server/backend/tests/core/extensions` PASS; `npm run typecheck` PASS.

### Task 3: The switch store

**Files:**
- Create: `zumi-bot-server/backend/src/core/connectors/connectorStore.ts`
- Create: `zumi-bot-server/backend/src/core/connectors/CLAUDE.md` (pointer: "Before changing code here, read `docs/architecture/connectors.md` (repo-root path).", same form as `core/extensions/CLAUDE.md`)
- Test: `zumi-bot-server/backend/tests/core/connectorStore.test.ts`

**Interfaces:**
- Consumes: `CONNECTOR_IDS`, `isConnectorId`, `type ConnectorId`, `type ConnectorMigration` (Task 1); `writeFileAtomic` from `../fsutil`.
- Produces:
  ```ts
  export class ConnectorStore {
    constructor(dataDir: string)                         // file: <dataDir>/connectors.json
    load(): Promise<void>
    migrated(): boolean                                  // a file was read, or replace() ran
    migration(): Exclude<ConnectorMigration, 'running'> | null
    onFor(agent: string): ConnectorId[] | null           // null until migrated; catalog order
    offFor(agent: string): ConnectorId[]                 // [] until migrated (today's behaviour); else the complement of onFor
    set(agent: string, id: ConnectorId, on: boolean): Promise<void>   // throws Error(CONNECTOR_TEXT.settingUp) before migration
    replace(agents: Record<string, ConnectorId[]>, migration: 'kept' | 'failed'): Promise<void>  // the switch-over's one write; a no-op once migrated
    renameAgent(from: string, to: string): Promise<void> // memory moves before the first await
    forgetAgents(names: readonly string[]): Promise<void>
    agents(): string[]                                   // names holding an entry
  }
  ```
  File shape: `{ "v": 1, "agents": { "<agent>": ["gmail", …] }, "migration": "kept" | "failed" }`, written with `writeFileAtomic(file, text, 0o600)`, writes queued one at a time (ApprovalStore's `run` pattern).

Read rules: missing file → not migrated. Not JSON → moved aside to `connectors.json.corrupt-<ms>` and read as `{agents: {}, migration: 'failed'}` (migrated, all off). `EACCES` or any other read error → `unread`: migrated, `onFor` returns `[]` for everyone, and every write first re-reads and throws `Error('connectors.json could not be read, so the change was not saved')` until a read succeeds. Unknown ids and non-array values are dropped on read. An agent left with no ids is removed from the map.

- [ ] **Step 1: Failing tests** (temp data dir per test):
  - `missing file is not migrated`: `onFor('a')` → null, `offFor('a')` → `[]`, `set` rejects with `CONNECTOR_TEXT.settingUp`.
  - `replace then set round-trips`: `replace({ a: ['slack', 'gmail'] }, 'kept')` → `onFor('a')` `['gmail', 'slack']` (catalog order); `set('a', 'notion', true)`; a fresh store's `load()` gives `['gmail', 'notion', 'slack']`; `offFor('a')` is the other four; file mode `0o600`; `migration()` `'kept'`.
  - `replace runs once`: a second `replace({ b: ['gmail'] }, 'kept')` leaves `onFor('b')` `[]`.
  - `unknown ids are dropped on read`: a file with `["gmail", "fax"]` → `['gmail']`.
  - `corrupt file is moved aside and reads as all off`: `migration()` `'failed'`, `onFor('a')` `[]`, a `connectors.json.corrupt-*` exists.
  - `unreadable file is never overwritten` (chmod `000`, skip as root): `onFor('a')` `[]`, `set` rejects, file bytes unchanged.
  - `rename moves synchronously`: after `replace({ a: ['gmail'] }, 'kept')`, `const p = renameAgent('a', 'b')`; before awaiting, `onFor('b')` is `['gmail']` and `onFor('a')` `[]`; after, the file names `b` only. Renaming onto an agent with entries joins both lists.
  - `forgetAgents drops entries`; `agents()` lists only names holding ids.
- [ ] **Step 2:** `npx vitest run zumi-bot-server/backend/tests/core/connectorStore.test.ts` — FAIL.
- [ ] **Step 3:** Implement `ConnectorStore` on `ApprovalStore`'s pattern (`core/store/approvalStore.ts`).
- [ ] **Step 4:** PASS.

### Task 4: The run's deny entries and the file guard

**Files:**
- Modify: `zumi-bot-server/backend/src/core/extensions/agentRunConfig.ts`
- Create: `zumi-bot-server/backend/src/core/connectors/connectorsGuard.ts`
- Test: `zumi-bot-server/backend/tests/core/extensions/agentRunConfig.test.ts`, `zumi-bot-server/backend/tests/core/connectorsGuard.test.ts`

**Interfaces:**
- Consumes: `denyEntries`, `type ConnectorId` (Task 1).
- Produces:
  - `buildAgentRunConfig(ext, keys, opts: { serversOff?: boolean; skillsOff?: boolean; connectorsOff?: readonly ConnectorId[] } = {})`. When `opts.serversOff !== false`: `deniedMcpServers` = today's `{serverName}` entries, then `denyEntries(connectorsOff).deniedMcpServers`; `disallowedTools` = today's belt, then `denyEntries(...).disallowedTools`, deduped. When `serversOff === false` (the probe), neither is added.
  - `connectorsGuardSettings(file: string): string` → `JSON.stringify({ permissions: { deny: [...] } })` with `${tool}(/${abs})` for `Read`, `Edit`, `MultiEdit`, `Write`, `Grep`, `Glob` (`abs` = `resolve(file)`; same form as `vaultGuardSettings`).

- [ ] **Step 1: Failing tests:**
  - `agentRunConfig.test.ts` › `connectors not on are denied after the agent's own off list`: `ext` with `serversOff: ['x']`, `connectorsOff: ['gmail']` → settings' `deniedMcpServers` deep-equals `[{serverName:'x'}, {serverUrl:'https://gmailmcp.googleapis.com/*'}, {serverUrl:'https://gmail.mcp.claude.com/*'}, {serverName:'claude.ai Gmail'}]`; `disallowedTools` `['mcp__x', 'mcp__claude_ai_Gmail']`.
  - `the probe gets no connector deny`: same input with `serversOff: false` → no `--settings` key `deniedMcpServers`, `disallowedTools` `[]`.
  - `no connectorsOff is today's config`: an existing test's input without `connectorsOff` gives byte-identical `extraArgs`.
  - `connectorsGuard.test.ts`: `connectorsGuardSettings('/d/connectors.json')` parses to `{ permissions: { deny: ['Read(//d/connectors.json)', 'Edit(//d/connectors.json)', 'MultiEdit(//d/connectors.json)', 'Write(//d/connectors.json)', 'Grep(//d/connectors.json)', 'Glob(//d/connectors.json)'] } }`.
- [ ] **Step 2:** Run both files — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.

### Task 5: The switch-over and the page's view

**Files:**
- Create: `zumi-bot-server/backend/src/core/connectors/migration.ts` (pure)
- Create: `zumi-bot-server/backend/src/core/connectors/connectorsService.ts`
- Test: `zumi-bot-server/backend/tests/core/connectorMigration.test.ts`, `zumi-bot-server/backend/tests/core/connectorsService.test.ts`

**Interfaces:**
- Consumes: Task 1's catalog functions and view types; `ConnectorStore` (Task 3); `type Loadout`, `type AgentExtensions` from shared extensions; `ZUMI_BOT_NAME`; `engineOfAgent`.
- Produces:
  ```ts
  // migration.ts
  export interface MigratingAgent { name: string; serversOff: readonly string[]; own: ReadonlyArray<{ name: string; url: string | null }> }
  export function keptSwitches(servers: ReadonlyArray<Pick<LoadoutServer, 'name' | 'connector'>>, agents: readonly MigratingAgent[]): Record<string, ConnectorId[]>
  // connectorsService.ts
  export interface ConnectorsDeps {
    store: ConnectorStore
    loadout(refresh: boolean): Promise<Loadout>          // the home folder, no agent
    agents(): Promise<AgentSummary[]>
    extensionsOf(agent: string): Promise<AgentExtensions | null>
    keyVar(): Promise<string | null>
    now(): number
    onChanged(): void                                    // `connectors:changed`
    log(line: string): void
  }
  export class ConnectorsService {
    constructor(d: ConnectorsDeps)
    list(refresh: boolean): Promise<ConnectorsView>
    setAgent(id: ConnectorId, agent: string, on: boolean): Promise<void>
    migrate(): Promise<void>                             // once per process; concurrent calls share one promise
  }
  ```

Rules:
- `keptSwitches`: per agent, the ids of `servers` whose `connector` is set and whose `name` is not in `serversOff`, plus `connectorOf(own.url, own.name)` of each own server; catalog order, deduped; an agent with none is left out.
- `migrate()`: returns at once when `store.migrated()`. Claude agents = `agents()` with `error === null`, name not `ZUMI_BOT_NAME`, `engineOfAgent(a) === 'claude'`. None → `replace({}, 'kept')` with no probe. Else `loadout(false)`: `errors.servers` set or a throw → `replace({}, 'failed')`; else `replace(keptSwitches(l.servers, migrating), 'kept')`, where each agent's `serversOff` and `own` (`servers` with a non-null `def`: `{ name, url: def.url ?? null }`) come from `extensionsOf`. Then `onChanged()`. Log one line: `connectors: kept on-state for <n> agents` or `connectors: switch-over probe failed, every connector starts off` (no names, URLs or CLI text).
- `list(refresh)`: `agents` = `agents()` minus errors and Zumi Bot, sorted by name, each with `engine`. `keyVar` = `await keyVar()`. `migration` = `store.migration() ?? 'running'`. `loadout(refresh)` throwing → `error = CONNECTOR_TEXT.probeFailed`, every card `state: 'unknown'`, `tools: []`; `errors.servers` set → `error` = that sentence, cards `unknown`. Otherwise per catalog entry: `state` = `connectorState`, `tools` = `connectorTools`, `unknownTools`, and `on` = the Claude agents whose `store.onFor(name)` includes the id (none while running). `at` = `now()`.
- `setAgent`: `store.set(agent, id, on)` then `onChanged()`. (The handler checks who the agent is.)

- [ ] **Step 1: Failing tests:**
  - `connectorMigration.test.ts` › `keeps what each agent loads today`: servers `claude.ai Gmail`(gmail), `claude.ai Notion`(notion), `stub`(null); agent `a` serversOff `['claude.ai Notion']`, own `[{ name: 'lin', url: 'https://mcp.linear.app/mcp' }]` → `{ a: ['gmail', 'linear'] }`; agent `b` with every catalog server off → absent.
  - `connectorsService.test.ts` (fake deps, real store in a temp dir):
    - `switch-over with no Claude agents writes kept without probing`: `loadout` never called; `store.migration()` `'kept'`.
    - `switch-over keeps on-state`: agents `dev` (claude), `cx` (provider codex), `zumi-bot`; loadout servers Gmail and Slack → `onFor('dev')` `['gmail', 'slack']`; `cx` and `zumi-bot` absent; `onChanged` called once.
    - `switch-over failure starts everything off`: `loadout` rejects → `migration()` `'failed'`, `onFor('dev')` `[]`; same for `errors.servers` set.
    - `migrate twice probes once` (two concurrent calls, `loadout` called once).
    - `list while running`: before `migrate()` resolves, `list(false)` has `migration: 'running'` and every `on` empty.
    - `list builds cards`: Gmail `connected` with tools `['search_threads', 'brand_new']` → card `{ state: 'connected', unknownTools: ['brand_new'], on: ['dev'] }`; Drive absent → `not-connected`; `agents` `[{name:'cx',engine:'codex'},{name:'dev',engine:'claude'}]` (no Zumi Bot).
    - `list names the key variable, never its value`: `keyVar` → `'ANTHROPIC_API_KEY'`; `JSON.stringify(view)` contains it and not the fake value set in the test's env object.
    - `probe failure shows not checked`: `loadout` rejects → `error === CONNECTOR_TEXT.probeFailed`, every state `'unknown'`.
- [ ] **Step 2:** Run both — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS.

### Task 6: API, handlers and server wiring

**Files:**
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.connectors`), `zumi-bot-server/shared/src/rpc.ts` (event)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (deps + two handlers)
- Modify: `zumi-bot-server/frontend/src/net/api.ts`
- Modify: `zumi-bot-server/backend/src/app.ts`
- Test: `zumi-bot-server/backend/tests/rpc/connectorsHandlers.test.ts`, `zumi-bot-server/backend/tests/core/connectorsWiring.test.ts` (only if `app.ts`'s closure is extracted, see Step 3)

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - `ZumiBotApi.connectors: { list(refresh?: boolean): Promise<ConnectorsView>; setAgent(id: ConnectorId, agent: string, on: boolean): Promise<void>; onChanged(cb: () => void): () => void }`
  - Server event `{ event: 'connectors:changed'; payload: null }`.
  - `HandlerDeps.connectors: Pick<ConnectorsService, 'list' | 'setAgent'>`.
  - Handlers: `'connectors:list': (refresh)` — null/undefined → false, else `bool(refresh, 'refresh')`. `'connectors:setAgent': (id, agent, on)` — `!isConnectorId(id)` → `throw new TypeError('id')`; `typeof agent !== 'string'` → `TypeError('agent')`; the agent must be in `agents.list()` with `error === null`, not `ZUMI_BOT_NAME`, `engineOfAgent(a) === 'claude'`, else `throw new Error(CONNECTOR_TEXT.notSwitchable)`; `bool(on, 'on')`.
  - `api.ts`: `list: (refresh) => call('connectors:list', refresh ?? false)`, `setAgent: (id, agent, on) => call('connectors:setAgent', id, agent, on)`, `onChanged: (cb) => rpc.on('connectors:changed', () => cb())`.

`app.ts` wiring:
- `const connectorStore = new ConnectorStore(dataDir)`; `await connectorStore.load()` beside the other stores' loads.
- `agentRunConfig`: Zumi Bot → `opts?.serversOff === false ? NO_RUN_CONFIG : buildAgentRunConfig(NO_EXTENSIONS, [], { connectorsOff: CONNECTOR_IDS })`; `ext === null` → `buildAgentRunConfig(NO_EXTENSIONS, [], { ...opts, connectorsOff: connectorStore.offFor(agent) })`; otherwise today's call with `{ ...opts, connectorsOff: connectorStore.offFor(agent) }`.
- `vaultGuard: mergeInlineJson([vaultGuardSettings(...), connectorsGuardSettings(join(dataDir, 'connectors.json'))], '--settings')` (export nothing new: `mergeInlineJson` is already exported from `claudeRunner.ts`). Update the comment: the guard now also covers `connectors.json`.
- `const connectors = new ConnectorsService({ store: connectorStore, loadout: (refresh) => extensions.loadout(home, null, refresh), agents: () => agents.list(), extensionsOf: (a) => agents.extensionsOf(a), keyVar: async () => { await runEnv.ready(); return keyVarInUse(runEnv.env()) }, now: Date.now, onChanged: () => hub.broadcast({ event: 'connectors:changed', payload: null }), log: (l) => console.error(l) })`; pass it to `createHandlers`.
- `extensions:changed` also fires `connectors:changed` (a Claude Code page write can add or remove a catalog server).
- Rename pipeline: `await connectorStore.renameAgent(from, to)` right after `approvals.renameAgent`, caught and logged like the vault's. Agents sync: `removed` adds `await connectorStore.forgetAgents(names)` (caught); `remembered` adds `...connectorStore.agents()`.
- After the server listens (where the search index `start()` runs): `void connectors.migrate()`.

- [ ] **Step 1: Failing tests** in `connectorsHandlers.test.ts` (pattern of `extensionsHandlers.test.ts`; agents `dev`, `broken` (error), `zumi-bot`, `cx` (provider codex)):
  - `list passes refresh`: `h['connectors:list'](null)` → service called with `false`; `(true)` → `true`; `('yes')` rejects `TypeError`.
  - `setAgent validates`: `('fax', 'dev', true)` → `TypeError`; `('gmail', 1, true)` → `TypeError`; `('gmail', 'dev', 'on')` → `TypeError`; `('gmail', 'zumi-bot', true)`, `('gmail', 'cx', true)`, `('gmail', 'broken', true)`, `('gmail', 'ghost', true)` each reject with `CONNECTOR_TEXT.notSwitchable`; none reached the service.
  - `setAgent passes a valid call`: `('slack', 'dev', false)` → service `['slack', 'dev', false]`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement the API, the handlers, `api.ts` and the `app.ts` wiring. If an existing backend test builds the full app and now trips on the switch-over (an extra probe, an extra file), fix the test's setup, never the rule.
- [ ] **Step 4:** `npx vitest run zumi-bot-server/backend/tests/rpc` PASS; `npm run typecheck` PASS.

### Task 7: The page's pure rules and its place in Settings

**Files:**
- Create: `zumi-bot-server/frontend/src/state/connectors.ts`
- Modify: `zumi-bot-server/frontend/src/state/route.ts` (`SETTINGS_SECTIONS`: `'connectors'` right after `'claude-code'`)
- Modify: `zumi-bot-server/frontend/src/state/settings.ts` (label "Connectors")
- Modify: `zumi-bot-server/frontend/src/components/MenuIcon.tsx` (new `plug` shape), `zumi-bot-server/frontend/src/components/Settings.tsx` (`ICONS.connectors = 'plug'`)
- Modify: `zumi-bot-server/frontend/src/state/commandPalette.ts` (`connectors: { keywords: 'gmail google calendar drive notion github slack linear claude.ai accounts services connect', icon: 'plug' }`; drop `connectors` from `claude-code`'s keywords)
- Modify: `zumi-bot-server/frontend/src/state/extensions.ts` (`agentServerRows`: `toggleable` is false when `s.connector !== null`)
- Test: `zumi-bot-server/frontend/tests/connectors.test.ts`, plus the existing route/palette/extensions tests the change touches

**Interfaces:**
- Consumes: Task 1's types and `CONNECTOR_TEXT`, `connectorById`; `type StatusTone` from `state/extensionsPage.ts`.
- Produces:
  ```ts
  export interface CardModel {
    id: ConnectorId; name: string; blurb: string
    label: string; tone: StatusTone; hint: string | null
    action: { label: 'Connect' | 'Reconnect' | 'Manage on claude.ai'; href: string }
    customUrl: string | null; onText: string; unknownText: string | null
  }
  export function cardModel(card: ConnectorCardView): CardModel
  export function switchRows(view: ConnectorsView, id: ConnectorId): Array<{ agent: string; on: boolean }>   // Claude agents only
  export function withSwitch(view: ConnectorsView, id: ConnectorId, agent: string, on: boolean): ConnectorsView  // optimistic flip
  export const REFRESH_GAP_MS = 5000
  export function shouldRefresh(lastAt: number | null, now: number): boolean   // null or ≥ REFRESH_GAP_MS ago
  ```
  Tones: connected `ok`, needs-attention `warn`, not-connected `idle`, off-in-claude-code `idle`, unknown `idle`. Hint: needs-attention → `needsAttention`, not-connected → `notConnected`, off-in-claude-code → `offInClaudeCode`, else null. Action: not-connected → Connect, needs-attention → Reconnect, else Manage on claude.ai; `href` = `connectUrl`. `unknownText` = `CONNECTOR_TEXT.unknown(list)` when the list is non-empty.

- [ ] **Step 1: Failing tests:** `cardModel` for each state (label, tone, hint, action label, `href` exactly the catalog's `connectUrl`); GitHub's `customUrl` is `https://api.githubcopilot.com/mcp/`, others null; `onText` both forms; `switchRows` leaves out Codex agents and keeps name order; `withSwitch` adds and removes without touching other cards; `shouldRefresh(null, 0)` true, `(1000, 5999)` false, `(1000, 6000)` true; `agentServerRows` gives `toggleable: false` for a row with `connector: 'gmail'`; route `settingsFromPath('/settings/connectors')` → `'connectors'`; the palette lists Connectors for the query `gmail`.
- [ ] **Step 2:** `npx vitest run --project frontend` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; `npm run typecheck` PASS.

### Task 8: The Connectors page and the links between pages

**Files:**
- Create: `zumi-bot-server/frontend/src/components/ConnectorsSettings.tsx`
- Modify: `zumi-bot-server/frontend/src/components/Settings.tsx` (`PageProps.onSection`; render `<ConnectorsSettings agents onSection />` for `'connectors'`; pass `onOpenConnectors` to `ExtensionsSettings`)
- Modify: `zumi-bot-server/frontend/src/components/ExtensionsSettings.tsx` (prop `onOpenConnectors: () => void`; one hint line at the top of the Servers tab with `CONNECTOR_TEXT.toConnectors` and a link button, `data-testid="ext-connectors-link"`)
- Modify: `zumi-bot-server/frontend/src/components/AgentLoadout.tsx` (export `Switch`; prop `onOpenConnectors?: () => void`; a `ServerLine` with `r.connector` shows a link button `CONNECTOR_TEXT.agentRow`, `data-testid="agent-ext-connector-link"`, instead of a switch)
- Modify: `zumi-bot-server/frontend/src/components/AgentEditor.tsx` (pass `onOpenConnectors` through), `zumi-bot-server/frontend/src/App.tsx` (`onSection={(s) => openSettings(s)}` on `SettingsPage`, `onOpenConnectors={() => openSettings('connectors')}` on `AgentEditor`)
- Modify: the stylesheet that holds `.ext-row` (reuse its classes; add only what the cards need)

**Interfaces:**
- Consumes: `api.connectors.*` (Task 6), Task 7's rules, `Switch`.
- Produces: the page, with `data-testid`s the e2e uses: `connectors-page`, `connector-card` (`data-id`, `data-state`), `connector-action`, `connector-copy`, `connector-switch` (`data-agent`, `data-on`), `connector-keyvar`, `connector-migration`, `connector-error`, `connector-unknown`, `connectors-to-claude-code`.

Behaviour: on mount `list(false)`; `onChanged` → `list(false)`; `window` `focus` and `document` `visibilitychange` to visible → `list(true)` when `shouldRefresh(lastAt, Date.now())`. Notices on top, in this order: key variable (`CONNECTOR_TEXT.keyVar`), `running` or `migrationFailed`, `error`. Then `intro`, `machines`, `codex` (when any Codex agent), `zumiBot`. One card per catalog entry: name, state chip, blurb, hint, unknown-tools note, the action as `<a href target="_blank" rel="noreferrer">` (the desktop shell opens it in the system browser), GitHub's URL in `<code>` with a Copy button (`navigator.clipboard.writeText`), `onText`, then one `Switch` per `switchRows` row, disabled while `migration === 'running'` or a flip is in flight. A flip calls `withSwitch` first, then `setAgent`; a rejection reloads the list and shows the error sentence. A footer button `CONNECTOR_TEXT.toClaudeCode` calls `onSection('claude-code')`. No logic beyond wiring: anything with a rule goes in `state/connectors.ts`.

- [ ] **Step 1:** Build it. (No component tests exist in this repo; the e2e in Task 10 covers it.)
- [ ] **Step 2:** `npm run typecheck` and `npm run build:server` PASS.

### Task 9: Sync

**Files:**
- Modify: `zumi-bot-server/deploy/sync.mjs` (`NEWEST_WINS` gains `'connectors.json'`; the push `sources` list and the VPS swap's `for f in …` list gain it)
- Test: `zumi-bot-server/backend/tests/sync.test.ts` (follow whatever it already checks for `settings.json`; if it checks no file list, add none)

- [ ] **Step 1:** Add the failing case if `sync.test.ts` covers the lists; run it — FAIL.
- [ ] **Step 2:** Edit `sync.mjs`.
- [ ] **Step 3:** PASS.

### Task 10: E2E suite, harness seed and the real-CLI probe

**Files:**
- Modify: `zumi-bot-server/e2e/harness.mjs` (`start({ …, connectors = { v: 1, agents: {}, migration: 'kept' } })`: before the server starts, write it as `<dataDir>/connectors.json` (0600) unless the file exists; `connectors: null` writes nothing)
- Modify: `zumi-bot-server/e2e/extensions.e2e.mjs` (pass `connectors: { v: 1, agents: { [AGENT]: <all seven ids> }, migration: 'kept' }`, so its exact deny and belt assertions hold)
- Create: `zumi-bot-server/e2e/connectors.e2e.mjs`; script `"e2e:connectors": "npm run build && node zumi-bot-server/e2e/connectors.e2e.mjs"` in the root `package.json`
- Create: `zumi-bot-server/e2e/connectorsProbe.mjs`; script `"e2e:connectors-probe": "node zumi-bot-server/e2e/connectorsProbe.mjs"`; export `listings` from `e2e/extensionsProbe.mjs` (and declare it in `extensionsProbe.d.mts`)

**connectors.e2e.mjs** (fake `fake-extensions-claude.mjs` with `FAKE_EXT_ALLOW_TURN`, harness `connectors: null`, throwaway HOME; header comment lists what is covered, like `extensions.e2e.mjs`). Fake state `mcpServers`: `claude.ai Gmail` connected, `config: { type: 'claudeai-proxy', url: 'https://gmailmcp.googleapis.com/mcp/v1', id: 'mcpsrv_1' }`, tools `search_threads`, `send_message`, `brand_new`; `claude.ai Notion` needs-auth (`https://mcp.notion.com/mcp`); `claude.ai Slack (2)` connected (`https://mcp.slack.com/mcp`); `My GitHub` connected (`https://api.githubcopilot.com/mcp/`); `claude.ai Fake Drive` connected (`https://example.invalid/mcp`). Agents seeded on disk: `conn-agent` (serversOff `['claude.ai Notion']`), `conn-codex` (provider codex). Numbered checks, each `pass(...)`:
1. Switch-over: `connectors.json` appears with `agents: { 'conn-agent': ['gmail', 'github', 'slack'] }`, `migration: 'kept'`, mode `0600`.
2. Ctrl+K "gmail" lists Connectors and opens `/settings/connectors`; 7 cards; `data-state`: gmail connected, notion needs-attention, slack connected, github connected, google-drive not-connected; Gmail shows `brand_new` as unknown; Drive's action `href` is its directory URL; GitHub's Copy shows `https://api.githubcopilot.com/mcp/`; `conn-codex` has no switch and the Codex sentence shows.
3. Switches: turn Notion on and Gmail off for `conn-agent` → the file follows; a second tab sees the change (`connectors:changed`).
4. The run: a chat turn to `conn-agent` → its argv's one `--settings` has `{serverUrl}` entries for gmail, google-calendar, google-drive, linear and none for notion, github, slack; `--disallowedTools` has `mcp__claude_ai_Gmail` and not `mcp__claude_ai_Notion`; `permissions.deny` has `Edit(/<dataDir>/connectors.json)`.
5. Refresh on return: change the fake state so Drive is connected (`https://drivemcp.googleapis.com/mcp/v1`), fire `visibilitychange` → Drive's card turns connected.
6. Links: Agent Studio for `conn-agent` shows `agent-ext-connector-link` on the Gmail row and no switch there; clicking it opens the Connectors page. Settings › Claude Code's Servers tab has `ext-connectors-link`.
7. Key variable: restart with `ANTHROPIC_API_KEY: 'sk-e2e-not-a-real-key'` in the server env → `connector-keyvar` names `ANTHROPIC_API_KEY`; the page text, `connectors.json` and the server log never contain `sk-e2e-not-a-real-key`.
8. Switch-over failure: a fresh data dir and `FAKE_EXT_ERROR_SUBTYPES: 'mcp_status'` → `migration: 'failed'`, every agent off, `connector-migration` shows the failure sentence.
End with `unexpectedErrors()` empty, as the other suites do.

**connectorsProbe.mjs** (real CLI, the user's own `HOME`, `--soft` by default, prints PASS / FAILED / INCONCLUSIVE per check, never prints a token or a full URL beyond its host): (a) a plain `listings` run lists `claude.ai …` servers; print each one's name, status, `config.url` host and `connectorOf` id — this settles which Gmail and Calendar hosts the account gets; (b) a run with `deniedMcpServers: [{ serverUrl: <its catalog pattern> }]` for the first connected catalog connector no longer lists it; (c) the same with `{ serverName }`. INCONCLUSIVE when no catalog connector is connected.

- [ ] **Step 1:** Harness option and the `extensions.e2e.mjs` seed; `npm run e2e:extensions` PASS.
- [ ] **Step 2:** Write `connectors.e2e.mjs`; `npm run e2e:connectors` PASS.
- [ ] **Step 3:** Write `connectorsProbe.mjs`. Do not run it: Task 12 asks the user first.

### Task 11: Docs

**Files:**
- Modify: `docs/architecture/connectors.md` — status line: phase 1 built (date, CLI version); a "Built (phase 1)" section naming the files, `connectors.json`'s shape, the switch-over (including the no-agents shortcut and the no-deny window), Zumi Bot always off, the guard (file tools only), what the e2e and the probe cover. Keep phases 2–3 as proposals.
- Modify: `docs/architecture/extensions.md` — `LoadoutServer.connector`; a catalog connector's row in Agent Studio links to the Connectors page instead of a switch; the Servers tab's link; `buildAgentRunConfig`'s `connectorsOff`.
- Modify: `docs/architecture/vault.md` — the main runs' guard settings also deny the file tools on `connectors.json`.
- Modify: `docs/architecture/data.md` — `connectors.json` (0600, per-agent on lists and the switch-over result; synced newest-wins; holds no secret: tokens stay at claude.ai on route A).
- Modify: `docs/architecture/deploy-and-sync.md` — `connectors.json` newest-wins both ways.
- Modify: `docs/architecture/e2e.md` — `e2e:connectors`, `e2e:connectors-probe` (real account, ask first), the harness `connectors` option.
- Modify: `docs/architecture/ui.md` if it lists the Settings sections (`grep -n claude-code docs/architecture/ui.md`).
- Modify: `CLAUDE.md` — the Connectors index line only: `- [Connectors](docs/architecture/connectors.md): `core/connectors/`, `shared/src/connectors.ts`, `ConnectorsSettings.tsx`, `state/connectors.ts``.

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** `npx vitest run zumi-bot-server/shared/tests/repoDocs.test.ts` PASS (size and index).

### Task 12: Verify, then stop for review

- [ ] **Step 1:** `npm test` — all pass.
- [ ] **Step 2:** `npm run typecheck` — clean.
- [ ] **Step 3:** `npm run build:server` — succeeds.
- [ ] **Step 4:** `npm run e2e:connectors` and `npm run e2e:extensions` — PASS.
- [ ] **Step 5:** Ask the user before anything touches their claude.ai account: (a) `npm run e2e:connectors-probe`, which lists their connectors with the real CLI; (b) `npm run dev` and opening Settings › Connectors to check one real service (Slack, connected today) shows Connected, then turning it on for one agent. Run only what they say yes to.
- [ ] **Step 6:** Report: what changed, what could not be verified, and for each catalog service whether it works on route A, route B or neither. Then stop for review.
