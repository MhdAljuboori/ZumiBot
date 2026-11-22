// End-to-end check of the Inbox in the built server + web UI (VPS mode, for Web Push) against the FAKE workflow claude
// (backend/tests/fixtures/fake-workflow-claude.mjs: a chat turn, whose argv has --agent, is exactly fake-claude.mjs):
// no real CLI call is ever made, so no login or quota is used. Usage: npm run e2e:inbox   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server, Chrome, the second browser context and the fake push server started here are stopped in `finally`;
//    overall timeout 5 min.
// Cards come from a can_use_tool control_request plus #WAIT_RESPONSE in the fake claude's script (one file, read when a
// run starts, so it is rewritten only once the run before it shows its card); FAKE_RESPONSES_FILE shows what each
// card was answered. Workflow runs and their Approval and Notify steps need no model call. The Notify push goes to a
// local fake push service (ZUMIBOT_TEST_PUSH_ORIGIN) through a device enabled by a raw /ws RPC with keys made here,
// and is decrypted (RFC 8291) here. Devices are enabled only for cases 8 and 9 (one each, off again after its push):
// every chat turn's reply also pushes, and the 10-a-minute cap would drop (and log) a later one. A push click is a full
// navigation to the address the service worker opens (`/inbox/<id>`, unit-tested in clickTarget.test.ts), so case 8
// loads that address. RPCs go over a fresh /ws socket from a second tab parked on a static file of the origin, so a
// navigation of the app tab never cuts one off.
//
// DOM hooks relied on (data-testid): rail-inbox (+ aria-label, aria-current), rail-inbox-count, rail-inbox-new,
//   inbox-page, inbox-chip-all, inbox-chip-waiting, inbox-chip-messages, inbox-waiting, inbox-waiting-empty,
//   inbox-card (+ data-kind, data-key), inbox-answered, inbox-messages, inbox-message (+ data-message-id, data-new,
//   class lit), inbox-open-run, inbox-archive, inbox-unarchive, inbox-delete, inbox-toast, inbox-undo,
//   inbox-show-archived, inbox-messages-empty, approval-card (+ data-status), approval-allow-once, approval-deny,
//   question-card, question-other, question-other-input, wf-approval-text, wf-approve, workflow-run-view, mode-tab-agents,
//   inbox-msg-more (+ aria-expanded); classes inbox-card-head, inbox-msg-title, inbox-msg-body.
// Stored state read: <dataDir>/chats.json, <dataDir>/chats/<id>.json, <dataDir>/workflow-messages.json.

import { createDecipheriv, createECDH, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort, start, unexpectedErrors } from './harness.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-workflow-claude.mjs', import.meta.url))
const AGENT = 'e2e-inbox-agent'
const BETA = 'e2e-inbox-beta'
// How the Inbox names them: by display name (displayName in shared/src/agentName.ts).
const AGENT_SHOWN = '@E2e Inbox Agent'
const BETA_SHOWN = '@E2e Inbox Beta'
const PREFIX = 'zumibot-e2e-inbox-'
const OVERALL_TIMEOUT = 5 * 60_000
const T = 15_000
const DEVICE = 'e2e-inbox-device'
const OTHER = 'Free and Pro, Team as a footnote'
const EDITED = 'EDITED-REPLY-4417'
const PAYLOAD_KEYS = ['v', 'kind', 'tag', 'chatId', 'title', 'agent', 'at', 'run', 'body', 'message']
const CASES = 10
// Case 9: a Notify body past the push's 200 characters (NOTIFY_BODY_MAX), a Markdown list of three links, as Zumi Bot writes it.
const LINKS = [
  ['Claude Code hooks are trending', 'https://www.notion.so/e2e/claude-code-hooks-0001'],
  ['Agents that write their own tests', 'https://www.notion.so/e2e/agents-write-tests-0002'],
  ['Prompt caching in long chats', 'https://www.notion.so/e2e/prompt-caching-0003']
]
const LAST_LINE = 'Reply in the chat if one of them needs another pass, or if a page should be dropped before it is shared.'
const LONG_BODY = [
  'Three new articles are drafted and saved as Notion pages. Each one covers a hashtag that trended on x.com today and is about Claude.',
  '',
  'Read them before they go out: each page ends with the sources it used and a short summary you can post as it is.',
  '',
  ...LINKS.map(([text, url]) => `- [${text}](${url})`),
  '',
  LAST_LINE
].join('\n')

let h = null
let push = null
let rpcPage = null
let ctx2 = null
const made = [] // every mkdtemp dir made here
const t0 = Date.now()
const results = [] // [case number, name, 'PASS' | 'FAIL']
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

// One stop for both the overall timeout and the end of main, so neither exits while the other is still killing.
let stopping = null
const stop = () => (stopping ??= stopAll())
async function stopAll() {
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
  if (push) {
    const p = push
    push = null
    p.server.closeAllConnections()
    await new Promise((r) => p.server.close(r))
  }
}

