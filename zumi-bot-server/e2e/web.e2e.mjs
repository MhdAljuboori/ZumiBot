// End-to-end check of the built server + web UI (local mode, headless Chrome) against the REAL `claude` CLI
// (Haiku only, via the test agent's frontmatter). Ported from the Electron app.e2e.mjs; the server runs with the real HOME.
// Usage: npm run e2e        (builds first)
//        E2E_STEPS=1,2 node zumi-bot-server/e2e/web.e2e.mjs   (run a subset; the test agent is still trashed in `finally`)
//
// Hard rules enforced here:
//  - aborts before launching if ~/.claude/agents/zumibot-test.md already exists;
//  - every click/send is scoped to the `zumibot-test` agent block / chat (never any other agent);
//  - only ~/.claude/agents/zumibot-test.md is ever created (the server's Delete moves it to the freedesktop trash,
//    `gio trash` is the fallback in `finally`; never rm);
//  - only the two mkdtemp dirs created here are ever deleted.
// Note: on start the server also writes the built-in zumi-bot.md into the agents folder, by design
// (it is protected and self-healing); this script neither creates nor removes it.
//
// The app runs with ZUMIBOT_PERMISSION_MODE=manual (dev/test-only override, set by the harness) on every start of the run,
// because the CLI's `auto` mode never asked for approval in testing; manual mode makes it ask for Bash.
//
// DOM hooks relied on (data-testid / role / class):
//   data-testid: new-agent (the sidebar's + button; opens new-menu), new-menu-agent,
//                agent-row (+ data-agent-name), agent-toggle (aria-expanded), agent-menu-button, agent-menu-edit, editor-more, editor-delete (Agent Studio's More menu),
//                folder (+ data-cwd), chat-row (+ data-chat-id),
//                composer-input, send-button, message-list, streaming-bubble (+ [data-streaming]),
//                tool-run (folded run of tool-rows; its .tool-run-head aria-expanded is one toggle for the whole chat),
//                tool-row, error-bubble, claude-banner,
//                approval-card (+ data-status pending|allowed-once|allowed-chat|auto-allowed|denied|unanswered, data-request-id),
//                approval-allow-once, approval-allow-chat, approval-deny, approval-badge (sidebar chat row, "Approval needed"),
//                theme-system|theme-light|theme-dark (Settings > General theme buttons),
//                new-chat (no-chat-open screen; also the agent start screen, with chat-intro inside), new-chat-agent, new-chat-agent-option (+ data-agent-name),
//                new-chat-folder, new-chat-folder-option (+ data-cwd), new-chat-choose-folder,
//                chat-agent, chat-folder (open chat's locked pickers under the composer; chat-folder has data-tip=cwd, .folder-icon inside)
//                attach-button (paperclip), draft-attachments, draft-attachment (+ data-status), draft-attachment-remove,
//                attach-error, drop-overlay, sent-attachments, sent-thumb (img inside), sent-chip
//                (a sent file that is missing has no test id and reads "File missing")
//   server env: ZUMIBOT_TEST_PICK_FOLDER (fixed answer of "Choose folder…"); files are attached through the paperclip + Playwright's
//                `filechooser` event (the old ZUMIBOT_TEST_PICK_FILES no longer exists)
//   by role/text/class: .approval-line (card history line), .notice ("Stopped."), button "Haiku" (model chip, aria-pressed), "Save changes",
//                dialog button "Move to Trash"; #agent-name, #agent-description, #agent-prompt;
//                .bubble.assistant / .bubble.user; [role=separator] (expired divider)
//   step 17 (edit and version switch, the hidden --resume-session-at/--fork-session flags) also uses: user-message, edit-button,
//                message-editor-input, message-editor-send, message-editor, version-switcher (.version-label), version-prev
//   step 16 (queued follow-ups) runs on its own server with the fake claude (temp HOME, temp agents dir, no real CLI turn):
//                tasks-tray, tasks-head (its first span reads "Tasks · N"), task-row (.task-text inside), task-drop, task-send
//   steps 19-20 (to-do tools, run before the delete in step 11) ask the agent to call mcp__zumibot_todos__list and read
//                the CLI's own session logs (~/.claude/projects/<scratch>) for the call and its result; they rely on
//                tool-row (+ data-tool-id) and approval-card. Step 20 gives the test agent's own file a tools: list
//                naming the four to-do tools for one turn and writes the file back afterwards.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { start as startHarness } from './harness.mjs'
import { redPng } from './redPng.mjs'
import { probeSideRun } from './btwProbe.mjs'

const AGENT = 'zumibot-test'
const AGENT_LABEL = 'Zumibot Test' // how the UI shows AGENT
const AGENTS_DIR = join(homedir(), '.claude', 'agents')
const AGENT_FILE = join(AGENTS_DIR, `${AGENT}.md`)
const ZERO_UUID = '00000000-0000-4000-8000-000000000000'
const EXPIRED_TEXT = "Earlier session expired. Continued in a new session using this chat's history as context."
const REPLY_TIMEOUT = 120_000
const OVERALL_TIMEOUT = 12 * 60_000
const SHOTS = fileURLToPath(new URL('./screenshots', import.meta.url))
const PREFIX = 'zumibot-e2e-'

const only = process.env.E2E_STEPS ? new Set(process.env.E2E_STEPS.split(',').map((s) => s.trim())) : null
const wants = (n) => only === null || only.has(String(n))

class Blocked extends Error {}

let aborted = false // set by the overall timeout and by `finally`: nothing may start the server afterwards
const checkAborted = () => {
  if (aborted) throw new Error('aborted (overall timeout or cleanup already started)')
}

let tmpUserData = null
let tmpScratch = null
let fixturePng = null // red 32x32 PNG and secret.txt, kept in <userData>/fixtures (outside the chat's cwd)
let fixtureTxt = null
let current = null // harness handle (page, server, errors, stop) + pid
const allErrors = []
const results = []
let cliTurns = 0

const log = (m) => console.log(m)
const t0 = Date.now()
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const ok = (step) => {
  results.push(`ok ${step}`)
  log(`ok ${step}  [${secs()}]`)
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

async function shot(name, page = current.page) {
  await mkdir(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `e2e-${name}.png`) })
}

async function start() {
  checkAborted()
  // fake:false = real claude with the real HOME (its login); the harness already sets manual permission mode
  const started = await startHarness({
    mode: 'local',
    fake: false,
    dataDir: tmpUserData,
    agentsDir: AGENTS_DIR,
    env: { ZUMIBOT_TEST_PICK_FOLDER: tmpScratch, ZUMIBOT_PERMISSION_MODE: 'manual' }
  })
  current = { ...started, pid: started.server.pid }
  allErrors.push(started.errors)
  if (aborted) {
    await stop()
    throw new Error('aborted while launching')
  }
  await current.page.waitForSelector('[data-testid="new-agent"]', { timeout: 30_000 })
  return current.page
}

// Without pgrep the step-7 "no process left" assertion would pass vacuously, so refuse to run.
function requirePgrep() {
  try {
    execFileSync('pgrep', ['--version'], { stdio: 'ignore' })
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error('pgrep is not installed; the e2e process check cannot run')
    // pgrep exists but rejected the flag (non-ENOENT): fine.
  }
}

