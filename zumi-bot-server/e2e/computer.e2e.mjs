// Computer use acceptance (npm run e2e:computer): the built server in Local mode, the real built UI in headless Chrome,
// the fake claude that runs the ACTUAL injected desktop MCP bridge (fake-desktop-claude.mjs), and fake Xvnc, D-Bus and
// cua-driver behind the ZUMIBOT_DESKTOP_* / ZUMIBOT_CUA_DRIVER overrides. No model, no quota, no real X server.
// Spec: docs/superpowers/specs/2026-11-04-computer-use-design.md.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { start, unexpectedErrors } from './harness.mjs'
import { PROCESS_START } from '../backend/tests/fixtures/fake-desktop-actions.mjs'

const FIX = fileURLToPath(new URL('../backend/tests/fixtures/', import.meta.url))
const FAKE = join(FIX, 'fake-desktop-claude.mjs')
await access(FAKE)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await fn()
    if (value) return value
    await sleep(40)
  }
  throw Error(`Timed out: ${label}`)
}
const lines = (path) =>
  readFile(path, 'utf8').then(
    (s) =>
      s
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    () => []
  )
const checks = []
function pass(name) {
  checks.push(name)
  console.log(`PASS ${name}`)
}
const scenario = (plan) => `DESKTOP_SCENARIO:${Buffer.from(JSON.stringify(plan)).toString('base64')}`
const call = (tool, args = {}, save) => ({ tool: `desktop_${tool}`, args, ...(save ? { save } : {}) })
const stamp = (name) => ({ $stamp: name })
const tid = (id) => `[data-testid="${id}"]`

const root = await mkdtemp(join(tmpdir(), 'cb-computer-'))
const bin = join(root, 'bin'),
  agentsDir = join(root, 'agents'),
  work = join(root, 'work'),
  rt = join(root, 'rt')
const xvncLog = join(root, 'xvnc.jsonl'),
  cuaLog = join(root, 'cua.jsonl')
const cbDirsBefore = new Set((await readdir('/tmp')).filter((n) => n.startsWith('cb-d-')))
let h = null,
  rpc = null,
  ctx2 = null

// The adapter builds each child's env from scratch, so the fakes' log paths ride in their wrappers.
async function wrapper(name, body) {
  const path = join(bin, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o755)
  return path
}
const node = (fixture) => `exec '${process.execPath}' '${join(FIX, fixture)}' "$@"`

const xvnc = () => lines(xvncLog)
const cuaTools = async () => (await lines(cuaLog)).filter((e) => e.tool).map((e) => e.tool)
const count = async (type) => (await xvnc()).filter((e) => e.type === type).length
async function logResult(log, name, agent, ms) {
  return until(
    async () => {
      const all = await lines(log)
      const failed = all.find((e) => e.name === 'fixture-error')
      if (failed) throw Error(`fake claude failed: ${failed.message}`)
      return all.find((e) => e.name === name && (agent === undefined || e.agent === agent))
    },
    `fake result ${name}`,
    ms
  )
}

