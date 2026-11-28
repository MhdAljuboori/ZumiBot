# Agents-only sync by default

Date: 2026-11-28. Area: [Deploy and sync](../../architecture/deploy-and-sync.md).

## Intent

The user runs ZumiBot on this PC (Local mode) and on a VPS and keeps **chats separate per machine** on purpose. Today every
sync joins chats and copies `~/.claude/projects` (the CLI session logs, 4.9 GB here), which makes it slow, stops the local
app and restarts the VPS. What they want kept the same on both machines is their **Claude setup**: agents, agent memory,
skills, plugins and the global `CLAUDE.md`.

So sync gets two modes:

- **Plain sync (the default):** the Claude setup only. Fast, touches no ZumiBot data, restarts nothing.
- **Full sync:** today's sync, unchanged, plus the plugin installs. Chosen with a **Sync with chats and projects** checkbox in
  the desktop Sync window (unticked every time the window opens), or `--with-chats` on the CLI.

## Goals

- A plain sync copies `~/.claude/agents`, `~/.claude/skills`, `~/.claude/agent-memory` and `~/.claude/CLAUDE.md` both ways,
  exactly as the full sync does today (rsync `--update`, the same excludes, overwritten files kept in the backup folder).
- A plain sync installs plugins found on one side only on the other side (see Plugins).
- A plain sync reads and writes nothing in either machine's ZumiBot data folder (`~/.local/share/zumibot`), so it does not
  check running replies on either side, does not stop or restart the local server, and does not restart the VPS service.
- A full sync behaves exactly as today, and also does the plugin installs instead of only reporting them.
- The checkbox reads **Sync with chats and projects** and starts unticked each time the Sync window opens.

## Non-goals

- No new per-item choice (no "sync vault only" etc.). Two modes only.
- `~/.claude/settings.json` stays report-only in both modes (its hooks and permissions hold machine paths).
- Remembered approvals stay unsynced, as today.
- No plugin removal, upgrade, version matching or enabled-state matching: a plugin installed on both sides is left alone,
  whatever its version and whether it is on or off on either side.

## Anti-goals (a failure even if it works)

- A plain sync that stops the local app, restarts the VPS, or refuses because a reply is running.
- A plain sync that copies any chat, session log or other per-machine data.
- Auto-accepting a plugin's marketplace-declared command on the user's behalf (never pass `-y` or `--accept-command`).
- The checkbox remembering a ticked state between openings.

## What goes where

| Plain sync (box off) | Full sync only (box ticked) |
| --- | --- |
| `~/.claude/agents`, `skills`, `agent-memory`, `CLAUDE.md` | `chats.json`, `chats/` (items, versions, side questions, per-chat to-dos, dispatch, AG-UI threads), attachments, file snapshots, `sidebar.json` |
| Plugin installs, both ways | `~/.claude/projects`, `~/.claude/file-history`, `~/.claude/history.jsonl` |
| `~/.claude/settings.json` difference report | usage (`usage.json`, `usage-records.jsonl`), `todos.json`, `workflow-messages.json` |
| | `vault.json` and the vault key, `connectors.json` |
| | routines, workflows, their `history/`, run files, `channels.json` |
| | ZumiBot `settings.json` |

Full sync is everything in both columns.

**Why the vault and connector switches are full-only (decided by the user):** the running server holds both in memory
(`VaultStore`, `ConnectorStore`), so pushing them needs today's stop-and-restart path, which the plain sync exists to avoid.
They change rarely.

**Why no restart is needed for the plain set:** the server watches the agents folder; the CLI reads skills, memory and
`CLAUDE.md` on each run; agent memory's `MEMORY.md` index is repaired on list, on create and at the start of each reply.

## Approaches

1. **One `sync()` with a `chats` option; the Claude-setup part extracted into a function both modes call** (picked). Plain mode
   returns after that part; full mode runs today's flow, which calls the same function where it now syncs `CLAUDE_DIRS`,
   `CLAUDE.md` and reports plugins.
2. A separate script for the plain sync. Rejected: the desktop build copies named sync files into `resources/sync`, and the two
   modes share the Claude-setup code, so a second file only adds packaging and duplication.
3. Remember the checkbox. Rejected: the user asked for off by default.

## Design (decided)

### `zumi-bot-server/deploy/sync.mjs`