function descendants(pid) {
  const out = []
  const walk = (p) => {
    let kids = []
    try {
      kids = execFileSync('pgrep', ['-P', String(p)], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
        .map(Number)
    } catch {
      /* no children */
    }
    for (const k of kids) {
      out.push(k)
      walk(k)
    }
  }
  walk(pid)
  return out
}

async function stop() {
  if (!current) return
  const h = current
  current = null
  await shutDown(h)
}

async function shutDown({ stop: stopHarness, pid }) {
  const kids = pid ? descendants(pid) : []
  // Closes Chrome and SIGTERMs the server (which stops its claude children)
  await Promise.race([stopHarness().catch(() => {}), new Promise((r) => setTimeout(r, 30_000))])
  // Hard fallback: only the server PID the harness started, plus its descendants.
  for (const p of [pid, ...kids]) {
    if (!p) continue
    try {
      process.kill(p, 0)
      process.kill(p, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

// ---------- DOM helpers (all scoped to the zumibot-test agent) ----------

const agentRow = (page) => page.locator(`[data-testid="agent-row"][data-agent-name="${AGENT}"]`)
const agentBlock = (page) => page.locator('nav.agent-list .agent-block').filter({ has: agentRow(page) })

/** Opens the agent's chat list without starting a chat (clicking the row itself starts one). */
async function ensureExpanded(page) {
  await agentRow(page).waitFor({ timeout: 15_000 })
  const toggle = agentBlock(page).locator('[data-testid="agent-toggle"]')
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
}

/** Refuses to continue unless the open chat (or the agent start screen, whose Send starts one) belongs to the test agent. */
async function assertTestChat(page) {
  const agent = await page
    .locator('[data-testid="chat-agent"], [data-testid="new-chat"] [data-testid="new-chat-agent"]')
    .first()
    .textContent()
  assert(agent?.trim() === AGENT_LABEL, `open chat is not the ${AGENT} chat (agent: ${JSON.stringify(agent)})`)
}

/** Sends `text` and waits (<= 120 s) for the turn to finish. Returns the texts of assistant bubbles added by this turn. */
async function sendAndWait(page, text) {
  await assertTestChat(page)
  const beforeUser = await page.locator('.bubble.user').count()
  const beforeAssistant = await page.locator('.bubble.assistant:not([data-streaming])').count()
  const input = page.locator('[data-testid="composer-input"]')
  await input.fill(text)
  await page.locator('[data-testid="send-button"]').click()
  cliTurns++
  const handle = await page.waitForFunction(
    ({ bu, ba, prompt }) => {
      const err = document.querySelector('[data-testid="error-bubble"]')
      if (err) return { error: err.textContent }
      // A NEW user bubble carrying exactly the sent prompt must exist before any reply is judged.
      const users = [...document.querySelectorAll('.bubble.user')]
      const lastUser = users[users.length - 1]
      if (!(users.length > bu && lastUser && lastUser.textContent.trim() === prompt.trim())) return false
      const assistants = [...document.querySelectorAll('.bubble.assistant:not([data-streaming])')]
      // Only assistant bubbles that come AFTER the new user bubble count as this turn's reply.
      const fresh = assistants.filter((a) => lastUser.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)
      const btn = document.querySelector('[data-testid="send-button"]')
      const idle = btn && btn.textContent === 'Send' && !document.querySelector('[data-streaming]')
      return assistants.length > ba && fresh.length > 0 && idle ? { done: true, replies: fresh.map((a) => a.textContent) } : false
    },
    { bu: beforeUser, ba: beforeAssistant, prompt: text },
    { timeout: REPLY_TIMEOUT, polling: 200 }
  )
  const res = await handle.jsonValue()
  if (res.error) throw new Blocked(`app showed an error bubble: ${res.error}`)
  return res.replies
}

// ---------- steps ----------

async function step1(page) {
  await page.locator('[data-testid="new-agent"]').click()
  await page.locator('[data-testid="new-menu-agent"]').click()
  await page.locator('#agent-name').fill(AGENT)
  await page.locator('#agent-description').fill('Temporary ZumiBot e2e agent.')
  await page.getByRole('button', { name: 'Haiku', exact: true }).click()
  await page.locator('#agent-prompt').fill('You are a test agent. Keep replies very short.')
  const save = page.getByRole('button', { name: 'Save changes', exact: true })
  await save.click()
  const deadline = Date.now() + 10_000
  while (!existsSync(AGENT_FILE) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  assert(existsSync(AGENT_FILE), `${AGENT_FILE} was not written`)
  const raw = await readFile(AGENT_FILE, 'utf8')
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)
  assert(m, 'saved file has no frontmatter')
  const fm = YAML.parse(m[1])
  assert(fm.model === 'haiku', `frontmatter model is ${JSON.stringify(fm.model)}, expected "haiku"`)
  assert(fm.name === AGENT, `frontmatter name is ${JSON.stringify(fm.name)}`)
  assert(fm.description === 'Temporary ZumiBot e2e agent.', `description is ${JSON.stringify(fm.description)}`)
  assert(raw.includes('You are a test agent. Keep replies very short.'), 'prompt body missing from file')
  await agentRow(page).waitFor({ timeout: 10_000 }) // it appears in the sidebar
  await shot('1-create')
  ok('1 create test agent (file written, model: haiku)')
}

async function step2(page) {
  // Clicking an agent opens its start screen: intro shown, agent picked, no folder and no folder dialog.
  await agentRow(page).click()
  const screen = page.locator('[data-testid="new-chat"]')
  await screen.locator('[data-testid="chat-intro"]').waitFor({ timeout: 10_000 })
  await assertTestChat(page)
  const folderPicker = screen.locator('[data-testid="new-chat-folder"]')
  assert(
    (await folderPicker.textContent()).includes('No folder'),
    `folder picker reads ${JSON.stringify(await folderPicker.textContent())}`
  )
  // A folder is optional: with none picked, Send starts the chat in a scratch folder of its own.
  const send = page.locator('[data-testid="send-button"]')
  await page.locator('[data-testid="composer-input"]').fill('x')
  assert(!(await send.isDisabled()), 'Send disabled on the start screen with no folder picked')
  await page.locator('[data-testid="composer-input"]').fill('')
  assert((await agentBlock(page).locator('[data-testid="chat-row"]').count()) === 0, 'clicking the agent created a chat')

  // The server's fixed folder (ZUMIBOT_TEST_PICK_FOLDER) answers "Choose folder…"; the chat itself starts on the first send (step 3).
  await folderPicker.click()
  await page.locator('[data-testid="new-chat-choose-folder"]').click()
  await page.waitForFunction(
    (cwd) => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip') === cwd,
    tmpScratch,
    { timeout: 5_000 }
  )
  assert((await folderPicker.textContent()).includes(basename(tmpScratch)), `folder picker text lacks ${basename(tmpScratch)}`)
  await shot('2-agent-start')
  ok(`2 agent start screen (no folder until picked, then ${basename(tmpScratch)})`)
}

async function step3(page) {
  await page.evaluate(() => {
    window.__sawStreaming = false
    const check = () => {
      if (document.querySelector('[data-streaming]')) window.__sawStreaming = true
    }
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true })
    check()
  })
  const replies = await sendAndWait(page, 'Reply with the single word: pong')
  assert(
    replies.some((r) => /pong/i.test(r)),
    `no assistant bubble contains "pong": ${JSON.stringify(replies)}`
  )
  const saw = await page.evaluate(() => window.__sawStreaming)
  assert(saw === true, 'no [data-streaming] element was ever observed while the reply streamed')
  // The first send from the start screen opened the chat, its pickers now locked.
  const folderPicker = page.locator('[data-testid="chat-folder"]')
  assert(
    (await folderPicker.getAttribute('data-tip')) === tmpScratch,
    `folder picker title ${await folderPicker.getAttribute('data-tip')} != scratch dir ${tmpScratch}`
  )
  assert(await folderPicker.isDisabled(), 'folder picker is editable in an open chat')
  assert(await page.locator('[data-testid="chat-agent"]').isDisabled(), 'agent picker is editable in an open chat')
  const folder = agentBlock(page).locator(`[data-testid="folder"][data-cwd="${tmpScratch}"]`)
  await folder.locator('[data-testid="chat-row"]').first().waitFor({ timeout: 5_000 })
  await shot('3-streaming-pong')
  ok('3 streaming (pong reply, [data-streaming] observed, chat opened with locked pickers)')
}

// ---------- approval steps (4-7) ----------

const PRE_STOP_AGENT = AGENT // the pre-Stop live-child check looks for this agent name
const NO_RETRY = ' If it is denied or cannot run, do not retry or try anything else; just say so.'
const cmd = (expr) => `python3 -c "print(${expr})"`
const runPrompt = (expr, tail = '') => `Run this exact shell command: ${cmd(expr)}.${NO_RETRY}${tail}`

/** Tool runs start folded and share one chat-wide toggle, so opening one renders every tool row. */
async function openToolRuns(page) {
  const closed = page.locator('[data-testid="tool-run"] .tool-run-head[aria-expanded="false"]')
  if ((await closed.count()) > 0) await closed.first().click()
}

/** Counts of elements that exist before a send; steps judge only elements after these indexes. */
async function baseline(page) {
  await openToolRuns(page)
  return {
    cards: await page.locator('[data-testid="approval-card"]').count(),
    tools: await page.locator('[data-testid="tool-row"]').count(),
    notices: await page.locator('.notice').count()
  }
}

/** Fills and sends without waiting for the reply. */
async function sendOnly(page, text) {
  await assertTestChat(page)
  await page.locator('[data-testid="composer-input"]').fill(text)
  await page.locator('[data-testid="send-button"]').click()
  cliTurns++
}

/** Watches (in the page) for any new card (index >= base) ever being `pending`; read with pendingSeen(). */
async function watchPending(page, baseCards) {
  await page.evaluate((n) => {
    window.__pendingSeen = false
    const check = () => {
      const cards = [...document.querySelectorAll('[data-testid="approval-card"]')]
      if (cards.slice(n).some((c) => c.getAttribute('data-status') === 'pending')) window.__pendingSeen = true
    }
    window.__pendingObs?.disconnect()
    window.__pendingObs = new MutationObserver(check)
    window.__pendingObs.observe(document.body, { subtree: true, childList: true, attributes: true })
    check()
  }, baseCards)
}
const pendingSeen = (page) => page.evaluate(() => window.__pendingSeen === true)

/** Waits for the NEW card (index = baseCards) to have `status`; returns its data-request-id. Fails fast on an error bubble. */
async function waitCard(page, baseCards, status, timeout = REPLY_TIMEOUT) {
  const handle = await page.waitForFunction(
    ({ n, status }) => {
      const err = document.querySelector('[data-testid="error-bubble"]')
      if (err) return { error: err.textContent }
      const c = document.querySelectorAll('[data-testid="approval-card"]')[n]
      return c && c.getAttribute('data-status') === status ? { id: c.getAttribute('data-request-id') } : false
    },
    { n: baseCards, status },
    { timeout, polling: 150 }
  )
  const res = await handle.jsonValue()
  if (res.error) throw new Blocked(`app showed an error bubble: ${res.error}`)
  return res.id
}

const cardById = (page, id) => page.locator(`[data-testid="approval-card"][data-request-id="${id}"]`)

/** Waits until the composer is idle ("Send", nothing streaming). Fails fast on an error bubble. */
async function waitIdle(page, timeout = REPLY_TIMEOUT) {
  const handle = await page.waitForFunction(
    () => {
      const err = document.querySelector('[data-testid="error-bubble"]')
      if (err) return { error: err.textContent }
      const btn = document.querySelector('[data-testid="send-button"]')
      return btn && btn.textContent === 'Send' && !document.querySelector('[data-streaming]') ? { done: true } : false
    },
    undefined,
    { timeout, polling: 200 }
  )
  const res = await handle.jsonValue()
  if (res.error) throw new Blocked(`app showed an error bubble: ${res.error}`)
}

/** Polls (<= 3 s) until the pending-state UI settles: sidebar badge count, badge text and composer button. */
async function waitPendingUi(page, badges, buttonText) {
  await page.waitForFunction(
    ({ badges, buttonText }) => {
      const bs = [...document.querySelectorAll('[data-testid="chat-row"] [data-testid="approval-badge"]')]
      const btn = document.querySelector('[data-testid="send-button"]')
      const textOk = badges === 0 || bs.every((b) => b.textContent.trim() === 'Approval needed')
      return bs.length === badges && textOk && btn && btn.textContent === buttonText
    },
    { badges, buttonText },
    { timeout: 3_000, polling: 100 }
  )
}

async function badgeCount(page) {
  return agentBlock(page).locator('[data-testid="chat-row"] [data-testid="approval-badge"]').count()
}

/** Expands tool rows added after `baseTools` and returns their result panels' texts. */
async function newToolResults(page, baseTools) {
  await openToolRuns(page)
  const rows = page.locator('[data-testid="tool-row"]')
  const n = await rows.count()
  const out = []
  for (let i = baseTools; i < n; i++) {
    const row = rows.nth(i)
    const head = row.locator('.tool-head')
    if ((await head.getAttribute('aria-expanded')) !== 'true') await head.click()
    const pres = await row.locator('.tool-panel pre').allTextContents()
    out.push(pres[pres.length - 1] ?? '')
  }
  return out
}

async function step4(page) {
  // Deny. (Needs the model to actually call Bash.)
  const base = await baseline(page)
  await sendOnly(page, runPrompt('6*7'))
  const id = await waitCard(page, base.cards, 'pending')
  const card = cardById(page, id)
  assert((await card.textContent()).includes(`print(6*7)`), `pending card does not show the command: ${await card.textContent()}`)
  await waitPendingUi(page, 1, 'Stop').catch(() => {
    throw new Error('ASSERT FAILED: pending card needs the "Approval needed" badge and a "Stop" composer button within 3 s')
  })
  await shot('4-approval-pending')
  await card.locator('[data-testid="approval-deny"]').click()
  await waitCard(page, base.cards, 'denied', 15_000)
  assert((await card.locator('.approval-line').textContent()).trim() === 'Denied', 'card line is not "Denied"')
  await waitIdle(page)
  // A row reads as the call's own description (or "Bash") over its command, so match the command and the blocked mark.
  const command = 'python3 -c "print(6*7)"'
  await openToolRuns(page)
  const blocked = page.locator('[data-testid="tool-row"]').filter({ hasText: command }).filter({ hasText: '⛔ blocked:' })
  assert((await blocked.count()) >= 1 && (await blocked.first().isVisible()), `blocked row not visible: ${command}`)
  assert((await badgeCount(page)) === 0, 'badge still shown after the reply finished')
  await blocked.first().scrollIntoViewIfNeeded()
  await shot('4-denied')
  ok('4 approval: Deny (pending card + badge + Stop, then Denied, blocked row, reply finished)')
}

async function step5(page) {
  // Allow once, same command again. (Needs the model to call Bash again rather than answer from history.)
  const base = await baseline(page)
  await sendOnly(page, runPrompt('6*7', ' Run it again now even if you ran it before.'))
  const id = await waitCard(page, base.cards, 'pending')
  await cardById(page, id).locator('[data-testid="approval-allow-once"]').click()
  await waitCard(page, base.cards, 'allowed-once', 15_000)
  assert((await cardById(page, id).locator('.approval-line').textContent()).trim() === 'Allowed once', 'card line is not "Allowed once"')
  await waitIdle(page)
  const results = await newToolResults(page, base.tools)
  assert(
    results.some((r) => r.includes('42')),
    `no new tool result contains 42: ${JSON.stringify(results)}`
  )
  assert((await badgeCount(page)) === 0, 'badge still shown after the turn finished')
  await shot('5-allow-once')
  ok('5 approval: Allow once (line "Allowed once", tool result 42, badge gone)')
}

async function step6(page) {
  // Allow for this chat, then the identical command is auto-allowed without a pending card.
  const base = await baseline(page)
  await sendOnly(page, runPrompt('7*8'))
  const id = await waitCard(page, base.cards, 'pending')
  await cardById(page, id).locator('[data-testid="approval-allow-chat"]').click()
  await waitCard(page, base.cards, 'allowed-chat', 15_000)
  assert(
    (await cardById(page, id).locator('.approval-line').textContent()).trim() === 'Allowed for this chat',
    'card line is not "Allowed for this chat"'
  )
  await waitIdle(page)
  const results = await newToolResults(page, base.tools)
  assert(
    results.some((r) => r.includes('56')),
    `no new tool result contains 56: ${JSON.stringify(results)}`
  )
  await shot('6-allow-chat')

  const base2 = await baseline(page)
  await watchPending(page, base2.cards)
  await sendOnly(page, runPrompt('7*8', ' Run it again now even if you ran it before.'))
  const id2 = await waitCard(page, base2.cards, 'auto-allowed')
  await waitIdle(page)
  assert(!(await pendingSeen(page)), 'a pending card appeared for the repeated command')
  assert(
    (await cardById(page, id2).locator('.approval-line').textContent()).trim() === 'Auto-allowed (earlier "Allow for this chat")',
    'card line is not the auto-allowed text'
  )
  assert((await badgeCount(page)) === 0, 'badge shown for an auto-allowed command')
  await shot('6-auto-allowed')
  ok('6 approval: Allow for this chat (56), repeat auto-allowed without a pending card')
}

async function step7(page) {
  // Stop with a pending card.
  const base = await baseline(page)
  await sendOnly(page, runPrompt('9*9'))
  const id = await waitCard(page, base.cards, 'pending')
  await waitPendingUi(page, 1, 'Stop').catch(() => {
    throw new Error('ASSERT FAILED: pending card needs the "Approval needed" badge and a "Stop" composer button within 3 s')
  })
  // Prove the process check can see a live child: while the card is pending, the run's claude must be among the server's descendants
  const agentArgs = (pid) => {
    try {
      return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).trim()
    } catch {
      return '' // already gone
    }
  }
  // Either spelling of the flag: the CLI adapter passes `--agent <name>`, the Agent SDK adapter `--agent=<name>`. The
  // assertion is still that a live claude child for this agent exists (see docs/architecture/engines.md).
  const forAgent = new RegExp(`--agent[ =]${PRE_STOP_AGENT}(\\s|$)`)
  const live = descendants(current.pid).filter((k) => forAgent.test(agentArgs(k)))
  assert(
    live.length > 0,
    `no live claude child with "--agent ${PRE_STOP_AGENT}" under server pid ${current.pid} while the approval is pending`
  )
  console.log(`   step 7: live claude child(ren) before Stop: ${live.join(',')}`)
  await page.locator('[data-testid="send-button"]').click()
  await waitCard(page, base.cards, 'unanswered', 15_000)
  for (const k of live) {
    const gone = Date.now() + 15_000
    while (agentArgs(k).includes('--agent') && Date.now() < gone) await new Promise((r) => setTimeout(r, 200))
    assert(!agentArgs(k).includes('--agent'), `claude child ${k} still alive after Stop`)
  }
  assert((await cardById(page, id).locator('.approval-line').textContent()).trim() === 'Not answered', 'card line is not "Not answered"')
  await page.waitForFunction(
    (n) => [...document.querySelectorAll('.notice')].slice(n).some((x) => x.textContent.trim() === 'Stopped.'),
    base.notices,
    { timeout: 15_000 }
  )
  await page.locator('[data-testid="send-button"]').filter({ hasText: 'Send' }).waitFor({ timeout: 15_000 })
  assert((await badgeCount(page)) === 0, 'badge still shown after Stop')
  // The stopped tool must stay a plain row: no "blocked" row for it among the rows added after this send.
  await openToolRuns(page)
  const stoppedRows = await page.locator('[data-testid="tool-row"]').allTextContents()
  const blockedNew = stoppedRows.slice(base.tools).filter((t) => t.includes('⛔ blocked:') && t.includes('python3 -c "print(9*9)"'))
  assert(blockedNew.length === 0, `stopped tool was marked blocked: ${JSON.stringify(stoppedRows.slice(base.tools))}`)
  // No claude child of this run may survive (SIGTERM fallback is 3 s after SIGINT). Only descendants of
  // this run's server PID are inspected, so unrelated processes (or a wrapper shell whose command line
  // merely mentions the agent flag) can never match.
  const deadline = Date.now() + 15_000
  let left = []
  let inspected = 0
  while (Date.now() < deadline) {
    left = []
    const kids = descendants(current.pid)
    inspected = Math.max(inspected, kids.length)
    for (const k of kids) {
      try {
        const args = execFileSync('ps', ['-o', 'args=', '-p', String(k)], { encoding: 'utf8' }).trim()
        if (args.includes(`--agent ${AGENT}`)) left.push(`${k} ${args}`)
      } catch {
        /* already gone */
      }
    }
    if (left.length === 0) break
    await new Promise((r) => setTimeout(r, 300))
  }
  assert(left.length === 0, `claude process still running after Stop: ${JSON.stringify(left)}`)
  console.log(`   step 7: inspected ${inspected} server descendant process(es)`)
  await shot('7-stop-pending')
  ok('7 approval: Stop with a pending card (Not answered, Stopped. notice, badge gone, no process left)')
}

async function chatsJson() {
  return JSON.parse(await readFile(join(tmpUserData, 'chats.json'), 'utf8'))
}

/** `history` = what the stored log must show before we continue: first user prompt and minimum user/assistant bubble counts. */
async function openTestChat(page, chatId, history) {
  await ensureExpanded(page)
  const row = agentBlock(page).locator(`[data-testid="chat-row"][data-chat-id="${chatId}"]`)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.locator('[data-testid="chat-agent"]').waitFor({ timeout: 10_000 })
  await assertTestChat(page)
  // History loads asynchronously after the header appears: wait for it so counts taken later are stable.
  await page.waitForFunction(
    ({ first, users, assistants }) => {
      const u = document.querySelectorAll('.bubble.user')
      const a = document.querySelectorAll('.bubble.assistant:not([data-streaming])')
      return u.length >= users && a.length >= assistants && u[0]?.textContent.trim() === first
    },
    history,
    { timeout: 15_000, polling: 100 }
  )
}

async function step8() {
  await stop()
  const idx = await chatsJson()
  assert(idx.chats.length === 1 && idx.chats[0].agentName === AGENT, `unexpected chats.json: ${JSON.stringify(idx)}`)
  const chatId = idx.chats[0].id
  const sessionBefore = idx.chats[0].sessionId
  assert(sessionBefore && sessionBefore !== ZERO_UUID, `sessionId before resume is ${sessionBefore}`)
  const page = await start()
  // asserts the chat is listed under zumibot-test and its stored history (6 turns) has rendered
  await openTestChat(page, chatId, { first: 'Reply with the single word: pong', users: 6, assistants: 2 })
  const replies = await sendAndWait(page, 'What single word did you reply with first?')
  assert(
    replies.some((r) => /pong/i.test(r)),
    `resume reply lacks "pong": ${JSON.stringify(replies)}`
  )
  // A genuine --resume: no expiry fallback happened and the stored session id is untouched.
  assert(
    (await page.locator('[role="separator"]').filter({ hasText: EXPIRED_TEXT }).count()) === 0,
    'expired divider appeared: --resume fell back to a new session'
  )
  await new Promise((r) => setTimeout(r, 1000))
  const sessionAfter = (await chatsJson()).chats[0].sessionId
  assert(sessionAfter === sessionBefore, `sessionId changed on resume: ${sessionBefore} -> ${sessionAfter}`)
  await shot('8-resume')
  ok('8 resume (chat listed after relaunch, reply recalls pong)')
}

async function step9() {
  await stop()
  const idx = await chatsJson()
  const before = idx.chats[0].sessionId
  assert(before && before !== ZERO_UUID, `sessionId before is ${before}`)
  idx.chats[0].sessionId = ZERO_UUID
  await writeFile(join(tmpUserData, 'chats.json'), JSON.stringify(idx, null, 2))
  const chatId = idx.chats[0].id
  const page = await start()
  await openTestChat(page, chatId, { first: 'Reply with the single word: pong', users: 7, assistants: 3 })
  const replies = await sendAndWait(page, 'Reply with the single word: ok')
  const divider = page.locator('[role="separator"]').filter({ hasText: EXPIRED_TEXT })
  assert((await divider.count()) >= 1 && (await divider.first().isVisible()), 'expired divider not visible')
  assert(
    replies.some((r) => /\bok\b/i.test(r)),
    `expired-session reply lacks "ok": ${JSON.stringify(replies)}`
  )
  let after = null
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    after = (await chatsJson()).chats[0].sessionId
    if (after && after !== ZERO_UUID) break
    await new Promise((r) => setTimeout(r, 250))
  }
  assert(after !== null && after !== ZERO_UUID, `sessionId after is ${after}`)
  assert(after !== before, 'sessionId did not change after expiry')
  await divider.first().scrollIntoViewIfNeeded()
  await shot('9-expired-divider')
  ok('9 expired session (divider visible, reply ok, new sessionId)')
}

async function step10() {
  // A fresh launch opens on the no-chat-open screen with nothing picked.
  await stop()
  const page = await start()
  await page.locator('[data-testid="new-chat"]').waitFor({ timeout: 10_000 })
  const send = page.locator('[data-testid="send-button"]')
  const text = 'Reply with the single word: hello'
  await page.locator('[data-testid="composer-input"]').fill(text)
  assert(await send.isDisabled(), 'Send enabled with no agent and no folder picked')
  assert((await send.getAttribute('data-tip')) === 'Pick an agent first', `send title ${await send.getAttribute('data-tip')}`)

  await page.locator('[data-testid="new-chat-agent"]').click()
  await page.locator(`[data-testid="new-chat-agent-option"][data-agent-name="${AGENT}"]`).click()
  assert(
    (await page.locator('[data-testid="new-chat-agent"]').textContent()).includes(AGENT_LABEL),
    'agent picker does not show the test agent'
  )
  assert(await send.isEnabled(), 'Send disabled with an agent but no folder picked')

  // The scratch folder is listed as recent once an earlier step chatted in it; otherwise the server's fixed folder answers.
  await page.locator('[data-testid="new-chat-folder"]').click()
  const recent = page.locator(`[data-testid="new-chat-folder-option"][data-cwd="${tmpScratch}"]`)
  await page.locator('[data-testid="new-chat-choose-folder"]').waitFor({ timeout: 5_000 })
  if (wants(2)) assert((await recent.count()) === 1, 'scratch folder not listed under Recent')
  if ((await recent.count()) === 1) await recent.click()
  else await page.locator('[data-testid="new-chat-choose-folder"]').click()
  const folderPicker = page.locator('[data-testid="new-chat-folder"]')
  await page.waitForFunction(
    (name) => document.querySelector('[data-testid="new-chat-folder"]')?.textContent.includes(name),
    basename(tmpScratch),
    { timeout: 5_000 }
  )
  assert((await folderPicker.locator('.folder-icon').count()) === 1, 'folder picker has no folder icon')
  assert(await send.isEnabled(), 'Send still disabled with agent, folder and text set')
  await shot('10-new-chat-ready')

  await send.click()
  cliTurns++
  await page.locator('[data-testid="chat-agent"]').waitFor({ timeout: 10_000 })
  await assertTestChat(page)
  const chatFolder = page.locator('[data-testid="chat-folder"]')
  assert(
    (await chatFolder.getAttribute('data-tip')) === tmpScratch,
    `folder picker title ${await chatFolder.getAttribute('data-tip')} != ${tmpScratch}`
  )
  assert((await chatFolder.locator('.folder-icon').count()) === 1, 'folder picker has no folder icon')
  await page.locator('.bubble.user', { hasText: text }).waitFor({ timeout: 10_000 })
  await waitIdle(page)
  assert((await page.locator('.bubble.assistant').count()) > 0, 'no assistant reply in the new chat')
  await shot('10-new-chat-sent')
  ok('10 new chat from the no-chat-open screen (gated Send, agent + folder pickers, message sent)')
  return page
}

async function step11(page) {
  await agentRow(page).hover()
  await agentBlock(page).locator('[data-testid="agent-menu-button"]').click()
  await page.locator('[data-testid="agent-menu-edit"]').click()
  await page.getByRole('heading', { name: AGENT_LABEL, level: 2 }).waitFor({ timeout: 10_000 })
  await page.locator('[data-testid="editor-more"]').click()
  await page.locator('[data-testid="editor-delete"]').click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 5_000 })
  assert((await dialog.textContent()).includes(`Move ${AGENT}.md to Trash?`), 'confirm dialog text unexpected')
  await shot('11-delete-confirm')
  await dialog.getByRole('button', { name: 'Move to Trash' }).click()
  const deadline = Date.now() + 5_000
  while (existsSync(AGENT_FILE) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
  assert(!existsSync(AGENT_FILE), `${AGENT_FILE} still exists after Delete`)
  await page.locator('[data-testid="new-chat"]').waitFor({ timeout: 5_000 })
  await agentRow(page).waitFor({ state: 'detached', timeout: 5_000 })
  await shot('11-deleted')
  ok('11 delete (file gone, new-chat screen, row removed)')
}

