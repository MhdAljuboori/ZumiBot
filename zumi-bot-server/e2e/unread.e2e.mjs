// End-to-end check of unread markers in the built server + web UI against the FAKE claude: no real CLI turn is ever
// sent, so no login or quota is used. Usage: npm run e2e:unread   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server, Chrome and the second browser context started here are stopped in `finally`; overall timeout 3 min.
// "Looking" is the page's own presence report (visible + focused + on the chat + input within 3 min), so page 1 gets a
// click before each check that relies on it. Messages to a chat nobody looks at go by a raw /ws `chats:send` from a
// fresh socket, which never reports presence. Page 2 is a separate browser context (its own device id), i.e. a second
// device. Each turn's reply word is set in the fake claude's script, so every reply can be told apart in the DOM.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), agent-toggle (aria-expanded), chat-row
//   (+ data-chat-id, class `unread`), unread-dot, agent-unread-dot, new-line, agent-turn, agent-message,
//   mark-unread-button, composer-input, send-button.
// Stored state read: <dataDir>/chats.json (replyAt / seenAt / mark).

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const BASIC = fileURLToPath(new URL('../backend/tests/fixtures/stream/basic.jsonl', import.meta.url))
const AGENT = 'e2e-unread-agent'
const PREFIX = 'zumibot-e2e-unread-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 15_000

let h = null
let ctx2 = null
const made = [] // every mkdtemp dir made here
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const metaOf = async (chatId) => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats.find((c) => c.id === chatId)

async function waitFor(fn, timeout, what) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}`)
}

async function stop() {
  if (ctx2) {
    const c = ctx2
    ctx2 = null
    await Promise.race([c.close().catch(() => {}), sleep(10_000)])
  }
  if (h) {
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
}

// One raw RPC over a fresh /ws socket from the page, so the auth cookie rides along and no presence is reported.
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

const row = (page, chatId) => page.locator(`${tid('chat-row')}[data-chat-id="${chatId}"]`)
const dotOn = (page, chatId) => row(page, chatId).locator(tid('unread-dot'))
const rowUnread = async (page, chatId) => ((await row(page, chatId).getAttribute('class')) ?? '').split(/\s+/).includes('unread')

async function expandAgent(page) {
  const toggle = page
    .locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`)
    .locator('xpath=..')
    .locator(tid('agent-toggle'))
  await toggle.waitFor({ timeout: T })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
  await waitFor(async () => (await toggle.getAttribute('aria-expanded')) === 'true', T, 'the agent to expand')
  return toggle
}

