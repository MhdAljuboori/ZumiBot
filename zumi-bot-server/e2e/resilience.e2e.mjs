// Local-mode e2e against the built server with the fake claude (no network, no real CLI).
// Covers: two tabs, a closed or reloaded tab mid-reply, an approval across tabs, a socket dropped while a card waits,
// a server restart mid-reply,
// upload limits, unsafe downloads, theme, the in-page folder picker and the account menu in local mode.
// Usage: npm run e2e:resilience (builds first).
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const BASIC = fileURLToPath(new URL('../backend/tests/fixtures/stream/basic.jsonl', import.meta.url))
const AGENT = 'e2e-agent'
const AGENT_FILE = `---\nname: ${AGENT}\ndescription: E2E test agent\nmodel: haiku\n---\nYou are a test agent.\n`
const INTERRUPTED = 'Interrupted — the app closed before this reply finished.'

const t0 = Date.now()
const pass = (step) => console.log(`PASS ${step}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}

const harnesses = []
const tmpDirs = []
const mk = async (prefix) => {
  const d = await mkdtemp(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}

// ---------- fake claude scripts: basic.jsonl with the reply streamed as `words` slow deltas ----------
const baseLines = (await readFile(BASIC, 'utf8')).split('\n').filter(Boolean)
// requestId: a chat already holding a card with that id takes the request as a repeat, so a second card needs its own.
async function writeScript(h, { words = 0, ms = 300, approval = false, requestId = 'req-e2e-1' } = {}) {
  const text = Array.from({ length: words }, (_, i) => `w${i + 1} `)
  const out = []
  for (const line of baseLines) {
    const m = JSON.parse(line)
    if (m.type === 'stream_event' && m.event?.delta?.type === 'text_delta') {
      if (approval) {
        out.push(
          JSON.stringify({
            type: 'control_request',
            request_id: requestId,
            request: {
              subtype: 'can_use_tool',
              tool_name: 'Bash',
              input: { command: 'ls' },
              description: 'List files',
              decision_reason: 'needs approval',
              tool_use_id: 'toolu_e2e'
            }
          }),
          `#WAIT_RESPONSE ${requestId}`
        )
      }
      if (words === 0) out.push(line)
      for (const t of text) out.push(JSON.stringify({ ...m, event: { ...m.event, delta: { ...m.event.delta, text: t } } }), `#SLEEP ${ms}`)
    } else if (m.type === 'assistant' && words > 0) {
      m.message.content = [{ type: 'text', text: text.join('').trim() }]
      out.push(JSON.stringify(m))
    } else out.push(line)
  }
  await writeFile(h.script, out.join('\n') + '\n')
}

// ---------- DOM helpers ----------
const SEND = '[data-testid="send-button"]'
const INPUT = '[data-testid="composer-input"]'
// The reply to the latest user message: assistant bubbles after the last user bubble (older turns say w1..w30 too).
const lastReply = () => {
  const users = [...document.querySelectorAll('.bubble.user')]
  const last = users[users.length - 1]
  return [...document.querySelectorAll('.bubble.assistant')]
    .filter((b) => !last || last.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)
    .map((b) => b.textContent.trim())
    .join(' ')
}
const replyText = (page) => page.evaluate(lastReply)
const hasWord = (n) => new RegExp(`\\bw${n}\\b`)