// ---------- attachment steps (12-15; they run after step 10 and before the delete in step 11) ----------

const ATTACH_PROMPT = 'What color is the image, and what is the secret word in the text file? Answer in two words.'

/** The open chat must be the test agent's: opens its newest one when none is open (its row only opens the start screen). */
async function ensureChat(page) {
  if ((await page.locator('[data-testid="chat-agent"]').count()) === 0) {
    await agentRow(page).click() // opens the agent's block, listing its chats
    await agentBlock(page).locator('[data-testid="chat-row"]').first().click()
    await page.locator('[data-testid="chat-agent"]').waitFor({ timeout: 10_000 })
  }
  await assertTestChat(page)
}

async function blockedRowsAfter(page, baseTools) {
  await openToolRuns(page)
  const rows = await page.locator('[data-testid="tool-row"]').allTextContents()
  return rows.slice(baseTools).filter((t) => t.includes('\u26d4 blocked'))
}

async function step12(page) {
  await ensureChat(page)
  // Through the paperclip's file chooser (replaces ZUMIBOT_TEST_PICK_FILES)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-testid="attach-button"]').click()])
  await chooser.setFiles([fixturePng, fixtureTxt])
  await page.waitForFunction(
    () => {
      const items = [...document.querySelectorAll('[data-testid="draft-attachment"]')]
      return items.length === 2 && items.every((i) => i.getAttribute('data-status') === 'ready')
    },
    undefined,
    { timeout: 15_000, polling: 100 }
  )
  assert((await page.locator('[data-testid="attach-error"]').count()) === 0, 'attach-error shown after picking two files')
  await shot('12-draft-attachments')
  const base = await baseline(page)
  const replies = await sendAndWait(page, ATTACH_PROMPT)
  const joined = replies.join(' | ')
  assert(/\bred\b/i.test(joined), `reply lacks "red": ${JSON.stringify(replies)}`)
  assert(/pineapple/i.test(joined), `reply lacks "pineapple": ${JSON.stringify(replies)}`)
  assert((await page.locator('[data-testid="draft-attachment"]').count()) === 0, 'draft attachments not cleared after send')
  const thumbs = page.locator('[data-testid="sent-thumb"]')
  assert((await thumbs.count()) === 1, `expected 1 sent-thumb, got ${await thumbs.count()}`)
  await page
    .waitForFunction(
      () => {
        const img = document.querySelector('[data-testid="sent-thumb"] img')
        return img && img.complete && img.naturalWidth > 0
      },
      undefined,
      { timeout: 10_000 }
    )
    .catch(() => {})
  const width = await thumbs.locator('img').evaluate((img) => img.naturalWidth)
  assert(width > 0, `sent thumbnail did not load (naturalWidth ${width})`)
  assert(
    (await page.locator('[data-testid="sent-chip"]').count()) === 1,
    `expected 1 sent-chip, got ${await page.locator('[data-testid="sent-chip"]').count()}`
  )
  const blocked = await blockedRowsAfter(page, base.tools)
  assert(blocked.length === 0, `blocked tool rows after an attachment turn: ${JSON.stringify(blocked)}`)
  const cards = await page.locator('[data-testid="approval-card"]').count()
  assert(cards === base.cards, `${cards - base.cards} approval card(s) appeared for reading the attached files`)
  await shot('12-attached-reply')
  ok(`12 attachments: picked 2 files (ready), reply has red + pineapple, 1 thumb (${width}px) + 1 chip, no blocked rows, no approval cards`)
}

