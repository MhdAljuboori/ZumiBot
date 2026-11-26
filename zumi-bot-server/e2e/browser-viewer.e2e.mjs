// Built UI acceptance with a deterministic socket fixture and a real sandboxed Chrome page.
// No model, real credentials, personal profile, production server or external website is used.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { chromium } from 'playwright-core'
import { WebSocketServer } from 'ws'
import { pickOption, unexpectedErrors } from './harness.mjs'
import { encodeBrowserFrame } from '../shared/src/browser.ts'
const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'screenshots', 'browser-task7')
await mkdir(out, { recursive: true })
const agent = (name) => ({
  name,
  filePath: `/synthetic/${name}.md`,
  description: 'Research and browser tasks',
  color: 'blue',
  icon: null,
  error: null,
  builtIn: false
})
const agents = [agent('researcher'), agent('writer')]
const chat = (id, title, extra = {}) => ({
  id,
  title,
  agentName: 'researcher',
  sessionId: null,
  cwd: '/synthetic',
  createdAt: 1,
  updatedAt: 1,
  inFlight: false,
  ...extra
})
const chats = [
  chat('help', 'Website verification'),
  chat('ordinary', 'Research notes'),
  chat('group', 'Research team', {
    agentName: '',
    group: { members: ['researcher', 'writer'], sessions: {}, seen: {}, role: '', active: [], queue: [] }
  })
]
const handoff = {
  id: 'request',
  profileId: 'profile',
  generation: 'gen',
  chatId: 'help',
  turnId: 'attempt',
  site: 'https://workspace.example.test',
  reason: 'Please complete the website verification, then return control and choose I’m done.',
  createdAt: 1,
  agent: 'researcher',
  status: 'pending'
}
const items = [
  { type: 'user', id: 'u', text: 'Check the workspace and summarize the latest project updates.', ts: 1 },
  { type: 'assistant', id: 'a', agent: 'researcher', text: 'The workspace needs your help before I can continue.', ts: 2 },
  { type: 'browser-action', id: 'card', agent: 'researcher', ts: 3, handoff }
]
const status = {
  agent: 'researcher',
  profileId: 'profile',
  generation: 'gen',
  state: 'ready',
  tabs: [{ id: 'tab', title: 'Atlas Workspace', url: 'about:blank' }],
  activeTabId: 'tab',
  control: 'agent',
  pendingRequestId: 'request',
  error: null
}
const requests = [],
  rpcRequests = [],
  rpcClients = new Set(),
  errors = [],
  fixtureValues = []
let browser,
  site,
  frameTimer,
  capturing = false,
  captures = 0,
  sequence = 0
