// Settings › Claude Code and Agent Studio's "What this agent loads" against the built server and web UI. No quota: claude is
// backend/tests/fixtures/fake-extensions-claude.mjs (the probe's four control requests and the `claude mcp` / `claude plugin`
// subcommands, driven by a state file; with FAKE_EXT_ALLOW_TURN a chat turn runs fake-claude.mjs), codex is the fake codex, and
// HOME is the harness's throwaway one, so ~/.claude and ~/.claude.json are never the user's.
// Covered: the page lists servers, plugins, skills and hooks (and is in Ctrl+K); a user-scope server is added, edited with its
// hidden value kept, and removed through the fake CLI; project (.mcp.json) and local scope; plugin switches; a skill is created,
// edited, switched off and on, and trashed; a hook is added, edited and removed in settings.json with other keys kept, and an
// unparseable file is reported and left alone; Agent Studio's switches, own hook and own server write the agent file; the agent's
// next run and its /btw side run carry --disallowedTools and ONE --settings (deniedMcpServers, skillOverrides, enabledPlugins, the
// agent's hook and ZumiBot's pause hook); an own server's Vault header reaches argv only as ${ZUMIBOT_MCP_VAULT_0}, the value
// only the run's env, and a revoked grant drops the server from the run and the side run.
// Setup that is not the point (the Vault key, chats, the btw question) goes over raw /ws RPCs; the rest is clicked.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { WebSocket } from 'ws'
import { start, unexpectedErrors, pickOption, selectValue } from './harness.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-extensions-claude.mjs', import.meta.url))
await access(FAKE)
const T = 30_000
const tid = (id) => `[data-testid="${id}"]`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// A check that throws (a JSON file read mid-write) counts as not yet; its last error is named if time runs out.
async function until(fn, label, ms = T) {
  const end = Date.now() + ms
  let last = null
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
      last = null
    } catch (e) {
      last = e
    }
    await sleep(40)
  }
  throw Error(`Timed out: ${label}${last ? ` (last check threw: ${String(last?.message ?? last).slice(0, 200)})` : ''}`)
}
function pass(name) {
  console.log(`PASS ${name}`)
}
const jsonLines = (text) =>
  text.split('\n').flatMap((l) => {
    try {
      return l ? [JSON.parse(l)] : []
    } catch {
      return []
    }
  })
const readLines = (path) => readFile(path, 'utf8').then(jsonLines, () => [])
const exists = (path) =>
  access(path).then(
    () => true,
    () => false
  )
const readJson = (path) => readFile(path, 'utf8').then(JSON.parse)

// Synthetic secrets: none of them may reach the page, a log, the data dir or an argv.
const SEEDED = 'SEEDED-ENV-SECRET-4419'
const TYPED = 'TYPED-ENV-SECRET-7731'
const KEY_VALUE = 'vk-e2e-ext-T0kenValue-Zq81x93fJ'
const KEY_ENV = 'EXT_E2E_TOKEN'
const KEY_NAME = 'Ext e2e token'

const AGENT = 'ext-agent'
const CODEX_AGENT = 'ext-codex'
const PLUGIN = 'fakeplug@fakemarket'
const ODD_SERVER = 'claude.ai Fake Drive'
const PLUGIN_SERVER = 'plugin:fakeplug:srv'

const stdio = (name, extra = {}) => ({
  name,
  status: 'connected',
  scope: 'user',
  transport: 'stdio',
  config: { type: 'stdio', command: 'node' },
  tools: [],
  ...extra
})
const SEED_STATE = {
  version: '9.9.9-fake',
  mcpServers: [
    stdio('user-stdio', {
      config: { type: 'stdio', command: 'node', args: ['a.js'], env: { TOKEN: SEEDED } },
      tools: [{ name: 'ping' }, { name: 'pong' }]
    }),
    {
      name: 'needs-login',
      status: 'needs-auth',
      scope: 'user',
      transport: 'http',
      config: { type: 'http', url: 'https://example.invalid/mcp' },
      tools: []
    },
    { name: ODD_SERVER, status: 'connected', scope: 'claudeai', transport: 'http', config: {}, tools: [{ name: 'list_files' }] },
    { name: PLUGIN_SERVER, status: 'connected', source: 'plugin', transport: 'stdio', config: {}, tools: [{ name: 'srv_tool' }] }
  ],
  skills: [
    { name: 'seeded-skill', description: 'A seeded user skill.', source: 'user', state: 'on', tokens: 40 },
    { name: 'fakeplug:helper', description: 'From the plugin.', source: 'plugin', state: 'on', tokens: 15 },
    { name: 'bundled-one', description: 'Bundled.', source: 'bundled', state: 'on', tokens: 9 }
  ],
  hooks: [
    {
      event: 'PostToolUse',
      matcher: 'Edit',
      source: 'pluginHook',
      pluginName: 'fakeplug',
      commandText: 'echo plugin-hook',
      type: 'command',
      timeout: null
    }
  ],
  plugins: [
    { id: PLUGIN, enabled: true },
    { id: 'otherplug@fakemarket', enabled: false }
  ]
}

const root = await mkdtemp(join(tmpdir(), 'cb-ext-e2e-'))
const out = join(root, 'out')
const project = join(root, 'project')
const agentsDir = join(root, 'agents')
const statePath = join(out, 'state.json')
const cliLog = join(out, 'cli.jsonl')
const startLog = join(out, 'start.jsonl')
const invLog = join(out, 'inv.jsonl')
const envDump = join(out, 'env.json')
let h = null

const readState = () => readJson(statePath)
const editState = async (fn) => {
  const s = await readState()
  fn(s)
  await writeFile(statePath, JSON.stringify(s, null, 2))
}
const cliCalls = async (...head) => (await readLines(cliLog)).filter((a) => head.every((x, i) => a[i] === x))
const invocations = () => readLines(invLog)
const flagValue = (args, flag) => args[args.indexOf(flag) + 1]
const allFlag = (args, flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []))

async function connect(hh) {
  const cookie = (await hh.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
  const ws = new WebSocket(hh.origin.replace('http', 'ws') + '/ws', { headers: { Origin: hh.origin, Cookie: cookie } })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let id = 0
  const pending = new Map(),
    wire = []
  ws.on('message', (raw) => {
    wire.push(String(raw))
    const value = JSON.parse(String(raw))
    if (pending.has(value.id)) {
      pending.get(value.id)(value)
      pending.delete(value.id)
    }
  })
  ws.on('error', () => {})
  return {
    wire,
    async rpc(method, ...args) {
      const next = ++id
      const result = new Promise((resolve, reject) => {
        pending.set(next, resolve)
        setTimeout(() => reject(Error(`Socket timeout ${method}`)), 20_000).unref()
      })
      ws.send(JSON.stringify({ id: next, method, args }))
      const response = await result
      if (!response.ok) throw Error(`${method}: ${JSON.stringify(response.error ?? response)}`)
      return response.value
    },
    close() {
      ws.close()
    }
  }
}

async function filesUnder(dir, skip) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name)
    if (skip(path)) continue
    if (entry.isDirectory()) found.push(...(await filesUnder(path, skip)))
    else if (entry.isFile()) found.push(path)
  }
  return found
}