async function step13(page) {
  await ensureChat(page)
  const base = await baseline(page)
  const replies = await sendAndWait(
    page,
    'Use the Read tool on the attached text file again now (do not answer from memory), then quote its exact content line.'
  )
  assert(
    replies.some((r) => /pineapple/i.test(r)),
    `follow-up reply lacks "pineapple": ${JSON.stringify(replies)}`
  )
  await openToolRuns(page)
  const toolsNow = await page.locator('[data-testid="tool-row"]').count()
  assert(
    toolsNow > base.tools,
    `no new tool row on the follow-up turn (${base.tools} before, ${toolsNow} after): the file was not read again`
  )
  const blocked = await blockedRowsAfter(page, base.tools)
  assert(blocked.length === 0, `blocked tool rows on the follow-up turn: ${JSON.stringify(blocked)}`)
  assert((await page.locator('[data-testid="approval-card"]').count()) === base.cards, 'approval card appeared on the follow-up turn')
  await shot('13-resume-add-dir')
  ok('13 follow-up turn re-reads the file (--add-dir with --resume): pineapple, no blocked rows')
}

async function step14(page) {
  await ensureChat(page)
  await page.locator('[data-testid="composer-input"]').click()
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 16
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#00f'
    ctx.fillRect(0, 0, 16, 16)
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'))
    const dt = new DataTransfer()
    dt.items.add(new File([blob], 'image.png', { type: 'image/png' }))
    document
      .querySelector('[data-testid="composer-input"]')
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  const item = page.locator('[data-testid="draft-attachment"][data-status="ready"]')
  await item.waitFor({ timeout: 10_000 })
  assert((await page.locator('[data-testid="draft-attachment"]').count()) === 1, 'expected exactly 1 draft attachment after paste')
  const remove = item.locator('[data-testid="draft-attachment-remove"]')
  const label = (await remove.getAttribute('aria-label')) ?? ''
  assert(/^Remove pasted-\d{8}-\d{6}\.png$/.test(label), `pasted file name unexpected: ${JSON.stringify(label)}`)
  await shot('14-pasted')
  await remove.click()
  await page.locator('[data-testid="draft-attachment"]').waitFor({ state: 'detached', timeout: 5_000 })
  ok(`14 paste: ready draft "${label.slice(7)}", removed again`)
}

