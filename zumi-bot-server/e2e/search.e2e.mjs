// End-to-end check of message search in the built server + web UI against the FAKE claude: no real CLI turn is ever
// sent, so no login or quota is used. Usage: npm run e2e:search   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// Chats are written into the data dir before the server starts, so the index is built from chats/*.json at start: a
// long chat whose match sits far above its first page, an archived chat and one in Arabic. A chat made afterwards
// gets a fake reply, which must become searchable once its saves settle, and must leave the index when it is deleted.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), search-button, search-input, message-hits,
//   message-hits-status, message-hit (+ data-chat-id, data-hit-item), message-hits-more, agent-message,
//   user-message, archived-note, search-button.

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const BASIC = fileURLToPath(new URL('../backend/tests/fixtures/stream/basic.jsonl', import.meta.url))
const AGENT = 'e2e-search-agent'
const PREFIX = 'zumibot-e2e-search-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 15_000
const LONG = 'search-long-chat'
const OLD = 'search-archived-chat'
const ARABIC = 'search-arabic-chat'
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
const metaOf = async (chatId) => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats.find((c) => c.id === chatId)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])

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

const replyWith = async (word) => writeFile(h.script, (await readFile(BASIC, 'utf8')).replaceAll('pong', word))
const path = (page) => decodeURIComponent(new URL(page.url()).pathname)
const hit = (page, chatId, itemId) => page.locator(`${tid('message-hit')}[data-chat-id="${chatId}"][data-hit-item="${itemId}"]`)
const status = (page) => page.locator(tid('message-hits-status'))

async function seed(dataDir, folder) {
  const now = Date.now()
  const meta = (id, title, extra = {}) => ({
    id,
    agentName: AGENT,
    sessionId: null,
    cwd: folder,
    title,
    createdAt: now - 30 * DAY,
    updatedAt: now - DAY,
    inFlight: false,
    ...extra
  })
  // 300 items, oldest first; the one match sits at index 10, far above the first page of 60.
  const long = Array.from({ length: 300 }, (_, i) =>
    i % 2 === 0
      ? { type: 'user', id: `u${i}`, text: `Question number ${i} about the weather`, ts: now - 20 * DAY + i * 1000 }
      : { type: 'assistant', id: `a${i}`, text: `Answer ${i}: it is sunny.`, ts: now - 20 * DAY + i * 1000 }
  )
  long[11] = {
    type: 'assistant',
    id: 'a11',
    text: 'The **Zephyrine** protocol needs a restart of the relay first.',
    ts: now - 20 * DAY + 11_000
  }
  const old = [
    { type: 'user', id: 'o1', text: 'Keep the zephyrine archived note for later', ts: now - 40 * DAY },
    { type: 'assistant', id: 'o2', text: 'Noted.', ts: now - 40 * DAY + 1000 }
  ]
  const arabic = [{ type: 'user', id: 'r1', text: 'اسمي مُحَمَّد وأعمل في المستشفى', ts: now - 2 * DAY }]
  await mkdir(join(dataDir, 'chats'), { recursive: true })
  await writeFile(
    join(dataDir, 'chats.json'),
    JSON.stringify({
      chats: [meta(LONG, 'Weather log'), meta(OLD, 'Old notes', { archivedAt: now - 5 * DAY }), meta(ARABIC, 'Arabic chat')]
    })
  )
  await writeFile(join(dataDir, 'chats', `${LONG}.json`), JSON.stringify(long))
  await writeFile(join(dataDir, 'chats', `${OLD}.json`), JSON.stringify(old))
  await writeFile(join(dataDir, 'chats', `${ARABIC}.json`), JSON.stringify(arabic))
}

