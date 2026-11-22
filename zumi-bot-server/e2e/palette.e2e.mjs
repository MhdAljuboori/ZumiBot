// End-to-end check of the Ctrl+K palette in the built server + web UI against the FAKE claude: no CLI turn is ever
// sent, so no login or quota is used. Usage: npm run e2e:palette   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// Chats are written into the data dir before the server starts (a long one whose message search hit sits far above its
// first page, a live one, an archived one); a routine and a workflow are saved over raw /ws RPCs. Each pick is checked by
// the address it leads to, so every view, Settings section and editor is reached the way a reload would find it.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), palette, palette-input, palette-group (+ data-group),
//   palette-item (+ data-key), palette-hit (+ data-chat-id, data-hit-item), palette-messages-status, palette-empty,
//   rail-palette, nav-toggle, nav-backdrop, routine-name, routine-more, routine-discard, search-button, archived-note,
//   new-chat-agent, new-chat-members.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start, unexpectedErrors } from './harness.mjs'

const AGENT = 'e2e-palette-agent'
const WRITER = 'e2e-palette-writer'
const PREFIX = 'zumibot-e2e-palette-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 15_000
const LONG = 'palette-long-chat'
const LAUNCH = 'palette-launch-chat'
const OLD = 'palette-archived-chat'
const DAY = 86_400_000

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

const path = (page) => decodeURIComponent(new URL(page.url()).pathname)
const palette = (page) => page.locator(tid('palette'))
const input = (page) => page.locator(tid('palette-input'))
const item = (page, key) => page.locator(`${tid('palette-item')}[data-key="${key}"]`)
const activeKey = (page) =>
  page.evaluate(() => {
    const id = document.querySelector('[data-testid="palette-input"]')?.getAttribute('aria-activedescendant')
    const el = id ? document.getElementById(id) : null
    return el?.dataset.key ?? (el ? `hit:${el.dataset.hitItem}` : null)
  })

async function seed(dataDir, folder) {
  const now = Date.now()
  const meta = (id, agentName, title, updatedAt, extra = {}) => ({
    id,
    agentName,
    sessionId: null,
    cwd: folder,
    title,
    createdAt: now - 30 * DAY,
    updatedAt,
    inFlight: false,
    ...extra
  })
  const long = Array.from({ length: 300 }, (_, i) =>
    i % 2 === 0
      ? { type: 'user', id: `u${i}`, text: `Question number ${i} about the weather`, ts: now - 20 * DAY + i * 1000 }
      : { type: 'assistant', id: `a${i}`, text: `Answer ${i}: it is sunny.`, ts: now - 20 * DAY + i * 1000 }
  )
  long[11] = { type: 'assistant', id: 'a11', text: 'The Zephyrine relay needs a restart first.', ts: now - 20 * DAY + 11_000 }
  await mkdir(join(dataDir, 'chats'), { recursive: true })
  await writeFile(
    join(dataDir, 'chats.json'),
    JSON.stringify({
      chats: [
        meta(LONG, AGENT, 'Weather log', now - 2 * DAY),
        meta(LAUNCH, WRITER, 'Launch plan', now - DAY),
        meta(OLD, AGENT, 'Old notes', now - 9 * DAY, { archivedAt: now - 5 * DAY })
      ]
    })
  )
  await writeFile(join(dataDir, 'chats', `${LONG}.json`), JSON.stringify(long))
  await writeFile(
    join(dataDir, 'chats', `${LAUNCH}.json`),
    JSON.stringify([{ type: 'user', id: 'l1', text: 'Plan the launch', ts: now - DAY }])
  )
  await writeFile(join(dataDir, 'chats', `${OLD}.json`), JSON.stringify([{ type: 'user', id: 'o1', text: 'Old note', ts: now - 9 * DAY }]))
  // A remembered folder for the writer: opening it must still pick no folder (step 4).
  await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ lastFolderByAgent: { [WRITER]: folder } }))
}