// ---------- the fake push service and RFC 8291 decrypt (as in e2e:notifications), kept apart from the code under test ----------
async function startPushServer() {
  const port = await freePort()
  const got = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      got.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(201).end()
    })
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${port}`, server, got }
}

function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16)
  const idLen = body[20]
  const asPublic = body.subarray(21, 21 + idLen)
  const ct = body.subarray(21 + idLen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const uaPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  assert(plain[plain.length - 1] === 2, 'the push record does not end with the last-record delimiter')
  return plain.subarray(0, plain.length - 1).toString('utf8')
}

// One raw RPC over a fresh /ws socket from the parked tab, so the session cookie rides along and no presence is reported.
const rpc = (method, ...args) =>
  rpcPage.evaluate(
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

// chats:send resolves only when the reply ends, so a turn that waits on a card is sent without waiting for it: the
// promise is that turn's end, awaited once the card is answered.
const send = (chatId, text) => {
  const p = rpc('chats:send', chatId, text, [])
  p.catch(() => {}) // a rejection still fails the step that awaits it
  return p
}

const storedChats = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats
const metaOf = async (id) => (await storedChats()).find((c) => c.id === id)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])
const idle = async (id) => {
  const m = await metaOf(id)
  return Boolean(m) && !m.inFlight
}
const roomIdle = async (id) => {
  const m = await metaOf(id)
  return Boolean(m) && !m.inFlight && m.group.active.length === 0 && m.group.queue.length === 0
}
const messagesFile = () => join(h.dataDir, 'workflow-messages.json')
const storedMessages = async () => readFile(messagesFile(), 'utf8').then(JSON.parse)

// ---------- the fake claude's script ----------
const SID = '3b1f5c2a-9d4e-4f60-8a71-b2c3d4e5f607'
const line = (o) => JSON.stringify(o)
const init = () => line({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-haiku-5-5', permissionMode: 'default' })
const say = (text) =>
  line({
    type: 'assistant',
    message: {
      model: 'claude-haiku-5-5',
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: null,
      usage: { input_tokens: 2, output_tokens: 2 }
    },
    parent_tool_use_id: null,
    session_id: SID,
    uuid: randomUUID()
  })
const result = (text) => line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: SID, uuid: randomUUID() })
// A tool request that waits for the user's answer, as the manual-mode CLI makes it.
const request = (requestId, toolName, input) => [
  line({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'can_use_tool',
      tool_name: toolName,
      input,
      description: 'e2e card',
      decision_reason: 'needs approval',
      tool_use_id: `toolu_${requestId}`
    }
  }),
  `#WAIT_RESPONSE ${requestId}`
]
const cardTurn = (requestId, toolName, input) =>
  writeFile(h.script, [init(), ...request(requestId, toolName, input), say('Done.'), result('Done.')].join('\n') + '\n')

