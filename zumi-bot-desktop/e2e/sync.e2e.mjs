// Built desktop sync smoke test. All homes, data, SSH commands and sudo are temporary fixtures.
// Run after npm run build: node zumi-bot-desktop/e2e/sync.e2e.mjs
// Its windows and tray open on a throwaway X display with its own session bus and window manager (throwawayDisplay.mjs),
// never on the developer's desktop; ZUMIBOT_E2E_REAL_DISPLAY=1 opts in to the inherited display and bus.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access, stat, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { _electron, chromium } from 'playwright-core'
import { keyIdOf, openItem, sealItem } from '../../zumi-bot-server/deploy/vaultSync.mjs'
import { startThrowawayDisplay } from './throwawayDisplay.mjs'

const root = await mkdtemp(join(tmpdir(), 'zumibot-sync-e2e-'))
const home = join(root, 'home'),
  remote = join(root, 'remote'),
  bin = join(root, 'bin')
const userData = join(root, 'config/ZumiBot')
const data = join(home, '.local/share/zumibot')
// Test keys made here only: the PC key path is passed to the app (and from it to the sync worker), the VPS one is the
// default under the fixture's remote HOME. Nothing touches the real ~/.config/zumibot-vault.
const pcKey = join(root, 'pc-vault/vault.key'),
  vpsKey = join(remote, '.config/zumibot-vault/vault.key')
const pcVault = join(data, 'vault.json'),
  vpsVault = join(remote, '.local/share/zumibot/vault.json')
let app, browser
let session = null // the throwaway X session, unless ZUMIBOT_E2E_REAL_DISPLAY=1
// process() throws once the app is closed, and then there is nothing left to kill.
const killApp = () => {
  try {
    app?.process().kill('SIGKILL')
  } catch {}
}
const stopSession = async () => {
  await session?.stop().catch(() => {})
  session = null
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    console.error(`FAIL ${sig}`)
    killApp()
    Promise.all([stopSession(), rm(root, { recursive: true, force: true }).catch(() => {})]).finally(() => process.exit(1))
  })
}
const put = async (file, text, executable = false) => {
  await mkdir(resolve(file, '..'), { recursive: true })
  await writeFile(file, text, executable ? { mode: 0o755 } : undefined)
}
const until = async (predicate) => {
  const end = Date.now() + 20000
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error('Timed out waiting for sync')
    await new Promise((r) => setTimeout(r, 100))
  }
}

