// End-to-end check of voice input (dictation) in the built server + web UI (local mode) against the FAKE claude and a
// fake transcription endpoint: no real CLI turn and no OpenRouter call is ever made, so no login, quota or key is used.
// Usage: npm run e2e:voice   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server, Chrome and the fake transcription server started here are stopped in `finally`; overall timeout 3 min.
// Chrome runs with a fake mic (--use-fake-device-for-media-stream: a real MediaRecorder clip) playing fixtures/mic-loop.wav
// (--use-file-for-fake-audio-capture: 0.8 s of tone, then 2.4 s of faint noise, looping, so the talk's endpointer sees speech
// and then a pause; the default fake tone never stops) and the permission prompt auto-accepted (--use-fake-ui-for-media-stream). ZUMIBOT_TEST_VOICE_URL points the server at a
// local fake OpenRouter that records each request and answers transcriptions from a queue each step fills; it answers nothing
// else, so a speech or summary call (voice no longer speaks) would show up as an unexpected path (case 17, the voice request:
// the page at /voice, the new voice chat, the chat opened). An init script keeps every
// track getUserMedia hands out in window.__tracks, so a released mic is checked by its readyState. A reply that keeps
// running comes from a can_use_tool control_request plus #WAIT_RESPONSE in the fake claude's script.
//
// DOM hooks relied on (data-testid): dictation-button (+ data-phase), dictation-strip, dictation-lang, dictation-error,
//   composer-input, send-button, new-chat-agent, new-chat-agent-option (+ data-agent-name), new-chat-folder,
//   new-chat-choose-folder, agent-row (+ data-agent-name), chat-row (+ data-chat-id), new-agent, new-menu-group,
//   new-chat-members, new-chat-member-option (+ data-agent-name), command-menu, mention-menu, user-message, edit-button,
//   message-editor, message-editor-input, message-editor-send, message-editor-cancel, version-switcher (its
//   `.version-label`), approval-card, approval-allow-once, task-row (its `.task-text`), new-chat. The composer's dictation hooks are scoped to `.composer`, the edit box's to message-editor. Also the
//   composer's polite live region (`.composer > [role=status]`), the sidebar row's "Reply running" spinner, and the
//   Tiptap editor Tiptap hangs on composer-input (`el.editor`, to read the caret the insert will use).
// Stored state read: <dataDir>/chats.json (queued tasks). Written: <dataDir>/voice.json (before start, and to switch off).

import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort, start, unexpectedErrors } from './harness.mjs'

const BASIC = fileURLToPath(new URL('../backend/tests/fixtures/stream/basic.jsonl', import.meta.url))
const PREFIX = 'zumibot-e2e-voice-'
const OVERALL_TIMEOUT = 6 * 60_000
const T = 15_000
const AGENT = 'vc'
const OTHER = 'editor' // in a room, `@ed` matches it, so the mention menu could open
const KEY = 'e2e-dummy-key'
const ARABIC = 'مرحبا بكم'
const TX_PATH = '/api/v1/audio/transcriptions'
const MIC_LOOP = fileURLToPath(new URL('./fixtures/mic-loop.wav', import.meta.url))
const REPLY = 'Done, Friday 3:30 with Obada.'
const BLOCKED = "Microphone is blocked. Allow it in the browser's site settings."
const FAILED = 'Transcription failed. Try again.'
const EMPTY = "Didn't catch anything."

let h = null
let fake = null
const made = [] // every mkdtemp dir made here
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const readJson = (name) => readFile(join(h.dataDir, name), 'utf8').then(JSON.parse)

async function waitFor(fn, timeout, what) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}`)
}

async function stop() {
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
  if (fake) {
    const f = fake
    fake = null
    f.server.closeAllConnections()
    await new Promise((r) => f.server.close(r))
  }
}

// ---------- the fake OpenRouter: records every request, answers transcriptions from `queue` ({text}, {status}, {delayMs}) ----------
async function startFakeOpenRouter() {
  const port = await freePort()
  const got = []
  const queue = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let json = null
      try {
        json = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        /* recorded as null */
      }
      const rec = { method: req.method, path: req.url, headers: req.headers, json, aborted: false }
      got.push(rec)
      res.on('close', () => {
        if (!res.writableFinished) rec.aborted = true
      })
      // An answer nobody queued shows up in a box, so a stray request can't pass unseen.
      const a = req.method === 'POST' && req.url === TX_PATH ? (queue.shift() ?? { text: 'UNQUEUED' }) : { status: 404 }
      const answer = () => {
        if (res.destroyed) return
        res.writeHead(a.status ?? 200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(a.status ? { error: { message: 'fake failure' } } : { text: a.text }))
      }
      if (a.delayMs) setTimeout(answer, a.delayMs)
      else answer()
    })
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${port}`, server, got, queue }
}

// ---------- init scripts (serialised into every page of their context) ----------
function trackMic() {
  window.__tracks = []
  window.__asked = []
  const md = navigator.mediaDevices
  if (!md?.getUserMedia) return
  const real = md.getUserMedia.bind(md)
  md.getUserMedia = async (c) => {
    window.__asked.push(JSON.stringify(c))
    const s = await real(c)
    window.__tracks.push(...s.getTracks())
    return s
  }
}
function blockMic() {
  // A page's first about:blank is no secure context, so it has no mediaDevices.
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('x', 'NotAllowedError'))
}
function holdMic() {
  // The grant waits for window.__grant(), like a permission prompt answered later; the tracks are kept as in trackMic.
  window.__tracks = []
  const md = navigator.mediaDevices
  if (!md?.getUserMedia) return
  const real = md.getUserMedia.bind(md)
  let grant
  const granted = new Promise((r) => (grant = r))
  window.__grant = () => grant()
  md.getUserMedia = async (c) => {
    const s = await real(c)
    window.__tracks.push(...s.getTracks())
    await granted
    return s
  }
}

// One raw RPC over a fresh /ws socket from the page, so the cb_local cookie rides along.
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

// ---------- UI helpers; `u` is { page, press } so the phone taps where the desktop clicks ----------
const COMPOSER = '.composer'
const EDITOR = tid('message-editor')
const mic = (page, scope = COMPOSER) => page.locator(`${scope} ${tid('dictation-button')}`)
const strip = (page, scope = COMPOSER) => page.locator(`${scope} ${tid('dictation-strip')}`)
const voiceError = (page, scope = COMPOSER) => page.locator(`${scope} ${tid('dictation-error')}`)
const composer = (page) => page.locator(tid('composer-input'))
const sendButton = (page) => page.locator(tid('send-button'))
// A non-breaking space is what the editor may use for a trailing space.
const draftText = async (page) => (await composer(page).evaluate((el) => el.textContent)).replace(/\u00a0/g, ' ')
const phaseOf = (page, scope) => mic(page, scope).getAttribute('data-phase')
const waitPhase = (page, scope, phase) => waitFor(async () => (await phaseOf(page, scope)) === phase, T, `the mic to be ${phase}`)
const tracks = (page) => page.evaluate(() => window.__tracks.map((t) => t.readyState))
const userMessages = (page, text) => page.locator(tid('user-message')).filter({ hasText: text })
const chatMeta = async (chatId) => (await readJson('chats.json')).chats.find((c) => c.id === chatId)
const sendState = (page) =>
  sendButton(page).evaluate((b) => ({ label: b.textContent.trim(), stop: b.classList.contains('stop'), disabled: b.disabled }))
const focusedTestId = (page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)