// Polled from node: the page's CSP forbids eval, so a function cannot be built from a string inside it.
async function waitWord(page, n, timeout = 15_000) {
  const end = Date.now() + timeout
  while (!hasWord(n).test(await replyText(page))) {
    if (Date.now() > end) throw new Error(`reply never reached w${n}: ${await replyText(page)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function waitIdle(page, timeout = 20_000) {
  await page.waitForFunction(
    () =>
      !document.querySelector('[data-streaming]') && document.querySelector('[data-testid="send-button"]')?.textContent.trim() === 'Send',
    undefined,
    { timeout }
  )
}

// Waits for the user bubble: until it exists, "the latest reply" would still be the previous turn's.
const waitUser = (page, text) => page.locator('.bubble.user', { hasText: text }).last().waitFor({ timeout: 10_000 })

async function sendText(page, text) {
  await page.locator(INPUT).fill(text)
  await page.locator(SEND).click()
  await waitUser(page, text)
}

// Through the paperclip, like a user: it tells the app which draft the hidden input's files belong to.
async function attach(page, files) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-testid="attach-button"]').click()])
  await chooser.setFiles(files)
}

async function pickAgent(page) {
  await page.locator('[data-testid="new-chat-agent"]').click()
  await page.locator(`[data-testid="new-chat-agent-option"][data-agent-name="${AGENT}"]`).click()
}

/** Starts a chat from the no-chat-open screen (the server's fixed folder answers "choose folder"). */
async function startChat(page, text) {
  await page.locator('[data-testid="new-chat"]').waitFor({ timeout: 15_000 })
  await pickAgent(page)
  await page.locator('[data-testid="new-chat-folder"]').click()
  await page.locator('[data-testid="new-chat-choose-folder"]').click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.textContent.includes('work'), undefined, {
    timeout: 10_000
  })
  await sendText(page, text)
  await page.locator('[data-testid="chat-agent"]').waitFor({ timeout: 15_000 })
}

/** Opens the (only) chat from the sidebar; a fresh tab lands on the no-chat-open screen. */
async function openChat(page) {
  await page.locator('[data-testid="agent-row"]').first().waitFor({ timeout: 15_000 })
  const row = page.locator('[data-testid="chat-row"]').first()
  try {
    await row.waitFor({ timeout: 2_500 })
  } catch {
    await page.locator('[data-testid="agent-toggle"]').first().click()
    await row.waitFor({ timeout: 5_000 })
  }
  await row.click()
  await page.locator('[data-testid="chat-agent"]').waitFor({ timeout: 10_000 })
}

async function newTab() {
  const p = await h.newPage()
  await p.goto(h.origin)
  return p
}

let h = null
let h2 = null
try {
  const work = await mk('cb-e2e-work-')
  const agentsDir = await mk('cb-e2e-agents-')
  await writeFile(join(agentsDir, `${AGENT}.md`), AGENT_FILE)
  h = await start({ mode: 'local', fake: true, agentsDir, env: { ZUMIBOT_TEST_PICK_FOLDER: work } })
  harnesses.push(h)
  let A = h.page
  await writeScript(h, { words: 30 })

  // 1. two tabs show the same streaming text
  await startChat(A, 'go slow one')
  let B = await newTab()
  await openChat(B)
  await waitWord(A, 6)
  await waitWord(B, 6)
  // Tab B must be getting live deltas: it still streams and is far from done (the reply takes ~9 s, w6 is at ~2 s)
  const [a1, b1] = [await replyText(A), await replyText(B)]
  assert(!hasWord(30).test(b1) && (await B.locator('[data-streaming]').count()) === 1, `tab B did not stream live: ${b1}`)
  const grown = b1.split(/\s+/).length
  await waitWord(B, grown + 2, 5_000)
  assert(hasWord(6).test(a1), `tab A lacks w6: ${a1}`)
  await waitIdle(A)
  await waitIdle(B)
  const [fa, fb] = [await replyText(A), await replyText(B)]
  assert(fa === fb && hasWord(30).test(fa), `final text differs or is incomplete: ${JSON.stringify([fa, fb])}`)
  pass('two tabs show the same streaming text, and the same final reply')

  // 2. closing the only tab mid-reply, then a new tab: the run kept going
  await B.close()
  await sendText(A, 'go slow two')
  await waitWord(A, 4)
  const seen = (await replyText(A)).split(/\s+/).length
  await A.close()
  await new Promise((r) => setTimeout(r, 2_500))
  A = await newTab()
  await openChat(A)
  await waitWord(A, seen + 1)
  await waitIdle(A, 30_000)
  const closedFinal = await replyText(A)
  assert(hasWord(30).test(closedFinal), `reply did not finish after the tab closed: ${closedFinal}`)
  assert((await A.locator('[data-testid="error-bubble"]').count()) === 0, 'an error bubble after reopening')
  pass(`closing the only tab mid-reply, then a new tab: reply was past w${seen} and finished`)

  // 2b. a page reload mid-reply: the chat's own address opens it again, with no click
  const chatUrl = A.url()
  assert(/^\/chat\/[^/]+$/.test(new URL(chatUrl).pathname), `the open chat has no address of its own: ${chatUrl}`)
  await sendText(A, 'go slow three')
  await waitWord(A, 3)
  const seenBeforeReload = (await replyText(A)).split(/\s+/).length
  await A.reload()
  await A.locator('[data-testid="chat-agent"]').waitFor({ timeout: 10_000 })
  assert(A.url() === chatUrl, `the reload moved the address: ${A.url()}`)
  await waitWord(A, seenBeforeReload + 1)
  await waitIdle(A, 30_000)
  const reloadFinal = await replyText(A)
  assert(hasWord(30).test(reloadFinal), `reply did not finish after the reload: ${reloadFinal}`)
  pass('a page reload mid-reply stays in the chat, and shows the reply further along and finished')

  // 2c. Back leaves the chat for the new-chat screen, Forward reopens it; an unknown chat's address falls back to /
  await A.goBack()
  await A.locator('[data-testid="new-chat"]').waitFor({ timeout: 10_000 })
  assert(new URL(A.url()).pathname === '/', `Back went to ${A.url()}`)
  await A.goForward()
  await A.locator('[data-testid="chat-agent"]').waitFor({ timeout: 10_000 })
  assert(A.url() === chatUrl, `Forward went to ${A.url()}`)
  await A.goto(`${h.origin}/chat/no-such-chat`)
  await A.locator('[data-testid="new-chat"]').waitFor({ timeout: 15_000 })
  await A.waitForFunction(() => location.pathname === '/', undefined, { timeout: 5_000 })
  await A.goto(chatUrl)
  await A.locator('[data-testid="chat-agent"]').waitFor({ timeout: 15_000 })
  pass('Back and Forward move between the chat and the new-chat screen; an unknown chat lands on /')

  // 3. an approval answered in tab A shows answered in tab B
  await writeScript(h, { words: 0, approval: true })
  B = await newTab()
  await openChat(B)
  await sendText(A, 'needs approval')
  const cardA = A.locator('[data-testid="approval-card"]').last()
  const cardB = B.locator('[data-testid="approval-card"]').last()
  await cardA.waitFor({ timeout: 15_000 })
  await cardB.waitFor({ timeout: 15_000 })
  assert((await cardB.getAttribute('data-status')) === 'pending', 'tab B card is not pending')
  await cardA.locator('[data-testid="approval-allow-once"]').click()
  await B.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="approval-card"]')].pop()?.getAttribute('data-status') === 'allowed-once',
    undefined,
    { timeout: 10_000 }
  )
  await waitIdle(A)
  await waitIdle(B)
  pass('an approval answered in tab A shows answered (allowed-once) in tab B')

  // 3b. the page's socket drops while its turn waits on a card (a phone closing the app): chats:send is rejected,
  // but the turn runs on, so no error may show; after the reconnect the card is still there and answers
  const dropCtx = await h.newContext()
  // Keeps every socket the page opens, so the test can close the app's own /ws as the OS would.
  await dropCtx.addInitScript(() => {
    const Native = window.WebSocket
    const socks = []
    window.__cbSockets = socks
    window.WebSocket = class extends Native {
      constructor(...args) {
        super(...args)
        socks.push(this)
      }
    }
  })
  const D = await dropCtx.newPage()
  await D.goto(h.origin)
  await openChat(D)
  await writeScript(h, { words: 0, approval: true, requestId: 'req-e2e-drop' })
  await sendText(D, 'drop my socket')
  // Step 3's card is still in the chat, answered: wait for this turn's own pending one.
  const cardD = D.locator('[data-testid="approval-card"][data-status="pending"]')
  await cardD.waitFor({ timeout: 15_000 })
  const rpcSockets = () => D.evaluate(() => window.__cbSockets.filter((s) => new URL(s.url).pathname === '/ws').map((s) => s.readyState))
  assert((await rpcSockets()).filter((r) => r === 1).length === 1, `expected one open /ws, got ${await rpcSockets()}`)
  await D.evaluate(() => {
    for (const s of window.__cbSockets) if (new URL(s.url).pathname === '/ws' && s.readyState === 1) s.close()
  })
  const reconnectBy = Date.now() + 15_000
  for (;;) {
    const states = await rpcSockets()
    if (states.length >= 2 && states[states.length - 1] === 1) break
    if (Date.now() > reconnectBy) throw new Error(`no reconnect: ${states}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  await D.locator('.connection-bar').waitFor({ state: 'detached', timeout: 10_000 })
  await D.waitForTimeout(500)
  const dropErrors = await D.locator('[data-testid="error-bubble"]').allTextContents()
  assert(dropErrors.length === 0, `an error shows after the reconnect: ${JSON.stringify(dropErrors)}`)
  assert((await cardD.count()) === 1, 'the pending card is gone after the reconnect')
  await cardD.locator('[data-testid="approval-allow-once"]').click()
  await waitIdle(D)
  assert((await D.locator('[data-testid="error-bubble"]').count()) === 0, 'an error shows after the turn ended')
  await dropCtx.close()
  await waitIdle(A)
  pass('a dropped socket while the turn waits on a card shows no error; it reconnects and the card still answers')

  // 4. restartServer() mid-reply
  await writeScript(h, { words: 30 })
  await sendText(A, 'restart me')
  await waitUser(B, 'restart me')
  await waitWord(A, 3)
  await waitWord(B, 3)
  const bar = '.connection-bar'
  await Promise.all([
    h.restartServer(),
    ...[A, B].map((p) =>
      p.waitForFunction(() => document.querySelector('.connection-bar')?.textContent.includes('Reconnecting…'), undefined, {
        timeout: 20_000,
        polling: 50
      })
    )
  ])
  pass('restartServer() mid-reply: both tabs show "Reconnecting…"')
  for (const [name, p] of [
    ['A', A],
    ['B', B]
  ]) {
    await p.locator(bar).waitFor({ state: 'detached', timeout: 20_000 })
    await p.locator('.notice', { hasText: INTERRUPTED }).last().waitFor({ timeout: 15_000 })
    await waitIdle(p, 10_000)
    assert((await p.locator('[data-streaming]').count()) === 0, `tab ${name} still streams`)
    assert((await p.locator('.spinner').count()) === 0, `tab ${name} still shows a spinner`)
    await p.locator(INPUT).fill('x') // an empty composer keeps Send disabled, so type first
    assert(await p.locator(SEND).isEnabled(), `tab ${name} send is disabled`)
    await p.locator(INPUT).fill('')
  }
  pass('after the restart both tabs show the "interrupted" notice, no spinner, and send is enabled')

  // 5. a 26 MB upload
  await B.close()
  await attach(A, { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(26 * 1024 * 1024) })
  await A.locator('[data-testid="attach-error"]').waitFor({ timeout: 10_000 })
  assert(
    (await A.locator('[data-testid="attach-error"]').textContent()).trim() === 'big.bin is over 25 MB',
    `attach error ${await A.locator('[data-testid="attach-error"]').textContent()}`
  )
  pass('a 26 MB upload shows "big.bin is over 25 MB"')

  // 6. an uploaded x.html downloads instead of rendering
  await writeScript(h, { words: 0 })
  await attach(A, {
    name: 'x.html',
    mimeType: 'text/html',
    buffer: Buffer.from('<h1 id="owned">unsafe html</h1><script>document.title="owned"</script>')
  })
  await A.locator('[data-testid="draft-attachment"][data-status="ready"]').waitFor({ timeout: 10_000 })
  await sendText(A, 'here is a file')
  const chip = A.locator('[data-testid="sent-chip"]').last()
  await chip.waitFor({ timeout: 10_000 })
  const download = new Promise((resolve) => {
    const hook = (p) => p.on('download', resolve)
    h.context.pages().forEach(hook)
    h.context.on('page', hook)
  })
  // A click opens the in-app viewer, which shows the html's source as text (never the page); its Open still downloads it.
  await chip
    .locator('button, a')
    .first()
    .click()
    .catch(() => chip.click())
  const viewer = A.locator('[data-testid="file-viewer"]')
  await viewer.waitFor({ timeout: 5_000 })
  await viewer.locator('[data-testid="viewer-text"]').waitFor({ timeout: 10_000 })
  const shown = await viewer.locator('[data-testid="viewer-text"]').textContent()
  assert(shown.includes('<h1 id="owned">'), `viewer text ${JSON.stringify(shown)}`)
  assert((await A.locator('#owned').count()) === 0 && (await A.title()) !== 'owned', 'the html rendered inside the viewer')
  await viewer.locator('[data-testid="viewer-open"]').click()
  const dl = await Promise.race([
    download,
    new Promise((_, rej) => setTimeout(() => rej(new Error('no download event within 10 s')), 10_000))
  ])
  assert(dl.suggestedFilename() === 'x.html', `download name ${dl.suggestedFilename()}`)
  for (const p of h.context.pages()) assert((await p.locator('#owned').count()) === 0, 'the html rendered as a page')
  await A.keyboard.press('Escape')
  await viewer.waitFor({ state: 'detached', timeout: 5_000 })
  pass('an uploaded x.html opens in the viewer as its source text, and its Open triggers a download, not a page')
  await waitIdle(A)

  // 7. theme overrides the OS scheme (set in Settings > General, opened from the account menu)
  await A.locator('[data-testid="settings-open"]').click()
  await A.waitForURL(/\/settings\/general$/, { timeout: 5_000 })
  await A.emulateMedia({ colorScheme: 'light' })
  await A.locator('[data-testid="theme-dark"]').click()
  const bg = () => A.evaluate(() => getComputedStyle(document.body).backgroundColor)
  await A.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(14, 16, 19)', undefined, { timeout: 5_000 })
  assert((await bg()) === 'rgb(14, 16, 19)', `dark bg ${await bg()}`)
  await A.emulateMedia({ colorScheme: 'dark' })
  await A.locator('[data-testid="theme-light"]').click()
  await A.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(255, 255, 255)', undefined, { timeout: 5_000 })
  assert((await bg()) === 'rgb(255, 255, 255)', `light bg ${await bg()}`)
  await A.locator('[data-testid="theme-system"]').click()
  pass('theme Dark under a light OS is rgb(14, 16, 19); Light under a dark OS is rgb(255, 255, 255)')

  // 8. local mode: no Account section (sign-out) in Settings
  await new Promise((r) => setTimeout(r, 1_000)) // the mode answer arrives after the socket opens
  assert((await A.locator('[data-testid="settings-nav-account"]').count()) === 0, 'Account section shown in local mode')
  assert((await A.getByText('Sign out').count()) === 0, 'Sign out is shown in local mode')
  assert((await A.locator('[data-testid="sign-out"], [data-testid="sign-out-everywhere"]').count()) === 0, 'sign-out buttons in local mode')
  await A.keyboard.press('Escape')
  await A.waitForURL((u) => !u.pathname.startsWith('/settings'), { timeout: 5_000 })
  pass('local mode shows no Account section or "Sign out"; Esc leaves Settings')
  await h.stop()

  // 9. the in-page folder picker (no fixed folder, so "choose folder" opens it)
  const agents2 = await mk('cb-e2e-agents-')
  await writeFile(join(agents2, `${AGENT}.md`), AGENT_FILE)
  h2 = await start({ mode: 'local', fake: true, agentsDir: agents2 })
  harnesses.push(h2)
  const home = join(h2.root, 'home') // the picker starts at home when the agent has no last folder
  for (const d of ['alpha/child1', 'alpha/child2', 'beta', 'gamma', '.hidden']) await mkdir(join(home, d), { recursive: true })
  const P = h2.page
  await P.locator('[data-testid="new-chat"]').waitFor({ timeout: 15_000 })
  await pickAgent(P)
  await P.locator('[data-testid="new-chat-folder"]').click()
  await P.locator('[data-testid="new-chat-choose-folder"]').click()
  const picker = P.locator('[data-testid="folder-picker"]')
  await picker.waitFor({ timeout: 10_000 })
  const items = picker.locator('[data-testid="folder-picker-item"]')
  await P.waitForFunction(() => document.querySelectorAll('[data-testid="folder-picker-item"]').length === 3, undefined, {
    timeout: 10_000
  })
  const names = await items.evaluateAll((els) => els.map((e) => e.getAttribute('data-name')))
  assert(JSON.stringify(names) === JSON.stringify(['alpha', 'beta', 'gamma']), `listed ${JSON.stringify(names)}`)
  assert((await picker.locator('[data-testid="folder-picker-path"]').getAttribute('data-path')) === home, 'picker did not start at home')
  pass('folder picker opens from "Choose folder…" and lists the tmp tree (hidden folders hidden)')

  const selected = () =>
    P.evaluate(() => document.querySelector('[data-testid="folder-picker-item"][aria-selected="true"]')?.getAttribute('data-name') ?? null)
  await items.nth(0).click()
  assert((await selected()) === 'alpha', `selected ${await selected()}`)
  await P.keyboard.press('ArrowDown')
  assert((await selected()) === 'beta', `after ArrowDown ${await selected()}`)
  await P.keyboard.press('ArrowDown')
  assert((await selected()) === 'gamma', `after 2nd ArrowDown ${await selected()}`)
  await P.keyboard.press('ArrowUp')
  assert((await selected()) === 'beta', `after ArrowUp ${await selected()}`)
  pass('ArrowDown / ArrowUp move the selection')

  const inside = () => P.evaluate(() => !!document.activeElement?.closest('[data-testid="folder-picker"]'))
  for (let i = 0; i < 14; i++) {
    await P.keyboard.press('Tab')
    assert(await inside(), `Tab ${i + 1} moved focus out of the picker`)
  }
  for (let i = 0; i < 14; i++) {
    await P.keyboard.press('Shift+Tab')
    assert(await inside(), `Shift+Tab ${i + 1} moved focus out of the picker`)
  }
  pass('Tab and Shift+Tab never move focus outside the picker')

  const nameInput = picker.locator('[data-testid="folder-picker-new-name"]')
  await picker.locator('[data-testid="folder-picker-new"]').click()
  await nameInput.waitFor({ timeout: 5_000 })
  await nameInput.fill('discarded')
  await P.keyboard.press('Escape')
  await nameInput.waitFor({ state: 'detached', timeout: 5_000 })
  assert(await picker.isVisible(), 'Esc in the name input closed the whole picker')
  pass('Esc in the new-folder input closes only the input; the picker stays open')

  await picker.locator('[data-testid="folder-picker-new"]').click()
  await nameInput.fill('made')
  await P.keyboard.press('Enter')
  await P.waitForFunction(
    (p) => document.querySelector('[data-testid="folder-picker-path"]')?.getAttribute('data-path') === p,
    join(home, 'made'),
    { timeout: 10_000 }
  )
  assert((await stat(join(home, 'made'))).isDirectory(), 'made folder missing on disk')
  assert(!(await stat(join(home, 'discarded')).catch(() => null)), 'the cancelled name was created')
  pass('creating a folder navigates the picker into it')

  await picker.locator('[data-testid="folder-picker-up"]').click()
  await P.waitForFunction(
    (p) =>
      document.querySelector('[data-testid="folder-picker-path"]')?.getAttribute('data-path') === p &&
      document.querySelectorAll('[data-testid="folder-picker-item"]').length === 4,
    home,
    { timeout: 10_000 }
  )
  await picker.locator('[data-testid="folder-picker-item"][data-name="beta"]').click()
  await picker.locator('[data-testid="folder-picker-use"]').click()
  await picker.waitFor({ state: 'detached', timeout: 5_000 })
  const folderBtn = P.locator('[data-testid="new-chat-folder"]')
  assert((await folderBtn.getAttribute('data-tip')) === join(home, 'beta'), `chosen folder ${await folderBtn.getAttribute('data-tip')}`)
  assert((await folderBtn.textContent()).includes('beta'), 'folder button does not show beta')
  pass('selecting a child folder then "Use this folder" returns that folder')

  await folderBtn.click()
  await P.locator('[data-testid="new-chat-choose-folder"]').click()
  await picker.waitFor({ timeout: 10_000 })
  await P.keyboard.press('Escape')
  await picker.waitFor({ state: 'detached', timeout: 5_000 })
  assert((await folderBtn.getAttribute('data-tip')) === join(home, 'beta'), 'Esc changed the chosen folder')
  pass('Esc with no input open closes the picker and keeps the earlier choice')
  // No console or server error is expected anywhere in this suite (a restart closes sockets cleanly)
  const bad = unexpectedErrors(
    harnesses.flatMap((x) => x.errors),
    []
  )
  assert(bad.length === 0, `unexpected errors: ${JSON.stringify(bad)}`)
  pass('no unexpected console or server errors')
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
} catch (err) {
  console.error(`FAIL ${err instanceof Error ? err.stack : err}`)
  for (const x of harnesses) {
    console.error(x.errors.slice(-10).join('\n'))
    // A screenshot of every open tab helps to see why a step failed
    for (const [i, p] of (x.context?.pages() ?? []).entries())
      await p.screenshot({ path: join(tmpdir(), `cb-e2e-fail-${i}.png`) }).then(
        () => console.error(`screenshot: ${join(tmpdir(), `cb-e2e-fail-${i}.png`)}`),
        () => {}
      )
  }
  process.exitCode = 1
} finally {
  for (const x of harnesses) await x.stop().catch((e) => console.error('stop failed', e))
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true })
}
