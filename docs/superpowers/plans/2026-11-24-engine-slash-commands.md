# Engine Slash Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The composer's `/` menu lists the agent's engine commands (Claude Code commands for a Claude agent, Codex skills for a Codex agent) after ZumiBot's rows, each labelled `claude`/`codex`, and sending one makes the engine run it.

**Architecture:** A commands-only probe (`initialize`; Codex `skills/list`) runs in the chat's folder as the agent, is sanitized to rows and cached in `ExtensionsService`. A new RPC serves the rows to the composer; a pick carries `engine`, the resolver turns it into a `SentCommand` with `engine` (its `prompt` is the text the engine reads), and a Codex turn adds a `skill` input item.

**Tech Stack:** TypeScript, Node 22, vitest, React 19.

**Spec:** `docs/superpowers/specs/2026-11-24-engine-slash-commands-design.md`

## Global Constraints

- Claude built-ins denied (only rows the CLI marks `builtin: true`): `login`, `logout`, `model`, `effort`, `usage`, `usage-credits`, `extra-usage`, `config`, `color`, `clear`, `fast`, `focus`, `rename`, `output-style`, `autocompact`, `compact`, `context`, `mcp`, `agents`, `reload-plugins`, `reload-skills`, `heapdump`, `import`, `design-consent`, `design-revoke`, `auto-mode-setup`, `workflow-launch-exec`, `help`, `exit`, `resume`, `permissions`, `hooks`, `memory`, `status`, `cost`, `theme`, `vim`, `ide`, `terminal-setup`, `statusline`, `privacy-settings`, `release-notes`, `feedback`, `bug`, `keybindings`, `add-dir`, `export`, `copy`, `plugin`, `upgrade`, `tasks`, `rewind`; and every name starting `__`.
- ZumiBot's reserved names (`btw`, `todo`, `run-workflow`) never show as engine rows.
- Raw probe answers are never logged, cached or passed on; only sanitized rows. Errors stay fixed sentences (no paths, no CLI output).
- A Codex skill's `path` never leaves the server (not in the RPC answer, not on the stored item).
- Engine rows only in single chats and the new-chat screen; rooms get none.
- Cache: per folder, agent and agent-file hash; `forget()` drops it; an entry older than 5 minutes (`ENGINE_COMMANDS_STALE_MS = 300_000`) is returned and re-probed in the background.
- No git commits (the user's rule): leave changes uncommitted.
- Docs: update `docs/architecture/agent-commands.md` in the same change.

## Review Focus

- A pick whose engine row is gone by send time (skill removed, agent switched): Claude still sends the text as typed; Codex fails the send with `Codex has no $<name> skill any more`. Test in Task 4.
- A plugin name with `:` (`/superpowers:brainstorming`) typed by hand: the menu filters on it and the pick survives typing args after it. Test in Task 6.
- Same name as an agent command (`/review` in both): the agent row comes first, picking the `claude` row sends the engine pick, which the resolver never turns into the agent command. Tests in Tasks 4 and 6.
- A probe that fails or a CLI that is missing: the RPC answers `{engine, commands: []}`, never throws to the menu. Test in Task 3.
- A Claude command sent as a reply: the quote goes after the command text, so the command stays first. Test in Task 5.

---

### Task 1: Shared types and name rules

**Files:**
- Create: `zumi-bot-server/shared/src/engineCommands.ts`
- Modify: `zumi-bot-server/shared/src/commands.ts` (`CommandPick`, `SentCommand`)
- Test: `zumi-bot-server/shared/tests/engineCommands.test.ts`

**Interfaces:**
- Produces:
  - `export type CommandEngine = 'claude' | 'codex'`
  - `export interface EngineCommand { name: string; description: string; hint?: string }`
  - `export interface EngineCommands { engine: CommandEngine; commands: EngineCommand[] }`
  - `export const CLAUDE_DENIED: ReadonlySet<string>` (the Global Constraints list)
  - `export function engineLeading(text: string): { name: string; args: string } | null` — `^\/([A-Za-z0-9][A-Za-z0-9_:.-]*)(?=\s|$)` at index 0, args trimmed.
  - `export function codexPrompt(name: string, args: string): string` — `$<name>` or `$<name> <args>`.
  - `CommandPick` gains `engine?: CommandEngine`; `SentCommand` gains `engine?: CommandEngine`.

- [ ] **Step 1: Write the failing tests**

```ts
it('reads a namespaced leading command', () => {
  expect(engineLeading('/superpowers:brainstorming  fix the menu ')).toEqual({ name: 'superpowers:brainstorming', args: 'fix the menu' })
  expect(engineLeading('/goal')).toEqual({ name: 'goal', args: '' })
  expect(engineLeading(' /goal')).toBeNull()
  expect(engineLeading('/')).toBeNull()
})
it('fills a codex skill prompt', () => {
  expect(codexPrompt('pdf', '')).toBe('$pdf')
  expect(codexPrompt('pdf', 'read a.pdf')).toBe('$pdf read a.pdf')
})
it('denies screens and settings, keeps action built-ins', () => {
  for (const n of ['model', 'effort', 'usage', 'login', 'clear', 'compact', 'context']) expect(CLAUDE_DENIED.has(n)).toBe(true)
  for (const n of ['goal', 'advisor', 'ultrareview', 'security-review', 'init']) expect(CLAUDE_DENIED.has(n)).toBe(false)
})
```

- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/shared/tests/engineCommands.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `shared/src/engineCommands.ts` and the two optional fields in `commands.ts`.
- [ ] **Step 4: Run** the same command — expect PASS. Run `npm run typecheck` — expect clean.

---

### Task 2: Commands-only probe and sanitizers

**Files:**
- Modify: `zumi-bot-server/backend/src/core/extensions/probe.ts`
- Create: `zumi-bot-server/backend/src/core/extensions/engineCommandRows.ts`
- Modify: `zumi-bot-server/backend/tests/fixtures/fake-claude.mjs`, `fake-codex.mjs` only if their `initialize` / `skills/list` answers lack `commands` / skills (read them first)
- Test: `zumi-bot-server/backend/tests/core/extensions/probe.test.ts`, `zumi-bot-server/backend/tests/core/extensions/engineCommandRows.test.ts`

**Interfaces:**
- Consumes: `CLAUDE_DENIED`, `EngineCommand` (Task 1).
- Produces:
  - `export interface EngineCommandRow extends EngineCommand { path?: string }` (path: Codex only)
  - `export function probeClaudeCommands(o: ClaudeProbeOptions): Promise<unknown | null>` — same argv as `probeClaude`; sends only `initialize`; resolves its raw `response` (null on error, exit, timeout or spawn failure); deadline default 15 s; ends the process group as `runProbe` does.
  - `export function probeCodexCommands(o: ProbeOptions): Promise<unknown | null>` — `initialize`, `initialized`, then `skills/list {cwds:[folder]}` asked again until two answers have the same skill count (as `codexDialect.again`); resolves the last answer or null.
  - `export function claudeCommandRows(answer: unknown): EngineCommandRow[]` — from `answer.commands`: keep objects with a string `name` passing `/^[A-Za-z0-9][A-Za-z0-9_:.-]*$/`; drop `builtin === true && CLAUDE_DENIED.has(name)`, names starting `__`, and `btw`/`todo`/`run-workflow`; description: string, first line, trimmed, cut at 300 chars; `hint`: non-empty trimmed `argumentHint` only; first row per name wins; CLI order kept.
  - `export function codexSkillRows(answer: unknown): EngineCommandRow[]` — every `data[].skills[]` with `enabled === true`, a valid name and a string `path`; description = `interface.shortDescription ?? shortDescription ?? description`, same trimming; first per name wins.

Reuse `runProbe`'s process handling: extract what both modes need rather than copying `ProbeProc` (the implementer picks: a `sections` option on `runProbe`, or a small shared helper).

- [ ] **Step 1: Write failing tests**
  - `claudeCommandRows` keeps `{name:'goal',builtin:true}`, `{name:'superpowers:brainstorming'}`, a skill with `argumentHint:'[x]'` (→ `hint:'[x]'`); drops `{name:'model',builtin:true}`, `{name:'__remote-workflow',builtin:true}`, `{name:'todo'}`, `{name:42}`, a `null` row; a non-builtin row named `model` (a user's own command) is kept.
  - `codexSkillRows` keeps an enabled skill with path, drops a disabled one and one without path, prefers `interface.shortDescription`.
  - `probeClaudeCommands` against the fake claude: resolves an object with a `commands` array, writes exactly one control request (`initialize`) and no user message, leaves no process (copy the "leaves no process" check of `probeClaude`'s test).
  - `probeCodexCommands` against the fake codex: resolves the `skills/list` answer.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/extensions/` — expect the new tests to FAIL.
- [ ] **Step 3: Implement** the two probe functions and `engineCommandRows.ts`.
- [ ] **Step 4: Run** the same command — expect PASS (old probe tests too).

---

### Task 3: Cache in ExtensionsService and the RPC

**Files:**
- Modify: `zumi-bot-server/backend/src/core/extensions/extensionsService.ts`
- Modify: `zumi-bot-server/shared/src/types.ts` (`ZumiBotApi.agents`)
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts`
- Modify: `zumi-bot-server/frontend/src/net/api.ts`
- Test: `zumi-bot-server/backend/tests/core/extensions/extensionsService.test.ts`

**Interfaces:**
- Consumes: Task 2's probes and row readers; `ExtensionsDeps.runConfig(agent, { serversOff: true, skillsOff: true })` (a real run's config, so switched-off skills stay off).
- Produces:
  - `ExtensionsService.engineCommands(folder: string, agent: string): Promise<{ engine: CommandEngine; rows: EngineCommandRow[] } | null>` — null for an ACP or AG-UI agent or an unknown/broken one; Zumi Bot counts as Claude. Missing CLI or failed probe → `rows: []` (not cached, so the next call tries again). Uses `slot()`, `abortable()`, the generation counter and its own cache map (`CACHE_MAX` entries), keyed like `cacheKey(folder, agent, fileText)`. Joins an in-flight probe for the same key. A hit older than `ENGINE_COMMANDS_STALE_MS` returns the cached rows and starts one background re-probe for that key.
  - `ExtensionsService.codexSkill(folder: string, agent: string, name: string): Promise<{ name: string; path: string } | null>` — from `engineCommands`.
  - `forget()` also clears the engine cache and its in-flight map.
  - RPC `agents:engineCommands(agent: string, folder: string | null): Promise<EngineCommands | null>` — handler checks `agent` is a loadable agent's name, `folder` with `extFolder` (null → `d.home`, the same home `ExtensionsService` uses); strips `path`. `ZumiBotApi.agents.engineCommands(agent, folder)`; `api.ts`: `engineCommands: (agent, folder) => call('agents:engineCommands', agent, folder)`.

- [ ] **Step 1: Write failing tests** (stub `probe` seam: add `claudeCommands?` / `codexCommands?` to `ExtensionsDeps.probe`)
  - Second call for the same folder, agent and file text probes once; editing the agent file's text probes again.
  - `forget()` makes the next call probe again; a probe that began before `forget()` does not land in the cache.
  - With a fake clock (`now`) past 5 minutes: the call returns the old rows at once and a second probe starts; the call after it returns the new rows.
  - A probe resolving null → `{engine:'claude', rows: []}` and the next call probes again.
  - A Codex agent → `engine: 'codex'`; `codexSkill(folder, agent, 'pdf')` → `{name:'pdf', path}`; unknown name → null.
  - An ACP agent → null.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/extensions/extensionsService.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the service methods, the handler, the API type and the `api.ts` mapping.
- [ ] **Step 4: Run** the test file — PASS; `npm run typecheck` — clean.

---

### Task 4: Resolver and send handlers

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/commandResolver.ts`
- Modify: `zumi-bot-server/backend/src/rpc/handlers.ts` (`commandPick`)
- Modify: `zumi-bot-server/backend/src/app.ts` (resolver deps)
- Test: `zumi-bot-server/backend/tests/core/commandResolver.test.ts`

**Interfaces:**
- Consumes: `engineLeading`, `codexPrompt`, `CommandPick.engine`, `SentCommand.engine` (Task 1); `ExtensionsService.engineCommands` (Task 3).
- Produces:
  - Resolver dep `engineCommandsOf(agent: string, folder: string): Promise<{ engine: CommandEngine; rows: { name: string }[] } | null>` (app.ts wires it to `extensions.engineCommands`, catching to null).
  - `forSend` rules, in order:
    1. Pick with `engine` set: refused in a room (`Engine commands run only in a single chat`); `pick.agent` must be the chat's agent; name read with `engineLeading`, must equal `pick.name` or the pick is ignored. Claude → `{agent, name, prompt: text, engine:'claude'}` (no list check: the CLI decides). Codex → the name must be in the list, else `Codex has no $<name> skill any more`; → `{agent, name, prompt: codexPrompt(name, args), engine:'codex'}`.
    2. No engine pick: the existing agent-command rules first (unchanged).
    3. Nothing found, single chat: look the `engineLeading` name up in the list; a hit gives the same `SentCommand` as rule 1; no hit → `undefined` (sent as typed).
  - `forRerun`: a stored `old.command.engine` carries into the derived pick (`{agent, name, engine}`); the leading-name check for an engine command uses `engineLeading`.
  - `commandPick()` in handlers accepts `engine` only as `'claude'` or `'codex'` (anything else → `TypeError('Invalid command')`).

- [ ] **Step 1: Write failing tests**
  - Claude engine pick `/goal ship it` → `{agent:'a', name:'goal', prompt:'/goal ship it', engine:'claude'}`, even when agent `a` has its own `/goal` command.
  - Codex engine pick `/pdf read a.pdf` with `pdf` in the list → `prompt: '$pdf read a.pdf', engine:'codex'`; without it → rejects with `Codex has no $pdf skill any more`.
  - Engine pick in a room → rejects with `Engine commands run only in a single chat`.
  - No pick, `/superpowers:brainstorming x` typed, Claude agent, name in list → `engine:'claude'`; not in list → `undefined`.
  - No pick, `/review`, agent has its own `review` → the agent command (no `engine`).
  - Resend of a message whose `command.engine === 'codex'` keeps `engine:'codex'`.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/backend/tests/core/commandResolver.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.

---

### Task 5: The turn: reply order, Codex skill item

**Files:**
- Modify: `zumi-bot-server/backend/src/core/chat/reply.ts` (`withReply`)
- Modify: `zumi-bot-server/backend/src/core/chat/chatService.ts` (prompt build near `const noted = …`, `TurnSpec`, `codexRun` config)
- Modify: `zumi-bot-server/backend/src/core/codex/codexParams.ts` (`codexInput`), `zumi-bot-server/backend/src/core/codex/codexRunner.ts` (`CodexRunOptions`, `turn/start`)
- Modify: `zumi-bot-server/backend/src/app.ts` (chatService dep)
- Test: `zumi-bot-server/backend/tests/core/reply.test.ts`, `zumi-bot-server/backend/tests/core/codexParams.test.ts`, `zumi-bot-server/backend/tests/core/codexRunner.test.ts`, the chatService Codex test file that already covers a Codex turn (find with `grep -ln "engine: 'codex'" backend/tests/core/chatService*.test.ts`)

**Interfaces:**
- Consumes: `SentCommand.engine` (Task 1), `ExtensionsService.codexSkill` (Task 3).
- Produces:
  - `withReply(text: string, quoted: AssistantItem | undefined, after = false): string` — `after` puts the `<reply_to>` block after the text.
  - `export interface CodexSkillRef { name: string; path: string }` in `codexParams.ts`; `codexInput(c: UserContent, skills: readonly CodexSkillRef[] = [])` appends `{ type: 'skill', name, path }` per ref after the content items.
  - `CodexRunOptions.skills?: CodexSkillRef[]`, passed to `codexInput` on `turn/start` only (never compact).
  - `TurnSpec.skills?: CodexSkillRef[]`; `codexRun` passes `spec.skills` through.
  - ChatService dep `codexSkill?(folder: string, agent: string, name: string): Promise<CodexSkillRef | null>` (app.ts wires it to `extensions.codexSkill`). In the send path, for `engine === 'codex'` and `user.command?.engine === 'codex'`, resolve it with `meta.cwd`; null → throw `Codex has no $<name> skill any more` (before anything is stored, like the to-do refusal); found → `spec.skills = [ref]`.
  - The `noted` line uses `withReply(..., user.command?.engine === 'claude')`.

- [ ] **Step 1: Write failing tests**
  - `withReply('/goal x', quoted, true)` → `'/goal x\n\n<reply_to …>…</reply_to>'`; default unchanged.
  - `codexInput('$pdf a', [{name:'pdf', path:'/s/pdf/SKILL.md'}])` → text item then `{type:'skill', name:'pdf', path:'/s/pdf/SKILL.md'}`.
  - codexRunner: with `skills`, the `turn/start` params' `input` equals `codexInput('hello', skills)`.
  - chatService (Codex): a user item with `command: {agent, name:'pdf', prompt:'$pdf a', engine:'codex'}` and a `codexSkill` stub → the codex start config carries `skills: [{name:'pdf', path}]`; stub returning null → the turn ends with an error item `Codex has no $pdf skill any more` and the CLI never starts.
- [ ] **Step 2: Run** the four files — expect FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `npm run typecheck` — clean.

---

### Task 6: Menu logic (pure)

**Files:**
- Modify: `zumi-bot-server/frontend/src/state/commandInput.ts`
- Test: `zumi-bot-server/frontend/tests/commandInput.test.ts`

**Interfaces:**
- Consumes: `EngineCommands`, `EngineCommand`, `CommandEngine`, `engineLeading` (Task 1).
- Produces:
  - `export interface EngineCommandOption { engine: CommandEngine; command: EngineCommand }`; `CommandOption` gains it.
  - `filterCommands(query, agents, opts)` gains `opts.engine?: EngineCommands | null`; its rows come after the agent rows, by the same rule (name prefix, then description word prefix), and show after `/todo ` too (a command the to-do list goes with).
  - `SLASH_QUERY` accepts `[A-Za-z0-9_:.-]*` after the slash (agent names still only match their own charset).
  - `keepPick(text, pick, agents?, engine?: EngineCommands | null)`: an engine pick holds while `engineLeading(splitTodo(text).rest)?.name === pick.name`, and (when `engine` is given) while `engine.engine === pick.engine` and its rows still hold the name.
  - `groupOptions` skips engine options.

- [ ] **Step 1: Write failing tests**
  - `/go` with agent command `goal-check` and engine row `goal` → agent row first, then `{engine:'claude', command:{name:'goal'}}`.
  - `/superpowers:br` matches `superpowers:brainstorming` (`slashQuery('/superpowers:br', true)?.query === 'superpowers:br'`).
  - Engine rows whose description has a word starting with the query come after name matches.
  - `keepPick('/superpowers:brainstorming fix it', {agent:'a', name:'superpowers:brainstorming', engine:'claude'}, [agentA], claudeList)` keeps it; after the name is edited it is dropped; with a list no longer holding the name it is dropped.
  - `filterCommands('', agents, { engine: null })` is the old result exactly.
- [ ] **Step 2: Run** `npx vitest run zumi-bot-server/frontend/tests/commandInput.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.

---

### Task 7: Menu UI, fetch hook, bubble

**Files:**
- Create: `zumi-bot-server/frontend/src/net/useEngineCommands.ts`
- Modify: `zumi-bot-server/frontend/src/components/Composer.tsx`, `CommandMenu.tsx`, `ChatView.tsx` (single-chat composer only), `NewChatView.tsx` (single mode only), `CommandBubble.tsx`, the stylesheet that holds `.command-option` (find with `grep -rln "command-option" frontend/src`)

**Interfaces:**
- Consumes: `api.agents.engineCommands` (Task 3), Task 6's `filterCommands` / `keepPick`.
- Produces:
  - `useEngineCommands(agent: string | null, folder: string | null): EngineCommands | null` — fetches when either changes and on reconnect (`useOnReconnect`), drops an answer for an older key, null while loading or on error, null for `agent === null`.
  - `Composer` prop `engineCommands?: EngineCommands | null` → `filterCommands(..., { engine })`, `keepPick(..., engine)`; `pickCommand` sets `{agent: <chat's agent>, name, engine}` for an engine option (the composer's single `commandAgents[0]`).
  - `CommandMenu` row for an engine option: `/name`, then `hint` in a muted `command-hint` span when set, the description, and a trailing `command-engine` label (`claude` / `codex`, `data-testid="command-engine"`); `key` = `engine:<engine>/<name>`.
  - `CommandBubble`: a `command.engine` message shows its chip with the engine label and no "Full prompt" toggle.
  - ChatView passes `useEngineCommands(chat.group ? null : chat.agentName, chat.cwd)`; NewChatView passes `useEngineCommands(single ? draft.agentName : null, draft.cwd)`. Island and editors pass nothing.

- [ ] **Step 1: Implement** (no component tests exist in this repo; logic lives in Task 6).
- [ ] **Step 2: Run** `npm run typecheck` and `npx vitest run --project frontend` — expect clean / PASS.
- [ ] **Step 3: Check in the app** (`run` skill or preview): a Claude agent's chat, type `/` — agent rows, then Claude rows each ending `claude`; `/goal` row present, `/model` absent; pick `/superpowers:brainstorming`, send — the bubble shows the `claude` chip and the agent runs the skill. A Codex agent shows its skills labelled `codex`. A room shows no engine rows.

---

### Task 8: Docs and full verification

**Files:**
- Modify: `docs/architecture/agent-commands.md` (new paragraph **Engine commands.**: the probe, the deny list's home, cache and 5-minute refresh, single chats only, the pick's `engine`, Claude sent as typed, Codex `$name` plus `skill` item, reply quote after, the reseed limit)
- Modify: `docs/architecture/extensions.md` (one sentence: the commands-only probe and its cache share `ExtensionsService`'s slots and `forget()`)
- Modify: the user docs page that covers the `/` menu (find with `grep -rln "/btw\|slash" zumi-bot-docs/src/content/docs`), one short section

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run** `npm test` — expect all projects PASS (includes `repoDocs.test.ts`, the 16 KB CLAUDE.md check).
- [ ] **Step 3: Run** `npm run typecheck` — expect clean.
