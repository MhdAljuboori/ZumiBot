// End-to-end check of Edit, Resend, Fork and version switching in the built server + web UI (local mode, headless
// Chrome) against a FAKE claude WITH A MEMORY (backend/tests/fixtures/fake-memory-claude.mjs): it keeps a session per id,
// honours --resume, --resume-session-at and --fork-session like the real CLI did in the spec's spike, and answers
// "List every word" with the words its session was told to remember. No real CLI turn is sent, so no login or quota is used.
// The same pattern against the real claude is in web.e2e.mjs (npm run e2e). Usage: npm run e2e:versions   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME (the fake's sessions live in it),
//    agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - every server and Chrome started here is stopped in `finally`; overall timeout 4 min.
//
// DOM hooks relied on (data-testid): new-agent, new-menu-group, new-chat-members, new-chat-member-option (+ data-agent-name),
//   new-chat-folder, new-chat-choose-folder, agent-row (+ data-agent-name), composer-input, send-button, message-list,
//   user-message, agent-message, edit-button, resend-button, fork-button, message-editor, message-editor-input,
//   message-editor-send, mention-menu, mention-option (+ data-agent-name),
//   version-switcher (.version-label), version-prev, error-bubble, chat-row, group-row, unassigned-items,
//   context-chip (+ data-percent, title), context-popup, context-note, context-compact, context-member (+ data-agent-name).
// The context meter and Compact are checked here too: the fake reports 2000 tokens per session entry of a 20000 window.
// Stored state read: <dataDir>/chats.json (titles), <home>/.fake-sessions/*.json (what the fake's sessions hold).
//
// Replies are the fake's own words ("OK", "Words: A, B"), so steps assert exact text.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start as startHarness, unexpectedErrors } from './harness.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-memory-claude.mjs', import.meta.url))
const MEM = 'e2e-memory'
const ALPHA = 'e2e-alpha'
const BETA = 'e2e-beta'
const LABEL = { [ALPHA]: 'E2e Alpha', [BETA]: 'E2e Beta' }
const PREFIX = 'zumibot-e2e-versions-'
const OVERALL_TIMEOUT = 4 * 60_000
const T = 20_000
const LIST = 'List every word'

let h = null
const made = []
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

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

// ---------- reading and waiting ----------

/** The open chat as a list in document order: user bubbles (with their `n / m` label), replies (with their author), errors, notices. */
const thread = (page) =>
  page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"]')
    if (!list) return []
    const sel = '.bubble.user, .bubble.assistant:not([data-streaming]), [data-testid="error-bubble"], .notice, [role="separator"]'
    return [...list.querySelectorAll(sel)].map((el) => {
      const text = el.textContent.trim()
      if (el.matches('.bubble.user')) {
        return {
          kind: 'user',
          text,
          ver: el.closest('[data-testid="user-message"]')?.querySelector('.version-label')?.textContent.trim() ?? null
        }
      }
      if (el.matches('.bubble.assistant'))
        return {
          kind: 'reply',
          text,
          agent: el.closest('[data-testid="agent-turn"]')?.querySelector('.agent-turn-name')?.textContent.trim() ?? ''
        }
      if (el.matches('[data-testid="error-bubble"]')) return { kind: 'error', text }
      return { kind: 'notice', text }
    })
  })
const summary = (t) =>
  t.map((e) => `${e.kind}${e.ver ? `[${e.ver}]` : ''}${e.agent ? `(${e.agent})` : ''}:${JSON.stringify(e.text)}`).join(' > ')