async function connect(path = '/ws', origin = h.origin, authenticated = true) {
  const cookie = (await h.context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ')
  const ws = new WebSocket(h.origin.replace('http', 'ws') + path, {
    headers: { Origin: origin, ...(authenticated ? { Cookie: cookie } : {}) }
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  let id = 0,
    bytes = Buffer.alloc(0)
  const pending = new Map(),
    wire = []
  ws.on('message', (raw, binary) => {
    if (binary) {
      bytes = Buffer.concat([bytes, raw])
      return
    }
    const value = JSON.parse(String(raw))
    wire.push(value)
    if (pending.has(value.id)) {
      pending.get(value.id)(value)
      pending.delete(value.id)
    }
  })
  ws.on('error', () => {})
  return {
    ws,
    wire,
    async request(message, wait = true) {
      const next = ++id
      if (!wait) {
        ws.send(JSON.stringify({ id: next, ...message }))
        return { id: next, value: null }
      }
      const result = new Promise((resolve) => pending.set(next, resolve))
      ws.send(JSON.stringify({ id: next, ...message }))
      let timer
      const response = await Promise.race([
        result,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error(`Socket timeout ${message.op ?? message.method}`)), 20000)
        })
      ]).finally(() => clearTimeout(timer))
      assert.equal(response.ok, true, JSON.stringify(response))
      return { id: next, value: response.value }
    },
    async rpc(method, ...args) {
      return (await this.request({ method, args }, method !== 'chats:send')).value
    },
    /** The next n RFB bytes of the open leg. */
    async take(n) {
      await until(() => bytes.length >= n, `${n} RFB bytes`)
      const out = bytes.subarray(0, n)
      bytes = bytes.subarray(n)
      return out
    },
    close() {
      ws.close()
    }
  }
}
async function rejectedSocket(origin, authenticated) {
  const client = await connect('/ws/desktop', origin, authenticated)
  assert.equal(await new Promise((resolve) => client.ws.once('close', resolve)), 4401)
}
const items = async (id) => (await rpc.rpc('chats:items', id)).items
async function idle(chatId) {
  await until(async () => (await rpc.rpc('chats:list')).find((c) => c.id === chatId)?.inFlight === false, `chat ${chatId} idle`)
}
async function status(page, text) {
  await page.waitForFunction((t) => document.querySelector('[data-testid="desktop-status"]')?.textContent === t, text, { timeout: 20000 })
}
const canvas = (page) =>
  page.waitForFunction(() => document.querySelector('.desktop-screen canvas')?.width === 1280, null, { timeout: 30000 })
async function openDesktop(page) {
  if (await page.locator(tid('desktop-panel')).isVisible()) return canvas(page)
  if (!(await page.locator(tid('side-menu')).isVisible())) await page.locator(tid('side-panel-toggle')).click()
  await page.locator(tid('side-open-desktop')).click()
  await page.locator(tid('desktop-panel')).waitFor()
  await canvas(page)
}
const control = (page) => page.getByRole('switch', { name: 'Take control' })
async function clickCanvas(page, dx = 0, dy = 0) {
  const box = await page.locator('.desktop-screen canvas').boundingBox()
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy)
}
// Pointer lines reach the fake Xvnc only after the relay's filter let them through.
const pointers = () => count('pointer')
async function noNewPointer(before, label) {
  await sleep(800)
  assert.equal(await pointers(), before, label)
}

