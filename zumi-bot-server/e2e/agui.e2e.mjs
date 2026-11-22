// End-to-end check of remote agents (AG-UI over HTTP + SSE) in the built server + web UI (local mode) against the FAKE AG-UI
// server (backend/tests/fixtures/fake-agui-server.mjs, started by the harness's `fakeAgui` on 127.0.0.1 under the dev hook
// ZUMIBOT_AGUI_ALLOW_LOCAL=1) and the FAKE claude: no real CLI or remote agent is ever reached, so no login or quota is used.
// See docs/architecture/protocol-engines.md (AG-UI engine, Phase 2 as built).
// Usage: npm run e2e:agui (builds first). Never part of `npm run e2e`.
//
// The fake server reads its script (h.agui.script) for each request; request i (counted from the server's start) plays entry
// i, so `aguiScript` pads the requests already made. It logs each request's path, query, headers and body (h.agui.log).
// The remote agent is made in Agent Studio (Engine = Remote agent (AG-UI), Endpoint = the fake's url), so its endpoint is
// confirmed by the Save itself: nothing here writes protocol-launch.json, which the moved-endpoint step depends on.
// The fake claude is fake-clone-claude.mjs (every call reads <FAKE_STDOUT_DIR>/<agent>.jsonl).
//
// Hard rules enforced here:
//  - nothing in ~/.claude or the real data dir is touched: the harness gives the server a throwaway HOME, agents dir, data dir
//    and vault key folder; voice is pointed at a loopback port nothing listens on;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server, Chrome and the fake server are stopped in `finally`; the fake server or any child of this process still
//    running then is a FAIL; overall timeout 6 min.
//
// DOM hooks relied on (data-testid): new-agent, new-menu-agent, new-menu-group, agent-engine, agui-card, agui-endpoint, agui-key,
//   agui-header, agui-error, agui-remote, agui-older-chats, agui-test, agui-test-result, acp-compare, agent-daily-cap,
//   agent-row (+ data-agent-name), agent-engine-tag, agent-menu-button, agent-menu-edit, new-chat-folder,
//   new-chat-choose-folder, new-chat-members, new-chat-member-option (+ data-agent-name, aria-disabled), remote-chip,
//   remote-chip-text, composer-input, send-button (title Stop while running), attach-button, draft-attachment (+ data-status),
//   agent-message, user-message, user-message-actions, copy-button, edit-button, resend-button, fork-button,
//   message-editor, message-editor-input, message-editor-send, tool-run, tool-row, thought-row, question-card
//   (+ data-status), question-tab, question-option (+ data-label), question-send, error-bubble, mention-menu, mention-option
//   (+ data-agent-name), voice-talk-agent. Agent Studio: #agent-name, #agent-description, #agent-prompt, button
//   "Save changes". Streaming shows as [data-streaming]; notices are `.notice`.
// Stored state read: <dataDir>/chats.json, <dataDir>/chats/<id>.json, <dataDir>/protocol-launch.json (read only),
//   <agentsDir>/<agent>.md (edited once, outside Agent Studio, for the moved endpoint).

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort, pickOption, start } from './harness.mjs'
import { killOwnedChild } from './e2eChecks.mjs'
import { redPng } from './redPng.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-clone-claude.mjs', import.meta.url))
const G = 'e2e-agui' // made in Agent Studio on the remote engine
const A = 'e2e-claude-a' // Claude: the @ menu's chat, the room option that may join, the voice default that is offered
const B = 'e2e-claude-b' // Claude, with a chat, then switched to the remote engine: its old chat must not continue
const C = 'e2e-claude-c' // Claude: what A's @ menu offers, so the check of what it leaves out is not vacuous
const PREFIX = 'zumibot-e2e-agui-'
const OVERALL_TIMEOUT = 6 * 60_000
const T = 15_000
const G_BODY = 'You are a remote test agent. This text must never leave the machine.'
const KEY_ENV = 'AGUI_E2E_KEY'
const KEY_VALUE = 'agui-e2e-T0ken-q7Zr41xV'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// Verbatim from shared/src/agui.ts (AGUI_TEXT, AGUI_STUDIO_TEXT).
const ENDPOINT_INVALID =
  'The endpoint must be an https address of at most 2048 characters, with no spaces, no username or password and no #'
const UNTRUSTED = "This agent's endpoint changed outside Agent Studio. Open it in Agent Studio and save to confirm."
const CUT = 'The connection ended before the agent finished.'
const NO_ATTACHMENTS = 'Attachments are not sent to remote agents. Send the message without them.'
const OTHER_ENGINE = 'This chat began on another engine, so its history is never sent to a remote agent: start a new chat for this agent.'
const OLDER_CHATS =
  'Chats this agent had on another engine do not continue on a remote agent: their history would be sent to its host. Start a new chat for it.'
const remoteNotice = (host) => `Runs outside this machine, at ${host}. Every message of its chats, and the chat's history, is sent there.`
const runError = (code, message) => `The agent reported an error (${code}): ${message}`
const unauthorized = (code, key) =>
  `The agent's server answered with status ${code}: it did not accept the key ${key}. Check authKey in Agent Studio and the key in the Vault.`
const declined = (reason) => `The agent asked for an approval ZumiBot could not show (${reason}), so it was cancelled.`
// Pydantic AI 2.65's approval schema, as its AG-UI adapter sends it: only `approved` is required.
const PYDANTIC_SCHEMA = {
  properties: { approved: { type: 'boolean' }, editedArgs: { type: 'object' }, reason: { type: 'string' } },
  required: ['approved'],
  type: 'object'
}