/** Polls the thread until `fn(thread)` is truthy, then returns the thread. An error bubble fails fast unless `allowError`. */
async function poll(page, fn, what, { timeout = T, allowError = false } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    const t = await thread(page)
    const err = t.find((e) => e.kind === 'error')
    if (err && !allowError) throw new Error(`ASSERT FAILED: an error bubble while waiting for ${what}: ${err.text}; thread: ${summary(t)}`)
    if (fn(t)) return t
    if (Date.now() > end) throw new Error(`ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}; thread: ${summary(t)}`)
    await sleep(120)
  }
}
/** Nothing is running: no live turn, no live bubble, no Stop button, no task waiting; seen on two reads 300 ms apart. */
async function idle(page) {
  const busy = () =>
    page.evaluate(() => {
      const b = document.querySelector('[data-testid="send-button"]')
      return (
        Boolean(document.querySelector('[data-testid="room-live"], [data-streaming]')) ||
        (b ? b.textContent.trim() !== 'Send' && b.textContent.trim() !== '' : false)
      )
    })
  const end = Date.now() + T
  for (;;) {
    if (!(await busy())) {
      await sleep(300)
      if (!(await busy())) return
    }
    if (Date.now() > end) throw new Error('ASSERT FAILED: the chat never went idle')
    await sleep(120)
  }
}

const repliesAfter = (t, userText) => {
  const at = t.map((e) => e.kind === 'user' && e.text.includes(userText)).lastIndexOf(true)
  return at < 0 ? [] : t.slice(at + 1).filter((e) => e.kind === 'reply')
}
const userBubble = (t, text) => t.find((e) => e.kind === 'user' && e.text.includes(text))
const texts = (t) => t.filter((e) => e.kind === 'user' || e.kind === 'reply').map((e) => e.text)

// ---------- UI actions ----------

