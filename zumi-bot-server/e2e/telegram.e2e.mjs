// End-to-end check of the Telegram channel in the built server + web UI (local mode) against the FAKE claude and a fake Telegram
// Bot API (backend/tests/fixtures/fake-telegram.mjs): no real Telegram, CLI turn, login or quota is ever used.
// Usage: npm run e2e:telegram   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server, Chrome and the fake Telegram started here are stopped in `finally`; overall timeout 4 min.
// ZUMIBOT_TEST_TELEGRAM_URL points the server at the fake.
//
// DOM hooks relied on (data-testid): settings-channels, channel-token, channel-token-save, channel-state, channel-run,
//   channel-agent-<name>, channel-pair, channel-code, channel-paired, channel-mark, chat-row (+ data-chat-id), agent-row
//   (+ data-agent-name), agent-toggle, chat-menu-channel, user-message, approval-card (+ data-status, data-request-id), approval-deny,
//   channel-notify-replied.
// Stored state read: <dataDir>/channel-tokens.json (the token is sealed, never readable), <dataDir>/channels.json.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start, unexpectedErrors } from './harness.mjs'
import { FAKE_TOKEN, startFakeTelegram } from '../backend/tests/fixtures/fake-telegram.mjs'

const PREFIX = 'zumibot-e2e-telegram-'
const OVERALL_TIMEOUT = 4 * 60_000
const T = 15_000
const AGENT = 'tg'
const OFF = 'quiet'
const OWNER = 1001
const STRANGER = 2002

let h = null
let tg = null
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
const sentTexts = () => tg.sent().map((p) => String(p.text))
const waitSent = (pred, what) => waitFor(() => sentTexts().some(pred), T, what)

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

async function expandAgent(page, name) {
  const toggle = page
    .locator(`${tid('agent-row')}[data-agent-name="${name}"]`)
    .locator('xpath=..')
    .locator(tid('agent-toggle'))
  await toggle.waitFor({ timeout: T })
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
}

const logsHave = (needle) => [...h.output, ...h.errors].join('\n').includes(needle)