/** Waits for the composer to read `expected`; a timeout says what it read. */
async function waitBox(page, expected, what) {
  let last = null
  await waitFor(async () => (last = await draftText(page)) === expected, T, what).catch((e) => {
    throw new Error(`${e.message} (it reads ${JSON.stringify(last)})`)
  })
}

/** The listening strip's time, in whole seconds. */
async function elapsed(page, scope) {
  const t = await strip(page, scope)
    .locator('.dictation-time')
    .textContent()
    .catch(() => null)
  const m = /^(\d+):(\d\d)$/.exec(t?.trim() ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1
}

/** Starts a dictation and waits past 0:01, so the clip is over the 0.6 s minimum. */
async function listen(u, scope = COMPOSER) {
  await u.press(mic(u.page, scope))
  await waitPhase(u.page, scope, 'listening')
  await waitFor(async () => (await elapsed(u.page, scope)) >= 1, T, 'the strip time to pass 0:01')
}

/** Taps the mic to stop, with `answer` queued for the fake; returns the request the fake got. */
async function stopWith(u, answer, scope = COMPOSER) {
  const n = fake.got.length
  fake.queue.push(answer)
  await u.press(mic(u.page, scope))
  await waitFor(async () => fake.got.length === n + 1, T, 'the clip to reach the fake')
  await waitPhase(u.page, scope, 'idle')
  return fake.got.at(-1)
}

async function clearComposer(u) {
  await u.press(composer(u.page))
  await u.page.keyboard.press('Control+A')
  await u.page.keyboard.press('Backspace')
  await waitFor(async () => (await draftText(u.page)) === '', T, 'the composer to be empty')
}

async function pickFolder(page, pickDir) {
  await page.click(tid('new-chat-folder'))
  await page.click(tid('new-chat-choose-folder'))
  await waitFor(async () => (await page.locator(tid('new-chat-folder')).getAttribute('data-tip')) === pickDir, T, 'the folder to be set')
}

/** The reply has ended: `assistants` agent bubbles are in and the empty box's button is Send again. */
const replyDone = (page, assistants) =>
  waitFor(
    async () => (await page.locator('.bubble.assistant').count()) >= assistants && !(await sendState(page)).stop,
    30_000,
    'the reply to end'
  )

const chatIdOf = (page) => decodeURIComponent(new URL(page.url()).pathname.split('/').pop())

/** The fake claude's script with a tool request it waits on, so the reply keeps running until the card is answered. */
async function scriptWaiting(id) {
  const lines = (await readFile(BASIC, 'utf8')).split('\n').filter(Boolean)
  const req = {
    type: 'control_request',
    request_id: id,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Bash',
      input: { command: 'ls' },
      description: 'List files',
      decision_reason: 'needs approval',
      tool_use_id: `toolu_${id}`
    }
  }
  const out = lines.flatMap((l) => {
    const j = JSON.parse(l)
    return j.type === 'stream_event' && j.event?.delta?.type === 'text_delta' ? [JSON.stringify(req), `#WAIT_RESPONSE ${id}`, l] : [l]
  })
  await writeFile(h.script, out.join('\n') + '\n')
}
const scriptBasic = async () => writeFile(h.script, await readFile(BASIC, 'utf8'))

/** Where a block's text sits in its content box: px left free on each side. `widen` first makes room in a shrink-wrapped block. */
const textSides = (loc, widen = 0) =>
  loc.evaluate((el, widen) => {
    if (widen) el.style.minWidth = `${el.getBoundingClientRect().width + widen}px`
    const r = document.createRange()
    r.selectNodeContents(el)
    const t = r.getBoundingClientRect()
    const b = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const sides = { left: t.left - b.left - parseFloat(cs.paddingLeft), right: b.right - parseFloat(cs.paddingRight) - t.right }
    if (widen) el.style.minWidth = ''
    return sides
  }, widen)
const rightAligned = (s) => s.right < 4 && s.left > 40
const leftAligned = (s) => s.left < 4 && s.right > 40

// ---------- the cases that run on the desktop page and on the phone ----------

/** Tap, wait, tap: the strip counts up, then Transcribing…; the text lands at the caret and nothing is sent. */
async function tapWaitTap(u, chatId, label) {
  const { page } = u
  const before = await page.locator(tid('user-message')).count()
  const n = fake.got.length
  await u.press(composer(page))
  await page.keyboard.type('start ')
  await listen(u)
  const m = mic(page)
  assert(
    (await m.getAttribute('aria-pressed')) === 'true' && (await m.getAttribute('aria-label')) === 'Stop dictation',
    `${label}: the listening mic is not pressed "Stop dictation"`
  )
  const line = (await strip(page).textContent()).replace(/\s+/g, ' ')
  assert(/Listening \d+:\d\d/.test(line) && line.includes('Auto'), `${label}: the strip reads ${JSON.stringify(line)}`)
  assert((await focusedTestId(page)) === 'composer-input', `${label}: the mic took the focus from the box`)
  const live = page.locator(`${COMPOSER} > [role="status"][aria-live="polite"]`)
  assert((await live.textContent()) === 'Listening', `${label}: the live region says ${JSON.stringify(await live.textContent())}`)
  fake.queue.push({ delayMs: 1_000, text: 'world' })
  await u.press(m)
  await waitFor(
    async () =>
      (
        await strip(page)
          .textContent()
          .catch(() => '')
      ).includes('Transcribing…'),
    T,
    `${label}: the strip to read Transcribing…`
  )
  assert((await phaseOf(page)) === 'transcribing', `${label}: the mic is not transcribing`)
  assert((await live.textContent()) === 'Transcribing', `${label}: the live region says ${JSON.stringify(await live.textContent())}`)
  await waitBox(page, 'start world ', `${label}: the box to read "start world "`)
  await waitPhase(page, COMPOSER, 'idle')
  assert((await live.textContent()) === 'Dictation added', `${label}: the live region says ${JSON.stringify(await live.textContent())}`)
  assert(fake.got.length === n + 1, `${label}: the fake got ${fake.got.length - n} requests, not 1`)
  const s = await sendState(page)
  assert(s.label === 'Send' && !s.stop && !s.disabled, `${label}: the button is ${JSON.stringify(s)}, not an enabled Send`)
  await sleep(500)
  assert((await page.locator(tid('user-message')).count()) === before, `${label}: a user message was sent`)
  assert(((await chatMeta(chatId)).tasks?.length ?? 0) === 0, `${label}: a task was queued`)
  const states = await tracks(page)
  assert(states.length > 0 && states.every((r) => r === 'ended'), `${label}: tracks after stop: ${JSON.stringify(states)}`)
  const asked = await page.evaluate(() => window.__asked)
  assert(
    asked.every((c) => c === '{"audio":true}'),
    `${label}: getUserMedia was asked for ${JSON.stringify(asked)}`
  )
  ok(`2 ${label}: tap, wait, tap: Listening 0:01, Transcribing…, "start world " at the caret, still Send, nothing sent, mic released`)
}