async function step15() {
  await stop()
  // The chat that has a sent attachment (step 10 made a second chat without one).
  let found = null
  for (const c of (await chatsJson()).chats) {
    const items = JSON.parse(await readFile(join(tmpUserData, 'chats', `${c.id}.json`), 'utf8'))
    if (c.agentName === AGENT && items.some((i) => i.type === 'user' && i.attachments?.length > 0)) found = { id: c.id, items }
  }
  assert(found, 'no stored chat has a user item with attachments')
  const users = found.items.filter((i) => i.type === 'user' && i.text.trim() !== '')
  const page = await start()
  await openTestChat(page, found.id, { first: users[0].text, users: users.length, assistants: 1 })
  // A sent thumbnail loads lazily, and the chat opens at its newest message: scroll up to it, as a reader would.
  await page.locator('[data-testid="sent-thumb"]').first().scrollIntoViewIfNeeded()
  await page
    .waitForFunction(
      () => {
        const img = document.querySelector('[data-testid="sent-thumb"] img')
        return img && img.complete && img.naturalWidth > 0
      },
      undefined,
      { timeout: 15_000, polling: 200 }
    )
    .catch(() => {})
  const width = await page
    .locator('[data-testid="sent-thumb"] img')
    .first()
    .evaluate((img) => img.naturalWidth)
  assert(width > 0, `sent thumbnail does not load after relaunch (naturalWidth ${width})`)
  assert((await page.locator('[data-testid="sent-chip"]').count()) === 1, 'sent chip missing after relaunch')
  await shot('15-reopened')
  ok(`15 reopen after relaunch: sent thumbnail still loads (${width}px), chip still shown`)
}

