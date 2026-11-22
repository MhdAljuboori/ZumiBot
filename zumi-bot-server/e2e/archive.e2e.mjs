// End-to-end check of chat and room archiving in the built server + web UI against the FAKE claude: no real CLI turn
// is ever sent, so no login or quota is used. Usage: npm run e2e:archive   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// The chats and the room are made over a raw /ws RPC; the room is put in a section first, so Unarchive must bring it
// back to that section. Each turn's reply word is set in the fake claude's script, so replies can be told apart.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), agent-toggle, chat-row (+ data-chat-id),
//   group-row (+ data-chat-id), user-section, chat-menu-archive, sidebar-user, archived-open, archived-nav,
//   archived-row (+ data-chat-id), archived-placeholder, archived-note, archived-unarchive, archived-menu-button,
//   archived-menu-unarchive, archived-empty, archived-back, archived-search, archived-check, archived-bulk,
//   archived-bulk-count, archived-bulk-unarchive, archived-bulk-delete, archived-select-all, agent-turn, cost-chip,
//   context-chip, composer-input, send-button.
// Stored state read: <dataDir>/chats.json (archivedAt / unarchivedAt), <dataDir>/sidebar.json.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const BASIC = fileURLToPath(new URL('../backend/tests/fixtures/stream/basic.jsonl', import.meta.url))
const AGENT = 'e2e-archive-agent'
const OTHER = 'e2e-archive-other'
const PREFIX = 'zumibot-e2e-archive-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 15_000

let h = null
const made = [] // every mkdtemp dir made here
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const metaOf = async (chatId) => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats.find((c) => c.id === chatId)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])
const archived = (m) => m.archivedAt !== undefined && m.archivedAt > (m.unarchivedAt ?? 0)

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

// The next turn of the fake claude replies with `word` instead of "pong".
const replyWith = async (word) => writeFile(h.script, (await readFile(BASIC, 'utf8')).replaceAll('pong', word))

async function waitReply(chatId, word) {
  await waitFor(
    async () => {
      const m = await metaOf(chatId)
      return m && !m.inFlight && (await itemsOf(chatId)).some((i) => i.type === 'assistant' && i.text.includes(word))
    },
    30_000,
    `the reply "${word}" in ${chatId}`
  )
}

const chatRow = (page, id) => page.locator(`${tid('chat-row')}[data-chat-id="${id}"]`)
const groupRow = (page, id) => page.locator(`${tid('group-row')}[data-chat-id="${id}"]`)
const archivedRow = (page, id) => page.locator(`${tid('archived-row')}[data-chat-id="${id}"]`)
const path = (page) => decodeURIComponent(new URL(page.url()).pathname)