const looking = (page) => page.evaluate(() => document.visibilityState === 'visible' && document.hasFocus())

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Unread markers e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  h = await start({ fake: true, dataDir, agentsDir })
  const p1 = h.page
  await p1.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })

  // 1. one agent, chats A and B; page 1 on A, page 2 (another device) on the empty view
  const A = (await rpc(p1, 'chats:create', AGENT, folder)).id
  const B = (await rpc(p1, 'chats:create', AGENT, folder)).id
  await p1.goto(`${h.origin}/chat/${encodeURIComponent(A)}`)
  await expandAgent(p1)
  await row(p1, A).waitFor({ timeout: T })
  await row(p1, B).waitFor({ timeout: T })
  await p1.locator(tid('composer-input')).click()
  assert(await looking(p1), 'page 1 is not visible and focused')

  ctx2 = await h.browser.newContext()
  await ctx2.addCookies(await h.context.cookies())
  const p2 = await ctx2.newPage()
  p2.on('console', (m) => m.type() === 'error' && h?.errors.push(`console (page 2): ${m.text()}`))
  p2.on('pageerror', (e) => h?.errors.push(`pageerror (page 2): ${e.message}`))
  await p2.goto(h.origin)
  const p2Toggle = await expandAgent(p2)
  await row(p2, B).waitFor({ timeout: T })
  assert((await dotOn(p1, B).count()) === 0 && (await dotOn(p2, B).count()) === 0, 'a fresh chat shows an unread dot')
  ok(`chats A ${A} and B ${B}; page 1 looks at A, page 2 sits on the empty view`)

  // 2. B replies while nobody looks at it
  await replyWith('first-reply-b')
  await rpc(p2, 'chats:send', B, 'first message to B')
  await dotOn(p1, B).waitFor({ timeout: 30_000 })
  assert(await rowUnread(p1, B), "page 1's B row lacks the unread class")
  assert((await dotOn(p1, A).count()) === 0 && !(await rowUnread(p1, A)), 'A shows unread though nothing was sent there')
  const b1 = await metaOf(B)
  assert(
    typeof b1.replyAt === 'number' && b1.seenAt === undefined,
    `chats.json has B as ${JSON.stringify({ replyAt: b1.replyAt, seenAt: b1.seenAt })}`
  )
  ok('B unread on page 1: dot and unread class; chats.json has replyAt and no seenAt')

  // 3. the second device sees it too, and a collapsed agent rolls it up
  await dotOn(p2, B).waitFor({ timeout: T })
  await p2Toggle.click()
  await p2.locator(tid('agent-unread-dot')).waitFor({ timeout: T })
  await p2Toggle.click()
  await row(p2, B).waitFor({ timeout: T })
  assert((await p2.locator(tid('agent-unread-dot')).count()) === 0, 'the agent dot stays while the agent is open')
  ok("page 2 shows B's dot; collapsed, the agent row shows agent-unread-dot")

  // 4. page 1 opens B: read on both pages, and no New line, since B was never seen
  await row(p1, B).click()
  await p1.waitForURL(new RegExp(`/chat/${B}$`), { timeout: T })
  await p1.locator(tid('agent-turn')).filter({ hasText: 'first-reply-b' }).waitFor({ timeout: T })
  await waitFor(async () => (await dotOn(p1, B).count()) === 0 && !(await rowUnread(p1, B)), T, "page 1's B dot to go")
  await waitFor(async () => (await dotOn(p2, B).count()) === 0 && !(await rowUnread(p2, B)), T, "page 2's B dot to go")
  const b2 = await metaOf(B)
  assert(
    typeof b2.seenAt === 'number' && b2.seenAt >= b2.replyAt,
    `chats.json has B as ${JSON.stringify({ replyAt: b2.replyAt, seenAt: b2.seenAt })}`
  )
  assert((await p1.locator(tid('new-line')).count()) === 0, 'a New line shows in a chat never seen before')
  ok('opening B clears the dot on both pages; seenAt stored; no New line')

  // 5. back to A; B replies again; opening B shows the New line right above the second reply
  await row(p1, A).click()
  await p1.waitForURL(new RegExp(`/chat/${A}$`), { timeout: T })
  await replyWith('second-reply-b')
  await rpc(p2, 'chats:send', B, 'second message to B')
  await dotOn(p1, B).waitFor({ timeout: 30_000 })
  await dotOn(p2, B).waitFor({ timeout: T })
  await row(p1, B).click()
  await p1.waitForURL(new RegExp(`/chat/${B}$`), { timeout: T })
  await p1.locator(tid('new-line')).waitFor({ timeout: T })
  const around = await p1.evaluate(() => {
    const lines = document.querySelectorAll('[data-testid="new-line"]')
    const line = lines[0]
    const turns = [...document.querySelectorAll('[data-testid="agent-turn"]')]
    const first = turns.find((t) => t.textContent.includes('first-reply-b'))
    return {
      count: lines.length,
      next: line.nextElementSibling?.getAttribute('data-testid') ?? null,
      nextText: line.nextElementSibling?.textContent ?? '',
      prevText: line.previousElementSibling?.textContent ?? '',
      firstBefore: first !== undefined && Boolean(first.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING)
    }
  })
  assert(around.count === 1, `${around.count} New lines`)
  assert(
    around.next === 'agent-turn' && around.nextText.includes('second-reply-b') && !around.nextText.includes('first-reply-b'),
    `the New line is not right above the second reply's group (next: ${around.next}, "${around.nextText}")`
  )
  assert(around.prevText.includes('second message to B'), `the New line does not follow the second message (prev: "${around.prevText}")`)
  assert(around.firstBefore, 'the first reply is not above the New line')
  await waitFor(
    async () => (await dotOn(p1, B).count()) === 0 && (await dotOn(p2, B).count()) === 0,
    T,
    "B's dots to go after the second open"
  )
  ok('the New line sits between the second message and the second reply; dots gone on both pages')

  // 6. a reply that ends in the chat on screen is never unread
  await row(p1, A).click()
  await p1.waitForURL(new RegExp(`/chat/${A}$`), { timeout: T })
  await replyWith('reply-in-a')
  await p1.locator(tid('composer-input')).click()
  await p1.locator(tid('composer-input')).fill('message in A')
  await p1.locator(tid('send-button')).click()
  assert(await looking(p1), 'page 1 is not visible and focused')
  await p1.locator(tid('agent-turn')).filter({ hasText: 'reply-in-a' }).waitFor({ timeout: 30_000 })
  await waitFor(async () => typeof (await metaOf(A))?.replyAt === 'number', T, "A's replyAt")
  const end = Date.now() + 2_000
  while (Date.now() < end) {
    assert((await dotOn(p1, A).count()) === 0 && !(await rowUnread(p1, A)), 'A shows unread on page 1 though it is on screen')
    assert((await dotOn(p2, A).count()) === 0, 'A shows unread on page 2 though page 1 is on it')
    await sleep(100)
  }
  const a = await metaOf(A)
  assert(a.seenAt === a.replyAt, `chats.json has A as ${JSON.stringify({ replyAt: a.replyAt, seenAt: a.seenAt })}`)
  assert((await p1.locator(tid('new-line')).count()) === 0, 'a New line shows in the chat on screen')
  ok('a reply in the chat on screen never shows a dot for 2 s; seenAt equals replyAt')

  // 7. Mark unread on A's reply while A stays on screen: dots on both pages and the New line above that reply at once
  const msgA = p1.locator(tid('agent-message')).filter({ hasText: 'reply-in-a' })
  await msgA.hover()
  await msgA.locator(tid('mark-unread-button')).click()
  await dotOn(p1, A).waitFor({ timeout: T })
  await dotOn(p2, A).waitFor({ timeout: T })
  await p1.locator(tid('new-line')).waitFor({ timeout: T })
  const lineNext = () => p1.evaluate(() => document.querySelector('[data-testid="new-line"]')?.nextElementSibling?.textContent ?? '')
  assert((await lineNext()).includes('reply-in-a'), `the New line is not above the marked reply ("${await lineNext()}")`)
  assert(new URL(p1.url()).pathname === `/chat/${A}`, `page 1 left A for ${p1.url()}`)
  const marked = await metaOf(A)
  assert(
    marked.mark && marked.mark.at > (marked.seenAt ?? 0),
    `chats.json has A as ${JSON.stringify({ seenAt: marked.seenAt, mark: marked.mark })}`
  )
  ok('Mark unread keeps page 1 on A, lights A on both pages and shows the New line above the reply')

  // 8. a refocus is not an open: page 1 blurs and comes back to A, and the mark stays
  await p1.evaluate(() => {
    document.hasFocus = () => false
    window.dispatchEvent(new Event('blur'))
  })
  await sleep(500)
  await p1.evaluate(() => {
    delete document.hasFocus
    window.dispatchEvent(new Event('focus'))
  })
  await p1.locator(tid('composer-input')).click()
  assert(await looking(p1), 'page 1 is not visible and focused after the refocus')
  const held = Date.now() + 2_000
  while (Date.now() < held) {
    assert((await dotOn(p1, A).count()) === 1 && (await dotOn(p2, A).count()) === 1, 'the refocus cleared the mark')
    await sleep(100)
  }
  const kept = await metaOf(A)
  assert(
    kept.mark && kept.mark.at > (kept.seenAt ?? 0),
    `the refocus ended the mark: ${JSON.stringify({ seenAt: kept.seenAt, mark: kept.mark })}`
  )
  ok('a blur and refocus of page 1 on A keeps the mark for 2 s')

  // 9. opening A again ends it: dots go on both pages, and the New line stays on the marked reply for this visit
  await row(p1, B).click()
  await p1.waitForURL(new RegExp(`/chat/${B}$`), { timeout: T })
  await row(p1, A).click()
  await p1.waitForURL(new RegExp(`/chat/${A}$`), { timeout: T })
  await waitFor(async () => (await dotOn(p1, A).count()) === 0 && (await dotOn(p2, A).count()) === 0, T, "A's dots to go after the open")
  const cleared = await metaOf(A)
  assert(
    cleared.mark === undefined && cleared.seenAt > marked.mark.at,
    `chats.json has A as ${JSON.stringify({ seenAt: cleared.seenAt, mark: cleared.mark })}`
  )
  await p1.locator(tid('new-line')).waitFor({ timeout: T })
  assert((await lineNext()).includes('reply-in-a'), `after the open the New line is not above the marked reply ("${await lineNext()}")`)
  ok('reopening A clears the mark on both pages; the New line stays above the marked reply')

  // 10. nothing unexpected
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
console.log(failed ? 'e2e:unread FAILED' : 'e2e:unread passed')
process.exit(failed ? 1 : 0)