let h = null
let fakePid = null // the fake server's pid, kept past stop() for the leftover check
let fakeLog = null
const made = [] // every mkdtemp dir made here
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
// A SearchSelect's option values (the harness's optionLabels reads their text): it opens the menu, reads them and closes it.
async function optionValues(select) {
  await select.click()
  const values = await select
    .page()
    .locator(`.search-select-menu ${tid('select-option')}`)
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-value')))
  await select.page().keyboard.press('Escape')
  return values
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function waitFor(fn, timeout, what) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}`)
}

async function stop() {
  if (!h) return
  const cur = h
  h = null
  await Promise.race([cur.stop().catch(() => {}), sleep(30_000)])
  killOwnedChild(cur.server)
}

// One raw RPC over a fresh /ws socket from the page, so the auth cookie rides along.
const rpc = (page, method, ...args) =>
  page.evaluate(
    async ({ method, args }) => {
      const ws = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/ws`)
      await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = () => rej(new Error('the socket did not open')))))
      try {
        return await new Promise((res, rej) => {
          ws.onmessage = (e) => {
            const m = JSON.parse(e.data)
            if (m.id === 1) m.ok ? res(m.value) : rej(new Error(m.error))
          }
          ws.send(JSON.stringify({ id: 1, method, args }))
        })
      } finally {
        ws.close()
      }
    },
    { method, args }
  )

const storedChats = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats
const metaOf = async (id) => (await storedChats()).find((c) => c.id === id)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])
const jsonLines = async (file) =>
  (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))

// ---------- the fake AG-UI server: its script and what it got ----------
const aguiLog = () => jsonLines(h.agui.log)
const aguiRequests = async () => (await aguiLog()).filter((e) => typeof e.path === 'string')
/** Scripts the next requests: entries for the requests already made are padded, since the fake counts from its start. */
const aguiScript = async (...next) => {
  const done = (await aguiRequests()).length
  await writeFile(h.agui.script, JSON.stringify({ requests: [...Array.from({ length: done }, () => []), ...next] }))
}
const raw = (event) => ({ raw: event })
const interrupt = (...interrupts) => ({ finish: { outcome: { type: 'interrupt', interrupts } } })
/** Nothing but the request's own header holds the key: not the path, the query or the body. */
const keyOnlyInHeader = (req) =>
  req.headers.authorization === `Bearer ${KEY_VALUE}` &&
  !JSON.stringify({ path: req.path, query: req.query, body: req.body }).includes(KEY_VALUE)

// ---------- the fake claude's scripts: one file per agent ----------
let scripts = null
const SID_B = '6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e'
const line = (o) => JSON.stringify(o)
const init = (sid) => line({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-5-5', permissionMode: 'default' })
const say = (sid, text) =>
  line({
    type: 'assistant',
    message: {
      model: 'claude-haiku-5-5',
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: null,
      usage: { input_tokens: 2, output_tokens: 2 }
    },
    parent_tool_use_id: null,
    session_id: sid,
    uuid: randomUUID()
  })
const result = (sid, text) =>
  line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, uuid: randomUUID() })
const script = (agent, ...lines) => writeFile(join(scripts, `${agent}.jsonl`), lines.flat().join('\n') + '\n')

