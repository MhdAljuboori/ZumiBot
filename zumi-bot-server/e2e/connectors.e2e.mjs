// Settings › Connectors against the built server and web UI. No quota and no claude.ai account: claude is
// backend/tests/fixtures/fake-extensions-claude.mjs (its mcp_status answers claudeai-proxy servers from a state file; with
// FAKE_EXT_ALLOW_TURN a chat turn runs fake-claude.mjs), codex is not started, and HOME is the harness's throwaway one.
// The harness gets `connectors: null`, so the first-start switch-over really runs.
// Covered: 1 the switch-over writes connectors.json (0600) from what each Claude agent could use (an agent's off list kept, Codex
// agents and Zumi Bot left out); 2 Ctrl+K opens the page, which shows 7 cards in the states the fake reports, unknown tools, the
// directory link, GitHub's custom-connector URL, and no switch for a Codex agent; 3 switches write the file and a second tab follows
// (connectors:changed); 4 the next run's ONE --settings denies by URL (and name) every connector that is not on, with the belt and
// the file guard; 5 coming back to the tab re-reads the connectors; 6 Agent Studio's connector row links here instead of switching,
// and Settings › Claude Code links here; 7 with a key variable in the server's env the page names the variable and no value leaks
// anywhere; 8 a probe that fails at the switch-over leaves every connector off and the page says why.
// Phase 3 (writes ask), a fresh server with Gmail on for the agent and Slack off, driven with fake-claude scripts of can_use_tool
// requests (#MCP_CALL with a `permission` id; the answer is read from FAKE_RESPONSES_FILE): 9 the run's one --settings holds
// permissions.ask for Gmail only, beside the file guard; 10 a Gmail read in a chat is allowed with no card; 11 a Gmail write shows the
// connector card (head, "As connected on claude.ai", the input) with Allow once and Deny only, and Allow once answers allow; 12 turning
// Remember on for Gmail writes connectors.json, a new card then offers Allow always, and the next turn's same call is auto-allowed;
// 13 a routine's Run now: its Gmail read is allowed, its write is denied with the exact sentence, and no card is ever made.
// Setup that is not the point (chats) goes over raw /ws RPCs; the rest is clicked.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { start, unexpectedErrors } from './harness.mjs'

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
const readJson = (path) => readFile(path, 'utf8').then(JSON.parse)
const flagValue = (args, flag) => args[args.indexOf(flag) + 1]

// Synthetic: must reach no page, log, file or argv.
const KEY_VALUE = 'sk-e2e-not-a-real-key'
const KEY_VAR = 'ANTHROPIC_API_KEY'
// None of the three may come from the developer's own environment (the harness passes the rest through); undefined removes it.
const NO_KEYS = { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined }

const AGENT = 'conn-agent'
const CODEX_AGENT = 'conn-codex'
const DRIVE_DIRECTORY = 'https://claude.ai/directory/b89f7865-a755-4f86-8062-c3bd651740ce'

const proxy = (name, url, status, tools = []) => ({
  name,
  status,
  scope: 'claudeai',
  transport: 'claudeai-proxy',
  config: { type: 'claudeai-proxy', url, id: `mcpsrv_${name.length}` },
  tools: tools.map((t) => ({ name: t }))
})
const SEED_STATE = {
  version: '9.9.9-fake',
  mcpServers: [
    proxy('claude.ai Gmail', 'https://gmailmcp.googleapis.com/mcp/v1', 'connected', ['search_threads', 'send_message', 'brand_new']),
    proxy('claude.ai Notion', 'https://mcp.notion.com/mcp', 'needs-auth'),
    proxy('claude.ai Slack (2)', 'https://mcp.slack.com/mcp', 'connected'),
    // A custom connector the user typed the name of: matched by URL only.
    proxy('My GitHub', 'https://api.githubcopilot.com/mcp/', 'connected'),
    // Not a catalog server (yet): its URL is nobody's
    proxy('claude.ai Fake Drive', 'https://example.invalid/mcp', 'connected')
  ],
  skills: [],
  hooks: [],
  plugins: []
}

const root = await mkdtemp(join(tmpdir(), 'cb-conn-e2e-'))
const out = join(root, 'out')
const project = join(root, 'project')
const agentsDir = join(root, 'agents')
const dataDir = join(root, 'data')
const statePath = join(out, 'state.json')
const invLog = join(out, 'inv.jsonl')
const respFile = join(out, 'responses.jsonl')
// Every harness this suite started: its errors and server output are checked at the end.
const harnesses = []
let h = null

