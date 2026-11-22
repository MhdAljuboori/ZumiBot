// End-to-end check of agent asks in the built server + web UI (local mode) against the FAKE claude
// (backend/tests/fixtures/fake-claude.mjs): no real CLI call is ever made, so no login or quota is used. Usage: npm run e2e:ask
// (builds first)
//
// The asks are real: A's script has an #MCP_CALL line, so the fake starts the zumibot_agents bridge from the
// --mcp-config the server passed, with the capability env the server gave it, and calls `ask` over stdio, after a
// can_use_tool request (manual mode) that the server must answer by itself, without a card. The server then runs B's
// turn in the A→B chat, which is a second fake: each agent reads its own script, <FAKE_STDOUT_DIR>/<agent>.jsonl.
// B's tool requests are a can_use_tool line plus #WAIT_RESPONSE, answered (or left waiting) from A's chat.
// What each fake was answered is read from FAKE_RESPONSES_FILE (both fakes append to it); what each was started with
// from FAKE_INVOCATIONS_OUT (one line per run).
// Side asks (`side_question`): a side run (argv has --no-session-persistence) reads <FAKE_STDOUT_DIR>/<agent>.side.jsonl,
// so A's `/btw` answer can #MCP_CALL side_question and B's side answer has its own script. A side run's tool results reach
// no chat item, so every #MCP_CALL's result is read from FAKE_MCP_RESULTS_OUT.
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 4 min.
//
// DOM hooks relied on (data-testid): new-chat-agent, new-chat-agent-option (+ data-agent-name), new-chat-folder,
//   new-chat-choose-folder, composer-input, send-button, agent-message, user-message, ask-card (+ data-status),
//   ask-message, ask-reply-toggle, ask-reply, ask-open, approval-card (+ data-status), approval-allow-once,
//   approval-badge, agent-approval-badge, asked-bar, asked-source, agent-row (+ data-agent-name), agent-toggle,
//   chat-row (+ data-chat-id), mention-menu, mention-option (+ data-agent-name). Sidebar rows sit in `.agent-block`.
//   The asking agent's name is `data-from` on the user bubble (`.bubble.user`) inside user-message.
//   Side asks: side-ask-card (+ data-status), side-ask-question, side-ask-answer-toggle, side-ask-answer, side-ask-open in
//   A's chat; side-panel, side-entry (+ data-side-id, data-state; the focused one is document.activeElement), side-stop,
//   side-again, side-from (B's entry, "from <A>"), side-ask-link (+ data-state) on A's own entry; side-chip in
//   `.side-chip-row[data-side-id]` opens A's entry.
// Stored state read: <dataDir>/chats.json, <dataDir>/chats/<id>.json, <dataDir>/chats/<id>.btw.json.

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-claude.mjs', import.meta.url))
const A = 'e2e-ask-a'
const B = 'e2e-ask-b'
const PREFIX = 'zumibot-e2e-ask-'
const OVERALL_TIMEOUT = 4 * 60_000
const T = 15_000
const ASK_TOOL = 'mcp__zumibot_agents__ask'
// Verbatim from backend/src/core/asks/askPrompt.ts (REFUSAL.inChain, askedSystem's first line).
const IN_CHAIN = `@${A} is already waiting for your answer in this chain, so it cannot be asked.`
const ASKED_LINE = `You are being asked by the agent @${A}`
const SIDE_TOOL = 'mcp__zumibot_agents__side_question'
// Verbatim from backend/src/core/asks/askPrompt.ts (REFUSAL.sideStopped(B), REFUSAL.noConversation(B)).
const SIDE_STOPPED = `The side question to @${B} was stopped.`
const NO_CONVERSATION = `You have not asked @${B} from this chat yet, so there is no conversation to ask about.`
// The matcher of SIDE_GUARD_ASKING (backend/src/core/btw/sideRun.ts): every tool but side_question; the plain guard's is '*'.
const ASKING_MATCHER = '^(?!mcp__zumibot_agents__side_question$).*'
const A_NAME = 'E2e Ask A' // displayName(A)

const MSG1 = 'Create a card for the login bug'
const MSG2 = 'Add the steps to reproduce to that card'
const MSG3 = 'Assign the card to Homam'
const MSG4 = 'Check whether the card is a duplicate'
const MSG5 = 'Check the card once more'
// Side questions: no leading or trailing space, since the server stores the question trimmed and the card matches it exactly.
const SIDE_Q1 = 'Which card number did you use?'
const SIDE_Q2 = 'Is the card still open?'
const SIDE_Q3 = 'How long will the card take?'
const SIDE_Q4 = 'Did you make a card already?'

let h = null
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
const askedFrom = async (id) => (await storedChats()).filter((c) => c.asked?.from === id)
const askTools = async (id) => (await itemsOf(id)).filter((i) => i.type === 'tool' && i.name === ASK_TOOL)
const sideTools = async (id) => (await itemsOf(id)).filter((i) => i.type === 'tool' && i.name === SIDE_TOOL)
const sidesOf = async (id) =>
  (await readFile(join(h.dataDir, 'chats', `${id}.btw.json`), 'utf8').then(JSON.parse, () => ({ items: [] }))).items