- `sync({ env, chats = false, ... })`. `chats: true` is today's full sync.
- **Plain mode steps:**
  1. Same `VPS_HOST`/`VPS_USER`/`VPS_DIR` checks as today (`VPS_DIR` is not used in plain mode but is still validated, so a bad
     file fails the same way in both modes).
  2. No running-reply check (VPS or local), no background-process warning, no `server.lock` check.
  3. Read the remote home (`printf %s "$HOME"`) as today.
  4. Backup folders `~/zumibot-sync-backup-<time>/` on both sides, made 0700 as today, holding only `agents` and `CLAUDE.md`
     up front (no `zumibot-data`, no `history.jsonl`). rsync's `--backup-dir=<bk>/<dir>-overwritten` keeps overwritten files as
     today.
  5. rsync `agents`, `skills`, `agent-memory` both ways with today's per-dir excludes and `--update`, then `CLAUDE.md` both ways.
  6. Plugins (below).
  7. The `~/.claude/settings.json` difference line, as today.
  8. Last line: `Synced agents, skills, agent memory and plugins. Backups: <bk> (this PC), <rbk> (VPS).` Exit 0.
- **Full mode:** today's flow unchanged, except its Claude-setup steps (the `CLAUDE_DIRS` loop, `CLAUDE.md`, the plugin report)
  are the shared function, and `projects` and `file-history` stay in its rsync list. The shared function takes the list of
  `~/.claude` dirs, so full mode passes all five and plain mode passes three.
- **CLI:** `node sync.mjs --with-chats` (so `npm run sync -- --with-chats`) sets `chats: true`; without it the CLI runs a plain
  sync. Any other argument is refused with a usage line and exit 1, so a typo never silently runs the wrong mode.

### Plugins (both modes)

- Read `plugins/installed_plugins.json` and `plugins/known_marketplaces.json` under `~/.claude` on each side (remote over ssh
  `cat`, as the report does today). A plugin id is `name@marketplace` (the keys of `plugins`).
- For each id on one side only, install it on the other side:
  1. If that side does not know the marketplace, add it from the source the first side records: `{source: 'github', repo}` →
     `claude plugin marketplace add <repo>`, `{source: 'git', url}` → `claude plugin marketplace add <url>`. Any other source
     (a local directory or file) is machine-specific: skip the plugin and log it.
  2. `claude plugin install <name>@<marketplace>` (user scope, the default). Never `-y`, never `--accept-command`.
- **Only plugins that are on are copied (decided by the user).** A plugin is on when that side's `~/.claude/settings.json`
  has `enabledPlugins[id] === true`; `false` or no entry means off (an off plugin is never switched on anywhere). Only the
  `enabledPlugins` key is read from that file: it can hold hooks, env and other values, which are never logged, copied or
  passed on. Its ids pass the same strict pattern. A side that has the id installed, on or off, counts as having it, so a
  plugin turned off on one machine stays off there and is not installed again.