try {
  await mkdir(userData, { recursive: true })
  await mkdir(data, { recursive: true })
  await put(join(remote, '.local/share/zumibot/chats.json'), '{"chats":[]}')
  await put(join(remote, '.local/share/zumibot/chats/placeholder'), '')
  await put(join(remote, '.claude/agents/remote.md'), '---\nname: remote\ndescription: Synced fixture\n---\nFixture.')
  await put(join(home, '.claude/agents/local.md'), '---\nname: local\ndescription: Local fixture\n---\nFixture.')
  await put(join(remote, 'busy'), '0\n')
  await put(join(remote, 'zumibot/bin/zumibot-server'), `#!/bin/sh\ncat '${remote}/busy'\n`, true)
  await put(join(bin, 'sudo'), '#!/bin/sh\nexit 0\n', true)
  await put(join(bin, 'claude'), '#!/bin/sh\nexit 1\n', true)
  // Never contact a network host: run remote shell commands only under this fixture's HOME.
  await put(
    join(bin, 'ssh'),
    `#!${process.execPath}
import { spawnSync } from 'node:child_process'; import { existsSync } from 'node:fs';
if (process.argv.at(-2) !== 'bot@vps.test') process.exit(91);
if (existsSync(${JSON.stringify(join(root, 'fail'))})) { console.error('Fixture SSH unavailable'); process.exitCode = 255; }
else {
 if (existsSync(${JSON.stringify(join(root, 'slow'))})) await new Promise(r => setTimeout(r, 1200));
 const r = spawnSync('/bin/bash', ['-c', process.argv.at(-1)], {env:{...process.env, HOME:${JSON.stringify(remote)}}, stdio:'inherit'}); process.exitCode = r.status ?? 1;
}
`,
    true
  )
  await put(
    join(bin, 'rsync'),
    `#!${process.execPath}
import { spawnSync } from 'node:child_process'; import { join } from 'node:path';
const args=[]; const input=process.argv.slice(2);
for(let i=0;i<input.length;i++){if(input[i]==='-e'){i++;continue}const s=input[i];const p='bot@vps.test:';const r=s.startsWith(p)?s.slice(p.length):null;args.push(r===null?s:r.startsWith('/')?r:join(${JSON.stringify(remote)},r)+(r.endsWith('/')?'/':''))}
process.exitCode=spawnSync('/usr/bin/rsync',args,{stdio:'inherit'}).status??1;
`,
    true
  )
  const probe = createServer()
  await new Promise((r) => probe.listen(0, '127.0.0.1', r))
  const port = probe.address().port
  await new Promise((r) => probe.close(r))
  await put(join(userData, 'server.json'), JSON.stringify({ kind: 'local', port }))
  await put(join(userData, 'sync.env'), `VPS_HOST=vps.test\nVPS_USER=bot\nVPS_DIR=${remote}/zumibot\n`)
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(root, 'config'), PATH: `${bin}:${process.env.PATH}` }
  for (const key of Object.keys(env))
    if (key.startsWith('ZUMIBOT_') || key === 'ELECTRON_RUN_AS_NODE' || key === 'XDG_DATA_HOME') delete env[key]
  env.ZUMIBOT_VAULT_KEY_FILE = pcKey
  if (process.env.ZUMIBOT_E2E_REAL_DISPLAY === '1') {
    console.warn('WARNING ZUMIBOT_E2E_REAL_DISPLAY=1: the windows open on your real desktop and its session bus')
  } else {
    // Own display, own session bus (the tray registers on it), own window manager: the real desktop never sees these windows.
    session = await startThrowawayDisplay(root, { avoid: process.env.DISPLAY })
    Object.assign(env, session.env)
    for (const k of ['WAYLAND_DISPLAY', 'XAUTHORITY', 'SESSION_MANAGER', 'GDK_BACKEND', 'ELECTRON_OZONE_PLATFORM_HINT']) delete env[k]
    console.log(`PASS throwaway X display ${session.display} with its own session bus and window manager (real desktop untouched)`)
  }
  const packaged = process.env.ZUMIBOT_SYNC_E2E_EXECUTABLE
  const launch = (extra = []) =>
    _electron.launch({
      ...(packaged ? { executablePath: packaged, args: extra } : { args: [resolve('zumi-bot-desktop'), ...extra] }),
      env,
      timeout: 30000
    })
  app = await launch()
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="sidebar-user"]', { timeout: 30000 })
  await page.click('[data-testid="settings-open"]')
  await page.click('[data-testid="settings-nav-sync"]')
  const opened = app.waitForEvent('window')
  await page.click('[data-testid="sync"]')
  const progress = await opened
  await progress.waitForSelector('#start')
  assert.match(await progress.locator('#target').innerText(), /bot@vps.test/)
  assert.equal(await progress.evaluate(() => typeof window.zumibotDesktop), 'undefined')
  assert.equal(await page.evaluate(() => typeof window.zumibotSync), 'undefined')

  await put(join(root, 'slow'), '')
  await progress.click('#start')
  await until(() => progress.evaluate(async () => (await window.zumibotSync.status()).active))
  await app.evaluate(({ app, BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().endsWith('/sync.html'))
      .close()
    app.quit()
  })
  assert.equal(progress.isClosed(), false)
  await page.evaluate(() => window.zumibotDesktop.switchServer())
  assert.match(page.url(), /^http:/)
  await rm(join(root, 'slow'))
  await until(() => progress.evaluate(async () => !(await window.zumibotSync.status()).active))
  assert.match(await progress.locator('#log').innerText(), /Sync complete/)
  await page.waitForSelector('[data-testid="sidebar-user"]')
  await access(join(home, '.claude/agents/remote.md'))
  await access(join(remote, '.claude/agents/local.md'))
  console.log('PASS sync, backup progress, main-window guards, worker resources, and local reconnection')

  // The vault: items sealed with test keys, checked by opening them, never through the app's own code.
  const lines = () => progress.evaluate(async () => (await window.zumibotSync.status()).lines)
  const ended = (l) => /^Sync (complete|failed)|reconnecting failed/.test(l)
  const syncAgain = async () => {
    const before = (await lines()).filter(ended).length
    await progress.click('#start')
    await until(async () => (await lines()).filter(ended).length > before)
    await until(() => progress.evaluate(async () => !(await window.zumibotSync.status()).active))
    const all = await lines()
    assert.equal(all.filter(ended).at(-1), 'Sync complete.')
    return all
  }
  const body = (id, updatedAt) => ({ id, updatedAt, kind: 'login', name: id, agents: [], password: `pw-${id}-secret` })
  const live = (key, id, updatedAt) => ({ id, updatedAt, deleted: false, sealed: sealItem(key, id, updatedAt, body(id, updatedAt)) })
  const putKey = async (file, key) => {
    await put(file, `${key.toString('base64')}\n`)
    await chmod(file, 0o600)
  }
  const keyText = async (file) => (await readFile(file, 'utf8')).trim()
  const opensWith = async (file, key, ids) => {
    const v = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(v.keyId, keyIdOf(key))
    assert.deepEqual(v.items.map((i) => i.id).sort(), [...ids].sort())
    for (const i of v.items) assert.deepEqual(openItem(key, i), body(i.id, i.updatedAt))
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  }
  const K0 = randomBytes(32),
    K1 = randomBytes(32),
    K2 = randomBytes(32)

  // A key only this PC has goes to the VPS through ssh's stdin.
  await putKey(pcKey, K0)
  await put(pcVault, JSON.stringify({ v: 1, keyId: keyIdOf(K0), items: [live(K0, 'pc-first', 5)] }))
  assert.ok((await syncAgain()).includes('Vault key copied from this PC to the VPS.'))
  assert.equal(await keyText(vpsKey), K0.toString('base64'))
  assert.equal((await stat(vpsKey)).mode & 0o777, 0o600)
  assert.equal((await stat(dirname(vpsKey))).mode & 0o777, 0o700)
  await opensWith(vpsVault, K0, ['pc-first'])
  console.log('PASS a vault key only on this PC reaches the VPS over ssh stdin')

  // A key only on the VPS home is copied to this PC (a fresh PC: no key, no vault).
  await rm(dirname(pcKey), { recursive: true })
  await rm(pcVault)
  await rm(dirname(vpsKey), { recursive: true })
  await putKey(vpsKey, K1)
  await put(vpsVault, JSON.stringify({ v: 1, keyId: keyIdOf(K1), items: [live(K1, 'vps-login', 10)] }))
  assert.ok((await syncAgain()).includes('Vault key copied from the VPS to this PC.'))
  assert.equal(await keyText(pcKey), K1.toString('base64'))
  assert.equal((await stat(pcKey)).mode & 0o777, 0o600)
  assert.equal((await stat(dirname(pcKey))).mode & 0o777, 0o700)
  for (const f of [pcVault, vpsVault]) await opensWith(f, K1, ['vps-login'])
  console.log('PASS a vault key only on the VPS is copied to this PC')

  // Different keys: the VPS key wins, this PC's items are sealed again with it, the old key is kept beside it.
  await rm(pcKey)
  await putKey(pcKey, K2)
  await put(pcVault, JSON.stringify({ v: 1, keyId: keyIdOf(K2), items: [live(K2, 'pc-login', 20)] }))
  assert.ok((await syncAgain()).some((l) => l.startsWith("This PC's vault used another key: its items are now sealed with the VPS key.")))
  assert.equal(await keyText(pcKey), K1.toString('base64'))
  assert.equal(await keyText(vpsKey), K1.toString('base64'))
  const kept = (await readdir(dirname(pcKey))).filter((f) => f.startsWith('vault.key.replaced-'))
  assert.equal(kept.length, 1)
  assert.equal(await keyText(join(dirname(pcKey), kept[0])), K2.toString('base64'))
  assert.equal((await stat(join(dirname(pcKey), kept[0]))).mode & 0o777, 0o600)
  for (const f of [pcVault, vpsVault]) await opensWith(f, K1, ['pc-login', 'vps-login'])
  console.log("PASS different keys: this PC's items are re-sealed under the VPS key and both sides open the joined vault")

  // No key, in any spelling the sync handles it in, reaches the log, the window or a backup folder.
  const shown = (await lines()).join('\n') + (await progress.locator('#log').innerText())
  const stored = []
  for (const dir of [home, remote])
    for (const b of (await readdir(dir)).filter((n) => n.startsWith('zumibot-sync-backup-'))) {
      for (const e of await readdir(join(dir, b), { recursive: true, withFileTypes: true }))
        if (e.isFile()) stored.push(await readFile(join(e.parentPath, e.name), 'latin1'))
    }
  assert.ok(stored.length > 0)
  for (const k of [K0, K1, K2])
    for (const f of [
      k.toString('base64'),
      k.toString('hex'),
      Buffer.from(`${k.toString('base64')}\n`)
        .toString('base64')
        .slice(0, 40)
    ]) {
      assert.ok(!shown.includes(f), 'a vault key reached the sync log')
      assert.ok(!stored.some((s) => s.includes(f)), 'a vault key reached a backup folder')
    }
  console.log('PASS the vault key never appears in the sync log or a backup')

  await put(join(root, 'fail'), '')
  await progress.click('#start')
  await until(async () => (await progress.locator('#log').innerText()).includes('Fixture SSH unavailable'))
  await until(() => progress.evaluate(async () => !(await window.zumibotSync.status()).active))
  assert.match(await progress.locator('#log').innerText(), /Sync failed/)
  await page.waitForSelector('[data-testid="sidebar-user"]')
  await progress.click('#close')
  console.log('PASS SSH failure is visible and local server recovers')

  // A normal browser receives only the fixed handoff link, with useful instructions if no helper is installed.
  browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', headless: true })
  const context = await browser.newContext()
  const cookies = await app.evaluate(async ({ session }) => session.defaultSession.cookies.get({ name: 'cb_local' }))
  await context.addCookies(cookies.map((c) => ({ name: c.name, value: c.value, url: page.url() })))
  const tab = await context.newPage()
  await tab.goto(page.url())
  await tab.click('[data-testid="settings-open"]')
  await tab.click('[data-testid="settings-nav-sync"]')
  assert.equal(await tab.locator('[data-testid="sync-open-desktop"]').getAttribute('href'), 'zumibot://sync')
  assert.match(await tab.locator('[data-testid="settings-sync"]').innerText(), /desktop app on this PC/)
  console.log('PASS browser handoff UI')

  // Model the OS delivering the registered URL; opening alone must never start a sync.
  await app.evaluate(({ app }) => app.emit('second-instance', {}, ['zumibot', 'zumibot://sync']))
  await until(async () => app.windows().some((w) => w.url().endsWith('/sync.html')))
  const external = app.windows().find((w) => w.url().endsWith('/sync.html'))
  assert.equal(await external.evaluate(async () => (await window.zumibotSync.status()).active), false)
  await app.evaluate(({ dialog }) => {
    globalThis.syncPrompts = 0
    dialog.showMessageBox = async () => {
      globalThis.syncPrompts++
      return { response: 0 }
    }
  })
  await external.click('#start')
  await until(async () => (await app.evaluate(() => globalThis.syncPrompts)) === 1)
  await until(() => external.evaluate(async () => !(await window.zumibotSync.status()).active))
  assert.match(await external.locator('#log').innerText(), /Sync cancelled/)
  await external.click('#close')
  console.log('PASS browser protocol handoff requires native confirmation')

  // Cold start: the OS launches the app with the URL, so the sync window opens before the main window is shown.
  // While the sync window is open the main window refuses to close, so quit only once it is really gone.
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1))
  await app.close()
  app = await launch(['zumibot://sync'])
  await until(async () => app.windows().some((w) => w.url().endsWith('/sync.html')))
  const cold = app.windows().find((w) => w.url().endsWith('/sync.html'))
  await cold.waitForSelector('#start')
  assert.match(await cold.locator('#target').innerText(), /bot@vps.test/)
  await until(() =>
    app.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 2 && BrowserWindow.getAllWindows().every((w) => w.isVisible())
    )
  )
  await app.evaluate(({ dialog }) => {
    globalThis.syncPrompts = 0
    dialog.showMessageBox = async () => {
      globalThis.syncPrompts++
      return { response: 0 }
    }
  })
  await cold.click('#start')
  await until(async () => (await app.evaluate(() => globalThis.syncPrompts)) === 1)
  await until(() => cold.evaluate(async () => !(await window.zumibotSync.status()).active))
  assert.match(await cold.locator('#log').innerText(), /Sync cancelled/)
  await cold.click('#close')
  console.log('PASS cold start from the browser link shows both windows and asks first')

  // A browser request while the picker is up (after Switch server) syncs without reconnecting behind the user's back.
  await rm(join(root, 'fail'))
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1))
  const main = app.windows().find((w) => !w.url().endsWith('/sync.html'))
  await main.waitForSelector('[data-testid="sidebar-user"]')
  await main.evaluate(() => window.zumibotDesktop.switchServer())
  await until(async () => main.url().endsWith('/picker.html'))
  await app.evaluate(({ app, dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
    app.emit('second-instance', {}, ['zumibot', 'zumibot://sync'])
  })
  await until(async () => app.windows().some((w) => w.url().endsWith('/sync.html')))
  const fromPicker = app.windows().find((w) => w.url().endsWith('/sync.html'))
  await fromPicker.waitForSelector('#start')
  await fromPicker.click('#start')
  await until(async () => /Sync (complete|failed)|reconnecting failed/.test(await fromPicker.locator('#log').innerText()))
  assert.match(await fromPicker.locator('#log').innerText(), /Sync complete/)
  assert.match(main.url(), /\/picker\.html$/)
  await fromPicker.click('#close')
  console.log('PASS sync from the picker leaves the picker in place')

  // Local start failed at launch: reconnecting replaces the error page's window, and the sync window must survive it.
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1))
  await app.close()
  const blocker = createServer((socket) => socket.destroy()) // close() would wait for any probe left open
  await new Promise((r) => blocker.listen(port, '127.0.0.1', r))
  app = await launch(['zumibot://sync'])
  await until(async () => app.windows().some((w) => w.url().endsWith('/sync.html')))
  await until(async () => app.windows().some((w) => w.url().endsWith('/error.html')))
  const afterError = app.windows().find((w) => w.url().endsWith('/sync.html'))
  await afterError.waitForSelector('#start')
  await new Promise((r) => blocker.close(r))
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1 })
  })
  await afterError.click('#start')
  await until(async () => /Sync (complete|failed)|reconnecting failed/.test(await afterError.locator('#log').innerText()))
  assert.match(await afterError.locator('#log').innerText(), /Sync complete/)
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 2))
  await app
    .windows()
    .find((w) => w.url().startsWith('http:'))
    .waitForSelector('[data-testid="sidebar-user"]')
  await afterError.click('#close')
  console.log('PASS sync over a failed local start keeps its window and reconnects')

  // An unusable deploy.env reads as a failure, not as a cancel, and never reaches ssh.
  await until(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1))
  await put(join(userData, 'sync.env'), 'VPS_HOST=bad;host\nVPS_USER=bot\n')
  const bad = join(root, 'bad.env')
  await put(bad, 'VPS_HOST=-oProxyCommand=evil\nVPS_USER=bot\n')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, bad)
  const reopened = app.waitForEvent('window')
  await app
    .windows()
    .find((w) => w.url().startsWith('http:'))
    .evaluate(() => window.zumibotDesktop.sync())
  const badSync = await reopened
  await badSync.waitForSelector('#start')
  await badSync.click('#start')
  await until(async () => /Sync failed/.test(await badSync.locator('#status').innerText()))
  assert.match(await badSync.locator('#status').innerText(), /^Sync failed: Choose a deploy\.env/)
  await badSync.click('#close')
  console.log('PASS an unusable deploy.env reads as a failure')
} finally {
  try {
    await browser?.close().catch(() => {})
    // A failed step can leave the sync window open, and the main window refuses to close while it is.
    await app
      ?.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().endsWith('/sync.html')) w.destroy()
      })
      .catch(() => {})
    // A close that hangs must not leak the X session: Electron is killed after 10 s.
    await Promise.race([app?.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000).unref())])
    killApp()
  } finally {
    await stopSession()
    await rm(root, { recursive: true, force: true })
  }
}