// ---------- the fake claude's scripts: one file per agent, rewritten before each turn ----------
let scripts = null
let responsesFile = null
let invocationsFile = null
let mcpResultsFile = null
const SID_A = '0a1b2c3d-4e5f-4a60-8172-93a4b5c6d7e8'
const SID_B = '1b2c3d4e-5f60-4b71-8283-a4b5c6d7e8f9'
// A side run is a fork: its session id must differ from the one it resumes, or the server stops it as FORK_IGNORED.
const SID_A_SIDE = '2c3d4e5f-6071-4c82-9394-b5c6d7e8f9a0'
const SID_B_SIDE = '3d4e5f60-7182-4d93-a4a5-c6d7e8f9a0b1'
const SID_A2 = '4e5f6071-8293-4ea4-b5b6-d7e8f9a0b1c2'
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
// An ask as the manual-mode CLI makes it: tool_use, a can_use_tool request (req-<id>) it waits on, the call, the result.
const askCall = (agent, message, id) =>
  `#MCP_CALL ${line({ server: 'zumibot_agents', tool: 'ask', args: { agent, message }, id, permission: `req-${id}` })}`
// A Bash request that waits for the user's answer.
const bashRequest = (requestId, command) => [
  line({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command },
      description: 'Run the card tool',
      decision_reason: 'needs approval',
      tool_use_id: `toolu_${requestId}`
    }
  }),
  `#WAIT_RESPONSE ${requestId}`
]
const script = (agent, ...lines) => writeFile(join(scripts, `${agent}.jsonl`), lines.flat().join('\n') + '\n')
// A side_question call, asked for permission as the manual-mode CLI does (req-<id>); the server must allow it by itself.
const sideCall = (agent, question, id) =>
  `#MCP_CALL ${line({ server: 'zumibot_agents', tool: 'side_question', args: { agent, question }, id, permission: `req-${id}` })}`
// The script of the agent's side runs (its /btw answers and the side questions put to it).
const sideScript = (agent, ...lines) => writeFile(join(scripts, `${agent}.side.jsonl`), lines.flat().join('\n') + '\n')

// ---------- what the fakes were answered and started with ----------
const responses = async () =>
  (await readFile(responsesFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l).response)
const answered = async (requestId, behavior) =>
  (await responses()).some((r) => r?.request_id === requestId && r.response?.behavior === behavior)
const invocations = async () =>
  (await readFile(invocationsFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l).args)
