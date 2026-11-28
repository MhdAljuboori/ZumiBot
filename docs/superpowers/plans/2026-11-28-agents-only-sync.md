# Agents-only sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync copies only the Claude setup (agents, skills, agent memory, `CLAUDE.md`, plugins that are on) by default, and today's full sync only when the user ticks **Sync with chats and projects** (or passes `--with-chats`).

**Architecture:** `sync({ chats })` in `zumi-bot-server/deploy/sync.mjs` gains a plain path that runs only a shared `syncClaudeSetup()` (rsync of three `~/.claude` dirs, `CLAUDE.md`, plugin installs, settings report) and never touches ZumiBot data. Full mode is today's flow calling the same function. The desktop Sync window passes a `chats` boolean through preload → IPC → `syncFlow` → worker → `sync()`, and plain mode skips the local busy/pause/restore steps.

**Tech Stack:** plain Node ESM (`sync.mjs`, `config.mjs`, no deps), Electron main/preload (TypeScript), static HTML/JS pages, vitest.

**Spec:** `docs/superpowers/specs/2026-11-28-agents-only-sync-design.md`

## Global Constraints

- `sync.mjs` and `config.mjs` stay plain Node ESM with no imports beyond `node:*` and each other; the desktop build copies them to `resources/sync`.
- Plain mode never reads or writes `~/.local/share/zumibot` on either side, never runs `zumibot-server busy`/`processes`, never checks `server.lock`, never restarts anything.
- Never pass `-y` or `--accept-command` to `claude plugin install`.
- Only the `enabledPlugins` key is taken from `~/.claude/settings.json`; nothing else from it is logged, copied or passed on.
- Checkbox label exactly `Sync with chats and projects`, unticked on every window open, never remembered.
- Exact copy (from the spec) is listed in each task; do not reword it.
- No `git commit` unless the user asks (their standing rule). Skip every commit.
- Comments short and say why. Tests that spawn shells stay inside the Linux-only `describe.skipIf(process.platform !== 'linux')('sync', …)` and follow its existing fake-bin pattern; pure-function tests go in their own top-level `describe` so they run everywhere.

## Review Focus

1. No `claude` on `PATH` on one side (even in a login shell): each install there fails, is logged with the manual command, and the sync still exits 0. Pinned in Task 3.
2. Malformed or missing `installed_plugins.json` / `known_marketplaces.json` / `settings.json`: treated as empty, never a crash. Pinned in Task 3.
3. Target side has the id only at project scope: counts as installed, nothing is installed. Pinned in Task 3.
4. Two missing plugins from one unknown marketplace: the marketplace is added once. Pinned in Task 3.
5. Box ticked, window closed and reopened: unticked again. Pinned in Task 5 (e2e).

---

### Task 1: `realRun` timeout

**Files:**
- Modify: `zumi-bot-server/deploy/config.mjs` (`realRun`)
- Test: `zumi-bot-server/backend/tests/sync.test.ts` (`describe('sync helpers')`)

**Interfaces:**
- Produces: `realRun(cmd, args, opts?: { cwd?, input?, stream?, timeoutMs?: number }) → Promise<{ code, stdout, stderr }>`; on timeout the child gets `SIGTERM` and the result is `{ code: 124, stdout, stderr: stderr + 'timed out' }`.

- [ ] **Step 1: Write the failing test** in `describe('sync helpers')`:

```ts
it('realRun stops a command that runs past timeoutMs', async () => {
  const t = Date.now()
  const r = await realRun('sleep', ['5'], { timeoutMs: 50 })
  expect(r.code).toBe(124)
  expect(r.stderr).toContain('timed out')
  expect(Date.now() - t).toBeLessThan(2000)
})
```