// ---------- queued follow-ups (16): its own server on the fake claude, so a reply lasts exactly as long as its script ----------

const BASIC = fileURLToPath(new URL('../backend/tests/fixtures/stream/basic.jsonl', import.meta.url))
const QUEUE_AGENT = 'e2e-queue'
let fake = null // harness handle of step 16

async function stopFake() {
  if (!fake) return
  const h = fake
  fake = null
  await shutDown({ stop: h.stop, pid: h.server.pid })
}

/** Every fake run waits `ms` before its reply ("pong"): time to send more while it runs. */
async function slowScript(ms) {
  const [init, ...rest] = (await readFile(BASIC, 'utf8')).split('\n').filter(Boolean)
  await writeFile(fake.script, [init, `#SLEEP ${ms}`, ...rest].join('\n') + '\n')
}

/** Records each change of where every one of `texts` shows (a task row, a user bubble) into window.__queued. */
const watchQueued = (page, texts) =>
  page.evaluate((texts) => {
    window.__queued = []
    let last
    const check = () => {
      const rows = [...document.querySelectorAll('[data-testid="task-row"] .task-text')].map((e) => e.textContent.trim())
      const users = [...document.querySelectorAll('.bubble.user')].map((e) => e.textContent.trim())
      const s = texts.map((t) => `${t}:${rows.includes(t) ? 'row' : ''}${users.includes(t) ? '+bubble' : ''}`).join(' ')
      if (s !== last) window.__queued.push((last = s))
    }
    window.__queuedObs?.disconnect()
    window.__queuedObs = new MutationObserver(check)
    window.__queuedObs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true })
    check()
  }, texts)

/** The thread in order: user bubbles, finished replies and notices. */
const threadRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.bubble.user, .bubble.assistant:not([data-streaming]), .notice')].map((e) => {
      const kind = e.matches('.bubble.user') ? 'user' : e.matches('.notice') ? 'notice' : 'reply'
      return `${kind}:${e.textContent.trim()}`
    })
  )

