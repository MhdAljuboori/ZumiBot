// Desktop e2e: Local mode on the shell's real layout (server bundle from zumi-bot-server/backend/dist).
// Usage: npm run e2e -w zumibot   (root build, electron-builder --dir, then this against dist/linux-unpacked/zumibot:
// isPackaged, resources/server/server.mjs, NODE_ENV=production). `npm run e2e:dev -w zumibot` runs the unpacked shell instead.
//
// Hard rules: tmp XDG_CONFIG_HOME (userData follows it), tmp ZUMIBOT_DATA_DIR, tmp HOME; the real ~/.config/ZumiBot and
// ~/.local/share/zumibot are never touched; only the Electron started here (and its server child) is ever killed.
// The windows open on a throwaway X display with its own session bus and window manager (throwawayDisplay.mjs), never on the
// developer's desktop: an e2e once crashed the real GNOME Shell. ZUMIBOT_E2E_REAL_DISPLAY=1 opts in to the inherited display.
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron } from 'playwright-core'
import { startThrowawayDisplay } from './throwawayDisplay.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../zumi-bot-server/e2e/fixtures/group-shot/userData', import.meta.url))
const PACKAGED = fileURLToPath(new URL('../dist/linux-unpacked/zumibot', import.meta.url))
const OVERALL_TIMEOUT = 180_000

const assert = (c, m) => {
  if (!c) throw new Error(`ASSERT: ${m}`)
}
const ok = (m) => console.log(`PASS ${m}`)
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function hashTree(dir) {
  const out = {}
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else
        out[relative(dir, p)] = createHash('sha256')
          .update(await readFile(p))
          .digest('hex')
    }
  }
  await walk(dir)
  return out
}

/** Direct children of a pid, from /proc (Linux only, like the .deb). */
async function childPids(pid) {
  try {
    return (await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
}

// The path itself: the main window on /settings/island also ends with it.
const isIsland = (url) => /^https?:\/\/[^/]+\/island$/.test(url)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitUntil(fn, ms = 20_000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}
/** The Playwright page of the first Electron window whose URL passes `test` (a window may load after this is called). */
async function waitForWindow(electronApp, test, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const found = electronApp.windows().find((p) => !p.isClosed() && test(p))
    if (found) return found
    await sleep(100)
  }
  throw new Error('timed out waiting for a window')
}
/** Electron's flags are no proof that the window manager took them; X11 says so on the island window itself (null: no xprop or no window manager). */
async function x11IslandProp(electronApp, env, prop, island = true) {
  const id = await electronApp.evaluate(({ BrowserWindow }, island) => {
    const w = BrowserWindow.getAllWindows().find((x) => /^https?:\/\/[^/]+\/island$/.test(x.webContents.getURL()) === island)
    return w ? w.getNativeWindowHandle().readUInt32LE(0) : null
  }, island)
  if (!id || !env.DISPLAY || env.WAYLAND_DISPLAY) return null
  try {
    const run = promisify(execFile)
    await run('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK'], { env })
    return (await run('xprop', ['-id', String(id), prop], { env })).stdout.trim()
  } catch {
    return null
  }
}
const x11Workspace = (electronApp, env) => x11IslandProp(electronApp, env, '_NET_WM_DESKTOP')
/** The island's X shape extents ("58x480+372+20" -> {width, height}) from xwininfo; undefined: not X11 or no xwininfo, null: no shape set yet. */
async function x11Shape(electronApp, env) {
  const id = await electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => /^https?:\/\/[^/]+\/island$/.test(x.webContents.getURL()))
    return w ? w.getNativeWindowHandle().readUInt32LE(0) : null
  })
  if (!id || !env.DISPLAY || env.WAYLAND_DISPLAY) return undefined
  try {
    const out = (await promisify(execFile)('xwininfo', ['-id', String(id), '-shape'], { env })).stdout
    const m = /Window shape extents:\s+(\d+)x(\d+)/.exec(out)
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null
  } catch (err) {
    return err.code === 'ENOENT' ? undefined : null
  }
}
const islandWindows = (electronApp) =>
  electronApp.evaluate(
    ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => /^https?:\/\/[^/]+\/island$/.test(w.webContents.getURL())).length
  )