- [ ] **Step 2:** `npx vitest run zumi-bot-server/backend/tests/sync.test.ts -t "timeoutMs"` → FAIL (code 0 after 5 s, or test timeout).
- [ ] **Step 3:** Implement in `realRun`: a `setTimeout` when `opts.timeoutMs` is set, cleared on `close`/`error`; resolve once only.
- [ ] **Step 4:** Same command → PASS; then the whole `sync helpers` describe passes.

---

### Task 2: Plain mode in `sync()` and the CLI flag

**Files:**
- Modify: `zumi-bot-server/deploy/sync.mjs` (`sync`, new `syncClaudeSetup`, `parseSyncArgs`, `isEntry` block)
- Test: `zumi-bot-server/backend/tests/sync.test.ts`

**Interfaces:**
- Produces: `sync({ env, chats = false, run, log, alive, sleep, now }) → Promise<0|1>`.
- Produces: `export function parseSyncArgs(argv: string[]): { chats: boolean } | null` (`[]` → `{chats:false}`, `['--with-chats']` → `{chats:true}`, anything else → `null`).
- Produces (internal): `async function syncClaudeSetup({ dirs, target, ssh, rsync, run, bk, rbk, home, log }) → Promise<boolean>`; `dirs` is a filtered `CLAUDE_DIRS`; returns `false` when an rsync fails (caller returns 1). It does the dir rsyncs, `CLAUDE.md`, then calls `syncPlugins` (Task 3; until then keep today's plugin report here), then the `~/.claude/settings.json` difference line.
- Constant: `const SETUP_DIRS = ['agents', 'skills', 'agent-memory']`.

- [ ] **Step 1: Make the harness mode-aware.** `go(run, alive, extra, chats = true)` passes `chats` to `sync()`, so every existing test keeps today's full behavior. Extend `fakeRun(onRun?, path = \`${join(root, 'bin')}:${process.env.PATH}\`)`: the fake commands' `PATH` comes from `path`, it accepts a third `opts` argument (ignored), and it runs `cmd === 'bash'` locally: `spawnSync('bash', args, { env: { ...process.env, HOME: pc, PATH: path }, encoding: 'utf8' })`.

- [ ] **Step 2: Write the failing tests** (inside the Linux `sync` describe):

```ts
it('plain sync merges agents, skills, memory and CLAUDE.md, and nothing of chats', async () => {
  write(join(pc, '.claude/agent-memory/a/m.md'), 'pc mem')
  write(join(vps, '.claude/CLAUDE.md'), 'vps rules')
  const pcChats = readFileSync(data(pc, 'chats.json'), 'utf8')
  const vpsChats = readFileSync(data(vps, 'chats.json'), 'utf8')
  expect(await go(fakeRun(), () => false, {}, false)).toBe(0)
  for (const home of [pc, vps]) {
    expect(existsSync(join(home, '.claude/agents/pc-agent.md')) && existsSync(join(home, '.claude/agents/vps-agent.md'))).toBe(true)
    expect(readFileSync(join(home, '.claude/agent-memory/a/m.md'), 'utf8')).toBe('pc mem')
    expect(readFileSync(join(home, '.claude/CLAUDE.md'), 'utf8')).toBe('vps rules')
  }
  expect(readFileSync(join(pc, '.claude/projects/p/s.jsonl'), 'utf8')).toBe('old')
  expect(readFileSync(join(pc, '.claude/history.jsonl'), 'utf8')).toBe('{"timestamp":2}\n')
  expect(readFileSync(data(pc, 'chats.json'), 'utf8')).toBe(pcChats)
  expect(readFileSync(data(vps, 'chats.json'), 'utf8')).toBe(vpsChats)
  expect(existsSync(join(vps, 'systemctl.log'))).toBe(false)
  expect(calls.some((c) => c.args.some((a) => a.includes('zumibot-server') || a.includes('.local/share/zumibot')))).toBe(false)
  const bk = /Backups: (\S+) \(this PC\)/.exec(logs.at(-1)!)![1]!
  expect(logs.at(-1)).toMatch(/^Synced agents, skills, agent memory and plugins\. Backups: /)
  expect(existsSync(join(bk, 'agents/pc-agent.md'))).toBe(true)
  expect(existsSync(join(bk, 'zumibot-data'))).toBe(false)
})

it('plain sync runs while ZumiBot runs on this PC and a reply runs on the VPS', async () => {
  write(data(pc, 'server.lock'), '4242 1')
  write(join(vps, 'busy'), '2\n')
  expect(await go(fakeRun(), () => true, {}, false)).toBe(0)
})
```

and in `describe('sync helpers')`:

```ts
it('parseSyncArgs picks the mode and refuses anything else', () => {
  expect(parseSyncArgs([])).toEqual({ chats: false })
  expect(parseSyncArgs(['--with-chats'])).toEqual({ chats: true })
  expect(parseSyncArgs(['--chats'])).toBeNull()
  expect(parseSyncArgs(['--with-chats', 'x'])).toBeNull()
})
```

- [ ] **Step 3:** `npx vitest run zumi-bot-server/backend/tests/sync.test.ts -t "plain sync|parseSyncArgs"` → FAIL.
- [ ] **Step 4: Implement.** In `sync()`: after the host/user/dir checks, branch on `chats`. Plain: read remote home, make the 0700 backup folders with only `agents` and `CLAUDE.md` copied in (local `cpSync`; remote `mkdir -p -m 700`, `mkdir -p ~/.claude/agents ~/.claude/skills ~/.claude/agent-memory`, `cp -a` of `agents`/`CLAUDE.md`), run `syncClaudeSetup` with `CLAUDE_DIRS.filter(([d]) => SETUP_DIRS.includes(d))`, then log exactly `Synced agents, skills, agent memory and plugins. Backups: ${bk} (this PC), ${rbk} (VPS).` and return 0. Full: today's flow, with its `CLAUDE_DIRS` loop + `CLAUDE.md` + plugin report + settings line replaced by one `syncClaudeSetup` call (all five dirs) at the loop's current place; `history.jsonl` stays in the full path. `isEntry` block: `parseSyncArgs(process.argv.slice(2))`; on `null` print `Usage: node sync.mjs [--with-chats]` and set `process.exitCode = 1`; else `sync({ env, chats })`.
- [ ] **Step 5:** Run the whole file: `npx vitest run zumi-bot-server/backend/tests/sync.test.ts` → all pass (existing full-mode tests unchanged).

---

### Task 3: Install plugins that are on, both ways

**Files:**
- Modify: `zumi-bot-server/deploy/sync.mjs` (new `pluginSide`, `planPluginInstalls`, internal `syncPlugins`; called from `syncClaudeSetup`, replacing the report)
- Test: `zumi-bot-server/backend/tests/sync.test.ts`

**Interfaces:**
- Consumes: `realRun`'s `timeoutMs` (Task 1), `syncClaudeSetup` (Task 2), the `fakeRun` `bash` branch (Task 2).
- Produces: `export function pluginSide({ installed, marketplaces, settings }: { installed: string, marketplaces: string, settings: string }) → { installed: Record<string, Array<{ scope?: string }>>, marketplaces: Record<string, { source?: { source?: string, repo?: string, url?: string } }>, enabled: Record<string, boolean> }` (each text parsed in its own try; bad or missing JSON → `{}`; `installed` from `.plugins`, `enabled` from `.enabledPlugins` only).
- Produces: `export function planPluginInstalls(pc, vps) → { installs: Array<{ id: string, to: 'local' | 'vps', addMarketplace: string | null }>, skipped: Array<{ id: string, to: 'local' | 'vps', reason: string }> }`.
- Constants: `PLUGIN_ID = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/`, `PLUGIN_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/`, `PLUGIN_GIT_URL = /^https:\/\/[A-Za-z0-9._~\/:@-]+$/`, `PLUGIN_TIMEOUT_MS = 300_000`.

**Planner rules** (for each id installed on one side and not installed at any scope on the other, `to` = the other side):
1. `enabled[id] !== true` on the source side → not copied, not listed (quiet: off plugins stay where they are).
2. Fails `PLUGIN_ID` → skipped, reason `its name has characters sync does not pass on`.
3. No `scope: 'user'` entry → skipped, reason `it is installed for one project only`.
4. Marketplace (text after `@`) missing from the source side's marketplaces → skipped, reason `its marketplace is not on record`.
5. Source `{source:'github', repo}` passing `PLUGIN_REPO` → arg `repo`; `{source:'git', url}` passing `PLUGIN_GIT_URL` → arg `url`; anything else → skipped, reason `its marketplace is a folder on the other machine`.
6. `addMarketplace` = the arg when the target side does not know that marketplace and no earlier install in this plan already adds it to that side; else `null`.

**Executor** `syncPlugins({ target, home, run, log })`: reads both sides' three files (local `readFileSync` under `~/.claude`, remote `cat` over ssh with `2>/dev/null || true`), plans, logs each skip as `Plugin ${id} was not installed on ${side}: ${reason}.`, then for each install runs (local) `run('bash', ['-lc', cmd], { timeoutMs })` or (remote) `run('ssh', [...SSH_OPTS, target, \`bash -lc ${shq(cmd)}\`], { timeoutMs })` with `cmd` = `claude plugin marketplace add ${shq(arg)}` (when `addMarketplace`) then `claude plugin install ${shq(id)}`. Success: `Installed plugin ${id} on ${side}.`; any non-zero exit: `Plugin ${id} could not be installed on ${side}: ${first non-empty stderr line}. To add it there: claude plugin install ${id}` and move on. `side` is `the VPS` or `this PC`. Never affects the exit code.

- [ ] **Step 1: Write the failing pure tests** in a new top-level `describe('planPluginInstalls')`:

```ts
const side = (o: { installed?: object; marketplaces?: object; enabled?: object }) =>
  pluginSide({
    installed: JSON.stringify({ version: 2, plugins: o.installed ?? {} }),
    marketplaces: JSON.stringify(o.marketplaces ?? {}),
    settings: JSON.stringify({ enabledPlugins: o.enabled ?? {}, env: { SECRET: 'x' } })
  })
const user = [{ scope: 'user' }]
const gh = { m: { source: { source: 'github', repo: 'o/m' } } }

it('installs an on plugin on the side that lacks it, adding its marketplace once', () => {
  const pc = side({ installed: { 'a@m': user, 'b@m': user }, marketplaces: gh, enabled: { 'a@m': true, 'b@m': true } })
  expect(planPluginInstalls(pc, side({})).installs).toEqual([
    { id: 'a@m', to: 'vps', addMarketplace: 'o/m' },
    { id: 'b@m', to: 'vps', addMarketplace: null }
  ])
})
it('never copies an off plugin or one with no enabledPlugins entry', () => {
  const pc = side({ installed: { 'a@m': user, 'b@m': user }, marketplaces: gh, enabled: { 'a@m': false } })
  expect(planPluginInstalls(pc, side({}))).toEqual({ installs: [], skipped: [] })
})
it('counts a project-scope install on the target as installed', () => {
  const pc = side({ installed: { 'a@m': user }, marketplaces: gh, enabled: { 'a@m': true } })
  const vps = side({ installed: { 'a@m': [{ scope: 'project', projectPath: '/x' }] } })
  expect(planPluginInstalls(pc, vps).installs).toEqual([])
})
it('skips project-only, unknown-marketplace, folder-source and unsafe ids with a reason', () => {
  const pc = side({
    installed: { 'p@m': [{ scope: 'project' }], 'u@builtin': user, 'd@local': user, 'x;rm@m': user },
    marketplaces: { ...gh, local: { source: { source: 'directory', path: '/home/me/m' } } },
    enabled: { 'p@m': true, 'u@builtin': true, 'd@local': true, 'x;rm@m': true }
  })
  expect(planPluginInstalls(pc, side({})).skipped.map((s) => s.reason)).toEqual([
    'it is installed for one project only',
    'its marketplace is not on record',
    'its marketplace is a folder on the other machine',
    'its name has characters sync does not pass on'
  ])
})
it('reads bad JSON as empty and takes only enabledPlugins from settings', () => {
  const s = pluginSide({ installed: '{', marketplaces: '', settings: '{"enabledPlugins":{"a@m":true},"env":{"K":"v"}}' })
  expect(s).toEqual({ installed: {}, marketplaces: {}, enabled: { 'a@m': true } })
})
it('installs both ways', () => {
  const pc = side({ installed: { 'a@m': user }, marketplaces: gh, enabled: { 'a@m': true } })
  const vps = side({ installed: { 'b@m': user }, marketplaces: gh, enabled: { 'b@m': true } })
  expect(planPluginInstalls(pc, vps).installs).toEqual([
    { id: 'a@m', to: 'vps', addMarketplace: null },
    { id: 'b@m', to: 'local', addMarketplace: null }
  ])
})
```

(The skip order follows insertion order of the source side's `plugins`; the planner walks the PC's ids first, then the VPS's.)

- [ ] **Step 2: Write the failing integration tests** in the Linux `sync` describe. A fake `claude` in `join(root, 'bin/claude')`, mode 0755, that appends `"$HOME $*"` to `join(root, 'claude.log')` and exits 1 with `Plugin needs approval` on stderr when its args contain `fail@`:

```ts
it('installs plugins that are on, logs failures, and still succeeds', async () => {
  write(join(pc, '.claude/plugins/installed_plugins.json'), { version: 2, plugins: { 'a@m': [{ scope: 'user' }], 'fail@m': [{ scope: 'user' }] } })
  write(join(pc, '.claude/plugins/known_marketplaces.json'), { m: { source: { source: 'github', repo: 'o/m' } } })
  write(join(pc, '.claude/settings.json'), { enabledPlugins: { 'a@m': true, 'fail@m': true } })
  expect(await go(fakeRun(), () => false, {}, false)).toBe(0)
  expect(readFileSync(join(root, 'claude.log'), 'utf8').split('\n').filter(Boolean)).toEqual([
    `${vps} plugin marketplace add o/m`,
    `${vps} plugin install a@m`,
    `${vps} plugin install fail@m`
  ])
  expect(logs).toContain('Installed plugin a@m on the VPS.')
  expect(logs).toContain('Plugin fail@m could not be installed on the VPS: Plugin needs approval. To add it there: claude plugin install fail@m')
  expect(calls.some((c) => c.args.join(' ').includes(' -y'))).toBe(false)
})

it('a side with no claude logs each plugin it could not install and still succeeds', async () => {
  // only the PC's plugin; no fake claude on PATH at all
  write(join(pc, '.claude/plugins/installed_plugins.json'), { version: 2, plugins: { 'a@m': [{ scope: 'user' }] } })
  write(join(pc, '.claude/plugins/known_marketplaces.json'), { m: { source: { source: 'github', repo: 'o/m' } } })
  write(join(pc, '.claude/settings.json'), { enabledPlugins: { 'a@m': true } })
  expect(await go(fakeRun(), () => false, {}, false)).toBe(0)
  expect(logs.some((l) => l.startsWith('Plugin a@m could not be installed on the VPS: '))).toBe(true)
})
```

(Write the fake `claude` only in the first test. The second runs `go(fakeRun(undefined, \`${join(root, 'bin')}:/usr/bin:/bin\`), () => false, {}, false)` so the developer's real `claude` (often in `~/.local/bin` on their `PATH`) is never found or run, and also asserts `claude.log` does not exist. A login shell sources `/etc/profile`; on a distro whose `/etc/profile` resets `PATH`, check the fake is still found in the first test, and if not, prepend the fake bin from a `$HOME/.profile` written into both fake homes.)

- [ ] **Step 3:** `npx vitest run zumi-bot-server/backend/tests/sync.test.ts -t "planPluginInstalls|plugins|no claude"` → FAIL.
- [ ] **Step 4: Implement** `pluginSide`, `planPluginInstalls`, `syncPlugins` per the rules above; call `syncPlugins` from `syncClaudeSetup` in place of the old report (both modes).
- [ ] **Step 5:** Whole file → all pass.

---

### Task 4: Desktop checkbox and plain flow

**Files:**
- Modify: `zumi-bot-desktop/src/main/syncFlow.ts`, `syncProcess.ts`, `syncDesktop.ts`, `zumi-bot-desktop/src/sync/runner.mjs`, `zumi-bot-desktop/src/preload/index.ts`, `zumi-bot-desktop/src/pages/sync.html`, `sync.js`, `picker.css` (only if the checkbox needs a style; CSP forbids inline styles)
- Test: `zumi-bot-desktop/tests/syncFlow.test.ts`, `zumi-bot-desktop/tests/syncProcess.test.ts`

**Interfaces:**
- Consumes: `sync({ env, chats, log })` (Task 2).
- Produces: `SyncFlowDeps.prepare(chats: boolean): Promise<boolean>`, `SyncFlowDeps.execute(chats: boolean): Promise<number>`, `flow.run(chats = false): Promise<void>`.
- Produces: `runSyncProcess({ node, entry, config, home, chats: boolean, log })`, which sends `{ config, home, chats }` to the worker; `runner.mjs` calls `sync({ env, chats: chats === true, log })`.
- Produces: preload `zumibotSync.start(o?: { chats?: boolean })` → `ipcRenderer.invoke('sync:start', { chats: o?.chats === true })`; main reads `(o as { chats?: unknown } | null)?.chats === true` only.

**Exact copy:**
- `sync.html` description paragraph: `Merge agents, skills, agent memory and plugins in both directions, with backups. Nothing restarts.`
- Checkbox: `<label><input id="chats" type="checkbox" /> Sync with chats and projects</label>`, and under it `<p class="hint">Also merges chats, projects, the vault and automations. The VPS restarts, and active replies must finish first.</p>`
- Plain confirm dialog: message `Sync agents, skills, memory and plugins with ${user}@${host}?`, detail `They will be merged in both directions, with backups. Chats stay on each machine. Nothing restarts.` Full: today's message and detail.
- First log line: plain `Syncing agents, skills, memory and plugins with ${user}@${host}...`; full: today's `Syncing with ${user}@${host} (${dir})...`.

- [ ] **Step 1: Write the failing tests.** In `syncFlow.test.ts`, change every existing `flow.run()` to `flow.run(true)` (they describe the full sync), record the mode in `setup` (`prepare: async (c) => (calls.push(\`prepare:${c}\`), true)` style or a separate array), and add:

```ts
it('plain sync asks about unsaved edits but never checks replies, pauses or restores', async () => {
  const { flow, calls } = setup({ isDirty: () => true, busy: async () => (calls.push('busy'), 0) })
  await flow.run(false)
  expect(calls).toEqual(['prepare', 'save', 'execute', 'Sync complete.'])
})
it('passes the mode to prepare and execute', async () => {
  const seen: boolean[] = []
  const { flow } = setup({ prepare: async (c) => (seen.push(c), true), execute: async (c) => (seen.push(c), 0) })
  await flow.run(true)
  await flow.run(false)
  expect(seen).toEqual([true, true, false, false])
})
it('plain sync reports a failed run', async () => {
  const { flow, calls } = setup({ execute: async () => 1 })
  await flow.run(false)
  expect(calls).toEqual(['prepare', 'Sync failed: see the log above.'])
})
```

In `syncProcess.test.ts`, the first worker also exits 8 unless `m.chats === true`, and the test passes `chats: true`.

- [ ] **Step 2:** `npx vitest run --project zumibot` (the desktop project; check `vitest.config.mts` for its name) → FAIL.
- [ ] **Step 3: Implement** the interfaces and copy above. `syncFlow.run(chats)`: plain = `prepare(chats)` → unsaved prompt → `execute(chats)` → result line; full = today's order. `sync.js`: `const box = document.getElementById('chats')`, `box.disabled = busy` in `refresh`, `api.start({ chats: box.checked })`; the box starts unticked because the page loads fresh each time the window opens (no state saved).
- [ ] **Step 4:** Desktop project tests pass; `npm run typecheck` exit 0.

---

### Task 5: Desktop e2e

**Files:**
- Modify: `zumi-bot-desktop/e2e/sync.e2e.mjs`

- [ ] **Step 1:** Read the file and `docs/architecture/e2e.md` (how `npm run e2e:sync` runs, display needs). Every existing flow that relies on full-sync behavior (the local server pausing and reconnecting, chats reaching the fake VPS) ticks `#chats` before clicking `#start`.
- [ ] **Step 2:** Add a plain flow: open Sync, leave the box unticked, `#start`, wait for `Sync complete.`; assert the fake VPS `chats.json` is unchanged, an agent file reached it, and the local server was never stopped (no reconnect line in the log). Close and reopen the window and assert `#chats` is not checked (Review Focus 5).
- [ ] **Step 3:** `npm run e2e:sync` → passes. If it cannot run here (no display), say so in the report; do not mark it passed.

---

### Task 6: Settings hint and docs

**Files:**
- Modify: `zumi-bot-server/frontend/src/components/Settings.tsx` (desktop sync row `hint`)
- Modify: `docs/architecture/deploy-and-sync.md`
- Modify: `zumi-bot-docs/src/content/docs/desktop/sync.mdx`

- [ ] **Step 1:** Settings hint (the `shell?.sync` row) becomes exactly: `Copies agents, skills, agent memory and plugins both ways. Tick Sync with chats and projects in the Sync window to also copy chats; the app then reconnects when it finishes.`
- [ ] **Step 2:** `deploy-and-sync.md`: a paragraph before today's `npm run sync` paragraph saying sync has two modes; plain (default) copies `agents`, `skills`, `agent-memory`, `CLAUDE.md` and installs plugins that are on (rules: `enabledPlugins === true` on the source side, user scope only, github/git marketplaces added first, never `-y`, failures logged and never fatal, uninstalls come back while the plugin is on elsewhere), reads no ZumiBot data, checks no replies, restarts nothing; full (`--with-chats`, the window's checkbox) is what the existing paragraph describes. Change "Plugins and `~/.claude/settings.json` are only reported" to say plugins are installed (both modes) and only `settings.json` is reported. In the desktop paragraph, add the checkbox and that plain mode skips the busy check and the local server stop.
- [ ] **Step 3:** `sync.mdx`: describe the checkbox (`Sync with chats and projects`, off each time), what a plain sync merges, that "No replies running" and "The server restarts at the end" apply only with the box ticked, that plugins are now installed on the other side when they are turned on (a plugin that needs approval is named in the log with the command to run), and how to keep a plugin off one machine (leave it installed there and turn it off). Move "Vault", "Routines, workflows and channels", chats, to-dos etc. under the ticked box in "What gets merged". No file names, internal paths or flags in this page except what it already shows (`VPS_DIR`, `deploy.env`).
- [ ] **Step 4:** `npx vitest run zumi-bot-docs zumi-bot-server/shared/tests/repoDocs.test.ts` → pass; `npm run typecheck` exit 0; `npm test` → all pass.