async function openSearch(page, query) {
  if ((await page.locator(tid('search-input')).count()) === 0) await page.locator(tid('search-button')).click()
  await page.locator(tid('search-input')).fill(query)
}

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Search e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  await seed(dataDir, folder)
  h = await start({ fake: true, dataDir, agentsDir })
  const page = h.page
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })

  // 1. the index built from the stored chats: newest first, the archived chat included, the match marked
  await waitFor(async () => (await rpc(page, 'chats:search', 'zephyr', 0)).indexing === false, T, 'the index to finish building')
  await openSearch(page, 'zephyr')
  await waitFor(async () => (await status(page).textContent()) === '2 messages', T, 'the status to read 2 messages')
  const keys = await page.locator(tid('message-hit')).evaluateAll((els) => els.map((e) => `${e.dataset.chatId}/${e.dataset.hitItem}`))
  assert(JSON.stringify(keys) === JSON.stringify([`${LONG}/a11`, `${OLD}/o1`]), `hits newest first: ${keys}`)
  const marks = await hit(page, LONG, 'a11').locator('mark').allTextContents()
  assert(JSON.stringify(marks) === JSON.stringify(['Zephyr']), `the matched part is marked: ${marks}`)
  assert((await hit(page, OLD, 'o1').textContent()).includes('Archived'), 'the archived hit is tagged')
  assert((await hit(page, LONG, 'a11').textContent()).includes('Weather log'), 'the hit names its chat')
  ok('the index is built from chats/*.json at start; hits are newest first, tagged and marked')

  // 2. a hit far above the first page: its chat opens there, in one request, and the words light
  await hit(page, LONG, 'a11').click()
  const target = page.locator('[data-item-id="a11"]')
  await target.waitFor({ timeout: T })
  await waitFor(
    async () =>
      target.evaluate((el) => {
        const r = el.getBoundingClientRect()
        return r.top >= 0 && r.bottom <= window.innerHeight
      }),
    T,
    'the matched message to scroll into view'
  )
  assert(path(page) === `/chat/${LONG}`, `the address names the chat: ${path(page)}`)
  const lit = await page.evaluate(() => {
    const h = CSS.highlights?.get('search-hit')
    return h ? [...h].map((r) => r.toString()) : null
  })
  assert(lit !== null && lit.length === 1 && lit[0] === 'Zephyr', `the message's matched word is lit: ${JSON.stringify(lit)}`)
  ok('opening a hit 289 items back scrolls its chat to the message and lights the word')

  // 3. the archived chat opens from its hit, with its archived note
  await hit(page, OLD, 'o1').click()
  await page.locator('[data-item-id="o1"]').waitFor({ timeout: T })
  await page.locator(tid('archived-note')).waitFor({ timeout: T })
  ok('an archived chat opens from its hit, still archived')

  // 4. phrases, word starts and Arabic folding
  const phrase = await rpc(page, 'chats:search', '"zephyrine archived"', 0)
  assert(phrase.total === 1 && phrase.hits[0].itemId === 'o1', `a quoted phrase: ${JSON.stringify(phrase.hits.map((x) => x.itemId))}`)
  assert((await rpc(page, 'chats:search', '"zephyrine relay"', 0)).total === 0, 'a phrase not as typed finds nothing')
  assert((await rpc(page, 'chats:search', 'ephyrine', 0)).total === 0, 'a word inside another word finds nothing')
  const arabic = await rpc(page, 'chats:search', 'محمد مستشفي', 0)
  assert(arabic.total === 1 && arabic.hits[0].chatId === ARABIC, 'Arabic matches across its diacritics and letter forms')
  ok('a quoted phrase, word starts and Arabic folding')

  // 5. a reply in a chat made now becomes searchable once its saves settle; Show more pages
  const fresh = (await rpc(page, 'chats:create', AGENT, folder)).id
  await replyWith('quokkaphrase')
  await rpc(page, 'chats:send', fresh, 'hello there')
  await waitFor(
    async () => {
      const m = await metaOf(fresh)
      return m && !m.inFlight && (await itemsOf(fresh)).some((i) => i.type === 'assistant' && i.text.includes('quokkaphrase'))
    },
    30_000,
    'the fake reply'
  )
  await waitFor(async () => (await rpc(page, 'chats:search', 'quokka', 0)).total === 1, T, 'the new reply to be indexed')
  await openSearch(page, 'quokka')
  await page.locator(`${tid('message-hit')}[data-chat-id="${fresh}"]`).waitFor({ timeout: T })
  await openSearch(page, 'weather')
  await waitFor(async () => (await status(page).textContent()) === '150 messages', T, 'the weather count')
  assert((await page.locator(tid('message-hit')).count()) === 30, 'the first page holds 30 hits')
  await page.locator(tid('message-hits-more')).click()
  await waitFor(async () => (await page.locator(tid('message-hit')).count()) === 60, T, 'Show more to add 30 hits')
  ok("a new chat's reply is indexed once it settles; Show more adds the next page")

  // 6. a deleted chat leaves the index
  await rpc(page, 'chats:remove', fresh)
  assert((await rpc(page, 'chats:search', 'quokka', 0)).total === 0, 'the deleted chat is gone from the index')
  ok('a deleted chat leaves the index')

  // 7. the search button opens the search with the cursor in it (Ctrl+K is the palette's, see e2e:palette)
  await page.locator('.search-close').click()
  await page.locator(tid('search-input')).waitFor({ state: 'detached', timeout: T })
  await page.locator(tid('search-button')).click()
  await page.locator(tid('search-input')).waitFor({ timeout: T })
  assert(await page.locator(tid('search-input')).evaluate((el) => el === document.activeElement), 'the search box has focus')
  ok('the search button opens the search')

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
console.log(failed ? 'e2e:search FAILED' : 'e2e:search passed')
process.exit(failed ? 1 : 0)