// CSP violations are reported to the page itself, whatever the console says.
const cspCollector = () => {
  window.__csp = []
  document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`))
}

/** A raw RFB viewer on /ws/desktop: watches, does the 3.8 handshake by hand and returns the leg's socket. */
async function rawViewer(target) {
  const v = await connect('/ws/desktop')
  const watch = await v.request({ op: 'watch', target })
  await until(() => v.wire.some((m) => m.type === 'rfb' && m.state === 'open' && m.watchId === watch.id), 'raw viewer leg')
  assert.equal(String(await v.take(12)), 'RFB 003.008\n')
  v.ws.send(Buffer.from('RFB 003.008\n'))
  assert.deepEqual([...(await v.take(2))], [1, 1])
  v.ws.send(Buffer.from([1]))
  assert.deepEqual([...(await v.take(4))], [0, 0, 0, 0])
  v.ws.send(Buffer.from([1]))
  const init = await v.take(24)
  await v.take(init.readUInt32BE(20))
  return v
}

try {
  for (const d of [bin, agentsDir, work]) await mkdir(d, { recursive: true })
  await mkdir(rt, { mode: 0o700 })
  // computerUse is turned on by the UI in check 1; the room members have it from the start.
  const agentFile = (name, on = false) =>
    `---\nname: ${name}\ndescription: Computer use acceptance\n${on ? 'computerUse: true\n' : ''}---\nUse the desktop fixture.\n`
  await writeFile(join(agentsDir, 'cu-agent.md'), agentFile('cu-agent'))
  await writeFile(join(agentsDir, 'plain-agent.md'), agentFile('plain-agent'))
  for (const name of ['room-a', 'room-b']) await writeFile(join(agentsDir, `${name}.md`), agentFile(name, true))
  const env = {
    // Steady small updates, so a watching viewer has traffic that must stop when it closes (check 9).
    ZUMIBOT_DESKTOP_XVNC: await wrapper(
      'xvnc',
      `FAKE_XVNC_LOG='${xvncLog}' FAKE_XVNC_UPDATE_MS=150; export FAKE_XVNC_LOG FAKE_XVNC_UPDATE_MS\n${node('fake-xvnc.mjs')}`
    ),
    ZUMIBOT_DESKTOP_DBUS_DAEMON: await wrapper('dbus', node('fake-dbus-daemon.mjs')),
    ZUMIBOT_DESKTOP_SESSION: await wrapper('session', 'exec sleep 86400'),
    ZUMIBOT_CUA_DRIVER: await wrapper('cua', `FAKE_CUA_LOG='${cuaLog}'; export FAKE_CUA_LOG\n${node('fake-cua-driver.mjs')}`),
    // Desktop run folders land under this run's temp root, so every process it starts carries the root in its env.
    XDG_RUNTIME_DIR: rt
  }
  h = await start({ mode: 'local', fake: FAKE, agentsDir, env })
  const page = h.page
  await h.context.addInitScript(cspCollector)
  const traffic = { received: 0, sent: 0 }
  page.on('websocket', (ws) => {
    if (!ws.url().endsWith('/ws/desktop')) return
    ws.on('framereceived', (f) => {
      if (typeof f.payload !== 'string') traffic.received += f.payload.length
    })
    ws.on('framesent', (f) => {
      if (typeof f.payload !== 'string') traffic.sent += f.payload.length
    })
  })
  rpc = await connect()

  // ---- 1 Agent Studio's switch writes computerUse: true, and off removes the key ----
  const file = join(agentsDir, 'cu-agent.md'),
    text = () => readFile(file, 'utf8')
  // The page the rest of the suite drives is served with the app's real CSP (checked in 3).
  const csp = (await page.goto(h.origin)).headers()['content-security-policy']
  const row = page.locator(`${tid('agent-row')}[data-agent-name="cu-agent"]`)
  await row.waitFor({ timeout: 30000 })
  await row.hover()
  await page.getByRole('button', { name: /^cu.agent options$/i }).click()
  await page.locator(tid('agent-menu-edit')).click()
  const toggle = page.locator(tid('computer-use-switch'))
  await toggle.waitFor()
  assert.equal(await toggle.getAttribute('aria-checked'), 'false')
  assert.equal(await page.locator(tid('open-desktop')).isDisabled(), true, 'Open Desktop waits for a saved computerUse')
  const saveWith = async (on) => {
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-checked'), String(on))
    await page.getByRole('button', { name: 'Save changes', exact: true }).click()
    await until(
      async () => (on ? /^computerUse: true$/m.test(await text()) : !(await text()).includes('computerUse')),
      `agent file computerUse ${on}`
    )
    assert.doesNotMatch(await text(), /computerUse: false/)
  }
  await saveWith(true)
  await saveWith(false)
  await saveWith(true)
  await page.waitForFunction(() => !document.querySelector('[data-testid="open-desktop"]')?.disabled, null, { timeout: 10000 })
  assert.equal(await count('start'), 0, 'turning computer use on starts no desktop')
  pass('1 Agent Studio switch writes computerUse: true, off removes the key (never false); no desktop starts')

  // ---- 2 looking runs without a card; a click shows "Click at 412, 300", Show on desktop marks it, Allow clicks once ----
  const chat = await rpc.rpc('chats:create', 'cu-agent', work)
  const chatUrl = `${h.origin}/chat/${encodeURIComponent(chat.id)}`
  const log2 = join(root, 'click.jsonl'),
    gate2 = join(root, 'gate-click'),
    hold2 = join(root, 'hold-click')
  // The hold keeps the turn (and its lease) after the click, so "Agent working" can be seen before "Idle".
  await rpc.rpc(
    'chats:send',
    chat.id,
    scenario({
      log: log2,
      steps: [
        call('screenshot', {}, 'shot'),
        { wait: gate2 },
        call('click', { stamp: stamp('shot'), x: 412, y: 300 }, 'click'),
        { wait: hold2 }
      ]
    }),
    []
  )
  const shot = await logResult(log2, 'shot')
  assert.equal(shot.isError, false)
  assert.equal(shot.image, true)
  assert.ok(shot.result.stamp?.observationId)
  assert.deepEqual(await cuaTools(), ['get_desktop_state'])
  assert.equal(
    (await items(chat.id)).some((i) => i.type === 'approval'),
    false,
    'a screenshot asks nothing'
  )
  await page.goto(chatUrl)
  await page.locator(tid('composer-input')).waitFor()
  await writeFile(gate2, 'go')
  const card = page.locator(`${tid('approval-card')}[data-status="pending"]`)
  await card.waitFor()
  const head = (await card.locator('.approval-head').textContent()).trim()
  assert.match(head, /Click at 412, 300/)
  const approvals = (await items(chat.id)).filter((i) => i.type === 'approval')
  assert.deepEqual(
    approvals.map((a) => a.toolName),
    ['mcp__zumibot_desktop__desktop_click']
  )
  // A pending card starts no stream by itself.
  assert.equal(await count('init'), 0)
  assert.equal(await page.locator(tid('desktop-panel')).count(), 0, 'no desktop view before Show on desktop')
  await card.locator(tid('approval-show-desktop')).click()
  await page.locator(tid('desktop-panel')).waitFor()
  await canvas(page)
  await page.locator(tid('desktop-marker')).waitFor()
  await sleep(300)
  const mark = await page.locator(tid('desktop-marker')).boundingBox(),
    pic = await page.locator('.desktop-screen canvas').boundingBox()
  const k = pic.width / 1280
  assert.ok(
    Math.abs(mark.x + mark.width / 2 - (pic.x + 412 * k)) < 4 && Math.abs(mark.y + mark.height / 2 - (pic.y + 300 * k)) < 4,
    `marker at 412,300: ${JSON.stringify({ mark, pic })}`
  )
  await status(page, 'Waiting for approval')
  await card.locator(tid('approval-allow-once')).click()
  const click = await logResult(log2, 'click')
  assert.equal(click.isError, false, JSON.stringify(click.result))
  assert.equal(click.result.done, true)
  await status(page, 'Agent working')
  await writeFile(hold2, 'go')
  await idle(chat.id)
  assert.deepEqual(await cuaTools(), ['get_desktop_state', 'click'])
  assert.deepEqual((await lines(cuaLog)).find((e) => e.tool === 'click').args, { scope: 'desktop', x: 412, y: 300 })
  const stored = await readFile(join(h.dataDir, 'chats', `${chat.id}.json`), 'utf8')
  assert.equal(stored.includes('iVBORw0KGgo'), false, 'no screenshot in the chat JSON')
  const rows = (await items(chat.id)).filter((i) => i.type === 'tool')
  assert.deepEqual(
    rows.map((r) => [r.name, r.result]),
    [
      ['mcp__zumibot_desktop__desktop_screenshot', 'Desktop command completed.'],
      ['mcp__zumibot_desktop__desktop_click', 'Desktop command completed.']
    ]
  )
  pass(
    `2 screenshot asks nothing; card "${head}"; Show on desktop marks 412,300; Allow -> one get_desktop_state then one click; chat stores no image`
  )

  // ---- 3 noVNC paints the fake framebuffer under the real CSP ----
  const pixel = await page.evaluate(() => {
    const c = document.querySelector('.desktop-screen canvas')
    return [c.width, c.height, ...c.getContext('2d').getImageData(640, 400, 1, 1).data]
  })
  // noVNC asks for red in the low byte; the fake writes 90 60 30 per pixel whatever the shifts.
  assert.deepEqual(pixel, [1280, 800, 0x90, 0x60, 0x30, 255])
  await status(page, 'Idle')
  assert.match(csp, /script-src 'self';/)
  assert.match(csp, /connect-src 'self';/)
  assert.deepEqual(await page.evaluate(() => window.__csp), [])
  pass(
    '3 noVNC canvas 1280x800 painted rgb(144,96,48) under the real CSP, no violations; status "Waiting for approval" while the card waited, "Agent working" after Allow, "Idle" once the turn ended'
  )

  // ---- 4 input reaches Xvnc only with Take control on ----
  let before = await pointers()
  await clickCanvas(page)
  await noNewPointer(before, 'a click while watching reaches nothing')
  await control(page).check()
  await status(page, 'You have control')
  await clickCanvas(page)
  await until(async () => (await pointers()) > before, 'pointer reaches Xvnc in control')
  await control(page).uncheck()
  await page.waitForFunction(() => document.querySelector('[data-testid="desktop-status"]')?.textContent !== 'You have control', null, {
    timeout: 20000
  })
  before = await pointers()
  await clickCanvas(page, 30, 30)
  await noNewPointer(before, 'a click after release reaches nothing')
  pass('4 a canvas click adds no pointer line while watching, does with Take control, and stops again after release')

  // ---- 5 a second window watching sees "Controlled in another window"; its input never reaches Xvnc ----
  await control(page).check()
  await status(page, 'You have control')
  ctx2 = await h.newContext()
  await ctx2.addInitScript(cspCollector)
  const page2 = await ctx2.newPage()
  await page2.goto(chatUrl)
  await page2.locator(tid('side-panel-toggle')).click()
  await page2.locator(tid('side-open-desktop')).click()
  await canvas(page2)
  await status(page2, 'Controlled in another window')
  assert.equal(await control(page2).isDisabled(), true)
  before = await pointers()
  const keys = await count('key')
  await clickCanvas(page2)
  await page2.keyboard.press('a')
  await noNewPointer(before, "the other window's click reaches nothing")
  // The server drops it, not just the UI: a raw viewer's pointer and key bytes go nowhere, and its leg stays usable.
  const raw = await rawViewer({ agent: 'cu-agent', chatId: chat.id })
  raw.ws.send(Buffer.from([5, 1, 0, 50, 0, 60]))
  raw.ws.send(Buffer.from([5, 0, 0, 50, 0, 60]))
  raw.ws.send(Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]))
  raw.ws.send(Buffer.from([3, 0, 0, 0, 0, 0, 0, 1, 0, 1]))
  const update = await raw.take(20)
  assert.equal(update[0], 0, 'a full update request still answers')
  await noNewPointer(before, 'raw pointer bytes without control reach nothing')
  assert.equal(await count('key'), keys)
  raw.close()
  assert.deepEqual(await page2.evaluate(() => window.__csp), [])
  await ctx2.close()
  ctx2 = null
  await control(page).uncheck()
  await page.waitForFunction(() => document.querySelector('[data-testid="desktop-status"]')?.textContent !== 'You have control', null, {
    timeout: 20000
  })
  pass(
    '5 a second window shows "Controlled in another window" with Take control disabled; its clicks and a raw viewer\'s input never reach Xvnc'
  )

  // ---- 6 a handoff card: I'm done resumes without a live view; Cancel returns cancelled ----
  await page.getByRole('button', { name: 'Close desktop', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="desktop-panel"]'), null, { timeout: 5000 })
  for (const decision of ['done', 'cancel']) {
    const log = join(root, `handoff-${decision}.jsonl`),
      reason = `Please sign in to the mail app (${decision})`
    const inits = await count('init')
    await rpc.rpc('chats:send', chat.id, scenario({ log, steps: [call('request_user_action', { reason }, 'handoff')] }), [])
    const handoffCard = page.locator(`${tid('browser-action')}[data-surface="desktop"]`).filter({ hasText: reason })
    await handoffCard.getByText('Action required').waitFor()
    assert.equal(await page.locator(tid('desktop-panel')).count(), 0, 'the card opens no view')
    await handoffCard.getByRole('button', { name: decision === 'done' ? 'I’m done' : 'Cancel', exact: true }).click()
    const outcome = await logResult(log, 'handoff')
    if (decision === 'done') assert.equal(outcome.isError, false, JSON.stringify(outcome.result))
    else {
      assert.equal(outcome.isError, true)
      assert.equal(outcome.result.code, 'handoff_cancelled')
    }
    await handoffCard.getByText(decision === 'done' ? 'Done — agent can continue' : 'Cancelled').waitFor()
    await idle(chat.id)
    assert.equal(await count('init'), inits, 'answering a card streams nothing')
    assert.equal(await page.locator(tid('desktop-panel')).count(), 0)
  }
  pass("6 desktop handoff card: I'm done resumes the turn with no live view opened; a second card's Cancel returns handoff_cancelled")

  // ---- 7 a click whose screenshot came before the user had control is refused as stale ----
  const log7 = join(root, 'stale.jsonl'),
    gate7 = join(root, 'gate-stale')
  await rpc.rpc(
    'chats:send',
    chat.id,
    scenario({
      log: log7,
      steps: [call('screenshot', {}, 'fresh'), { wait: gate7 }, call('click', { stamp: stamp('fresh'), x: 100, y: 120 }, 'stale')]
    }),
    []
  )
  await logResult(log7, 'fresh')
  const clicks = (await cuaTools()).filter((t) => t === 'click').length
  await openDesktop(page)
  await control(page).check()
  await status(page, 'You have control')
  await control(page).uncheck()
  await page.waitForFunction(() => document.querySelector('[data-testid="desktop-status"]')?.textContent !== 'You have control', null, {
    timeout: 20000
  })
  await writeFile(gate7, 'go')
  const staleCard = page.locator(`${tid('approval-card')}[data-status="pending"]`)
  await staleCard.waitFor()
  assert.match(await staleCard.locator('.approval-head').textContent(), /Click at 100, 120/)
  await staleCard.locator(tid('approval-allow-once')).click()
  const refused = await logResult(log7, 'stale')
  assert.equal(refused.isError, true)
  assert.equal(refused.result.code, 'stale')
  await idle(chat.id)
  assert.equal((await cuaTools()).filter((t) => t === 'click').length, clicks, 'the stale click never reached cua')
  pass('7 a click approved after the user took and released control is refused as stale; no click reaches cua')

  // ---- 8 the viewer socket refuses a hostile Origin and a missing cookie ----
  await rejectedSocket('https://hostile.invalid', true)
  await rejectedSocket(h.origin, false)
  pass('8 /ws/desktop closes 4401 for a hostile Origin and for no cookie')

  // ---- 9 closing the panel stops the stream ----
  await openDesktop(page)
  const flowing = traffic.received
  await until(() => traffic.received > flowing + 1000, 'RFB traffic while the view is open')
  await page.getByRole('button', { name: 'Close desktop', exact: true }).click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="desktop-panel"]'), null, { timeout: 5000 })
  // Every viewer connection Xvnc saw has ended.
  await until(async () => (await count('close')) === (await count('init')), 'Xvnc connections closed')
  await sleep(300)
  const stopped = { ...traffic }
  await sleep(2000)
  assert.deepEqual(traffic, stopped, 'no RFB bytes after the panel closed')
  pass(
    `9 closing the panel stops RFB traffic (no bytes for 2 s) and Xvnc has no viewer left (${await count('init')} connections, all closed)`
  )

  // ---- 10 an agent without computer use gets no desktop server ----
  const plain = await rpc.rpc('chats:create', 'plain-agent', work),
    log10 = join(root, 'plain.jsonl')
  await rpc.rpc('chats:send', plain.id, scenario({ log: log10, desktop: false }), [])
  const argv = await logResult(log10, 'argv')
  // Its only --settings is the one every main run gets: the pause hook and the process start ask rule, no desktop rule.
  assert.equal(argv.servers.includes('zumibot_desktop'), false)
  assert.ok(argv.settings <= 1)
  assert.deepEqual(argv.ask, [PROCESS_START])
  await idle(plain.id)
  pass(`10 an agent without computerUse gets no zumibot_desktop and no desktop ask rules (servers: ${argv.servers.join(', ')})`)

  // ---- 11 two computer-use room members each get their own desktop ----
  const starts = (await xvnc()).filter((e) => e.type === 'start').length
  const room = await rpc.rpc('chats:createGroup', ['room-a', 'room-b'], work, ''),
    log11 = join(root, 'room.jsonl')
  await rpc.rpc('chats:send', room.id, '@room-a @room-b ' + scenario({ log: log11, steps: [call('screenshot', {}, 'look')] }), [])
  const [a, b] = [await logResult(log11, 'look', 'room-a', 30000), await logResult(log11, 'look', 'room-b')]
  assert.equal(a.isError, false, JSON.stringify(a.result))
  assert.equal(b.isError, false, JSON.stringify(b.result))
  assert.notEqual(a.result.stamp.generation, b.result.stamp.generation)
  const fresh = (await xvnc()).filter((e) => e.type === 'start').slice(starts)
  assert.equal(fresh.length, 2, 'one fake Xvnc start per member')
  const socketOf = (e) => e.args[e.args.indexOf('-rfbunixpath') + 1]
  assert.notEqual(fresh[0].display, fresh[1].display)
  assert.notEqual(socketOf(fresh[0]), socketOf(fresh[1]))
  const profiles = JSON.parse(await readFile(join(h.dataDir, 'desktops', 'profiles.json'), 'utf8')).profiles
  assert.ok(profiles['room-a'] && profiles['room-b'] && profiles['room-a'] !== profiles['room-b'], JSON.stringify(profiles))
  await idle(room.id)
  pass(
    `11 room members room-a and room-b get their own profiles and desktops (two fake Xvnc starts on :${fresh[0].display} and :${fresh[1].display})`
  )

  // ---- 12 Deny: a denied card runs nothing, not even a desktop start ----
  const log12 = join(root, 'deny.jsonl'),
    cuaBefore = (await cuaTools()).length,
    startsBefore = await count('start')
  // A looking tool forced to ask (ask: true), then an action; the stamp is never checked, since nothing runs.
  await rpc.rpc(
    'chats:send',
    chat.id,
    scenario({
      log: log12,
      steps: [
        { ...call('screenshot', {}, 'peek'), ask: true },
        call('click', { stamp: { generation: 'g', epoch: 1, observationId: 'o' }, x: 5, y: 6 }, 'poke')
      ]
    }),
    []
  )
  // Each card by its own request id from the chat items, so no check depends on when the page renders a status.
  for (const [name, tool, offer, other] of [
    ['peek', 'desktop_screenshot', 'approval-open-desktop', 'approval-show-desktop'],
    ['poke', 'desktop_click', 'approval-show-desktop', 'approval-open-desktop']
  ]) {
    const asked = await until(
      async () =>
        (await items(chat.id)).find(
          (i) => i.type === 'approval' && i.status === 'pending' && i.toolName === `mcp__zumibot_desktop__${tool}`
        ),
      `${name} card`
    )
    const pending = page.locator(`${tid('approval-card')}[data-request-id="${asked.id}"]`)
    // A card without a point offers Open Desktop; a pointer card keeps Show on desktop. Neither is clicked: watching starts a desktop.
    await pending.locator(tid(offer)).waitFor()
    assert.equal(await pending.locator(tid(other)).count(), 0)
    await pending.locator(tid('approval-deny')).click()
    assert.equal((await logResult(log12, name)).denied, true)
  }
  await idle(chat.id)
  const denied = (await items(chat.id)).filter((i) => i.type === 'approval').slice(-2)
  assert.deepEqual(
    denied.map((a) => [a.toolName, a.status]),
    [
      ['mcp__zumibot_desktop__desktop_screenshot', 'denied'],
      ['mcp__zumibot_desktop__desktop_click', 'denied']
    ]
  )
  assert.equal((await cuaTools()).length, cuaBefore, 'a denied call reaches no cua tool')
  assert.equal(await count('start'), startsBefore, 'a denied call starts no desktop')
  pass(
    '12 Deny on a desktop card (a forced-ask screenshot with Open Desktop, a click with Show on desktop): the fake logs denied, no cua call, no desktop start'
  )

  // ---- 13 a paste reaches the desktop's clipboard only with Take control on ----
  await openDesktop(page)
  const paste = (text) =>
    page.evaluate((t) => {
      const data = new DataTransfer()
      data.setData('text/plain', t)
      document
        .querySelector('.desktop-screen canvas')
        .dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, text)
  const cuts = await count('cut')
  await paste('watching only')
  await sleep(800)
  assert.equal(await count('cut'), cuts, 'a paste while watching reaches nothing')
  await control(page).check()
  await status(page, 'You have control')
  await paste('pasted while in control')
  const cut = await until(async () => (await xvnc()).filter((e) => e.type === 'cut')[cuts], 'cut text reaches Xvnc in control')
  assert.equal(cut.text, 'pasted while in control')
  await control(page).uncheck()
  await page.waitForFunction(() => document.querySelector('[data-testid="desktop-status"]')?.textContent !== 'You have control', null, {
    timeout: 20000
  })
  await paste('after release')
  await sleep(800)
  assert.equal(await count('cut'), cuts + 1, 'a paste after release reaches nothing')
  pass(
    '13 a paste on the desktop sends its text as ClientCutText only with Take control on (one cut line, none while watching or after release)'
  )

  // The refused sockets (check 8) are raw Node clients, so no page logs anything for them: no error is expected.
  assert.deepEqual(unexpectedErrors(h.errors, []), [])
} catch (error) {
  if (h) console.error(JSON.stringify({ serverAndConsoleErrors: h.errors }))
  for (const name of (await readdir(root).catch(() => [])).filter((n) => n.endsWith('.jsonl'))) {
    console.error(JSON.stringify({ log: name, records: (await lines(join(root, name))).slice(-30) }))
  }
  throw error
} finally {
  await ctx2?.close().catch(() => {})
  rpc?.close()
  await h?.stop()
  // Everything this run started carries the run's temp root in its env (wrappers, XDG_RUNTIME_DIR) or argv.
  const ours = async () => {
    const found = []
    for (const pid of (await readdir('/proc')).filter((n) => /^\d+$/.test(n))) {
      const [cmd, env] = await Promise.all([
        readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
        readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '')
      ])
      if (cmd.includes(root) || env.includes(root)) found.push(`${pid} ${cmd.replace(/\0/g, ' ').trim()}`)
    }
    return found
  }
  // Rootless Podman (the server's container check runs `podman info`) starts one pause process per XDG_RUNTIME_DIR and keeps it
  // for the user's session, so this run's own rt gets one. It is Podman's, not the app's: ended here, never counted.
  const podmanPause = (line) => /^\d+ catatonit -P$/.test(line)
  for (const line of (await ours()).filter(podmanPause))
    try {
      process.kill(Number(line.split(' ')[0]), 'SIGKILL')
    } catch {
      /* gone */
    }
  const appLeft = async () => (await ours()).filter((line) => !podmanPause(line))
  let left = []
  try {
    left = await until(
      async () => {
        const l = await appLeft()
        return l.length === 0 ? [] : null
      },
      'no processes left',
      15000
    )
  } catch {
    left = await appLeft()
  }
  for (const line of left)
    try {
      process.kill(Number(line.split(' ')[0]), 'SIGKILL')
    } catch {
      /* gone */
    }
  const fakes = execFileSync('sh', ['-c', "pgrep -af 'Xvnc|fake-' || true"], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.includes(FIX))
  await rm(root, { recursive: true, force: true })
  const cbDirs = (await readdir('/tmp')).filter((n) => n.startsWith('cb-d-') && !cbDirsBefore.has(n))
  if (left.length || fakes.length || cbDirs.length) {
    console.error(JSON.stringify({ leftovers: left, fakes, cbDirs }))
    process.exitCode = 1
  } else if (checks.length === 13) {
    console.log(JSON.stringify({ result: 'PASS', checks: checks.length, leftovers: 0 }))
  }
}
