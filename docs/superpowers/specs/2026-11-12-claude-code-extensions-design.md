# Servers, plugins, skills and hooks: see and manage what agents load

Date: 2026-11-12. Status: design, approved for planning once the user signs off.

## Why

ZumiBot has no page for MCP servers, skills or hooks. Agent Studio edits the agent file but never shows what the agent
will actually load when it runs, and that is not what the file says: the CLI adds the user's MCP servers, the project's
`.mcp.json`, every enabled plugin's servers, skills and hooks, the user's and the project's skills, the claude.ai
connectors and every hook in the settings files, while an agent file's own `mcpServers:` and `hooks:` keys are ignored
when the agent runs as the main agent (`--agent`), which is how ZumiBot runs it. The user wants to see the truth, change
it globally, and change it per agent.

## Goals

1. **See what loads.** For any folder, and for any agent in any folder: every MCP server (status, where it comes from, its
   tools), every plugin, every skill (where it comes from, its token cost, on or off) and every hook (event, matcher,
   command, where it comes from), plus what ZumiBot itself adds to a run. The answer comes from the CLI, not from reading
   files, so it is what a run really gets.
2. **Manage globally** (the user's own Claude Code config on the machine the server runs on):
   - MCP servers: add, edit, remove, in user, local (one folder) or project (`.mcp.json`) scope.
   - Plugins: enable, disable.
   - Skills: create, edit, delete the user's and a project's own skills; turn any skill off or on.
   - Hooks: add, edit, remove command hooks in user, project or local settings.
3. **Manage per agent.** Everything is on by default (the user's answer): a new server, plugin or skill reaches every agent
   unless the agent turned it off. Per agent the user can turn a server, a skill or a plugin off (and a globally disabled
   plugin on), and give the agent its own MCP servers and its own hooks.
4. Codex agents get the same "what loads" view, read-only.

## Non-goals

- Installing or uninstalling plugins, adding or removing marketplaces (the terminal's `claude plugin install` stays the way).
- Signing in to an MCP server that needs auth, or managing claude.ai connectors (claude.ai's own settings do that). The row
  says how (`claude mcp login <name>` in a terminal, or claude.ai › Settings › Connectors).
- Turning one hook from the user's global settings off for one agent: the CLI has no per-hook switch, only the whole plugin
  that adds it (verified).
- Approving or denying a project's `.mcp.json` servers (shown as pending approval, with the CLI's own wording).
- Editing a Codex agent's or Codex's own config (`~/.codex/config.toml`).
- Zumi Bot: its file is written by the server, so its card is view only.
- Letting Zumi Bot (the agent) change any of this through its tools.
- Syncing what `npm run sync` does not already sync (see Sync).

## Anti-goals (a failure even if it works; my framing, from the project's existing rules)

- Showing a server, skill or hook as loaded when a run would not load it, or the other way round.
- A secret (an env value, a header value, an OAuth token) reaching the UI, a log, an error or a URL.
- Breaking the prompt cache between an agent's main run and its side questions, Compact or keep-warm pings.
- Any per-agent setting weakening ZumiBot's own guards (the pause hook, the vault guard, the side-run tool guard, the
  desktop ask rules, Zumi Bot's deny rules).
- Losing a line of the user's `settings.json`, `.mcp.json` or `~/.claude.json` that the page did not mean to change.

## What the CLI tells us (verified on 2.1.322, no model call)

A `claude -p --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio
[--agent <name>]` process started in a folder answers these control requests before any user message, so no quota is used:

| Request | Answer |
|---|---|
| `initialize` | `commands`, `agents`, `claude_code_version`, and things we must drop (`account`, `models`, ...) |
| `mcp_status` | `mcpServers[]`: `name` (`github`, `plugin:playwright:playwright`, `claude.ai Gmail`), `status` (`connected`, `needs-auth`, `failed`, `pending`, ...), `transport`, `scope` (`user`, `local`, `project`, `dynamic`, `claudeai`), `source` (`plugin`, `claudeai`, ...), `config` (holds env and headers: never passed on), `serverInfo`, `tools[]` (name, annotations) |
| `get_skills_dialog` | `skills[]`: `name`, `display_name`, `description`, `source` (`user`, `project`, `plugin`, `claude.ai sync`, ...), `tokens`, `state` (`on`/`off`), `advertised` |
| `get_hooks_listing` | `hooks[]`: `event`, `matcher`, `source` (`userSettings`, `projectSettings`, `localSettings`, `flagSettings`, `pluginHook`, ...), `sourceLabel`, `pluginName`, `type`, `commandText`, `timeout` |
| `get_settings` | `effective` settings and each source's own (used for `enabledPlugins` and `skillOverrides`) |

Servers connect in the background: `mcp_status` is asked until no server is `pending`, or 15 s pass (then the pending ones
show as "still connecting").

What one run's `--settings` can change (verified): `enabledPlugins` turns a plugin off, or a globally disabled one on, for
that run (its skills, servers and hooks follow); `skillOverrides: {"<name>": "off"}` turns a skill off for that run; `hooks`
adds hooks (listed with source `flagSettings`); `deniedMcpServers: [{"serverName": "<full name>"}]` keeps a server from
loading at all (verified for `plugin:playwright:playwright` and `claude.ai Gmail`: gone from `mcp_status`, no process, so
no tools and no server instructions; a short name such as `chrome-devtools` matches nothing; the CLI prints "blocked by
enterprise policy" for a claude.ai one on stderr). `--disallowedTools mcp__<server>` is a deny rule (`cliArg`) that removes
the server's tools from the model's tool list while it still connects (see Checks made).

These control requests are not a documented API. Every feature here degrades to a fixed sentence ("This Claude Code
version does not report MCP servers") when a request fails or its answer has an unexpected shape, and `npm run e2e` gains
a probe that fails loudly when one disappears.

Starting the CLI runs the user's `SessionStart` hooks (and `SessionEnd` at exit), as any session does; their output is
dropped. The probe passes `--no-session-persistence`, so no session log is written.

## Per-agent settings: where they live and how a run gets them

### Agent file keys

ZumiBot-only keys, like `icon` and `computerUse` (the CLI ignores unknown keys; flat, absent = nothing changed):

```yaml
serversOff:            # servers this agent does not get, by the name the CLI lists
  - claude.ai Gmail
  - plugin:playwright:playwright
skillsOff:             # skills this agent does not get, by skill name
  - apple-design
plugins:               # per-agent plugin overrides; absent plugin = its global state
  caveman@caveman: false
  frontend-design@claude-plugins-official: true
```

And two keys the CLI itself defines for subagents, which ZumiBot now also applies to the agent's own runs:

```yaml
mcpServers:            # the agent's own servers (CLI subagent format)
  - my-db:
      command: node
      args: [server.js]
      env: { DB_URL: "..." }
hooks:                 # the agent's own hooks (settings.json hooks format)
  PreToolUse:
    - matcher: Bash
      hooks:
        - type: command
          command: ./check.sh
```

`mcpServers` entries that are a bare name (a reference to an already configured server) are kept as written and shown as
"already loaded"; only inline definitions are added to the run. A name starting with `zumibot_` is refused (ZumiBot's
own bridges use that prefix), and one equal to a server the agent already loads is flagged in the card.

### Secrets of an agent's own servers come from the Vault (the user's choice)

A value in an inline server's `env` or `headers` may hold `${vault:<ENV_NAME>}`, where `<ENV_NAME>` is the env name of a
Vault API key granted to this agent (several references and text around them are fine: `Bearer ${vault:GITHUB_TOKEN}`).
The agent file then holds only the key's env name, so the Raw view, sync and any agent reading `~/.claude/agents` see no
secret. A plain value still works (the CLI's own format); the form marks it "Stored as plain text in the agent file".

At spawn ZumiBot rewrites each reference to `${ZUMIBOT_MCP_VAULT_<n>}` in the generated `--mcp-config` JSON and puts
the value under that env name in the run's env; the CLI expands it when it starts the server (verified, model-free, for
`args` and `env` of an inline `--mcp-config`). So the value is never in argv, a file, a log or the page. Every run that
carries the agent's servers (main, room member, routine, workflow steps, A→B, Compact, side question, keep-warm ping, the
probe) gets them the same way, so the server set, its tools and the cache prefix are the same in all of them. This is the
one place a Vault value reaches a side run or a Compact: the side guard still blocks every tool there, and the value is
one the agent's main runs already hold in their env. The values join the run's scrub map like the agent's API keys, so an
echo becomes `[vault: <name>]`.

A reference that cannot be filled (no granted key with that env name, a vault in `keyMissing` or `keyMismatch`) leaves
that one server out of every run of the agent, alike in all of them, and the card says why in a fixed sentence ("Not
started: no Vault key GITHUB_TOKEN is granted to this agent"). The agent file is never changed. Two granted keys with one
env name (only a sync join can make that) take the last in name order, as the env does.

In Agent Studio each env and header value has a **From Vault** picker listing the API keys granted to this agent (name
and env name, never a value); picking writes the reference. Global servers (user, local, project scope) are the CLI's own
files, which `claude` in a terminal reads too, so they take no Vault references (a non-goal). `hooks` takes only what settings.json takes; anything the
parser does not understand is kept in the file and not applied (and the card says so).

Saving goes through Agent Studio's normal Save and `serializeAgent`, which rewrites only keys that changed (as it does for
`tools`). The keys parse into `AgentFields` (`serversOff`, `skillsOff`, `plugins`, `mcpServers`, `hooks`; null when absent).

### What a run gets

`disallowedToolsFor(agent)` in `app.ts` (today only Zumi Bot's deny rules) becomes the one per-agent hook, extended to
also return the agent's settings and MCP config. For a Claude agent, every run of it (single chat, room member, routine,
workflow Agent and For each steps, A→B asked run, Compact, side question, keep-warm ping) gets:

- for each `serversOff` entry, `deniedMcpServers: [{"serverName": "<name as listed>"}]` in the run's settings object, so
  the server never loads for this agent (an "Off" row is then true: no process, no instructions, no tools), and, as a belt
  in case a CLI update stops honouring that key outside managed settings, `--disallowedTools mcp__<normalized server name>`
  (every character outside `[A-Za-z0-9_-]` becomes `_`: `claude.ai Gmail` → `mcp__claude_ai_Gmail`,
  `plugin:playwright:playwright` → `mcp__plugin_playwright_playwright`). The probe check (Testing) fails loudly if a denied
  server still loads.
- one `--settings` object with `deniedMcpServers` from `serversOff`, `enabledPlugins` from `plugins`, `skillOverrides`
  (`"off"`) from `skillsOff`, and `hooks` from the agent's `hooks`, merged by `oneSettings` into the run's one `--settings`
  (lists add up, so ZumiBot's own hooks and deny rules always stay; the generated object never holds any other key, so an
  agent file can never set `disableAllHooks`, permissions or anything else).
- one `--mcp-config` with the agent's inline `mcpServers`, after ZumiBot's own bridges.

These go into the turn spec's base (`extraArgs`, `disallowedTools`), so the side base copies them and `baseFor` builds
them for a fresh side base: a side answer, a Compact and a keep-warm ping see the same skills, plugins and tools as the
main run and the cache prefix holds. The side guard still blocks every tool in a side run; the agent's hooks ride there
too, as the user's global hooks already do, so a `SessionStart` hook's added context is the same on both.

An agent's own hooks have exactly the power of the user's global hooks, nothing less and nothing more (my call, accepted
as a limit): a `PreToolUse` hook that prints an allow decision, or a `PermissionRequest` hook, can approve a call before
ZumiBot's card shows, as a global hook already can. Whoever can write an agent file can write `~/.claude/settings.json`
too, so this opens nothing new. Zumi Bot, `/make-friendly` and the automations tools never write `serversOff`,
`skillsOff`, `plugins`, `mcpServers` or `hooks`, and keep them as they are when they edit an agent.

Read per attempt, like `compactWindow`, so a Save applies from the next run. A change to an agent's set changes its tool
list or skill list: its next message writes the whole context to the cache again at full price, once. The card says so
next to Save.

Rooms: each member gets its own agent's set. The moderator, the room summary, workflow LLM and Condition steps and every
other bare `claude -p` call keep `--setting-sources '' --strict-mcp-config` and get none of this.

Codex agents get none of it (the card is read-only for them); a Codex agent file with these keys runs as before.

## The probe

`ExtensionsProbe` (backend, `core/extensions/`) runs the CLI as above in a folder, optionally as an agent with that agent's
per-agent args (what a run would pass, from the same builder, less the `serversOff` and `skillsOff` parts, so a server or skill the agent turned off
still shows its status, tools and global state and can be switched back on; the card marks it from the agent's list.
`plugins` overrides stay applied: a plugin turned off for the agent has its servers, skills and hooks gone from the probe,
while its plugin row, from `claude plugin list`, stays switchable), asks the four
requests, and kills the process
(stdin closed, then the existing kill ladder). It returns a sanitized `Loadout`:

- servers: name, status, scope, source, transport, plugin id when it came from a plugin, tool names, and for a server the
  user can edit, its file and scope. `mcp_status`'s `config` is dropped whole (it holds env and header values, and its
  `args` come back with every `${VAR}` already expanded, verified); a definition is shown only from its source file
  (`~/.claude.json`, `.mcp.json`, the agent file), unexpanded, with env and header values hidden. Never OAuth state.
- plugins: from `claude plugin list --json` (installed plugins, global state) joined with the effective `enabledPlugins`.
- skills: name, description, source, plugin, tokens, state, file path for user and project skills.
- hooks: event, matcher, type, command text (as the CLI shows it), timeout, source, file, plugin.
- the CLI version, and per-section errors (one section failing leaves the others).

ZumiBot's own additions are a fixed list the server builds from the same facts the runner uses (the browser, to-do,
vault and ask bridges, Zumi Bot's automations bridge, the desktop server for an agent with computer use; the pause hook,
the vault guard, the desktop ask rules), shown in their own "Added by ZumiBot" group, never editable.

Results are cached in memory per (agent or none, folder, the agent file's text hash) and dropped when the page writes
anything (a server, plugin, skill or hook change, an agent save) or the user presses Refresh. At most two probes run at
once server-wide, the rest queue; each has a 30 s deadline. A probe never runs at server start, only when a page asks.

Codex agents: the probe starts `codex app-server --listen stdio://` in the folder (no model, no thread), sends `initialize`,
then `mcpServerStatus/list`, `skills/list {cwds}` and `hooks/list {cwds}` (verified on codex 0.164.0), and kills it; plus
the bridges ZumiBot adds to a Codex run. Plugins are not listed for Codex.

## Global writes

All on the machine the server runs on. Every write is refused while that file changed since the page read it (a stale
check by content hash, the same message style as `VAULT_CHANGED`), so two tabs or a running CLI never lose each other's
edits silently.

- **MCP servers**, user and local scope: through the CLI's own `claude mcp add-json -s <scope> <name> <json>` and
  `claude mcp remove -s <scope> <name>`, run in the chosen folder, because the CLI rewrites `~/.claude.json` all the time
  and a second writer would lose its changes. An edit is a remove then an add; if the add fails, the old definition is
  added back and the error says so. Project scope writes the folder's `.mcp.json` directly (a plain project file the CLI
  does not rewrite), atomically, other servers untouched. Reading a server's definition for its edit form: `~/.claude.json`
  (`mcpServers`, or `projects[<folder>].mcpServers`) and `.mcp.json`, read only. The form shows command, args and URL in
  full and env and header names with their values hidden; a blank value keeps the stored one (the server merges it in, so
  the value never travels to the page and back).
- **Plugins**: `claude plugin enable <id>` / `claude plugin disable <id>` (user scope).
- **Skills**: user skills in `~/.claude/skills/<name>/SKILL.md`, project skills in `<folder>/.claude/skills/<name>/SKILL.md`.
  Create (name, description, body), edit (description and body; other frontmatter keys and the folder's other files kept),
  delete (the whole skill folder to the Trash, as agents are). A skill from a plugin or claude.ai sync is not editable.
  Turning any skill off or on globally writes `skillOverrides` in `~/.claude/settings.json`.
- **Hooks**: the `hooks` key of `~/.claude/settings.json`, `<folder>/.claude/settings.json` or
  `<folder>/.claude/settings.local.json`. Add, edit and remove `type: command` hooks (event, matcher, command, timeout).
  Hooks of another type are shown and kept as written, not editable. Plugin hooks are shown with their plugin and follow
  it.
- Settings files are rewritten as 2-space JSON with only the touched key changed (key order kept), atomically, mode kept.
  A file that does not parse is never written; the page says which file and why.

A write's argv (MCP add) holds the server's env and header values for the moment the CLI command runs: on a shared machine
another user could read them from the process list. Accepted and documented as a limit (the CLI takes no stdin there).

## UI

### Settings › Claude Code (`/settings/claude-code`)

A new Settings section after Vault, in the nav and the command palette (keywords: mcp servers plugins skills hooks
connectors). On top a folder picker (default: the home folder) and Refresh. Four tabs: **Servers**, **Plugins**,
**Skills**, **Hooks** (tab kept in component state). Each lists what loads in that folder, grouped by where it comes from
(User, This folder, Project, Plugin, claude.ai, Added by ZumiBot), with the actions above on the rows that allow them and
an Add button per tab. A row that cannot be changed says where to change it. While a probe runs, a spinner; its errors
per section.

Servers: status dot and label, transport, tool count (expands to the tool names), source. Plugins: switch and what it adds
(counts of skills, servers, hooks from the loadout); no description (the plugin rows show the counts only). Skills: switch (global on/off), tokens, source; a click
opens the editor for an editable one. Hooks: event, matcher, command on one line, source.

### Agent Studio card: "What this agent loads"

Below Tools, for every agent with a file (Zumi Bot view only). A folder picker (default: the agent's last folder,
`lastFolderByAgent`, else home) and Refresh. The same four groups for that agent in that folder, each row with an
**On for this agent** switch (servers, skills and plugins; hooks from global settings have none). A server the agent's
`tools:` list leaves out shows "Not in this agent's tools list". Totals at the top: servers connected, tools, skills on and
their tokens. Two sub-cards: **This agent's own servers** and **This agent's own hooks**, editing `mcpServers` and `hooks`
in the file (same forms as the Settings page).

The switches and sub-cards are part of the form: they mark it dirty, Save writes them, Discard puts them back, and the
unsaved-changes guard covers them. The list shows what the saved agent loads; after a Save the card probes again. A plugin
switched on here shows "Save to see what it adds" until then.

Codex agents: the card shows the Codex view with no switches and a note that per-agent choices are Claude only.

### Pure logic

`frontend/src/state/extensions.ts`: grouping, the effective state of a row from the loadout plus the form's draft lists,
the totals, the `tools:` list check, the server-name normalization (shared with the backend in `shared/src/extensions.ts`).

## RPCs

`extensions:loadout {folder, agent?, refresh?}`, `extensions:serverGet {folder, scope, name}`,
`extensions:serverSave {folder, scope, name, prevName?, def, stamp}`, `extensions:serverRemove {folder, scope, name}`,
`extensions:pluginSet {id, enabled}`, `extensions:skillGet|skillSave|skillRemove|skillSetEnabled`,
`extensions:hookSave|hookRemove {file, ...}`. Every handler checks its arguments as today, refuses a folder that is not an
existing absolute directory, and refuses any path outside the three settings files, `~/.claude/skills` and
`<folder>/.claude/skills`. `extensions:changed` (no payload) is broadcast after a write so open pages refetch.

## Sync

Agent files and `~/.claude/skills` already sync, so per-agent keys and user skills follow. `~/.claude/settings.json`,
`~/.claude.json` and plugins do not (sync only reports a difference); the Settings page says that changes apply to this
machine only.

## Checks made (one real haiku run, $0.01, CLI 2.1.322)

1. `--disallowedTools mcp__plugin_playwright_playwright mcp__claude_ai_Gmail` removed both servers' tools from the
   model's tool list (`init.tools`), while their servers still connected (`init.mcp_servers`).
2. Tool prefix: every character outside `[A-Za-z0-9_-]` becomes `_`: `plugin:chrome-devtools-mcp:chrome-devtools` →
   `mcp__plugin_chrome-devtools-mcp_chrome-devtools__…`, `claude.ai Claude Docs` → `mcp__claude_ai_Claude_Docs__…`.
3. An agent file's inline `mcpServers` server and its `UserPromptSubmit` hook were neither loaded nor run under `--agent`,
   so ZumiBot adding them never doubles them. `e2e/extensionsProbe.mjs` re-checks 1 to 3 after a CLI update (it may
   change).
4. Model-free: `deniedMcpServers` in a run's `--settings` keeps a server (by its full listed name) out of `mcp_status`
   entirely; `disabledMcpServers` there does nothing (it is a per-folder `~/.claude.json` key).
5. Model-free: an inline `--mcp-config` server's `args` and `env` get `${VAR}` expanded from the CLI's own env before the
   server starts, and `mcp_status` then reports the expanded `args`.
6. Left for the build: that a side run's `--no-session-persistence` and its guard behave the same with the per-agent
   `--settings` merged in (expected, since `oneSettings` already merges the desktop ask rules there).

## Testing

- Unit (pure): frontmatter parse and serialize of the five keys (absent, empty, bad shapes kept verbatim), the per-agent
  args builder (never other keys; merged with pause, vault guard and side guard; order; Vault references rewritten to
  env names with no value in argv, an unfillable one dropping only its server, alike for main and side), loadout
  sanitizing (no env or header value and no expanded arg survives), settings file edits (only `hooks`/`skillOverrides` touched, key order kept, stale refused, bad
  JSON never written), skill file edits, the frontend state module.
- Backend: the probe against the fake claude, which gains answers for the four control requests and a `mcp`/`plugin`
  subcommand that logs its argv.
- `e2e:extensions` (fake claude, no quota): the Settings page lists servers, plugins, skills and hooks from the fake;
  adding and removing a server calls the fake `claude mcp`; a skill is created, edited and trashed; a hook is added to a
  temp `settings.json` and other keys survive; in Agent Studio a server, a skill and a plugin are switched off and a hook
  added, Save writes the keys, and the agent's next run (fake invocation log) has the `--disallowedTools`, one merged
  `--settings` with `deniedMcpServers` and ZumiBot's hooks still in it, and a side question's run has the same; an own
  server whose header picks a Vault key gets `${ZUMIBOT_MCP_VAULT_0}` in argv and the value only in the run's env (the
  harness's temp vault), and the key's value is nowhere in the data dir, the server log or the page.
- `npm run e2e` adds `extensionsProbe.mjs --soft` against the real CLI: the four control requests answer with the expected
  shape, a server named in a run's `deniedMcpServers` is absent from `mcp_status`, and `skillOverrides`/`enabledPlugins`
  in `--settings` change the skill and hook lists (all model-free); with `--model-check` it also makes the one haiku run of
  Checks made 1 to 3 (PASS, FAILED, INCONCLUSIVE; `ZUMIBOT_SKIP_EXTENSIONS_PROBE=1` skips it).

## Left to the builder

Component split, styles, icons, exact copy (short, plain), the cache key's exact parts, and the order of work.