async function stop() {
  if (h) {
    const cur = h
    h = null
    await Promise.race([cur.stop().catch(() => {}), sleep(30_000)])
  }
  if (tg) {
    const f = tg
    tg = null
    await f.close()
  }
}

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  for (const name of [AGENT, OFF])
    await writeFile(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: Telegram e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
    )
  tg = await startFakeTelegram()
  h = await start({ fake: true, dataDir, agentsDir, env: { ZUMIBOT_TEST_TELEGRAM_URL: tg.origin } })
  const page = h.page

  // 1. Settings › Channels: the token is saved, sealed, and never comes back; the bot runs here and connects.
  await page.goto(`${h.origin}/settings/channels`)
  await page.locator(tid('settings-channels')).waitFor({ timeout: 30_000 })
  await page.locator(tid('channel-token')).fill(FAKE_TOKEN)
  await page.locator(tid('channel-token-save')).click()
  await waitFor(async () => (await page.locator(tid('channel-token')).inputValue()) === '', T, 'the token field to clear')
  const sealed = await readFile(join(dataDir, 'channel-tokens.json'), 'utf8')
  assert(!sealed.includes(FAKE_TOKEN.split(':')[1]), 'the token is readable on disk')
  await page.locator(tid('channel-run')).check()
  await waitFor(
    async () => (await page.locator(tid('channel-state')).textContent()) === 'Connected as @test_zumibot.',
    T,
    'the bot to connect'
  )
  ok('1 the token is saved sealed, the field clears, and the bot connects')

  // 2. Every agent starts off; turning one on is stored.
  assert(!(await page.locator(tid(`channel-agent-${AGENT}`)).isChecked()), 'an agent started on')
  await page.locator(tid(`channel-agent-${AGENT}`)).check()
  await waitFor(
    async () => JSON.parse(await readFile(join(dataDir, 'channels.json'), 'utf8')).telegram.agents.includes(AGENT),
    T,
    'the switch to be stored'
  )
  ok('2 agents start off; one is turned on')

  // 3. Pairing: a stranger's guesses get no answer; the owner's code pairs, and Settings follows.
  await page.locator(tid('channel-pair')).click()
  const line = await page.locator(tid('channel-code')).textContent()
  const code = /([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(line)?.[1]
  assert(code, `no code shown: ${line}`)
  tg.message(STRANGER, 'AAAA-BBBB')
  tg.message(STRANGER, 'hello')
  tg.message(OWNER, code)
  await page.locator(tid('channel-paired')).waitFor({ timeout: T })
  assert(
    tg.sent().every((p) => Number(p.chat_id) !== STRANGER),
    'the stranger got an answer'
  )
  ok('3 pairs with the code, never answers a stranger')

  // 4. A chat from Telegram: /new, a message, the reply back; the web UI shows the same chat with its mark.
  tg.message(OWNER, `/new ${AGENT}`)
  await waitSent((t) => t.startsWith('New chat:'), 'the new chat')
  tg.message(OWNER, 'ping from the phone')
  await waitSent((t) => t.includes('pong'), 'the reply')
  const chats = await rpc(page, 'chats:list')
  const chat = chats.find((c) => c.agentName === AGENT)
  assert(chat?.channel?.platform === 'telegram', 'the chat is not marked as linked')
  await page.goto(`${h.origin}/chat/${encodeURIComponent(chat.id)}`)
  await page.locator(tid('user-message')).filter({ hasText: 'ping from the phone' }).waitFor({ timeout: T })
  await expandAgent(page, AGENT)
  await page.locator(`${tid('chat-row')}[data-chat-id="${chat.id}"] ${tid('channel-mark')}`).waitFor({ timeout: T })
  ok('4 a message from Telegram is a turn in the same chat, the reply goes back, and the web UI marks the chat')

  // 5. A chat made in the web UI continues in Telegram from its menu; one whose agent is off is refused.
  const webChat = (await rpc(page, 'chats:create', AGENT, folder)).id
  const offChat = (await rpc(page, 'chats:create', OFF, folder)).id
  await page.reload()
  await expandAgent(page, AGENT)
  await page.locator(`${tid('chat-row')}[data-chat-id="${webChat}"]`).click({ button: 'right' })
  await page.locator(tid('chat-menu-channel')).click()
  await waitSent((t) => t.startsWith('Continuing here:'), 'the continue notice')
  tg.message(OWNER, 'second chat now')
  await waitFor(
    async () => (await rpc(page, 'chats:items', webChat)).items.some((i) => i.type === 'user' && i.text === 'second chat now'),
    T,
    'the message to land in the web chat'
  )
  await expandAgent(page, OFF)
  await page.locator(`${tid('chat-row')}[data-chat-id="${offChat}"]`).click({ button: 'right' })
  await page.locator(tid('chat-menu-channel')).click()
  await page.getByText("This chat's agent is not available from Telegram").waitFor({ timeout: T })
  await page.keyboard.press('Escape')
  ok('5 Continue in Telegram moves the conversation; an agent left off is refused')

  // 6. Cards (phase 2): a card answered in the web UI updates its Telegram message; one answered in Telegram updates the web card.
  const SID = 's-e2e-card'
  const L = (o) => JSON.stringify(o)
  const cardScript = (req, cmd) =>
    [
      L({ type: 'system', subtype: 'init', session_id: SID }),
      L({
        type: 'assistant',
        session_id: SID,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `t-${req}`, name: 'Bash', input: { command: cmd } }] }
      }),
      L({
        type: 'control_request',
        request_id: req,
        request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: cmd }, tool_use_id: `t-${req}` }
      }),
      `#WAIT_RESPONSE ${req}`,
      L({
        type: 'user',
        session_id: SID,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t-${req}`, content: 'ok', is_error: false }] }
      }),
      L({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: `done ${req}` }] } }),
      L({ type: 'result', subtype: 'success', is_error: false, result: `done ${req}`, session_id: SID, total_cost_usd: 0 })
    ].join('\n') + '\n'
  const cardFor = (cmd) =>
    waitFor(() => tg.sent().some((p) => String(p.text).includes(cmd) && p.reply_markup), T, `the card for ${cmd}`).then(() =>
      tg.calls.find((c) => c.method === 'sendMessage' && String(c.params.text).includes(cmd) && c.params.reply_markup)
    )
  await writeFile(h.script, cardScript('r-web', 'echo from-web'))
  await page.goto(`${h.origin}/chat/${encodeURIComponent(webChat)}`)
  tg.message(OWNER, 'run the web one')
  const webCard = await cardFor('echo from-web')
  assert(
    webCard.params.reply_markup.inline_keyboard
      .flat()
      .map((b) => b.text)
      .join('|') === 'Allow once|Deny',
    'the card offers more than Allow once and Deny'
  )
  await page.locator(`${tid('approval-card')}[data-status="pending"] ${tid('approval-deny')}`).click()
  await waitFor(
    () =>
      tg.calls.some(
        (c) =>
          c.method === 'editMessageText' &&
          c.params.message_id === webCard.messageId &&
          String(c.params.text).includes('✗ Denied in ZumiBot')
      ),
    T,
    'the Telegram card to show the web answer'
  )
  await waitSent((t) => t.includes('done r-web'), 'the turn to end')
  await writeFile(h.script, cardScript('r-tg', 'echo from-phone'))
  tg.message(OWNER, 'run the phone one')
  const tgCard = await cardFor('echo from-phone')
  await page.locator(`${tid('approval-card')}[data-status="pending"]`).waitFor({ timeout: T })
  const allow = tgCard.params.reply_markup.inline_keyboard[0][0]
  tg.press(OWNER, tgCard.messageId, allow.callback_data)
  await page.locator(`${tid('approval-card')}[data-request-id="r-tg"][data-status="allowed-once"]`).waitFor({ timeout: T })
  await waitFor(
    () =>
      tg.calls.some(
        (c) =>
          c.method === 'editMessageText' &&
          c.params.message_id === tgCard.messageId &&
          String(c.params.text).includes('✓ Allowed once') &&
          !String(c.params.text).includes('in ZumiBot')
      ),
    T,
    'the Telegram card to show its own answer'
  )
  tg.press(OWNER, tgCard.messageId, allow.callback_data)
  await waitFor(
    () => tg.calls.some((c) => c.method === 'answerCallbackQuery' && c.params.text === 'That button is no longer active.'),
    T,
    'the stale press notice'
  )
  assert(!logsHave(allow.callback_data), 'a card token reached a log line')
  ok('6 a card answered in the web UI updates Telegram, one answered in Telegram updates the web card, and a stale press changes nothing')

  // 7. Notifications (phase 4): with Replied on in Settings, a web turn in a chat nobody has open tells Telegram, title only.
  await writeFile(
    h.script,
    [
      L({ type: 'system', subtype: 'init', session_id: SID }),
      L({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: 'private reply text' }] } }),
      L({ type: 'result', subtype: 'success', is_error: false, result: 'private reply text', session_id: SID, total_cost_usd: 0 })
    ].join('\n') + '\n'
  )
  await page.goto(`${h.origin}/settings/channels`)
  await page.locator(tid('channel-notify-replied')).check()
  await waitFor(
    async () => JSON.parse(await readFile(join(dataDir, 'channels.json'), 'utf8')).telegram.notify.replied === true,
    T,
    'the notify switch to be stored'
  )
  const quiet = (await rpc(page, 'chats:create', AGENT, folder)).id
  await rpc(page, 'chats:rename', quiet, 'Quiet chat')
  await rpc(page, 'chats:send', quiet, 'hello from the web', [])
  await waitSent((t) => t === '<b>Quiet chat</b>\nTg replied', 'the replied notice')
  assert(
    !sentTexts().some((t) => t.includes('private reply text') || t.includes('hello from the web')),
    'reply or prompt text went to Telegram'
  )
  ok('7 with Replied on, a web turn notifies Telegram with the title only')

  // 8. Nothing secret in the logs.
  await sleep(500)
  const logs = [...h.output, ...h.errors].join('\n')
  assert(!logs.includes(FAKE_TOKEN.split(':')[1]), 'the token reached a log line')
  assert(!logs.includes(code.replace('-', '')), 'the pairing code reached a log line')
  const bad = unexpectedErrors(h.errors, [/^server stderr: pause hook unavailable/])
  assert(bad.length === 0, `unexpected console/server errors:\n${bad.join('\n')}`)
  ok('8 no token or code in any log; no unexpected errors')
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
console.log(failed ? 'e2e:telegram FAILED' : 'e2e:telegram passed')
process.exit(failed ? 1 : 0)