const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg))
const wss = new WebSocketServer({ noServer: true })
const server = createServer(async (req, res) => {
  if (req.url === '/fixture-input' && req.method === 'POST') {
    let text = ''
    for await (const part of req) text += part
    fixtureValues.push(text)
    res.end('ok')
    return
  }
  if (req.url === '/fixture-long') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(
      `<!doctype html><title>Long fixture</title><style>body{margin:0;font:20px system-ui}p,input{margin:16px}input{font:20px system-ui;width:220px}</style><p>Select hello <span id="word">world</span></p><input id="field" aria-label="Field" oninput="fetch('/fixture-input',{method:'POST',body:'field:'+this.value})"><div style="height:4000px;background:linear-gradient(#fff,#9ab)"></div><script>let t;addEventListener('scroll',()=>{clearTimeout(t);t=setTimeout(()=>fetch('/fixture-input',{method:'POST',body:'scroll:'+Math.round(scrollY)}),150)});document.addEventListener('selectionchange',()=>{const s=String(getSelection());if(s)fetch('/fixture-input',{method:'POST',body:'sel:'+s})})</script>`
    )
    return
  }
  if (req.url === '/fixture-download') {
    res.setHeader('Content-Disposition', 'attachment; filename="synthetic.txt"')
    res.end('synthetic download bytes')
    return
  }
  if (req.url === '/fixture-files') {
    res.setHeader('Content-Type', 'text/html')
    res.end(
      `<!doctype html><title>File and dialog fixture</title><input aria-label="Website file" type="file" style="position:absolute;left:50px;top:80px" onchange="this.files[0].text().then(text=>fetch('/fixture-input',{method:'POST',body:text}))"><button style="position:absolute;left:50px;top:180px" onclick="document.querySelector('#result').textContent=prompt('Synthetic website prompt','default')">Prompt</button><a style="position:absolute;left:50px;top:280px" href="/fixture-download">Download</a><div id="result"></div>`
    )
    return
  }
  if (req.url === '/fixture') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(
      `<!doctype html><html><head><title>Atlas Workspace</title><style>*{box-sizing:border-box}body{margin:0;background:#f3f5f9;color:#213047;font:18px system-ui}header{padding:24px 40px;background:#172c48;color:white;font-size:22px}main{max-width:640px;margin:90px auto;background:white;border:1px solid #dce2eb;border-radius:18px;padding:45px;box-shadow:0 12px 35px #1d35550b}small{color:#607087}h1{font-size:30px;margin:12px 0}p{color:#6a788a;line-height:1.6}label{display:block;font-size:15px;margin:24px 0 8px}input{display:block;width:100%;padding:15px;border:1px solid #bac7d8;border-radius:8px;font:18px system-ui}button{margin-top:20px;padding:14px 22px;background:#286add;color:white;border:0;border-radius:8px;font:16px system-ui}footer{margin-top:24px;color:#8a96a5;font-size:12px}</style></head><body><header>◈ Atlas Workspace</header><main><small>WEBSITE VERIFICATION</small><h1>Continue to your workspace</h1><p>This is a synthetic local website for testing the in-app browser viewer.</p><label for="account">Test account</label><input id="account" oninput="fetch('/fixture-input',{method:'POST',body:this.value})" autocomplete="off" placeholder="Enter a test account"><button onclick="document.querySelector('h1').textContent='Workspace ready'">Continue</button><footer>Local fixture · No external account or credentials</footer></main></body></html>`
    )
    return
  }
  const path = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '')
  if (path.includes('..')) {
    res.writeHead(404).end()
    return
  }
  try {
    const body = await readFile(join(here, '../frontend/dist', path))
    res.setHeader(
      'Content-Type',
      { html: 'text/html', js: 'application/javascript', css: 'text/css', png: 'image/png' }[extname(path).slice(1)] ??
        'application/octet-stream'
    )
    res.end(body)
  } catch {
    res.writeHead(404).end()
  }
})
server.on('upgrade', (req, sock, head) =>
  wss.handleUpgrade(req, sock, head, (ws) => {
    if (req.url === '/ws') {
      rpcClients.add(ws)
      ws.on('close', () => rpcClients.delete(ws))
      ws.on('message', (data) => {
        const { id, method, args } = JSON.parse(String(data))
        rpcRequests.push(method)
        let value = null
        switch (method) {
          case 'agents:list':
            value = agents
            break
          case 'btw:list':
            value = []
            break
          case 'todos:list':
            value = { rev: 0, items: [] }
            break
          case 'chats:list':
            value = chats
            break
          case 'chats:items':
            value = { items: args[0] === 'help' ? items : [], start: 0, seq: 1, quoted: [] }
            break
          case 'app:claudeStatus':
            value = '/synthetic/claude'
            break
          case 'app:getTheme':
            value = 'light'
            break
          case 'app:getAccent':
            value = 'blue'
            break
          case 'app:getHouseStyle':
            value = true
            break
          case 'app:mode':
            value = 'local'
            break
          case 'sidebar:get':
            value = { sections: [], unassigned: [] }
            break
          case 'routines:list':
            value = { routines: [], runs: {} }
            break
          case 'agents:read':
            value = '---\nname: researcher\ndescription: Research and browser tasks\n---\nResearch websites.'
            break
          case 'approvals:list':
            value = []
            break
          case 'notify:status':
            value = { pushAvailable: false, vapidPublicKey: null, devices: [] }
            break
          case 'notify:state':
            value = { pending: {}, lookedAt: {} }
            break
          case 'chats:pending':
          case 'processes:counts':
            value = {}
            break
          case 'todos:board':
            value = { rev: 0, open: [], done: [], doneTotal: 0 }
            break
          case 'inbox:messages':
            value = { messages: [], seenAt: 0 }
            break
          case 'workflows:list':
            value = { workflows: [], runs: {} }
            break
          case 'update:status':
            value = {
              current: '0.0.0',
              availability: 'notInstaller',
              local: true,
              latest: null,
              newer: false,
              checkedAt: null,
              checking: false,
              error: null,
              installing: false,
              lastResult: null,
              canRollBack: false
            }
            break
          case 'agents:codexInfo':
            value = { found: false, models: [] }
            break
          case 'vault:list':
            value = []
            break
          case 'isolation:status':
            value = {
              sandbox: { available: false, reason: 'synthetic' },
              container: { available: false, reason: 'synthetic' },
              toolchain: []
            }
            break
          case 'isolation:get':
            value = { isolation: { level: 'off', write: [], read: [], network: [], webSearch: false, autoBash: false }, refused: null }
            break
          case 'browsers:clear':
            status.state = 'stopped'
            status.control = 'agent'
            status.tabs = []
            for (const client of wss.clients)
              if (client.browserWatch) send(client, { type: 'status', watchId: client.browserWatch, status })
            break
        }
        send(ws, { id, ok: true, value })
      })
      return
    }
    ws.on('close', () => {
      ws.browserWatch = null
      status.control = 'agent'
    })
    const picture = async () => {
      if (capturing || !ws.browserWatch || ws.readyState !== 1) return
      capturing = true
      try {
        const jpeg = await site.screenshot({ type: 'jpeg', quality: 65 })
        if (ws.browserWatch) {
          captures++
          ws.send(
            encodeBrowserFrame(ws.browserWatch, {
              generation: status.generation,
              tabId: status.activeTabId,
              sequence: sequence++,
              width: 1280,
              height: 800,
              jpeg
            })
          )
        }
      } finally {
        capturing = false
      }
    }
    ws.on('message', async (data) => {
      const req = JSON.parse(String(data))
      requests.push(req)
      try {
        switch (req.op) {
          case 'watch':
            ws.browserWatch = req.id
            status.state = 'ready'
            status.control = 'agent'
            status.agent = req.target.agent
            status.tabs = [{ id: 'tab', title: 'Atlas Workspace', url: site.url() }]
            send(ws, { type: 'status', watchId: req.id, status })
            await picture()
            break
          case 'unwatch':
            ws.browserWatch = null
            status.control = 'agent'
            break
          case 'takeControl':
            status.control = 'pausing'
            send(ws, { type: 'status', watchId: ws.browserWatch, status })
            await new Promise((r) => setTimeout(r, 50))
            status.control = 'you'
            send(ws, { type: 'status', watchId: ws.browserWatch, status })
            break
          case 'releaseControl':
            status.control = 'agent'
            send(ws, { type: 'status', watchId: ws.browserWatch, status })
            break
          case 'input': {
            const i = req.input
            if (i.type === 'text') await site.keyboard.insertText(i.text)
            if (i.type === 'mouseDown' || i.type === 'mouseUp') {
              await site.mouse.move(i.x, i.y)
              await site.mouse[i.type === 'mouseDown' ? 'down' : 'up']({ button: i.button })
            }
            if (i.type === 'keyDown' || i.type === 'keyUp') {
              const cdp = await site.context().newCDPSession(site)
              await cdp.send('Input.dispatchKeyEvent', { type: i.type === 'keyDown' ? 'rawKeyDown' : 'keyUp', key: i.key, code: i.code })
              await cdp.detach()
            }
            break
          }
          case 'navigate':
            if (req.command.op === 'navigate') await site.goto(req.command.url)
            if (req.command.op === 'reload') await site.reload()
            status.tabs = [{ id: 'tab', title: await site.title(), url: site.url() }]
            send(ws, { type: 'status', watchId: ws.browserWatch, status })
            break
          case 'answer':
            handoff.status = req.decision === 'done' ? 'done' : 'cancelled'
            status.control = 'agent'
            for (const rpc of rpcClients)
              send(rpc, { event: 'chats:push', payload: { chatId: 'help', kind: 'items', items, start: 0, seq: 2 } })
            break
        }
        send(ws, { type: 'response', id: req.id, ok: true, value: null })
      } catch {
        send(ws, { type: 'response', id: req.id, ok: false, error: 'Synthetic browser command failed' })
      }
    })
    frameTimer = setInterval(() => void picture(), 120)
    ws.on('close', () => clearInterval(frameTimer))
  })
)
try {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({ channel: 'chrome', headless: true, chromiumSandbox: true })
  const website = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  site = await website.newPage()
  await site.goto(`${origin}/fixture`)
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text())
  })
  await page.goto(origin)
  await page.locator('[data-agent-name="researcher"]').first().click()
  await page.locator('[data-chat-id="help"]').first().click()
  await page.getByTestId('browser-action').waitFor()
  assert.equal(requests.filter((r) => r.op === 'watch').length, 0)
  assert.equal(captures, 0)
  await page.getByTestId('browser-action').getByRole('button', { name: 'Open Browser' }).click()
  await page.getByRole('switch', { name: 'Take control' }).waitFor()
  await page.waitForFunction(() => document.querySelector('canvas')?.width === 1280)
  assert.equal(await page.getByRole('switch', { name: 'Take control' }).isChecked(), false)
  await page.screenshot({ path: join(out, 'desktop-inline.png') })
  // The thread's edge fade is a mask, which would trap a fixed panel inside it: expanded, the card's panel must cover the
  // window (over the sidebar, chat head and composer) with Restore on top, and the moved canvas must repaint.
  await page.getByRole('button', { name: 'Expand browser' }).click()
  // Near the left edge: the sidebar covered the URL's start, where the address begins.
  const topmost = (b) => {
    const r = b.getBoundingClientRect(),
      hit = document.elementFromPoint(r.x + Math.min(8, r.width / 2), r.y + r.height / 2)
    return b === hit || b.contains(hit)
  }
  assert.equal(await page.getByRole('button', { name: 'Restore browser size' }).evaluate(topmost), true)
  assert.equal(await page.getByLabel('Browser URL').evaluate(topmost), true)
  await page.waitForFunction(() => document.querySelector('canvas')?.width === 1280)
  await page.screenshot({ path: join(out, 'desktop-expanded.png') })
  await page.getByRole('button', { name: 'Restore browser size' }).click()
  await page.getByTestId('browser-action').getByTestId('browser-panel').waitFor()
  await page.waitForFunction(() => document.querySelector('canvas')?.width === 1280)
  await page.getByRole('switch', { name: 'Take control' }).check()
  await page.getByText('You have control', { exact: true }).waitFor()
  const surface = await page.getByLabel('Browser page input').boundingBox()
  const scale = Math.min(surface.width / 1280, surface.height / 800),
    left = surface.x + (surface.width - 1280 * scale) / 2,
    top = surface.y + (surface.height - 800 * scale) / 2
  await page.mouse.click(left + 500 * scale, top + 423 * scale)
  await page.keyboard.type('demo', { delay: 60 })
  await page.waitForTimeout(250)
  assert.equal(await site.locator('#account').inputValue(), 'demo')
  assert.deepEqual(
    requests.filter((r) => r.op === 'input' && r.input.type === 'text').map((r) => r.input.text),
    ['d', 'e', 'm', 'o']
  )
  // An IME edits the text already in the field, so the composed word is added to it, never put in its place.
  await page.getByLabel('Browser page input').evaluate((el) => {
    const start = el.value
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    el.value = start + 'مرحبا'
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'مرحبا', isComposing: true }))
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'مرحبا' }))
    el.value = start + 'مرحبا'
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'مرحبا', inputType: 'insertText' }))
  })
  await page.waitForTimeout(200)
  assert.equal(requests.filter((r) => r.op === 'input' && r.input.type === 'text' && r.input.text === 'مرحبا').length, 1)
  // Real client clipboard and keyboard default: cancelling Ctrl+V suppresses this paste event.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
  await page.evaluate(() => navigator.clipboard.writeText('local-clipboard-control'))
  const clipboardStart = requests.length
  await page.keyboard.press('Control+V')
  await page.waitForTimeout(250)
  assert.deepEqual(
    requests
      .slice(clipboardStart)
      .filter((r) => r.op === 'input' && r.input.type === 'text')
      .map((r) => r.input.text),
    ['local-clipboard-control']
  )
  assert.equal(
    requests.slice(clipboardStart).some((r) => r.op === 'input' && ['keyDown', 'keyUp'].includes(r.input.type) && r.input.code === 'KeyV'),
    false
  )
  // Linux has no Cmd+V editing binding: dispatch the macOS key and its default paste event only if uncancelled.
  const metaStart = requests.length
  const metaAllowed = await page.getByLabel('Browser page input').evaluate((el) => {
    const allowed = el.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', metaKey: true, bubbles: true, cancelable: true })
    )
    if (allowed) {
      const data = new DataTransfer()
      data.setData('text/plain', 'local-clipboard-command')
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'v', code: 'KeyV', metaKey: true, bubbles: true, cancelable: true }))
    return allowed
  })
  assert.equal(metaAllowed, true)
  await page.waitForTimeout(250)
  assert.deepEqual(
    requests
      .slice(metaStart)
      .filter((r) => r.op === 'input' && r.input.type === 'text')
      .map((r) => r.input.text),
    ['local-clipboard-command']
  )
  assert.equal(
    requests.slice(metaStart).some((r) => r.op === 'input' && ['keyDown', 'keyUp'].includes(r.input.type) && r.input.code === 'KeyV'),
    false
  )
  const modifiedStart = requests.length
  const modifiedAllowed = await page.getByLabel('Browser page input').evaluate((el) => {
    const commits = [
      { key: '@', code: 'KeyQ', ctrlKey: true, altKey: true, modifierAltGraph: true },
      { key: 'ø', code: 'KeyO', altKey: true }
    ]
    return commits.map((init) => {
      const down = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true }),
        allowed = el.dispatchEvent(down)
      if (allowed) {
        el.value += init.key
        el.dispatchEvent(new InputEvent('input', { data: init.key, inputType: 'insertText', bubbles: true }))
      }
      el.dispatchEvent(new KeyboardEvent('keyup', { ...init, bubbles: true, cancelable: true }))
      return allowed
    })
  })
  assert.deepEqual(modifiedAllowed, [true, true])
  await page.waitForTimeout(250)
  assert.deepEqual(
    requests
      .slice(modifiedStart)
      .filter((r) => r.op === 'input' && r.input.type === 'text')
      .map((r) => r.input.text),
    ['@', 'ø']
  )
  assert.ok((await site.locator('#account').inputValue()).endsWith('local-clipboard-controllocal-clipboard-command@ø'))
  await page.keyboard.press('Escape')
  assert.equal(await page.getByLabel('Browser page input').evaluate((el) => el === document.activeElement), false)
  await page.getByRole('button', { name: 'Close browser', exact: true }).click()
  const before = captures
  await page.waitForTimeout(400)
  assert.ok(captures <= before + 1)
  await page.getByTestId('browser-action').getByRole('button', { name: 'Open Browser' }).click()
  await page.getByRole('switch', { name: 'Take control' }).waitFor()
  assert.equal(await page.getByRole('switch', { name: 'Take control' }).isChecked(), false)
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(200)
  assert.equal(requests.at(-1).op, 'unwatch')
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.waitForTimeout(300)
  assert.equal(await page.getByRole('switch', { name: 'Take control' }).isChecked(), false)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  if (await page.getByTestId('nav-backdrop').isVisible()) await page.getByRole('button', { name: 'Close sidebar', exact: true }).click()
  await page.screenshot({ path: join(out, 'narrow-inline.png') })
  await page.getByRole('button', { name: 'Expand browser' }).click()
  await page.screenshot({ path: join(out, 'narrow-expanded.png') })
  await page.getByRole('button', { name: 'Restore browser size' }).click()
  await page.getByRole('button', { name: 'Close browser', exact: true }).click()
  const watchCount = requests.filter((r) => r.op === 'watch').length
  await page.getByRole('button', { name: 'I’m done', exact: true }).click()
  await page.waitForTimeout(200)
  assert.equal(requests.at(-1).op, 'answer')
  assert.equal(requests.filter((r) => r.op === 'watch').length, watchCount)
  // Open a terminal card by agent/chat only: never reuse the old request target.
  await page.getByTestId('browser-action').getByRole('button', { name: 'Open Browser' }).click()
  await page.waitForTimeout(200)
  assert.equal(requests.filter((r) => r.op === 'watch').at(-1).target.requestId, undefined)
  await page.screenshot({ path: join(out, 'narrow-panel.png') })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: join(out, 'desktop-panel.png') })
  await page.getByRole('switch', { name: 'Take control' }).check()
  await page.getByText('You have control', { exact: true }).waitFor()
  for (const ws of wss.clients) if (ws.browserWatch) ws.close(1012)
  await page.waitForTimeout(1100)
  assert.equal(await page.getByRole('switch', { name: 'Take control' }).isChecked(), false)
  // A terminal clear notification must blank the canvas and input immediately.
  for (const ws of wss.clients)
    if (ws.browserWatch) send(ws, { type: 'status', watchId: ws.browserWatch, status: { ...status, state: 'closing', control: 'agent' } })
  await page.getByText('No live page', { exact: true }).waitFor()
  assert.equal(await page.getByRole('switch', { name: 'Take control' }).isDisabled(), true)
  await page.getByRole('button', { name: 'Close browser', exact: true }).click()
  await page.locator('[data-chat-id="group"]').first().click()
  if (!(await page.getByTestId('side-menu').isVisible())) await page.getByTestId('side-panel-toggle').click()
  await pickOption(page.getByLabel('Browser agent'), 'writer')
  await page.getByTestId('side-open-browser').click()
  await page.waitForTimeout(200)
  assert.equal(requests.filter((r) => r.op === 'watch').at(-1).target.agent, 'writer')
  await page.locator('[data-chat-id="ordinary"]').first().click()
  await page.waitForTimeout(150)
  assert.equal(requests.at(-1).op, 'unwatch')
  await page.getByTestId('agent-row').filter({ hasText: 'Researcher' }).hover()
  await page.getByRole('button', { name: 'Researcher options', exact: true }).click()
  await page.getByTestId('agent-menu-edit').click()
  await page.getByRole('button', { name: 'Clear browser data', exact: true }).waitFor()
  const clearsBefore = rpcRequests.filter((m) => m === 'browsers:clear').length
  await page.getByRole('button', { name: 'Clear browser data', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  assert.equal(rpcRequests.filter((m) => m === 'browsers:clear').length, clearsBefore)
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click()
  assert.equal(rpcRequests.filter((m) => m === 'browsers:clear').length, clearsBefore)
  await page.getByRole('button', { name: 'Clear browser data', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Clear browser data', exact: true }).click()
  await page.getByText('Browser data cleared.', { exact: true }).waitFor()
  assert.equal(rpcRequests.filter((m) => m === 'browsers:clear').length, clearsBefore + 1)
  assert.deepEqual(errors, [])
  const evidence = {
    result: 'PASS',
    checks: [
      'No socket/watch/capture on chat or card mount',
      'Explicit early-status/frame watch',
      'Take control off by default and on close/reopen/reconnect/visibility resume',
      'Real page pointer scaling and printable text exactly once',
      'IME commit exactly once',
      'Native Ctrl+V clipboard paste once with no remote raw V',
      'Cmd+V key default permits one local paste event with no remote raw V',
      'AltGraph and Option printable key defaults permit committed text once',
      'Escape restores app focus',
      'Expanded card panel covers the window above the thread fade, Restore and URL on top, canvas repainted',
      'Hidden unwatch and no new stream for answer-only Done',
      'Terminal card uses ordinary target',
      'Terminal status blanks canvas/disables input',
      'Group member selector',
      'Agent settings clear requires confirmation and respects Cancel'
    ],
    screenshots: [
      'desktop-inline.png',
      'desktop-expanded.png',
      'desktop-panel.png',
      'narrow-inline.png',
      'narrow-expanded.png',
      'narrow-panel.png'
    ],
    requests: requests.map((r) => ({ id: r.id, op: r.op, ...(r.op === 'watch' ? { target: r.target } : {}) })),
    captures,
    consoleErrors: errors
  }
  // Also exercise the built production server, real BrowserHub/manager and packaged worker.
  const tmp = await mkdtemp(join(tmpdir(), 'cb-viewer-production-')),
    dataDir = join(tmp, 'data'),
    agentsDir = join(tmp, 'agents')
  let child, productionContext
  try {
    await mkdir(join(dataDir, 'chats'), { recursive: true })
    await mkdir(agentsDir)
    await mkdir(join(tmp, 'home'))
    await writeFile(
      join(agentsDir, 'researcher.md'),
      '---\nname: researcher\ndescription: Research and browser tasks\n---\nResearch websites.'
    )
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ claudePath: '/usr/bin/true', theme: 'light' }))
    await writeFile(join(dataDir, 'chats.json'), JSON.stringify({ chats: [chat('real', 'Production browser fixture')] }))
    const probe = createServer()
    await new Promise((r) => probe.listen(0, '127.0.0.1', r))
    const port = probe.address().port
    await new Promise((r) => probe.close(r))
    const secret = randomBytes(24).toString('hex'),
      productionOrigin = `http://127.0.0.1:${port}`
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ZUMIBOT_'))),
      HOME: join(tmp, 'home'),
      NODE_ENV: 'test',
      ZUMIBOT_MODE: 'local',
      ZUMIBOT_LOCAL_SECRET: secret,
      ZUMIBOT_PORT: String(port),
      ZUMIBOT_DATA_DIR: dataDir,
      ZUMIBOT_AGENTS_DIR: agentsDir,
      // The inherited XDG_CONFIG_HOME would put the vault key under the developer's real config folder.
      ZUMIBOT_VAULT_KEY_FILE: join(tmp, 'vault-key', 'vault.key')
    }
    child = spawn(process.execPath, [join(here, '../backend/dist/server.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise((resolve, reject) => {
      let log = ''
      const timer = setTimeout(() => reject(new Error('Production fixture server startup timeout')), 15000)
      child.stdout.on('data', (d) => {
        log += d
        if (log.includes(`LISTENING ${port}`)) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.once('exit', () => reject(new Error('Production fixture server exited')))
      child.stderr.on('data', (d) => errors.push(...String(d).trim().split('\n')))
    })
    productionContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await productionContext.addCookies([{ name: 'cb_local', value: secret, url: productionOrigin }])
    const productionWire = []
    const real = await productionContext.newPage()
    real.on('websocket', (ws) => {
      ws.on('framesent', (e) => {
        try {
          const r = JSON.parse(String(e.payload))
          productionWire.push({ direction: 'sent', op: r.op, id: r.id, watchId: r.watchId })
        } catch {}
      })
      ws.on('framereceived', (e) => {
        try {
          const r = JSON.parse(String(e.payload))
          if (r.type === 'status' || r.type === 'response') productionWire.push({ direction: 'received', ...r })
        } catch {}
      })
    })
    real.on('pageerror', (e) => errors.push(e.message))
    await real.goto(productionOrigin)
    await real.locator('[data-agent-name="researcher"]').first().click()
    await real.locator('[data-chat-id="real"]').first().click()
    await real.getByTestId('chat-intro').waitFor()
    const profilesBefore = await readFile(join(dataDir, 'browsers/profiles.json'), 'utf8').then(JSON.parse, () => ({ profiles: {} }))
    assert.equal(Object.keys(profilesBefore.profiles).length, 0)
    const fitted = () => {
      const c = document.querySelector('canvas'),
        r = c?.getBoundingClientRect()
      return !!c?.width && c.width === Math.round(Math.floor(r.width) * Math.min(2, devicePixelRatio))
    }
    await ((await real.getByTestId('side-menu').isVisible()) || (await real.getByTestId('side-panel-toggle').click()),
    real.getByTestId('side-open-browser').click())
    await real.getByRole('switch', { name: 'Take control' }).waitFor()
    await real.waitForFunction(fitted)
    assert.equal(await real.getByRole('switch', { name: 'Take control' }).isChecked(), false)
    await real.getByRole('switch', { name: 'Take control' }).check()
    await real.getByText('You have control', { exact: true }).waitFor()
    await real.getByRole('textbox', { name: 'Browser URL', exact: true }).fill(`${origin}/fixture`)
    await real.getByRole('button', { name: 'Go', exact: true }).click()
    await real.waitForTimeout(500)
    // Where the account field is on a page of the panel's size, measured on the same fixture locally.
    const remoteSize = (page) =>
      page.evaluate(() => {
        const c = document.querySelector('canvas'),
          d = Math.min(2, devicePixelRatio)
        return [Math.round(c.width / d), Math.round(c.height / d)]
      })
    // On a phone, focusing or leaving a field hides or shows the tab bar, which resizes the surface; the page follows a
    // frame later. Map points only once the frame is the surface's size again, or they land off by the bar's height.
    const settled = (page) =>
      page.waitForFunction(() => {
        const c = document.querySelector('canvas'),
          r = c.getBoundingClientRect(),
          d = Math.min(2, devicePixelRatio)
        return Math.round(c.width / d) === Math.floor(r.width) && Math.round(c.height / d) === Math.floor(r.height)
      })
    const remoteBox = async (page, url, selector) => {
      await settled(page)
      const [W, H] = await remoteSize(page),
        probe = await browser.newPage({ viewport: { width: W, height: H } })
      try {
        await probe.goto(url)
        return await probe.locator(selector).boundingBox()
      } finally {
        await probe.close()
      }
    }
    const toScreen = async (page, x, y) => {
      await settled(page)
      const [W, H] = await remoteSize(page),
        r = await page.getByLabel('Browser page input').boundingBox(),
        k = Math.min(r.width / W, r.height / H)
      return [r.x + (r.width - W * k) / 2 + x * k, r.y + (r.height - H * k) / 2 + y * k]
    }
    const account = await remoteBox(real, `${origin}/fixture`, '#account')
    await real.mouse.click(...(await toScreen(real, account.x + 20, account.y + account.height / 2)))
    await real.keyboard.type('fixture', { delay: 75 })
    await real.waitForTimeout(250)
    assert.equal(fixtureValues.at(-1), 'fixture')
    // A double click selects the word under it, as on any desktop browser.
    await real.mouse.dblclick(...(await toScreen(real, account.x + 20, account.y + account.height / 2)))
    await real.keyboard.type('picked', { delay: 40 })
    await real.waitForTimeout(250)
    assert.equal(fixtureValues.at(-1), 'picked')
    await real.getByRole('textbox', { name: 'Browser URL', exact: true }).fill(`${origin}/fixture-files`)
    await real.getByRole('button', { name: 'Go', exact: true }).click()
    await real.waitForTimeout(300)
    const remoteClick = async (x, y) => real.mouse.click(...(await toScreen(real, x, y)))
    await remoteClick(100, 90)
    await real.getByLabel('Choose files for website').waitFor({ timeout: 3000 })
    await real
      .getByLabel('Choose files for website')
      .setInputFiles({ name: 'native-synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic native upload bytes') })
    await real.waitForTimeout(350)
    assert.equal(fixtureValues.at(-1), 'synthetic native upload bytes')
    await remoteClick(85, 190)
    await real.getByRole('textbox', { name: 'Website prompt response' }).fill('مرحبا')
    await real.screenshot({ path: join(out, 'production-dialog.png') })
    await real.getByRole('button', { name: 'Accept website dialog', exact: true }).click()
    await real.getByRole('textbox', { name: 'Website prompt response' }).waitFor({ state: 'hidden' })
    await remoteClick(85, 290)
    await real.getByRole('link', { name: 'Download synthetic.txt', exact: true }).waitFor({ timeout: 5000 })
    const fetched = await productionContext.request.get(
      productionOrigin + (await real.getByRole('link', { name: 'Download synthetic.txt', exact: true }).getAttribute('href'))
    )
    assert.equal(fetched.status(), 200)
    assert.equal(await fetched.text(), 'synthetic download bytes')
    await real.screenshot({ path: join(out, 'production-files.png') })
    evidence.checks.push('Production viewer native picker upload, Arabic prompt response and authenticated downloaded bytes')
    evidence.screenshots.push('production-dialog.png', 'production-files.png')
    await real.screenshot({ path: join(out, 'production-desktop.png') })
    await real.getByRole('button', { name: 'Close browser', exact: true }).click()
    await ((await real.getByTestId('side-menu').isVisible()) || (await real.getByTestId('side-panel-toggle').click()),
    real.getByTestId('side-open-browser').click())
    await real
      .locator('.browser-footer')
      .filter({ hasText: 'Live browser' })
      .waitFor({ timeout: 10000 })
      .catch(async (error) => {
        await real.screenshot({ path: join(out, 'production-reopen-failure.png') })
        await writeFile(
          join(out, 'production-debug.json'),
          JSON.stringify({ panel: await real.getByTestId('browser-panel').innerText(), wire: productionWire, errors }, null, 2)
        )
        throw error
      })
    assert.equal(await real.getByRole('switch', { name: 'Take control' }).isChecked(), false)
    // Read the synthetic fixture through a bounded page screenshot after reopening.
    await real.waitForTimeout(300)
    await real.screenshot({ path: join(out, 'production-reopen.png') })
    await writeFile(join(out, 'production-wire.json'), JSON.stringify(productionWire, null, 2))
    evidence.checks.push('Built production server authenticates, launches sandboxed worker, navigates, accepts input and reopens read-only')
    evidence.screenshots.push('production-desktop.png', 'production-reopen.png')
    // A phone: the page takes the phone's size, a tap types, Paste sends the clipboard, a long press selects a word, a swipe scrolls.
    const until = async (fn, label, ms = 8000) => {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (await fn()) return
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error(`Timed out: ${label}`)
    }
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
    try {
      await phone.addCookies([{ name: 'cb_local', value: secret, url: productionOrigin }])
      await phone.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: productionOrigin })
      const m = await phone.newPage()
      m.on('pageerror', (e) => errors.push(e.message))
      await m.goto(`${productionOrigin}/chat/real`)
      await ((await m.getByTestId('side-menu').isVisible()) || (await m.getByTestId('side-panel-toggle').click()),
      m.getByTestId('side-open-browser').click())
      await m.getByRole('switch', { name: 'Take control' }).check()
      await m.getByText('You have control', { exact: true }).waitFor()
      await m.getByRole('textbox', { name: 'Browser URL', exact: true }).fill(`${origin}/fixture-long`)
      await m.getByRole('button', { name: 'Go', exact: true }).click()
      // The controller's phone size wins over the desktop viewer that is still watching.
      await m.waitForFunction(fitted)
      await m.waitForTimeout(400)
      assert.deepEqual(
        await remoteSize(m),
        await m.getByTestId('browser-surface').evaluate((el) => {
          const r = el.getBoundingClientRect()
          return [Math.floor(r.width), Math.floor(r.height)]
        })
      )
      const field = await remoteBox(m, `${origin}/fixture-long`, '#field')
      await m.touchscreen.tap(...(await toScreen(m, field.x + 20, field.y + field.height / 2)))
      await m.keyboard.insertText('typed')
      await until(() => fixtureValues.at(-1) === 'field:typed', 'phone tap and type')
      await m.evaluate(() => navigator.clipboard.writeText('-pasted'))
      await m.getByRole('button', { name: 'Paste', exact: true }).click()
      await until(() => fixtureValues.at(-1) === 'field:typed-pasted', 'phone Paste button')
      // A phone keyboard: its keys carry no code, and its Backspace mostly edits the field's own text (a 229 key, then
      // an input event). Neither may cost control, and the field is never rewritten under the keyboard.
      const input = m.getByLabel('Browser page input')
      const before = await input.evaluate((el) => el.value)
      await input.evaluate((el) => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }))
        el.setRangeText('', el.value.length - 1, el.value.length, 'end')
        el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }))
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Unidentified', keyCode: 229, bubbles: true, cancelable: true }))
      })
      await until(() => fixtureValues.at(-1) === 'field:typed-paste', 'phone keyboard Backspace edits the field')
      assert.equal(await input.evaluate((el) => el.value), before.slice(0, -1), 'the page input is never rewritten while typing')
      await input.evaluate((el) => {
        for (const type of ['keydown', 'keyup'])
          el.dispatchEvent(new KeyboardEvent(type, { key: 'Backspace', code: '', keyCode: 8, bubbles: true, cancelable: true }))
      })
      await until(() => fixtureValues.at(-1) === 'field:typed-past', 'phone Backspace key without a code')
      await input.evaluate((el) => {
        el.setRangeText('ed', el.value.length, el.value.length, 'end')
        el.dispatchEvent(new InputEvent('input', { data: 'ed', inputType: 'insertText', bubbles: true }))
      })
      await until(() => fixtureValues.at(-1) === 'field:typed-pasted', 'phone keyboard types after Backspace')
      assert.equal(await m.getByRole('switch', { name: 'Take control' }).isChecked(), true, 'phone keys keep control')
      const cdp = await phone.newCDPSession(m),
        word = await remoteBox(m, `${origin}/fixture-long`, '#word')
      const [wx, wy] = await toScreen(m, word.x + word.width / 2, word.y + word.height / 2)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: wx, y: wy }] })
      await m.waitForTimeout(700)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await until(() => fixtureValues.includes('sel:world'), 'phone long press selects a word')
      const [sx, sy] = await toScreen(m, 200, 500)
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy }] })
      for (let n = 1; n <= 12; n++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx, y: sy - n * 25 }] })
        await m.waitForTimeout(30)
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await until(() => fixtureValues.some((v) => /^scroll:[1-9]/.test(v)), 'phone swipe scrolls the page')
      assert.equal(fixtureValues.filter((v) => v.startsWith('field:')).at(-1), 'field:typed-pasted', 'a swipe never clicks or types')
      await m.screenshot({ path: join(out, 'phone-control.png') })
      await m.getByRole('button', { name: 'Close browser', exact: true }).click()
      evidence.checks.push(
        'Phone viewer: page sized to the phone at 2x, tap and type, Paste button, keyboard Backspace both ways, long-press word select, swipe scroll'
      )
      evidence.screenshots.push('phone-control.png')
    } finally {
      await phone.close()
    }
    // The stand-in claude (/usr/bin/true) answers no probe: the connector switch-over and the slash menu's commands probe say so.
    assert.deepEqual(
      unexpectedErrors(errors, [
        /^connectors: switch-over probe failed, every connector starts off$/,
        /^engine commands probe failed \(claude\)$/
      ]),
      []
    )
  } finally {
    await productionContext?.close()
    if (child && child.exitCode === null) {
      const stopped = new Promise((r) => child.once('exit', r))
      child.kill('SIGTERM')
      await Promise.race([stopped, new Promise((r) => setTimeout(r, 12000).unref())])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
    await rm(tmp, { recursive: true, force: true })
  }
  await writeFile(join(out, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ result: 'PASS', checks: evidence.checks.length, screenshots: out, captures }))
} finally {
  clearInterval(frameTimer)
  for (const ws of wss.clients) ws.terminate()
  await browser?.close()
  await new Promise((r) => wss.close(r))
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
}