// ---------- UI helpers ----------
const composer = (page) => page.locator(tid('composer-input'))
const textOf = async (loc) => ((await loc.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
const agentRow = (page, name) => page.locator(`${tid('agent-row')}[data-agent-name="${name}"]`)
const frontmatter = (raw) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? ''
const errorShown = (page, text) =>
  waitFor(async () => (await page.locator(tid('error-bubble'), { hasText: text }).count()) > 0, T, `the error "${text}" on the page`)
const lastError = async (id) => (await itemsOf(id)).filter((i) => i.type === 'error').at(-1)?.text

async function pickFolder(page, dir) {
  await page.click(tid('new-chat-folder'))
  await page.click(tid('new-chat-choose-folder'))
  await waitFor(async () => (await page.locator(tid('new-chat-folder')).getAttribute('data-tip')) === dir, T, 'the folder to be set')
}

/** The open chat's id from the address bar, once it is a chat other than the given ones. */
async function openedChat(page, not = []) {
  let id = null
  await waitFor(
    async () => {
      const m = /\/chat\/([^/?#]+)$/.exec(new URL(page.url()).pathname)
      id = m ? decodeURIComponent(m[1]) : null
      return id !== null && !not.includes(id)
    },
    T,
    'a new chat to open'
  )
  return id
}

async function openChat(page, id) {
  await page.goto(`${h.origin}/chat/${encodeURIComponent(id)}`)
  await composer(page).waitFor({ timeout: T })
}

async function typeAndSend(page, text) {
  await composer(page).click()
  await page.keyboard.type(text)
  await page.click(tid('send-button'))
}

async function idle(ids, what) {
  await waitFor(
    async () => {
      for (const id of ids) {
        const m = await metaOf(id)
        if (!m || m.inFlight) return false
      }
      return true
    },
    T,
    what
  )
}

/** The reply is shown and the chat is idle again. */
async function waitReply(page, chatId, text) {
  await waitFor(async () => (await page.locator(tid('agent-message'), { hasText: text }).count()) > 0, T, `the reply "${text}"`)
  await idle([chatId], `the reply "${text}" to end`)
}

/** A send that ends with an error: shown on the page, stored as the chat's last error, the chat idle again. */
async function sendRefused(page, chatId, text, error) {
  await typeAndSend(page, text)
  await errorShown(page, error)
  await idle([chatId], `"${text}" to end`)
  const stored = await lastError(chatId)
  assert(stored === error, `the stored error is ${JSON.stringify(stored)}, not ${JSON.stringify(error)}`)
}

/** Opens Agent Studio on an existing agent from its sidebar row. */
async function editAgent(page, name) {
  await agentRow(page, name).hover()
  await page
    .locator(`.agent-block:has(${tid('agent-row')}[data-agent-name="${name}"]) ${tid('agent-menu-button')}`)
    .first()
    .click()
  await page.locator(tid('agent-menu-edit')).click()
  await page.locator(tid('agent-engine')).waitFor({ timeout: T })
}

/** The action buttons a hovered message shows (by data-testid), once its action row is there. */
async function actionsOf(msg, row) {
  await msg.hover()
  await msg.locator(tid(row)).waitFor({ timeout: T })
  await msg.locator(`${tid(row)} ${tid('copy-button')}`).waitFor({ timeout: T })
  return msg.locator(`${tid(row)} button[data-testid]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
}

/** Whether `pid` still runs as this suite's fake server: its env names this run's log, so a reused pid is never taken for it. */
const fakeAlive = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`FAKE_AGUI_LOG=${fakeLog}`)
  } catch {
    return false
  }
}
/** Processes still running whose parent is this suite (the server, Chrome, the fake server). Linux /proc only. */
function ownChildren() {
  const out = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8')
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(fields[1]) === process.pid && fields[0] !== 'Z')
        out.push({ pid: Number(name), comm: stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')')) })
    } catch {
      /* gone */
    }
  }
  return out
}

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  scripts = await mk('scripts')
  for (const [name, description] of [
    [A, 'Checks the repo with the user.'],
    [B, 'Moves to a remote server later.'],
    [C, 'Answers questions from other agents.']
  ]) {
    await writeFile(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: ${description}\nmodel: haiku\n---\nYou are a test agent.\n`
    )
  }
  // Voice on, with a dummy key, so Settings › Voice shows its default agent; its URL is a loopback port nothing listens on.
  await writeFile(join(dataDir, 'voice.json'), JSON.stringify({ enabled: true, key: 'vk-e2e-dummy-voice-key' }), { mode: 0o600 })
  h = await start({
    fake: FAKE,
    fakeAgui: true,
    dataDir,
    agentsDir,
    env: { ZUMIBOT_TEST_PICK_FOLDER: folder, FAKE_STDOUT_DIR: scripts, ZUMIBOT_TEST_VOICE_URL: `http://127.0.0.1:${await freePort()}` }
  })
  fakePid = h.agui.pid
  fakeLog = h.agui.log
  assert(fakeAlive(fakePid), 'the fake server is not found by its env, so the leftover check at the end would prove nothing')
  const page = h.page
  const gFile = join(agentsDir, `${G}.md`)
  const bFile = join(agentsDir, `${B}.md`)
  const trustFile = join(h.dataDir, 'protocol-launch.json')
  const trusted = async (name) => (await readFile(trustFile, 'utf8').then(JSON.parse, () => ({}))).agents?.[name]
  const fakeUrl = new URL(h.agui.url)
  const host = fakeUrl.host
  const saveButton = page.getByRole('button', { name: 'Save changes', exact: true })

  // 0. B, a Claude agent, has a chat before it is moved to the remote engine (step 9).
  await page.locator(tid('new-agent')).waitFor({ timeout: 30_000 })
  await script(B, init(SID_B), say(SID_B, 'Claude B here'), result(SID_B, 'Claude B here'))
  await agentRow(page, B).click()
  await pickFolder(page, folder)
  await typeAndSend(page, 'Hello Claude B')
  const bId = await openedChat(page)
  await waitReply(page, bId, 'Claude B here')
  ok(`0 ${B} (Claude) has a chat`)

  // 1. Agent Studio: a new agent on the remote engine. Its card shows at once; Save is refused for an endpoint with a username
  // and password and for one with a #, writing nothing; the fake's url saves provider: ag-ui and its endpoint, which the Save
  // confirms on this machine. A Vault key granted to the agent is then offered as its Auth key and saved. Test connects and
  // sends no request; there is no daily cap card.
  await page.click(tid('new-agent'))
  await page.click(tid('new-menu-agent'))
  await page.locator('#agent-name').fill(G)
  await page.locator('#agent-description').fill('Runs on a remote AG-UI server for the e2e.')
  // A new agent starts on Claude, whose daily cap card shows: so its absence below is the remote engine's doing.
  await page.locator(tid('agent-daily-cap')).waitFor({ timeout: T })
  // The Engine dropdown (a SearchSelect): its options show while its menu is open.
  await page.locator(tid('agent-engine')).click()
  const remoteOption = page.locator(`.search-select-menu ${tid('select-option')}[data-value="ag-ui"]`)
  assert(
    (await textOf(remoteOption)) === 'Remote agent (AG-UI)' && !(await remoteOption.isDisabled()),
    `the Engine select offers ${JSON.stringify(await textOf(remoteOption))}`
  )
  await remoteOption.click()
  await page.locator(tid('agui-card')).waitFor({ timeout: T })
  await page.locator('#agent-prompt').fill(G_BODY)
  for (const bad of [`http://user:pw@${host}/run`, `${h.agui.url}#frag`]) {
    await page.locator(tid('agui-endpoint')).fill(bad)
    await waitFor(async () => (await textOf(page.locator(tid('agui-error')))) === ENDPOINT_INVALID, T, `the endpoint error for ${bad}`)
    await saveButton.click()
    await sleep(500)
    assert(!existsSync(gFile), `Save wrote an agent with the endpoint ${bad}`)
  }
  await page.locator(tid('agui-endpoint')).fill(h.agui.url)
  await waitFor(async () => (await page.locator(tid('agui-error')).count()) === 0, T, 'the endpoint error to clear')
  assert(
    (await textOf(page.locator(tid('agui-remote')))) === remoteNotice(host),
    `the card's notice reads ${JSON.stringify(await textOf(page.locator(tid('agui-remote'))))}`
  )
  assert((await page.locator(tid('agent-daily-cap')).count()) === 0, 'Agent Studio shows a daily spend cap for a remote agent')
  await saveButton.click()
  await waitFor(async () => existsSync(gFile), T, `${gFile} to be written`)
  const fm1 = frontmatter(await readFile(gFile, 'utf8'))
  assert(
    /^provider: ag-ui$/m.test(fm1) && fm1.includes(h.agui.url) && !/^model:/m.test(fm1),
    `the agent file's frontmatter is ${JSON.stringify(fm1)}`
  )
  await waitFor(
    async () => same(await trusted(G), { provider: 'ag-ui', endpoint: h.agui.url, authKey: null, authHeader: null }),
    T,
    'the endpoint to be confirmed'
  )
  await agentRow(page, G).waitFor({ timeout: T })
  const tag = await textOf(agentRow(page, G).locator(tid('agent-engine-tag')))
  assert(tag === 'Remote', `G's row tag reads ${JSON.stringify(tag)}`)
  await rpc(page, 'vault:save', { kind: 'apiKey', name: 'Remote agent key', agents: [G], env: KEY_ENV, value: KEY_VALUE, description: '' })
  await waitFor(async () => (await optionValues(page.locator(tid('agui-key')))).includes(KEY_ENV), T, 'the granted key to be offered')
  await pickOption(page.locator(tid('agui-key')), KEY_ENV)
  await waitFor(async () => saveButton.isEnabled(), T, 'Save to be on after picking the key')
  await saveButton.click()
  await waitFor(
    async () => same(await trusted(G), { provider: 'ag-ui', endpoint: h.agui.url, authKey: KEY_ENV, authHeader: null }),
    T,
    'the key to be confirmed with the endpoint'
  )
  assert(
    !(await readFile(gFile, 'utf8')).includes(KEY_VALUE) && !(await readFile(trustFile, 'utf8')).includes(KEY_VALUE),
    'the key value reached the agent file or protocol-launch.json'
  )
  await waitFor(async () => !(await page.locator(tid('agui-test')).isDisabled()), T, 'Test to be on for the saved agent')
  await page.locator(tid('agui-test')).click()
  const testResult = page.locator(tid('agui-test-result'))
  await testResult.waitFor({ timeout: 30_000 })
  const testText = await textOf(testResult)
  assert(
    testText.includes(host) &&
      testText.includes('127.0.0.1') &&
      testText.includes('Plain, to this machine only (development)') &&
      testText.includes(`${KEY_ENV}, granted to this agent`),
    `the Test result reads ${JSON.stringify(testText)}`
  )
  await sleep(300)
  assert((await aguiLog()).length === 0, `Test reached the server: ${JSON.stringify(await aguiLog())}`)
  ok(
    `1 Agent Studio: "Remote agent (AG-UI)" shows its card and drops the daily cap card a new (Claude) agent has; Save is refused for an endpoint with userinfo or a # (nothing written); the fake's url saves provider: ag-ui, confirmed in protocol-launch.json; a granted Vault key becomes the Auth key; the row reads Remote; Test reads ${JSON.stringify(testText)} and the server got no request`
  )

  // 2. the chip: the new-chat screen and the chat header show "Remote · host", with the remote notice as its tooltip and its text
  await agentRow(page, G).click()
  await pickFolder(page, folder)
  const chip = page.locator(tid('remote-chip'))
  const chipChecks = async (where) => {
    await chip.waitFor({ timeout: T })
    const label = await textOf(chip)
    const title = await chip.getAttribute('data-tip')
    assert(label === `Remote · ${host}` && title === remoteNotice(host), `the ${where} chip reads ${JSON.stringify({ label, title })}`)
    await chip.click()
    const shown = await textOf(page.locator(tid('remote-chip-text')))
    assert(shown === remoteNotice(host), `the ${where} chip opens ${JSON.stringify(shown)}`)
    await chip.click() // a second press closes it
    await page.locator(tid('remote-chip-text')).waitFor({ state: 'detached', timeout: T })
  }
  await chipChecks('new-chat')

  // 3. a chat: reasoning, a reply that streams, and a remote tool row with its result; the request carries the key in its header
  // only, no system text and no tools; the second turn carries the history (the call and its result, no thinking) and the state
  await aguiScript(
    [
      { reasoning: 'Weighing the question' },
      raw({ type: 'TEXT_MESSAGE_START', messageId: 'm-hello', role: 'assistant' }),
      raw({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm-hello', delta: 'Hello ' }),
      { sleep: 500 },
      raw({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm-hello', delta: 'from AG-UI' }),
      raw({ type: 'TEXT_MESSAGE_END', messageId: 'm-hello' }),
      { tool: { id: 'call_1', name: 'search_docs', args: { q: 'ag-ui' }, result: '3 documents found', parent: 'm-hello' } },
      { state: { snapshot: { visits: 1 } } },
      { finish: { usage: [{ model: 'remote-model', inputTokens: 12, outputTokens: 5 }] } }
    ],
    [{ text: 'Three documents' }, { finish: {} }]
  )
  await page.evaluate(() => {
    window.__sawStreaming = false
    new MutationObserver(() => {
      if (document.querySelector('[data-streaming]')) window.__sawStreaming = true
    }).observe(document.body, { subtree: true, childList: true, attributes: true })
  })
  await typeAndSend(page, 'Hello remote')
  const gId = await openedChat(page, [bId])
  await waitReply(page, gId, 'Hello from AG-UI')
  assert(await page.evaluate(() => window.__sawStreaming), 'no [data-streaming] element was seen while the reply streamed')
  const [r1] = await aguiRequests()
  const items3 = await itemsOf(gId)
  const u1 = items3.find((i) => i.type === 'user')
  assert(
    keyOnlyInHeader(r1) && r1.headers.accept === 'text/event-stream' && r1.path === fakeUrl.pathname,
    `the first request was ${JSON.stringify({ path: r1.path, headers: Object.keys(r1.headers), accept: r1.headers.accept })}`
  )
  const b1 = r1.body
  assert(
    UUID.test(b1.threadId) &&
      UUID.test(b1.runId) &&
      b1.protocolVersion === '1.0' &&
      same(b1.state, {}) &&
      same(b1.tools, []) &&
      same(b1.context, []) &&
      same(b1.forwardedProps, {}) &&
      !('resume' in b1) &&
      !('parentRunId' in b1),
    `the first RunAgentInput was ${JSON.stringify({ ...b1, messages: undefined })}`
  )
  assert(
    same(b1.messages, [{ id: u1.id, role: 'user', content: 'Hello remote' }]) && !JSON.stringify(b1).includes(G_BODY),
    `the first messages were ${JSON.stringify(b1.messages)}`
  )
  const thinking3 = items3.find((i) => i.type === 'thinking')
  const reply3 = items3.find((i) => i.type === 'assistant')
  const tool3 = items3.find((i) => i.type === 'tool')
  assert(
    thinking3?.text === 'Weighing the question' && reply3?.text === 'Hello from AG-UI',
    `the stored thought and reply are ${JSON.stringify([thinking3?.text, reply3?.text])}`
  )
  assert(
    tool3?.name === 'AguiTool' &&
      same(tool3.input, { tool: 'search_docs', args: { q: 'ag-ui' } }) &&
      tool3.result === '3 documents found' &&
      !tool3.isError,
    `the stored tool row is ${JSON.stringify(tool3)}`
  )
  const meta3 = await metaOf(gId)
  assert(
    meta3.sessionEngine === 'ag-ui' && meta3.sessionId === b1.threadId,
    `the chat's session is ${JSON.stringify({ sessionId: meta3.sessionId, sessionEngine: meta3.sessionEngine })}`
  )
  const runHead = page.locator(tid('tool-run')).first().locator('.tool-run-head')
  if ((await runHead.getAttribute('aria-expanded')) !== 'true') await runHead.click()
  await page.locator(tid('thought-row')).first().waitFor({ timeout: T })
  assert(
    (await page.locator(tid('tool-row'), { hasText: 'search_docs' }).count()) === 1,
    'the remote tool row is not shown in the open run'
  )
  await chipChecks('chat header')
  await typeAndSend(page, 'What did you find?')
  await waitReply(page, gId, 'Three documents')
  const r2 = (await aguiRequests())[1]
  const u2 = (await itemsOf(gId)).filter((i) => i.type === 'user')[1]
  const history2 = [
    { id: u1.id, role: 'user', content: 'Hello remote' },
    {
      id: reply3.id,
      role: 'assistant',
      content: 'Hello from AG-UI',
      toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'search_docs', arguments: '{"q":"ag-ui"}' } }]
    },
    { id: `result-${tool3.id}`, role: 'tool', toolCallId: 'call_1', content: '3 documents found' },
    { id: u2.id, role: 'user', content: 'What did you find?' }
  ]
  assert(
    keyOnlyInHeader(r2) && r2.body.threadId === b1.threadId && r2.body.runId !== b1.runId && same(r2.body.state, { visits: 1 }),
    `the second request was ${JSON.stringify({ ...r2.body, messages: undefined })}`
  )
  assert(same(r2.body.messages, history2), `the second messages were ${JSON.stringify(r2.body.messages)}`)
  ok('2 the chip "Remote · host" with the remote notice as its tooltip and text, on the new-chat screen and in the chat header')
  ok(
    '3 a chat: reasoning, a streamed reply and a remote tool row (shown in the run, stored as AguiTool with its result); the key only in its Authorization header, no system text, tools [], state {}; the second turn sends the history (call and result, no thinking) on the same thread with the kept state'
  )

  // 4. interrupts, in Pydantic AI's shape (an empty message, then the call naming it as its parent): the approval maps to a
  // question card asking only the required `approved` (Yes / No), and an interrupt with no schema is cancelled with a notice;
  // Yes goes back as `resume` on the same thread, with the empty message resent as the call's parent, and no empty reply shows
  await aguiScript(
    [
      raw({ type: 'TEXT_MESSAGE_START', messageId: 'm-empty', role: 'assistant' }),
      raw({ type: 'TEXT_MESSAGE_END', messageId: 'm-empty' }),
      { tool: { id: 'call_del', name: 'delete_demo_file', args: { path: 'demo.txt' }, parent: 'm-empty' } },
      interrupt(
        {
          id: 'int-del',
          reason: 'tool_call',
          message: 'Approve delete_demo_file?',
          toolCallId: 'call_del',
          responseSchema: PYDANTIC_SCHEMA
        },
        { id: 'int-custom', reason: 'custom_review' }
      )
    ],
    [
      raw({ type: 'TOOL_CALL_RESULT', messageId: 'r-del', toolCallId: 'call_del', content: 'pretended to delete demo.txt', role: 'tool' }),
      { text: 'done: pretended to delete demo.txt' },
      { finish: {} }
    ]
  )
  let mark = (await aguiRequests()).length
  let itemsAt = (await itemsOf(gId)).length
  await typeAndSend(page, 'Run the approval demo')
  const qCard = page.locator(`${tid('question-card')}[data-status="pending"]`).first()
  await qCard.waitFor({ timeout: T })
  const labels = await qCard.locator(tid('question-option')).evaluateAll((els) => els.map((e) => e.getAttribute('data-label')))
  assert(
    (await textOf(qCard)).includes('Approve delete_demo_file?') &&
      (await qCard.locator(tid('question-tab')).count()) === 0 &&
      same(labels, ['Yes', 'No']),
    `the question card reads ${JSON.stringify(await textOf(qCard))} with options ${JSON.stringify(labels)}`
  )
  await waitFor(
    async () => (await page.locator('.notice', { hasText: declined('custom_review') }).count()) > 0,
    T,
    'the declined interrupt notice'
  )
  await qCard.locator(`${tid('question-option')}[data-label="Yes"] input`).click()
  await qCard.locator(tid('question-send')).click()
  await waitReply(page, gId, 'done: pretended to delete demo.txt')
  const reqs4 = (await aguiRequests()).slice(mark)
  assert(
    reqs4.length === 2 && reqs4[1].body.threadId === b1.threadId && reqs4[1].body.runId !== reqs4[0].body.runId,
    `the approval turn sent ${reqs4.length} request(s)`
  )
  assert(
    same(reqs4[1].body.resume, [
      { interruptId: 'int-del', status: 'resolved', payload: { approved: true } },
      { interruptId: 'int-custom', status: 'cancelled' }
    ]),
    `the resume was ${JSON.stringify(reqs4[1].body.resume)}`
  )
  assert(
    same(reqs4[1].body.messages.at(-1), {
      id: 'm-empty',
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_del', type: 'function', function: { name: 'delete_demo_file', arguments: '{"path":"demo.txt"}' } }]
    }),
    `the resumed run ended its messages with ${JSON.stringify(reqs4[1].body.messages.at(-1))}`
  )
  const items4 = (await itemsOf(gId)).slice(itemsAt)
  const card4 = items4.find((i) => i.type === 'approval')
  assert(
    card4?.toolName === 'AskUserQuestion' && card4.status === 'answered',
    `the stored card is ${JSON.stringify(card4 && { toolName: card4.toolName, status: card4.status })}`
  )
  assert(items4.find((i) => i.type === 'tool')?.result === 'pretended to delete demo.txt', 'the approved call has no result')
  assert(
    items4.filter((i) => i.type === 'assistant').every((i) => i.text.trim() !== ''),
    `an empty reply was stored: ${JSON.stringify(items4.map((i) => [i.type, i.text]))}`
  )
  assert(!(await page.locator(tid('agent-message')).allTextContents()).some((t) => t.trim() === ''), 'an empty agent message is shown')
  ok(
    '4 a Pydantic-shaped approval shows one Yes/No question (optional fields pruned), the interrupt with no schema is cancelled with its notice, Yes resumes the thread with {approved: true} and the cancel; the empty message is resent as the parent and never shown'
  )

  // 5. Stop with a card open: nothing more is sent, the chat ends with the stopped notice; the next send cancels the interrupt
  await aguiScript(
    [
      { text: 'I need a go-ahead' },
      interrupt({
        id: 'int-stop',
        reason: 'confirm',
        responseSchema: { type: 'object', properties: { go: { type: 'boolean', title: 'Go ahead?' } }, required: ['go'] }
      })
    ],
    [{ text: 'Picked up again' }, { finish: {} }]
  )
  mark = (await aguiRequests()).length
  await typeAndSend(page, 'Start the long job')
  await page
    .locator(`${tid('question-card')}[data-status="pending"]`)
    .first()
    .waitFor({ timeout: T })
  const stopButton = page.locator(tid('send-button'))
  await waitFor(async () => (await stopButton.getAttribute('data-tip')) === 'Stop', T, 'the Stop button')
  await stopButton.click()
  await idle([gId], 'the remote chat to stop')
  await sleep(1000)
  const items5 = await itemsOf(gId)
  assert(items5.at(-1)?.type === 'notice' && items5.at(-1).kind === 'stopped', `the chat ends with ${JSON.stringify(items5.at(-1))}`)
  assert((await page.locator(`${tid('question-card')}[data-status="pending"]`).count()) === 0, 'a card is still pending after Stop')
  assert((await aguiRequests()).length === mark + 1, `Stop sent more: ${(await aguiRequests()).length - mark} request(s)`)
  await typeAndSend(page, 'Carry on')
  await waitReply(page, gId, 'Picked up again')
  const r5 = (await aguiRequests())[mark + 1]
  assert(
    r5.body.threadId === b1.threadId && same(r5.body.resume, [{ interruptId: 'int-stop', status: 'cancelled' }]),
    `the send after Stop was ${JSON.stringify({ threadId: r5.body.threadId, resume: r5.body.resume })}`
  )
  ok(
    '5 Stop with a card open sends nothing more and ends with the stopped notice; the next send cancels int-stop in its resume, on the same thread'
  )

  // 6. failures: a RUN_ERROR with its code, a stream cut with no terminal event, and a 401 whose body echoes the key, which shows
  // only the status and names authKey
  await aguiScript(
    [{ text: 'Working on it' }, { error: { message: 'the model quota ran out', code: 'QUOTA' } }],
    [{ text: 'Half an' }, { cut: true }],
    [{ status: { code: 401, body: `invalid key ${KEY_VALUE}` } }]
  )
  await sendRefused(page, gId, 'Trigger an error', runError('QUOTA', 'the model quota ran out'))
  await sendRefused(page, gId, 'Trigger a cut', CUT)
  await sendRefused(page, gId, 'Trigger a 401', unauthorized(401, KEY_ENV))
  const chatText = await readFile(join(h.dataDir, 'chats', `${gId}.json`), 'utf8')
  assert(!chatText.includes(KEY_VALUE) && !(await page.content()).includes(KEY_VALUE), 'the key value reached the chat or the page')
  ok('6 a RUN_ERROR shows "(QUOTA): the model quota ran out", a cut stream the cut sentence, and a 401 echoing the key names authKey only')

  // 7. Edit, Resend and Fork are offered; an Edit starts a new thread with the visible items, no resume and the state {}, and
  // says nothing of it (no expired notice)
  const userActs = await actionsOf(page.locator(tid('user-message')).filter({ hasText: 'Hello remote' }).last(), 'user-message-actions')
  assert(
    ['edit-button', 'resend-button', 'fork-button'].every((b) => userActs.includes(b)),
    `the remote chat's user message offers ${JSON.stringify(userActs)}`
  )
  await aguiScript([{ text: 'Edited answer' }, { finish: {} }])
  mark = (await aguiRequests()).length
  const msg7 = page.locator(tid('user-message')).filter({ hasText: 'Trigger a 401' }).last()
  await msg7.hover()
  await msg7.locator(tid('edit-button')).click()
  await page.locator(tid('message-editor-input')).fill('Edited question')
  await page.locator(tid('message-editor-send')).click()
  await page.locator(tid('message-editor')).waitFor({ state: 'detached', timeout: T })
  await waitReply(page, gId, 'Edited answer')
  const r7 = (await aguiRequests())[mark]
  assert(
    UUID.test(r7.body.threadId) && r7.body.threadId !== b1.threadId && !('resume' in r7.body) && same(r7.body.state, {}),
    `the Edit's request was ${JSON.stringify({ ...r7.body, messages: undefined })}`
  )
  assert(
    same(r7.body.messages.at(-1), { id: r7.body.messages.at(-1).id, role: 'user', content: 'Edited question' }) &&
      r7.body.messages[0].content === 'Hello remote' &&
      !JSON.stringify(r7.body.messages).includes('Trigger a 401'),
    `the Edit's messages were ${JSON.stringify(r7.body.messages)}`
  )
  const items7 = await itemsOf(gId)
  const edited = items7.findLastIndex((i) => i.type === 'user')
  assert(
    !items7.slice(edited).some((i) => i.type === 'notice' && i.kind === 'expired'),
    `an expired notice follows the Edit: ${JSON.stringify(items7.slice(edited).map((i) => i.kind ?? i.type))}`
  )
  assert((await metaOf(gId)).sessionId === r7.body.threadId, 'the chat does not keep the new thread')
  ok(
    `7 the user message offers ${JSON.stringify(userActs)}; an Edit sends a new thread (no resume, state {}) with the visible items, and no expired notice`
  )

  // 8. refusals before any request: an attachment; a chat whose endpoint was edited in the file (then confirmed by Save)
  mark = (await aguiRequests()).length
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(tid('attach-button')).click()])
  await chooser.setFiles({ name: 'red.png', mimeType: 'image/png', buffer: redPng() })
  await page.locator(`${tid('draft-attachment')}[data-status="ready"]`).waitFor({ timeout: T })
  await sendRefused(page, gId, 'Look at this picture', NO_ATTACHMENTS)
  const moved = h.agui.url.replace(/\/run$/, '/run-moved')
  await writeFile(gFile, (await readFile(gFile, 'utf8')).replace(h.agui.url, moved))
  await sleep(1000) // the agents-folder watcher
  await sendRefused(page, gId, 'After the move', UNTRUSTED)
  assert((await aguiRequests()).length === mark, 'a refused send reached the server')
  await editAgent(page, G)
  const compare = page.locator(tid('acp-compare'))
  await compare.waitFor({ timeout: T })
  const compareText = await textOf(compare)
  assert(compareText.includes(h.agui.url) && compareText.includes(moved), `the compare box reads ${JSON.stringify(compareText)}`)
  await waitFor(async () => saveButton.isEnabled(), T, 'Save to be on with no edit')
  await saveButton.click()
  await waitFor(async () => (await trusted(G))?.endpoint === moved, T, 'the moved endpoint to be confirmed')
  await compare.waitFor({ state: 'detached', timeout: T })
  await openChat(page, gId)
  await aguiScript([{ text: 'Reached the moved path' }, { finish: {} }])
  await typeAndSend(page, 'Moved for real')
  await waitReply(page, gId, 'Reached the moved path')
  const r8 = (await aguiRequests())[mark]
  assert(r8.path === '/run-moved' && keyOnlyInHeader(r8), `the confirmed send went to ${r8.path}`)
  ok(
    '8 an attachment is refused, and so is an endpoint edited in the file, with no request; Agent Studio shows both endpoints, Save confirms the new one and the next send goes there'
  )

  // 9. B's Claude chat after B moves to the remote engine: Agent Studio says older chats do not continue, and a send there is
  // refused before any request
  await editAgent(page, B)
  await pickOption(page.locator(tid('agent-engine')), 'ag-ui')
  const older = page.locator(tid('agui-older-chats'))
  await older.waitFor({ timeout: T })
  assert((await textOf(older)) === OLDER_CHATS, `the older-chats note reads ${JSON.stringify(await textOf(older))}`)
  await page.locator(tid('agui-endpoint')).fill(h.agui.url)
  await waitFor(async () => saveButton.isEnabled(), T, "Save to be on for B's switch")
  await saveButton.click()
  await waitFor(
    async () => (await trusted(B))?.endpoint === h.agui.url && /^provider: ag-ui$/m.test(frontmatter(readFileSync(bFile, 'utf8'))),
    T,
    'B to be saved as a remote agent'
  )
  await openChat(page, bId)
  mark = (await aguiRequests()).length
  await sendRefused(page, bId, 'Continue on the remote engine', OTHER_ENGINE)
  assert((await aguiRequests()).length === mark, "B's old chat reached the server")
  ok(
    `9 ${B} switched to the remote engine: the older-chats note shows, and its Claude chat is refused ("${OTHER_ENGINE.slice(0, 40)}…") with no request`
  )

  // 10. not offered: the room member picker, A's @ menu and the voice default leave remote agents out
  await page.click(tid('new-agent'))
  await page.click(tid('new-menu-group'))
  await page.locator(tid('new-chat-members')).click()
  const memberOption = (n) => page.locator(`${tid('new-chat-member-option')}[data-agent-name="${n}"]`)
  await memberOption(G).waitFor({ timeout: T })
  const gOption = { disabled: await memberOption(G).getAttribute('aria-disabled'), text: await textOf(memberOption(G)) }
  assert(
    gOption.disabled === 'true' && gOption.text.includes("can't join") && (await memberOption(A).getAttribute('aria-disabled')) === 'false',
    `the members picker shows ${JSON.stringify(gOption)}`
  )
  await page.keyboard.press('Escape')
  await agentRow(page, A).click()
  await composer(page).waitFor({ timeout: T })
  await composer(page).click()
  await page.keyboard.type('@e2e')
  const menu = page.locator(tid('mention-menu'))
  await menu.waitFor({ timeout: T })
  const mentioned = await menu.locator(tid('mention-option')).evaluateAll((els) => els.map((e) => e.getAttribute('data-agent-name')))
  assert(mentioned.includes(C) && !mentioned.includes(G) && !mentioned.includes(B), `A's @ menu lists ${JSON.stringify(mentioned)}`)
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  await page.goto(`${h.origin}/settings/voice`)
  const voiceSelect = page.locator(tid('voice-talk-agent'))
  await voiceSelect.waitFor({ timeout: T })
  const voiceOptions = await optionValues(voiceSelect)
  assert(
    voiceOptions.includes(A) && !voiceOptions.includes(G) && !voiceOptions.includes(B),
    `the voice default offers ${JSON.stringify(voiceOptions)}`
  )
  ok(
    `10 the members picker shows ${G} as "can't join"; A's @ menu lists ${JSON.stringify(mentioned)}; the voice default offers ${JSON.stringify(voiceOptions.filter(Boolean))}`
  )

  assert(h.errors.length === 0, `unexpected errors: ${h.errors.join(' | ')}`)
  ok('no console or server errors')
}

const timer = setTimeout(() => {
  console.error('FAIL overall timeout')
  void stop().finally(() => process.exit(1))
}, OVERALL_TIMEOUT)
timer.unref()

let failed = false
try {
  await main()
} catch (err) {
  failed = true
  console.error(`FAIL ${err instanceof Error ? err.message : err}`)
} finally {
  await stop()
  // stop() ends the server, Chrome and the fake server: any of them still running is a leak.
  if (fakePid !== null && fakeAlive(fakePid)) {
    failed = true
    console.error(`FAIL the fake AG-UI server (pid ${fakePid}) outlived the harness`)
    try {
      process.kill(fakePid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  const left = ownChildren()
  if (left.length > 0) {
    failed = true
    console.error(`FAIL processes started here are still running: ${JSON.stringify(left)}`)
    for (const p of left) {
      try {
        process.kill(p.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  }
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
console.log(failed ? 'e2e:agui FAILED' : 'e2e:agui passed')
process.exit(failed ? 1 : 0)
