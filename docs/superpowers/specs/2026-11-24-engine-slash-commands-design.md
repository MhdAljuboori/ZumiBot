# Engine slash commands in the `/` menu

## Intent

The composer's `/` menu lists only what ZumiBot offers: `/btw`, `/todo`, `/run-workflow` and the agent's own frontmatter
commands. The user wants the commands of the agent's engine there too: a Claude agent's Claude Code commands (skills,
plugin commands, the user's own commands and the built-ins that act), a Codex agent's Codex commands. Each row ends with
its engine's label (`claude`, `codex`), and they come after ZumiBot's rows.

## Goals

- A single chat (and the new-chat screen) of a Claude agent lists, after ZumiBot's rows, every command `claude` reports for
  that agent in that folder, minus the deny list below, each row labelled `claude`.
- A Codex agent lists its enabled Codex skills the same way, labelled `codex`.
- Picking one inserts `/name ` and sends it so the engine runs it, never an agent command of the same name.

## Non-goals

- Rooms: engine commands are not offered there (a member's turn starts with the thread, so the CLI would never read the
  command first).
- Codex TUI commands (`/review`, `/init`, `/compact`…): app-server has none of them as text; ZumiBot's own Compact stays.
- The routine editor's and card comments' `/` lists: unchanged.

## Anti-goals

- Built-ins that are a screen or a setting ZumiBot already owns (`/model`, `/effort`, `/usage`, `/login`, `/clear`…) must
  not show: they would fight ZumiBot's pickers or do nothing visible.
- No model call, no quota, to build the list.

## Approaches

- **A. Commands-only probe (picked).** Start `claude -p --input-format stream-json … [--agent <name>]
  --no-session-persistence` in the chat's folder with the agent's run config (as a real run: switched-off skills and plugins
  stay off), send the `initialize` control request, keep its `commands` (`name`, `description`, `argumentHint`, `builtin`),
  end the process group. No MCP wait: about 1–2 s, once. Codex: `codex app-server`, `initialize`, `skills/list`.
- B. Reuse the full loadout probe: same data, but it waits up to 15 s for MCP servers. Too slow for a menu.
- C. Read skills, commands and plugin folders from disk plus a fixed built-in list: no spawn, but re-does the CLI's
  discovery and misses what the agent switched off.

The user picked A.

## Design

**Probe and cache (server).** `probe.ts` gets a commands-only mode beside the loadout one: Claude sends `initialize` and
nothing else; Codex sends `initialize` then `skills/list` (asked again until two answers agree, as the loadout probe does).
A sanitizer reads each answer defensively from an allow-list: Claude rows `{name, description, argumentHint}`; Codex rows
`{name, description}` of enabled skills, with the skill's `path` kept server-side only. `ExtensionsService` (or a small
sibling using its slot limit, abort and `forget()`) caches the rows per folder, agent and agent-file hash. `forget()` (every
write, Vault change, agents-folder change) drops them. A read older than 5 minutes returns the cached rows and re-probes in
the background, so a skill added outside ZumiBot shows up without a restart.

**Filter (shared, pure).** `shared/src/engineCommands.ts`: a deny list of Claude built-ins (only rows the CLI marks
`builtin: true`): `login`, `logout`, `model`, `effort`, `usage`, `usage-credits`, `extra-usage`, `config`, `color`,
`clear`, `fast`, `focus`, `rename`, `output-style`, `autocompact`, `compact`, `context`, `mcp`, `agents`,
`reload-plugins`, `reload-skills`, `heapdump`, `import`, `design-consent`, `design-revoke`, `auto-mode-setup`,
`workflow-launch-exec`, and every name starting `__`, plus defensive entries for UI commands not in `-p` today (`help`,
`exit`, `resume`, `permissions`, `hooks`, `memory`, `status`, `cost`, `theme`, …). Skills and plugin or user commands are
never denied. ZumiBot's reserved names (`btw`, `todo`, `run-workflow`) are dropped.

**RPC.** `agents:engineCommands(agent, folder)` returns `{engine: 'claude' | 'codex', commands: EngineCommand[]}` or
`null` for ACP and AG-UI agents (and when the CLI is missing or the probe fails: the menu just shows no engine rows).
Added in the three places: `ZumiBotApi`, `rpc/handlers.ts` (folder checked as an existing absolute directory),
`net/api.ts`.

**Menu (frontend).** A single chat and the new-chat screen fetch the list for their agent and folder (a small hook, kept
while the agent and folder stay). `filterCommands` takes the engine rows as a separate input and puts them after the agent
commands, same matching rule (name prefix, then description word prefix). `slashQuery` and the pick logic accept `:` and
`_` in names (`/superpowers:brainstorming`). `CommandMenu` ends an engine row with a muted label (`claude` / `codex`)
and shows a non-empty `argumentHint` dimmed after the name. Rooms pass no engine rows.

**Send.** `CommandPick` gains `engine?: 'claude' | 'codex'`. `keepPick` keeps an engine pick while the text still starts
with its `/name`.

- Claude: the resolver skips agent-command lookup for an engine pick, and the text goes to the CLI as typed, which runs
  the command. The user item stores `engineCommand: {engine: 'claude', name}` for the bubble's label. A reply quote, which
  is normally put in front, goes after the command text instead so the command stays first.
- Codex: the server looks the skill up by name in the cached list (probing if needed), stores `engineCommand: {engine:
  'codex', name}` and sends the turn's input as text `$<name> <args>` plus `{type: 'skill', name, path}`. The path never
  comes from the client. A skill gone since the pick fails the send with a plain sentence.
- A `/name` typed by hand with no pick: an agent command wins (as today), else a Claude agent's text goes as typed (already
  so), else a Codex agent's matching skill is used as above.

## Constraints

- `initialize`'s `commands` and Codex's `skills/list` are no documented API: read defensively, never pass raw answers on.
- No secrets in logs or errors; probe errors stay fixed sentences.
- Docs: update `docs/architecture/agent-commands.md` (and the user docs page for commands).

## Known limits (accepted)

- A reseeded turn (after an edit, an engine switch) puts history before the message, so a Claude command there is read as
  text, not run.
- A built-in that prints a report (`/insights`, `/doctor`) shows as a reply from a synthetic assistant message, as the CLI
  sends it.

## Left to the builder

Where the probe mode lives (a flag on `runProbe` or its own function), the hook's name and caching on the client, exact
CSS of the label, and test layout.