/** Send while listening with a reply running: Send, not Stop; held and disabled; one queued task holding the transcript. */
async function sendWhileListening(u, chatId, label, words, reqId) {
  const { page } = u
  await scriptWaiting(reqId)
  await u.press(composer(page))
  await page.keyboard.type(`run ${label}`)
  await u.press(sendButton(page))
  const card = page.locator(tid('approval-card')).last()
  await card.locator(tid('approval-allow-once')).waitFor({ timeout: 30_000 })
  await waitFor(
    async () => (await draftText(page)) === '' && (await sendState(page)).stop,
    T,
    `${label}: the empty box's button to be Stop while the reply runs`
  )
  await listen(u)
  let s = await sendState(page)
  assert(s.label === 'Send' && !s.stop && !s.disabled, `${label}: while listening the button is ${JSON.stringify(s)}, not Send`)
  const n = fake.got.length
  // Long enough that the desktop's second press below surely lands while the send is held.
  fake.queue.push({ delayMs: 2_500, text: words })
  await u.press(sendButton(page))
  await waitFor(async () => (await sendState(page)).disabled, 2_000, `${label}: Send to be disabled while the send is held`)
  s = await sendState(page)
  assert(s.label === 'Send' && !s.stop, `${label}: the held button is ${JSON.stringify(s)}`)
  const held = (await strip(page).textContent()).trim()
  assert(held === 'Transcribing, then sending…', `${label}: the strip reads ${JSON.stringify(held)}`)
  if (!u.phone) {
    // A second press can't come from the disabled button; Enter in the box is the other way to send.
    await composer(page).click()
    await page.keyboard.press('Enter')
    assert((await phaseOf(page)) === 'transcribing', `${label}: the fake answered before the second press, so it proves nothing`)
  }
  // Exact, not includes: a transcript inserted twice must fail here.
  const rows = async () => (await page.locator(`${tid('task-row')} .task-text`).allTextContents()).filter((t) => t.trim() === words).length
  await waitFor(async () => (await rows()) >= 1, T, `${label}: the queued task with exactly the transcript`)
  const count = async () => ({
    rows: await rows(),
    stored: ((await chatMeta(chatId)).tasks ?? []).filter((t) => t.text.trim() === words).length,
    all: (await chatMeta(chatId)).tasks?.length ?? 0
  })
  await waitFor(async () => (await count()).stored === 1, T, `${label}: the task in chats.json`)
  await sleep(1_500)
  const c = await count()
  assert(c.rows === 1 && c.stored === 1 && c.all === 1, `${label}: queued ${JSON.stringify(c)}, not exactly one task with the transcript`)
  assert(fake.got.length === n + 1, `${label}: the fake got ${fake.got.length - n} requests, not 1`)
  // The dictation no longer counts as content and the reply still runs, so the empty box's button is Stop again.
  const after = await sendState(page)
  assert(after.stop && after.label === 'Stop', `${label}: after the held send went the button is ${JSON.stringify(after)}, not Stop`)
  // A sent message leaves the box, as a typed one does (the prop never changes here: '' before the insert, '' after).
  assert(
    (await draftText(page)) === '',
    `${label}: the box still holds ${JSON.stringify(await draftText(page))} after the held send sent it`
  )
  // Let the reply finish: the queued task then goes as the next turn, with a script that ends at once.
  await scriptBasic()
  const replies = await page.locator('.bubble.assistant').count()
  await u.press(card.locator(tid('approval-allow-once')))
  await waitFor(async () => (await userMessages(page, words).count()) === 1, 30_000, `${label}: the task to be sent as a user message`)
  await replyDone(page, replies + 2)
  await waitFor(async () => (await page.locator(tid('task-row')).count()) === 0, T, `${label}: the task tray to empty`)
  assert((await userMessages(page, words).count()) === 1, `${label}: the transcript was sent more than once`)
  ok(`4 ${label}: Send while listening is Send, then disabled with "Transcribing, then sending…"; exactly one task, sent with "${words}"`)
}

// ---------- the voice request (case 17) ----------

/** The fake claude's script for a voice chat: the basic reply with REPLY as its text; with `card`, a can_use_tool for a calendar tool held until it is answered first. */
async function scriptVoice(card) {
  const lines = (await readFile(BASIC, 'utf8')).split('\n').filter(Boolean)
  const req = card && {
    type: 'control_request',
    request_id: card,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'mcp__cal__create_event',
      input: { title: 'Meeting with Obada', start: 'Friday 3:30' },
      description: 'Create a calendar event',
      decision_reason: 'needs approval',
      tool_use_id: `toolu_${card}`
    }
  }
  let first = true
  const out = lines.flatMap((l) => {
    const swapped = l.replaceAll('"text":"pong"', `"text":${JSON.stringify(REPLY)}`)
    const j = JSON.parse(l)
    if (req && first && j.type === 'stream_event' && j.event?.delta?.type === 'text_delta') {
      first = false
      return [JSON.stringify(req), `#WAIT_RESPONSE ${card}`, swapped]
    }
    return [swapped]
  })
  await writeFile(h.script, out.join('\n') + '\n')
}

