// End-to-end check of the built-in zumi-bot in the built server + web UI (local mode, fake claude: no CLI turn is
// ever sent, so nothing real runs; step 6 sends one message to the fake claude). Ported from the old Electron app's e2e suite.
// Usage: npm run e2e:zumi-bot   (builds first)
// Only the three mkdtemp dirs created here (plus the harness's own temp root) are ever deleted.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from './harness.mjs'

const PREFIX = 'zumibot-e2e-cb-'
const SHOTS = fileURLToPath(new URL('./screenshots', import.meta.url))
const CB = 'zumi-bot'
const OLD = 'bot-father-agent' // the built-in's name before Zumi Bot

let userData = null
let agentsDir = null
let pickDir = null
let current = null
const t0 = Date.now()
let okCount = 0

const ok = (m) => {
  okCount++
  console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
}
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const row = (page, name) => page.locator(`[data-testid="agent-row"][data-agent-name="${name}"]`)
const agentFile = (name, body = 'You are a test agent.') =>
  `---\nname: ${name}\ndescription: Nested e2e agent.\nmodel: haiku\n---\n${body}\n`

async function waitFor(fn, timeout, what) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}`)
}

async function stop() {
  if (!current) return
  const { stop: stopHarness, server } = current
  const pid = server.pid
  current = null
  await Promise.race([stopHarness().catch(() => {}), sleep(30_000)])
  try {
    process.kill(pid, 0)
    process.kill(pid, 'SIGKILL')
  } catch {
    /* already gone */
  }
}

async function main() {
  userData = await mkdtemp(join(tmpdir(), `${PREFIX}data-`))
  agentsDir = await mkdtemp(join(tmpdir(), `${PREFIX}agents-`))
  pickDir = await mkdtemp(join(tmpdir(), `${PREFIX}pick-`))
  console.log(`userData=${userData} agentsDir=${agentsDir} pick=${pickDir}`)
  const cbFile = join(agentsDir, `${CB}.md`)
  // A data dir from before the rename: the old built-in's file and one chat of it, moved to Zumi Bot at start.
  const oldFile = join(agentsDir, `${OLD}.md`)
  await writeFile(oldFile, agentFile(OLD))
  const oldChat = {
    id: 'old-built-in-chat',
    title: 'Made before the rename',
    agentName: OLD,
    sessionId: null,
    cwd: agentsDir,
    createdAt: 1,
    updatedAt: 1,
    inFlight: false
  }
  await writeFile(join(userData, 'chats.json'), JSON.stringify({ chats: [oldChat] }))

  const started = await start({ mode: 'local', fake: true, dataDir: userData, agentsDir, env: { ZUMIBOT_TEST_PICK_FOLDER: pickDir } })
  current = started
  const page = started.page
  await page.waitForSelector('[data-testid="new-agent"]', { timeout: 30_000 })

  // 1
  const first = page.locator('[data-testid="agent-row"]').first()
  await first.waitFor({ timeout: 15_000 })
  assert(
    (await first.getAttribute('data-agent-name')) === CB,
    `first row is ${await first.getAttribute('data-agent-name')}, expected ${CB}`
  )
  assert((await first.getAttribute('data-built-in')) === 'true', 'first row lacks data-built-in="true"')
  await waitFor(() => existsSync(cbFile), 5_000, `${cbFile} to exist`)
  const original = await readFile(cbFile, 'utf8')
  assert(original.length > 0, 'zumi-bot file is empty')
  ok('1 zumi-bot is the first row, built-in, file written')

  // 2 (pre-rename data)
  const stored = JSON.parse(await readFile(join(userData, 'chats.json'), 'utf8')).chats
  assert(
    stored.find((c) => c.id === oldChat.id)?.agentName === CB,
    `old chat agent is ${stored.find((c) => c.id === oldChat.id)?.agentName}, expected ${CB}`
  )
  assert(!existsSync(oldFile), `${oldFile} is still in the agents folder`)
  assert(existsSync(join(started.root, 'home', '.local', 'share', 'Trash', 'files', `${OLD}.md`)), 'old built-in file is not in the Trash')
  assert((await row(page, OLD).count()) === 0, `a row for ${OLD} is shown`)
  ok('2 old built-in chat moved to zumi-bot, its file in the Trash, no row for it')

  // 3
  await first.hover()
  await page.locator('[data-testid="agent-menu-button"]').first().click()
  await page.locator('[data-testid="agent-menu-new-chat"]').waitFor({ state: 'visible', timeout: 5_000 })
  assert((await page.locator('[data-testid="agent-menu-edit"]').count()) === 0, 'Edit menu item is rendered for built-in agent')
  assert((await page.locator('[data-testid="agent-menu-delete"]').count()) === 0, 'Delete menu item is rendered for built-in agent')
  await page.keyboard.press('Escape')
  ok('3 menu: New chat only (no Edit, no Delete)')

  // 4
  await row(page, CB).click()
  await page.locator('[data-testid="chat-agent"]').waitFor({ timeout: 10_000 })
  assert((await page.locator('[data-testid="chat-folder"]').count()) === 0, 'folder picker shown for built-in agent chat')
  assert(
    (await page.getByRole('button', { name: 'Edit agent', exact: true }).count()) === 0,
    '"Edit agent" button shown for built-in agent'
  )
  const cbBlock = page.locator('nav.agent-list .agent-block').filter({ has: row(page, CB) })
  await cbBlock.locator('[data-testid="chat-row"]').first().waitFor({ timeout: 5_000 })
  assert((await cbBlock.locator('[data-testid="folder"]').count()) === 0, 'built-in agent chats are grouped under a folder in the sidebar')
  ok('4 zumi-bot chat has no folder picker, no Edit agent, chats sit straight under it in the sidebar')

  // 5
  await mkdir(join(agentsDir, 'nested-one'))
  await writeFile(join(agentsDir, 'nested-one', 'nested-one.md'), agentFile('nested-one'))
  await row(page, 'nested-one').waitFor({ timeout: 3_000 })
  ok('5 nested-one appears live')

  // 6
  await row(page, 'nested-one').click()
  // Clicking an agent with no chats opens its start screen (no chat yet): pick the folder and send one message (fake claude)
  await page.locator('[data-testid="new-chat-folder"]').click()
  await page.locator('[data-testid="new-chat-choose-folder"]').click()
  await page.waitForFunction((cwd) => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip') === cwd, pickDir, {
    timeout: 5_000
  })
  await page.locator('[data-testid="composer-input"]').fill('hello')
  await page.locator('[data-testid="send-button"]').click()
  const pickFolder = page.locator(`[data-testid="folder"][data-cwd="${pickDir}"]`)
  await pickFolder.locator('[data-testid="chat-row"]').first().waitFor({ timeout: 5_000 })
  await writeFile(join(agentsDir, 'nested-one', 'nested-one.md'), agentFile('nested-two'))
  await row(page, 'nested-two').waitFor({ timeout: 3_000 })
  await row(page, 'nested-one').waitFor({ state: 'detached', timeout: 3_000 })
  const block = page.locator('nav.agent-list .agent-block').filter({ has: row(page, 'nested-two') })
  const toggle = block.locator('[data-testid="agent-toggle"]')
  await toggle.waitFor({ timeout: 3_000 })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await block.locator('[data-testid="chat-row"]').first().waitFor({ timeout: 3_000 })
  assert(
    (await block.locator('[data-testid="chat-row"]').count()) === 1,
    `nested-two has ${await block.locator('[data-testid="chat-row"]').count()} chat rows, expected 1`
  )
  ok('6 rename nested-one -> nested-two moves its chat')

  // 7
  await writeFile(cbFile, 'junk')
  await waitFor(async () => (await readFile(cbFile, 'utf8')) === original, 3_000, 'zumi-bot file to be restored')
  assert(
    (await page.locator('[data-testid="agent-row"]').first().getAttribute('data-agent-name')) === CB,
    'zumi-bot is no longer the first row'
  )
  ok('7 junk overwrite of zumi-bot file restored, still first row')

  // 8
  await mkdir(SHOTS, { recursive: true })
  await page.emulateMedia({ colorScheme: null }) // Playwright forces light; let the app's theme setting decide
  // The theme is set in Settings, which cover the sidebar, so each shot is taken after Esc leaves them.
  const setTheme = async (theme) => {
    await page.keyboard.press('Control+,')
    await page.locator(`[data-testid="theme-${theme}"]`).click()
    await page.keyboard.press('Escape')
    await page.locator('[data-testid="settings-nav"]').waitFor({ state: 'detached' })
  }
  await setTheme('light')
  await sleep(400)
  await page.screenshot({ path: join(SHOTS, 'zumi-bot-light.png') })
  await setTheme('dark')
  await sleep(400)
  await page.screenshot({ path: join(SHOTS, 'zumi-bot-dark.png') })
  ok('8 screenshots zumi-bot-light.png and zumi-bot-dark.png')

  if (started.errors.length) console.log(`browser console and server errors:\n${started.errors.join('\n')}`)
}

const safe = (p) => p !== null && p.startsWith(tmpdir() + sep) && basename(p).startsWith(PREFIX)
let failed = false
try {
  await main()
} catch (err) {
  failed = true
  console.error(err)
  if (current) await current.page.screenshot({ path: join(SHOTS, 'zumi-bot-failure.png') }).catch(() => {})
} finally {
  await stop().catch((e) => console.error('stop failed', e))
  for (const d of [userData, agentsDir, pickDir]) {
    if (d === null) continue
    if (safe(d)) await rm(d, { recursive: true, force: true })
    else console.error(`refusing to delete unexpected path ${d}`)
  }
}
if (!failed && okCount !== 8) failed = true
process.exit(failed ? 1 : 0)
