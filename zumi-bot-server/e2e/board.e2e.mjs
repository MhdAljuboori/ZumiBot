// End-to-end check of the task board in the built server + web UI (local mode) against the FAKE claude, so it costs no
// quota. Usage: npm run e2e:board (builds first)
//
// The flow: a chat's to-do list from before the board moves onto it at a restart (made by the digest agent, in its chat,
// New); the board shows a column per status, the rail counts what is on the user's side; a card added on the board is
// yours, New and unassigned, and its drawer takes notes and an image; a drag of an unassigned card to To do asks who
// first (Me), the Move to menu takes it back to New; assigning an agent in the drawer starts nothing, a drag to To do
// starts the agent's chat with the card as its first message; the agent's question (the real zumibot_todos bridge,
// #MCP_CALL ask_user) moves the card to Blocked and into the Inbox, where it is answered; ready_for_review moves it to In
// review; a message from the drawer runs it again, and a turn that ends with neither lands in In review too; the drawer's
// Status back to New stops a running turn, To do carries on in the same chat; the checkbox ticks it into Done; the
// creator filter and /todos/<id> after a reload work; no checkbox is shown (Move to Done ticks); Kanban is the default view
// and Grid lists every card in a sortable table, completed ones hidden until asked; a search, the assignee and the creator
// filter both views; a column collapses to a strip that keeps its count, takes a drop
// and stays collapsed after a reload.
//
// Hard rules: nothing in ~/.claude is touched (the harness gives a throwaway HOME, agents dir and data dir); only the
// mkdtemp dirs made here are deleted, in `finally`; the server and Chrome are stopped in `finally`; overall timeout 4 min.
//
// DOM hooks relied on (data-testid): rail-todos, rail-todos-count, rail-inbox, rail-inbox-count, todo-board, board-col
//   (+ data-col), board-col-count, board-card (+ data-todo-id, data-col), board-card-open,
//   board-card-menu, board-menu-open, board-menu-copy-link, board-menu-remove, board-card-creator, board-filter, board-drawer, board-drawer-close, board-drawer-prev, board-drawer-next, board-drawer-pos,
//   todo-comment (+ data-by), todo-comment-input, todo-comment-post, todo-comment-edit, todo-comment-edit-input, todo-comment-save,
//   todo-comment-delete, todo-comment-pop (the floating @ and / lists), todo-hint-comments, board-card-assignee (the footer avatar's button), grid-assignee-button, board-card-state, board-scrim, board-view (+ data-view, aria-pressed), todo-grid, grid-row (+
//   data-todo-id, data-col), grid-open, grid-sort (+ data-key), grid-status-select, grid-show-done (+ aria-checked),
//   grid-done-hidden, board-search, board-filter-assignee, board-clear-filters, board-col-collapse, board-col-expand (+ the column's
//   data-collapsed), todo-add-input, todo-add-button, todo-card, todo-card-creator,
//   todo-card-status-select, todo-card-assignee, todo-card-assign (the chip: opens assignee-menu, assignee-menu-item + data-who), todo-card-starts, todo-card-state, todo-card-edit,
//   todo-card-notes-input, todo-card-save, todo-card-notes, todo-card-file-input, todo-card-paste, todo-card-file, todo-give,
//   todo-give-agent, todo-give-pick, todo-give-folder, todo-give-button, todo-question (+ data-answered), todo-option,
//   todo-card-send-answers, todo-card-review, todo-card-reply, todo-card-reply-send, todo-card-open-chat, inbox-card
//   (+ data-kind), inbox-open, inbox-answered, agent-message, user-message, todo-change, approval-card, todo-comment-ask,
//   card-ask (+ card-ask-status, card-ask-title, card-ask-open), full-prompt-toggle, full-prompt.
// Stored state read: <dataDir>/chats.json, <dataDir>/todos.json (the board), <dataDir>/chats/<id>.todos.json (gone).

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors, pickOption, selectValue } from './harness.mjs'
import { redPng } from './redPng.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-claude.mjs', import.meta.url))
const DIGEST = 'e2e-board-digest'
const AGENT = 'e2e-board-builder'
const AGENT_LABEL = 'E2e Board Builder' // displayName(AGENT): the box shows a mention by it
const PREFIX = 'zumibot-e2e-board-'
const OVERALL_TIMEOUT = 4 * 60_000
const T = 15_000
const TITLE = 'Export the March report'
const NOTES = 'Use the sales sheet.\n\nOne row per **region**.'
const QUESTION = 'CSV or JSON?'
const ASKED = 'I put a question on the card.'
const REVIEWED = 'The export is done.'
const HEADER = 'Added the header row.'
const STOPPED = 'Carrying on.'
const LEGACY = [
  ['m1', 'Reply to Morjan about the launch'],
  ['m2', 'Approve the budget sheet'],
  ['m3', 'Renew the domain']
]
const SHOTS = process.env.E2E_SHOTS_DIR ?? null

let h = null
const made = []
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
const shot = async (page, name) => {
  if (!SHOTS) return
  await sleep(350) // the drawer slides and fades in
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false })
}

// ---------- the fake claude's script, rewritten before each turn ----------
const SID = 'b1b2c3d4-0000-4000-8000-0000000000bb'
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
const todoCall = (tool, args, id) => `#MCP_CALL ${line({ server: 'zumibot_todos', tool, args, id, permission: `req-${id}` })}`
const script = (...lines) => writeFile(h.script, lines.join('\n') + '\n')

