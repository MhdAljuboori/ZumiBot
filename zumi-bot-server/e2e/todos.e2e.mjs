// End-to-end check of chat to-dos in the built server + web UI (local mode) against the FAKE claude
// (backend/tests/fixtures/fake-clone-claude.mjs, which answers a room's moderator with {} and runs fake-claude.mjs for
// every agent turn): no real CLI call is ever made, so no login or quota is used. Usage: npm run e2e:todos (builds first)
//
// The agent's to-do calls are real: each turn's script has an #MCP_CALL line, so the fake starts the zumibot_todos
// bridge from the --mcp-config the server passed, with the capability env the server gave it, and calls the tool over
// stdio, after a can_use_tool request (manual mode) that the server must answer by itself, without a card.
// What the agent read is checked on the fake's stdin (FAKE_STDIN_OUT, written when a run ends).
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server, Chrome and the second browser context started here are stopped in `finally`; overall timeout 4 min.
//
// DOM hooks relied on (data-testid): new-chat-agent, new-chat-agent-option (+ data-agent-name), new-chat-folder,
//   new-chat-choose-folder, composer-input, send-button, agent-message (+ data-item-id), user-message, todo-chip,
//   command-chip, todo-line, todo-chip-open, todo-change, approval-card, tool-row, side-panel-toggle, side-menu,
//   side-open-todos, todos-panel, todos-title, todos-empty, todo-group (+ data-todo-reply), todo-group-label, todo-heading, todo-row (+ data-todo-id,
//   data-done), todo-row-dot (+ data-col: the status menu's button), todo-status-menu, todo-status-option (+ data-col, aria-checked), todo-open, todo-give, todo-give-agent, todo-give-button, todo-text, todo-by, todo-remove, todo-toast, todo-undo, todo-done-toggle, todo-add (the form), todo-add-input, todo-add-button, todo-add-note, fork-button,
//   group-row (+ data-chat-id), chat-menu-clone, clone-dialog (+ data-step), clone-create.
// Stored state read: <dataDir>/chats.json, <dataDir>/chats/<id>.json, <dataDir>/todos.json (the board).

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors, pickOption } from './harness.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-clone-claude.mjs', import.meta.url))
const AGENT = 'e2e-todos-agent'
const BETA = 'e2e-todos-beta'
const PREFIX = 'zumibot-e2e-todos-'
const OVERALL_TIMEOUT = 4 * 60_000
const T = 15_000
// The request line of a to-do turn, verbatim from backend/src/core/todos/todoPrompt.ts (TODO_REQUEST).
const TODO_REQUEST =
  "Put the action items of your reply on the user's task board with the zumibot_todos tools, each with a description that holds everything needed to act on it."
const MY_DAY_PROMPT = 'Give me my day.'

const A = 'Reply to Morjan about the launch'
const B = 'Answer the invite from Homam'
const C_MD = 'Review card [WK-7](https://example.com/wk-7)'
const C = 'Review card WK-7' // as the panel shows it: the link is rendered
const D = 'Approve the budget sheet'
const E = 'Reply to Lina in #design'
const F = 'Draft the launch post'
const G = 'Book the demo room'

let h = null
let ctx2 = null
const made = [] // every mkdtemp dir made here
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`

async function waitFor(fn, timeout, what) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}`)
}

async function stop() {
  if (ctx2) {
    const c = ctx2
    ctx2 = null
    await c.close().catch(() => {})
  }
  if (!h) return
  const cur = h
  const pid = cur.server.pid
  h = null
  await Promise.race([cur.stop().catch(() => {}), sleep(30_000)])
  try {
    process.kill(pid, 0)
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
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
// The one board: every chat's to-dos, tombstones too.
const boardFile = () => join(h.dataDir, 'todos.json')
const listOf = async (page, id) => (await rpc(page, 'todos:list', id)).items
const idOf = (items, text) => {
  const item = items.find((i) => i.text === text)
  assert(item, `no to-do reads ${JSON.stringify(text)} (${JSON.stringify(items.map((i) => i.text))})`)
  return item.id
}

// ---------- the fake claude's script: one file, rewritten before each turn ----------
const SID = '6f1d2c3b-4a5e-4f60-8172-93a4b5c6d7e8'
const line = (o) => JSON.stringify(o)
const init = () => line({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-haiku-5-5', permissionMode: 'default' })
const say = (text) =>
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
    session_id: SID,
    uuid: randomUUID()
  })
const result = (text) => line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: SID, uuid: randomUUID() })
// A to-do tool call as the manual-mode CLI makes it: tool_use, a can_use_tool request (req-<id>) it waits on, the result.
const todoCall = (tool, args, id) => `#MCP_CALL ${line({ server: 'zumibot_todos', tool, args, id, permission: `req-${id}` })}`
const script = (...lines) => writeFile(h.script, lines.join('\n') + '\n')