const tmp = await mkdtemp(join(tmpdir(), 'zumibot-e2e-desktop-'))
const home = join(tmp, 'home')
const xdgConfig = join(tmp, 'config')
const dataDir = join(tmp, 'data')
const agentsDir = join(tmp, 'agents')
const userData = join(xdgConfig, 'ZumiBot')
const errors = []
let app = null
let serverPid = null
let electronPid = null
let browserProcesses = []
let session = null // the throwaway X session, unless ZUMIBOT_E2E_REAL_DISPLAY=1
const REAL_DISPLAY = process.env.ZUMIBOT_E2E_REAL_DISPLAY === '1'
const timer = setTimeout(() => {
  console.error('FAIL overall timeout')
  cleanup().finally(() => process.exit(1))
}, OVERALL_TIMEOUT)

async function cleanup() {
  // A failure before the server pid was found: its server.mjs children are still ours to kill.
  const stray = []
  if (electronPid && alive(electronPid)) {
    for (const k of await childPids(electronPid)) {
      if ((await readFile(`/proc/${k}/cmdline`, 'utf8').catch(() => '')).includes('server.mjs')) stray.push(k)
    }
  }
  for (const pid of [serverPid, ...stray, electronPid]) {
    if (pid && alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {}
    }
  }
  await session?.stop().catch(() => {})
  await rm(tmp, { recursive: true, force: true }).catch(() => {})
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    console.error(`FAIL ${sig}`)
    clearTimeout(timer)
    cleanup().finally(() => process.exit(1))
  })
}

async function browserPreflight(executable, source, env) {
  const artifact = join(tmp, 'server artifact with spaces')
  await cp(source, artifact, { recursive: true })
  const childEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', ZUMIBOT_BROWSER_EXECUTABLE_PATH: '/opt/google/chrome/chrome' }
  const check = spawn(executable, [join(artifact, 'server.mjs'), 'browser-check'], { env: childEnv })
  let output = '',
    errors = ''
  check.stdout.on('data', (b) => {
    output += b
  })
  check.stderr.on('data', (b) => {
    errors += b
  })
  const [code] = await once(check, 'exit')
  assert(code === 0 && output.includes('Browser check passed'), `Electron Node browser check failed: ${errors}`)
  assert((await readdir(dataDir)).length === 0, 'check touched app data')
  ok('copied packaged browser-check uses Electron Node and sandboxed worker, with ephemeral profile only')

  // Synthetic private backend boundary; run the real shipped MCP bridge with Electron Node.
  const socketPath = join(tmp, 'bridge.sock'),
    token = 'synthetic-desktop-capability'
  let routed = false
  const ipc = createServer((socket) => {
    let pending = ''
    socket.on('data', (bytes) => {
      pending += bytes
      let n
      while ((n = pending.indexOf('\n')) >= 0) {
        const request = JSON.parse(pending.slice(0, n))
        pending = pending.slice(n + 1)
        if (request.type === 'auth') {
          assert(request.token === token, 'wrong synthetic capability')
          socket.write(JSON.stringify({ type: 'auth', ok: true }) + '\n')
        } else if (request.type === 'run') {
          assert(request.command.op === 'tabs', 'unexpected bridge operation')
          routed = true
          socket.write(JSON.stringify({ type: 'result', id: request.id, result: { ok: true, data: { tabs: [] } } }) + '\n')
        }
      }
    })
  })
  await new Promise((resolve) => ipc.listen(socketPath, resolve))
  const client = new Client({ name: 'desktop-acceptance', version: '1' })
  try {
    await client.connect(
      new StdioClientTransport({
        command: executable,
        args: [join(artifact, 'browserBridge.mjs')],
        cwd: artifact,
        env: { ...childEnv, ZUMIBOT_BROWSER_IPC: socketPath, ZUMIBOT_BROWSER_CAPABILITY: token }
      })
    )
    assert(
      (await client.listTools()).tools.some((t) => t.name === 'browser_tabs'),
      'bridge discovery failed'
    )
    const result = await client.callTool({ name: 'browser_tabs', arguments: {} })
    assert(routed && !result.isError, 'Electron Node bridge did not route tool')
    ok('copied packaged MCP bridge discovers and routes with Electron Node')
  } finally {
    await client.close()
    await new Promise((resolve) => ipc.close(resolve))
  }

  // Intercept only the upstream downloader; explicit install must fork Electron in Node mode too.
  const record = join(tmp, 'installer.json'),
    installData = join(tmp, 'installer data')
  await writeFile(
    join(artifact, 'node_modules/playwright-core/cli.js'),
    `require('fs').writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),cache:process.env.PLAYWRIGHT_BROWSERS_PATH,electron:process.versions.electron}));process.exit(17);`
  )
  const install = spawn(executable, [join(artifact, 'server.mjs'), 'browser-install'], {
    env: { ...childEnv, ZUMIBOT_DATA_DIR: installData },
    stdio: 'ignore'
  })
  assert((await once(install, 'exit'))[0] === 1, 'synthetic install exit did not propagate')
  const called = JSON.parse(await readFile(record, 'utf8'))
  assert(
    called.electron &&
      called.cache === join(installData, 'browser-runtime') &&
      JSON.stringify(called.args) === '["install","--no-shell","chromium"]',
    'install child did not use the pinned private Electron runtime'
  )
  ok('explicit installer uses Electron Node and private cache; downloader intercepted, no installation or network')
}