const readState = () => readJson(statePath)
const editState = async (fn) => {
  const s = await readState()
  fn(s)
  await writeFile(statePath, JSON.stringify(s, null, 2))
}
const invocations = () => readLines(invLog)
const connectorsFile = (d) => join(d, 'connectors.json')

const baseEnv = (extra) => ({
  FAKE_EXT_STATE: statePath,
  FAKE_EXT_ALLOW_TURN: '1',
  FAKE_INVOCATIONS_OUT: invLog,
  FAKE_RESPONSES_FILE: respFile,
  CLAUDE_CONFIG_DIR: undefined,
  XDG_DATA_HOME: undefined,
  ...NO_KEYS,
  ...extra
})
const begin = async (opts = {}) => {
  h = await start({ mode: 'local', fake: FAKE, agentsDir, connectors: null, ...opts, env: baseEnv(opts.env) })
  harnesses.push(h)
  return h
}

async function connect(hh) {
  const cookie = (await hh.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
  const ws = new WebSocket(hh.origin.replace('http', 'ws') + '/ws', { headers: { Origin: hh.origin, Cookie: cookie } })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let id = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const value = JSON.parse(String(raw))
    if (pending.has(value.id)) {
      pending.get(value.id)(value)
      pending.delete(value.id)
    }
  })
  ws.on('error', () => {})
  return {
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

const card = (page, id) => page.locator(`${tid('connector-card')}[data-id="${id}"]`)
const switchOf = (page, id, agent = AGENT) => card(page, id).locator(`${tid('connector-switch')}[data-agent="${agent}"]`)
const states = async (page) =>
  Object.fromEntries(await page.locator(tid('connector-card')).evaluateAll((els) => els.map((e) => [e.dataset.id, e.dataset.state])))
async function openConnectors(page, origin = h.origin) {
  await page.goto(`${origin}/settings/connectors`)
  await page.locator(tid('connectors-page')).waitFor({ timeout: T })
  await card(page, 'gmail').waitFor({ timeout: T })
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

try {
  await mkdir(out, { recursive: true })
  await mkdir(project, { recursive: true })
  await mkdir(join(project, '.git'))
  await mkdir(agentsDir, { recursive: true })
  await writeFile(statePath, JSON.stringify(SEED_STATE, null, 2))
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Connectors e2e agent.\nmodel: haiku\nserversOff:\n  - claude.ai Notion\n---\nYou are a test agent.\n`
  )
  await writeFile(
    join(agentsDir, `${CODEX_AGENT}.md`),
    `---\nname: ${CODEX_AGENT}\ndescription: Connectors e2e Codex agent.\nprovider: codex\n---\nYou are a Codex test agent.\n`
  )

  await begin({ dataDir })
  const page = h.page
  const file = connectorsFile(dataDir)

  // ---- 1 the first-start switch-over keeps what the Claude agent could use ----
  // Gmail, GitHub and Slack are connected and not in its off list; Notion is in it; Drive's server is no catalog entry; the Codex agent
  // and Zumi Bot never get a switch.
  const stored = await until(async () => readJson(file), 'connectors.json to be written by the switch-over')
  assert.deepEqual(stored, { v: 1, agents: { [AGENT]: ['gmail', 'github', 'slack'] }, migration: 'kept', remember: {} })
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'connectors.json is private to the user')
  pass(
    '1 the first-start switch-over wrote connectors.json (0600) with gmail, github and slack on for conn-agent and nothing for the Codex agent or Zumi Bot, migration kept'
  )

  // ---- 2 Ctrl+K opens the page; the cards show the fake's states ----
  await page.goto(h.origin)
  await page.locator(tid('agent-row')).first().waitFor({ timeout: T })
  await page.keyboard.press('Control+k')
  await page.locator(tid('palette-input')).fill('gmail')
  const item = page.locator(`${tid('palette-item')}[data-key="settings:connectors"]`)
  await item.waitFor({ timeout: T })
  assert.match(await item.innerText(), /Connectors/)
  await page.keyboard.press('Enter')
  await page.locator(tid('connectors-page')).waitFor({ timeout: T })
  assert.equal(new URL(page.url()).pathname, '/settings/connectors', 'Ctrl+K opened the section at its own address')
  await card(page, 'gmail').waitFor({ timeout: T })
  assert.equal(await page.locator(tid('connector-card')).count(), 7, 'one card per catalog connector')
  // The page asks the CLI: the states settle once the probe answered
  await until(async () => (await states(page)).gmail === 'connected', "the page to show the fake's answer")
  assert.deepEqual(await states(page), {
    gmail: 'connected',
    'google-calendar': 'not-connected',
    'google-drive': 'not-connected',
    notion: 'needs-attention',
    github: 'connected',
    slack: 'connected',
    linear: 'not-connected'
  })
  assert.equal(await page.locator(tid('connector-keyvar')).count(), 0, 'no key variable, no notice')
  assert.equal(await page.locator(tid('connector-migration')).count(), 0, 'the switch-over settled, so no migration note')
  assert.match(
    await page.locator(tid('connector-cache-note')).innerText(),
    /re-read its whole context once/,
    'the cache note shows once under the intro lines'
  )
  assert.equal(await page.locator(tid('connector-cache-note')).count(), 1)
  assert.match(
    await card(page, 'gmail').locator(tid('connector-unknown')).innerText(),
    /brand_new/,
    'a tool the catalog does not know is named on the Gmail card'
  )
  assert.equal(await page.locator(tid('connector-unknown')).count(), 1, 'and on no other card')
  assert.equal(
    await card(page, 'google-drive').locator(tid('connector-action')).getAttribute('href'),
    DRIVE_DIRECTORY,
    "Drive's Connect opens its directory page"
  )
  assert.equal((await card(page, 'google-drive').locator(tid('connector-action')).innerText()).trim(), 'Connect')
  assert.equal((await card(page, 'notion').locator(tid('connector-action')).innerText()).trim(), 'Reconnect')
  assert.equal((await card(page, 'gmail').locator(tid('connector-action')).innerText()).trim(), 'Manage on claude.ai')
  assert.equal(await card(page, 'github').locator(tid('connector-copy')).count(), 1, 'GitHub has a Copy button')
  assert.match(
    await card(page, 'github').innerText(),
    /https:\/\/api\.githubcopilot\.com\/mcp\//,
    'and shows the URL to add as a custom connector'
  )
  assert.equal(await switchOf(page, 'gmail').count(), 1, 'the Claude agent has a switch')
  assert.equal(await switchOf(page, 'gmail').getAttribute('data-on'), 'true')
  assert.equal(await switchOf(page, 'notion').getAttribute('data-on'), 'false', 'Notion was in its off list, so it did not carry over')
  assert.equal(await page.locator(`${tid('connector-switch')}[data-agent="${CODEX_AGENT}"]`).count(), 0, 'a Codex agent has no switch')
  assert.equal(await page.locator(`${tid('connector-switch')}:not([data-agent="${AGENT}"])`).count(), 0, 'and neither does Zumi Bot')
  assert.match(
    await page.locator(tid('connectors-page')).innerText(),
    /Codex agents cannot use claude\.ai connectors\./,
    'the Codex sentence shows'
  )
  assert.match(await card(page, 'gmail').innerText(), /On for conn-agent/)
  pass(
    "2 Ctrl+K \"gmail\" opens /settings/connectors: 7 cards in the fake's states, brand_new unknown on Gmail, Drive's directory link, GitHub's Copy and URL, no switch for the Codex agent and the Codex sentence"
  )

  // ---- 3 switches: Notion on, Gmail off; the file follows and a second tab sees it ----
  const second = await h.newPage()
  await openConnectors(second)
  await until(async () => (await switchOf(second, 'gmail').getAttribute('data-on')) === 'true', 'the second tab to load the switches')
  await switchOf(page, 'notion').click()
  await until(async () => (await readJson(file)).agents[AGENT]?.join() === 'gmail,notion,github,slack', 'Notion to be on in the file')
  await until(async () => await switchOf(page, 'gmail').isEnabled(), 'the switch to be usable again')
  await switchOf(page, 'gmail').click()
  await until(async () => (await readJson(file)).agents[AGENT]?.join() === 'notion,github,slack', 'Gmail to be off in the file')
  assert.deepEqual(await readJson(file), { v: 1, agents: { [AGENT]: ['notion', 'github', 'slack'] }, migration: 'kept', remember: {} })
  assert.equal((await stat(file)).mode & 0o777, 0o600, 'still 0600 after a write')
  await until(
    async () =>
      (await switchOf(second, 'notion').getAttribute('data-on')) === 'true' &&
      (await switchOf(second, 'gmail').getAttribute('data-on')) === 'false',
    'the second tab to follow the change'
  )
  await second.close()
  pass('3 Notion on and Gmail off for conn-agent: connectors.json follows (catalog order, 0600) and a second tab shows both changes')

  // ---- 4 the next run denies every connector that is not on ----
  const rpc = await connect(h)
  const chat = await rpc.rpc('chats:create', AGENT, project)
  const idle = (id) => until(async () => (await rpc.rpc('chats:list')).find((c) => c.id === id && !c.inFlight), 'the chat to be idle')
  const seen = (await invocations()).length
  rpc.rpc('chats:send', chat.id, 'hello', []).catch(() => {})
  const main = (
    await until(
      async () => (await invocations()).slice(seen).find((i) => !i.args.includes('--no-session-persistence')),
      'the CLI to be started for the turn'
    )
  ).args
  await idle(chat.id)
  assert.equal(flagValue(main, '--agent'), AGENT)
  assert.equal(main.filter((a) => a === '--settings').length, 1, 'ONE --settings')
  const settings = JSON.parse(flagValue(main, '--settings'))
  const urls = settings.deniedMcpServers.flatMap((e) => (e.serverUrl ? [e.serverUrl] : []))
  const hosts = urls.map((u) => new URL(u.replace('*', 'x')).host).sort()
  assert.deepEqual(
    hosts,
    [
      'calendarmcp.googleapis.com',
      'drivemcp.googleapis.com',
      'gcal.mcp.claude.com',
      'gmail.mcp.claude.com',
      'gmailmcp.googleapis.com',
      'mcp.linear.app'
    ],
    'serverUrl entries for gmail, google-calendar, google-drive and linear only'
  )
  assert.ok(
    urls.every((u) => u.startsWith('https://')),
    'every pattern is https'
  )
  for (const on of ['mcp.notion.com', 'api.githubcopilot.com', 'mcp.slack.com'])
    assert.ok(!urls.some((u) => u.includes(on)), `no pattern for ${on}: that connector is on`)
  const names = settings.deniedMcpServers.flatMap((e) => (e.serverName ? [e.serverName] : []))
  for (const n of ['claude.ai Gmail', 'claude.ai Google Calendar', 'claude.ai Google Drive', 'claude.ai Linear'])
    assert.ok(names.includes(n), `${n} is denied by name too`)
  assert.ok(!names.includes('claude.ai Slack'), 'the Slack connector is on, so not denied')
  const belt = main.slice(main.indexOf('--disallowedTools') + 1)
  assert.ok(belt.includes('mcp__claude_ai_Gmail'), 'the belt has Gmail')
  assert.ok(!belt.includes('mcp__claude_ai_Slack'), 'and not Slack, which is on')
  // The agent's own off list is honoured too (off wins): Notion's switch is on, but its file still lists the server off.
  assert.ok(
    names.includes('claude.ai Notion') && belt.includes('mcp__claude_ai_Notion'),
    "a server in the agent's own off list stays denied by name (off wins)"
  )
  assert.ok(!urls.some((u) => u.includes('notion')), 'while the Notion switch keeps its URL pattern out')
  assert.ok(settings.permissions.deny.includes(`Edit(/${join(dataDir, 'connectors.json')})`), 'connectors.json is behind a deny rule')
  for (const tool of ['Read', 'Edit', 'MultiEdit', 'Write', 'Grep', 'Glob'])
    assert.ok(settings.permissions.deny.includes(`${tool}(/${file})`), `${tool} of connectors.json is denied`)
  rpc.close()
  pass(
    '4 the next run has ONE --settings with serverUrl entries for gmail, google-calendar, google-drive and linear (none for notion, github, slack), their names and belts, and deny rules on connectors.json'
  )

  // ---- 5 coming back to the tab re-reads the connectors ----
  await openConnectors(page)
  await until(async () => (await states(page))['google-drive'] === 'not-connected', 'the page to show Drive as not connected')
  await editState((s) => {
    s.mcpServers.find((x) => x.name === 'claude.ai Fake Drive').config.url = 'https://drivemcp.googleapis.com/mcp/v1'
  })
  // The page ignores a return within 5 s of its last read
  await sleep(5500)
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await until(async () => (await states(page))['google-drive'] === 'connected', 'Drive to turn connected after the tab came back')
  assert.equal((await card(page, 'google-drive').locator(tid('connector-action')).innerText()).trim(), 'Manage on claude.ai')
  pass('5 the fake reports Drive on its Google URL and a visibilitychange makes its card connected')

  // ---- 6 links between the pages ----
  await openAgentStudio(page, AGENT)
  const gmailRow = page.locator(`${tid('agent-ext-server')}[data-name="claude.ai Gmail"]`)
  await gmailRow.waitFor({ timeout: T })
  assert.equal(await gmailRow.locator(tid('agent-ext-connector-link')).count(), 1, 'a connector row has the link')
  assert.equal(await gmailRow.locator(tid('agent-ext-switch')).count(), 0, 'and no switch')
  await gmailRow.locator(tid('agent-ext-connector-link')).click()
  await page.locator(tid('connectors-page')).waitFor({ timeout: T })
  assert.equal(new URL(page.url()).pathname, '/settings/connectors', 'the link opens the Connectors page')
  await page.goto(`${h.origin}/settings/claude-code`)
  await page.locator(tid('ext-connectors-link')).waitFor({ timeout: T })
  await page.locator(tid('ext-connectors-link')).click()
  await page.locator(tid('connectors-page')).waitFor({ timeout: T })
  assert.equal(new URL(page.url()).pathname, '/settings/connectors', "and so does the Servers tab's link")
  await page.locator(tid('connectors-to-claude-code')).click()
  await page.locator(tid('settings-claude-code')).waitFor({ timeout: T })
  pass("6 Agent Studio's Gmail row has the link and no switch and opens Connectors; Claude Code's Servers tab links there and back")

  // ---- 7 a key variable in the server's env: named, never its value ----
  const pageTexts = []
  await h.stop()
  await begin({ dataDir, env: { [KEY_VAR]: KEY_VALUE } })
  const page7 = h.page
  const wire = []
  page7.on('websocket', (ws) => ws.on('framereceived', (f) => wire.push(String(f.payload))))
  await openConnectors(page7)
  const notice = page7.locator(tid('connector-keyvar'))
  await notice.waitFor({ timeout: T })
  assert.match(await notice.innerText(), new RegExp(KEY_VAR), 'the notice names the variable')
  pageTexts.push(await page7.locator('body').innerText())
  // The cards still render (the fake answers regardless), so the notice is page-wide, not a blank page
  assert.equal(await page7.locator(tid('connector-card')).count(), 7)
  const leaks = [
    ['the page text', pageTexts.join('\n')],
    ["the page's socket", wire.join('\n')],
    ['connectors.json', await readFile(file, 'utf8')],
    ['the server log', [...h.output, ...h.errors].join('\n')],
    ["the first run's server log", [...harnesses[0].output, ...harnesses[0].errors].join('\n')],
    ['the CLI argv log', await readFile(invLog, 'utf8')]
  ]
  assert.ok(wire.length > 0 && wire.join('\n').includes('keyVar'), "the socket capture holds the server's answer, which names the variable")
  assert.deepEqual(
    leaks.filter(([, text]) => text.includes(KEY_VALUE)).map(([where]) => where),
    [],
    'the key value reached a place it must not'
  )
  pass(
    `7 with ${KEY_VAR} in the server's env the page names the variable; its value is in no page text, socket frame, connectors.json, server log or argv`
  )

  // ---- 8 the switch-over's probe fails: every connector off, the page says why ----
  await h.stop()
  const freshData = join(root, 'data-failed')
  await mkdir(freshData, { recursive: true })
  await begin({ dataDir: freshData, env: { FAKE_EXT_ERROR_SUBTYPES: 'mcp_status' } })
  const failed = await until(async () => readJson(connectorsFile(freshData)), 'connectors.json to be written after the failed probe')
  assert.deepEqual(failed, { v: 1, agents: {}, migration: 'failed', remember: {} })
  const page8 = h.page
  await openConnectors(page8)
  const note = page8.locator(tid('connector-migration'))
  await note.waitFor({ timeout: T })
  assert.match(await note.innerText(), /could not list your connectors/, 'the failure sentence shows')
  assert.ok((await page8.locator(tid('connector-switch')).count()) > 0, 'the switches are there')
  assert.deepEqual(
    await page8.locator(tid('connector-switch')).evaluateAll((els) => [...new Set(els.map((e) => e.dataset.on))]),
    ['false'],
    'every connector is off for every agent'
  )
  pass(
    '8 a failing probe at the switch-over writes migration failed with no switches on, and the page shows the failure sentence with every switch off'
  )

  // ---- 9 to 13: writes ask (phase 3) ----
  // A fresh server with Gmail on for the agent and Slack (and every other connector) off, Remember off.
  await h.stop()
  const askData = join(root, 'data-ask')
  await begin({ dataDir: askData, connectors: { v: 1, agents: { [AGENT]: ['gmail'] }, migration: 'kept' } })
  const askFile = connectorsFile(askData)
  const page9 = h.page
  const rpc9 = await connect(h)
  const chat9 = await rpc9.rpc('chats:create', AGENT, project)
  const idle9 = () => until(async () => (await rpc9.rpc('chats:list')).find((c) => c.id === chat9.id && !c.inFlight), 'the chat to be idle')
  const SID = 'conn-e2e-session'
  const line = (o) => JSON.stringify(o)
  const initLine = line({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-haiku-5-5', permissionMode: 'default' })
  const say = (text) =>
    line({
      type: 'assistant',
      message: {
        model: 'claude-haiku-5-5',
        id: `msg_${text.length}`,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text }],
        stop_reason: null,
        usage: { input_tokens: 2, output_tokens: 2 }
      },
      parent_tool_use_id: null,
      session_id: SID
    })
  const resultLine = (text) => line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: SID })
  // A claude.ai Gmail tool call as the CLI makes it: tool_use, a can_use_tool request (req-<id>) it waits on, then the result (an
  // error here: the fake has no Gmail server, which is fine, since only the answer matters).
  const gmail = (tool, args, id) => `#MCP_CALL ${line({ server: 'claude_ai_Gmail', tool, args, id, permission: `req-${id}` })}`
  const turnOf = (calls, reply) => writeFile(h.script, [initLine, ...calls, say(reply), resultLine(reply)].join('\n') + '\n')
  const answerTo = async (id) => (await readLines(respFile)).find((m) => m.response?.request_id === `req-${id}`)?.response?.response ?? null
  const answered = (id) => until(() => answerTo(id), `the fake to be answered req-${id}`)
  const approvals = async (chatId) => (await rpc9.rpc('chats:items', chatId)).items.filter((i) => i.type === 'approval')
  const WRITE = { to: 'dana@example.com', subject: 'Status', body: 'Shipped today' }
  const REFUSAL =
    'Gmail send_message changes data outside this machine. Runs started by a routine or workflow may only read; ask the user to do this in a chat.'
  const cardOf = (id) => page9.locator(`${tid('approval-card')}[data-request-id="req-${id}"]`)
  await page9.goto(`${h.origin}/chat/${encodeURIComponent(chat9.id)}`)
  await page9.locator(tid('composer-input')).waitFor({ timeout: T })

  // ---- 9 the run's one --settings asks for every tool of a connector that is on ----
  const seen9 = (await invocations()).length
  rpc9.rpc('chats:send', chat9.id, 'hello', []).catch(() => {})
  const main9 = (
    await until(
      async () => (await invocations()).slice(seen9).find((i) => !i.args.includes('--no-session-persistence')),
      'the CLI to be started for the turn'
    )
  ).args
  await idle9()
  assert.equal(main9.filter((a) => a === '--settings').length, 1, 'ONE --settings')
  const settings9 = JSON.parse(flagValue(main9, '--settings'))
  assert.ok(settings9.permissions.ask.includes('mcp__claude_ai_Gmail__*'), 'Gmail is on, so its tools ask')
  assert.ok(
    !settings9.permissions.ask.some((r) => /Slack|GitHub|Notion|Linear|Drive|Calendar/.test(r)),
    'no ask rule for a connector that is off'
  )
  assert.ok(
    settings9.permissions.deny.includes(`Edit(/${askFile})`) && settings9.permissions.deny.includes(`Read(/${askFile})`),
    'the file guard is still in the same settings'
  )
  pass(
    "9 the run's ONE --settings has permissions.ask mcp__claude_ai_Gmail__* (Gmail is on) and none for Slack or the other connectors that are off, beside the connectors.json deny rules"
  )

  // ---- 10 a read in an attended chat is allowed with no card ----
  await turnOf([gmail('list_labels', {}, 'toolu_read')], 'Read done.')
  rpc9.rpc('chats:send', chat9.id, 'list my labels', []).catch(() => {})
  assert.equal((await answered('toolu_read')).behavior, 'allow', 'the read was answered allow')
  await idle9()
  assert.equal((await approvals(chat9.id)).length, 0, 'no card was made for the read')
  assert.equal(await page9.locator(tid('approval-card')).count(), 0, 'and none is on the page')
  pass('10 a Gmail read in a chat is answered allow and makes no card')

  // ---- 11 a write shows the connector card: Allow once and Deny only (Remember is off) ----
  await turnOf([gmail('send_message', WRITE, 'toolu_w1')], 'Sent.')
  rpc9.rpc('chats:send', chat9.id, 'send the status mail', []).catch(() => {})
  const card1 = cardOf('toolu_w1')
  await card1.waitFor({ timeout: T })
  assert.equal(await card1.getAttribute('data-status'), 'pending')
  assert.match(await card1.locator('.approval-head').innerText(), /Gmail · Send message/, 'the head names the service and the tool')
  assert.equal((await card1.locator(tid('approval-connector')).innerText()).trim(), 'As connected on claude.ai')
  assert.match(
    await card1.locator('.tool-panel').innerText(),
    /dana@example\.com[\s\S]*Shipped today/,
    'the input is open, as the write would send it'
  )
  assert.equal(await card1.locator(tid('approval-allow-once')).count(), 1)
  assert.equal(await card1.locator(tid('approval-deny')).count(), 1)
  for (const id of ['approval-allow-chat', 'approval-allow-agent', 'approval-allow-step'])
    assert.equal(await card1.locator(tid(id)).count(), 0, `no ${id} while Remember is off`)
  assert.deepEqual(
    (await approvals(chat9.id)).find((a) => a.id === 'req-toolu_w1').connector,
    { id: 'gmail', tool: 'send_message', remember: false },
    'the card is stamped with the connector'
  )
  assert.equal(await answerTo('toolu_w1'), null, 'nothing answers the CLI before the user does')
  await card1.locator(tid('approval-allow-once')).click()
  assert.equal((await answered('toolu_w1')).behavior, 'allow', 'Allow once answers allow')
  await idle9()
  assert.equal((await approvals(chat9.id)).find((a) => a.id === 'req-toolu_w1').status, 'allowed-once')
  pass(
    '11 a Gmail write shows the card "Gmail · send_message" with "As connected on claude.ai" and its input, only Allow once and Deny (no chat, agent or step choice); Allow once answers allow'
  )

  // ---- 12 Remember: the switch lands in connectors.json, the next card offers Allow always, and the next call is auto-allowed ----
  await openConnectors(page9)
  const remember = page9.locator(`${tid('connector-remember')}[data-id="gmail"]`)
  await remember.waitFor({ timeout: T })
  assert.equal(await remember.getAttribute('data-on'), 'false', 'Remember starts off')
  assert.ok(!(await readJson(askFile)).remember?.gmail, 'connectors.json holds no remember for Gmail yet')
  assert.ok((await page9.locator(tid('connector-guard-note')).innerText()).length > 0, 'the guard note shows')
  await remember.click()
  await until(async () => (await readJson(askFile)).remember?.gmail === true, 'connectors.json to hold remember.gmail')
  await until(async () => (await remember.getAttribute('data-on')) === 'true', 'the switch to show on')
  assert.equal((await stat(askFile)).mode & 0o777, 0o600, 'still 0600')
  assert.deepEqual((await readJson(askFile)).agents, { [AGENT]: ['gmail'] }, 'the agent switches are untouched')
  await page9.goto(`${h.origin}/chat/${encodeURIComponent(chat9.id)}`)
  await page9.locator(tid('composer-input')).waitFor({ timeout: T })
  await turnOf([gmail('send_message', WRITE, 'toolu_w2')], 'Sent again.')
  rpc9.rpc('chats:send', chat9.id, 'send it again', []).catch(() => {})
  const card2 = cardOf('toolu_w2')
  await card2.waitFor({ timeout: T })
  assert.equal(await card2.locator(tid('approval-allow-chat')).count(), 1, 'Remember on: Allow for this chat is offered')
  assert.equal(await card2.locator(tid('approval-allow-step')).count(), 0, 'never a step')
  await card2.locator(tid('approval-allow-agent')).click()
  assert.equal((await answered('toolu_w2')).behavior, 'allow')
  await idle9()
  assert.equal((await approvals(chat9.id)).find((a) => a.id === 'req-toolu_w2').status, 'allowed-agent')
  await turnOf([gmail('send_message', { ...WRITE, subject: 'Another' }, 'toolu_w3')], 'Sent a third.')
  rpc9.rpc('chats:send', chat9.id, 'and once more', []).catch(() => {})
  assert.equal((await answered('toolu_w3')).behavior, 'allow', 'the same call is answered with no card')
  await idle9()
  assert.equal((await approvals(chat9.id)).find((a) => a.id === 'req-toolu_w3').status, 'auto-allowed-agent')
  assert.equal(await cardOf('toolu_w3').getAttribute('data-status'), 'auto-allowed-agent', 'the page shows it as auto-allowed')
  pass(
    "12 Remember for Gmail writes remember.gmail to connectors.json (0600), the next write card offers Allow for this chat and Allow always (never for a step), and Allow always makes the next turn's Gmail write auto-allowed-agent"
  )

  // ---- 13 an unattended run (a routine's Run now): reads allowed, a write refused with the exact sentence, no card ----
  await turnOf([gmail('list_labels', {}, 'toolu_u1'), gmail('send_message', WRITE, 'toolu_u2')], 'Routine done.')
  const routine = await rpc9.rpc('routines:save', {
    id: null,
    name: 'Mail check',
    enabled: true,
    timeZone: 'UTC',
    trigger: { kind: 'manual' },
    limitPolicy: 'wait',
    missedPolicy: 'run-once',
    sessionPolicy: 'continue',
    command: null,
    target: { kind: 'new-chat', agent: AGENT, cwd: project },
    prompt: 'Check the mail and answer.'
  })
  const run13 = await rpc9.rpc('routines:runNow', routine.id)
  await until(async () => (await rpc9.rpc('routines:list')).runs[routine.id]?.[0]?.status === 'done', 'the routine run to be done')
  assert.equal((await answered('toolu_u1')).behavior, 'allow', "the routine's read is answered allow")
  const refused = await answered('toolu_u2')
  assert.equal(refused.behavior, 'deny', "the routine's write is denied")
  assert.equal(refused.message, REFUSAL, 'with the exact refusal')
  assert.deepEqual(await approvals(run13.chatId), [], "no card was ever made in the routine's chat")
  const page13 = await h.newPage()
  await page13.goto(`${h.origin}/chat/${encodeURIComponent(run13.chatId)}`)
  await page13.locator(tid('composer-input')).waitFor({ timeout: T })
  assert.equal(await page13.locator(tid('approval-card')).count(), 0, 'and the chat shows none')
  await page13.close()
  rpc9.close()
  pass(
    '13 a routine\'s Run now: its Gmail read is answered allow, its send_message is denied with "Gmail send_message changes data outside this machine. Runs started by a routine or workflow may only read; ask the user to do this in a chat." and the run\'s chat holds no card'
  )

  // ---- end: nothing unexpected failed ----
  const allErrors = harnesses.flatMap((x) => x.errors)
  const unexpected = unexpectedErrors(allErrors, [
    /^server stderr: connectors: kept on-state for 1 agents$/,
    /^server stderr: connectors: switch-over probe failed, every connector starts off$/
  ])
  assert.deepEqual(unexpected, [], 'no console or server errors')
  pass('14 no unexpected console or server error in any of the servers')
  console.log(JSON.stringify({ result: 'PASS', suite: 'connectors' }))
} catch (error) {
  if (h) console.error(JSON.stringify({ errors: h.errors.slice(-10) }))
  throw error
} finally {
  await h?.stop()
  await rm(root, { recursive: true, force: true })
}

// Every CLI the suite started is gone: a hung probe or a run would show here.
const alive = () =>
  spawnSync('pgrep', ['-f', `^${process.execPath} ${FAKE}`])
    .stdout.toString()
    .trim()
for (let i = 0; i < 50 && alive() !== ''; i++) await sleep(100)
assert.equal(alive(), '', 'no fake-extensions-claude process is left')