async function step16() {
  const agentsDir = join(tmpUserData, 'queue-agents')
  const work = join(tmpUserData, 'queue-work')
  await mkdir(agentsDir, { recursive: true })
  await mkdir(work, { recursive: true })
  await writeFile(
    join(agentsDir, `${QUEUE_AGENT}.md`),
    `---\nname: ${QUEUE_AGENT}\ndescription: Fake e2e agent for queued messages\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  checkAborted()
  fake = await startHarness({ mode: 'local', fake: true, agentsDir, env: { ZUMIBOT_TEST_PICK_FOLDER: work } })
  allErrors.push(fake.errors)
  checkAborted()
  const page = fake.page
  const input = page.locator('[data-testid="composer-input"]')
  const send = page.locator('[data-testid="send-button"]')
  const rows = page.locator('[data-testid="task-row"]')
  const rowTexts = () => page.locator('[data-testid="task-row"] .task-text').allTextContents()
  const headText = async () => (await page.locator('[data-testid="tasks-head"] span').first().textContent()).trim()
  const users = () => page.evaluate(() => [...document.querySelectorAll('.bubble.user')].map((e) => e.textContent.trim()))
  const waitUser = (text, timeout = 15_000) =>
    page.waitForFunction((t) => [...document.querySelectorAll('.bubble.user')].some((e) => e.textContent.trim() === t), text, {
      timeout,
      polling: 100
    })
  const doubles = async () => (await page.evaluate(() => window.__queued ?? [])).filter((s) => s.includes('row+bubble'))

  await slowScript(3_000)
  await page.locator('[data-testid="new-chat"]').waitFor({ timeout: 15_000 })
  await page.locator('[data-testid="new-chat-agent"]').click()
  await page.locator(`[data-testid="new-chat-agent-option"][data-agent-name="${QUEUE_AGENT}"]`).click()
  await page.locator('[data-testid="new-chat-folder"]').click()
  await page.locator('[data-testid="new-chat-choose-folder"]').click()
  await page.waitForFunction((cwd) => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip') === cwd, work, {
    timeout: 10_000
  })
  await watchQueued(page, ['two', 'three', 'four'])
  await input.fill('one')
  await send.click()
  await page.locator('[data-testid="chat-agent"]').waitFor({ timeout: 10_000 })
  await waitUser('one')

  // While the reply runs, text in the box makes the button Send; the message waits as a task, not as a bubble.
  await input.fill('two')
  assert(
    (await send.textContent()).trim() === 'Send' && (await send.isEnabled()),
    'Send is not offered while the reply runs with text typed'
  )
  await send.click()
  await rows.first().waitFor({ timeout: 5_000 })
  assert(JSON.stringify(await rowTexts()) === JSON.stringify(['two']), `Tasks lists ${JSON.stringify(await rowTexts())}`)
  assert((await headText()) === 'Tasks · 1', `Tasks header reads ${JSON.stringify(await headText())}`)
  assert(!(await users()).includes('two'), 'the queued "two" is in the thread already')
  assert((await send.textContent()).trim() === 'Stop', 'the reply to "one" is not running any more: "two" was not sent mid-run')
  assert((await page.locator('[data-testid="task-send"]').count()) === 0, 'a task offers Send now while the chat runs')
  await shot('16-queued', page)

  // The reply ends: "two" goes in on its own, and its own reply follows.
  await waitUser('two')
  await page.locator('[data-testid="tasks-tray"]').waitFor({ state: 'detached', timeout: 5_000 })
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.bubble.assistant:not([data-streaming])').length >= 2 &&
      document.querySelector('[data-testid="send-button"]')?.textContent === 'Send' &&
      !document.querySelector('[data-streaming]'),
    undefined,
    { timeout: 20_000, polling: 100 }
  )
  const first = await threadRows(page)
  assert(
    JSON.stringify(first) === JSON.stringify(['user:one', 'reply:pong', 'user:two', 'reply:pong']),
    `thread after the first task: ${JSON.stringify(first)}`
  )

  // Two more while a new reply runs; × takes "four" off; Stop ends the run and the next task goes in.
  await slowScript(6_000)
  await input.fill('go')
  await send.click()
  await waitUser('go')
  for (const text of ['three', 'four']) {
    await input.fill(text)
    await send.click()
    await page.waitForFunction(
      (t) => [...document.querySelectorAll('[data-testid="task-row"] .task-text')].some((e) => e.textContent.trim() === t),
      text,
      { timeout: 5_000 }
    )
  }
  assert(
    JSON.stringify(await rowTexts()) === JSON.stringify(['three', 'four']),
    `Tasks lists ${JSON.stringify(await rowTexts())}, expected oldest first`
  )
  assert((await headText()) === 'Tasks · 2', `Tasks header reads ${JSON.stringify(await headText())}`)
  await rows.filter({ hasText: 'four' }).locator('[data-testid="task-drop"]').click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="task-row"]').length === 1, undefined, { timeout: 5_000 })
  assert(
    JSON.stringify(await rowTexts()) === JSON.stringify(['three']),
    `Tasks lists ${JSON.stringify(await rowTexts())} after × on "four"`
  )
  assert((await headText()) === 'Tasks · 1', `Tasks header reads ${JSON.stringify(await headText())}`)
  assert(
    (await send.textContent()).trim() === 'Stop',
    `composer button reads ${JSON.stringify(await send.textContent())} while running with an empty box`
  )
  await send.click()
  await waitUser('three')
  await page.locator('[data-testid="tasks-tray"]').waitFor({ state: 'detached', timeout: 5_000 })
  await waitIdle(page, 30_000)
  const all = await threadRows(page)
  const expected = ['user:one', 'reply:pong', 'user:two', 'reply:pong', 'user:go', 'notice:Stopped.', 'user:three', 'reply:pong']
  assert(JSON.stringify(all) === JSON.stringify(expected), `thread after Stop: ${JSON.stringify(all)}`)
  const twice = await doubles()
  assert(twice.length === 0, `a queued message showed as a task row and a bubble at once: ${JSON.stringify(twice)}`)

  // Stored the same: the dropped task never went in, and no task is left.
  const idx = JSON.parse(await readFile(join(fake.dataDir, 'chats.json'), 'utf8'))
  assert(idx.chats.length === 1 && (idx.chats[0].tasks ?? []).length === 0, `stored chats: ${JSON.stringify(idx.chats)}`)
  const items = JSON.parse(await readFile(join(fake.dataDir, 'chats', `${idx.chats[0].id}.json`), 'utf8'))
  const sent = items.filter((i) => i.type === 'user').map((i) => i.text)
  assert(JSON.stringify(sent) === JSON.stringify(['one', 'two', 'go', 'three']), `stored user messages ${JSON.stringify(sent)}`)
  await shot('16-after-stop', page)
  await stopFake()
  ok(
    '16 queued follow-ups (fake claude): "two" sent mid-reply waited as a task (no bubble), went in after the reply; × dropped "four"; Stop sent "three"'
  )
}

// ---------- edit and switch back (17): what the agent REMEMBERS must follow the version, through the real CLI's hidden flags ----------

const userMessage = (page, text) => page.locator('[data-testid="user-message"]').filter({ hasText: text }).last()

/** Edits the user message that reads `oldText` to `newText` and waits (<= 120 s) for the new version's reply and for the chat to be idle. */
async function editAndWait(page, oldText, newText) {
  await assertTestChat(page)
  const msg = userMessage(page, oldText)
  await msg.hover()
  await msg.locator('[data-testid="edit-button"]').click()
  await page.locator('[data-testid="message-editor-input"]').fill(newText)
  await page.locator('[data-testid="message-editor-send"]').click()
  cliTurns++
  const handle = await page.waitForFunction(
    (text) => {
      const err = document.querySelector('[data-testid="error-bubble"]')
      if (err) return { error: err.textContent }
      const users = [...document.querySelectorAll('.bubble.user')]
      const at = users.findIndex((u) => u.textContent.trim() === text)
      if (at < 0) return false
      const label = users[at].closest('[data-testid="user-message"]')?.querySelector('.version-label')?.textContent.trim()
      const replied = [...document.querySelectorAll('.bubble.assistant:not([data-streaming])')].some(
        (a) => users[at].compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING
      )
      const btn = document.querySelector('[data-testid="send-button"]')
      return label === '2 / 2' && replied && btn && btn.textContent === 'Send' && !document.querySelector('[data-streaming]')
        ? { done: true }
        : false
    },
    newText,
    { timeout: REPLY_TIMEOUT, polling: 200 }
  )
  const res = await handle.jsonValue()
  if (res.error) throw new Blocked(`app showed an error bubble: ${res.error}`)
}

async function step17() {
  // A fresh launch opens on the no-chat-open screen; the chat is made the way step 10 does.
  await stop()
  const page = await start()
  await page.locator('[data-testid="new-chat"]').waitFor({ timeout: 10_000 })
  await page.locator('[data-testid="new-chat-agent"]').click()
  await page.locator(`[data-testid="new-chat-agent-option"][data-agent-name="${AGENT}"]`).click()
  await page.locator('[data-testid="new-chat-folder"]').click()
  const recent = page.locator(`[data-testid="new-chat-folder-option"][data-cwd="${tmpScratch}"]`)
  await page.locator('[data-testid="new-chat-choose-folder"]').waitFor({ timeout: 5_000 })
  if ((await recent.count()) === 1) await recent.click()
  else await page.locator('[data-testid="new-chat-choose-folder"]').click()
  await page.waitForFunction(
    (name) => document.querySelector('[data-testid="new-chat-folder"]')?.textContent.includes(name),
    basename(tmpScratch),
    { timeout: 5_000 }
  )

  const apple = 'Remember the word APPLE. Reply with just OK.'
  const banana = 'Remember the word BANANA. Reply with just OK.'
  const cherry = 'Remember the word CHERRY. Reply with just OK.'
  const list = 'List every word I asked you to remember, in one line.'
  await page.locator('[data-testid="composer-input"]').fill(apple)
  await page.locator('[data-testid="send-button"]').click()
  cliTurns++
  await page.locator('[data-testid="chat-agent"]').waitFor({ timeout: 10_000 })
  await page.locator('.bubble.user', { hasText: apple }).waitFor({ timeout: 10_000 })
  await waitIdle(page)
  assert((await page.locator('.bubble.assistant').count()) > 0, 'no assistant reply to the first message')
  await sendAndWait(page, banana)

  // Edit BANANA -> CHERRY: version 2 of that message, whose session was cut after APPLE's answer.
  await editAndWait(page, banana, cherry)
  const afterEdit = (await sendAndWait(page, list)).join(' ')
  assert(
    /APPLE/i.test(afterEdit) && /CHERRY/i.test(afterEdit) && !/BANANA/i.test(afterEdit),
    `after the edit the list reads ${JSON.stringify(afterEdit)}; it must hold APPLE and CHERRY, not BANANA`
  )

  // Switch back: version 1 and the memory that goes with it.
  await userMessage(page, cherry).locator('[data-testid="version-prev"]').click()
  await page.waitForFunction(
    (text) => {
      const u = [...document.querySelectorAll('.bubble.user')].find((b) => b.textContent.trim() === text)
      return u?.closest('[data-testid="user-message"]')?.querySelector('.version-label')?.textContent.trim() === '1 / 2'
    },
    banana,
    { timeout: 15_000, polling: 200 }
  )
  await waitIdle(page)
  const afterBack = (await sendAndWait(page, list)).join(' ')
  assert(
    /APPLE/i.test(afterBack) && /BANANA/i.test(afterBack) && !/CHERRY/i.test(afterBack),
    `after switching back the list reads ${JSON.stringify(afterBack)}; it must hold APPLE and BANANA, not CHERRY`
  )
  await shot('17-versions')
  ok('17 edit and switch back (real CLI): edited list is APPLE, CHERRY; version 1 lists APPLE, BANANA')
}

async function step18() {
  await probeSideRun({ log })
  ok('18 /btw real CLI fork, persistence, tool guard and prompt cache probe')
}

// ---------- to-do tools (19-20): the zumibot_todos MCP server through the real CLI, in manual mode ----------

const TODO_TOOLS = [
  'mcp__zumibot_todos__list',
  'mcp__zumibot_todos__add',
  'mcp__zumibot_todos__check',
  'mcp__zumibot_todos__remove',
  'mcp__zumibot_todos__ask_user',
  'mcp__zumibot_todos__ready_for_review'
]
const TODO_LIST = TODO_TOOLS[0]
const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')

/**
 * Every `tool` call in the CLI's own session logs of the scratch folder, by tool_use id, with its result. The logs are
 * the proof the call ran: ZumiBot shows no row for it. Ids are deduplicated, since a forked session copies its history.
 */
async function toolCallsInLogs(tool) {
  // Same folder naming as the CLI: every non-alphanumeric character becomes '-'.
  const dir = join(PROJECTS, (await realpath(tmpScratch)).replace(/[^a-zA-Z0-9]/g, '-'))
  const uses = new Set()
  const results = new Map()
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) await walk(join(d, e.name))
      else if (e.name.endsWith('.jsonl')) {
        for (const l of (await readFile(join(d, e.name), 'utf8')).split('\n')) {
          let m
          try {
            m = JSON.parse(l)
          } catch {
            continue
          }
          for (const b of Array.isArray(m?.message?.content) ? m.message.content : []) {
            if (b?.type === 'tool_use' && b.name === tool) uses.add(b.id)
            if (b?.type === 'tool_result') {
              const text =
                typeof b.content === 'string' ? b.content : (Array.isArray(b.content) ? b.content : []).map((p) => p?.text ?? '').join('\n')
              results.set(b.tool_use_id, { isError: b.is_error === true, text })
            }
          }
        }
      }
    }
  }
  await walk(dir)
  return [...uses].map((id) => ({ id, result: results.get(id) ?? null }))
}

/** Asks the agent to call `list` and checks it ran through the CLI with no approval card, no tool row and no stored tool item. */
async function probeTodoList(page, prompt) {
  await ensureChat(page)
  const base = await baseline(page)
  const before = new Set((await toolCallsInLogs(TODO_LIST)).map((c) => c.id))
  const replies = await sendAndWait(page, prompt)
  let calls = []
  // The CLI writes its session log as it goes; give the last lines a moment.
  for (let end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) {
    calls = (await toolCallsInLogs(TODO_LIST)).filter((c) => !before.has(c.id))
    if (calls.length > 0 && calls.every((c) => c.result)) break
  }
  assert(calls.length > 0, `the agent made no ${TODO_LIST} call (reply: ${JSON.stringify(replies)})`)
  assert(
    calls.every((c) => c.result && !c.result.isError),
    `a ${TODO_LIST} call failed or has no result: ${JSON.stringify(calls)}`
  )
  assert(
    calls.some((c) => c.result.text.includes('No open to-dos.')),
    `no list call returned the empty list: ${JSON.stringify(calls)}`
  )
  assert((await page.locator('[data-testid="approval-card"]').count()) === base.cards, 'an approval card appeared for the to-do tool')
  await openToolRuns(page)
  for (const c of calls)
    assert(
      (await page.locator(`[data-testid="tool-row"][data-tool-id="${c.id}"]`).count()) === 0,
      `the to-do call ${c.id} shows as a tool row`
    )
  const chatId = decodeURIComponent(new URL(page.url()).pathname.replace(/^\/chat\//, ''))
  const stored = JSON.parse(await readFile(join(tmpUserData, 'chats', `${chatId}.json`), 'utf8'))
  const todoItems = stored.filter(
    (i) =>
      (i.type === 'tool' && i.name.startsWith('mcp__zumibot_todos__')) ||
      (i.type === 'approval' && i.toolName.startsWith('mcp__zumibot_todos__'))
  )
  assert(todoItems.length === 0, `to-do tool or approval items were stored: ${JSON.stringify(todoItems)}`)
  // Not a failure (the CLI may reach a deferred tool through ToolSearch first), but worth seeing.
  const others = (await page.locator('[data-testid="tool-row"]').count()) - base.tools
  if (others > 0) log(`  (${others} other tool row(s) in this turn, e.g. ToolSearch)`)
  return calls.length
}

async function step19(page) {
  const n = await probeTodoList(page, `Call the ${TODO_LIST} tool now. It takes no arguments. Then reply with its output only.`)
  await shot('19-todo-list')
  ok(`19 to-do list tool through the real CLI: ${n} call(s) ran, auto-allowed (no card), no tool row`)
}

async function step20(page) {
  await ensureChat(page)
  // The test agent itself gets a tools: list naming the to-do tools for this one turn, then its file is put back.
  const original = await readFile(AGENT_FILE, 'utf8')
  const tools = ['Read', ...TODO_TOOLS].join(', ')
  const limited = original.replace(
    /^---\r?\n([\s\S]*?)\r?\n---/,
    (_, fm) => `---\n${fm.replace(/^tools:.*(\r?\n|$)/m, '')}\ntools: ${tools}\n---`
  )
  const fm = YAML.parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(limited)?.[1] ?? '')
  assert(fm?.tools === tools && fm.name === AGENT, `the limited agent file does not parse to tools: ${tools}`)
  await writeFile(AGENT_FILE, limited)
  try {
    const n = await probeTodoList(
      page,
      `Call the ${TODO_LIST} tool again now; do not answer from memory. It takes no arguments. Then reply with its output only.`
    )
    await shot('20-todo-list-tools')
    ok(`20 to-do list tool for an agent whose tools: list names the 4 to-do tools: ${n} call(s) ran, no card, no tool row`)
  } finally {
    await writeFile(AGENT_FILE, original)
  }
}

// ---------- main ----------

function safeTmpDir(p) {
  return p !== null && p.startsWith(tmpdir() + sep) && basename(p).startsWith(PREFIX)
}

async function main() {
  requirePgrep()
  if (existsSync(AGENT_FILE)) {
    console.error(`ABORT: ${AGENT_FILE} already exists. Refusing to run.`)
    process.exit(2)
  }
  tmpUserData = await mkdtemp(join(tmpdir(), `${PREFIX}data-`))
  tmpScratch = await mkdtemp(join(tmpdir(), `${PREFIX}cwd-`))
  await writeFile(join(tmpScratch, 'hello.txt'), 'hello\n')
  await mkdir(join(tmpUserData, 'fixtures'))
  fixturePng = join(tmpUserData, 'fixtures', 'red.png')
  fixtureTxt = join(tmpUserData, 'fixtures', 'secret.txt')
  await writeFile(fixturePng, redPng(32))
  await writeFile(fixtureTxt, 'secret word: pineapple\n')
  log(`userData=${tmpUserData} scratch=${tmpScratch} steps=${only ? [...only].join(',') : 'all'}`)

  let page = await start()
  if (wants(1)) {
    checkAborted()
    await step1(page)
  }
  if (wants(2)) {
    checkAborted()
    await step2(page)
  }
  if (wants(3)) {
    checkAborted()
    await step3(page)
  }
  if (wants(4)) {
    checkAborted()
    await step4(page)
  }
  if (wants(5)) {
    checkAborted()
    await step5(page)
  }
  if (wants(6)) {
    checkAborted()
    await step6(page)
  }
  if (wants(7)) {
    checkAborted()
    await step7(page)
  }
  if (wants(8)) {
    checkAborted()
    await step8()
  }
  if (wants(9)) {
    checkAborted()
    await step9()
  }
  if (wants(10)) {
    checkAborted()
    page = await step10()
  }
  if (wants(12)) {
    checkAborted()
    page = current ? current.page : await start()
    await step12(page)
  }
  if (wants(13)) {
    checkAborted()
    await step13(current.page)
  }
  if (wants(14)) {
    checkAborted()
    await step14(current.page)
  }
  if (wants(15)) {
    checkAborted()
    await step15()
  }
  if (wants(17)) {
    checkAborted()
    await step17()
  }
  if (wants(19)) {
    checkAborted()
    page = current ? current.page : await start()
    await step19(page)
  }
  if (wants(20)) {
    checkAborted()
    page = current ? current.page : await start()
    await step20(page)
  }
  if (wants(11)) {
    checkAborted()
    page = current ? current.page : await start()
    await step11(page)
  }
  if (wants(16)) {
    checkAborted()
    await step16()
  }
  if (wants(18)) {
    checkAborted()
    await step18()
  }
}

let failed = false
let timer
try {
  await Promise.race([
    main(),
    new Promise((_, rej) => {
      timer = setTimeout(() => {
        aborted = true
        rej(new Error('overall e2e timeout (12 min)'))
      }, OVERALL_TIMEOUT)
    })
  ])
} catch (err) {
  failed = true
  if (err instanceof Blocked) console.error(`BLOCKED: ${err.message}`)
  console.error(err)
  if (current) await shot('failure').catch(() => {})
  if (fake) await shot('failure-queued', fake.page).catch(() => {})
} finally {
  aborted = true
  clearTimeout(timer)
  await stop().catch((e) => console.error('stop failed', e))
  await stopFake().catch((e) => console.error('stop failed', e))
  if (existsSync(AGENT_FILE)) {
    try {
      execFileSync('gio', ['trash', AGENT_FILE])
      console.error(`finally: trashed leftover ${AGENT_FILE} with gio trash`)
    } catch (e) {
      failed = true
      console.error(`finally: COULD NOT trash ${AGENT_FILE}: ${e}`)
    }
  }
  for (const dir of [tmpUserData, tmpScratch]) {
    if (dir === null) continue
    if (safeTmpDir(dir)) await rm(dir, { recursive: true, force: true })
    else console.error(`refusing to delete unexpected path ${dir}`)
  }
}

log('--- browser console and server errors collected ---')
const flat = allErrors.flat()
log(flat.length ? flat.join('\n') : '(none)')
log(`--- ${results.join(' | ')}`)
log(`real CLI turns sent: ${cliTurns}; total ${secs()}`)
if (!failed && !only) {
  const expected = 20
  if (results.length < expected) {
    failed = true
    console.error(`expected ${expected} step results, got ${results.length}`)
  }
}
process.exit(failed ? 1 : 0)