const talkPhase = (p) => p.locator(tid('voice-talk')).getAttribute('data-phase')
async function waitTalk(p, phase, timeout = 60_000) {
  let last = null
  await waitFor(async () => (last = await talkPhase(p).catch(() => null)) === phase, timeout, `the talk to be ${phase}`).catch(
    async (e) => {
      const notice = await p
        .locator(tid('voice-notice'))
        .textContent()
        .catch(() => null)
      throw new Error(`${e.message} (it is ${last}; notice ${JSON.stringify(notice)})`)
    }
  )
}
const voiceChats = async () => (await readJson('chats.json')).chats.filter((c) => c.voice === true)
const itemsOf = async (page, chatId) => (await rpc(page, 'chats:items', chatId)).items
const approvalOf = async (page, chatId, id) => (await itemsOf(page, chatId)).find((i) => i.type === 'approval' && i.id === id)
const onChatPage = (p, chatId) =>
  waitFor(async () => new URL(p.url()).pathname === `/chat/${chatId}`, 60_000, `the page to be at /chat/${chatId}`)

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const pickDir = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Voice e2e agent.\nmodel: haiku\ncommands:\n  - name: check\n    description: Check a card\n    prompt: Use check on $ARGUMENTS\n---\nYou are a test agent.\n`
  )
  await writeFile(
    join(agentsDir, `${OTHER}.md`),
    `---\nname: ${OTHER}\ndescription: Second member.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  await writeFile(join(dataDir, 'voice.json'), JSON.stringify({ enabled: true, key: KEY }), { mode: 0o600 })
  fake = await startFakeOpenRouter()
  h = await start({
    fake: true,
    dataDir,
    agentsDir,
    chromeArgs: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${MIC_LOOP}`],
    env: { ZUMIBOT_TEST_VOICE_URL: fake.origin, ZUMIBOT_TEST_PICK_FOLDER: pickDir }
  })
  await h.context.addInitScript(trackMic)
  const page = h.page
  const desk = { page, phone: false, press: (l) => l.click() }
  await page.reload()

  // ---------- two chats with the agent ----------
  await page.locator(tid('new-chat-agent')).waitFor({ timeout: 30_000 })
  await page.click(tid('new-chat-agent'))
  await page.click(`${tid('new-chat-agent-option')}[data-agent-name="${AGENT}"]`)
  await pickFolder(page, pickDir)
  await composer(page).click()
  await page.keyboard.type('alpha beta')
  await page.click(tid('send-button'))
  await page.waitForURL(/\/chat\//, { timeout: T })
  const chatA = chatIdOf(page)
  await replyDone(page, 1)
  // The agent's row opens its start screen with no folder picked, even with a chat; the first send makes the second chat.
  await page.click(`${tid('agent-row')}[data-agent-name="${AGENT}"]`)
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await pickFolder(page, pickDir)
  await composer(page).click()
  await page.keyboard.type('second chat')
  await page.click(tid('send-button'))
  await waitFor(async () => /\/chat\//.test(page.url()) && chatIdOf(page) !== chatA, T, 'the second chat to open')
  const chatB = chatIdOf(page)
  await replyDone(page, 1)
  const rowA = page.locator(`${tid('chat-row')}[data-chat-id="${chatA}"]`)
  const rowB = page.locator(`${tid('chat-row')}[data-chat-id="${chatB}"]`)
  await rowA.click()
  await page.waitForURL(new RegExp(`/chat/${chatA}$`), { timeout: T })
  await mic(page).waitFor({ timeout: T })
  ok(`chats ${chatA} and ${chatB} made; the composer shows the mic`)

  // ---------- 1. off: no mic; on again through the RPC ----------
  await writeFile(join(dataDir, 'voice.json'), JSON.stringify({ enabled: false, key: KEY }))
  await page.reload()
  await userMessages(page, 'alpha beta').waitFor({ timeout: T })
  const off = await rpc(page, 'voice:status')
  assert(off.on === false && off.enabled === false && off.keySaved === true, `the status with voice off is ${JSON.stringify(off)}`)
  await sleep(1_000)
  assert((await mic(page).count()) === 0, 'the mic shows with voice off')
  const on = await rpc(page, 'voice:set', { enabled: true })
  assert(on.on === true && on.keySaved === true, `voice:set answered ${JSON.stringify(on)}`)
  await mic(page).waitFor({ timeout: T })
  await page.reload()
  await mic(page).waitFor({ timeout: T })
  ok('1 voice off (voice.json, reload): no mic; voice:set on brings it back live and after a reload')

  // ---------- 2. tap, wait, tap (desktop) ----------
  await tapWaitTap(desk, chatA, 'desktop')

  // ---------- 3. the request the fake got ----------
  const r = fake.got.at(-1)
  assert(r.method === 'POST' && r.path === TX_PATH, `the request was ${r.method} ${r.path}`)
  assert(r.headers.authorization === `Bearer ${KEY}`, 'the request does not carry the dummy key as its bearer')
  assert(r.json?.model === 'elevenlabs/scribe-v2', `the model is ${r.json?.model}`)
  assert(r.json.provider?.zdr === true, `provider is ${JSON.stringify(r.json.provider)}`)
  assert(r.json.input_audio?.format === 'webm', `the format is ${r.json.input_audio?.format}`)
  assert(!('language' in r.json), `Auto sent a language: ${r.json.language}`)
  const clip = Buffer.from(r.json.input_audio.data ?? '', 'base64')
  assert(
    clip.length > 1_000 && /^[A-Za-z0-9+/]+=*$/.test(r.json.input_audio.data),
    `the clip is not a non-empty base64 string (${clip.length} bytes)`
  )
  assert(clip.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'the clip is not a webm (EBML) file')
  await clearComposer(desk)
  await listen(desk)
  const chip = strip(page).locator(tid('dictation-lang'))
  await chip.click()
  await chip.click()
  assert((await chip.textContent()).trim() === 'AR', `the chip reads ${await chip.textContent()} after two taps`)
  const ar = await stopWith(desk, { text: 'marhaba' })
  assert(ar.json.language === 'ar', `AR sent language ${ar.json.language}`)
  assert((await page.evaluate(() => localStorage.getItem('zumibot.voiceLang'))) === 'ar', 'the AR choice is not stored')
  await listen(desk)
  await chip.click()
  assert((await chip.textContent()).trim() === 'Auto', 'a third tap does not cycle back to Auto')
  const auto = await stopWith(desk, { text: 'auto again' })
  assert(!('language' in auto.json), 'Auto after AR still sent a language')
  await waitBox(page, 'marhaba auto again ', 'both dictations in the box')
  await clearComposer(desk)
  ok('3 the fake got model elevenlabs/scribe-v2, zdr, webm, a base64 EBML clip, the bearer, no language on Auto, "ar" on AR')

  // ---------- 4. send while listening (desktop) ----------
  await sendWhileListening(desk, chatA, 'desktop', 'held words', 'req-voice-desk')

  // ---------- 2 and 4 on the phone ----------
  const phoneCtx = await h.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })
  await phoneCtx.addInitScript(trackMic)
  const phonePage = await phoneCtx.newPage()
  const phone = { page: phonePage, phone: true, press: (l) => l.tap() }
  await phonePage.goto(`${h.origin}/chat/${encodeURIComponent(chatB)}`)
  await mic(phonePage).waitFor({ timeout: T })
  assert(await phonePage.evaluate(() => matchMedia('(pointer: coarse)').matches), 'the phone context has no coarse pointer')
  await tapWaitTap(phone, chatB, 'phone')
  await clearComposer(phone)
  await sendWhileListening(phone, chatB, 'phone', 'phone held', 'req-voice-phone')
  await phoneCtx.close()

  // ---------- 5. send with an upstream error ----------
  {
    const before = await page.locator(tid('user-message')).count()
    await composer(page).click()
    await page.keyboard.type('keep this')
    await listen(desk)
    const n = fake.got.length
    fake.queue.push({ status: 500 })
    await sendButton(page).click()
    await voiceError(page).waitFor({ timeout: T })
    assert((await voiceError(page).textContent()).trim() === FAILED, `the error reads ${await voiceError(page).textContent()}`)
    assert(fake.got.length === n + 1, 'the clip did not reach the fake once')
    await sleep(800)
    assert((await draftText(page)) === 'keep this', `the box reads ${JSON.stringify(await draftText(page))}`)
    assert((await page.locator(tid('user-message')).count()) === before, 'a message was sent after the failed transcription')
    assert(((await chatMeta(chatA)).tasks?.length ?? 0) === 0, 'a task was queued after the failed transcription')
    const s = await sendState(page)
    assert(s.label === 'Send' && !s.disabled, `after the error the button is ${JSON.stringify(s)}`)
    await clearComposer(desk)
    ok('5 a 500 upstream while a send is held: "Transcription failed. Try again.", nothing sent, the box keeps its text')
  }

  // ---------- 6. chat switch while listening ----------
  {
    await composer(page).click()
    await listen(desk)
    const n = fake.got.length
    fake.queue.push({ delayMs: 300, text: 'leaked' })
    await rowB.click()
    await page.waitForURL(new RegExp(`/chat/${chatB}$`), { timeout: T })
    await sleep(1_500)
    assert(fake.got.length === n, 'the dropped clip reached the fake')
    fake.queue.length = 0
    const states = await tracks(page)
    assert(states.length > 0 && states.every((x) => x === 'ended'), `tracks after the switch: ${JSON.stringify(states)}`)
    assert((await draftText(page)) === '', `chat B's box reads ${JSON.stringify(await draftText(page))}`)
    assert((await phaseOf(page)) === 'idle' && (await strip(page).count()) === 0, 'chat B shows a dictation')
    await rowA.click()
    await page.waitForURL(new RegExp(`/chat/${chatA}$`), { timeout: T })
    await sleep(500)
    assert((await draftText(page)) === '', `chat A's box reads ${JSON.stringify(await draftText(page))}`)
    assert(fake.got.length === n, 'a request reached the fake after the switch')
    ok('6 chat switch while listening: no request, no text in either chat, every track ended')
  }

  // ---------- 7. page hidden while listening ----------
  {
    await composer(page).click()
    await listen(desk)
    const n = fake.got.length
    fake.queue.push({ text: 'from hidden' })
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await waitFor(async () => fake.got.length === n + 1, T, 'the hidden page to upload its clip')
    await waitBox(page, 'from hidden ', 'the text in the box while hidden')
    const states = await tracks(page)
    assert(
      states.every((x) => x === 'ended'),
      `tracks after hiding: ${JSON.stringify(states)}`
    )
    await page.evaluate(() => {
      delete document.visibilityState
      delete document.hidden
      document.dispatchEvent(new Event('visibilitychange'))
    })
    assert((await page.evaluate(() => document.visibilityState)) === 'visible', 'the visibility override was not undone')
    assert((await draftText(page)) === 'from hidden ', 'the text left the box when the page came back')
    await clearComposer(desk)
    ok('7 page hidden while listening: the clip is transcribed and the text is in the box on return')
  }

  // ---------- 8. menus never open after an insert (a new room: both / and @ menus exist there) ----------
  {
    await page.click(tid('new-agent'))
    await page.click(tid('new-menu-group'))
    await page.locator(tid('new-chat-members')).waitFor({ timeout: T })
    await page.click(tid('new-chat-members'))
    await page.locator(`${tid('new-chat-member-option')}[data-agent-name="${AGENT}"]`).click()
    await page.locator(`${tid('new-chat-member-option')}[data-agent-name="${OTHER}"]`).click()
    await page.keyboard.press('Escape')
    await page.locator(tid('new-chat-members')).locator('.picker-text').filter({ hasText: '2 agents' }).waitFor({ timeout: T })
    const cmdMenu = page.locator(tid('command-menu'))
    const mentionMenu = page.locator(tid('mention-menu'))
    // Typed by hand, both menus open here, so their absence below is the dictation's doing.
    await composer(page).click()
    await page.keyboard.type('/che')
    await cmdMenu.waitFor({ timeout: T })
    await clearComposer(desk)
    await page.keyboard.type('hello @ed')
    await mentionMenu.waitFor({ timeout: T })
    await page.keyboard.press('Escape')
    await clearComposer(desk)
    await listen(desk)
    await stopWith(desk, { text: '/check' })
    await waitBox(page, '/check ', 'the box to read "/check "')
    await sleep(400)
    assert((await focusedTestId(page)) === 'composer-input', 'the box lost focus, so the menu check proves nothing')
    assert((await cmdMenu.count()) === 0 && (await mentionMenu.count()) === 0, 'a menu opened after "/check" was dictated')
    await clearComposer(desk)
    await listen(desk)
    await stopWith(desk, { text: 'hello @ed' })
    await waitBox(page, 'hello @ed ', 'the box to read "hello @ed "')
    await sleep(400)
    assert((await focusedTestId(page)) === 'composer-input', 'the box lost focus before the mention check')
    assert((await cmdMenu.count()) === 0 && (await mentionMenu.count()) === 0, 'a menu opened after "hello @ed" was dictated')
    await clearComposer(desk)
    await rowA.click()
    await page.waitForURL(new RegExp(`/chat/${chatA}$`), { timeout: T })
    ok('8 in a room, dictated "/check" and "hello @ed" open neither the command nor the mention menu')
  }

  // ---------- 9. RTL ----------
  {
    await composer(page).click()
    await listen(desk)
    await stopWith(desk, { text: ARABIC })
    await waitBox(page, `${ARABIC} `, 'the Arabic text in the box')
    const p = composer(page).locator('p').first()
    const boxSides = await textSides(p)
    assert(rightAligned(boxSides), `the Arabic line in the box is not right-aligned: ${JSON.stringify(boxSides)}`)
    const replies = await page.locator('.bubble.assistant').count()
    await sendButton(page).click()
    const sent = page.locator('.bubble.user', { hasText: ARABIC }).locator('.sent-text p').first()
    await sent.waitFor({ timeout: T })
    await replyDone(page, replies + 1)
    const bubbleSides = await textSides(sent, 200)
    assert(rightAligned(bubbleSides), `the Arabic bubble is not right-aligned: ${JSON.stringify(bubbleSides)}`)
    const english = await textSides(page.locator('.bubble.user', { hasText: 'alpha beta' }).locator('.sent-text p').first(), 200)
    assert(leftAligned(english), `an English bubble is not left-aligned: ${JSON.stringify(english)}`)
    // Arabic into an English line, at the caret between "hello " and "world"
    await composer(page).click()
    await page.keyboard.type('hello world')
    // A person pauses before moving the caret; keys pressed in the same few ms as a re-render once left the editor's
    // own selection one step behind the one on screen (see the check below).
    await sleep(300)
    await page.keyboard.press('End')
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft')
    // The text before the caret, on screen and in the editor's state (Tiptap hangs the editor on its element); the
    // dictation inserts at the latter.
    const caretAt = () =>
      composer(page).evaluate((el) => {
        const s = getSelection()
        return {
          screen: s.anchorNode ? s.anchorNode.textContent.slice(0, s.anchorOffset) : null,
          editor: el.editor.state.doc.textBetween(0, el.editor.state.selection.from)
        }
      })
    let caret = null
    await waitFor(
      async () => ((caret = await caretAt()), caret.screen === 'hello ' && caret.editor === 'hello '),
      2_000,
      'the caret after "hello "'
    ).catch((e) => {
      throw new Error(`${e.message} (screen and editor: ${JSON.stringify(caret)})`)
    })
    await listen(desk)
    await stopWith(desk, { text: ARABIC })
    const mixed = `hello ${ARABIC} world`
    await waitBox(page, mixed, `the box to read ${JSON.stringify(mixed)} in logical order`)
    const mixedSides = await textSides(composer(page).locator('p').first())
    assert(leftAligned(mixedSides), `the English line with Arabic in it is not left-aligned: ${JSON.stringify(mixedSides)}`)
    await clearComposer(desk)
    ok('9 RTL: Arabic in an empty box and its sent bubble sit right; Arabic dictated mid-English lands at the caret in order')
  }

  // ---------- 10. the edit box, with its caret set while blurred ----------
  {
    const msg = userMessages(page, 'alpha beta').first()
    await msg.hover()
    await msg.locator(tid('edit-button')).click()
    const editor = page.locator(EDITOR)
    const box = editor.locator(tid('message-editor-input'))
    await box.waitFor({ timeout: T })
    // The edit box is the composer's editor: its text and caret go through the Tiptap editor on its element.
    const boxText = () => box.evaluate((el) => el.editor.getText())
    assert((await boxText()) === 'alpha beta', `the edit box opened with ${JSON.stringify(await boxText())}`)
    const caretAndBlur = (at) =>
      box.evaluate((el, at) => {
        el.editor.commands.setTextSelection(at + 1)
        el.blur()
        return document.activeElement !== el
      }, at)
    // After the space: no leading space added, one trailing space
    assert(await caretAndBlur(6), 'the edit box kept the focus')
    await listen(desk, EDITOR)
    assert((await phaseOf(page, COMPOSER)) === 'idle', 'the composer mic moved with the edit box mic')
    await stopWith(desk, { text: 'again' }, EDITOR)
    await waitFor(async () => (await boxText()) === 'alpha again beta', T, 'the edit box to read "alpha again beta"')
    // Right after a letter: one leading space, and the trailing one even before the existing space
    assert(await caretAndBlur(5), 'the edit box kept the focus')
    await listen(desk, EDITOR)
    await stopWith(desk, { text: 'more' }, EDITOR)
    const edited = 'alpha more  again beta'
    await waitFor(async () => (await boxText()) === edited, T, `the edit box to read ${JSON.stringify(edited)}`)
    assert((await draftText(page)) === '', 'the edit box dictation reached the composer')
    await editor.locator(tid('message-editor-send')).click()
    await waitFor(async () => (await page.locator(EDITOR).count()) === 0, T, 'the edit box to close')
    const version = userMessages(page, 'alpha more').first()
    await version.waitFor({ timeout: T })
    const shown = (await version.locator('.bubble.user').textContent()).replace(/\s+/g, ' ').trim()
    assert(shown === 'alpha more again beta', `the new version reads ${JSON.stringify(shown)}`)
    assert((await version.locator(tid('version-switcher')).count()) === 1, 'the edited message has no version switcher')
    // It was the first message, so the rerun's reply is the only one left in view.
    await waitFor(
      async () =>
        (await page.locator('.bubble.assistant').count()) === 1 &&
        (await rowA.locator('[aria-label="Reply running"]').count()) === 0 &&
        !(await sendState(page)).stop,
      30_000,
      "the edited message's reply to end"
    )
    ok('10 edit box: dictation lands at a caret set while blurred, with the spacing rule; Send makes the new version')
  }

  // ---------- 11. mic blocked ----------
  {
    const ctx = await h.newContext()
    await ctx.addInitScript(blockMic)
    const p = await ctx.newPage()
    await p.goto(`${h.origin}/chat/${encodeURIComponent(chatA)}`)
    await mic(p).waitFor({ timeout: T })
    await mic(p).click()
    await voiceError(p).waitFor({ timeout: T })
    const text = (await voiceError(p).textContent()).trim()
    assert(text === BLOCKED, `the blocked error reads ${JSON.stringify(text)}`)
    assert((await phaseOf(p)) === 'error', 'the mic is not in its error state')
    await ctx.close()
    ok('11 getUserMedia rejected with NotAllowedError: "Microphone is blocked. Allow it in the browser\'s site settings."')
  }

  // ---------- 12. the dictated text is a draft like typed text ----------
  // The app keeps drafts per chat in memory (a plain reload loses a typed draft too; only an expiry sign-out saves them),
  // so what is checked is that the dictated text is in that store: it is still there after leaving the chat and coming back.
  {
    await composer(page).click()
    await listen(desk)
    await stopWith(desk, { text: 'kept draft' })
    await waitBox(page, 'kept draft ', 'the dictated draft in the box')
    await rowB.click()
    await page.waitForURL(new RegExp(`/chat/${chatB}$`), { timeout: T })
    await waitBox(page, '', "chat B's own empty box")
    await rowA.click()
    await page.waitForURL(new RegExp(`/chat/${chatA}$`), { timeout: T })
    await waitBox(page, 'kept draft ', 'the dictated draft back in chat A')
    await clearComposer(desk)
    ok('12 the dictated draft is kept like a typed one: still in the box after leaving the chat and coming back')
  }

  // ---------- 13. one dictation at a time: the edit box's mic drops the composer's ----------
  {
    await composer(page).click()
    await listen(desk)
    // The composer's stream is the newest one so far; the edit box's will come after it.
    const mine = (await tracks(page)).length
    const n = fake.got.length
    const msg = userMessages(page, 'alpha more').first()
    await msg.hover()
    await msg.locator(tid('edit-button')).click()
    const editor = page.locator(EDITOR)
    const box = editor.locator(tid('message-editor-input'))
    const boxText = () => box.evaluate((el) => el.editor.getText())
    await box.waitFor({ timeout: T })
    assert(
      (await phaseOf(page, COMPOSER)) === 'listening',
      'opening the edit box stopped the composer dictation, so the mic tap below proves nothing'
    )
    await mic(page, EDITOR).click()
    await waitPhase(page, EDITOR, 'listening')
    await waitPhase(page, COMPOSER, 'idle')
    await sleep(1_000)
    const states = await tracks(page)
    assert(states.length === mine + 1, `expected one new stream for the edit box, tracks are ${JSON.stringify(states)}`)
    assert(
      states.slice(0, mine).every((x) => x === 'ended'),
      `the composer's mic is still held: ${JSON.stringify(states)}`
    )
    assert(states[mine] === 'live', `the edit box is not recording: ${JSON.stringify(states)}`)
    assert(fake.got.length === n, "the composer's dropped clip reached the fake")
    assert((await strip(page, COMPOSER).count()) === 0, 'the composer still shows a dictation strip')
    assert((await draftText(page)) === '', `the composer reads ${JSON.stringify(await draftText(page))}`)
    // The edit box's own dictation ends normally, then the box is closed unsent.
    await waitFor(async () => (await elapsed(page, EDITOR)) >= 1, T, "the edit box's strip time to pass 0:01")
    await stopWith(desk, { text: 'solo' }, EDITOR)
    await waitFor(
      async () => (await boxText()).replace(/\s+/g, ' ').trim() === 'alpha more again beta solo',
      T,
      'the edit box to end with "solo"'
    )
    assert(fake.got.length === n + 1, `the fake got ${fake.got.length - n} requests, not 1 (the edit box's)`)
    await editor.locator(tid('message-editor-cancel')).click()
    await waitFor(async () => (await page.locator(EDITOR).count()) === 0, T, 'the edit box to close')
    const after = await tracks(page)
    assert(
      after.every((x) => x === 'ended'),
      `tracks after the edit box's stop: ${JSON.stringify(after)}`
    )
    assert((await draftText(page)) === '' && (await phaseOf(page, COMPOSER)) === 'idle', 'the composer changed')
    ok("13 one dictation at a time: the edit box's mic drops the composer's (idle, mic released, nothing uploaded)")
  }

  // ---------- 14. send while listening in the edit box ----------
  {
    const words = 'edit held'
    const msg = userMessages(page, 'alpha more').first()
    const label = msg.locator('.version-label')
    assert((await label.textContent()).trim() === '2 / 2', `the message shows version ${await label.textContent()}, not 2 / 2`)
    await msg.hover()
    await msg.locator(tid('edit-button')).click()
    const editor = page.locator(EDITOR)
    const box = editor.locator(tid('message-editor-input'))
    const send = editor.locator(tid('message-editor-send'))
    await box.waitFor({ timeout: T })
    await listen(desk, EDITOR)
    assert(await send.isEnabled(), "the edit box's Send is disabled while listening")
    const n = fake.got.length
    fake.queue.push({ delayMs: 2_500, text: words })
    await send.click()
    await waitFor(async () => await send.isDisabled(), 2_000, "the edit box's Send to be disabled while the send is held")
    const held = (await strip(page, EDITOR).textContent()).trim()
    assert(held === 'Transcribing, then sending…', `the edit box's strip reads ${JSON.stringify(held)}`)
    // A second send attempt the disabled button can't make: Enter in the box.
    await box.press('Enter')
    assert((await phaseOf(page, EDITOR)) === 'transcribing', 'the fake answered before the second press, so it proves nothing')
    await waitFor(async () => (await page.locator(EDITOR).count()) === 0, T, 'the edit box to close after the held send')
    const version = userMessages(page, words)
    await version.first().waitFor({ timeout: T })
    await sleep(1_500)
    assert((await version.count()) === 1, `${await version.count()} user messages hold the transcript`)
    const shown = (await version.first().locator('.bubble.user').textContent()).replace(/\s+/g, ' ').trim()
    assert(shown === `alpha more again beta ${words}`, `the new version reads ${JSON.stringify(shown)}`)
    assert(shown.split(words).length === 2, `the transcript is in the new version ${shown.split(words).length - 1} times`)
    const now = (await version.first().locator('.version-label').textContent()).trim()
    assert(now === '3 / 3', `the message shows version ${now}, not exactly one new version (3 / 3)`)
    assert(fake.got.length === n + 1, `the fake got ${fake.got.length - n} requests, not 1`)
    await waitFor(
      // It is the first message, so the rerun's reply is the only one left in view.
      async () =>
        (await page.locator('.bubble.assistant').count()) === 1 &&
        (await rowA.locator('[aria-label="Reply running"]').count()) === 0 &&
        !(await sendState(page)).stop,
      30_000,
      "the edited message's reply to end"
    )
    ok('14 edit box: Send while listening is held (disabled, "Transcribing, then sending…"); one new version with the words once')
  }

  // ---------- 15. send while listening on the new-chat screen ----------
  {
    const words = 'new chat words'
    await page.click(`${tid('agent-row')}[data-agent-name="${OTHER}"]`)
    await page.locator(tid('new-chat')).waitFor({ timeout: T })
    await pickFolder(page, pickDir)
    await composer(page).click()
    await page.keyboard.type('x')
    await listen(desk)
    const n = fake.got.length
    fake.queue.push({ delayMs: 2_500, text: words })
    await sendButton(page).click()
    await waitFor(async () => (await sendState(page)).disabled, 2_000, 'Send to be disabled while the send is held')
    const held = (await strip(page).textContent()).trim()
    assert(held === 'Transcribing, then sending…', `the strip reads ${JSON.stringify(held)}`)
    // A second send attempt the disabled button can't make: Enter in the box.
    await composer(page).click()
    await page.keyboard.press('Enter')
    assert((await phaseOf(page)) === 'transcribing', 'the fake answered before the second press, so it proves nothing')
    await waitFor(async () => /\/chat\//.test(page.url()) && ![chatA, chatB].includes(chatIdOf(page)), T, 'the new chat to open')
    await replyDone(page, 1)
    await sleep(1_500)
    const sent = page.locator(tid('user-message'))
    assert((await sent.count()) === 1, `the new chat has ${await sent.count()} user messages, not 1`)
    const shown = (await sent.first().locator('.bubble.user').textContent()).replace(/\s+/g, ' ').trim()
    assert(shown === `x ${words}`, `the new chat's first message reads ${JSON.stringify(shown)}`)
    assert(fake.got.length === n + 1, `the fake got ${fake.got.length - n} requests, not 1`)
    assert((await draftText(page)) === '', `the new chat's box still holds ${JSON.stringify(await draftText(page))}`)
    ok(`15 new-chat screen: Send while listening starts the chat with exactly "x ${words}", once, and leaves its box empty`)
  }

  // ---------- 16. a grant that lands while the page is hidden records nothing ----------
  {
    const ctx = await h.newContext()
    await ctx.addInitScript(holdMic)
    const p = await ctx.newPage()
    await p.goto(`${h.origin}/chat/${encodeURIComponent(chatA)}`)
    await mic(p).waitFor({ timeout: T })
    await mic(p).click()
    await waitPhase(p, COMPOSER, 'starting')
    await p.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await sleep(300)
    assert((await phaseOf(p)) === 'starting', 'hiding the page while starting changed the phase, so the late grant below proves nothing')
    const n = fake.got.length
    // No visibilitychange follows the grant: the page is already hidden.
    await p.evaluate(() => window.__grant())
    await waitFor(async () => (await phaseOf(p)) === 'error', T, 'the late grant to stop at once (a clip too short to send)')
    assert((await voiceError(p).textContent()).trim() === EMPTY, `the error reads ${JSON.stringify(await voiceError(p).textContent())}`)
    const states = await tracks(p)
    assert(states.length > 0 && states.every((x) => x === 'ended'), `tracks after the hidden grant: ${JSON.stringify(states)}`)
    await sleep(500)
    assert(fake.got.length === n, 'the hidden grant uploaded a clip')
    await ctx.close()
    ok('16 a mic grant that lands while the page is hidden stops at once: nothing recorded unseen, mic released')
  }

  // ---------- 17. a voice request: speak it, it is transcribed and sent to a new voice chat, and the chat opens ----------
  {
    const seenChats = new Set((await readJson('chats.json')).chats.map((c) => c.id))
    await scriptVoice(null)
    const ctx = await h.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })
    await ctx.addInitScript(trackMic)
    const tp = await ctx.newPage()
    const tx0 = fake.got.length
    fake.queue.push({ text: 'Ask vc to set a meeting' })
    // The shortcut's address: this page has had no tap, so it may not open the mic yet and asks for one.
    await tp.goto(`${h.origin}/voice?start=1`)
    const startBtn = tp.locator(tid('voice-start'))
    await startBtn.waitFor({ timeout: T })
    assert(
      (await startBtn.getAttribute('aria-label')) === 'Start talking',
      `the avatar reads ${JSON.stringify(await startBtn.getAttribute('aria-label'))}`
    )
    assert((await tp.locator(tid('voice-status')).textContent()).trim() === 'Tap to talk', 'the status does not read Tap to talk')
    assert((await talkPhase(tp)) === 'idle', 'the talk began without a tap')
    assert((await tp.evaluate(() => window.__asked)).length === 0, 'the mic was asked for before any tap')
    await startBtn.tap()
    await waitTalk(tp, 'listening')
    assert((await tp.locator(tid('voice-status')).textContent()).trim() === 'Speak now', 'the status does not read Speak now')

    // One clip is heard, transcribed and sent; then the page is the chat, with the agent's reply on it.
    const made = await (async () => {
      await waitFor(async () => (await voiceChats()).some((c) => !seenChats.has(c.id)), 60_000, 'the voice chat to be made')
      return (await voiceChats()).filter((c) => !seenChats.has(c.id))
    })()
    assert(
      made.length === 1,
      `${made.length} voice chats were made, not 1 (calls ${fake.got
        .slice(tx0)
        .map((g) => g.path.split('/').pop())
        .join(',')}; errors ${JSON.stringify(h.errors.slice(-5))})`
    )
    const chat = made[0]
    await onChatPage(tp, chat.id)
    await tp.locator(tid('voice-page')).waitFor({ state: 'detached', timeout: T })
    await tp.locator('.bubble.assistant').filter({ hasText: REPLY }).first().waitFor({ timeout: 30_000 })
    assert(
      /^Voice · /.test(chat.title) && chat.voice === true && chat.agentName === AGENT,
      `the voice chat is ${JSON.stringify({ title: chat.title, voice: chat.voice, agent: chat.agentName })}`
    )
    const sent = (await itemsOf(page, chat.id)).filter((i) => i.type === 'user')
    assert(
      sent.length === 1 && sent[0].text === 'set a meeting',
      `the voice chat's user messages: ${JSON.stringify(sent.map((i) => i.text))} (the request, without "Ask vc to")`
    )
    const heard = fake.got.slice(tx0)
    assert(
      heard.length === 1 && heard[0].path === TX_PATH,
      `what reached the fake: ${JSON.stringify(heard.map((g) => g.path))} (one transcription, nothing else)`
    )
    ok(
      '17a /voice?start=1 waits for a tap, listens once, and the request goes to a new Voice · … chat (voice: true) that the page then shows with the reply'
    )

    // Everything let go: the talk ended the moment the chat opened.
    await waitFor(async () => (await tracks(tp)).length === 1 && (await tracks(tp)).every((r) => r === 'ended'), T, 'the mic track to end')
    assert(
      (await tp.evaluate(() => window.__asked)).join() ===
        '{"audio":{"echoCancellation":true,"noiseSuppression":true,"autoGainControl":true}}',
      'the mic was not asked for once with echo cancellation, noise suppression and auto gain'
    )
    ok('17b the mic track is stopped once the chat is open, and getUserMedia was asked once')

    // Nothing spoken or heard in a log.
    const logged = [...h.output, ...h.errors].join('\n')
    for (const secret of ['set a meeting', 'Done, Friday', 'Ask vc', KEY])
      assert(!logged.includes(secret), `the server log holds ${JSON.stringify(secret)}`)
    ok('17c no transcript and no key in the server log')

    // The sidebar row of a voice chat carries the mic mark.
    await page.reload()
    const row = page.locator(`${tid('chat-row')}[data-chat-id="${chat.id}"]`)
    await row.waitFor({ timeout: T })
    assert((await row.locator(tid('voice-mark')).count()) === 1, 'the voice chat row has no mic mark')
    assert(
      (await page.locator(`${tid('chat-row')}[data-chat-id="${chatA}"] ${tid('voice-mark')}`).count()) === 0,
      'a plain chat row has a mic mark'
    )
    ok('17d the voice chat row in the sidebar shows the mic mark; a plain chat row does not')

    // ---------- 18. a card in a voice chat is an ordinary on-screen card (no forced ask, normal choices) ----------
    await scriptVoice('req-voice-card')
    const seen2 = new Set((await readJson('chats.json')).chats.map((c) => c.id))
    fake.queue.push({ text: 'vc, book a room' })
    await tp.goto(`${h.origin}/voice`)
    await tp.locator(tid('voice-start')).tap()
    await waitFor(async () => (await voiceChats()).some((c) => !seen2.has(c.id)), 60_000, 'the second voice chat to be made')
    const card = (await voiceChats()).find((c) => !seen2.has(c.id))
    await onChatPage(tp, card.id)
    const cardEl = tp.locator(tid('approval-card'))
    await cardEl.waitFor({ timeout: 30_000 })
    for (const id of ['approval-allow-once', 'approval-allow-chat', 'approval-allow-agent', 'approval-deny'])
      assert((await cardEl.locator(tid(id)).count()) === 1, `the card has no ${id} choice`)
    assert(
      (await itemsOf(page, card.id)).find((i) => i.type === 'user')?.text === 'book a room',
      'the vocative request was not sent whole after the name'
    )
    await cardEl.locator(tid('approval-allow-once')).tap()
    await tp.locator('.bubble.assistant').filter({ hasText: REPLY }).first().waitFor({ timeout: 30_000 })
    assert((await approvalOf(page, card.id, 'req-voice-card'))?.status === 'allowed-once', 'the on-screen card was not allowed once')
    ok("18 a voice chat's card is a normal on-screen card with every usual choice; allowing it once finishes the reply")

    // ---------- 19. an unknown agent: a notice, nothing sent, the mic let go; and a tap tries again ----------
    const n19 = (await voiceChats()).length
    fake.queue.push({ text: 'Ask nobody to set a meeting' })
    await tp.goto(`${h.origin}/voice`)
    await tp.locator(tid('voice-start')).tap()
    await waitTalk(tp, 'ended', 60_000)
    const note = (await tp.locator(tid('voice-notice')).textContent()).trim()
    assert(note === "I don't know an agent called nobody.", `the notice reads ${JSON.stringify(note)}`)
    assert((await voiceChats()).length === n19, 'a chat was made for an unknown agent')
    assert(new URL(tp.url()).pathname === '/voice', `the page left /voice: ${tp.url()}`)
    const after19 = await tracks(tp)
    assert(after19.length === 1 && after19.every((r) => r === 'ended'), `mic tracks after the unknown agent: ${JSON.stringify(after19)}`)
    assert(await tp.locator(tid('voice-start')).isEnabled(), 'the avatar cannot start again')
    ok(
      '19 an unknown agent shows "I don\'t know an agent called nobody." on the page, makes no chat, releases the mic and can be started again'
    )

    // ---------- 20. an agent named with no request: it asks what, listens once more, and that is the request ----------
    await scriptVoice(null)
    const seen3 = new Set((await readJson('chats.json')).chats.map((c) => c.id))
    fake.queue.push({ text: 'Ask vc' }, { text: 'check the calendar' })
    await tp.goto(`${h.origin}/voice`)
    await tp.locator(tid('voice-start')).tap()
    await waitFor(
      async () =>
        (
          (await tp
            .locator(tid('voice-notice'))
            .textContent()
            .catch(() => '')) ?? ''
        ).includes('What should I ask Vc?'),
      60_000,
      'the "What should I ask Vc?" notice'
    )
    await waitFor(async () => (await voiceChats()).some((c) => !seen3.has(c.id)), 60_000, 'the third voice chat to be made')
    const third = (await voiceChats()).find((c) => !seen3.has(c.id))
    await onChatPage(tp, third.id)
    assert(
      (await itemsOf(page, third.id)).find((i) => i.type === 'user')?.text === 'check the calendar',
      'the second utterance was not the request'
    )
    ok('20 "Ask vc" alone asks "What should I ask Vc?", listens once more, and the next words go to that agent')
    await ctx.close()

    // ---------- 21. the top-bar mic on a phone opens the page and starts at once; Stop lets the mic go ----------
    const ctx2 = await h.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })
    await ctx2.addInitScript(trackMic)
    const bp = await ctx2.newPage()
    await bp.goto(h.origin)
    await bp.locator(tid('talk-button')).waitFor({ timeout: T })
    await bp.locator(tid('talk-button')).tap()
    await bp.locator(tid('voice-page')).waitFor({ timeout: T })
    assert(new URL(bp.url()).pathname === '/voice', `the address is ${bp.url()}`)
    await waitTalk(bp, 'listening')
    await bp.locator(tid('voice-stop')).tap()
    await waitTalk(bp, 'idle')
    const states3 = await tracks(bp)
    assert(states3.length === 1 && states3.every((r) => r === 'ended'), `mic tracks after Stop: ${JSON.stringify(states3)}`)
    await bp.locator(tid('voice-back')).tap()
    await bp.locator(tid('voice-page')).waitFor({ state: 'detached', timeout: T })
    assert(new URL(bp.url()).pathname !== '/voice', 'Back left the address at /voice')
    await ctx2.close()
    ok('21 the top-bar mic opens /voice and listens at once; Stop is idle with the mic released; Back closes the page')
  }

  assert(fake.queue.length === 0, `answers left unused: ${JSON.stringify(fake.queue)}`)
  // Voice only ever transcribes: no speech or summary call, and none cut short.
  assert(
    fake.got.every((g) => g.path === TX_PATH && !g.aborted),
    `the fake saw an unexpected path or an aborted request: ${JSON.stringify(fake.got.filter((g) => g.path !== TX_PATH || g.aborted).map((g) => g.path))}`
  )
  assert(!h.errors.some((e) => e.includes(KEY)), 'the key reached a log line')
  const bad = unexpectedErrors(h.errors, [
    // case 5's upstream 500 is logged by design, with the status and size only
    /^server stderr: voice: HTTP 500 \(\d+ bytes\)$/,
    // ...and its 502 to the page is a failed resource load to Chrome
    /^console: Failed to load resource: the server responded with a status of 502 \(Bad Gateway\)$/
  ])
  assert(bad.length === 0, `unexpected console/server errors:\n${bad.join('\n')}`)
  ok('no unexpected console or server errors; the key is in no log line')
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
console.log(failed ? 'e2e:voice FAILED' : 'e2e:voice passed')
process.exit(failed ? 1 : 0)