// ---------- what the agent read ----------
let stdinFile = null
let mcpOut = null
const stdinLines = async () =>
  (await readFile(stdinFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
async function firstMessage() {
  let first = null
  await waitFor(async () => (first = (await stdinLines())[0] ?? null) !== null, 30_000, 'the fake claude to write its stdin')
  return first.message.content
}
const textOf = (content) => (typeof content === 'string' ? content : content.map((p) => p.text ?? '').join(''))
const mcpResults = async () =>
  (await readFile(mcpOut, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

const storedChats = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats
const boardFile = async () => readFile(join(h.dataDir, 'todos.json'), 'utf8').then(JSON.parse)
const stored = async (id) => (await boardFile()).items.find((i) => i.id === id)

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

async function stop() {
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

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  const out = await mk('out')
  stdinFile = join(out, 'stdin.jsonl')
  mcpOut = join(out, 'mcp.jsonl')
  // The builder owns /card, so a comment's `@builder /card` shows as a command (step 14).
  const commandsOf = (name) =>
    name === AGENT ? 'commands:\n  - name: card\n    description: Make a card\n    prompt: "Make a card: $ARGUMENTS"\n' : ''
  for (const name of [DIGEST, AGENT])
    await writeFile(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: Board e2e agent.\nmodel: haiku\n${commandsOf(name)}---\nYou are a test agent.\n`
    )
  h = await start({
    fake: FAKE,
    dataDir,
    agentsDir,
    env: { ZUMIBOT_TEST_PICK_FOLDER: folder, FAKE_STDIN_OUT: stdinFile, FAKE_MCP_RESULTS_OUT: mcpOut }
  })
  const page = h.page
  const col = (c) => page.locator(`${tid('board-col')}[data-col="${c}"]`)
  const cardOf = (id) => page.locator(`${tid('board-card')}[data-todo-id="${id}"]`)
  const colOf = async (id) =>
    cardOf(id)
      .getAttribute('data-col')
      .catch(() => null)
  const inCol = (id, c, what) => waitFor(async () => (await colOf(id)) === c, 30_000, what)
  const drawer = page.locator(tid('board-drawer'))
  const card = drawer.locator(tid('todo-card'))
  const noCards = async (what) => assert((await page.locator(tid('approval-card')).count()) === 0, `${what}: an approval card is shown`)

  // 1. A chat's list from before the board moves onto it at the next start: made by the digest agent, in its chat, New.
  await page.locator(tid('rail-todos')).waitFor({ timeout: T })
  const digestChat = await rpc(page, 'chats:create', DIGEST, folder)
  const at = Date.now() - 2 * 86_400_000
  const legacy = {
    v: 1,
    rev: 3,
    seen: { [DIGEST]: 3 },
    items: LEGACY.map(([id, text], k) => ({
      id,
      text,
      group: null,
      from: { turn: 'turn-1', itemId: null, label: '/my-day', at: at + k },
      addedBy: DIGEST,
      done: k === 2 ? { at: at + 10, by: 'user' } : null,
      removed: null,
      last: { action: 'added', by: DIGEST, at },
      rev: 1,
      updatedAt: at + k
    }))
  }
  await mkdir(join(dataDir, 'chats'), { recursive: true })
  const legacyFile = join(dataDir, 'chats', `${digestChat.id}.todos.json`)
  await writeFile(legacyFile, JSON.stringify(legacy))
  await h.restartServer()
  await page.goto(`${h.origin}/todos`)
  await page.locator(tid('todo-board')).waitFor({ timeout: T })
  // The columns draw once the board's first fetch answers, after the page itself.
  await page.locator(tid('board-col')).first().waitFor({ timeout: T })
  const cols = await page.locator(tid('board-col')).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
  assert(JSON.stringify(cols) === JSON.stringify(['New', 'To do', 'Blocked', 'In progress', 'In review', 'Done']), `the columns: ${cols}`)
  await inCol('m1', 'new', 'the migrated card in New')
  assert((await colOf('m3')) === 'done', 'the migrated done card is not in Done')
  assert(
    ((await cardOf('m1').locator(tid('board-card-creator')).textContent()) ?? '').includes('@E2e Board Digest'),
    'the migrated card does not name its creator'
  )
  assert(
    (await cardOf('m1')
      .locator(`${tid('board-card-assignee')} .board-avatar.nobody`)
      .count()) === 1,
    'the migrated card has an assignee'
  )
  assert(!existsSync(legacyFile), "the chat's old list file is still there")
  assert((await stored('m1')).from.chatId === digestChat.id, 'the migrated card lost the chat it was made in')
  await waitFor(
    async () =>
      (await page
        .locator(tid('rail-todos-count'))
        .textContent()
        .catch(() => '')) === '2',
    T,
    'the rail to count the 2 new cards'
  )
  assert((await col('done').locator(tid('board-col-count')).textContent()) === '1', 'Done does not count 1')
  ok(
    "1 a chat's old list moved onto the board at the restart: six status columns, creator and chat kept, New and unassigned, done in Done, the old file gone"
  )
  await shot(page, '1-board')

  // 2. A card added on the board: by you, New, nobody assigned; its drawer takes notes and an image.
  await page.fill(tid('todo-add-input'), TITLE)
  await page.click(tid('todo-add-button'))
  const added = page.locator(tid('board-card'), { hasText: TITLE })
  await added.waitFor({ timeout: T })
  const todoId = await added.getAttribute('data-todo-id')
  assert((await added.getAttribute('data-col')) === 'new', 'the added card is not in New')
  await added.locator(tid('board-card-open')).click()
  await card.waitFor({ timeout: T })
  assert(new URL(page.url()).pathname === `/todos/${todoId}`, `the address is ${page.url()}, not the card's`)
  assert(((await card.locator(tid('todo-card-creator')).textContent()) ?? '').startsWith('you'), 'the card does not say who made it')
  assert((await card.locator(tid('todo-card-assignee')).textContent()) === 'Nobody', 'the card has an assignee')
  assert((await selectValue(card.locator(tid('todo-card-status-select')))) === 'new', 'the drawer status is not New')
  await card.locator(tid('todo-card-edit')).click()
  await card.locator(tid('todo-card-notes-input')).fill(NOTES)
  await card.locator(tid('todo-card-save')).click()
  await waitFor(
    async () =>
      (
        (await card
          .locator(tid('todo-card-notes'))
          .textContent()
          .catch(() => '')) ?? ''
      ).includes('One row per region'),
    T,
    'the notes to show, rendered'
  )
  await card.locator(tid('todo-card-file-input')).setInputFiles({ name: 'chart.png', mimeType: 'image/png', buffer: redPng() })
  await waitFor(async () => (await card.locator(tid('todo-card-file')).count()) === 1, T, 'the image on the card')
  // The image is a tile the size of the Add tile beside it, and opens in the app's viewer as a chat's image does.
  const thumb = card.locator(`${tid('todo-card-file')} .attach-thumb`)
  const [tb, ab] = [await thumb.boundingBox(), await card.locator(tid('todo-card-add-image')).boundingBox()]
  assert(
    tb && ab && Math.round(tb.width) === Math.round(ab.width) && Math.round(tb.height) === Math.round(ab.height),
    `the image tile is ${JSON.stringify(tb)}, the Add tile ${JSON.stringify(ab)}`
  )
  await thumb.click()
  const viewer = page.locator(tid('file-viewer'))
  await viewer.waitFor({ timeout: T })
  await waitFor(
    async () =>
      (await viewer
        .locator(tid('viewer-image'))
        .getAttribute('data-state')
        .catch(() => null)) === 'ready',
    T,
    'the image to load in the viewer'
  )
  await shot(page, '2-image-viewer')
  await viewer.locator(tid('viewer-close')).click()
  await viewer.waitFor({ state: 'detached', timeout: T })
  assert(await drawer.isVisible(), 'closing the viewer closed the drawer')
  const s2 = await stored(todoId)
  assert(
    s2.addedBy === 'user' &&
      s2.from.chatId === null &&
      s2.description === NOTES.trim() &&
      s2.files?.[0]?.kind === 'image' &&
      !('assignee' in s2),
    `the stored card: ${JSON.stringify(s2)}`
  )
  // The paste box takes a pasted image (named as the composer names one) and ignores pasted text.
  const pasteInto = (b64) =>
    card.locator(tid('todo-card-paste')).evaluate((el, data) => {
      const dt = new DataTransfer()
      if (data) dt.items.add(new File([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], 'image.png', { type: 'image/png' }))
      else dt.setData('text/plain', 'just text')
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, b64)
  await pasteInto(null)
  await pasteInto(redPng().toString('base64'))
  await waitFor(async () => (await card.locator(tid('todo-card-file')).count()) === 2, T, 'the pasted image on the card')
  assert((await card.locator(tid('todo-card-paste')).inputValue()) === '', 'pasted text stayed in the paste box')
  const s2b = await stored(todoId)
  assert(s2b.files?.length === 2 && /^pasted-\d{8}-\d{6}\.png$/.test(s2b.files[1].name), `the pasted file: ${JSON.stringify(s2b.files)}`)
  await card.locator(tid('todo-card-file-remove')).nth(1).click()
  await waitFor(async () => (await card.locator(tid('todo-card-file')).count()) === 1, T, 'the pasted image removed')
  await shot(page, '2-drawer-filled')
  if (SHOTS) {
    // The expanded layout, for the record only: shrunk again so the steps after see the drawer as before.
    await page.click(tid('board-drawer-expand'))
    await shot(page, '2-drawer-expanded')
    await page.click(tid('board-drawer-expand'))
  }
  await page.click(tid('board-drawer-close'))
  await drawer.waitFor({ state: 'detached', timeout: T })
  ok('2 a card added on the board is yours, New and unassigned; its drawer took notes and an image')

  // 3. A drag of an unassigned card to To do asks who first; Me moves it there. The Move to menu takes it back to New.
  await cardOf('m1').dragTo(col('todo'))
  await card.locator(tid('todo-give')).waitFor({ timeout: T })
  assert((await colOf('m1')) === 'new', 'the unassigned card moved before anyone was picked')
  await pickOption(card.locator(tid('todo-give-agent')), { label: 'Me' })
  assert((await card.locator(tid('todo-give-button')).textContent()) === 'Assign and move to To do', 'the button does not say the move')
  await card.locator(tid('todo-give-button')).click()
  await inCol('m1', 'todo', 'the card in To do')
  assert((await stored('m1')).assignee === 'user', 'the card is not assigned to the user')
  assert((await cardOf('m1').locator(tid('board-card-assignee')).textContent()) === 'You', 'the board card does not name its assignee')
  await page.click(tid('board-drawer-close'))
  await cardOf('m1').dragTo(col('new'))
  await inCol('m1', 'new', 'the card back in New')
  assert(
    (await stored('m1')).status === 'new' && (await stored('m1')).assignee === 'user',
    `the card back in New: ${JSON.stringify(await stored('m1'))}`
  )
  ok('3 a drag of an unassigned card to To do asked who first, Me moved it there; a drag took it back to New, still yours')

  // 4. Assigning the agent starts nothing; a drag to To do starts its chat with the card, and its question blocks the card.
  await cardOf(todoId).locator(tid('board-card-open')).click()
  await card.locator(tid('todo-card-assign')).click()
  // The chip opens the assignee menu (portalled to <body>); an agent opens the form with it chosen, to confirm the folder.
  await page.locator(`${tid('assignee-menu')} ${tid('assignee-menu-item')}[data-who="${AGENT}"]`).click()
  assert((await selectValue(card.locator(tid('todo-give-agent')))) === AGENT, 'the agent picked in the menu is not chosen in the form')
  await card.locator(tid('todo-give-pick')).click()
  await waitFor(async () => (await card.locator(tid('todo-give-folder')).textContent()) === folder, T, 'the picked folder')
  await card.locator(tid('todo-give-button')).click()
  await card.locator(tid('todo-card-starts')).waitFor({ timeout: T })
  const s4 = await stored(todoId)
  assert(
    s4.assignee === AGENT && s4.folder === folder && (s4.status ?? 'new') === 'new' && !s4.task,
    `the assigned card: ${JSON.stringify(s4)}`
  )
  assert(!(await storedChats()).some((c) => c.task?.todoId === todoId), 'assigning made a chat')
  await page.click(tid('board-drawer-close'))
  await script(
    init(),
    todoCall('ask_user', { questions: [{ question: QUESTION, options: ['CSV', 'JSON'] }] }, 'toolu_ask'),
    say(ASKED),
    result(ASKED)
  )
  await cardOf(todoId).dragTo(col('todo'))
  await inCol(todoId, 'blocked', 'the card in Blocked')
  const chat = (await storedChats()).find((c) => c.task?.todoId === todoId)
  assert(chat && chat.agentName === AGENT && chat.cwd === folder && chat.title === TITLE, `the task chat: ${JSON.stringify(chat)}`)
  const first = await firstMessage()
  assert(Array.isArray(first) && first.some((p) => p.type === 'image'), 'the first message carries no image block')
  const firstText = textOf(first)
  for (const want of [`Task: ${TITLE}`, 'One row per **region**.', 'This chat works on a task card', 'mcp__zumibot_todos__ask_user']) {
    assert(firstText.includes(want), `the first message lacks ${JSON.stringify(want)}: ${firstText}`)
  }
  assert(
    (await mcpResults()).some((r) => r.tool === 'mcp__zumibot_todos__ask_user' && !r.isError),
    `ask_user result: ${JSON.stringify(await mcpResults())}`
  )
  await cardOf(todoId).locator(tid('board-card-open')).click()
  assert(((await card.locator(tid('todo-question')).textContent()) ?? '').includes(QUESTION), 'the question is not on the card')
  await noCards('after ask_user')
  ok('4 assigning the agent started nothing; a drag to To do started its chat with the card, and its question moved the card to Blocked')
  await shot(page, '4-blocked')

  // 5. The question waits in the Inbox; Open to-do opens the drawer; the answer from the Inbox reaches the agent, which
  //    marks the card ready for review.
  await page.click(tid('board-drawer-close'))
  await waitFor(
    async () =>
      (await page
        .locator(tid('rail-inbox-count'))
        .textContent()
        .catch(() => '')) === '1',
    T,
    'the Inbox to count the card'
  )
  await page.click(tid('rail-inbox'))
  const entry = page.locator(`${tid('inbox-card')}[data-kind="todo"]`)
  await entry.waitFor({ timeout: T })
  await entry.locator(tid('inbox-open')).click()
  await card.waitFor({ timeout: T })
  assert(new URL(page.url()).pathname === `/todos/${todoId}`, 'Open to-do did not open the card on the board')
  await rm(stdinFile, { force: true })
  await script(
    init(),
    todoCall('ready_for_review', { summary: 'Exported to **march.csv**.' }, 'toolu_review'),
    say(REVIEWED),
    result(REVIEWED)
  )
  await page.click(tid('rail-inbox'))
  await entry.locator(tid('todo-option'), { hasText: 'CSV' }).click()
  await entry.locator(tid('todo-card-send-answers')).click()
  await waitFor(
    async () =>
      (
        (await page
          .locator(tid('inbox-answered'))
          .textContent()
          .catch(() => '')) ?? ''
      ).startsWith(`✓ Answered · ${QUESTION}`),
    T,
    'the answered line'
  )
  const answers = textOf(await firstMessage())
  assert(answers.startsWith(`Answers to your questions on the task card:\n\n> ${QUESTION}\n\nCSV`), `the answers message: ${answers}`)
  await page.click(tid('rail-todos'))
  await inCol(todoId, 'review', 'the card in In review')
  await cardOf(todoId).locator(tid('board-card-open')).click()
  assert(
    ((await card.locator(tid('todo-card-review')).textContent()) ?? '').includes('Exported to march.csv'),
    'the review summary is not shown'
  )
  ok('5 the question waited in the Inbox, Open to-do opened the card, the answer went to the chat, and the review moved it to In review')

  // 6. A message from the drawer runs the agent again; a turn that ends with neither a question nor a review lands in In
  //    review too. The chat holds the whole exchange.
  await rm(stdinFile, { force: true })
  await script(init(), '#SLEEP 1500', say(HEADER), result(HEADER))
  await card.locator(tid('todo-card-reply')).fill('Add a header row too.')
  await card.locator(tid('todo-card-reply-send')).click()
  await inCol(todoId, 'progress', 'the card in In progress while its turn runs')
  await waitFor(
    async () =>
      (await card
        .locator(tid('todo-card-state'))
        .textContent()
        .catch(() => '')) === 'Working…',
    T,
    'the drawer to say Working…'
  )
  assert(textOf(await firstMessage()).startsWith('Add a header row too.'), 'the reply did not reach the agent')
  await inCol(todoId, 'review', 'the card back in In review after a plain turn')
  await card.locator(tid('todo-card-open-chat')).click()
  await page.locator(tid('agent-message'), { hasText: HEADER }).waitFor({ timeout: T })
  assert((await page.locator(tid('user-message')).count()) === 3, 'the chat does not hold the card, the answers and the message')
  const changes = await page.locator(tid('todo-change')).allTextContents()
  assert(
    changes.some((c) => c.includes(`Asked on the task card: ${QUESTION}`)) && changes.some((c) => c.includes('ready for review')),
    `the to-do lines: ${JSON.stringify(changes)}`
  )
  ok(
    '6 a message from the drawer ran the agent (In progress, Working…), and its plain turn put the card back in In review; the chat holds it all'
  )

  // 7. Status New stops a running turn; To do again carries on in the same chat.
  await page.click(tid('rail-todos'))
  await rm(stdinFile, { force: true })
  await script(init(), '#SLEEP 20000', say('never'), result('never'))
  await cardOf(todoId).locator(tid('board-card-open')).click()
  await card.locator(tid('todo-card-reply')).fill('One more thing.')
  await card.locator(tid('todo-card-reply-send')).click()
  await inCol(todoId, 'progress', 'the card in In progress')
  await pickOption(card.locator(tid('todo-card-status-select')), 'new')
  await waitFor(async () => (await storedChats()).find((c) => c.id === chat.id)?.inFlight !== true, 30_000, 'the stopped turn to end')
  await inCol(todoId, 'new', 'the stopped card in New')
  await rm(stdinFile, { force: true })
  await script(init(), say(STOPPED), result(STOPPED))
  // The board is dimmed under the drawer and takes no drag there: close it first.
  await page.click(tid('board-drawer-close'))
  await cardOf(todoId).dragTo(col('todo'))
  await inCol(todoId, 'review', 'the carried-on card in In review')
  assert(textOf(await firstMessage()).startsWith('Carry on with the task on the card.'), 'To do did not tell the chat to carry on')
  assert((await storedChats()).filter((c) => c.task?.todoId === todoId).length === 1, 'To do made a second chat')
  ok('7 Status New stopped the running turn; To do carried on in the same chat')

  // 8. Move to Done ticks the card (no checkbox anywhere); the filter shows one creator's cards; /todos/<id> opens the card
  //    after a reload.
  assert((await page.locator('input[type="checkbox"]').count()) === 0, 'the board still shows a checkbox')
  await cardOf(todoId).dragTo(col('done'))
  await inCol(todoId, 'done', 'the card moved to Done')
  assert((await stored(todoId)).done?.by === 'user', 'Done did not tick the card')
  await waitFor(async () => (await col('done').locator(tid('board-col-count')).textContent()) === '2', T, 'Done to count 2')
  await pickOption(page.locator(tid('board-filter')), 'user')
  await waitFor(async () => (await page.locator(tid('board-card')).count()) === 1, T, 'only your card under Made by you')
  await pickOption(page.locator(tid('board-filter')), 'all')
  await page.goto(`${h.origin}/todos/m2`)
  await waitFor(
    async () =>
      (await drawer
        .locator(tid('board-drawer-title'))
        .textContent()
        .catch(() => '')) === 'Approve the budget sheet',
    T,
    'the drawer opened from the address'
  )
  assert(
    ((await card.locator(tid('todo-card-creator')).textContent()) ?? '').includes('@E2e Board Digest'),
    "the old card's drawer does not name its creator"
  )
  ok('8 Move to Done ticked the card, the filter showed your cards only, and /todos/<id> opened a card after a reload')
  await shot(page, '8-drawer')

  // 9. A column collapses to a strip that keeps its count and still takes a drop; the choice outlives a reload.
  await page.click(tid('board-drawer-close'))
  await col('blocked').locator(tid('board-col-collapse')).click()
  await waitFor(async () => (await col('blocked').getAttribute('data-collapsed')) === 'true', T, 'Blocked to collapse')
  await page.reload()
  await waitFor(
    async () =>
      (await col('blocked')
        .getAttribute('data-collapsed')
        .catch(() => null)) === 'true',
    T,
    'Blocked to stay collapsed after a reload'
  )
  assert((await col('blocked').locator(tid('board-col-count')).textContent()) === '0', 'the strip does not count 0')
  await cardOf('m1').dragTo(col('blocked'))
  await waitFor(
    async () => (await col('blocked').locator(tid('board-col-count')).textContent()) === '1',
    T,
    'the strip to count the dropped card'
  )
  assert((await stored('m1')).status === 'blocked', `the card dropped on the strip: ${JSON.stringify(await stored('m1'))}`)
  assert((await col('blocked').locator(tid('board-card')).count()) === 0, 'the collapsed column shows its cards')
  await shot(page, '9-collapsed')
  await col('blocked').locator(tid('board-col-expand')).click()
  await inCol('m1', 'blocked', 'the dropped card in Blocked, opened again')
  ok('9 a column collapsed to a strip with its count, stayed collapsed after a reload, took a drop, and opened again')

  // 10. Kanban is the default view; Grid lists every card in one sortable table whose Status moves a card, a row opens
  //     the card, the choice lasts while the page is left, and a reload starts on Kanban again.
  const view = (v) => page.locator(`${tid('board-view')}[data-view="${v}"]`)
  assert((await view('kanban').getAttribute('aria-pressed')) === 'true', 'Kanban is not the default view')
  await view('grid').click()
  const grid = page.locator(tid('todo-grid'))
  await grid.waitFor({ timeout: T })
  assert((await page.locator(tid('board-columns')).count()) === 0, 'the columns still show under Grid')
  const rowIn = (id) => grid.locator(`${tid('grid-row')}[data-todo-id="${id}"]`)
  const gridTexts = () => grid.locator(tid('grid-open')).allTextContents()
  await waitFor(
    async () => (await grid.locator(tid('grid-row')).count()) === 2,
    T,
    'the grid to list the 2 open cards, completed ones hidden'
  )
  assert(
    ((await grid.locator(tid('grid-done-hidden')).textContent()) ?? '').startsWith('2 completed tasks hidden'),
    'the grid does not say 2 completed are hidden'
  )
  assert((await page.locator(tid('grid-show-done')).getAttribute('aria-checked')) === 'false', 'Show completed is on by default')
  await page.locator(tid('grid-show-done')).click()
  await waitFor(async () => (await grid.locator(tid('grid-row')).count()) === 4, T, 'Show completed to list all 4 cards')
  assert((await rowIn(todoId).getAttribute('data-col')) === 'done', 'the done card is not Done in the grid')
  await grid.locator(`${tid('grid-sort')}[data-key="title"]`).click()
  const asc = await gridTexts()
  assert(
    JSON.stringify(asc) === JSON.stringify([...asc].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))),
    `the grid is not sorted by title: ${asc}`
  )
  // The drawer steps through the rows in the order the table shows them: buttons, J and K, never while typing.
  // Compared by id: a row's text also holds its hints (a files count).
  const rowIds = await grid.locator(tid('grid-row')).evaluateAll((els) => els.map((e) => e.getAttribute('data-todo-id')))
  const openRow = () =>
    grid
      .locator(`${tid('grid-row')}.open`)
      .getAttribute('data-todo-id')
      .catch(() => null)
  await grid.locator(tid('grid-open')).first().click()
  await waitFor(async () => (await openRow()) === rowIds[0], T, 'the first row to open')
  assert((await drawer.locator(tid('board-drawer-pos')).textContent()) === '1 of 4', 'the drawer does not say 1 of 4')
  assert(await drawer.locator(tid('board-drawer-prev')).isDisabled(), 'Previous is enabled on the first row')
  await drawer.locator(tid('board-drawer-next')).click()
  await waitFor(async () => (await openRow()) === rowIds[1], T, 'Next to open the second row')
  await page.keyboard.press('j')
  await waitFor(async () => (await openRow()) === rowIds[2], T, 'J to open the third row')
  await page.keyboard.press('k')
  await waitFor(async () => (await openRow()) === rowIds[1], T, 'K to go back to the second row')
  await drawer.locator(tid('todo-comment-input')).press('j')
  await new Promise((r) => setTimeout(r, 300))
  assert((await openRow()) === rowIds[1], 'J typed in the comment box stepped to another card')
  await drawer.locator(tid('todo-comment-input')).fill('')
  await page.click(tid('board-drawer-close'))
  await pickOption(rowIn('m2').locator(tid('grid-status-select')), 'review')
  await waitFor(async () => (await stored('m2')).status === 'review', T, 'the grid status to move m2 to In review')
  await waitFor(async () => (await rowIn('m2').getAttribute('data-col')) === 'review', T, 'the row to read In review')
  await pickOption(rowIn('m2').locator(tid('grid-status-select')), 'todo')
  await card.locator(tid('todo-give')).waitFor({ timeout: T }) // nobody has it: who first
  assert((await stored('m2')).status === 'review', 'the unassigned card moved before anyone was picked')
  await page.click(tid('board-drawer-close'))
  await shot(page, '10-grid')
  await rowIn('m1').locator('td').nth(3).click()
  await waitFor(
    async () =>
      (await drawer
        .locator(tid('board-drawer-title'))
        .textContent()
        .catch(() => '')) === 'Reply to Morjan about the launch',
    T,
    'a row click to open its card'
  )
  await page.click(tid('board-drawer-close'))
  await page.click(tid('rail-inbox'))
  await page.click(tid('rail-todos'))
  await grid.waitFor({ timeout: T })
  await page.reload()
  await page.locator(tid('board-columns')).waitFor({ timeout: T })
  assert((await view('kanban').getAttribute('aria-pressed')) === 'true', 'a reload did not start on Kanban')
  // On Kanban the drawer reads the columns left to right, each top to bottom: the cards' own order on the page.
  const kanbanIds = await page.locator(tid('board-card')).evaluateAll((els) => els.map((e) => e.getAttribute('data-todo-id')))
  await cardOf(kanbanIds[0]).locator(tid('board-card-open')).click()
  await waitFor(
    async () =>
      (await drawer
        .locator(tid('board-drawer-pos'))
        .textContent()
        .catch(() => '')) === `1 of ${kanbanIds.length}`,
    T,
    'the first Kanban card to open at 1'
  )
  await page.keyboard.press('j')
  await waitFor(
    async () =>
      (await page
        .locator(`${tid('board-card')}.open`)
        .getAttribute('data-todo-id')
        .catch(() => null)) === kanbanIds[1],
    T,
    'J to open the next Kanban card'
  )
  await shot(page, '10-drawer-nav')
  await page.click(tid('board-drawer-close'))
  ok(
    '10 Kanban is the default; Grid hid completed cards until Show completed, then listed every card, sorted by title, moved a card through its Status (asking who for To do), opened a card from a row, lasted while the page was left, and a reload went back to Kanban; the drawer stepped through the rows and cards in view order with its buttons, J and K, but not from the comment box'
  )

  // 11. Filters, in both views: a search, an assignee, Clear; they hold across views, and Show completed is kept on the
  //     device.
  await page.fill(tid('board-search'), 'budget')
  await waitFor(async () => (await page.locator(tid('board-card')).count()) === 1, T, 'the search to leave one card on the board')
  assert((await cardOf('m2').count()) === 1, 'the search did not keep the budget card')
  await view('grid').click()
  await grid.waitFor({ timeout: T })
  assert(
    (await page.locator(tid('grid-show-done')).getAttribute('aria-checked')) === 'true',
    'Show completed was not kept after the reload'
  )
  await waitFor(async () => (await grid.locator(tid('grid-row')).count()) === 1, T, 'the search to hold in the grid')
  await page.locator(tid('board-clear-filters')).click()
  await pickOption(page.locator(tid('board-filter-assignee')), 'user')
  await waitFor(
    async () => JSON.stringify(await gridTexts()) === JSON.stringify(['Reply to Morjan about the launch']),
    T,
    'Assigned to you to keep only your card'
  )
  await pickOption(page.locator(tid('board-filter-assignee')), 'none')
  await waitFor(async () => (await grid.locator(tid('grid-row')).count()) === 2, T, 'Unassigned to keep the 2 cards nobody has, one done')
  await shot(page, '11-filters')
  await page.locator(tid('grid-show-done')).click()
  await waitFor(async () => (await grid.locator(tid('grid-row')).count()) === 1, T, 'hiding completed to leave the open unassigned card')
  assert(
    ((await grid.locator(tid('grid-done-hidden')).textContent()) ?? '').startsWith('1 completed task hidden'),
    'the hidden count does not follow the filter'
  )
  await page.locator(tid('board-clear-filters')).click()
  assert((await page.locator(tid('board-clear-filters')).count()) === 0, 'Clear filters still shows with nothing set')
  await view('kanban').click()
  await waitFor(async () => (await page.locator(tid('board-card')).count()) === 4, T, 'every card back on the board')
  ok(
    '11 a search, Assigned to you and Unassigned filtered both views and held across them, Clear reset them, and Show completed was kept on the device'
  )

  // 12. The assignee changes in place, on a Kanban card and in a grid row, without opening the drawer.
  await cardOf('m2').locator(tid('board-card-assignee')).click()
  await page.locator(`${tid('assignee-menu')} ${tid('assignee-menu-item')}[data-who="user"]`).click()
  await waitFor(async () => (await stored('m2')).assignee === 'user', T, "the Kanban card's assignee menu to give m2 to the user")
  await waitFor(async () => (await cardOf('m2').locator(tid('board-card-assignee')).textContent()) === 'You', T, 'the card to read you')
  assert((await page.locator(tid('board-drawer')).count()) === 0, 'the assignee menu opened the drawer')
  await shot(page, '12-kanban-assignee')
  await view('grid').click()
  await grid.waitFor({ timeout: T })
  const m2Row = grid.locator(`${tid('grid-row')}[data-todo-id="m2"]`)
  await m2Row.locator(tid('grid-assignee-button')).click()
  await page.locator(`${tid('assignee-menu')} ${tid('assignee-menu-item')}[data-who=""]`).click()
  await waitFor(async () => (await stored('m2')).assignee === undefined, T, "the grid's assignee menu to unassign m2")
  await waitFor(async () => (await m2Row.locator(tid('grid-assignee')).textContent()) === 'unassigned', T, 'the row to read unassigned')
  assert((await page.locator(tid('board-drawer')).count()) === 0, "the grid's assignee menu opened the drawer")
  await view('kanban').click()
  ok('12 the assignee changed in place on a Kanban card and in a grid row, with no drawer')

  // 13. Comments: posted from the drawer, counted on the card, edited (marked edited) and deleted (a tombstone stays).
  await cardOf('m2').locator(tid('board-card-open')).click()
  const drawer13 = page.locator(tid('board-drawer'))
  await drawer13.locator(tid('todo-comment-input')).fill('Check the **Q3** numbers first')
  await drawer13.locator(tid('todo-comment-post')).click()
  await waitFor(async () => (await stored('m2')).comments?.length === 1, T, 'the comment to be stored')
  await drawer13.locator(tid('todo-comment')).waitFor({ timeout: T })
  assert(
    ((await drawer13.locator(tid('todo-comment')).textContent()) ?? '').includes('Check the Q3 numbers first'),
    'the comment does not show'
  )
  assert(((await drawer13.locator(tid('todo-comment-input')).textContent()) ?? '') === '', 'the box was not cleared')
  await waitFor(
    async () => ((await cardOf('m2').locator(tid('todo-hint-comments')).textContent()) ?? '').includes('1'),
    T,
    'the card to count its comment'
  )
  await shot(page, '13-comments')
  await drawer13.locator(tid('todo-comment-edit')).click()
  await drawer13.locator(tid('todo-comment-edit-input')).fill('Check the Q4 numbers first')
  await drawer13.locator(tid('todo-comment-save')).click()
  await waitFor(async () => (await stored('m2')).comments[0].text === 'Check the Q4 numbers first', T, 'the edit to be stored')
  await waitFor(
    async () => ((await drawer13.locator(tid('todo-comment')).textContent()) ?? '').includes('edited'),
    T,
    'the comment to read edited'
  )
  // Delete asks in the app's own dialog, never the browser's: Esc closes only the dialog, the drawer stays open.
  page.once('dialog', (d) => {
    void d.dismiss()
    throw new Error(`a browser dialog opened: ${d.message()}`)
  })
  const confirm13 = page.getByRole('dialog', { name: 'Delete this comment?' })
  await drawer13.locator(tid('todo-comment-delete')).click()
  await confirm13.waitFor({ timeout: T })
  await shot(page, '13-delete-confirm')
  await page.keyboard.press('Escape')
  await confirm13.waitFor({ state: 'detached', timeout: T })
  assert(await drawer13.isVisible(), 'Esc in the delete dialog closed the drawer')
  assert((await stored('m2')).comments[0].deletedAt === undefined, 'Esc deleted the comment')
  await drawer13.locator(tid('todo-comment-delete')).click()
  await confirm13.getByRole('button', { name: 'Delete' }).click()
  await waitFor(async () => (await stored('m2')).comments[0].deletedAt !== undefined, T, 'the delete to leave a tombstone')
  await waitFor(async () => (await drawer13.locator(tid('todo-comment')).count()) === 0, T, 'the deleted comment to go from the drawer')
  assert((await stored('m2')).comments[0].text === '', 'a deleted comment kept its text')
  await page.click(tid('board-drawer-close'))
  ok('13 a comment was posted from the drawer, counted on the card, edited and deleted (kept as a tombstone)')

  // 14. An @agent in a comment: the `@` list picks the agent, it answers in its own chat for the card, and its last
  // message lands as a reply under the comment; a plain reply from the drawer joins the same thread and asks that agent again.
  const ANSWER = 'Made a card for it: **Check Q3**.'
  await script(init(), '#SLEEP 800', say(ANSWER), result(ANSWER))
  await cardOf('m2').locator(tid('board-card-open')).click()
  const drawer14 = page.locator(tid('board-drawer'))
  const box14 = drawer14.locator(tid('todo-comment-input'))
  await box14.click()
  await box14.pressSequentially('Please @e2e-board-b')
  // The list floats in a portal on the body, outside the drawer.
  await page
    .locator(`${tid('todo-comment-pop')} ${tid('mention-option')}`)
    .first()
    .waitFor({ timeout: T })
  await shot(page, '14-mention-list')
  await box14.press('Enter')
  await box14.pressSequentially('/card make a card for this')
  // The /card the mentioned agent owns is tinted in the box, as the composer tints a command.
  await waitFor(
    async () => (await drawer14.locator('.todo-comment-input .composer-mark').allTextContents()).includes('/card'),
    T,
    'the box to mark /card'
  )
  // Away from the caret the handle reads as the agent's display name, as in the composer; the hidden raw handle stays the text.
  assert(
    (await drawer14.locator('.composer-mention').textContent()) === `@${AGENT_LABEL}`,
    `the box does not show the mention's name: ${await drawer14.locator('.composer-mention').textContent()}`
  )
  assert((await drawer14.locator('.composer-mention-raw').textContent()) === `@${AGENT}`, 'the @ list did not insert the handle')
  await shot(page, '14-mention-box')
  await drawer14.locator(tid('todo-comment-post')).click()
  await waitFor(async () => (await stored('m2')).comments?.some((c) => c.asked?.[0] === AGENT), T, 'the comment to store the asked agent')
  await drawer14.locator(tid('todo-comment-ask')).waitFor({ timeout: T })
  // Posted, it reads as the chat's command chip.
  assert(
    (await drawer14
      .locator(`${tid('todo-comment')}[data-by="user"] ${tid('comment-command')}`)
      .first()
      .textContent()) === '/card',
    'the posted comment shows no /card chip'
  )
  await waitFor(async () => (await stored('m2')).comments?.some((c) => c.by === AGENT && c.replyTo), T, 'the agent reply to be posted')
  const asked14 = (await stored('m2')).comments.find((c) => c.asked)
  const reply14 = (await stored('m2')).comments.find((c) => c.by === AGENT)
  assert(reply14.replyTo === asked14.id && reply14.text === ANSWER, `the reply: ${JSON.stringify(reply14)}`)
  const commentChat = (await storedChats()).find((c) => c.cardComments?.todoId === 'm2')
  assert(commentChat && commentChat.agentName === AGENT, "no chat for the card's comments")
  await drawer14.locator(`${tid('todo-replies')} ${tid('todo-comment')}[data-by="${AGENT}"]`).waitFor({ timeout: T })
  await waitFor(
    async () => (await drawer14.locator(tid('todo-comment-ask')).getAttribute('data-state')) === 'answered',
    T,
    'the ask chip to read answered'
  )
  await drawer14.locator(tid('todo-comment-reply')).first().click()
  await drawer14.locator(tid('todo-reply-input')).fill('Thanks!')
  await drawer14.locator(tid('todo-reply-post')).click()
  await waitFor(
    async () => (await stored('m2')).comments.filter((c) => c.replyTo === asked14.id).length >= 2,
    T,
    'the user reply to join the thread'
  )
  // A reply with no @ goes on with the thread's agent, which answers it in the same chat. Who it asks lands once the
  // routing call is over (the fake claude gives it no answer, so every candidate is asked).
  await waitFor(
    async () => (await stored('m2')).comments.find((c) => c.text === 'Thanks!')?.routing === undefined,
    T,
    'the plain reply to finish picking who to ask'
  )
  const thanks14 = (await stored('m2')).comments.find((c) => c.text === 'Thanks!')
  assert(thanks14.asked?.[0] === AGENT, `the plain reply did not ask the thread's agent: ${JSON.stringify(thanks14)}`)
  await waitFor(
    async () => (await stored('m2')).comments.filter((c) => c.replyTo === asked14.id && c.by === AGENT).length === 2,
    T,
    'the agent to answer the plain reply'
  )
  assert((await storedChats()).filter((c) => c.cardComments?.todoId === 'm2').length === 1, 'the plain reply made a second chat')
  await waitFor(
    async () => (await drawer14.locator(`${tid('todo-replies')} ${tid('todo-comment')}`).count()) === 3,
    T,
    'the thread to show all three replies'
  )
  await shot(page, '14-mention-thread')
  // The ask chip's Open chat link opens the card's chat. There the user's bubble is only the comment, the card sits
  // above it, and the full prompt the agent read is one toggle away.
  await drawer14.locator(`${tid('todo-comment-ask')} .inbox-link`).first().click()
  const ask14 = page.locator(tid('card-ask')).first()
  await ask14.waitFor({ timeout: T })
  const user14 = page.locator(tid('user-message')).first()
  await user14.waitFor({ timeout: T })
  const flat = (t) => (t ?? '').replace(/\s+/g, ' ').trim()
  const askText = flat(await ask14.textContent())
  assert(askText.includes('Task card') && askText.includes('Approve the budget sheet'), `the card-ask: ${askText}`)
  assert(flat(await ask14.locator(tid('card-ask-status')).textContent()) !== '', 'the card-ask shows no status')
  const bubble14 = flat(await user14.locator('.bubble.user').textContent())
  assert(!bubble14.includes('The user mentioned you'), `the bubble shows the wrapper: ${bubble14}`)
  // A mention inside the comment is a chip, as on the card, the chat's own agent too.
  assert(bubble14 === `Please ${AGENT_LABEL} /card make a card for this`, `the bubble is not just the comment: ${bubble14}`)
  assert(
    (await user14.locator(`.bubble.user ${tid('mention')}[data-agent-name="${AGENT}"]`).count()) === 1,
    "the bubble does not draw the agent's mention as a chip"
  )
  // The card sits above the bubble.
  const cardBox = await ask14.boundingBox()
  const bubbleBox = await user14.locator('.bubble.user').boundingBox()
  assert(cardBox.y + cardBox.height <= bubbleBox.y, 'the card is not above the bubble')
  assert(await user14.locator(tid('full-prompt')).count() === 0, 'the full prompt is open before the click')
  await user14.locator(tid('full-prompt-toggle')).click()
  const full14 = await user14.locator(tid('full-prompt')).textContent()
  assert(
    full14.includes('The user mentioned you in a comment on the task card') &&
      full14.includes("The user's comment:") &&
      full14.includes('> Please @e2e-board-builder /card make a card for this'),
    `the full prompt: ${full14}`
  )
  await shot(page, '14-card-ask')
  if (SHOTS) {
    await page.emulateMedia({ colorScheme: 'dark' }) // the app's theme follows the system by default
    await shot(page, '14-card-ask-dark')
    await page.emulateMedia({ colorScheme: 'light' })
  }
  // Open card → lands on the card's page with its drawer open.
  await ask14.locator(tid('card-ask-open')).click()
  await drawer.waitFor({ timeout: T })
  assert(new URL(page.url()).pathname === '/todos/m2', `Open card went to ${page.url()}`)
  assert((await drawer.locator(tid('todo-card')).textContent()).includes('Approve the budget sheet'), 'the drawer is not the card m2')
  await page.click(tid('board-drawer-close'))
  ok(
    '14 an @agent in a comment ran in its own chat for the card, its answer was posted as a threaded reply, and a plain reply in the thread asked it again'
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
  if (h) {
    console.error('board:', JSON.stringify(await boardFile().catch(() => null)).slice(0, 3000))
    console.error('mcp results:', JSON.stringify(await mcpResults()))
    console.error('errors:', JSON.stringify(h.errors?.slice?.(-10) ?? null))
    await shot(h.page, 'fail').catch(() => {})
  }
} finally {
  await stop()
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
console.log(failed ? 'e2e:board FAILED' : 'e2e:board passed')
process.exit(failed ? 1 : 0)