// ---------- workflow builders: ids double as handles ----------
const step = (id, kind, name, x, y, extra = {}) => ({ id, handle: id, name, kind, x, y, ...extra })
const edge = (from, port, to) => ({ id: `${from}-${port}-${to}`, from, port, to })
const draft = (name, steps, edges) => ({ id: null, name, enabled: true, timeZone: 'UTC', trigger: { kind: 'manual' }, steps, edges })
async function save(input) {
  const w = await rpc('workflows:save', input)
  // Saved on: a save never turns on a workflow with problems, so this proves it has none.
  assert(w.enabled === input.enabled, `"${input.name}" saved with enabled ${w.enabled}, so it has problems`)
  return w
}
const getRun = (runId) => rpc('workflows:getRun', runId)
async function runUntil(runId, pred, what, timeout = 30_000) {
  let last = null
  await waitFor(
    async () => {
      last = await getRun(runId)
      return last !== null && pred(last)
    },
    timeout,
    what
  )
  return last
}
const ended = (r) => !['running', 'waiting'].includes(r.status)
const visitOf = (r, stepId) => r.visits.find((v) => v.stepId === stepId)

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  const responsesFile = join(await mk('responses'), 'responses.jsonl')
  for (const [name, what] of [
    [AGENT, 'Inbox e2e agent.'],
    [BETA, 'Inbox e2e room member.']
  ]) {
    await writeFile(join(agentsDir, `${name}.md`), `---\nname: ${name}\ndescription: ${what}\nmodel: haiku\n---\nYou are a test agent.\n`)
  }
  push = await startPushServer()
  h = await start({
    mode: 'vps',
    fake: FAKE,
    dataDir,
    agentsDir,
    env: { ZUMIBOT_TEST_PUSH_ORIGIN: push.origin, FAKE_RESPONSES_FILE: responsesFile }
  })
  const page = h.page
  await page.locator(tid('rail-inbox')).waitFor({ timeout: 30_000 })
  rpcPage = await h.newPage()
  await rpcPage.goto(`${h.origin}/favicon.png`)
  assert(new URL(rpcPage.url()).pathname === '/favicon.png', `the RPC tab landed on ${rpcPage.url()}`)
  // A new tab comes to the front: the app tab behind it gets no animation frames, which stalls every click on it.
  await page.bringToFront()

  // ---------- page helpers ----------
  const path = (p = page) => decodeURIComponent(new URL(p.url()).pathname)
  // count() first: textContent() on a badge that just left would wait its full timeout.
  const railCount = async () => {
    const badge = page.locator(tid('rail-inbox-count'))
    return (await badge.count()) ? await badge.textContent({ timeout: 500 }).catch(() => null) : null
  }
  const railCountIs = (want, what) => waitFor(async () => (await railCount()) === want, T, what)
  const railLabel = () => page.locator(tid('rail-inbox')).getAttribute('aria-label')
  const cards = () => page.locator(tid('inbox-card'))
  const cardOf = (chatId) => page.locator(`${tid('inbox-card')}[data-key^="${chatId}:"]`)
  const answered = () => page.locator(tid('inbox-answered'))
  const msgRow = (id) => page.locator(`${tid('inbox-message')}[data-message-id="${id}"]`)
  const openInbox = async () => {
    await page.click(tid('rail-inbox'))
    await page.locator(tid('inbox-page')).waitFor({ timeout: T })
    await waitFor(async () => path() === '/inbox', T, 'the address to read /inbox')
  }
  const responseTo = async (id) => {
    const lines = (await readFile(responsesFile, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    return lines.find((l) => l.response?.request_id === id)?.response?.response ?? null
  }
  // The answered line stays about 4 s after the answer settles, then the card's slot is gone.
  const lineGoes = (what) => waitFor(async () => (await answered().count()) === 0, T, what)

  const runCase = async (n, name, fn) => {
    try {
      await fn()
      results.push([n, name, 'PASS'])
      console.log(`PASS case ${n}: ${name}`)
    } catch (err) {
      results.push([n, name, 'FAIL'])
      console.log(`FAIL case ${n}: ${name}`)
      throw err
    }
  }

  let chatA = null
  await runCase(
    1,
    'a tool approval shows in the Inbox and the rail counts it; Allow once there answers it, the chat shows it allowed',
    async () => {
      assert((await railLabel()) === 'Inbox', `the rail's Inbox name is ${JSON.stringify(await railLabel())} with nothing waiting`)
      chatA = (await rpc('chats:create', AGENT, folder)).id
      await cardTurn('req-bash', 'Bash', { command: 'npm test' })
      const sent = send(chatA, 'Run the tests')
      await railCountIs('1', 'the rail to count the waiting card')
      assert((await railLabel()) === 'Inbox, 1 waiting', `the rail's Inbox name is ${JSON.stringify(await railLabel())}`)
      await openInbox()
      assert(
        (await page.locator(tid('rail-inbox')).getAttribute('aria-current')) === 'page',
        'the rail does not mark the Inbox as the page shown'
      )
      await waitFor(async () => (await cardOf(chatA).count()) === 1, T, "chat A's card in the Inbox")
      assert((await cardOf(chatA).getAttribute('data-kind')) === 'card', 'the card is not a chat card')
      const head = (await cardOf(chatA).locator('.inbox-card-head').textContent()) ?? ''
      assert(head.includes(AGENT_SHOWN) && head.includes('Open chat →'), `the card header reads ${JSON.stringify(head)}`)
      assert(
        ((await page.locator(tid('inbox-chip-waiting')).textContent()) ?? '').trim() === 'Waiting 1',
        'the Waiting chip does not say 1'
      )

      await cardOf(chatA).locator(tid('approval-allow-once')).click()
      await answered().first().waitFor({ timeout: T })
      const text = ((await answered().first().textContent()) ?? '').trim()
      assert(text.startsWith('✓ Allowed once') && text.endsWith(AGENT_SHOWN), `the answered line reads ${JSON.stringify(text)}`)
      await railCountIs(null, 'the rail count to hide')
      assert((await railLabel()) === 'Inbox', `the rail's Inbox name is ${JSON.stringify(await railLabel())} after the answer`)
      await waitFor(async () => (await responseTo('req-bash'))?.behavior === 'allow', T, 'the fake to get allow for req-bash')
      await lineGoes('the answered line to go')
      await page.locator(tid('inbox-waiting-empty')).waitFor({ timeout: T })
      await sent
      await waitFor(() => idle(chatA), T, "chat A's turn to end")

      await page.goto(`${h.origin}/chat/${encodeURIComponent(chatA)}`)
      const card = page.locator(tid('approval-card')).last()
      await card.waitFor({ timeout: T })
      await waitFor(async () => (await card.getAttribute('data-status')) === 'allowed-once', T, 'the chat to show the card allowed once')
      ok(
        'rail "Inbox, 1 waiting"; header names @agent; Allow once → answered line, count hidden, fake allowed, line gone, chat card allowed-once'
      )
    }
  )

  await runCase(2, 'a question card answered with Other text in the Inbox reaches the fake', async () => {
    await openInbox()
    const questions = {
      questions: [
        {
          question: 'Which plan tiers?',
          header: 'Tiers',
          options: [
            { label: 'Free', description: '' },
            { label: 'Pro', description: '' }
          ],
          multiSelect: false
        }
      ]
    }
    await cardTurn('req-question', 'AskUserQuestion', questions)
    const sent = send(chatA, 'Which tiers should the page show?')
    await waitFor(async () => (await cardOf(chatA).locator(tid('question-card')).count()) === 1, T, 'the question card in the Inbox')
    const card = cardOf(chatA)
    await card.locator(tid('question-other')).click()
    await card.locator(tid('question-other-input')).fill(OTHER)
    await card.locator(tid('question-other-input')).press('Enter')
    await answered().first().waitFor({ timeout: T })
    const text = ((await answered().first().textContent()) ?? '').trim()
    assert(text.startsWith('✓ Answered · Which plan tiers?'), `the answered line reads ${JSON.stringify(text)}`)
    let got = null
    await waitFor(async () => (got = await responseTo('req-question')) !== null, T, 'the fake to get the answer')
    assert(
      got.behavior === 'allow' && JSON.stringify(got.updatedInput?.answers) === JSON.stringify({ 'Which plan tiers?': OTHER }),
      `the fake got ${JSON.stringify(got)}`
    )
    await railCountIs(null, 'the rail count to hide after the answer')
    await lineGoes('the answered line to go')
    await sent
    await waitFor(() => idle(chatA), T, "chat A's second turn to end")
    ok(`Other text typed in the Inbox reached the fake as {"Which plan tiers?": "${OTHER}"}`)
  })

  await runCase(3, 'a card answered in its own chat on another device leaves the open Inbox at once; the rail number follows', async () => {
    const chatB = (await rpc('chats:create', AGENT, folder)).id
    const chatC = (await rpc('chats:create', AGENT, folder)).id
    await cardTurn('req-b', 'Bash', { command: 'git status' })
    const sentB = send(chatB, 'Check the tree')
    await waitFor(async () => (await cardOf(chatB).count()) === 1, T, "chat B's card in the open Inbox")
    await railCountIs('1', 'the rail to count B')
    // B's run has read the script by now (its card shows), so C's may have its own.
    await cardTurn('req-c', 'Bash', { command: 'git log -1' })
    const sentC = send(chatC, 'Show the last commit')
    await waitFor(async () => (await cards().count()) === 2, T, 'two cards in the open Inbox')
    await railCountIs('2', 'the rail to count two')
    assert(((await page.locator(tid('inbox-chip-waiting')).textContent()) ?? '').trim() === 'Waiting 2', 'the Waiting chip does not say 2')
    const keys = await cards().evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
    assert(keys[0].startsWith(`${chatB}:`) && keys[1].startsWith(`${chatC}:`), `the cards are not oldest first: ${JSON.stringify(keys)}`)

    ctx2 = await h.newContext()
    const p2 = await ctx2.newPage()
    await p2.goto(`${h.origin}/chat/${encodeURIComponent(chatB)}`)
    const card = p2.locator(tid('approval-card')).last()
    await card.locator(tid('approval-deny')).click({ timeout: 30_000 })
    await waitFor(async () => (await card.getAttribute('data-status')) === 'denied', T, 'the other device to show B denied')
    await waitFor(async () => (await cardOf(chatB).count()) === 0, T, "B's card to leave the open Inbox")
    assert((await answered().count()) === 0, 'a card answered elsewhere left an answered line in the Inbox')
    assert((await cardOf(chatC).count()) === 1, "C's card left too")
    await railCountIs('1', 'the rail to follow down to 1')
    await ctx2.close()
    ctx2 = null
    await page.bringToFront()

    await cardOf(chatC).locator(tid('approval-allow-once')).click()
    await railCountIs(null, 'the rail count to hide after C')
    await waitFor(async () => (await responseTo('req-c'))?.behavior === 'allow', T, 'the fake to get allow for req-c')
    assert((await responseTo('req-b'))?.behavior === 'deny', 'the fake did not get deny for req-b')
    await lineGoes("C's answered line to go")
    await Promise.all([sentB, sentC])
    await waitFor(async () => (await idle(chatB)) && (await idle(chatC)), T, 'B and C to end')
    ok('B denied on a second device left the Inbox with no answered line, rail 2 → 1; C allowed from the Inbox, rail hidden')
  })

  await runCase(4, "a room member's card names the member in its header and is answered with the member", async () => {
    const room = (await rpc('chats:createGroup', [AGENT, BETA], folder, '')).id
    await cardTurn('req-room', 'Bash', { command: 'npm run lint' })
    const sent = send(room, `@${BETA} check the lint`)
    await waitFor(async () => (await cardOf(room).count()) === 1, 30_000, "the room member's card in the Inbox")
    const head = (await cardOf(room).locator('.inbox-card-head').textContent()) ?? ''
    assert(head.includes(BETA_SHOWN) && !head.includes(AGENT_SHOWN), `the room card header reads ${JSON.stringify(head)}`)
    const title = (await metaOf(room))?.title ?? ''
    assert(
      title === '' || head.includes(title),
      `the room card header ${JSON.stringify(head)} lacks the room title ${JSON.stringify(title)}`
    )
    await cardOf(room).locator(tid('approval-allow-once')).click()
    await answered().first().waitFor({ timeout: T })
    const text = ((await answered().first().textContent()) ?? '').trim()
    assert(text.endsWith(BETA_SHOWN), `the room's answered line reads ${JSON.stringify(text)}`)
    await waitFor(async () => (await responseTo('req-room'))?.behavior === 'allow', T, 'the fake to get allow for req-room')
    await sent
    await waitFor(() => roomIdle(room), 30_000, 'the room turn to end')
    const stored = (await itemsOf(room)).find((i) => i.type === 'approval' && i.id === 'req-room')
    assert(
      stored?.agent === BETA && stored.status === 'allowed-once',
      `the room's card is stored as ${JSON.stringify(stored && { agent: stored.agent, status: stored.status })}`
    )
    await railCountIs(null, 'the rail count to hide after the room card')
    await lineGoes("the room card's answered line to go")
    ok(`the room card reads @${BETA}; Allow once reached the fake and the stored card is ${BETA}'s, allowed-once`)
  })

  let inboxFlow = null
  let msgA = null
  await runCase(5, "a workflow Approval approved from the Inbox with edited text: the next step's input is that text", async () => {
    inboxFlow = await save(
      draft(
        'Inbox flow',
        [
          step('trig', 'trigger', 'Trigger', 0, 0),
          step('approve', 'approval', 'Send it?', 260, 0, { question: 'Send this reply?', editable: true }),
          step('tell', 'notify', 'Tell me', 520, 0, { title: 'Inbox check', body: '{{input}}' })
        ],
        [edge('trig', 'out', 'approve'), edge('approve', 'approved', 'tell')]
      )
    )
    const { id: runId } = await rpc('workflows:run', inboxFlow.id, 'draft reply')
    await runUntil(runId, (r) => r.status === 'waiting', 'the run to wait on its approval')
    const card = page.locator(`${tid('inbox-card')}[data-kind="workflow"]`)
    await card.waitFor({ timeout: T })
    await railCountIs('1', 'the rail to count the workflow approval')
    const head = (await card.locator('.inbox-card-head').textContent()) ?? ''
    assert(head.includes('Inbox flow › Send it?') && head.includes('Open run →'), `the workflow card header reads ${JSON.stringify(head)}`)
    assert((await card.locator(tid('wf-approval-text')).inputValue()) === 'draft reply', 'the approval box does not hold the step input')
    await card.locator(tid('wf-approval-text')).fill(EDITED)
    await card.locator(tid('wf-approve')).click()
    await answered().first().waitFor({ timeout: T })
    const text = ((await answered().first().textContent()) ?? '').trim()
    assert(text === '✓ Approved · Inbox flow › Send it?', `the answered line reads ${JSON.stringify(text)}`)
    const done = await runUntil(runId, ended, 'the run to end after Approve')
    assert(done.status === 'done', `the run ended ${done.status}: ${done.error}`)
    assert(
      visitOf(done, 'approve').port === 'approved' && visitOf(done, 'approve').output === EDITED,
      `the approval output is ${JSON.stringify(visitOf(done, 'approve').output)}`
    )
    const told = visitOf(done, 'tell')
    assert(told?.status === 'done' && told.input === EDITED, `the Notify step's input is ${JSON.stringify(told?.input)}`)
    msgA = told.id
    await railCountIs(null, 'the rail count to hide after the approval')
    await lineGoes("the approval's answered line to go")
    ok('the workflow card reads "Inbox flow › Send it?"; edited text approved there is the Notify step\'s input; the run is done')
  })

  await runCase(
    6,
    'the Notify message shows as new and survives a reload; Archive, Unarchive, Delete with Undo, then a Delete past the toast',
    async () => {
      const row = msgRow(msgA)
      await row.waitFor({ timeout: T })
      // The page was open before the message came, so it stays marked while it is read.
      assert((await row.getAttribute('data-new')) === 'true', 'the new message is not marked new')
      assert(((await row.locator('.inbox-msg-title').textContent()) ?? '') === 'Inbox check', 'the message title is not the Notify title')
      assert(((await row.locator('.inbox-msg-body').textContent()) ?? '') === EDITED, 'the message body is not the edited text')
      assert(
        ((await page.locator(tid('inbox-chip-messages')).textContent()) ?? '').trim() === 'Messages · 1 new',
        'the Messages chip does not say 1 new'
      )
      const stored = (await storedMessages()).messages.find((m) => m.id === msgA)
      assert(
        stored && stored.workflowId === inboxFlow.id && stored.stepName === 'Tell me' && stored.workflowName === 'Inbox flow',
        `the stored message is ${JSON.stringify(stored)}`
      )
      await waitFor(async () => (await storedMessages()).seenAt >= stored.at, T, 'the open Inbox to mark the message seen on the server')
      await waitFor(
        async () => (await page.locator(tid('rail-inbox-new')).count()) === 0,
        T,
        'the rail dot to stay off while the Inbox shows'
      )

      // The chips filter the one stream; each section is hidden, not removed, under the other chip.
      await page.click(tid('inbox-chip-messages'))
      await waitFor(async () => !(await page.locator(tid('inbox-waiting')).isVisible()), T, 'Waiting to hide under the Messages chip')
      assert(await page.locator(tid('inbox-messages')).isVisible(), 'Messages hidden under its own chip')
      await page.click(tid('inbox-chip-waiting'))
      await waitFor(async () => !(await page.locator(tid('inbox-messages')).isVisible()), T, 'Messages to hide under the Waiting chip')
      assert(await page.locator(tid('inbox-waiting')).isVisible(), 'Waiting hidden under its own chip')
      await page.click(tid('inbox-chip-all'))
      await row.waitFor({ timeout: T })

      await page.reload()
      await row.waitFor({ timeout: T })
      assert(path() === '/inbox', `a reload left ${path()}`)
      ok('the message shows new, with its title and body; seen on the server; chips filter; a reload keeps it')

      await row.locator(tid('inbox-open-run')).click()
      await page.waitForURL(new RegExp(`/workflows/${inboxFlow.id}/runs/[^/]+$`), { timeout: T })
      await page.locator(tid('workflow-run-view')).waitFor({ timeout: T })
      await openInbox()
      await row.waitFor({ timeout: T })

      await row.locator(tid('inbox-archive')).click()
      await waitFor(async () => (await row.count()) === 0, T, 'Archive to fold the message away')
      const fold = page.locator(tid('inbox-show-archived'))
      await waitFor(async () => ((await fold.textContent().catch(() => '')) ?? '').trim() === 'Show archived (1)', T, '"Show archived (1)"')
      await page.locator(tid('inbox-messages-empty')).waitFor({ timeout: T })
      await fold.click()
      await row.locator(tid('inbox-unarchive')).click({ timeout: T })
      await waitFor(async () => (await fold.count()) === 0, T, 'Unarchive to empty the archive')
      await row.locator(tid('inbox-archive')).waitFor({ timeout: T })
      ok('Archive → Show archived (1); Unarchive brings it back')

      await row.locator(tid('inbox-delete')).click()
      await page.locator(tid('inbox-toast')).waitFor({ timeout: T })
      await waitFor(async () => (await row.count()) === 0, T, 'Delete to remove the message')
      await page.click(tid('inbox-undo'))
      await row.waitFor({ timeout: T })
      assert((await page.locator(tid('inbox-toast')).count()) === 0, 'the toast stayed after Undo')

      await row.locator(tid('inbox-delete')).click()
      await page.locator(tid('inbox-toast')).waitFor({ timeout: T })
      await waitFor(async () => (await page.locator(tid('inbox-toast')).count()) === 0, 10_000, 'the Undo toast to go after 6 s')
      await page.reload()
      await page.locator(tid('inbox-messages-empty')).waitFor({ timeout: T })
      assert((await row.count()) === 0, 'the deleted message is back after a reload')
      const tomb = (await storedMessages()).messages.find((m) => m.id === msgA)
      assert(tomb && typeof tomb.deletedAt === 'number', `the deleted message is stored as ${JSON.stringify(tomb)}`)
      ok('Delete → Undo restores; a Delete left past the toast is gone after a reload (a tombstone on disk)')
    }
  )

  let ping = null
  const pingOnce = async (input) => {
    const { id: runId } = await rpc('workflows:run', ping.id, input)
    const done = await runUntil(runId, ended, `the ping run "${input}" to end`)
    assert(done.status === 'done', `the ping run "${input}" ended ${done.status}`)
    return visitOf(done, 'tell').id
  }
  let msgTwo = null
  await runCase(7, 'messages and the archive state survive a server restart', async () => {
    ping = await save(
      draft(
        'Ping flow',
        [step('trig', 'trigger', 'Trigger', 0, 0), step('tell', 'notify', 'Ping me', 260, 0, { title: 'Ping', body: '{{input}}' })],
        [edge('trig', 'out', 'tell')]
      )
    )
    const msgOne = await pingOnce('one')
    msgTwo = await pingOnce('two')
    await msgRow(msgOne).locator(tid('inbox-archive')).click({ timeout: T })
    await waitFor(
      async () => typeof (await storedMessages()).messages.find((m) => m.id === msgOne)?.archivedAt === 'number',
      T,
      'the archive to be stored'
    )
    await msgRow(msgTwo).waitFor({ timeout: T })

    await h.restartServer()
    await page.reload()
    await page.locator(tid('inbox-page')).waitFor({ timeout: 30_000 })
    await msgRow(msgTwo).waitFor({ timeout: T })
    assert((await msgRow(msgOne).count()) === 0, 'the archived message shows in the stream after the restart')
    assert((await msgRow(msgA).count()) === 0, 'the deleted message came back after the restart')
    const fold = page.locator(tid('inbox-show-archived'))
    assert(
      ((await fold.textContent({ timeout: T })) ?? '').trim() === 'Show archived (1)',
      'the archive does not hold one message after the restart'
    )
    await fold.click()
    await msgRow(msgOne).locator(tid('inbox-unarchive')).waitFor({ timeout: T })
    await fold.click() // folded again, for case 8's scroll
    const mode = (await stat(messagesFile())).mode & 0o777
    assert(mode === 0o600, `workflow-messages.json mode is ${mode.toString(8)}`)
    ok('after a restart: "two" in the stream, "one" under Show archived (1), the deleted one still gone; the file is 0600')
  })

  await runCase(
    8,
    'a Notify push carries the message id; opening /inbox/<id> scrolls to and lights it, then the address is /inbox',
    async () => {
      await page.click(tid('mode-tab-agents'))
      await waitFor(async () => path() === '/', T, 'Agents to leave the Inbox')
      const ua = createECDH('prime256v1')
      ua.generateKeys()
      const auth = randomBytes(16)
      const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
      await rpc('notify:enable', DEVICE, { channel: 'push', label: 'e2e', subscription: { endpoint: `${push.origin}/inbox`, keys } })
      const pushes = () => push.got.map((g) => JSON.parse(decrypt(g.body, ua.getPrivateKey(), auth)))

      const msgThree = await pingOnce('three')
      await page.locator(tid('rail-inbox-new')).waitFor({ timeout: T })
      assert(
        (await railLabel()) === 'Inbox, new messages',
        `the rail's Inbox name is ${JSON.stringify(await railLabel())} with a new message`
      )
      let p = null
      await waitFor(
        async () => (p = pushes().find((x) => x.kind === 'workflow' && x.message === msgThree) ?? null) !== null,
        T,
        'the Notify push with the message id'
      )
      assert(
        Object.keys(p).every((k) => PAYLOAD_KEYS.includes(k)),
        `the push has extra fields: ${Object.keys(p)}`
      )
      assert(
        p.title === 'Ping' && p.body === 'three' && p.chatId === null && p.run?.workflowId === ping.id,
        `the Notify push is ${JSON.stringify(p)}`
      )
      ok(`the Notify push carries message ${msgThree}; the rail shows the new-message dot`)

      // Newer messages push this one below the fold, so opening it has to scroll. No more pushes: the cap is per minute.
      await rpc('notify:disable', DEVICE)
      for (let i = 1; i <= 10; i++) await pingOnce(`filler ${i}`)
      await page.goto(`${h.origin}/inbox/${encodeURIComponent(msgThree)}`)
      const row = msgRow(msgThree)
      await row.waitFor({ timeout: 30_000 })
      await waitFor(async () => /\blit\b/.test((await row.getAttribute('class')) ?? ''), T, 'the message to be lit')
      await waitFor(async () => path() === '/inbox', T, 'the address to become /inbox')
      assert((await row.getAttribute('data-new')) === 'true', 'the opened message is not marked new')
      const pos = await row.evaluate((el) => {
        let s = el.parentElement
        while (s && !(s.scrollHeight > s.clientHeight && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement
        const scroller = s ?? document.scrollingElement
        const view = s ? s.getBoundingClientRect() : { top: 0, bottom: innerHeight }
        const r = el.getBoundingClientRect()
        return {
          scrollTop: scroller.scrollTop,
          clientHeight: scroller.clientHeight,
          top: r.top,
          bottom: r.bottom,
          viewTop: view.top,
          viewBottom: view.bottom
        }
      })
      assert(
        pos.top - pos.viewTop + pos.scrollTop > pos.clientHeight,
        `the message sits within the first screen (${JSON.stringify(pos)}), so this proves no scroll`
      )
      assert(
        pos.scrollTop > 0 && pos.top >= pos.viewTop && pos.bottom <= pos.viewBottom,
        `the message was not scrolled into view: ${JSON.stringify(pos)}`
      )
      await waitFor(async () => (await page.locator(tid('rail-inbox-new')).count()) === 0, T, 'the rail dot to go once the Inbox shows')
      await waitFor(async () => !/\blit\b/.test((await row.getAttribute('class')) ?? ''), T, 'the light to fade')
      assert(path() === '/inbox', `the address moved on to ${path()}`)
      ok('/inbox/<id> scrolled the message into view and lit it (still marked new); the address became /inbox; the rail dot went')
    }
  )

  await runCase(
    9,
    'a Notify body of 600 characters with three links reaches the Inbox whole, links clickable; the push holds 200',
    async () => {
      assert(LONG_BODY.length >= 580 && LONG_BODY.length <= 620, `the body is ${LONG_BODY.length} characters, not about 600`)
      // A fresh device: case 8's is off, and its pushes stay apart from this one's.
      const ua = createECDH('prime256v1')
      ua.generateKeys()
      const auth = randomBytes(16)
      const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
      const device = `${DEVICE}-long`
      await rpc('notify:enable', device, {
        channel: 'push',
        label: 'e2e long',
        subscription: { endpoint: `${push.origin}/inbox-long`, keys }
      })
      const longFlow = await save(
        draft(
          'Long flow',
          [
            step('trig', 'trigger', 'Trigger', 0, 0),
            step('tell', 'notify', 'Links', 260, 0, { title: 'Hashtag articles', body: LONG_BODY })
          ],
          [edge('trig', 'out', 'tell')]
        )
      )
      const { id: runId } = await rpc('workflows:run', longFlow.id, '')
      const done = await runUntil(runId, ended, 'the long Notify run to end')
      assert(done.status === 'done', `the long Notify run ended ${done.status}: ${done.error}`)
      const msgId = visitOf(done, 'tell').id

      let p = null
      const mine = () => push.got.filter((g) => g.path === '/inbox-long').map((g) => JSON.parse(decrypt(g.body, ua.getPrivateKey(), auth)))
      await waitFor(
        async () => (p = mine().find((x) => x.kind === 'workflow' && x.message === msgId) ?? null) !== null,
        T,
        'the long Notify push'
      )
      assert(p.title === 'Hashtag articles', `the push title is ${JSON.stringify(p.title)}`)
      assert(
        p.body.length === 200 && p.body === LONG_BODY.slice(0, 200),
        `the push body is ${p.body.length} characters: ${JSON.stringify(p.body)}`
      )
      await rpc('notify:disable', device)

      const stored = (await storedMessages()).messages.find((m) => m.id === msgId)
      assert(stored?.body === LONG_BODY, `the stored Inbox message holds ${stored?.body?.length} of ${LONG_BODY.length} characters`)

      await page.goto(`${h.origin}/inbox`)
      const row = msgRow(msgId)
      await row.waitFor({ timeout: 30_000 })
      const body = row.locator('.inbox-msg-body')
      // Past a few lines the body folds behind Show all, as the Audit log's boxes do.
      const more = row.locator(tid('inbox-msg-more'))
      const folded = (await more.count()) > 0
      if (folded) {
        await more.click()
        await waitFor(async () => (await more.getAttribute('aria-expanded')) === 'true', T, 'Show all to open the body')
      }
      const text = (await body.textContent()) ?? ''
      for (const [linkText, url] of LINKS) {
        const a = body.locator(`a[href="${url}"]`)
        assert((await a.count()) === 1 && (await a.textContent()) === linkText, `the body has no link "${linkText}" to ${url}`)
        assert(text.includes(linkText), `the body text lacks "${linkText}"`)
      }
      assert(text.includes(LAST_LINE) && text.includes(LONG_BODY.slice(0, 60)), 'the Inbox body is not whole')
      // An outside link opens a new tab, so the Inbox stays open.
      assert((await body.locator('a').first().getAttribute('target')) === '_blank', 'an outside link in the body does not open a new tab')
      ok(
        `a ${LONG_BODY.length}-character Notify body is whole in the Inbox (stored and shown${folded ? ', behind Show all' : ''}) with 3 links; the push body is its first 200`
      )
    }
  )

  await runCase(10, "a card above the chat's newest page shows in the Inbox after a reload and is answered there", async () => {
    const chat = (await rpc('chats:create', AGENT, folder)).id
    // 70 replies after the card, more than a page of items (ITEMS_PAGE, 60), so the newest page holds no card.
    const after = Array.from({ length: 70 }, (_, i) => say(`Step ${i + 1} while the card waits.`))
    const [ask, wait] = request('req-deep', 'Bash', { command: 'make deploy' })
    await writeFile(h.script, [init(), ask, ...after, wait, say('Done.'), result('Done.')].join('\n') + '\n')
    const sent = send(chat, 'Deploy it')
    await waitFor(
      async () => {
        const items = await itemsOf(chat)
        const at = items.findIndex((i) => i.type === 'approval' && i.id === 'req-deep')
        return at >= 0 && items.length - at > 60
      },
      30_000,
      'the card and the 70 replies after it to be stored'
    )
    const counts = await rpc('chats:pending')
    assert(counts[chat] === 1, `the server counts ${JSON.stringify(counts)}`)
    // A load rebuilds the counts, which pushes alone never resend: the card must still show.
    await page.goto(`${h.origin}/inbox`)
    await waitFor(async () => (await cardOf(chat).count()) === 1, 30_000, 'the card above the newest page in the Inbox after a reload')
    await railCountIs('1', 'the rail to count the card above the newest page')
    await cardOf(chat).locator(tid('approval-allow-once')).click()
    await waitFor(async () => (await responseTo('req-deep'))?.behavior === 'allow', T, 'the fake to get allow for req-deep')
    await sent
    await waitFor(() => idle(chat), T, 'the turn behind the deep card to end')
    await railCountIs(null, 'the rail count to hide after the deep card')
    await lineGoes("the deep card's answered line to go")
    ok('a card 70 items above the newest page shows after a reload (the server counts it), the rail counts it, Allow once reaches the fake')
  })

  const bad = unexpectedErrors(h.errors, [
    // The restart in case 7 may refuse a tab's reconnect until the new server listens (as in e2e:workflows).
    /WebSocket connection to '[^']*\/ws' failed: .*net::ERR_CONNECTION_REFUSED/
  ])
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
const passed = results.filter((r) => r[2] === 'PASS').length
console.log(`cases: ${passed} passed, ${results.length - passed} failed, ${CASES - results.length} not run`)
console.log(failed ? 'e2e:inbox FAILED' : 'e2e:inbox passed')
process.exit(failed ? 1 : 0)