async function expandAgent(page) {
  const toggle = page
    .locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`)
    .locator('xpath=..')
    .locator(tid('agent-toggle'))
  await toggle.waitFor({ timeout: T })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await waitFor(async () => (await toggle.getAttribute('aria-expanded')) === 'true', T, 'the agent to expand')
}

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  for (const name of [AGENT, OTHER]) {
    await writeFile(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: Archive e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
    )
  }
  h = await start({ fake: true, dataDir, agentsDir })
  const page = h.page
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })

  // 0. chat A with one exchange, chat B left alone, room R placed in a section of its own
  const A = (await rpc(page, 'chats:create', AGENT, folder)).id
  await replyWith('first-reply-a')
  await rpc(page, 'chats:send', A, 'hello A')
  await waitReply(A, 'first-reply-a')
  await rpc(page, 'chats:rename', A, 'Alpha plan')
  const B = (await rpc(page, 'chats:create', AGENT, folder)).id
  await rpc(page, 'chats:send', B, 'hello B')
  await waitReply(B, 'first-reply-a')
  const R = (await rpc(page, 'chats:createGroup', [AGENT, OTHER], folder, '')).id
  await rpc(page, 'chats:rename', R, 'Launch room')
  await rpc(page, 'sidebar:save', { sections: [{ id: 'work', name: 'Work', collapsed: false, items: [`group:${R}`] }], unassigned: [] })
  await page.reload()
  await expandAgent(page)
  await chatRow(page, A).waitFor({ timeout: T })
  await chatRow(page, B).waitFor({ timeout: T })
  const section = page.locator(tid('user-section')).filter({ hasText: 'Work' })
  await section.locator(`${tid('group-row')}[data-chat-id="${R}"]`).waitFor({ timeout: T })
  ok(`chat A ${A} (one exchange), chat B ${B}, room R ${R} in section Work`)

  // 1. Archive A and R from their right-click menus: both leave the sidebar, B stays, R's spot stays stored
  await chatRow(page, A).click({ button: 'right' })
  await page.locator(tid('chat-menu-archive')).click()
  await chatRow(page, A).waitFor({ state: 'detached', timeout: T })
  await groupRow(page, R).click({ button: 'right' })
  await page.locator(tid('chat-menu-archive')).click()
  await groupRow(page, R).waitFor({ state: 'detached', timeout: T })
  assert(await chatRow(page, B).isVisible(), 'B left the sidebar too')
  assert(
    archived(await metaOf(A)) && archived(await metaOf(R)) && !archived(await metaOf(B)),
    'chats.json does not have A and R archived and B not'
  )
  const stored = await readFile(join(dataDir, 'sidebar.json'), 'utf8').then(JSON.parse)
  assert(stored.sections[0]?.items.includes(`group:${R}`), `the stored layout lost R's spot: ${JSON.stringify(stored)}`)
  ok('Archive from the menu takes A and R out of the sidebar; B stays; R keeps its stored spot in Work')

  // 2. the rail's Archived opens the list in the sidebar's place, newest archived first
  await page.locator(tid('archived-open')).click()
  await page.locator(tid('archived-nav')).waitFor({ timeout: T })
  await page.locator(tid('archived-placeholder')).waitFor({ timeout: T })
  await waitFor(async () => path(page) === '/archived', T, 'the address /archived')
  const order = await page.locator(tid('archived-row')).evaluateAll((els) => els.map((e) => e.getAttribute('data-chat-id')))
  assert(JSON.stringify(order) === JSON.stringify([R, A]), `the list is ${JSON.stringify(order)}, not R then A`)
  await page.locator(tid('archived-search')).fill('alpha')
  await waitFor(
    async () => (await page.locator(tid('archived-row')).count()) === 1 && (await archivedRow(page, A).count()) === 1,
    T,
    'the search to keep only A'
  )
  await page.locator(tid('archived-search')).fill('')
  ok('Archived… lists R then A at /archived; the search finds A by title')

  // 3. opening A shows its history, cost and context, with the archived note; a reload keeps it there
  await archivedRow(page, A).click()
  await page.locator(tid('agent-turn')).filter({ hasText: 'first-reply-a' }).waitFor({ timeout: T })
  await page.locator(tid('archived-note')).waitFor({ timeout: T })
  await page.locator(tid('cost-chip')).waitFor({ timeout: T })
  await page.locator(tid('context-chip')).waitFor({ timeout: T })
  await waitFor(async () => path(page) === `/archived/${A}`, T, `the address /archived/${A}`)
  await page.reload()
  await page.locator(tid('archived-nav')).waitFor({ timeout: T })
  await page.locator(tid('agent-turn')).filter({ hasText: 'first-reply-a' }).waitFor({ timeout: T })
  await page.locator(tid('archived-note')).waitFor({ timeout: T })
  ok('A opens from the list with its reply, cost chip, context meter and the archived note; a reload keeps list and chat')

  // 4. sending in A brings it back: the note goes, it leaves the list, chats.json says so
  await replyWith('second-reply-a')
  await page.locator(tid('composer-input')).fill('picking this up again')
  await page.locator(tid('send-button')).click()
  await page.locator(tid('agent-turn')).filter({ hasText: 'second-reply-a' }).waitFor({ timeout: 30_000 })
  await page.locator(tid('archived-note')).waitFor({ state: 'detached', timeout: T })
  await archivedRow(page, A).waitFor({ state: 'detached', timeout: T })
  const a = await metaOf(A)
  assert(
    !archived(a) && a.unarchivedAt > a.archivedAt,
    `chats.json has A as ${JSON.stringify({ archivedAt: a.archivedAt, unarchivedAt: a.unarchivedAt })}`
  )
  ok('a message sent in archived A brings it back: note gone, row gone from the list, unarchivedAt stored')

  // 5. Unarchive R from its row menu: the list empties, and Back to chats shows R in Work again and A under its agent
  await archivedRow(page, R).hover()
  await archivedRow(page, R).locator('xpath=..').locator(tid('archived-menu-button')).click()
  await page.locator(tid('archived-menu-unarchive')).click()
  await archivedRow(page, R).waitFor({ state: 'detached', timeout: T })
  await page.locator(tid('archived-empty')).waitFor({ timeout: T })
  assert(!archived(await metaOf(R)), 'chats.json still has R archived')
  await page.locator(tid('archived-back')).click()
  await page.locator(tid('archived-nav')).waitFor({ state: 'detached', timeout: T })
  await section.locator(`${tid('group-row')}[data-chat-id="${R}"]`).waitFor({ timeout: T })
  await expandAgent(page)
  await chatRow(page, A).waitFor({ timeout: T })
  await waitFor(async () => path(page) === `/chat/${A}`, T, `the address /chat/${A} once the sidebar is back`)
  ok('Unarchive puts R back in Work; Back to chats keeps A open, now in the sidebar')

  // 6. archiving the open chat (here from another socket, as another device would) keeps it open with the note, and
  // the note's Unarchive brings its row back
  await rpc(page, 'chats:archive', A, true)
  await page.locator(tid('archived-note')).waitFor({ timeout: T })
  await chatRow(page, A).waitFor({ state: 'detached', timeout: T })
  await page.locator(tid('archived-unarchive')).click()
  await page.locator(tid('archived-note')).waitFor({ state: 'detached', timeout: T })
  await chatRow(page, A).waitFor({ timeout: T })
  assert(!archived(await metaOf(A)), 'chats.json still has A archived')
  ok("the open chat archived elsewhere stays open with the note; the note's Unarchive brings its row back")

  // 7. several at once: four archived chats (newest first: C4 C3 C2 C1); tick C4, shift-tick C2 for the range, open C3
  // without losing the ticks; a search hiding them hides the bar; Unarchive two, Esc, Select all, Delete the rest
  const C = []
  for (const n of ['one', 'two', 'three', 'four']) {
    const id = (await rpc(page, 'chats:create', AGENT, folder)).id
    await rpc(page, 'chats:rename', id, `Ship release ${n}`)
    await rpc(page, 'chats:archive', id, true)
    C.push(id)
  }
  const [C1, C2, C3, C4] = C
  await page.reload()
  await page.locator(tid('archived-open')).click()
  await archivedRow(page, C1).waitFor({ timeout: T })
  const check = (id) => archivedRow(page, id).locator('xpath=..').locator(tid('archived-check'))
  const count = page.locator(tid('archived-bulk-count'))
  const ticked = async () =>
    page
      .locator(`${tid('archived-check')}[aria-checked="true"]`)
      .evaluateAll((els) => els.map((e) => e.parentElement.querySelector('[data-chat-id]').getAttribute('data-chat-id')))
  assert((await page.locator(tid('archived-bulk')).count()) === 0, 'the bar shows before anything is ticked')
  await archivedRow(page, C4).hover()
  await check(C4).click()
  await waitFor(async () => (await count.textContent()) === '1 selected', T, 'the bar to say 1 selected')
  await check(C2).click({ modifiers: ['Shift'] })
  await waitFor(async () => (await count.textContent()) === '3 selected', T, 'the shift range to tick 3')
  assert(JSON.stringify(await ticked()) === JSON.stringify([C4, C3, C2]), `ticked ${JSON.stringify(await ticked())}, not C4 C3 C2`)
  await archivedRow(page, C3).click()
  await waitFor(async () => path(page) === `/archived/${C3}`, T, `the address /archived/${C3}`)
  await page.locator(tid('archived-note')).waitFor({ timeout: T })
  assert((await count.textContent()) === '3 selected', 'opening a chat lost the ticks')
  await page.locator(tid('archived-search')).fill('one')
  await page.locator(tid('archived-bulk')).waitFor({ state: 'detached', timeout: T })
  await page.locator(tid('archived-search')).fill('')
  await waitFor(async () => (await count.textContent().catch(() => '')) === '3 selected', T, 'the ticks back once the search clears')
  ok('tick, shift-tick a range, open a ticked chat and search: the ticks stay, and only shown ones are counted')

  await check(C3).click()
  await waitFor(async () => (await count.textContent()) === '2 selected', T, 'C3 to untick')
  await page.locator(tid('archived-bulk-unarchive')).click()
  await archivedRow(page, C4).waitFor({ state: 'detached', timeout: T })
  await archivedRow(page, C2).waitFor({ state: 'detached', timeout: T })
  await page.locator(tid('archived-bulk')).waitFor({ state: 'detached', timeout: T })
  await waitFor(async () => !archived(await metaOf(C4)) && !archived(await metaOf(C2)), T, 'chats.json to have C4 and C2 back')
  assert(archived(await metaOf(C3)) && archived(await metaOf(C1)), 'Unarchive reached a chat that was not ticked')
  ok("the bar's Unarchive brings back only the ticked C4 and C2")

  await check(C1).click()
  await count.waitFor({ timeout: T })
  await page.keyboard.press('Escape')
  await page.locator(tid('archived-bulk')).waitFor({ state: 'detached', timeout: T })
  await check(C1).click()
  await page.locator(tid('archived-select-all')).click()
  await waitFor(async () => (await count.textContent()) === '2 selected', T, 'Select all to tick C3 and C1')
  await page.locator(tid('archived-bulk-delete')).click()
  const dialog = page.locator('[role="dialog"]')
  await dialog.filter({ hasText: 'Delete 2 chats?' }).waitFor({ timeout: T })
  await dialog.locator('button', { hasText: 'Delete' }).click()
  await page.locator(tid('archived-empty')).waitFor({ timeout: T })
  await waitFor(async () => (await metaOf(C3)) === undefined && (await metaOf(C1)) === undefined, T, 'chats.json to drop C3 and C1')
  assert((await page.locator(tid('archived-note')).count()) === 0, 'the deleted open chat C3 still shows')
  ok('Esc clears the ticks; Select all then Delete asks once for 2 chats and deletes both, the open one included')

  // 8. nothing unexpected
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
console.log(failed ? 'e2e:archive FAILED' : 'e2e:archive passed')
process.exit(failed ? 1 : 0)