// Ctrl+K, the query, then Enter on the best match.
async function go(page, query) {
  await page.keyboard.press('Control+k')
  await input(page).waitFor({ timeout: T })
  await input(page).fill(query)
  await page.keyboard.press('Enter')
  await palette(page).waitFor({ state: 'detached', timeout: T })
}

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  for (const name of [AGENT, WRITER]) {
    await writeFile(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: Palette e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
    )
  }
  await seed(dataDir, folder)
  h = await start({ fake: true, dataDir, agentsDir })
  const page = h.page
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })
  const routine = await rpc(page, 'routines:save', {
    id: null,
    name: 'Nightly digest',
    enabled: false,
    timeZone: 'UTC',
    trigger: { kind: 'manual' },
    target: { kind: 'new-chat', agent: AGENT, cwd: folder },
    prompt: 'Summarise the day.',
    limitPolicy: 'wait',
    missedPolicy: 'run-once',
    sessionPolicy: 'continue',
    command: null
  })
  const flow = await rpc(page, 'workflows:save', {
    id: null,
    name: 'Triage flow',
    enabled: false,
    timeZone: 'UTC',
    trigger: { kind: 'manual' },
    steps: [
      { id: 't', handle: 't', name: 'Start', kind: 'trigger', x: 0, y: 0 },
      { id: 'g', handle: 'g', name: 'Sort', kind: 'agent', agent: AGENT, prompt: 'Sort the issues.', cwd: folder, x: 300, y: 0 }
    ],
    edges: [{ id: 't-out-g', from: 't', port: 'out', to: 'g' }]
  })
  // The palette reads the lists the page holds; a reload brings the new routine and workflow in.
  await page.reload()
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: T })

  // 1. Ctrl+K opens it with the cursor in its box; a blank query lists the newest live chats, the places and the creates
  await page.keyboard.press('Control+k')
  await input(page).waitFor({ timeout: T })
  assert(await input(page).evaluate((el) => el === document.activeElement), 'the box has focus')
  const groups = await page.locator(tid('palette-group')).evaluateAll((els) => els.map((e) => e.dataset.group))
  assert(JSON.stringify(groups) === JSON.stringify(['recent', 'goto', 'create']), `the blank sections: ${groups}`)
  const recent = await page
    .locator(`${tid('palette-group')}[data-group="recent"] ${tid('palette-item')}`)
    .evaluateAll((els) => els.map((e) => e.dataset.key))
  assert(
    JSON.stringify(recent) === JSON.stringify([`chat:${LAUNCH}`, `chat:${LONG}`]),
    `recent chats, newest first, no archived one: ${recent}`
  )
  assert((await activeKey(page)) === `chat:${LAUNCH}`, 'the first row is active')
  ok('Ctrl+K opens the palette on the newest chats, the places and the creates')

  // 2. arrows move and wrap; Ctrl+K again closes it and gives focus back
  await page.keyboard.press('ArrowDown')
  assert((await activeKey(page)) === `chat:${LONG}`, 'ArrowDown moves to the second row')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  assert((await activeKey(page)) === 'action:new-workflow', `ArrowUp from the top wraps to the last row: ${await activeKey(page)}`)
  await page.keyboard.press('Control+k')
  await palette(page).waitFor({ state: 'detached', timeout: T })
  await page.locator(tid('search-button')).focus()
  await page.keyboard.press('Control+k')
  await input(page).waitFor({ timeout: T })
  await page.keyboard.press('Escape')
  await palette(page).waitFor({ state: 'detached', timeout: T })
  assert(await page.locator(tid('search-button')).evaluate((el) => el === document.activeElement), 'Esc gives focus back to where it was')
  ok('arrows move and wrap; Ctrl+K again and Esc close it, giving focus back')

  // 3. each kind of place, by its address
  await go(page, 'launch')
  await waitFor(async () => path(page) === `/chat/${LAUNCH}`, T, 'the Launch plan chat')
  await go(page, 'passwords')
  await waitFor(async () => path(page) === '/settings/vault', T, 'Settings › Vault by a keyword')
  await go(page, 'nightly')
  await waitFor(async () => path(page) === `/routines/${routine.id}`, T, 'the routine')
  await go(page, 'triage')
  await waitFor(async () => path(page) === `/workflows/${flow.id}`, T, 'the workflow')
  await go(page, 'inbox')
  await waitFor(async () => path(page) === '/inbox', T, 'the Inbox')
  await go(page, 'archived')
  await waitFor(async () => path(page) === '/archived', T, 'Archived')
  await go(page, 'to-dos')
  await waitFor(async () => path(page) === '/todos', T, 'the To-dos page')
  await go(page, 'old notes')
  await waitFor(async () => path(page) === `/chat/${OLD}`, T, 'the archived chat')
  await page.locator(tid('archived-note')).waitFor({ timeout: T })
  ok('a chat, a Settings section by keyword, a routine, a workflow, the Inbox, Archived, To-dos and an archived chat')

  // 4. an agent by name opens as its sidebar row does: its start screen with no folder picked, though the writer has
  //    chats and a remembered folder, and no chat is made; New group chat and New chat open the new-chat screen in their modes
  const picker = page.locator(tid('new-chat-agent'))
  const folderPicker = page.locator(tid('new-chat-folder'))
  const writerStart = async (how) => {
    await waitFor(
      async () => path(page) === '/' && (await picker.count()) === 1 && (await picker.textContent()).includes('E2e Palette Writer'),
      T,
      `the writer's start screen ${how}`
    )
    const folderText = await folderPicker.textContent()
    assert(folderText.includes('No folder'), `the writer's start screen ${how} picked ${JSON.stringify(folderText)}`)
  }
  await go(page, 'palette writer')
  await writerStart('from the palette')
  await go(page, 'launch')
  await waitFor(async () => path(page) === `/chat/${LAUNCH}`, T, 'the Launch plan chat')
  await page.locator(`${tid('agent-row')}[data-agent-name="${WRITER}"]`).click()
  await writerStart('from its sidebar row')
  await sleep(500) // a chat made by the click would open by now
  assert(path(page) === '/', `the writer's row opened ${path(page)}`)
  const writerChats = (await rpc(page, 'chats:list')).filter((c) => c.agentName === WRITER)
  assert(writerChats.length === 1, `the writer has ${writerChats.length} chats, not its one seeded chat`)
  await go(page, 'new group')
  await page.locator(tid('new-chat-members')).waitFor({ timeout: T })
  await go(page, 'new chat')
  await picker.waitFor({ timeout: T })
  assert(path(page) === '/', `the new-chat screen: ${path(page)}`)
  ok('an agent opens its start screen with no folder, from the palette and its row; New group chat and New chat open the new-chat screen')

  // 5. the message search's hits sit under the places; one opens its chat at the message, 289 items back, lit
  await page.keyboard.press('Control+k')
  await input(page).fill('zephyr')
  const hit = page.locator(`${tid('palette-hit')}[data-chat-id="${LONG}"][data-hit-item="a11"]`)
  await hit.waitFor({ timeout: T })
  assert((await page.locator(tid('palette-messages-status')).textContent()) === '1 message', 'the message count')
  assert((await hit.locator('mark').allTextContents()).join() === 'Zephyr', 'the snippet marks the match')
  await page.keyboard.press('Enter') // nothing else matches, so the hit is the active row
  await palette(page).waitFor({ state: 'detached', timeout: T })
  await waitFor(async () => path(page) === `/chat/${LONG}`, T, 'the hit chat')
  const target = page.locator('.msg[data-item-id="a11"]')
  await target.waitFor({ timeout: T })
  await waitFor(
    async () =>
      target.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return r.top >= 0 && r.bottom <= window.innerHeight
      }),
    T,
    'the message in view'
  )
  const lit = await page.evaluate(() => [...(CSS.highlights?.get('search-hit') ?? [])].map((r) => r.toString()))
  assert(lit.join() === 'Zephyr', `the word lit: ${JSON.stringify(lit)}`)
  ok('a message hit opens its chat at the message, lit')

  // 6. nothing matching says so
  await page.keyboard.press('Control+k')
  await input(page).fill('qqqxqqq')
  await page.locator(tid('palette-empty')).waitFor({ timeout: T })
  await page.keyboard.press('Escape')
  ok('a query nothing matches says so')

  // 7. the unsaved-changes guard holds, and Ctrl+K stays out of its dialog
  await go(page, 'new routine')
  await waitFor(async () => path(page) === '/routines/new', T, 'the new routine editor')
  await page.locator(tid('routine-name')).fill('Draft routine')
  await go(page, 'inbox')
  const dialog = page.locator('[role="dialog"]').filter({ hasText: 'Unsaved changes' })
  await dialog.waitFor({ timeout: T })
  await page.keyboard.press('Control+k')
  await sleep(200)
  assert((await palette(page).count()) === 0, 'Ctrl+K opens nothing over the unsaved-changes dialog')
  await dialog.locator('button', { hasText: 'Cancel' }).click()
  await dialog.waitFor({ state: 'detached', timeout: T })
  assert(path(page) === '/routines/new', `Cancel keeps the editor: ${path(page)}`)
  await page.locator(tid('routine-more')).click()
  await page.locator(tid('routine-discard')).click()
  ok('the unsaved-changes guard holds, and Ctrl+K stays out of its dialog')

  // 8. on a phone, the rail's button in the drawer opens it, and a pick closes the drawer
  const phone = await h.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const mobile = await phone.newPage()
  await mobile.goto(h.origin)
  await mobile.locator(tid('nav-toggle')).click()
  await mobile.locator(tid('rail-palette')).click()
  await input(mobile).waitFor({ timeout: T })
  await input(mobile).fill('launch')
  await item(mobile, `chat:${LAUNCH}`).click()
  await palette(mobile).waitFor({ state: 'detached', timeout: T })
  await waitFor(async () => path(mobile) === `/chat/${LAUNCH}`, T, 'the phone on the chat')
  assert((await mobile.locator(tid('nav-backdrop')).count()) === 0, 'the drawer closed')
  await phone.close()
  ok("on a phone the rail's button opens the palette, and a pick closes the drawer")

  const bad = unexpectedErrors(h.errors, [])
  assert(bad.length === 0, `unexpected console/server errors:\n${bad.join('\n')}`)
  ok('no unexpected console or server errors')
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
console.log(failed ? 'e2e:palette FAILED' : 'e2e:palette passed')
process.exit(failed ? 1 : 0)