const input = (page) => page.locator(tid('composer-input'))
/** Sends from the composer; resolves once the message is in the thread. `match` is the part of a mention message that shows as written. */
async function say(page, text, match = text) {
  const count = (t) => t.filter((e) => e.kind === 'user' && e.text.includes(match)).length
  const had = count(await thread(page))
  await input(page).fill(text)
  await page.locator(tid('send-button')).click()
  await poll(page, (t) => count(t) > had, `"${match}" to appear`)
}
const userMsg = (page, text) => page.locator(tid('user-message')).filter({ hasText: text }).last()
async function hoverIn(loc, testId) {
  await loc.hover()
  const btn = loc.locator(tid(testId))
  await btn.waitFor({ timeout: T })
  return btn
}
async function edit(page, oldText, newText) {
  const msg = userMsg(page, oldText)
  await (await hoverIn(msg, 'edit-button')).click()
  await page.locator(tid('message-editor-input')).fill(newText)
  await page.locator(tid('message-editor-send')).click()
  await page.locator(tid('message-editor')).waitFor({ state: 'detached', timeout: T })
}
const editorBox = (page) => page.locator(tid('message-editor-input'))
/** The names the edit box's `@` list offers once `typed` is in the box. */
async function editorMentions(page, typed) {
  await editorBox(page).fill(typed)
  const menu = page.locator(tid('message-editor')).locator(tid('mention-menu'))
  await menu.waitFor({ timeout: T })
  return menu.locator(tid('mention-option')).evaluateAll((els) => els.map((e) => e.getAttribute('data-agent-name')))
}
const step = async (page, userText, dir) => {
  await userMsg(page, userText)
    .locator(tid(dir < 0 ? 'version-prev' : 'version-next'))
    .click()
}
const chatIdOf = (page) => new URL(page.url()).pathname.replace(/^\/chat\//, '')
const chatsJson = async () => JSON.parse(await readFile(join(h.dataDir, 'chats.json'), 'utf8')).chats
const sessionFiles = async () => {
  const dir = join(h.root, 'home', '.fake-sessions')
  const names = await readdir(dir).catch(() => [])
  return Promise.all(names.map(async (n) => ({ id: n.replace(/\.json$/, ''), entries: JSON.parse(await readFile(join(dir, n), 'utf8')) })))
}

async function startApp(env = {}) {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const work = await mk('work')
  const agentsDir = await mk('agents')
  const dataDir = await mk('data')
  for (const name of [MEM, ALPHA, BETA]) {
    await writeFile(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: Versions e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
    )
  }
  await mkdir(work, { recursive: true })
  h = await startHarness({ fake: FAKE, dataDir, agentsDir, env: { ZUMIBOT_TEST_PICK_FOLDER: work, ...env } })
  await h.page.locator(tid('new-agent')).waitFor({ timeout: 30_000 })
  return h.page
}

async function pickFolder(page) {
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
}

/** Opens the single-chat agent's start screen, picks the folder and sends the first message. */
async function startSingle(page, first) {
  await page.locator(`${tid('agent-row')}[data-agent-name="${MEM}"]`).click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await pickFolder(page)
  await say(page, first)
  await page.waitForURL(/\/chat\//, { timeout: T })
  return chatIdOf(page)
}

// ---------- single chat ----------

async function singleChat() {
  const page = await startApp()
  const id = await startSingle(page, 'Remember the word APPLE.')
  await poll(page, (t) => repliesAfter(t, 'APPLE')[0]?.text === 'OK', 'the reply to APPLE')
  await idle(page)
  await say(page, 'Remember the word BANANA.')
  await poll(page, (t) => repliesAfter(t, 'BANANA')[0]?.text === 'OK', 'the reply to BANANA')
  await idle(page)
  ok('APPLE and BANANA are remembered (two plain turns)')

  // The edit box offers the composer's `@` list: the agents this chat can ask (not its own, no everyone); Esc closes the
  // list and leaves the box open.
  await (await hoverIn(userMsg(page, 'BANANA'), 'edit-button')).click()
  const asked = await editorMentions(page, 'Remember the word BANANA. @')
  assert(same(asked, [ALPHA, BETA]), `the edit box's @ list in a single chat offers ${JSON.stringify(asked)}`)
  await editorBox(page).press('Escape')
  await page.locator(tid('mention-menu')).waitFor({ state: 'detached', timeout: T })
  assert(await page.locator(tid('message-editor')).isVisible(), 'Esc on the @ list closed the edit box')
  await page.locator(tid('message-editor-cancel')).click()
  await page.locator(tid('message-editor')).waitFor({ state: 'detached', timeout: T })
  ok(`the edit box's @ list offers ${JSON.stringify(asked)}, and Esc closes only the list`)

  // Edit BANANA -> CHERRY: a second version, shown; the agent remembers APPLE and CHERRY only.
  await edit(page, 'BANANA', 'Remember the word CHERRY.')
  let t = await poll(
    page,
    (th) => userBubble(th, 'CHERRY')?.ver === '2 / 2' && repliesAfter(th, 'CHERRY')[0]?.text === 'OK',
    'the edited version and its reply'
  )
  assert(!userBubble(t, 'BANANA'), `BANANA is still visible after the edit: ${summary(t)}`)
  await idle(page)
  await say(page, LIST)
  t = await poll(page, (th) => repliesAfter(th, LIST)[0], 'the list after the edit')
  assert(
    repliesAfter(t, LIST)[0].text === 'Words: APPLE, CHERRY',
    `after the edit the agent listed ${JSON.stringify(repliesAfter(t, LIST)[0].text)}`
  )
  await idle(page)
  ok('edit BANANA to CHERRY: 2 / 2, and the agent lists APPLE, CHERRY')

  // Switch back: version 1, BANANA is back, CHERRY and the list are gone, the agent remembers BANANA.
  await step(page, 'CHERRY', -1)
  t = await poll(page, (th) => userBubble(th, 'BANANA')?.ver === '1 / 2', 'version 1 to come back')
  assert(!userBubble(t, 'CHERRY') && !userBubble(t, LIST), `version 2 is still visible after switching back: ${summary(t)}`)
  assert(repliesAfter(t, 'BANANA')[0]?.text === 'OK', `the reply to BANANA is missing: ${summary(t)}`)
  await idle(page)
  await say(page, LIST)
  t = await poll(page, (th) => repliesAfter(th, LIST)[0], 'the list after switching back')
  assert(
    repliesAfter(t, LIST)[0].text === 'Words: APPLE, BANANA',
    `after switching back the agent listed ${JSON.stringify(repliesAfter(t, LIST)[0].text)}`
  )
  await idle(page)
  ok('switch back: 1 / 2, BANANA shown, and the agent lists APPLE, BANANA')

  // A reload and a second tab show the same version and replies.
  const before = await thread(page)
  await page.reload()
  await poll(page, (th) => same(th, before), 'the reloaded chat to match')
  const tab = await h.newPage()
  await tab.goto(`${h.origin}/chat/${id}`)
  await poll(tab, (th) => same(th, before), 'the second tab to match')
  await tab.close()
  ok('reload and a second tab show the same version and replies')

  // Resend on the latest answer resends the list message above it: a second version of it.
  const latest = page.locator(tid('agent-message')).last()
  await (await hoverIn(latest, 'resend-button')).click()
  t = await poll(
    page,
    (th) => userBubble(th, LIST)?.ver === '2 / 2' && repliesAfter(th, LIST)[0]?.text === 'Words: APPLE, BANANA',
    'the resent list message'
  )
  await idle(page)
  assert(userBubble(t, 'BANANA').ver === '1 / 2', `BANANA lost its version label: ${summary(t)}`)
  ok('Resend on the latest answer: 2 / 2 on the list message, same words')

  // Fork on the BANANA answer: a new chat "Fork of ..." holding the chat up to there; its agent remembers APPLE, BANANA.
  const answers = page.locator(tid('agent-message'))
  const bananaAnswer = answers.nth(1)
  assert((await bananaAnswer.textContent()).includes('OK'), 'the second answer is not the reply to BANANA')
  await (await hoverIn(bananaAnswer, 'fork-button')).click()
  await page.waitForFunction((from) => location.pathname.startsWith('/chat/') && location.pathname !== `/chat/${from}`, id, { timeout: T })
  const forkId = chatIdOf(page)
  const forkMeta = (await chatsJson()).find((c) => c.id === forkId)
  assert(forkMeta?.title?.startsWith('Fork of '), `the fork is titled ${JSON.stringify(forkMeta?.title)}`)
  t = await poll(page, (th) => texts(th).length === 4, 'the fork to show its four messages')
  assert(same(texts(t), ['Remember the word APPLE.', 'OK', 'Remember the word BANANA.', 'OK']), `the fork holds ${summary(t)}`)
  assert(await page.locator(tid('chat-row')).filter({ hasText: 'Fork of ' }).first().isVisible(), 'no sidebar row reads "Fork of ..."')
  await say(page, LIST)
  t = await poll(page, (th) => repliesAfter(th, LIST)[0], 'the list in the fork')
  assert(
    repliesAfter(t, LIST)[0].text === 'Words: APPLE, BANANA',
    `the fork's agent listed ${JSON.stringify(repliesAfter(t, LIST)[0].text)}`
  )
  await idle(page)
  ok(`Fork on the BANANA answer: "${forkMeta.title}", and its agent lists APPLE, BANANA`)

  // The original is untouched by the fork: still on version 2 of the list, BANANA at 1 / 2.
  await page.goto(`${h.origin}/chat/${id}`)
  t = await poll(page, (th) => userBubble(th, LIST)?.ver === '2 / 2', 'the original chat to reopen')
  assert(userBubble(t, 'BANANA').ver === '1 / 2', `the original lost its BANANA version: ${summary(t)}`)

  // Fork on the BANANA user message: only APPLE's turn is copied, and BANANA waits in the composer.
  await (await hoverIn(userMsg(page, 'BANANA'), 'fork-button')).click()
  await page.waitForFunction((from) => location.pathname.startsWith('/chat/') && location.pathname !== `/chat/${from}`, id, { timeout: T })
  t = await poll(page, (th) => texts(th).length === 2, 'the second fork to show its two messages')
  assert(same(texts(t), ['Remember the word APPLE.', 'OK']), `the user-message fork holds ${summary(t)}`)
  await page.waitForFunction(
    () => document.querySelector('[data-testid="composer-input"]')?.textContent.trim() === 'Remember the word BANANA.',
    null,
    { timeout: T }
  )
  ok('Fork on the BANANA message: only APPLE copied, composer holds "Remember the word BANANA."')

  // The fake never saw a second version written into an older session: every session keeps its own words.
  const sessions = await sessionFiles()
  const userWords = (s) =>
    s.entries.filter((e) => e.role === 'user').flatMap((e) => [...e.text.matchAll(/remember the word (\w+)/gi)].map((m) => m[1]))
  assert(
    sessions.every((s) => !(userWords(s).includes('CHERRY') && userWords(s).includes('BANANA'))),
    'a session holds both BANANA and CHERRY: a fork wrote into the wrong session'
  )
  ok('no session holds both BANANA and CHERRY')

  const bad = unexpectedErrors(h.errors, [])
  assert(bad.length === 0, `unexpected errors: ${bad.join(' | ')}`)
  ok('single chat: no console or server errors')
  await stop()
}

// ---------- context meter and Compact ----------

const chip = (page) => page.locator(tid('context-chip'))
/** Waits until the ring's percent (data-percent) is `percent`; returns its title. */
async function ringAt(page, percent) {
  await page
    .waitForFunction((p) => document.querySelector('[data-testid="context-chip"]')?.getAttribute('data-percent') === String(p), percent, {
      timeout: T
    })
    .catch(async () => {
      throw new Error(
        `ASSERT FAILED: the ring never read ${percent}%: ${await chip(page)
          .getAttribute('data-tip')
          .catch(() => 'no ring')}`
      )
    })
  return chip(page).getAttribute('data-tip')
}
const warns = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="context-chip"] .context-ring')?.classList.contains('warn') ?? false)

async function contextMeter() {
  const page = await startApp()
  assert((await chip(page).count()) === 0, 'a ring shows before any chat ran')
  await startSingle(page, 'Remember the word APPLE.')
  await poll(page, (t) => repliesAfter(t, 'APPLE')[0]?.text === 'OK', 'the reply to APPLE')
  await idle(page)
  assert((await ringAt(page, 20)) === 'Context 20% · 4K / 20K', `the ring's title reads ${await chip(page).getAttribute('data-tip')}`)
  assert(!(await warns(page)), 'the ring is amber at 20%')
  for (const w of ['BANANA', 'CHERRY', 'DATE']) {
    await say(page, `Remember the word ${w}.`)
    await poll(page, (t) => repliesAfter(t, w)[0]?.text === 'OK', `the reply to ${w}`)
    await idle(page)
  }
  await ringAt(page, 80)
  assert(await warns(page), 'the ring is not amber at 80%')
  ok('the ring fills with each turn (20% → 80%) and turns amber near full')

  const before = texts(await thread(page))
  await chip(page).click()
  await page.locator(tid('context-popup')).waitFor({ timeout: T })
  await page.locator(tid('context-note')).fill('keep the fruit')
  await page.locator(tid('context-compact')).click()
  await page.locator('.working').filter({ hasText: 'Compacting…' }).waitFor({ timeout: T })
  await idle(page)
  assert(
    (await ringAt(page, 0)) === 'Compacted 16K → 500 · exact size after the next reply',
    `after compacting the ring reads ${await chip(page).getAttribute('data-tip')}`
  )
  assert(same(texts(await thread(page)), before), 'compacting added or removed messages')
  const sessions = await sessionFiles()
  assert(
    sessions.some((x) => x.entries.length === 1 && /Focus: keep the fruit/.test(x.entries[0].text)),
    'no session was compacted with the note'
  )
  ok('Compact now: "Compacting…" while it runs, then an empty ring, the note reached the CLI, no message added')

  await say(page, LIST)
  const t = await poll(page, (th) => repliesAfter(th, LIST)[0], 'the list after compacting')
  assert(
    repliesAfter(t, LIST)[0].text === 'Words: APPLE, BANANA, CHERRY, DATE',
    `after compacting the agent listed ${JSON.stringify(repliesAfter(t, LIST)[0].text)}`
  )
  await idle(page)
  await ringAt(page, 30)
  await page.reload()
  await ringAt(page, 30)
  ok('the next reply refills the ring (30%), the agent still remembers, and a reload keeps the ring')

  const bad = unexpectedErrors(h.errors, [])
  assert(bad.length === 0, `unexpected errors: ${bad.join(' | ')}`)
  ok('context meter: no console or server errors')
  await stop()
}

// ---------- room ----------

async function room() {
  const page = await startApp()
  await page.locator(tid('new-agent')).click()
  await page.locator(tid('new-menu-group')).click()
  await page.locator(tid('new-chat-members')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-members')).click()
  for (const n of [ALPHA, BETA]) await page.locator(`${tid('new-chat-member-option')}[data-agent-name="${n}"]`).click()
  await page.keyboard.press('Escape')
  await pickFolder(page)
  const reply = (t, text, agent) => repliesAfter(t, text).find((e) => e.agent === LABEL[agent])

  await say(page, `@${ALPHA} Remember the word APPLE.`, 'Remember the word APPLE.')
  await poll(page, (t) => reply(t, 'APPLE', ALPHA)?.text === 'OK', 'alpha to answer APPLE')
  await idle(page)
  await say(page, `@${BETA} Remember the word BANANA.`, 'Remember the word BANANA.')
  await poll(page, (t) => reply(t, 'BANANA', BETA)?.text === 'OK', 'beta to answer BANANA')
  await idle(page)

  // The edit is written through the edit box's `@` list: everyone first, then the members; Enter picks, it does not send.
  await (await hoverIn(userMsg(page, 'BANANA'), 'edit-button')).click()
  const all = await editorMentions(page, '@')
  assert(same(all, ['everyone', ALPHA, BETA]), `the edit box's @ list in a room offers ${JSON.stringify(all)}`)
  const some = await editorMentions(page, '@e2e-b')
  assert(same(some, [BETA]), `the edit box's @ list for "e2e-b" offers ${JSON.stringify(some)}`)
  await editorBox(page).press('Enter')
  await page.locator(tid('mention-menu')).waitFor({ state: 'detached', timeout: T })
  await editorBox(page).pressSequentially('Remember the word CHERRY.')
  // The draft's text: on screen the mention reads by its display name.
  const written = await editorBox(page).evaluate((el) => el.editor.getText())
  assert(written === `@${BETA} Remember the word CHERRY.`, `the picked mention left ${JSON.stringify(written)} in the edit box`)
  await page.locator(tid('message-editor-send')).click()
  await page.locator(tid('message-editor')).waitFor({ state: 'detached', timeout: T })
  ok(`room: the edit box's @ list offers ${JSON.stringify(all)}, and its pick is written in`)
  await poll(
    page,
    (t) => userBubble(t, 'CHERRY')?.ver === '2 / 2' && reply(t, 'CHERRY', BETA)?.text === 'OK',
    "the edited room message and beta's reply"
  )
  await idle(page)
  await say(page, `@${ALPHA} @${BETA} ${LIST}`, LIST)
  let t = await poll(page, (th) => reply(th, LIST, ALPHA) && reply(th, LIST, BETA), 'both members to list after the edit')
  assert(reply(t, LIST, ALPHA).text === 'Words: APPLE, CHERRY', `after the edit alpha listed ${JSON.stringify(reply(t, LIST, ALPHA).text)}`)
  assert(reply(t, LIST, BETA).text === 'Words: APPLE, CHERRY', `after the edit beta listed ${JSON.stringify(reply(t, LIST, BETA).text)}`)
  await idle(page)
  ok('room: edit BANANA to CHERRY, both mentioned members list APPLE, CHERRY')

  await step(page, 'CHERRY', -1)
  t = await poll(page, (th) => userBubble(th, 'BANANA')?.ver === '1 / 2', 'version 1 of the room message')
  assert(!userBubble(t, 'CHERRY') && !userBubble(t, LIST), `version 2 is still visible after switching back: ${summary(t)}`)
  await idle(page)
  await say(page, `@${ALPHA} @${BETA} ${LIST}`, LIST)
  t = await poll(page, (th) => reply(th, LIST, ALPHA) && reply(th, LIST, BETA), 'both members to list after switching back')
  assert(
    reply(t, LIST, ALPHA).text === 'Words: APPLE, BANANA',
    `after switching back alpha listed ${JSON.stringify(reply(t, LIST, ALPHA).text)}`
  )
  assert(
    reply(t, LIST, BETA).text === 'Words: APPLE, BANANA',
    `after switching back beta listed ${JSON.stringify(reply(t, LIST, BETA).text)}`
  )
  ok('room: switching back, both mentioned members list APPLE, BANANA')

  // The ring shows the fullest member; its popover compacts one member only.
  await idle(page)
  await chip(page).waitFor({ timeout: T })
  await chip(page).click()
  const member = (name) => page.locator(`${tid('context-member')}[data-agent-name="${name}"]`)
  await member(ALPHA).waitFor({ timeout: T })
  assert((await page.locator(tid('context-member')).count()) === 2, 'the room popover does not list both members')
  await member(ALPHA).locator(tid('context-compact')).click()
  await idle(page)
  await page.waitForFunction(
    () => /^Context /.test(document.querySelector('[data-testid="context-chip"]')?.getAttribute('data-tip') ?? ''),
    null,
    { timeout: T }
  )
  await chip(page).click()
  await page.waitForFunction(
    (n) =>
      document.querySelector(`[data-testid="context-member"][data-agent-name="${n}"] .context-member-use`)?.textContent === 'compacted',
    ALPHA,
    { timeout: T }
  )
  assert(/%$/.test(await member(BETA).locator('.context-member-use').textContent()), "beta's meter changed when only alpha compacted")
  await page.keyboard.press('Escape')
  ok('room: the popover lists both members, and Compact on alpha compacts alpha only')

  const bad = unexpectedErrors(h.errors, [])
  assert(bad.length === 0, `unexpected errors: ${bad.join(' | ')}`)
  ok('room: no console or server errors')
  await stop()
}

// ---------- the CLI ignores --fork-session ----------

async function forkIgnored() {
  const page = await startApp({ FAKE_MEMORY_IGNORE_FORK: '1' })
  await startSingle(page, 'Remember the word APPLE.')
  await poll(page, (t) => repliesAfter(t, 'APPLE')[0]?.text === 'OK', 'the reply to APPLE')
  await idle(page)
  await say(page, 'Remember the word BANANA.')
  await poll(page, (t) => repliesAfter(t, 'BANANA')[0]?.text === 'OK', 'the reply to BANANA')
  await idle(page)

  await edit(page, 'BANANA', 'Remember the word CHERRY.')
  const t = await poll(page, (th) => th.find((e) => e.kind === 'error'), 'the FORK_IGNORED error', { allowError: true })
  const err = t.find((e) => e.kind === 'error').text
  assert(
    /ignored --fork-session/.test(err) && err.includes('fake'),
    `the error does not name the problem and the CLI version: ${JSON.stringify(err)}`
  )
  await idle(page)
  // The run was stopped before the fake wrote anything: no session ever heard CHERRY.
  const heard = (await sessionFiles()).filter((s) => s.entries.some((e) => /CHERRY/.test(e.text)))
  assert(heard.length === 0, `${heard.length} session file(s) hold CHERRY although --fork-session was ignored`)
  ok('--fork-session ignored: the edit shows the FORK_IGNORED error and no session was written')
  await stop()
}

const timer = setTimeout(() => {
  console.error('FAIL overall timeout')
  void stop().finally(() => process.exit(1))
}, OVERALL_TIMEOUT)
timer.unref()

let failed = false
try {
  await singleChat()
  await contextMeter()
  await room()
  await forkIgnored()
} catch (err) {
  failed = true
  console.error(`FAIL ${err instanceof Error ? err.message : err}`)
} finally {
  await stop()
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
console.log(failed ? 'e2e:versions FAILED' : 'e2e:versions passed')
process.exit(failed ? 1 : 0)