const mcpResults = async () =>
  (await readFile(mcpResultsFile, 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
const agentOf = (args) => args[args.indexOf('--agent') + 1]
const sideRuns = async (agent) => (await invocations()).filter((a) => agentOf(a) === agent && a.includes('--no-session-persistence'))
// The PreToolUse matchers of a run's settings (every --settings value; the runner merges them into one).
const guardOf = (args) =>
  args.flatMap((a, i) => (args[i - 1] === '--settings' ? (JSON.parse(a).hooks?.PreToolUse ?? []) : [])).map((h) => h.matcher)
const systemOf = (args) => {
  const i = args.indexOf('--append-system-prompt')
  return i >= 0 ? args[i + 1] : ''
}

// ---------- UI helpers ----------
const composer = (page) => page.locator(tid('composer-input'))
const cards = (page) => page.locator(tid('ask-card'))
const statusOf = (card) => card.getAttribute('data-status').catch(() => null)
const sideEntry = (page, id) => page.locator(`${tid('side-entry')}[data-side-id="${id}"]`)
const focusedSide = (page) => page.evaluate(() => document.activeElement?.closest?.('[data-side-id]')?.getAttribute('data-side-id') ?? null)
const textOf = async (loc) => ((await loc.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()

async function sendText(page, text) {
  await composer(page).fill(text)
  await page.click(tid('send-button'))
}

/** The user's /btw in the open chat: its new side entry, once stored and shown. */
async function btw(page, chatId, question) {
  const before = (await sidesOf(chatId)).map((s) => s.id)
  await sendText(page, `/btw ${question}`)
  let entry = null
  await waitFor(
    async () => (entry = (await sidesOf(chatId)).find((s) => !before.includes(s.id)) ?? null) !== null,
    T,
    `the side question "${question}"`
  )
  await sideEntry(page, entry.id).waitFor({ timeout: T })
  return entry
}

/** The A→B panel is open on B's entry `id`, focused, and the entry is marked as asked by A. */
async function onAskedEntry(page, bId, id) {
  const shown = () => decodeURIComponent(/\/chat\/([^/?#]+)$/.exec(new URL(page.url()).pathname)?.[1] ?? '')
  await waitFor(async () => shown() === bId, T, `the A→B chat to open (${JSON.stringify(shown())} is open)`)
  await page.locator(tid('side-panel')).waitFor({ timeout: T })
  await waitFor(
    async () => (await focusedSide(page)) === id,
    T,
    `B's side entry ${id} to be focused (focused: ${JSON.stringify(await focusedSide(page))})`
  )
  const from = await textOf(sideEntry(page, id).locator(tid('side-from')))
  assert(from === `from ${A_NAME}`, `B's entry reads ${JSON.stringify(from)} where it names who asked`)
  assert((await sideEntry(page, id).locator(tid('side-again')).count()) === 0, "B's entry offers Ask again")
}

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

async function typeAndSend(page, message) {
  await composer(page).click()
  await page.keyboard.type(message)
  await page.click(tid('send-button'))
}

/** The reply `text` is shown, both chats are idle and neither fake still runs. */
async function waitReply(page, chatId, reply, others = []) {
  await waitFor(async () => (await page.locator(tid('agent-message'), { hasText: reply }).count()) > 0, T, `the reply "${reply}"`)
  await idle([chatId, ...others], `the reply "${reply}" to end`)
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

/** The ask card at `index` (0 = first) reads `status`; with `withCard`, it holds one live approval card. */
async function cardIs(page, index, status, withCard = false) {
  const card = cards(page).nth(index)
  await waitFor(
    async () => (await statusOf(card)) === status,
    T,
    `ask card ${index + 1} to read "${status}" (it reads ${JSON.stringify(await statusOf(card))})`
  )
  if (withCard) {
    await waitFor(
      async () => (await card.locator(`${tid('approval-card')}[data-status="pending"]`).count()) === 1,
      T,
      `ask card ${index + 1} to hold a pending approval card`
    )
  }
  return card
}

const agentFile = (name, description) => `---\nname: ${name}\ndescription: ${description}\nmodel: haiku\n---\nYou are a test agent.\n`

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  scripts = await mk('scripts')
  const logs = await mk('logs')
  responsesFile = join(logs, 'responses.jsonl')
  invocationsFile = join(logs, 'invocations.jsonl')
  mcpResultsFile = join(logs, 'mcp-results.jsonl')
  await writeFile(join(agentsDir, `${A}.md`), agentFile(A, 'Checks issues with the user.'))
  await writeFile(join(agentsDir, `${B}.md`), agentFile(B, 'Creates Workiom cards.'))
  h = await start({
    fake: FAKE,
    dataDir,
    agentsDir,
    env: {
      ZUMIBOT_TEST_PICK_FOLDER: folder,
      FAKE_STDOUT_DIR: scripts,
      FAKE_RESPONSES_FILE: responsesFile,
      FAKE_INVOCATIONS_OUT: invocationsFile,
      FAKE_MCP_RESULTS_OUT: mcpResultsFile
    }
  })
  const page = h.page

  // 1. A asks B through the real bridge; B's Bash request waits in A's ask card and is answered there
  await script(A, init(SID_A), askCall(`@${B}`, MSG1, 'toolu_ask1'), say(SID_A, 'Done'), result(SID_A, 'Done'))
  await script(
    B,
    init(SID_B),
    bashRequest('req-b-bash1', 'wk create "Login bug"'),
    say(SID_B, 'Card WK-1 created'),
    result(SID_B, 'Card WK-1 created')
  )
  await page.locator(tid('new-chat-agent')).waitFor({ timeout: 30_000 })
  await page.click(tid('new-chat-agent'))
  await page.click(`${tid('new-chat-agent-option')}[data-agent-name="${A}"]`)
  await pickFolder(page, folder)
  // 0. the new-chat screen offers the same @ menu, so the first message can already ask B
  await composer(page).click()
  await page.keyboard.type('@e2e')
  const firstMenu = page.locator(tid('mention-menu'))
  await firstMenu.waitFor({ timeout: T })
  const firstNames = await firstMenu.locator(tid('mention-option')).evaluateAll((els) => els.map((e) => e.getAttribute('data-agent-name')))
  assert(
    firstNames.includes(B) && !firstNames.includes(A) && !firstNames.includes('everyone'),
    `the new-chat @ menu lists ${JSON.stringify(firstNames)}`
  )
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  ok(`0 the new-chat @ menu lists ${JSON.stringify(firstNames)}`)
  await typeAndSend(page, 'Please hand the login bug to the card agent')
  const aId = await openedChat(page)
  const card1 = await cardIs(page, 0, 'waiting', true)
  assert((await cards(page).count()) === 1, `${await cards(page).count()} ask cards are shown`)
  assert((await card1.locator(tid('ask-message')).textContent())?.trim() === MSG1, "the card does not show A's message to B")
  // The only approval card on the page is B's, inside the ask card: the ask itself was allowed by the server.
  assert(
    (await page.locator(tid('approval-card')).count()) === 1,
    `${await page.locator(tid('approval-card')).count()} approval cards are shown`
  )
  assert(await answered('req-toolu_ask1', 'allow'), 'the server sent no allow for the ask tool request')
  const bId = (await askedFrom(aId))[0]?.id
  assert(bId, 'no A→B chat was made')
  // B's waiting card counts as A's chat's: A shows the approval badge (on its chat row, or on A's row while collapsed).
  const aBlock = page.locator(`.agent-block:has(${tid('agent-row')}[data-agent-name="${A}"])`)
  await waitFor(
    async () =>
      (await aBlock.locator(`${tid('chat-row')}[data-chat-id="${aId}"] ${tid('approval-badge')}, ${tid('agent-approval-badge')}`).count()) >
      0,
    T,
    "the approval badge on A's chat"
  )
  await card1.locator(tid('approval-allow-once')).click()
  await cardIs(page, 0, 'done')
  await waitReply(page, aId, 'Done', [bId])
  await card1.locator(tid('ask-reply-toggle')).click()
  await waitFor(
    async () =>
      (
        (await card1
          .locator(tid('ask-reply'))
          .textContent()
          .catch(() => '')) ?? ''
      ).includes('Card WK-1 created'),
    T,
    "B's reply in the card"
  )
  assert(await answered('req-b-bash1', 'allow'), "B's Bash request was not allowed")
  const [tool1] = await askTools(aId)
  assert(tool1 && !tool1.isError && tool1.result?.includes('Card WK-1 created'), `A's tool result is ${JSON.stringify(tool1)}`)
  const aStored = await itemsOf(aId)
  assert(
    !aStored.some((i) => i.type === 'approval'),
    `approval items stored in A's chat (${JSON.stringify(aStored.filter((i) => i.type === 'approval'))})`
  )
  const bApproval = (await itemsOf(bId)).find((i) => i.type === 'approval')
  assert(bApproval?.id === 'req-b-bash1' && bApproval.status === 'allowed-once', `B's approval is stored as ${JSON.stringify(bApproval)}`)
  assert((await page.locator(`${tid('approval-card')}[data-status="pending"]`).count()) === 0, 'a pending approval card is still shown')
  // What each agent was started with: A gets the roster with B, B gets the asked paragraph, and no capability in argv.
  const runs = await invocations()
  const runA = runs.find((a) => agentOf(a) === A)
  const runB = runs.find((a) => agentOf(a) === B)
  assert(
    runA && systemOf(runA).includes(`@${B}: Creates Workiom cards.`) && !systemOf(runA).includes(`@${A}:`),
    "A's system prompt has no roster with B, or lists A"
  )
  assert(runB && systemOf(runB).includes(ASKED_LINE), "B's system prompt has no asked paragraph")
  assert(
    runs.every((a) => a.join(' ').includes('${ZUMIBOT_ASKS_CAPABILITY}')),
    'a run has no ask bridge, or its capability is not a placeholder'
  )
  const bMeta = await metaOf(bId)
  assert(
    !(bMeta.replyAt !== undefined && bMeta.replyAt > (bMeta.seenAt ?? 0)),
    `the A→B chat is unread (${JSON.stringify({ replyAt: bMeta.replyAt, seenAt: bMeta.seenAt })})`
  )
  ok(
    '1 A asks B over the real bridge: the card reads waiting with B\'s approval card (A shows the badge), Allow there lets B finish, the card reads done and A\'s tool result holds "Card WK-1 created"; no card for the ask itself'
  )

  // 2. Open conversation: the A→B chat is read-only, shows A on its message and sits under B
  await card1.locator(tid('ask-open')).click()
  assert((await openedChat(page, [aId])) === bId, 'Open conversation opened another chat')
  await page.locator(tid('asked-bar')).waitFor({ timeout: T })
  assert((await composer(page).count()) === 0, 'the A→B chat has a composer')
  const bar = (await page.locator(tid('asked-bar')).textContent())?.replace(/\s+/g, ' ').trim()
  // The bar names agents by their display names (displayName in shared/src/agentName.ts).
  assert(bar?.startsWith('Conversation between @E2e Ask A and @E2e Ask B, started from'), `the bar reads ${JSON.stringify(bar)}`)
  await page.locator(tid('agent-message'), { hasText: 'Card WK-1 created' }).waitFor({ timeout: T })
  const user = page.locator(tid('user-message'))
  assert((await user.count()) === 1, `${await user.count()} user messages are shown`)
  assert((await user.locator(`[data-from="${A}"]`).count()) === 1, `the user bubble has no data-from="${A}"`)
  assert((await user.textContent())?.includes(MSG1), "the user bubble does not hold A's message")
  const bRow = page.locator(`.agent-block:has(${tid('agent-row')}[data-agent-name="${B}"])`)
  const toggle = bRow.locator(tid('agent-toggle'))
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await bRow.locator(`${tid('chat-row')}[data-chat-id="${bId}"]`).waitFor({ timeout: T })
  assert((await aBlock.locator(`${tid('chat-row')}[data-chat-id="${bId}"]`).count()) === 0, 'the A→B chat is listed under A')
  const asked = (await storedChats()).filter((c) => c.asked !== undefined)
  assert(
    asked.length === 1 && asked[0].id === bId && asked[0].asked.from === aId && asked[0].asked.by === A && asked[0].agentName === B,
    `chats.json holds ${JSON.stringify(asked.map((c) => ({ id: c.id, agentName: c.agentName, asked: c.asked })))}`
  )
  const refused = await rpc(page, 'chats:send', bId, 'typed by the user', []).then(
    () => null,
    (e) => e.message
  )
  assert(
    refused?.includes('This chat is read-only'),
    `a send to the A→B chat was ${refused === null ? 'accepted' : `refused with ${JSON.stringify(refused)}`}`
  )
  await page.locator(tid('asked-source')).click()
  assert((await openedChat(page, [bId])) === aId, "the source link did not open A's chat")
  await composer(page).waitFor({ timeout: T })
  ok(
    `2 Open conversation: asked bar and no composer, the user bubble is from ${A}, the chat sits under ${B}, chats.json holds one chat asked from A's chat, a send to it is refused`
  )

  // 3. a second ask from A's chat continues the same A→B chat
  await script(A, init(SID_A), askCall(B, MSG2, 'toolu_ask2'), say(SID_A, 'Done again'), result(SID_A, 'Done again'))
  await script(B, init(SID_B), say(SID_B, 'Card WK-1 updated'), result(SID_B, 'Card WK-1 updated'))
  await typeAndSend(page, 'Add the steps too')
  await waitReply(page, aId, 'Done again', [bId])
  await cardIs(page, 1, 'done')
  const again = await askedFrom(aId)
  assert(again.length === 1 && again[0].id === bId, `the second ask made another chat (${JSON.stringify(again.map((c) => c.id))})`)
  const bUsers = (await itemsOf(bId)).filter((i) => i.type === 'user')
  assert(
    bUsers.length === 2 && bUsers.every((u) => u.from === A) && bUsers[1].text === MSG2,
    `the A→B chat holds ${JSON.stringify(bUsers)}`
  )
  const tool2 = (await askTools(aId))[1]
  assert(tool2 && !tool2.isError && tool2.result?.includes('Card WK-1 updated'), `A's second tool result is ${JSON.stringify(tool2)}`)
  ok(`3 a second ask continues the same A→B chat (${bId}), which now holds two messages from ${A}`)

  // 4. Stop in A's chat stops B while B waits on the user
  await script(A, init(SID_A), askCall(B, MSG3, 'toolu_ask3'), say(SID_A, 'Never shown'), result(SID_A, 'Never shown'))
  await script(
    B,
    init(SID_B),
    bashRequest('req-b-hang', 'wk assign WK-1 homam'),
    say(SID_B, 'Never assigned'),
    result(SID_B, 'Never assigned')
  )
  await typeAndSend(page, 'Assign it to Homam')
  await cardIs(page, 2, 'waiting', true)
  const stopButton = page.locator(tid('send-button'))
  await waitFor(async () => (await stopButton.getAttribute('data-tip')) === 'Stop', T, 'the Stop button')
  await stopButton.click()
  await idle([aId, bId], 'both chats to stop')
  await cardIs(page, 2, 'stopped')
  const bLast = (await itemsOf(bId)).at(-1)
  assert(bLast?.type === 'notice' && bLast.kind === 'stopped', `the A→B chat ends with ${JSON.stringify(bLast)}`)
  assert(!(await answered('req-b-hang', 'allow')), "B's request was allowed")
  assert(
    (await page.locator(`${tid('approval-card')}[data-status="pending"]`).count()) === 0,
    'a pending approval card is still shown after Stop'
  )
  assert(!(await page.locator(tid('agent-message'), { hasText: 'Never shown' }).count()), 'A went on after Stop')
  ok("4 Stop in A's chat stops B: B's chat ends \"Stopped.\", A's third card reads stopped, neither chat is running")

  // 5. B cannot ask A back: the ask is refused in B's turn with the in-chain sentence
  await script(A, init(SID_A), askCall(B, MSG4, 'toolu_ask4'), say(SID_A, 'B could not ask me'), result(SID_A, 'B could not ask me'))
  await script(
    B,
    init(SID_B),
    askCall(`@${A}`, 'Can you check the duplicates yourself?', 'toolu_back'),
    say(SID_B, 'Not a duplicate'),
    result(SID_B, 'Not a duplicate')
  )
  await typeAndSend(page, 'Is it a duplicate?')
  await waitReply(page, aId, 'B could not ask me', [bId])
  await cardIs(page, 3, 'done')
  const back = (await askTools(bId)).find((t) => t.id === 'toolu_back')
  assert(back?.isError === true && back.result === IN_CHAIN, `B's ask back reads ${JSON.stringify(back)}`)
  assert((await askedFrom(bId)).length === 0, 'B asking A made a chat')
  assert(await answered('req-toolu_back', 'allow'), "the server sent no allow for B's ask request")
  const tool4 = (await askTools(aId))[3]
  assert(tool4 && !tool4.isError && tool4.result?.includes('Not a duplicate'), `A's fourth tool result is ${JSON.stringify(tool4)}`)
  ok(`5 B asking A back is refused with "${IN_CHAIN}"`)

  // 6. the @ menu in A's composer lists B, not A, and no everyone
  await composer(page).click()
  await page.keyboard.type('@e2e')
  const menu = page.locator(tid('mention-menu'))
  await menu.waitFor({ timeout: T })
  const names = await menu.locator(tid('mention-option')).evaluateAll((els) => els.map((e) => e.getAttribute('data-agent-name')))
  assert(names.includes(B) && !names.includes(A) && !names.includes('everyone'), `the @ menu lists ${JSON.stringify(names)}`)
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  ok(`6 the @ menu in A's chat lists ${JSON.stringify(names)}: ${B}, not ${A}, no everyone`)

  // 7. mentions of other agents are chips in a single chat's bubbles, as in a room: the user's and the agent's
  const MENTION_REPLY = `I will hand it to @${B} next`
  await script(A, init(SID_A), say(SID_A, MENTION_REPLY), result(SID_A, MENTION_REPLY))
  await typeAndSend(page, `Thanks, ask @${B} again, not @${A} or @everyone today`)
  // The chip shows B's display name, not `@handle`, so the reply is found by the text around it.
  await waitReply(page, aId, 'I will hand it to')
  const chipsIn = (loc) => loc.locator(tid('mention')).evaluateAll((els) => els.map((e) => e.getAttribute('data-agent-name')))
  const userChips = await chipsIn(page.locator(tid('user-message')).last())
  assert(JSON.stringify(userChips) === JSON.stringify([B]), `the user bubble's mention chips are ${JSON.stringify(userChips)}`)
  const replyChips = await chipsIn(page.locator(tid('agent-message'), { hasText: 'I will hand it to' }).last())
  assert(JSON.stringify(replyChips) === JSON.stringify([B]), `the reply's mention chips are ${JSON.stringify(replyChips)}`)
  ok(`7 @${B} is a chip in the user bubble and in A's reply; @${A} (the chat's own agent) and @everyone stay text`)

  // 8. side_question from A's main run: B answers on the side from its own side script, A's card reads done with the
  // answer, and Open in conversation lands on B's entry (focused, "from A", no Ask again) in the A→B chat's Side questions
  await script(
    A,
    init(SID_A),
    askCall(B, MSG5, 'toolu_ask5'),
    sideCall(B, SIDE_Q1, 'toolu_side1'),
    say(SID_A, 'Side checked'),
    result(SID_A, 'Side checked')
  )
  await script(B, init(SID_B), say(SID_B, 'Card WK-1 checked'), result(SID_B, 'Card WK-1 checked'))
  await sideScript(B, init(SID_B_SIDE), say(SID_B_SIDE, 'SIDE-ANSWER-1'), result(SID_B_SIDE, 'SIDE-ANSWER-1'))
  await typeAndSend(page, 'Check the card, then ask which number it got')
  await waitReply(page, aId, 'Side checked', [bId])
  const sideCards = page.locator(tid('side-ask-card'))
  const sideCard1 = sideCards.first()
  await waitFor(
    async () => (await statusOf(sideCard1)) === 'done',
    T,
    `the side ask card to read "done" (it reads ${JSON.stringify(await statusOf(sideCard1))})`
  )
  assert((await sideCards.count()) === 1, `${await sideCards.count()} side ask cards are shown`)
  assert((await textOf(sideCard1.locator(tid('side-ask-question')))) === SIDE_Q1, "the side ask card does not show A's question")
  await sideCard1.locator(tid('side-ask-answer-toggle')).click()
  await waitFor(
    async () => (await textOf(sideCard1.locator(tid('side-ask-answer')))).includes('SIDE-ANSWER-1'),
    T,
    "B's side answer in the card"
  )
  const [side1] = await sideTools(aId)
  assert(side1 && !side1.isError && side1.result === 'SIDE-ANSWER-1', `A's side_question result is ${JSON.stringify(side1)}`)
  assert(await answered('req-toolu_side1', 'allow'), 'the server sent no allow for the side_question request')
  const [bSide1, ...moreB1] = await sidesOf(bId)
  assert(
    bSide1 &&
      moreB1.length === 0 &&
      bSide1.from === A &&
      bSide1.agent === B &&
      bSide1.question === SIDE_Q1 &&
      bSide1.state === 'done' &&
      bSide1.answer === 'SIDE-ANSWER-1' &&
      bSide1.asks === undefined,
    `the A→B chat's side questions are ${JSON.stringify(await sidesOf(bId))}`
  )
  assert(
    !JSON.stringify(await itemsOf(bId)).includes('SIDE-ANSWER-1') && !JSON.stringify(await itemsOf(bId)).includes(SIDE_Q1),
    "the side question reached the A→B chat's items"
  )
  const bSideRun1 = (await sideRuns(B)).at(-1)
  assert(
    bSideRun1 && JSON.stringify(guardOf(bSideRun1)) === '["*"]',
    `B's side run has the guard matchers ${JSON.stringify(bSideRun1 && guardOf(bSideRun1))}`
  )
  assert((await sideRuns(A)).length === 0, "A's main-run side_question started a side run of A")
  await sideCard1.locator(tid('side-ask-open')).click()
  await onAskedEntry(page, bId, bSide1.id)
  assert((await composer(page).count()) === 0, 'the A→B chat has a composer')
  ok(
    `8 side_question from A's main run: the card reads done with "SIDE-ANSWER-1", B's side run has the plain guard, Open in conversation focuses B's entry "from ${A_NAME}" (no Ask again)`
  )

  // 9. the user's /btw in A's chat: A's side run (the exception guard) side-asks B with no card, and A's entry links B's
  await page.locator(tid('asked-source')).click()
  assert((await openedChat(page, [bId])) === aId, "the source link did not open A's chat")
  await composer(page).waitFor({ timeout: T })
  await sideScript(
    A,
    init(SID_A_SIDE),
    sideCall(B, SIDE_Q2, 'toolu_side2'),
    say(SID_A_SIDE, 'B says SIDE-ANSWER-2'),
    result(SID_A_SIDE, 'B says SIDE-ANSWER-2')
  )
  await sideScript(B, init(SID_B_SIDE), say(SID_B_SIDE, 'SIDE-ANSWER-2'), result(SID_B_SIDE, 'SIDE-ANSWER-2'))
  await page.evaluate(() => {
    window.__sideAskCardSeen = false
    window.__sideAskObserver = new MutationObserver(() => {
      if (document.querySelector('[data-testid="approval-card"]')) window.__sideAskCardSeen = true
    })
    window.__sideAskObserver.observe(document.body, { childList: true, subtree: true })
  })
  const aSide2 = await btw(page, aId, 'ask b about it')
  assert(aSide2.question === 'ask b about it' && aSide2.from === undefined, `A's side entry is ${JSON.stringify(aSide2)}`)
  await page.locator(`${tid('side-entry')}[data-side-id="${aSide2.id}"][data-state="done"]`).waitFor({ timeout: T })
  const link2 = sideEntry(page, aSide2.id).locator(tid('side-ask-link'))
  await waitFor(async () => (await link2.getAttribute('data-state').catch(() => null)) === 'done', T, "A's side entry's link to read done")
  assert(
    (await link2.count()) === 1 && (await textOf(link2)) === 'Side question to @E2e Ask B · Done',
    `A's link chip reads ${JSON.stringify(await textOf(link2))}`
  )
  const aStored2 = (await sidesOf(aId)).find((s) => s.id === aSide2.id)
  assert(
    aStored2?.state === 'done' && aStored2.answer === 'B says SIDE-ANSWER-2' && aStored2.asks?.length === 1,
    `A's side entry is stored as ${JSON.stringify(aStored2)}`
  )
  const [l2] = aStored2.asks
  assert(l2.agent === B && l2.chatId === bId && l2.state === 'done', `A's side entry links ${JSON.stringify(l2)}`)
  const bSide2 = (await sidesOf(bId)).find((s) => s.id === l2.entryId)
  assert(
    bSide2?.from === A && bSide2.question === SIDE_Q2 && bSide2.state === 'done' && bSide2.answer === 'SIDE-ANSWER-2',
    `B's linked entry is ${JSON.stringify(bSide2)}`
  )
  assert(await answered('req-toolu_side2', 'allow'), "the server sent no allow for the side run's side_question request")
  assert(
    (await page.evaluate(() => window.__sideAskCardSeen)) === false && (await page.locator(tid('approval-card')).count()) === 0,
    'an approval card was shown for the side ask'
  )
  await page.evaluate(() => window.__sideAskObserver.disconnect())
  const side2 = (await mcpResults()).find((r) => r.id === 'toolu_side2')
  assert(side2 && !side2.isError && side2.text === 'SIDE-ANSWER-2', `A's side run's side_question result is ${JSON.stringify(side2)}`)
  const aSideRun = (await sideRuns(A)).at(-1)
  assert(
    aSideRun && JSON.stringify(guardOf(aSideRun)) === JSON.stringify([ASKING_MATCHER]),
    `A's side run has the guard matchers ${JSON.stringify(aSideRun && guardOf(aSideRun))}`
  )
  const bSideRun2 = (await sideRuns(B)).at(-1)
  assert(
    bSideRun2 !== bSideRun1 && JSON.stringify(guardOf(bSideRun2)) === '["*"]',
    `B's second side run has the guard matchers ${JSON.stringify(guardOf(bSideRun2))}`
  )
  await link2.click()
  await onAskedEntry(page, bId, l2.entryId)
  ok(
    `9 /btw in A's chat: A's side run (matcher ${ASKING_MATCHER}) side-asks B, allowed with no card; the link reads "Side question to @E2e Ask B · Done" and opens B's entry, focused`
  )

  // 10. Stop on B's entry in the A→B panel ends A's call with the stopped refusal, and A's link reads Stopped
  await page.locator(tid('asked-source')).click()
  assert((await openedChat(page, [bId])) === aId, "the source link did not open A's chat")
  await composer(page).waitFor({ timeout: T })
  await sideScript(
    A,
    init(SID_A_SIDE),
    sideCall(B, SIDE_Q3, 'toolu_side3'),
    say(SID_A_SIDE, 'The side question was stopped'),
    result(SID_A_SIDE, 'The side question was stopped')
  )
  await sideScript(
    B,
    init(SID_B_SIDE),
    '#WAIT_RESPONSE never-answered',
    say(SID_B_SIDE, 'Never answered'),
    result(SID_B_SIDE, 'Never answered')
  )
  const aSide3 = await btw(page, aId, 'how long will it take?')
  const link3 = sideEntry(page, aSide3.id).locator(tid('side-ask-link'))
  await waitFor(
    async () => (await link3.getAttribute('data-state').catch(() => null)) === 'running',
    T,
    "A's side entry's link to read running"
  )
  await link3.click()
  const l3 = (await sidesOf(aId)).find((s) => s.id === aSide3.id)?.asks?.[0]
  assert(l3?.chatId === bId, `A's running side entry links ${JSON.stringify(l3)}`)
  await onAskedEntry(page, bId, l3.entryId)
  const bEntry3 = sideEntry(page, l3.entryId)
  assert(
    (await bEntry3.getAttribute('data-state')) === 'running',
    `B's entry reads ${await bEntry3.getAttribute('data-state')} before Stop`
  )
  await bEntry3.locator(tid('side-stop')).click()
  await page.locator(`${tid('side-entry')}[data-side-id="${l3.entryId}"][data-state="stopped"]`).waitFor({ timeout: T })
  // Only the agent that asked may ask again, so a stopped entry from A offers no Ask again here.
  assert((await bEntry3.locator(tid('side-again')).count()) === 0, "B's stopped entry offers Ask again")
  let side3 = null
  await waitFor(
    async () => (side3 = (await mcpResults()).find((r) => r.id === 'toolu_side3') ?? null) !== null,
    T,
    "A's side_question call to end"
  )
  assert(side3.isError === true && side3.text === SIDE_STOPPED, `A's side_question result is ${JSON.stringify(side3)}`)
  await waitFor(async () => (await sidesOf(aId)).find((s) => s.id === aSide3.id)?.state === 'done', T, "A's side answer to end")
  const aStored3 = (await sidesOf(aId)).find((s) => s.id === aSide3.id)
  assert(aStored3.asks?.length === 1 && aStored3.asks[0].state === 'stopped', `A's side entry links ${JSON.stringify(aStored3.asks)}`)
  const bSide3 = (await sidesOf(bId)).find((s) => s.id === l3.entryId)
  assert(bSide3?.state === 'stopped' && bSide3.from === A, `B's stopped entry is ${JSON.stringify(bSide3)}`)
  await page.locator(tid('asked-source')).click()
  assert((await openedChat(page, [bId])) === aId, "the source link did not open A's chat")
  await page.locator(`.side-chip-row[data-side-id="${aSide3.id}"] ${tid('side-chip')}`).click()
  const stoppedLink = page.locator(`${tid('side-entry')}[data-side-id="${aSide3.id}"] ${tid('side-ask-link')}[data-state="stopped"]`)
  await stoppedLink.waitFor({ timeout: T })
  assert(
    (await textOf(stoppedLink)) === 'Side question to @E2e Ask B · Stopped',
    `A's link chip reads ${JSON.stringify(await textOf(stoppedLink))}`
  )
  ok(`10 Stop on B's entry in the A→B panel: A's call gets "${SIDE_STOPPED}", A's link reads Stopped`)

  // 11. a fresh chat of A has no A→B chat: side_question is refused with the no-conversation sentence, and no chat is made
  const chatsBefore = (await storedChats()).length
  // The agent's row opens its start screen with no folder picked; the first send makes the chat.
  await page.locator(`${tid('agent-row')}[data-agent-name="${A}"]`).click()
  await pickFolder(page, folder)
  await script(
    A,
    init(SID_A2),
    sideCall(B, SIDE_Q4, 'toolu_side4'),
    say(SID_A2, 'No conversation yet'),
    result(SID_A2, 'No conversation yet')
  )
  await typeAndSend(page, 'Ask the card agent on the side')
  const fresh = await openedChat(page, [aId, bId])
  await waitReply(page, fresh, 'No conversation yet')
  const sideCard4 = page.locator(tid('side-ask-card')).first()
  await waitFor(
    async () => (await statusOf(sideCard4)) === 'failed',
    T,
    `the side ask card to read "failed" (it reads ${JSON.stringify(await statusOf(sideCard4))})`
  )
  await sideCard4.locator(tid('side-ask-answer-toggle')).click()
  // The card draws @B as a mention chip, which shows B's display name.
  const shownRefusal = NO_CONVERSATION.replace(`@${B}`, 'E2e Ask B')
  const details = sideCard4.locator(tid('side-ask-answer'))
  await waitFor(
    async () => (await textOf(details)) === shownRefusal,
    T,
    `the refusal behind Show details (it reads ${JSON.stringify(await textOf(details))})`
  )
  assert((await details.locator(`${tid('mention')}[data-agent-name="${B}"]`).count()) === 1, 'the refusal has no mention chip for B')
  const [side4] = await sideTools(fresh)
  assert(side4?.isError === true && side4.result === NO_CONVERSATION, `the fresh chat's side_question result is ${JSON.stringify(side4)}`)
  assert(await answered('req-toolu_side4', 'allow'), 'the server sent no allow for the side_question request')
  assert(
    (await askedFrom(fresh)).length === 0 && (await storedChats()).length === chatsBefore + 1,
    'a side_question with no conversation made a chat'
  )
  assert((await sidesOf(bId)).length === 3, `the A→B chat holds ${(await sidesOf(bId)).length} side questions`)
  ok(`11 side_question in a fresh chat of A is refused with "${NO_CONVERSATION}", and no chat is made`)

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
console.log(failed ? 'e2e:ask FAILED' : 'e2e:ask passed')
process.exit(failed ? 1 : 0)