try {
  await mkdir(home, { recursive: true })
  await mkdir(agentsDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  // The "old app" data, plus the choice the picker would have saved.
  await cp(FIXTURE, userData, { recursive: true })
  await writeFile(join(agentsDir, 'icon-agent.md'), '---\nname: icon-agent\ndescription: Fixture agent\nmodel: haiku\n---\nFixture.\n')
  const before = await hashTree(userData)
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  await writeFile(join(userData, 'server.json'), JSON.stringify({ kind: 'local', port }), { mode: 0o600 })
  // One picked agent on this server: the island shows it without the user touching Settings.
  await writeFile(
    join(userData, 'island.json'),
    JSON.stringify({ v: 1, startAtLogin: true, top: null, agents: { [`http://127.0.0.1:${port}`]: ['icon-agent'] } }),
    { mode: 0o600 }
  )

  // This tool's own environment may carry these; the shell must not see them.
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdgConfig, ZUMIBOT_DATA_DIR: dataDir, ZUMIBOT_AGENTS_DIR: agentsDir }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.XDG_DATA_HOME
  for (const key of Object.keys(env)) if (key.startsWith('ZUMIBOT_BROWSER_')) delete env[key]
  env.ZUMIBOT_BROWSER_EXECUTABLE_PATH = '/opt/google/chrome/chrome'
  // A ZUMIBOT_VAULT_KEY_FILE of this tool's own environment would name the developer's real key.
  env.ZUMIBOT_VAULT_KEY_FILE = join(tmp, 'vault-key', 'vault.key')
  if (REAL_DISPLAY) {
    console.warn('WARNING ZUMIBOT_E2E_REAL_DISPLAY=1: the windows open on your real desktop and its session bus')
  } else {
    // Own display, own session bus (the tray registers on it), own window manager: the real desktop never sees these windows.
    session = await startThrowawayDisplay(tmp, { avoid: process.env.DISPLAY })
    Object.assign(env, session.env)
    for (const k of ['WAYLAND_DISPLAY', 'XAUTHORITY', 'SESSION_MANAGER', 'GDK_BACKEND', 'ELECTRON_OZONE_PLATFORM_HINT']) delete env[k]
    ok(`throwaway X display ${session.display} with its own session bus and window manager (real desktop untouched)`)
  }
  const exe = process.env.ZUMIBOT_E2E_UNPACKED ? null : (process.env.ZUMIBOT_E2E_EXECUTABLE ?? PACKAGED)
  if (exe) await browserPreflight(exe, join(dirname(exe), 'resources/server'), env)
  const launchOpts = exe ? { executablePath: exe, args: [] } : { args: [ROOT] }
  app = await _electron.launch({ ...launchOpts, env, timeout: 30_000 })
  electronPid = app.process().pid
  app.process().stderr?.on('data', (d) => errors.push(String(d).trim()))

  const page = await waitForWindow(app, (p) => !isIsland(p.url()))
  assert((await app.evaluate(({ app: a }) => a.getPath('userData'))) === userData, 'userData is not the tmp dir')
  ok(`launched ${exe ? 'packaged executable' : 'unpacked shell'}, userData is the tmp dir`)

  await page.waitForSelector('[data-testid="new-agent"]', { timeout: 40_000 })
  assert(new URL(page.url()).hostname === '127.0.0.1', `page is ${page.url()}, not the local server`)
  const kids = await childPids(electronPid)
  const serverKids = []
  for (const k of kids) {
    const cmd = await readFile(`/proc/${k}/cmdline`, 'utf8').catch(() => '')
    if (cmd.includes('server.mjs')) serverKids.push(k)
  }
  assert(serverKids.length === 1, `expected one server child, found ${serverKids.length}`)
  serverPid = serverKids[0]
  if (exe) {
    const cmd = await readFile(`/proc/${serverPid}/cmdline`, 'utf8')
    assert(cmd.includes('resources/server/server.mjs'), `server not from resources/server: ${cmd}`)
  }
  ok(`local server up on ${new URL(page.url()).host} (pid ${serverPid})`)

  // Migration: the fixture's two group chats and one single chat show up.
  await page.waitForSelector('[data-testid="group-row"]', { timeout: 20_000 })
  const groups = await page.locator('[data-testid="group-row"]').count()
  assert(groups === 2, `expected 2 group chats, saw ${groups}`)
  const titles = await page.locator('[data-testid="group-row"] .group-title').allTextContents()
  assert(
    titles.some((t) => t.includes('Grip card layout and wording')),
    `group titles: ${JSON.stringify(titles)}`
  )
  const agent = page.locator('[data-testid="agent-row"][data-agent-name="icon-agent"]')
  await agent.waitFor({ timeout: 15_000 })
  const toggle = page.locator('nav.agent-list .agent-block').filter({ has: agent }).locator('[data-testid="agent-toggle"]')
  if ((await toggle.count()) > 0 && (await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await page.waitForSelector('[data-testid="chat-row"]', { timeout: 10_000 })
  const single = page.locator('[data-testid="chat-row"][data-chat-id="single-shot-icon"]')
  await single.waitFor({ timeout: 10_000 })
  assert((await single.textContent()).includes('Icon ideas'), 'single chat title is not "Icon ideas"')
  const singles = 1
  ok(`migration: ${groups} group chats and ${singles} single chat in the sidebar`)

  // Real app server has already scrubbed ELECTRON_RUN_AS_NODE; version detection must still fork Node workers.
  await single.click()
  if (!(await page.getByTestId('side-menu').isVisible())) await page.getByTestId('side-panel-toggle').click()
  await page.getByTestId('side-open-browser').click()
  await page.waitForFunction(() => document.querySelector('canvas')?.width > 0, { timeout: 15_000 })
  assert(!(await page.getByRole('switch', { name: 'Take control' }).isChecked()), 'browser starts with control enabled')
  const profiles = JSON.parse(await readFile(join(dataDir, 'browsers/profiles.json'), 'utf8'))
  // The viewer's size now follows the panel, so the owner file (written once Chromium is up) marks the launch.
  const ownerFile = join(dataDir, 'browsers', profiles.profiles['icon-agent'], '.zumibot-browser-owner.json')
  let owner = null
  for (let i = 0; i < 200 && !(owner?.processes?.length > 0); i++) {
    owner = JSON.parse((await readFile(ownerFile, 'utf8').catch(() => 'null')) || 'null')
    if (!(owner?.processes?.length > 0)) await new Promise((r) => setTimeout(r, 100))
  }
  assert(owner, 'browser owner file never appeared')
  browserProcesses = [owner.worker, ...owner.processes]
  assert(browserProcesses.length > 1, 'browser process ownership missing')
  await page.getByRole('button', { name: 'Close browser', exact: true }).click()
  ok('production Local server launches sandboxed browser through Electron Node after environment scrubbing')

  // Settings: local mode has no login, so no Account section, but the shell's Switch server under Sync & server.
  await page.locator('[data-testid="settings-open"]').click()
  await page.locator('[data-testid="settings-nav-sync"]').click()
  await page.locator('[data-testid="switch-server"]').waitFor({ timeout: 10_000 })
  assert((await page.locator('[data-testid="settings-nav-account"]').count()) === 0, 'Account section shown in local mode')
  assert((await page.getByText(/sign out/i).count()) === 0, 'Sign out shown in local mode')
  ok('Settings: "Switch server…" present, no Account section or "Sign out"')

  // The island: a second window with its own page, on top of every workspace, never taking focus.
  const islandPage = await waitForWindow(app, (p) => isIsland(p.url()))
  const islandAgent = islandPage.locator('[data-testid="island-agent"][data-agent-name="icon-agent"]')
  await islandAgent.waitFor({ timeout: 20_000 })
  const readFlags = () =>
    app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => /^https?:\/\/[^/]+\/island$/.test(x.webContents.getURL()))
      return { top: w.isAlwaysOnTop(), all: w.isVisibleOnAllWorkspaces(), shown: w.isVisible(), focused: w.isFocused() }
    })
  // The window manager confirms "sticky" asynchronously after the window is mapped, so give it a moment.
  await waitUntil(async () => (await readFlags()).all, 10_000, 'the window manager to make the island sticky').catch(() => {})
  const flags = await readFlags()
  assert(flags.top && flags.all && flags.shown && !flags.focused, `island flags ${JSON.stringify(flags)}`)
  if ((await x11Workspace(app, env)) !== null) {
    // The window manager takes the every-workspace state a moment after the window is mapped.
    let seen = null
    await waitUntil(
      async () => ((seen = await x11Workspace(app, env)), seen?.endsWith('= 4294967295')),
      10_000,
      'the window manager to put the island on every workspace'
    ).catch(() => {})
    assert(seen?.endsWith('= 4294967295'), `island _NET_WM_DESKTOP is not "all workspaces": ${seen}`)
    // Not skip-taskbar, the dock counts the island as the app's window and the Super overview and Alt+Tab list it.
    let state = null
    await waitUntil(
      async () => ((state = await x11IslandProp(app, env, '_NET_WM_STATE')), state?.includes('_NET_WM_STATE_SKIP_TASKBAR')),
      10_000,
      'the window manager to keep the island off the taskbar'
    ).catch(() => {})
    assert(state?.includes('_NET_WM_STATE_SKIP_TASKBAR'), `island _NET_WM_STATE lacks skip taskbar: ${state}`)
    // Filed under ZumiBot's own entry, the island was the app's only window once the main window was hidden, and a
    // dock click activated it instead of launching the second instance that shows the main window.
    const islandClass = await x11IslandProp(app, env, 'WM_CLASS')
    assert(islandClass === 'WM_CLASS(STRING) = "zumibot-island", "zumibot-island"', `island WM_CLASS: ${islandClass}`)
    const mainClass = await x11IslandProp(app, env, 'WM_CLASS', false)
    assert(mainClass === 'WM_CLASS(STRING) = "zumibot", "zumibot"', `main window WM_CLASS: ${mainClass}`)
  }
  // The window is the work area's full-height column, strip + popup wide; what the user sees and can click is its X shape:
  // the strip alone while closed.
  const shapeNow = await x11Shape(app, env)
  if (shapeNow === undefined) console.log('NOTE xwininfo or X11 not available: the island shape check is skipped')
  else {
    const strip = { width: 58 } // STRIP_WIDTH in islandLayout.ts
    let seen = null
    await waitUntil(
      async () => ((seen = await x11Shape(app, env)), seen?.width === strip.width),
      10_000,
      'the island shape to be the strip'
    ).catch(() => {})
    assert(seen?.width === strip.width, `closed island shape is ${JSON.stringify(seen)}, not the ${strip.width}px strip`)
  }
  // A drag of the strip's background: the page slides the strip, the window never moves (Mutter applied each move of it up
  // to a second late on a real desktop), and the shell saves where the strip ended.
  const islandWinBounds = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((x) => /^https?:\/\/[^/]+\/island$/.test(x.webContents.getURL()))
        .getBounds()
    )
  const winBefore = await islandWinBounds()
  const stripBox = await islandPage.locator('[data-testid="island-strip"]').boundingBox()
  const grab = { x: stripBox.x + stripBox.width / 2, y: stripBox.y + 26 } // the pill's padding above the first icon
  await islandPage.mouse.move(grab.x, grab.y)
  await islandPage.mouse.down()
  await islandPage.mouse.move(grab.x, grab.y + 120, { steps: 12 })
  await islandPage.mouse.up()
  let savedTop = null
  await waitUntil(
    async () => ((savedTop = JSON.parse(await readFile(join(userData, 'island.json'), 'utf8')).top), savedTop !== null),
    10_000,
    'the island to save the dragged top'
  ).catch(() => {})
  const slidBox = await islandPage.locator('[data-testid="island-strip"]').boundingBox()
  const winAfter = await islandWinBounds()
  assert(
    JSON.stringify(winAfter) === JSON.stringify(winBefore),
    `the island window moved in a drag: ${JSON.stringify(winBefore)} -> ${JSON.stringify(winAfter)}`
  )
  assert(Math.round(slidBox.y - stripBox.y) === 120, `the strip slid ${slidBox.y - stripBox.y}px, not 120`)
  assert(savedTop === winBefore.y + slidBox.y, `island.json top is ${savedTop}, not the strip's ${winBefore.y + slidBox.y}`)
  ok('island drag: the page slides the strip, the window stays put, the shell saves the new top')
  await islandAgent.click()
  await islandPage.locator('[data-testid="island-popup"]').waitFor()
  if (shapeNow !== undefined) {
    let seen = null
    await waitUntil(
      async () => ((seen = await x11Shape(app, env)), (seen?.width ?? 0) > 58),
      10_000,
      'the island shape to widen for the popup'
    ).catch(() => {})
    assert((seen?.width ?? 0) > 58, `open island shape is ${JSON.stringify(seen)}, not wider than the strip`)
  }
  await waitUntil(
    async () => ((await islandPage.locator('[data-testid="island-title"]').textContent()) ?? '').includes('Icon ideas'),
    20_000,
    'the popup to show the agent chat'
  )
  await islandPage.locator('[data-testid="island-popup"] [contenteditable="true"]').click()
  await islandPage.keyboard.type('/')
  await islandPage.keyboard.press('Escape')
  assert(await islandPage.locator('[data-testid="island-popup"]').isVisible(), 'Esc in the / menu closed the popup')
  await islandPage.keyboard.press('Escape')
  await islandPage.locator('[data-testid="island-popup"]').waitFor({ state: 'detached' })
  ok(
    'island: on top, every workspace, no focus taken, X shape strip-wide then wider; popup opens the agent chat; Esc closes the menu, then the popup'
  )
  // Settings: unticking the only agent removes the island; ticking brings it back.
  await page.locator('[data-testid="settings-nav-island"]').click()
  const pick = page.locator('[data-testid="island-pick"][data-agent-name="icon-agent"] input')
  // The box is controlled and follows the shell's answer, so click and wait instead of uncheck()/check(), which judge it at once.
  await pick.click()
  await waitUntil(async () => !(await pick.isChecked()), 10_000, 'the box to untick')
  await waitUntil(async () => (await islandWindows(app)) === 0, 20_000, 'the island window to go')
  await waitUntil(() => pick.isEnabled(), 10_000, 'the box to unlock')
  await pick.click()
  await waitUntil(() => pick.isChecked(), 10_000, 'the box to tick')
  await waitForWindow(app, (p) => isIsland(p.url()))
  ok('Settings › Island & startup adds and removes the island')

  // Closing the window hides it: app and server stay (tray). Maximized first, so the reopen below must keep that.
  const mainState = () =>
    app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !/^https?:\/\/[^/]+\/island$/.test(x.webContents.getURL()))
      return w ? { visible: w.isVisible(), maximized: w.isMaximized(), bounds: w.getBounds() } : null
    })
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => !/^https?:\/\/[^/]+\/island$/.test(w.webContents.getURL()))
      ?.maximize()
  )
  await waitUntil(async () => (await mainState())?.maximized, 10_000, 'the main window to maximize')
  await sleep(1000) // the window manager settles the maximized size
  const maximized = await mainState()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => !/^https?:\/\/[^/]+\/island$/.test(w.webContents.getURL()))
      ?.close()
  )
  await new Promise((r) => setTimeout(r, 1000))
  assert(alive(electronPid) && alive(serverPid), 'closing the main window ended the app')
  assert(
    !(await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((w) => !/^https?:\/\/[^/]+\/island$/.test(w.webContents.getURL()) && w.isVisible())
    )),
    'main window still visible after close'
  )
  ok('closing the main window hides it; app and server keep running')
  // The dock icon's second launch reaches the running app as second-instance: the window comes back maximized, at the
  // size it had. The window manager drops _NET_WM_STATE when a window is withdrawn, so a plain show() came back normal.
  await app.evaluate(({ app: a }) => a.emit('second-instance', {}, [process.execPath], process.cwd()))
  await waitUntil(async () => (await mainState())?.visible, 10_000, 'the main window to come back')
  let reopened = null
  await waitUntil(
    async () => (
      (reopened = await mainState()),
      reopened?.maximized && JSON.stringify(reopened.bounds) === JSON.stringify(maximized.bounds)
    ),
    10_000,
    'the main window to come back maximized'
  ).catch(() => {})
  assert(
    reopened?.maximized && JSON.stringify(reopened.bounds) === JSON.stringify(maximized.bounds),
    `reopened ${JSON.stringify(reopened)}, closed maximized at ${JSON.stringify(maximized.bounds)}`
  )
  ok('a second launch shows the hidden main window maximized, at its size')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => !/^https?:\/\/[^/]+\/island$/.test(w.webContents.getURL()))
      ?.close()
  )
  await waitUntil(async () => !(await mainState())?.visible, 10_000, 'the main window to hide again')
  // Autostart: packaged writes the entry, unpacked never does.
  const entry = await readFile(join(xdgConfig, 'autostart/zumibot.desktop'), 'utf8').catch(() => null)
  assert(exe ? entry?.includes(' --hidden') : entry === null, `autostart entry: ${entry}`)
  ok('start at login entry matches the build kind')
  // Quit ends everything.
  const exited = new Promise((resolve) => app.process().once('exit', resolve))
  await app.evaluate(({ app: a }) => a.quit())
  await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('Electron did not exit after Quit')), 20_000))])
  for (let i = 0; i < 100 && alive(serverPid); i++) await new Promise((r) => setTimeout(r, 100))
  assert(!alive(serverPid), `server pid ${serverPid} still alive after Quit`)
  for (const owned of browserProcesses) {
    const stat = await readFile(`/proc/${owned.pid}/stat`, 'utf8').catch(() => '')
    assert(!stat || stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] === 'Z', `owned browser process ${owned.pid} survived shutdown`)
  }
  ok('Quit ended Electron, server, worker and Chromium processes')

  // The old app's data is only read: every fixture file is byte-identical.
  const after = await hashTree(userData)
  for (const [f, h] of Object.entries(before)) assert(after[f] === h, `fixture file changed or removed: ${f}`)
  ok(`${Object.keys(before).length} fixture files byte-identical`)
  // Started by the login entry (--hidden): the server comes up and the main window loads, but is never shown.
  errors.length = 0
  serverPid = null
  app = await _electron.launch({ ...launchOpts, args: [...launchOpts.args, '--hidden'], env, timeout: 30_000 })
  electronPid = app.process().pid
  app.process().stderr?.on('data', (d) => errors.push(String(d).trim()))
  let hidden = null
  for (let i = 0; i < 400 && !hidden; i++) {
    for (const k of await childPids(electronPid)) {
      if ((await readFile(`/proc/${k}/cmdline`, 'utf8').catch(() => '')).includes('server.mjs')) serverPid = k
    }
    const state = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !/^https?:\/\/[^/]+\/island$/.test(x.webContents.getURL()))
      return w ? { url: w.webContents.getURL(), visible: w.isVisible(), loading: w.webContents.isLoading() } : null
    })
    if (serverPid && state && state.url.startsWith('http://127.0.0.1:') && !state.loading) hidden = state
    else await new Promise((r) => setTimeout(r, 100))
  }
  assert(hidden, 'hidden start: the main window never loaded the local server')
  await new Promise((r) => setTimeout(r, 1500)) // a painted window would have been shown by now
  assert(
    !(await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((x) => !/^https?:\/\/[^/]+\/island$/.test(x.webContents.getURL()) && x.isVisible())
    )),
    'hidden start showed the main window'
  )
  ok('--hidden: server up, main window loaded the origin and stays hidden')
  // The island is the point of a login start: it shows by itself while the main window stays hidden.
  await waitUntil(
    () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().some((x) => /^https?:\/\/[^/]+\/island$/.test(x.webContents.getURL()) && x.isVisible())
      ),
    30_000,
    'the island to show on a hidden start'
  )
  ok('--hidden: the island is visible')
  const exited2 = new Promise((resolve) => app.process().once('exit', resolve))
  await app.evaluate(({ app: a }) => a.quit())
  await Promise.race([
    exited2,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Electron did not exit after Quit (hidden start)')), 20_000))
  ])
  for (let i = 0; i < 100 && alive(serverPid); i++) await new Promise((r) => setTimeout(r, 100))
  assert(!alive(serverPid), `server pid ${serverPid} still alive after Quit (hidden start)`)
  ok('Quit from a hidden start ended Electron and the server')

  // Chromium logs once that the island's window type atom is not in its cache; the type is set all the same (the skip
  // taskbar check above rests on it). Lines, not chunks, so a real error sharing a chunk with it still counts.
  const atomNotCached = /ERROR:ui\/gfx\/x\/atom_cache\.cc:\d+\] Add _NET_WM_WINDOW_TYPE_TOOLBAR to kAtomsToCache$/
  const bad = errors.flatMap((e) => e.split('\n')).filter((e) => /error|exception/i.test(e) && !atomNotCached.test(e.trim()))
  assert(bad.length === 0, `main stderr: ${bad.join(' | ')}`)
  console.log('E2E PASS')
} catch (err) {
  console.error(`E2E FAIL: ${err.message}`)
  console.error('Main diagnostics:', errors.join(' | '))
  const window = await app?.firstWindow().catch(() => null)
  if (window)
    console.error(
      'Window diagnostics:',
      window.url(),
      await window
        .locator('body')
        .innerText({ timeout: 2000 })
        .catch(() => 'unreadable')
    )
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  // A close that hangs must not leak the X session: cleanup SIGKILLs Electron if it is still there.
  // unref: a quick close must not keep the process alive for the rest of the 10 s.
  await Promise.race([app?.close().catch(() => {}), new Promise((r) => setTimeout(r, 10_000).unref())])
  await cleanup()
}