// The Agent Studio editor, opened from the sidebar row's menu as a user does.
async function openAgentStudio(page, name) {
  await page.goto(h.origin)
  const row = page.locator(`${tid('agent-row')}[data-agent-name="${name}"]`)
  await row.waitFor({ timeout: T })
  await row.hover()
  await page.getByRole('button', { name: new RegExp(`^${name.replace('-', '.')} options$`, 'i') }).click()
  await page.locator(tid('agent-menu-edit')).click()
  await page.locator(tid('agent-loadout')).waitFor({ timeout: T })
}
const saveAgent = (page) => page.getByRole('button', { name: 'Save changes', exact: true }).click()
const agentFrontmatter = async (name) => {
  const text = await readFile(join(agentsDir, `${name}.md`), 'utf8')
  return YAML.parse(/^---\n([\s\S]*?)\n---/.exec(text)[1])
}
const switchOf = (page, kind, name) => page.locator(`${tid(`agent-ext-${kind}`)}[data-name="${name}"] ${tid('agent-ext-switch')}`)
const openSection = async (page, id) => {
  const details = page.locator(tid(`agent-ext-${id}`))
  if (!(await details.evaluate((d) => d.open))) await details.locator('summary').click()
}

try {
  await mkdir(out, { recursive: true })
  await mkdir(project, { recursive: true })
  // Its own repo: the CLI files a folder's local servers under the nearest folder holding .git (Ruling 21), and this machine may have
  // a .git above the temp folder (an empty /tmp/.git was seen), so the key is made the project's own real path.
  await mkdir(join(project, '.git'))
  await mkdir(agentsDir, { recursive: true })
  await writeFile(statePath, JSON.stringify(SEED_STATE, null, 2))
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Extensions e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  await writeFile(
    join(agentsDir, `${CODEX_AGENT}.md`),
    `---\nname: ${CODEX_AGENT}\ndescription: Extensions e2e Codex agent.\nprovider: codex\n---\nYou are a Codex test agent.\n`
  )
  await writeFile(
    join(project, '.mcp.json'),
    JSON.stringify({ mcpServers: { 'keep-me': { type: 'stdio', command: 'node', args: ['keep.js'] } }, other: { x: 1 } }, null, 2) + '\n'
  )

  h = await start({
    mode: 'local',
    fake: FAKE,
    fakeCodex: true,
    agentsDir,
    // Every catalog connector on for the agent, so no connector deny joins the exact deny and belt lists asserted below
    connectors: {
      v: 1,
      agents: { [AGENT]: ['gmail', 'google-calendar', 'google-drive', 'notion', 'github', 'slack', 'linear'] },
      migration: 'kept'
    },
    env: {
      FAKE_EXT_STATE: statePath,
      FAKE_EXT_CLI_OUT: cliLog,
      FAKE_EXT_START_OUT: startLog,
      FAKE_EXT_ALLOW_TURN: '1',
      FAKE_INVOCATIONS_OUT: invLog,
      FAKE_ENV_OUT: envDump,
      ZUMIBOT_TEST_PICK_FOLDER: project,
      // A developer's own config dirs must never be used: the page and the CLI both read HOME.
      CLAUDE_CONFIG_DIR: undefined,
      XDG_DATA_HOME: undefined
    }
  })
  const page = h.page
  const home = join(h.root, 'home')
  const claudeDir = join(home, '.claude')
  const settingsFile = join(claudeDir, 'settings.json')
  // What the server told the page, and what the page sent (the typed value is sent by design, on its way to the CLI).
  const pageWire = []
  const pageSent = []
  const pageTexts = []
  page.on('websocket', (ws) => {
    ws.on('framereceived', (f) => pageWire.push(String(f.payload)))
    ws.on('framesent', (f) => pageSent.push(String(f.payload)))
  })
  const rpc = await connect(h)
  const noteText = async () => pageTexts.push(await page.locator('body').innerText())

  // The user's files in the temp HOME: a server with a value the page must never see, and settings with keys that must survive.
  await mkdir(claudeDir, { recursive: true })
  await writeFile(
    join(home, '.claude.json'),
    JSON.stringify(
      {
        numStartups: 3,
        mcpServers: { 'user-stdio': { type: 'stdio', command: 'node', args: ['a.js'], env: { TOKEN: SEEDED } } },
        projects: {
          [await realpath(project)]: {
            mcpServers: { 'local-seeded': { type: 'stdio', command: 'node', args: ['l.js'], env: { TOKEN: SEEDED } } }
          }
        }
      },
      null,
      2
    ) + '\n'
  )
  const SEED_SETTINGS = {
    model: 'sonnet-fake',
    permissions: { allow: ['Bash(ls)'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo seeded-hook' }] }] },
    env: { KEEP: '1' }
  }
  await writeFile(settingsFile, JSON.stringify(SEED_SETTINGS, null, 2) + '\n')

  // ---- 1 the page lists what the CLI reports; it is in Ctrl+K; the machine-only line and the sign-in hint show ----
  await page.goto(h.origin)
  await page.locator(tid('agent-row')).first().waitFor({ timeout: T })
  await page.keyboard.press('Control+k')
  await page.locator(tid('palette-input')).fill('claude code')
  const paletteItem = page.locator(`${tid('palette-item')}[data-key="settings:claude-code"]`)
  await paletteItem.waitFor({ timeout: T })
  assert.match(await paletteItem.innerText(), /Claude Code/)
  await page.keyboard.press('Enter')
  await page.locator(tid('settings-claude-code')).waitFor({ timeout: T })
  assert.equal(new URL(page.url()).pathname, '/settings/claude-code', 'Ctrl+K opened the section at its own address')
  const servers = page.locator(tid('ext-server'))
  await servers.first().waitFor({ timeout: T })
  assert.deepEqual(
    (await servers.evaluateAll((els) => els.map((e) => e.dataset.name))).sort(),
    ['needs-login', 'user-stdio', ODD_SERVER, PLUGIN_SERVER].sort(),
    "the servers the fake reports, none of ZumiBot's own"
  )
  const login = page.locator(`${tid('ext-server')}[data-name="needs-login"]`)
  assert.equal(await login.getAttribute('data-status'), 'needs-auth')
  assert.match(await login.locator(tid('ext-signin')).innerText(), /Sign in from a terminal: claude mcp login needs-login/)
  assert.equal(await page.locator(`${tid('ext-server')}[data-name="user-stdio"]`).getAttribute('data-source'), 'user')
  assert.equal(await page.locator(`${tid('ext-server')}[data-name="${ODD_SERVER}"]`).getAttribute('data-source'), 'claudeai')
  assert.equal(await page.locator(`${tid('ext-server')}[data-name="${PLUGIN_SERVER}"]`).getAttribute('data-source'), 'plugin')
  assert.equal(
    await page.locator(`${tid('ext-server')}[data-name="user-stdio"] ${tid('ext-edit')}`).count(),
    1,
    'a user server can be edited'
  )
  assert.equal(
    await page.locator(`${tid('ext-server')}[data-name="${PLUGIN_SERVER}"] ${tid('ext-edit')}`).count(),
    0,
    'a plugin server cannot'
  )
  assert.match(
    await page.locator(tid('settings-claude-code')).innerText(),
    /Changes here apply to this machine only; sync does not copy them\./
  )
  await page.locator(tid('ext-tab-plugins')).click()
  assert.deepEqual((await page.locator(tid('ext-plugin')).evaluateAll((els) => els.map((e) => e.dataset.name))).sort(), [
    PLUGIN,
    'otherplug@fakemarket'
  ])
  await page.locator(tid('ext-tab-skills')).click()
  assert.deepEqual((await page.locator(tid('ext-skill')).evaluateAll((els) => els.map((e) => e.dataset.name))).sort(), [
    'bundled-one',
    'fakeplug:helper',
    'seeded-skill'
  ])
  await page.locator(tid('ext-tab-hooks')).click()
  const hookRows = await page.locator(tid('ext-hook')).evaluateAll((els) => els.map((e) => `${e.dataset.source}:${e.dataset.name}`))
  assert.deepEqual(
    hookRows.sort(),
    ['plugin:PostToolUse', 'user:SessionStart'],
    "the settings.json hook and the plugin hook, none of ZumiBot's own"
  )
  await page.locator(tid('ext-tab-servers')).click()
  await noteText()
  // The page's own probe has no agent: it carries nothing of an agent's choices.
  const folderProbes = (await readLines(startLog)).filter((s) => !s.args.includes('--permission-mode') && !s.args.includes('--agent'))
  assert.ok(folderProbes.length > 0, 'the page asked the CLI')
  for (const probe of folderProbes) {
    for (const flag of ['--settings', '--mcp-config', '--disallowedTools'])
      assert.ok(!probe.args.includes(flag), `an agent-less probe has no ${flag}`)
  }
  pass(
    "1 Settings › Claude Code (via Ctrl+K) lists the fake's servers, plugins, skills and hooks; the sign-in hint and the machine-only line show; the agent-less probe carries no agent keys"
  )

  // ---- 2 add a user-scope stdio server, edit one keeping its hidden value, remove: the fake CLI is asked, no secret in its log ----
  await page.locator(tid('ext-add-server')).click()
  await page.getByLabel('Name', { exact: true }).fill('e2e-stdio')
  await page.getByLabel('Command', { exact: true }).fill('node')
  await page.getByLabel('Arguments').fill('srv.js')
  await page.locator(tid('ext-form-env-add')).click()
  await page.getByLabel('Environment variables: name 1').fill('API_KEY')
  assert.equal(await page.getByLabel('Environment variables: value 1').getAttribute('type'), 'password', 'a typed value is masked')
  await page.getByLabel('Environment variables: value 1').fill(TYPED)
  await page.locator(tid('ext-form-save')).click()
  const added = page.locator(`${tid('ext-server')}[data-name="e2e-stdio"]`)
  await added.waitFor({ timeout: T })
  const addCall = (await cliCalls('mcp', 'add-json', 'e2e-stdio'))[0]
  assert.ok(addCall, 'claude mcp add-json was run')
  assert.deepEqual(addCall.slice(4), ['-s', 'user'], 'in user scope')
  assert.deepEqual(
    JSON.parse(addCall[3]),
    { type: 'stdio', command: 'node', args: ['srv.js'], env: { API_KEY: '<value>' } },
    'the definition, with the value masked in the log'
  )
  assert.equal((await readState()).mcpServers.find((s) => s.name === 'e2e-stdio').config.env.API_KEY, TYPED, 'the CLI got the real value')
  // The fake writes <value> in its own log; the product's protection is checked in case 10 (sockets, server log, files).
  assert.ok(!(await readFile(cliLog, 'utf8')).includes(TYPED), 'the fake CLI log line names the value only as <value>')
  await noteText()

  // An edit leaves the stored value blank in the form and keeps it.
  await page.locator(`${tid('ext-server')}[data-name="user-stdio"] ${tid('ext-edit')}`).click()
  await page.locator(tid('ext-server-form')).waitFor({ timeout: T })
  const valueBox = page.getByLabel('Environment variables: value 1')
  assert.equal(await valueBox.inputValue(), '', 'the stored value is not in the form')
  assert.equal(await valueBox.getAttribute('placeholder'), 'Saved. Leave blank to keep it.')
  assert.equal(await page.getByLabel('Environment variables: name 1').inputValue(), 'TOKEN')
  assert.ok(!(await page.locator(tid('ext-server-form')).innerHTML()).includes(SEEDED), 'the form never held the stored value')
  await page.getByLabel('Arguments').fill('a.js\n--extra')
  await page.locator(tid('ext-form-save')).click()
  await page.locator(tid('ext-server-form')).waitFor({ state: 'detached', timeout: T })
  const removeCall = (await cliCalls('mcp', 'remove', 'user-stdio'))[0]
  assert.deepEqual(removeCall, ['mcp', 'remove', 'user-stdio', '-s', 'user'], 'an edit is a remove then an add')
  const editAdd = (await cliCalls('mcp', 'add-json', 'user-stdio'))[0]
  assert.deepEqual(
    JSON.parse(editAdd[3]),
    { type: 'stdio', command: 'node', args: ['a.js', '--extra'], env: { TOKEN: '<value>' } },
    'the add carries the stored value, masked in the log'
  )
  const kept = (await readState()).mcpServers.find((s) => s.name === 'user-stdio')
  assert.equal(kept.config.env.TOKEN, SEEDED, 'the stored value reached the CLI unchanged')
  assert.deepEqual(kept.config.args, ['a.js', '--extra'])
  assert.ok(!(await readFile(cliLog, 'utf8')).includes(SEEDED), 'the fake CLI log line names the stored value only as <value>')

  // Remove the one added first.
  await added.locator(tid('ext-remove')).click()
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await added.waitFor({ state: 'detached', timeout: T })
  assert.deepEqual((await cliCalls('mcp', 'remove', 'e2e-stdio'))[0], ['mcp', 'remove', 'e2e-stdio', '-s', 'user'])
  assert.ok(!(await readState()).mcpServers.some((s) => s.name === 'e2e-stdio'), 'the CLI no longer has it')
  assert.equal(await page.locator(tid('ext-note-error')).count(), 0, 'no error shown')
  pass(
    '2 a user-scope server is added (add-json, value masked in the log), edited with its hidden value kept (remove then add, form never showed it) and removed (mcp remove)'
  )

  // ---- 3 project and local scope: .mcp.json is written directly, the other server and key stay; local goes through the CLI ----
  await page.locator(tid('ext-folder-pick')).click()
  await until(async () => (await page.locator(tid('ext-folder')).getAttribute('data-tip')) === project, 'the folder to be the project')
  await page.locator(tid('ext-add-server')).click()
  await pickOption(page.locator(tid('ext-form-scope')), 'project')
  await page.getByLabel('Name', { exact: true }).fill('proj-new')
  await page.getByLabel('Command', { exact: true }).fill('node')
  await page.getByLabel('Arguments').fill('p.js')
  await page.locator(tid('ext-form-save')).click()
  await page.locator(tid('ext-server-form')).waitFor({ state: 'detached', timeout: T })
  const mcpFile = join(project, '.mcp.json')
  let mcp = await readJson(mcpFile)
  assert.deepEqual(Object.keys(mcp), ['mcpServers', 'other'], 'the top-level keys and their order stay')
  assert.deepEqual(mcp.other, { x: 1 })
  assert.deepEqual(Object.keys(mcp.mcpServers), ['keep-me', 'proj-new'], 'the other server stays')
  assert.deepEqual(mcp.mcpServers['keep-me'], { type: 'stdio', command: 'node', args: ['keep.js'] })
  assert.deepEqual(mcp.mcpServers['proj-new'], { type: 'stdio', command: 'node', args: ['p.js'] })
  assert.equal((await cliCalls('mcp', 'add-json', 'proj-new')).length, 0, 'project scope never goes through the CLI')
  // The fake CLI would list what a real one finds in .mcp.json.
  await editState((s) => s.mcpServers.push(stdio('keep-me', { scope: 'project' }), stdio('proj-new', { scope: 'project' })))
  await page.locator(tid('ext-refresh')).click()
  const projRow = page.locator(`${tid('ext-server')}[data-name="proj-new"]`)
  await projRow.waitFor({ timeout: T })
  await projRow.locator(tid('ext-remove')).click()
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await until(async () => !('proj-new' in (await readJson(mcpFile)).mcpServers), 'proj-new to leave .mcp.json')
  mcp = await readJson(mcpFile)
  assert.deepEqual(Object.keys(mcp.mcpServers), ['keep-me'], 'removing leaves the other server')
  assert.deepEqual(mcp.other, { x: 1 }, 'and the other key')
  // Local scope: the CLI, with -s local in the folder.
  await page.locator(tid('ext-add-server')).click()
  await pickOption(page.locator(tid('ext-form-scope')), 'local')
  await page.getByLabel('Name', { exact: true }).fill('local-new')
  await page.getByLabel('Command', { exact: true }).fill('node')
  await page.locator(tid('ext-form-save')).click()
  await page.locator(`${tid('ext-server')}[data-name="local-new"]`).waitFor({ timeout: T })
  assert.deepEqual((await cliCalls('mcp', 'add-json', 'local-new'))[0].slice(4), ['-s', 'local'])
  // A local server is read back from where the CLI files it (the repo's real path), with its value hidden.
  const localSeeded = await rpc.rpc('extensions:server', project, 'local', 'local-seeded')
  assert.deepEqual(localSeeded.def, { type: 'stdio', command: 'node', args: ['l.js'], env: { TOKEN: '' } })
  assert.deepEqual(localSeeded.hidden, { env: ['TOKEN'], headers: [] })
  assert.ok(!JSON.stringify(localSeeded).includes(SEEDED), 'the local server view holds no value')
  pass(
    '3 a project-scope server is written to <folder>/.mcp.json keeping the other server and top-level key, removed without touching them; local scope runs add-json -s local'
  )

  // ---- 4 plugin switch ----
  await page.locator(tid('ext-tab-plugins')).click()
  const pluginSwitch = page.locator(`${tid('ext-plugin')}[data-name="${PLUGIN}"] ${tid('ext-plugin-switch')}`)
  assert.equal(await pluginSwitch.getAttribute('aria-checked'), 'true')
  await pluginSwitch.click()
  await until(async () => (await cliCalls('plugin', 'disable', PLUGIN)).length === 1, 'plugin disable')
  await until(async () => (await pluginSwitch.getAttribute('aria-checked')) === 'false', 'the switch to read off after the probe')
  await pluginSwitch.click()
  await until(async () => (await cliCalls('plugin', 'enable', PLUGIN)).length === 1, 'plugin enable')
  await until(async () => (await pluginSwitch.getAttribute('aria-checked')) === 'true', 'the switch to read on again')
  pass('4 the plugin switch runs claude plugin disable then enable, and the row follows the CLI')

  // ---- 5 skills: create, edit (other keys and a sibling file survive), switch off and on, delete to the Trash ----
  await page.locator(tid('ext-tab-skills')).click()
  await page.locator(tid('ext-add-skill')).click()
  await page.getByLabel('Name', { exact: true }).fill('e2e-new-skill')
  await page.getByLabel('Description').fill('Original description')
  await page.getByLabel('Instructions').fill('Do the thing.\n')
  await page.locator(tid('ext-form-save')).click()
  await page.locator(tid('ext-skill-form')).waitFor({ state: 'detached', timeout: T })
  const skillDir = join(claudeDir, 'skills', 'e2e-new-skill')
  const skillFile = join(skillDir, 'SKILL.md')
  const created = await readFile(skillFile, 'utf8')
  assert.match(created, /^---\nname: e2e-new-skill\ndescription: Original description\n---\nDo the thing\.\n$/)
  // What another tool left in the skill: a frontmatter key and a file beside SKILL.md.
  await writeFile(skillFile, created.replace('description: Original description\n', 'description: Original description\ncustom: keep-me\n'))
  await mkdir(join(skillDir, 'ref'), { recursive: true })
  await writeFile(join(skillDir, 'ref', 'notes.md'), 'sibling notes\n')
  await editState((s) =>
    s.skills.push({ name: 'e2e-new-skill', description: 'Original description', source: 'user', state: 'on', tokens: 12 })
  )
  await page.locator(tid('ext-refresh')).click()
  const skillRow = page.locator(`${tid('ext-skill')}[data-name="e2e-new-skill"]`)
  await skillRow.locator(tid('ext-edit')).waitFor({ timeout: T })
  await skillRow.locator(tid('ext-edit')).click()
  await page.locator(tid('ext-skill-form')).waitFor({ timeout: T })
  assert.match(await page.locator(tid('ext-skill-files')).innerText(), /ref\/notes\.md/, 'the form lists the sibling file')
  await page.getByLabel('Description').fill('Changed description')
  await page.locator(tid('ext-form-save')).click()
  await page.locator(tid('ext-skill-form')).waitFor({ state: 'detached', timeout: T })
  const edited = await readFile(skillFile, 'utf8')
  const editedHead = YAML.parse(/^---\n([\s\S]*?)\n---/.exec(edited)[1])
  assert.deepEqual(
    editedHead,
    { name: 'e2e-new-skill', description: 'Changed description', custom: 'keep-me' },
    'only the description changed in the frontmatter'
  )
  assert.ok(edited.endsWith('---\nDo the thing.\n'), 'the instructions are intact')
  assert.equal(await readFile(join(skillDir, 'ref', 'notes.md'), 'utf8'), 'sibling notes\n', 'the sibling file survives')

  // The switch is skillOverrides in the user settings.json; the CLI would then report the skill off.
  const skillSwitch = skillRow.locator(tid('ext-skill-switch'))
  assert.equal(await skillSwitch.getAttribute('aria-checked'), 'true')
  await skillSwitch.click()
  await until(async () => (await readJson(settingsFile)).skillOverrides?.['e2e-new-skill'] === 'off', 'skillOverrides off')
  let settings = await readJson(settingsFile)
  assert.deepEqual(settings.skillOverrides, { 'e2e-new-skill': 'off' })
  for (const key of ['model', 'permissions', 'hooks', 'env'])
    assert.deepEqual(settings[key], SEED_SETTINGS[key], `${key} survives the switch`)
  assert.deepEqual(Object.keys(settings), [...Object.keys(SEED_SETTINGS), 'skillOverrides'], 'key order kept, the new key last')
  await editState((s) => {
    s.skills.find((x) => x.name === 'e2e-new-skill').state = 'off'
  })
  await page.locator(tid('ext-refresh')).click()
  await until(async () => (await skillRow.getAttribute('data-on')) === 'false', 'the row to read off')
  await skillSwitch.click()
  await until(async () => !('skillOverrides' in (await readJson(settingsFile))), 'skillOverrides to be removed')
  settings = await readJson(settingsFile)
  assert.deepEqual(settings, SEED_SETTINGS, 'switching it on leaves the file as it began')
  await editState((s) => {
    s.skills.find((x) => x.name === 'e2e-new-skill').state = 'on'
  })
  await page.locator(tid('ext-refresh')).click()
  await until(async () => (await skillRow.getAttribute('data-on')) === 'true', 'the row to read on')

  await skillRow.locator(tid('ext-edit')).click()
  await page.locator(tid('ext-skill-form')).waitFor({ timeout: T })
  await page.locator(tid('ext-skill-delete')).click()
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await page.locator(tid('ext-skill-form')).waitFor({ state: 'detached', timeout: T })
  assert.equal(await exists(skillDir), false, 'the skill folder left skills/')
  const trash = join(home, '.local', 'share', 'Trash')
  assert.equal(
    await readFile(join(trash, 'files', 'e2e-new-skill', 'SKILL.md'), 'utf8').then((t) => t.includes('Changed description')),
    true,
    'it is in the Trash, whole'
  )
  assert.equal(await readFile(join(trash, 'files', 'e2e-new-skill', 'ref', 'notes.md'), 'utf8'), 'sibling notes\n')
  assert.match(await readFile(join(trash, 'info', 'e2e-new-skill.trashinfo'), 'utf8'), /^\[Trash Info\]\nPath=.*e2e-new-skill/)
  await editState((s) => {
    s.skills = s.skills.filter((x) => x.name !== 'e2e-new-skill')
  })
  pass(
    '5 a skill is created, its description edited (other frontmatter key and a sibling file kept), switched off (skillOverrides) and on (key removed, other settings intact) and deleted to the Trash'
  )

  // ---- 6 hooks: add, edit, remove in the user settings.json; an unparseable file is reported and left alone ----
  await page.locator(tid('ext-tab-hooks')).click()
  await page.locator(tid('ext-add-hook')).click()
  assert.equal(await selectValue(page.locator(tid('ext-form-file'))), 'user')
  await page.getByLabel('Event', { exact: true }).fill('PreToolUse')
  await page.getByLabel('Matcher').fill('Bash')
  await page.getByLabel('Command', { exact: true }).fill('echo e2e-hook')
  await page.getByLabel('Timeout (seconds)').fill('5')
  await page.locator(tid('ext-form-save')).click()
  await page.locator(tid('ext-hook-form')).waitFor({ state: 'detached', timeout: T })
  settings = await readJson(settingsFile)
  assert.deepEqual(settings.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo e2e-hook', timeout: 5 }] }])
  assert.deepEqual(settings.hooks.SessionStart, SEED_SETTINGS.hooks.SessionStart, 'the existing hook survives')
  for (const key of ['model', 'permissions', 'env']) assert.deepEqual(settings[key], SEED_SETTINGS[key], `${key} survives`)
  const hookRow = page.locator(`${tid('ext-hook')}[data-name="PreToolUse"][data-source="user"]`)
  await hookRow.waitFor({ timeout: T })
  assert.match(await hookRow.locator(tid('ext-hook-command')).innerText(), /echo e2e-hook/)
  await hookRow.locator(tid('ext-edit')).click()
  await page.locator(tid('ext-hook-form')).waitFor({ timeout: T })
  assert.equal(await page.getByLabel('Timeout (seconds)').inputValue(), '5')
  await page.getByLabel('Command', { exact: true }).fill('echo e2e-hook-2')
  await page.locator(tid('ext-form-save')).click()
  await page.locator(tid('ext-hook-form')).waitFor({ state: 'detached', timeout: T })
  settings = await readJson(settingsFile)
  assert.deepEqual(
    settings.hooks.PreToolUse,
    [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo e2e-hook-2', timeout: 5 }] }],
    'the edit changed the command only'
  )
  // The row's stamp is the file's text it was read from: remove only from the list that shows the edit.
  await until(
    async () => /echo e2e-hook-2/.test(await hookRow.locator(tid('ext-hook-command')).innerText()),
    'the list to show the edited hook'
  )
  await hookRow.locator(tid('ext-remove')).click()
  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await until(async () => !('PreToolUse' in ((await readJson(settingsFile)).hooks ?? {})), 'the PreToolUse event to be pruned')
  settings = await readJson(settingsFile)
  assert.deepEqual(settings, SEED_SETTINGS, 'removing the hook leaves the file as it began')

  // A settings.json that does not parse: the hooks tab names it, the other tabs still load, the file is never written.
  const garbage = '{ "model": "sonnet-fake", oops'
  await writeFile(settingsFile, garbage)
  await page.locator(tid('ext-refresh')).click()
  const sectionError = page.locator(tid('ext-section-error'))
  await sectionError.waitFor({ timeout: T })
  assert.match(await sectionError.innerText(), /Your settings\.json is not valid JSON, so it was left unchanged\./)
  await page.locator(tid('ext-tab-servers')).click()
  await page.locator(`${tid('ext-server')}[data-name="user-stdio"]`).waitFor({ timeout: T })
  assert.equal(await page.locator(tid('ext-section-error')).count(), 0, 'the servers tab has no error')
  await page.locator(tid('ext-tab-skills')).click()
  await page.locator(`${tid('ext-skill')}[data-name="seeded-skill"]`).waitFor({ timeout: T })
  await page.locator(`${tid('ext-skill')}[data-name="seeded-skill"] ${tid('ext-skill-switch')}`).click()
  const refused = page.locator(tid('ext-note-error'))
  await refused.waitFor({ timeout: T })
  assert.match(await refused.innerText(), /not valid JSON/)
  assert.equal(await readFile(settingsFile, 'utf8'), garbage, 'the file was left byte for byte')
  await writeFile(settingsFile, JSON.stringify(SEED_SETTINGS, null, 2) + '\n')
  await page.locator(tid('ext-refresh')).click()
  pass(
    '6 a hook is added (matcher, timeout), edited and removed in settings.json with the other keys and hook kept and the event pruned; an unparseable file is named on the hooks tab, other tabs load, nothing is written'
  )

  // ---- 7 Agent Studio: switches write serversOff, skillsOff and plugins; Revert drops them; an own hook; Codex agents have none ----
  await openAgentStudio(page, AGENT)
  const card = page.locator(tid('agent-loadout'))
  await card.locator(tid('agent-ext-server')).first().waitFor({ timeout: T })
  assert.ok(
    (await card.locator(tid('agent-ext-server')).evaluateAll((els) => els.map((e) => e.dataset.name))).includes(ODD_SERVER),
    "the card lists the fake's servers"
  )
  assert.ok(
    (await card.locator(tid('agent-ext-server')).evaluateAll((els) => els.map((e) => `${e.dataset.source}:${e.dataset.name}`))).includes(
      'zumibot:zumibot_browser'
    ),
    "and ZumiBot's own"
  )
  assert.equal(await switchOf(page, 'server', 'zumibot_browser').count(), 0, "ZumiBot's own servers have no switch")
  await openSection(page, 'skills')
  await openSection(page, 'plugins')
  const flipAll = async () => {
    await switchOf(page, 'server', ODD_SERVER).click()
    await switchOf(page, 'server', PLUGIN_SERVER).click()
    await switchOf(page, 'skill', 'seeded-skill').click()
    await switchOf(page, 'plugin', PLUGIN).click()
  }
  await flipAll()
  for (const [kind, name] of [
    ['server', ODD_SERVER],
    ['server', PLUGIN_SERVER],
    ['skill', 'seeded-skill'],
    ['plugin', PLUGIN]
  ]) {
    assert.equal(await switchOf(page, kind, name).getAttribute('aria-checked'), 'false', `${name} reads off`)
  }
  await page.locator(tid('agent-cache-note')).waitFor({ timeout: T })
  // Revert puts the switches back.
  await page.getByRole('button', { name: 'Revert' }).click()
  for (const [kind, name] of [
    ['server', ODD_SERVER],
    ['server', PLUGIN_SERVER],
    ['skill', 'seeded-skill'],
    ['plugin', PLUGIN]
  ]) {
    await until(async () => (await switchOf(page, kind, name).getAttribute('aria-checked')) === 'true', `${name} back on after Revert`)
  }
  assert.equal(await page.locator(tid('agent-cache-note')).count(), 0, 'no cache note after Revert')
  assert.ok(!/serversOff|skillsOff/.test(await readFile(join(agentsDir, `${AGENT}.md`), 'utf8')), 'Revert wrote nothing')
  await flipAll()
  await saveAgent(page)
  await until(
    async () => (await readFile(join(agentsDir, `${AGENT}.md`), 'utf8')).includes('serversOff'),
    'the agent file to hold serversOff'
  )
  let front = await agentFrontmatter(AGENT)
  assert.deepEqual(
    front.serversOff,
    [ODD_SERVER, PLUGIN_SERVER],
    'server names exactly as the CLI lists them, spaces, dot and colons included'
  )
  assert.deepEqual(front.skillsOff, ['seeded-skill'])
  assert.deepEqual(front.plugins, { [PLUGIN]: false })
  assert.deepEqual([front.name, front.description, front.model], [AGENT, 'Extensions e2e agent.', 'haiku'], "the agent's own keys stay")
  // The card asks again by itself after a Save and the switches keep their state.
  await until(
    async () =>
      (await readLines(startLog)).some(
        (s) => s.args.includes('--agent') && !s.args.includes('--permission-mode') && s.args.some((a) => a.includes('enabledPlugins'))
      ),
    'a probe for the saved agent'
  )
  assert.equal(await switchOf(page, 'server', ODD_SERVER).getAttribute('aria-checked'), 'false')
  const agentProbe = (await readLines(startLog)).filter((s) => s.args.includes('--agent') && !s.args.includes('--permission-mode')).at(-1)
  const probeSettings = JSON.parse(flagValue(agentProbe.args, '--settings'))
  assert.deepEqual(probeSettings.enabledPlugins, { [PLUGIN]: false })
  assert.ok(
    !('deniedMcpServers' in probeSettings) && !('skillOverrides' in probeSettings),
    'the probe leaves the off lists out, so a switched-off item can be switched back on'
  )
  assert.ok(!agentProbe.args.includes('--disallowedTools'))

  // An own hook through the sub-card.
  await page.locator(tid('agent-own-hook-add')).click()
  await page.getByLabel('Event', { exact: true }).fill('PreToolUse')
  await page.getByLabel('Matcher').fill('Bash')
  await page.getByLabel('Command', { exact: true }).fill('echo agent-hook')
  await page.locator(tid('ext-form-save')).click()
  await page.locator(tid('ext-hook-form')).waitFor({ state: 'detached', timeout: T })
  assert.ok(!(await readFile(join(agentsDir, `${AGENT}.md`), 'utf8')).includes('agent-hook'), 'the hook is a draft until Save')
  await saveAgent(page)
  await until(
    async () => (await readFile(join(agentsDir, `${AGENT}.md`), 'utf8')).includes('agent-hook'),
    'the agent file to hold the hook'
  )
  front = await agentFrontmatter(AGENT)
  assert.deepEqual(front.hooks, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo agent-hook' }] }] })
  assert.deepEqual(front.serversOff, [ODD_SERVER, PLUGIN_SERVER], 'the earlier keys stay')
  await noteText()

  // Codex agents and Zumi Bot: a view only. (Zumi Bot is built in and has no Edit entry, so its card is not reachable here.)
  await openAgentStudio(page, CODEX_AGENT)
  await page.locator(tid('agent-loadout-readonly')).waitFor({ timeout: T })
  assert.equal(await page.locator(tid('agent-loadout-readonly')).innerText(), 'Per-agent choices apply to Claude agents only.')
  assert.equal(await page.locator(tid('agent-ext-switch')).count(), 0, "a Codex agent's card has no switches")
  assert.equal(
    (await page.locator(tid('agent-own-servers')).count()) + (await page.locator(tid('agent-own-hooks')).count()),
    0,
    'and no own-server or own-hook editing'
  )
  assert.equal(await page.locator(tid('agent-ext-plugins')).count(), 0, 'and no plugins section')
  pass(
    "7 Agent Studio: the card lists the fake's rows; four switches (odd server names, skill, plugin) are a draft Revert drops and Save writes as serversOff, skillsOff, plugins; an own hook is written by Save; the probe leaves the off lists out; a Codex agent's card has no switches"
  )

  // ---- 8 the run: --disallowedTools and ONE merged --settings, in the main run and the /btw side run ----
  const chat = await rpc.rpc('chats:create', AGENT, project)
  const idle = (id) => until(async () => (await rpc.rpc('chats:list')).find((c) => c.id === id && !c.inFlight), 'the chat to be idle')
  const runAfter = async (before, test) =>
    until(async () => (await invocations()).slice(before).find(test), 'the CLI to be started with those arguments')
  let seen = (await invocations()).length
  rpc.rpc('chats:send', chat.id, 'hello', []).catch(() => {})
  const main = (await runAfter(seen, (i) => !i.args.includes('--no-session-persistence'))).args
  await idle(chat.id)
  assert.equal(flagValue(main, '--agent'), AGENT)
  const BELT = ['mcp__claude_ai_Fake_Drive', 'mcp__plugin_fakeplug_srv']
  assert.deepEqual(main.slice(main.indexOf('--disallowedTools') + 1), BELT, 'the belt deny rules end the arguments, one per server')
  assert.equal(main.filter((a) => a === '--settings').length, 1, 'ONE --settings')
  const mainSettings = JSON.parse(flagValue(main, '--settings'))
  assert.deepEqual(mainSettings.deniedMcpServers, [{ serverName: ODD_SERVER }, { serverName: PLUGIN_SERVER }], 'names exactly as listed')
  assert.deepEqual(mainSettings.skillOverrides, { 'seeded-skill': 'off' })
  assert.deepEqual(mainSettings.enabledPlugins, { [PLUGIN]: false })
  const hooksText = JSON.stringify(mainSettings.hooks)
  assert.ok(hooksText.includes('echo agent-hook'), "the agent's own hook is in")
  assert.ok(hooksText.includes('ZUMIBOT_PAUSE_FILE'), "and ZumiBot's pause hook still is")
  assert.ok(
    Object.keys(mainSettings).every((k) => ['deniedMcpServers', 'skillOverrides', 'enabledPlugins', 'hooks', 'permissions'].includes(k)),
    `no other agent key reaches the settings: ${Object.keys(mainSettings)}`
  )

  seen = (await invocations()).length
  await rpc.rpc('btw:ask', chat.id, 'a quick side question', randomUUID())
  const side = (await runAfter(seen, (i) => i.args.includes('--no-session-persistence'))).args
  assert.equal(flagValue(side, '--agent'), AGENT)
  assert.deepEqual(side.slice(side.indexOf('--disallowedTools') + 1), BELT, 'the side run has the same belt')
  assert.equal(side.filter((a) => a === '--settings').length, 1, 'ONE --settings in the side run too')
  const sideSettings = JSON.parse(flagValue(side, '--settings'))
  for (const key of ['deniedMcpServers', 'skillOverrides', 'enabledPlugins'])
    assert.deepEqual(sideSettings[key], mainSettings[key], `the side run's ${key}`)
  assert.ok(JSON.stringify(sideSettings.hooks).includes('echo agent-hook'), "the side run has the agent's hook")
  assert.ok(JSON.stringify(sideSettings.hooks).includes('No tools in a side answer'), 'and its own tool guard')
  await until(
    async () => (await rpc.rpc('btw:list', chat.id)).every((e) => e.status !== 'running' && e.status !== 'pending'),
    'the side answer to finish'
  )
  pass(
    "8 the next run has --disallowedTools for each off server and ONE --settings with deniedMcpServers, skillOverrides, enabledPlugins, the agent's hook and ZumiBot's pause hook; the /btw run has the same"
  )

  // ---- 9 Vault: an own server's header picks a key; argv holds only ${ZUMIBOT_MCP_VAULT_0}, the value only the run's env ----
  await rpc.rpc('vault:save', { kind: 'apiKey', name: KEY_NAME, agents: [AGENT], env: KEY_ENV, value: KEY_VALUE, description: '' })
  await openAgentStudio(page, AGENT)
  await page.locator(tid('agent-own-server-add')).click()
  await page.getByLabel('Name', { exact: true }).fill('vault-srv')
  await pickOption(page.locator(tid('ext-form-transport')), 'http')
  await page.getByLabel('URL').fill('https://example.invalid/mcp')
  await page.locator(tid('ext-form-headers-add')).click()
  await page.getByLabel('Headers: name 1').fill('Authorization')
  await page.getByLabel('Headers: value 1', { exact: true }).fill('Bearer ')
  await pickOption(page.getByLabel('Headers: value 1 from Vault'), KEY_ENV)
  assert.equal(
    await page.getByLabel('Headers: value 1', { exact: true }).inputValue(),
    `Bearer \${vault:${KEY_ENV}}`,
    'the picker writes a reference, not the value'
  )
  await page.locator(tid('ext-form-save')).click()
  await page.locator(tid('ext-server-form')).waitFor({ state: 'detached', timeout: T })
  await saveAgent(page)
  await until(
    async () => (await readFile(join(agentsDir, `${AGENT}.md`), 'utf8')).includes('vault-srv'),
    'the agent file to hold the own server'
  )
  const agentText = await readFile(join(agentsDir, `${AGENT}.md`), 'utf8')
  assert.ok(agentText.includes(`\${vault:${KEY_ENV}}`) && !agentText.includes(KEY_VALUE), 'the file holds the reference, never the value')
  await noteText()

  seen = (await invocations()).length
  rpc.rpc('chats:send', chat.id, 'with the key', []).catch(() => {})
  const withKey = (await runAfter(seen, (i) => !i.args.includes('--no-session-persistence'))).args
  assert.ok(!(await invocations()).slice(seen).some((i) => JSON.stringify(i.args).includes(KEY_VALUE)), 'the key value is in no argument')
  const ownConfig = allFlag(withKey, '--mcp-config')
    .map((c) => JSON.parse(c))
    .find((c) => 'vault-srv' in c.mcpServers)
  assert.ok(ownConfig, 'the own server is in --mcp-config')
  assert.deepEqual(ownConfig.mcpServers['vault-srv'], {
    type: 'http',
    url: 'https://example.invalid/mcp',
    headers: { Authorization: 'Bearer ${ZUMIBOT_MCP_VAULT_0}' }
  })
  assert.equal((await readJson(envDump)).ZUMIBOT_MCP_VAULT_0, KEY_VALUE, "the value is in the run's env")
  await idle(chat.id)
  seen = (await invocations()).length
  await rpc.rpc('btw:ask', chat.id, 'another side question', randomUUID())
  const sideKey = (await runAfter(seen, (i) => i.args.includes('--no-session-persistence'))).args
  assert.ok(
    allFlag(sideKey, '--mcp-config').some((c) => c.includes('${ZUMIBOT_MCP_VAULT_0}')),
    'the side run starts the own server too'
  )
  assert.equal((await readJson(envDump)).ZUMIBOT_MCP_VAULT_0, KEY_VALUE, 'with the value in its env')
  assert.ok(!JSON.stringify(sideKey).includes(KEY_VALUE), 'never in its argv')
  await until(
    async () => (await rpc.rpc('btw:list', chat.id)).every((e) => e.status !== 'running' && e.status !== 'pending'),
    'the second side answer to finish'
  )

  // Revoke the grant: the next run and the next side question start no such server, with no value in their env.
  const item = (await rpc.rpc('vault:list')).find((i) => i.kind === 'apiKey')
  await rpc.rpc('vault:save', { id: item.id, kind: 'apiKey', name: KEY_NAME, agents: [], env: KEY_ENV, description: '' }, item.updatedAt)
  seen = (await invocations()).length
  rpc.rpc('chats:send', chat.id, 'after revoke', []).catch(() => {})
  const revoked = (await runAfter(seen, (i) => !i.args.includes('--no-session-persistence'))).args
  assert.ok(!JSON.stringify(revoked).includes('vault-srv'), 'a revoked key drops the server from the run')
  assert.equal((await readJson(envDump)).ZUMIBOT_MCP_VAULT_0, undefined, 'and its value from the env')
  assert.ok(JSON.stringify(revoked).includes('echo agent-hook'), "the agent's other choices still apply")
  await idle(chat.id)
  seen = (await invocations()).length
  await rpc.rpc('btw:ask', chat.id, 'side question after revoke', randomUUID())
  const sideRevoked = (await runAfter(seen, (i) => i.args.includes('--no-session-persistence'))).args
  assert.ok(!JSON.stringify(sideRevoked).includes('vault-srv'), 'the side run drops it too')
  assert.equal((await readJson(envDump)).ZUMIBOT_MCP_VAULT_0, undefined)
  await until(
    async () => (await rpc.rpc('btw:list', chat.id)).every((e) => e.status !== 'running' && e.status !== 'pending'),
    'the third side answer to finish'
  )
  // The card tells why, and the file keeps the server.
  await openAgentStudio(page, AGENT)
  const ownRow = page.locator(`${tid('agent-own-server')}[data-name="vault-srv"]`)
  await ownRow.waitFor({ timeout: T })
  // The row draws at once from the file; the reason comes with the probe that follows.
  await until(
    async () => new RegExp(`no Vault key ${KEY_ENV} is granted`).test(await ownRow.innerText()),
    'the card to say why the server was not started'
  )
  assert.ok((await readFile(join(agentsDir, `${AGENT}.md`), 'utf8')).includes('vault-srv'), 'the agent file still has it')
  await noteText()
  pass(
    "9 an own server's Vault header is ${ZUMIBOT_MCP_VAULT_0} in argv with the value only in the run and side-run env; revoking the grant drops the server and its env from the next run and side question, and the card says why"
  )

  // ---- 10 nothing leaked, nothing unexpected failed ----
  await idle(chat.id)
  const secrets = [
    ['seeded env value', SEEDED],
    ['typed env value', TYPED],
    ['vault key value', KEY_VALUE]
  ]
  const finalText = await page.locator('body').innerText()
  const places = [
    ['server log', [...h.output, ...h.errors].join('\n')],
    ['the CLI log', await readFile(cliLog, 'utf8')],
    ["the page's socket, received", pageWire.join('\n')],
    ["the page's socket, sent", pageSent.join('\n'), TYPED],
    ['the raw socket', rpc.wire.join('\n')],
    ['page text', [...pageTexts, finalText].join('\n')]
  ]
  // The data folder, the agents folder and the temp HOME, minus what must hold a secret: the vault key itself, the seeded
  // ~/.claude.json (the user's own file) and the sealed vault, which may only hold the key's value encrypted.
  const skip = (p) =>
    p.startsWith(join(h.root, 'vault-key')) || p === join(home, '.claude.json') || p.includes(`${join(h.dataDir, 'browsers')}/`)
  const files = await filesUnder(h.root, skip)
  assert.ok(
    files.some((f) => f.endsWith('vault.json')),
    'the sealed vault was scanned'
  )
  for (const f of files) places.push([`file ${relative(h.root, f)}`, await readFile(f, 'latin1')])
  // Outside the harness root too: the argv logs of every CLI start and the agent file as the suite left it (a Vault reference, no value).
  for (const f of [invLog, startLog, join(agentsDir, `${AGENT}.md`)]) {
    assert.ok(await exists(f), `${relative(root, f)} was written`)
    places.push([relative(root, f), await readFile(f, 'latin1')])
  }
  // Positive controls: the scans above read what the page really got and sent, not empty captures.
  assert.ok(pageWire.length > 0 && pageWire.join('\n').includes('seeded-skill'), "the page socket capture holds the server's answers")
  assert.ok(pageSent.length > 0 && pageSent.join('\n').includes('extensions:loadout'), "the page socket capture holds the page's requests")
  assert.ok(
    (await readFile(join(agentsDir, `${AGENT}.md`), 'utf8')).includes('${vault:'),
    'the agent file holds the Vault reference the scan expects'
  )
  // A place may name a value it holds by design.
  const found = places.flatMap(([where, text, allowed]) =>
    secrets.filter(([, v]) => v !== allowed && text.includes(v)).map(([what]) => `${what} in ${where}`)
  )
  assert.deepEqual(found, [], 'secrets reached a place they must not')
  // The server's one deliberate log line for a server left out of a run (names and a reason code, no value).
  const unexpected = unexpectedErrors(h.errors, [/^server stderr: agent servers left out of this run: vault-srv \(vault-missing\)$/])
  assert.deepEqual(unexpected, [], 'no console or server errors')
  rpc.close()
  pass(
    `10 none of the seeded, typed or Vault values is in the server log, the CLI log, either socket, the page text or ${files.length} files under the temp root; no console or server error`
  )
  console.log(JSON.stringify({ result: 'PASS', suite: 'extensions' }))
} catch (error) {
  if (h) console.error(JSON.stringify({ errors: h.errors.slice(-10) }))
  throw error
} finally {
  await h?.stop()
  await rm(root, { recursive: true, force: true })
}

// Every CLI the suite started is gone: a hung probe or a side run would show here.
// Anchored at the start of the command line, so a shell or editor that merely names the fixture is not counted.
const alive = () =>
  spawnSync('pgrep', ['-f', `^${process.execPath} ${FAKE}`])
    .stdout.toString()
    .trim()
for (let i = 0; i < 50 && alive() !== ''; i++) await sleep(100)
assert.equal(alive(), '', 'no fake-extensions-claude process is left')