- **Scope (builder's call, marked):** only `scope: "user"` entries are copied; project and local entries carry a
  `projectPath` that only means something on their machine, so they are skipped with a log line. A side that has the id at
  any scope counts as having it, so nothing is installed twice.
- **Marketplace not on record (builder's call, marked):** an id whose marketplace is missing from the source side's
  `known_marketplaces.json` (for example `cc-plugin-you-should-know@builtin`) is skipped with a log line.
- **Uninstalls come back (builder's call, marked):** with no record of earlier syncs, a plugin removed on one machine and
  still on (and turned on) on the other is installed again next sync, as deleted agents and memories come back today. The
  user docs say so, and give the way to keep a plugin off one machine: leave it installed there and turn it off.
- A failed add or install (non-zero exit, including a plugin that needs a person to accept its command) never fails the sync:
  log `Plugin <id> could not be installed on <the VPS|this PC>: <first stderr line>. To add it there: claude plugin install <id>`
  and go on. A success logs `Installed plugin <id> on <side>.`
- Remote commands run through the user's login shell so `claude` is on `PATH` (the VPS installs it under `~/.local/bin`);
  arguments are quoted with `shq`. The ids and repos come from the other machine's files, so they must pass a strict pattern
  (letters, digits, `.`, `_`, `-`, `/`, `@`, `:` for URLs) before they reach any command line; anything else is skipped and
  logged.
- Locally the sync runs `claude` through the injected `run`, so tests can fake it. Where the desktop worker's `PATH` lacks
  `claude`, the sync must still find it (see Left to the builder).

### Desktop shell

- `src/pages/sync.html`: a checkbox labelled **Sync with chats and projects** above the buttons, unticked on load, disabled
  while a sync runs. The description paragraph changes to:
  "Merge agents, skills, agent memory and plugins in both directions, with backups. Nothing restarts."
  and, under the checkbox, a hint:
  "Also merges chats, projects, the vault and automations. The VPS restarts, and active replies must finish first."
- `src/pages/sync.js`: `api.start({ chats: box.checked })`.
- `src/preload/index.ts`: `start: (o) => ipcRenderer.invoke('sync:start', { chats: o?.chats === true })`.
- `src/main/syncDesktop.ts`: `sync:start` reads only `chats === true` from the renderer (config still never comes from a
  renderer). The confirm dialog (first sync, or a start from the browser link) names the mode:
  - plain: message `Sync agents, skills, memory and plugins with <user>@<host>?`, detail
    `They will be merged in both directions, with backups. Chats stay on each machine. Nothing restarts.`
  - full: today's message and detail.
  The log's first line names the mode: `Syncing agents, skills, memory and plugins with …` or today's line for full.
  `runSyncProcess` passes `chats` to the worker, and `src/sync/runner.mjs` passes it to `sync()`.
- `src/main/syncFlow.ts`: `run(chats)`. Plain mode still runs `prepare` and the unsaved-edits prompt (an agent being edited is
  an agent file), then `execute` directly: no `busy()`, no `pause()`, no `restore()`. Full mode is unchanged. Final lines stay
  `Sync complete.` / `Sync failed: …`.

### Frontend

- `Settings.tsx` sync row hint (desktop case) becomes:
  "Copies agents, skills, agent memory and plugins both ways. Tick Sync with chats and projects in the Sync window to also copy
  chats; the app then reconnects when it finishes." (Today's hint wrongly says `~/.zumi`.)

### Docs

- `docs/architecture/deploy-and-sync.md`: the two modes, what each copies, plugin installs, plain mode's no-restart rule.
- `zumi-bot-docs/src/content/docs/desktop/sync.mdx`: the checkbox, the two modes, plugins installed rather than reported, and
  which steps (no replies running, the restart) apply to the full sync only. No file names or internal paths.
- `CHANGELOG.md`: a line under the next version's section if one is open, else left for the next `bump:*`.

## Tests (decided)

- `backend/tests/sync.test.ts`: existing tests call `go(..., { chats: true })` (or equivalent) and keep passing unchanged.
  New plain-mode tests: agents, skills, agent memory and `CLAUDE.md` merge both ways; `projects`, `file-history`,
  `history.jsonl` and the whole ZumiBot data folder are untouched on both sides; no `systemctl` call, no `zumibot-server busy`
  call; a running local server (`server.lock` alive) does not block it; plugin install calls for a plugin on one side only,
  a marketplace added first when missing, a non-github/git source skipped, a plugin turned off (or with no
  `enabledPlugins` entry) on its side never installed, a non-user-scope entry skipped, a failed install logged without
  failing the sync, an id with forbidden characters never reaching a command; CLI argument parsing (`--with-chats`, unknown argument refused).
- `zumi-bot-desktop/tests/syncFlow.test.ts`: plain mode skips `busy`, `pause` and `restore` but still asks about unsaved edits;
  full mode unchanged.
- `zumi-bot-desktop/e2e/sync.e2e.mjs`: runs a plain sync by default; keep (or add) a run with the box ticked.

## Left to the builder

- How the sync finds a local `claude` binary when the desktop worker's `PATH` lacks it (for example the user's login shell's
  `command -v claude`, or the same places `claudeLocator.ts` looks), as long as `sync.mjs` stays plain Node with no bundled
  dependencies and `run` stays the one injection point.
- How the remote login shell is invoked (`bash -lc`, `$SHELL -lc`), and a timeout for each plugin command so a stuck network
  install cannot stall the sync forever.
- The exact shape of the shared Claude-setup function and its log lines, within the wording above.
- Whether plugin installs run before or after `CLAUDE.md` (any order after the rsyncs is fine).