// ---------- what the agent read ----------
let stdinFile = null
const stdinLines = async () =>
  (await readFile(stdinFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
/** The user message the fake read (its first stdin line), as text. */
async function readMessage() {
  let first = null
  await waitFor(async () => (first = (await stdinLines())[0] ?? null) !== null, 30_000, 'the fake claude to write its stdin')
  const c = first.message.content
  return typeof c === 'string' ? c : c.map((p) => p.text ?? '').join('')
}
const allowedFor = async (requestId) =>
  (await stdinLines()).some(
    (m) => m.type === 'control_response' && m.response?.request_id === requestId && m.response?.response?.behavior === 'allow'
  )

// ---------- UI helpers ----------
const composer = (page) => page.locator(tid('composer-input'))
const panel = (page) => page.locator(tid('todos-panel'))
const rowOf = (page, id) => panel(page).locator(`${tid('todo-row')}[data-todo-id="${id}"]`)
// No checkbox: a row's dot opens its status menu, and Done there ticks it, without opening its card.
async function pickStatus(page, id, status) {
  await rowOf(page, id).locator(tid('todo-row-dot')).click()
  await rowOf(page, id)
    .locator(`${tid('todo-status-option')}[data-col="${status}"]`)
    .click()
}
const tickRow = (page, id) => pickStatus(page, id, 'done')
const openRows = (page) => panel(page).locator(`${tid('todo-group')} ${tid('todo-row')}`)
const openTexts = (page) => openRows(page).locator(tid('todo-text')).allTextContents()
const doneToggle = (page) => panel(page).locator(tid('todo-done-toggle'))
const title = async (page) => (await panel(page).locator(tid('todos-title')).textContent())?.trim()
const titleIs = (page, n) =>
  waitFor(async () => (await title(page).catch(() => null)) === `To-dos · ${n} left`, T, `the panel title "To-dos · ${n} left"`)
const doneIs = (page, n) =>
  waitFor(
    async () =>
      (
        (await doneToggle(page)
          .textContent()
          .catch(() => '')) ?? ''
      ).includes(`Done · ${n}`),
    T,
    `the Done section to read "Done · ${n}"`
  )

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

/** Sends from the composer and waits until the reply `text` is shown, the chat is idle and the fake has exited. */
async function send(page, chatId, message, reply) {
  await rm(stdinFile, { force: true })
  await composer(page).click()
  await page.keyboard.type(message)
  await page.click(tid('send-button'))
  await waitReply(page, chatId, reply)
}

async function waitReply(page, chatId, reply) {
  // A to-do request the server failed to answer by itself would wait on a card: fail at once, by name.
  await waitFor(
    async () => {
      if ((await page.locator(tid('approval-card')).count()) > 0)
        throw new Error(`ASSERT FAILED: an approval card appeared before the reply "${reply}"`)
      return (await page.locator(tid('agent-message'), { hasText: reply }).count()) > 0
    },
    30_000,
    `the reply "${reply}"`
  )
  await waitFor(
    async () => {
      const m = await metaOf(chatId)
      return m && !m.inFlight && (await page.locator(tid('send-button')).textContent())?.trim() === 'Send'
    },
    30_000,
    `the reply "${reply}" to end`
  )
  await readMessage() // the run is over only when the fake has exited
}

/** The to-do line of the reply that reads `reply`: its chip and its change lines, or null when it has none. */
const todoLineOf = (page, reply) =>
  page.evaluate((reply) => {
    const msg = [...document.querySelectorAll('[data-testid="agent-message"]')].find((m) => m.textContent.includes(reply))
    const read = (el) => ({
      chip: el.querySelector('[data-testid="todo-chip-open"]')?.textContent ?? null,
      changes: [...el.querySelectorAll('[data-testid="todo-change"]')].map((c) => c.textContent)
    })
    // Inside the reply's own bubble; below the message only when the touch sits on a tools run.
    const inside = msg?.querySelector('.bubble [data-testid="todo-line"]')
    if (inside) return read(inside)
    for (let el = msg?.nextElementSibling; el && el.getAttribute('data-testid') !== 'agent-message'; el = el.nextElementSibling) {
      if (el.getAttribute('data-testid') === 'todo-line') return read(el)
    }
    return null
  }, reply)

/** Opens the side panel's To-dos view, from whatever the panel shows now. */
async function openTodos(page) {
  for (let i = 0; i < 3; i++) {
    if (
      await panel(page)
        .isVisible()
        .catch(() => false)
    )
      return
    if (
      await page
        .locator(tid('side-menu'))
        .isVisible()
        .catch(() => false)
    ) {
      await page.click(tid('side-open-todos'))
      await panel(page).waitFor({ timeout: T })
      return
    }
    // Another view (or none) is open: the panel icon closes it or opens the list.
    await page.click(tid('side-panel-toggle'))
    await sleep(150)
  }
  throw new Error('ASSERT FAILED: could not open the To-dos panel')
}

async function openDone(page) {
  if ((await doneToggle(page).getAttribute('aria-expanded')) !== 'true') await doneToggle(page).click()
  await waitFor(async () => (await doneToggle(page).getAttribute('aria-expanded')) === 'true', T, 'the Done section to open')
}

const noCardsOrToolRows = async (page, chatId, what) => {
  assert((await page.locator(tid('approval-card')).count()) === 0, `${what}: an approval card is shown`)
  assert((await page.locator(tid('tool-row')).count()) === 0, `${what}: a tool row is shown`)
  const stored = await itemsOf(chatId)
  assert(
    !stored.some((i) => i.type === 'approval' || i.type === 'tool'),
    `${what}: approval or tool items stored (${JSON.stringify(stored.filter((i) => i.type === 'approval' || i.type === 'tool'))})`
  )
}

const agentFile = (name, commands) =>
  `---\nname: ${name}\ndescription: To-dos e2e agent.\nmodel: haiku\n${commands}---\nYou are a test agent.\n`

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  stdinFile = join(await mk('stdin'), 'stdin.jsonl')
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    agentFile(AGENT, `commands:\n  - name: my-day\n    description: My day\n    todos: true\n    prompt: ${MY_DAY_PROMPT}\n`)
  )
  await writeFile(join(agentsDir, `${BETA}.md`), agentFile(BETA, ''))
  h = await start({ fake: FAKE, dataDir, agentsDir, env: { ZUMIBOT_TEST_PICK_FOLDER: folder, FAKE_STDIN_OUT: stdinFile } })
  const page = h.page

  // 1. /todo /my-day in a new chat: the agent adds 3 items through the real bridge; no approval card, no tool row
  await script(
    init(),
    todoCall(
      'add',
      {
        items: [
          { text: A, group: 'Slack' },
          { text: B, group: 'Invites' },
          { text: C_MD, group: 'Workiom' }
        ]
      },
      'toolu_add1'
    ),
    say('Here is your day.'),
    result('Here is your day.')
  )
  await page.locator(tid('new-chat-agent')).waitFor({ timeout: 30_000 })
  await page.click(tid('new-chat-agent'))
  await page.click(`${tid('new-chat-agent-option')}[data-agent-name="${AGENT}"]`)
  await pickFolder(page, folder)
  await rm(stdinFile, { force: true })
  await composer(page).click()
  await page.keyboard.type('/todo /my-day')
  await page.click(tid('send-button'))
  const chatId = await openedChat(page)
  await waitReply(page, chatId, 'Here is your day.')
  const read1 = await readMessage()
  assert(
    read1.includes(MY_DAY_PROMPT) && read1.includes(TODO_REQUEST),
    `the agent read ${JSON.stringify(read1)}: no filled prompt or request line`
  )
  assert(await allowedFor('req-toolu_add1'), 'the server sent no allow for the to-do tool request')
  const bubble = page.locator(tid('user-message')).last()
  assert((await bubble.locator(tid('todo-chip')).textContent())?.trim() === '/todo', 'the user bubble has no /todo chip')
  assert((await bubble.locator(tid('command-chip')).textContent())?.trim() === '/my-day', 'the user bubble has no /my-day chip')
  await waitFor(async () => (await todoLineOf(page, 'Here is your day.'))?.chip === '☑ 3 new to-dos', T, 'the reply chip "☑ 3 new to-dos"')
  await noCardsOrToolRows(page, chatId, 'the /todo turn')
  await page.locator(tid('todo-chip-open')).click()
  await panel(page).waitFor({ timeout: T })
  await titleIs(page, 3)
  const groups = panel(page).locator(tid('todo-group'))
  await waitFor(
    async () => (await groups.count()) === 1 && (await groups.first().getAttribute('data-todo-reply')) !== null,
    T,
    'one group pointing at its reply'
  )
  const label = (await groups.first().locator(tid('todo-group-label')).textContent())?.trim()
  assert(label === '/my-day', `the group is labelled ${JSON.stringify(label)}, not /my-day`)
  const headings = await groups.first().locator(tid('todo-heading')).allTextContents()
  assert(headings.join(',') === 'Slack,Invites,Workiom', `the headings are ${JSON.stringify(headings)}`)
  const texts1 = await openTexts(page)
  assert(texts1.join('|') === [A, B, C].join('|'), `the panel lists ${JSON.stringify(texts1)}`)
  assert((await panel(page).locator('a[href="https://example.com/wk-7"]').count()) === 1, 'the card link in the item text is not a link')
  ok(
    '1 /todo /my-day: 3 items added through the bridge, the panel shows them under /my-day, the reply reads "☑ 3 new to-dos", no card or tool row'
  )

  // 2. a tick in the panel reaches the agent's next message as the state note
  let items = await listOf(page, chatId)
  const [idA, idB, idC] = [idOf(items, A), idOf(items, B), idOf(items, C_MD)]
  assert((await rowOf(page, idA).locator(tid('todo-row-dot')).getAttribute('data-col')) === 'new', 'the row dot does not read New')
  assert((await panel(page).locator('input[type="checkbox"]').count()) === 0, 'the panel still shows a checkbox')
  await rowOf(page, idA).locator(tid('todo-row-dot')).click()
  const checked = await rowOf(page, idA)
    .locator(`${tid('todo-status-option')}[aria-checked="true"]`)
    .getAttribute('data-col')
  assert(
    checked === 'new' && (await rowOf(page, idA).locator(tid('todo-status-option')).count()) === 6,
    `the status menu checks ${checked}`
  )
  await page.keyboard.press('Escape')
  await rowOf(page, idA).locator(tid('todo-status-menu')).waitFor({ state: 'detached', timeout: T })
  assert((await panel(page).count()) === 1, 'Esc in the status menu closed the side panel')
  await tickRow(page, idA)
  assert((await panel(page).locator(tid('todo-card')).count()) === 0, 'ticking from the row opened a card')
  await titleIs(page, 2)
  await doneIs(page, 1)
  await script(init(), say('Two left for today.'), result('Two left for today.'))
  await send(page, chatId, 'What is left?', 'Two left for today.')
  const read2 = await readMessage()
  assert(
    read2.includes('ticked by the user') && read2.includes(A),
    `the next turn read ${JSON.stringify(read2)}: no note of the user's tick`
  )
  ok(`2 the user's tick in the panel is in the next turn's message ("ticked by the user: ${A}")`)

  // 3. the agent ticks an item: "☑ Ticked:" under its reply, "by agent" in Done
  await script(
    init(),
    todoCall('check', { ids: [idB], done: true }, 'toolu_check'),
    say('Accepted the invite from Homam.'),
    result('Accepted the invite from Homam.')
  )
  await send(page, chatId, 'Accept the Homam invite and tick it', 'Accepted the invite from Homam.')
  await waitFor(
    async () => {
      const l = await todoLineOf(page, 'Accepted the invite from Homam.')
      return l !== null && l.chip === null && l.changes.join('|') === `☑ Ticked: ${B}`
    },
    T,
    `the reply line "☑ Ticked: ${B}"`
  )
  assert(await allowedFor('req-toolu_check'), 'the server sent no allow for the check request')
  await noCardsOrToolRows(page, chatId, 'the check turn')
  await openTodos(page)
  await titleIs(page, 1)
  await doneIs(page, 2)
  await openDone(page)
  await waitFor(
    async () =>
      (await rowOf(page, idB)
        .locator(tid('todo-by'))
        .textContent()
        .catch(() => null)) === 'by agent',
    T,
    'B to show "by agent"'
  )
  assert((await rowOf(page, idA).locator(tid('todo-by')).count()) === 0, "the user's own tick shows a ticked-by mark")
  assert((await rowOf(page, idB).getAttribute('data-done')) === 'true', 'B is not shown done')
  ok(`3 the agent's check shows "☑ Ticked: ${B}" under its reply and "by agent" in Done`)

  // 4. ✕ removes, Undo brings it back, a second ✕ keeps it removed once the toast is gone
  const rowC = rowOf(page, idC)
  await rowC.hover()
  await rowC.locator(tid('todo-remove')).click()
  await rowC.waitFor({ state: 'detached', timeout: T })
  await panel(page).locator(tid('todo-toast')).waitFor({ timeout: T })
  await titleIs(page, 0)
  await panel(page).locator(tid('todo-undo')).click()
  await rowC.waitFor({ timeout: T })
  await titleIs(page, 1)
  assert((await panel(page).locator(tid('todo-toast')).count()) === 0, 'the toast stayed after Undo')
  assert(
    (await listOf(page, chatId)).some((i) => i.id === idC),
    'Undo did not restore the item on the server'
  )
  await rowC.hover()
  await rowC.locator(tid('todo-remove')).click()
  await rowC.waitFor({ state: 'detached', timeout: T })
  await panel(page).locator(tid('todo-toast')).waitFor({ state: 'detached', timeout: 10_000 }) // about 6 s
  assert((await rowC.count()) === 0, 'the removed item came back after the toast')
  assert(!(await listOf(page, chatId)).some((i) => i.id === idC), 'the removed item is still listed by the server')
  const tomb = JSON.parse(await readFile(boardFile(), 'utf8')).items.find((i) => i.id === idC)
  assert(tomb?.removed?.by === 'user', `the removal is not kept as a tombstone (${JSON.stringify(tomb)})`)
  ok('4 ✕ removes, Undo restores, a second ✕ keeps it removed after the toast')

  // 5. a flagged command without /todo still asks for a list
  await script(
    init(),
    todoCall(
      'add',
      {
        items: [
          { text: D, group: 'Workiom' },
          { text: E, group: 'Slack' }
        ]
      },
      'toolu_add2'
    ),
    say('Here is your day again.'),
    result('Here is your day again.')
  )
  await send(page, chatId, '/my-day', 'Here is your day again.')
  const read5 = await readMessage()
  assert(
    read5.includes(MY_DAY_PROMPT) && read5.includes(TODO_REQUEST),
    `the plain /my-day turn read ${JSON.stringify(read5)}: no request line`
  )
  const user5 = (await itemsOf(chatId)).filter((i) => i.type === 'user').at(-1)
  assert(user5.text === '/my-day' && user5.todo === true && user5.command?.todos === true, `the stored message is ${JSON.stringify(user5)}`)
  assert((await page.locator(tid('user-message')).last().locator(tid('todo-chip')).count()) === 0, 'a plain /my-day shows a /todo chip')
  await waitFor(
    async () => (await todoLineOf(page, 'Here is your day again.'))?.chip === '☑ 2 new to-dos',
    T,
    'the reply chip "☑ 2 new to-dos"'
  )
  await noCardsOrToolRows(page, chatId, 'the flagged turn')
  await openTodos(page)
  await titleIs(page, 2)
  await waitFor(async () => (await openTexts(page)).join('|') === [D, E].join('|'), T, 'the panel to list the two new items')
  ok(`5 a plain /my-day (flag on) puts the request line on stdin and adds 2 items`)

  // 6a. Fork copies no to-dos: they live once on the board, under the chat that made them
  items = await listOf(page, chatId)
  const lastReply = page.locator(tid('agent-message')).last()
  await lastReply.hover()
  await lastReply.locator(tid('fork-button')).click()
  const forkId = await openedChat(page, [chatId])
  assert((await listOf(page, forkId)).length === 0, "the fork's panel lists to-dos of its own")
  const boardNow = await rpc(page, 'todos:board')
  const fromSource = [...boardNow.open, ...boardNow.done].filter((i) => i.from.chatId === chatId)
  assert(fromSource.length === items.length, `the board holds ${fromSource.length} of the source chat's ${items.length} live to-dos`)
  await openTodos(page)
  await panel(page).locator(tid('todos-empty')).waitFor({ timeout: T })
  ok(`6a Fork copies no to-dos: its panel is empty, and the board keeps the source chat's ${items.length} once`)

  // 6b. Clone room makes no to-dos (a room made over RPC, its member adds two items first)
  const roomId = (await rpc(page, 'chats:createGroup', [AGENT, BETA], folder, '')).id
  await script(
    init(),
    todoCall('add', { items: [{ text: F }, { text: G }] }, 'toolu_room'),
    say('Room plan ready.'),
    result('Room plan ready.')
  )
  await rm(stdinFile, { force: true })
  await rpc(page, 'chats:send', roomId, `/todo @${AGENT} plan the launch`, [])
  await waitFor(
    async () => {
      const m = await metaOf(roomId)
      const stored = await itemsOf(roomId)
      return (
        m &&
        !m.inFlight &&
        m.group.active.length === 0 &&
        m.group.queue.length === 0 &&
        stored.some((i) => i.type === 'assistant' && i.agent === AGENT && i.text === 'Room plan ready.')
      )
    },
    30_000,
    'the room turn to end'
  )
  const roomList = await listOf(page, roomId)
  assert(
    roomList.map((i) => i.text).join('|') === [F, G].join('|') && roomList.every((i) => i.addedBy === AGENT),
    `the room's list is ${JSON.stringify(roomList)}`
  )
  await page.reload()
  const roomRow = page.locator(`${tid('group-row')}[data-chat-id="${roomId}"]`)
  await roomRow.waitFor({ timeout: T })
  await roomRow.click({ button: 'right' })
  await page.locator(tid('chat-menu-clone')).click()
  const dialog = page.locator(tid('clone-dialog'))
  await dialog.waitFor({ timeout: T })
  await waitFor(async () => (await dialog.getAttribute('data-step').catch(() => null)) === 'choose', T, 'the clone dialog')
  await page.locator(tid('clone-create')).click()
  await dialog.waitFor({ state: 'detached', timeout: T })
  const cloneId = await openedChat(page, [chatId, forkId, roomId])
  assert((await listOf(page, cloneId)).length === 0, 'the cloned room has to-dos')
  await openTodos(page)
  await panel(page).locator(tid('todos-empty')).waitFor({ timeout: T })
  assert((await listOf(page, roomId)).length === 2, 'cloning changed the source room list')
  ok('6b Clone room makes no to-dos; the source room keeps its 2')

  // 7. a reload keeps the list
  await page.goto(`${h.origin}/chat/${chatId}`)
  await composer(page).waitFor({ timeout: T })
  await page.reload()
  await composer(page).waitFor({ timeout: T })
  await openTodos(page)
  await titleIs(page, 2)
  await doneIs(page, 2)
  await waitFor(async () => (await openTexts(page)).join('|') === [D, E].join('|'), T, 'the panel to list D and E after the reload')
  await openDone(page)
  await waitFor(
    async () =>
      (await rowOf(page, idB)
        .locator(tid('todo-by'))
        .textContent()
        .catch(() => null)) === 'by agent',
    T,
    'B still "by agent"'
  )
  assert((await rowOf(page, idA).count()) === 1 && (await rowOf(page, idC).count()) === 0, 'after the reload A is gone or C is back')
  ok('7 after a reload the list is the same: D, E open, A and B done (B by agent), C removed')

  // 8. a second device sees a tick live
  ctx2 = await h.newContext()
  const p2 = await ctx2.newPage()
  await p2.goto(`${h.origin}/chat/${chatId}`)
  await composer(p2).waitFor({ timeout: T })
  await openTodos(p2)
  await titleIs(p2, 2)
  const idD = idOf(await listOf(page, chatId), D)
  await tickRow(page, idD)
  await titleIs(p2, 1)
  await doneIs(p2, 3)
  assert((await openTexts(p2)).join('|') === E, `the second device still lists ${JSON.stringify(await openTexts(p2))} as open`)
  ok('8 a tick on one device shows on the second device live (1 left, Done · 3)')

  // 9. a to-do typed by hand: one "Added by you" group, a repeat is refused, the next turn's note tells the agent
  const H = 'Buy oat milk'
  const addInput = panel(page).locator(tid('todo-add-input'))
  await addInput.click()
  await page.keyboard.type(`  ${H}  `)
  await page.keyboard.press('Enter')
  await titleIs(page, 2)
  await waitFor(
    async () => (await openTexts(page)).join('|') === [E, H].join('|') || (await openTexts(page)).join('|') === [H, E].join('|'),
    T,
    'the hand-added to-do in the open list'
  )
  const mineGroup = panel(page)
    .locator(tid('todo-group'))
    .filter({ has: page.locator(tid('todo-row'), { hasText: H }) })
  assert(
    (await mineGroup.locator(tid('todo-group-label')).textContent())?.trim() === 'Added by you',
    'the hand-added group is not labelled "Added by you"'
  )
  assert((await mineGroup.locator(tid('todo-show')).count()) === 0, 'the hand-added group offers Show in chat')
  assert(
    (await addInput.inputValue()) === '' && (await addInput.evaluate((el) => document.activeElement === el)),
    'the input was not cleared and kept focused after an add'
  )
  const mine = (await listOf(page, chatId)).find((i) => i.text === H)
  assert(
    mine?.addedBy === 'user' && mine.from.turn === 'user' && mine.from.itemId === null && mine.from.label === 'Added by you',
    `the stored item is ${JSON.stringify(mine)}`
  )
  await page.keyboard.type(H)
  await page.keyboard.press('Enter')
  await panel(page).locator(tid('todo-add-note')).waitFor({ timeout: T })
  assert(
    (await panel(page).locator(tid('todo-add-note')).textContent())?.trim() === 'Already on the list',
    'the repeat shows no "Already on the list" note'
  )
  assert((await addInput.inputValue()) === H, 'the text of a refused repeat was cleared')
  assert((await listOf(page, chatId)).filter((i) => i.text === H).length === 1, 'a repeat of an open to-do was added')
  await addInput.fill('')
  await script(init(), say('Noted.'), result('Noted.'))
  await send(page, chatId, 'what is left?', 'Noted.')
  const read9 = await readMessage()
  assert(read9.includes('added by the user') && read9.includes(H), `the next turn read ${JSON.stringify(read9)}: no "added by the user"`)
  // The row's picker: To do on a card nobody has opens it with the assignee picker first; Me then moves it.
  await pickStatus(page, mine.id, 'todo')
  await rowOf(page, mine.id).locator(tid('todo-give')).waitFor({ timeout: T })
  assert(
    (await listOf(page, chatId)).find((i) => i.id === mine.id)?.status === undefined,
    'the unassigned card moved before anyone was picked'
  )
  await pickOption(rowOf(page, mine.id).locator(tid('todo-give-agent')), { label: 'Me' })
  await rowOf(page, mine.id).locator(tid('todo-give-button')).click()
  await waitFor(
    async () =>
      (await rowOf(page, mine.id)
        .locator(tid('todo-row-dot'))
        .getAttribute('data-col')
        .catch(() => '')) === 'todo',
    T,
    'the row dot to read To do'
  )
  assert((await listOf(page, chatId)).find((i) => i.id === mine.id)?.assignee === 'user', 'the card is not assigned to the user')
  ok(
    '9 a to-do typed in the panel joins "Added by you", a repeat is refused, the next turn reads "added by the user", and the status menu on its dot asked who before To do'
  )

  const bad = unexpectedErrors(h.errors, [])
  assert(bad.length === 0, `unexpected errors: ${bad.join(' | ')}`)
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
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
console.log(failed ? 'e2e:todos FAILED' : 'e2e:todos passed')
process.exit(failed ? 1 : 0)
