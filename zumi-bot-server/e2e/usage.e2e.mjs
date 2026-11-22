// End-to-end check of Usage (cost chip, Usage page, estimates of old chats) in the built server + web UI (local mode)
// against the FAKE claude: no real CLI turn is ever sent, so no login or quota is used. Usage: npm run e2e:usage   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME (<root>/home), agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// The exact record comes from the result line of the basic fixture (total_cost_usd 0.00461255); the old chat is only a
// session log under <home>/.claude/projects/p/old-s1.jsonl that the server prices itself.
//
// DOM hooks relied on (data-testid): new-chat-folder, new-chat-choose-folder, agent-row (+ data-agent-name), new-chat,
//   composer-input, send-button, message-list, cost-chip, cost-pop, cost-open-usage, usage-page, usage-chat-filter,
//   usage-total, usage-legend-estimated, usage-tab-chat, usage-row (+ data-key), cold-notice, cold-dismiss, agent-menu-button,
//   agent-menu-edit, compact-choice, context-chip, context-popup.
// Stored state read: <dataDir>/chats.json, <dataDir>/usage-records.jsonl, the agent file, the fake's env (FAKE_ENV_OUT).
// A resumed run is measured from the session's last cost-state line (seeded here, as the CLI writes it), not from zero.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start, unexpectedErrors, pickOption, selectValue } from './harness.mjs'

const AGENT = 'e2e-usage-agent'
const PREFIX = 'zumibot-e2e-usage-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 20_000
const OLD_ID = 'old-chat'

let h = null
const made = []
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const text = async (page, id) => ((await page.locator(tid(id)).textContent()) ?? '').trim()

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

// Two logged assistant messages of the old chat, claude-sonnet-5-5 (shared/src/pricing.ts: input 2, output 10,
// cache read 0.2, 5m cache write 2.5 USD per MTok; the lines carry no TTL split, so every write is a 5m write):
//   m1: 10000*2 + 20000*10 + 500000*0.2 + 100000*2.5 = 20000 + 200000 + 100000 + 250000 = 570000 / 1e6 = 0.57
//   m2:  5000*2 + 10000*10 + 200000*0.2 +      0*2.5 =  10000 + 100000 +  40000 +      0 = 150000 / 1e6 = 0.15
const EXPECTED_ESTIMATE = '$0.72'
const logLine = (id, ts, u) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(ts).toISOString(),
    message: { id, model: 'claude-sonnet-5-5', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: u }
  })

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const work = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  const envOut = join(await mk('env'), 'env.json')
  const invocations = join(await mk('invocations'), 'invocations.jsonl')
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Usage e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  h = await start({
    mode: 'local',
    fake: true,
    dataDir,
    agentsDir,
    env: { ZUMIBOT_TEST_PICK_FOLDER: work, FAKE_ENV_OUT: envOut, FAKE_INVOCATIONS_OUT: invocations, ZUMIBOT_TEST_KEEPWARM_MS: '3000' }
  })
  const page = h.page
  await page.locator(tid('new-agent')).waitFor({ timeout: 30_000 })

  // 1. an old chat: a session log only, no usage records; the restart makes the server scan it
  const now = Date.now()
  // Its context is big and its last request two hours old: the prompt cache has expired.
  const meta = {
    id: OLD_ID,
    agentName: AGENT,
    sessionId: 'old-s1',
    cwd: work,
    title: 'Old chat',
    createdAt: now - 3_600_000,
    updatedAt: now - 3_600_000,
    inFlight: false,
    context: { used: 730_000, window: 1_000_000, at: now - 7_200_000 }
  }
  await mkdir(join(dataDir, 'chats'), { recursive: true })
  await writeFile(join(dataDir, 'chats.json'), JSON.stringify({ chats: [meta] }))
  await writeFile(join(dataDir, 'chats', `${OLD_ID}.json`), '[]')
  await mkdir(join(h.root, 'home', '.claude', 'projects', 'p'), { recursive: true })
  await writeFile(
    join(h.root, 'home', '.claude', 'projects', 'p', 'old-s1.jsonl'),
    [
      logLine('msg_old_1', now - 3_000_000, {
        input_tokens: 10000,
        output_tokens: 20000,
        cache_read_input_tokens: 500000,
        cache_creation_input_tokens: 100000
      }),
      logLine('msg_old_2', now - 2_900_000, {
        input_tokens: 5000,
        output_tokens: 10000,
        cache_read_input_tokens: 200000,
        cache_creation_input_tokens: 0
      })
    ].join('\n') + '\n'
  )
  await h.restartServer()
  await page.reload()
  await page.locator(tid('new-agent')).waitFor({ timeout: 30_000 })
  ok('old chat seeded: two logged messages, no usage records, server restarted')

  // 2. a new chat: the fake's result carries total_cost_usd 0.00461255 -> an exact record
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  await page.locator(tid('composer-input')).fill('ping')
  await page.locator(tid('send-button')).click()
  await page.waitForURL(/\/chat\//, { timeout: T })
  await page.locator(tid('cost-chip')).waitFor({ timeout: 30_000 })
  await waitFor(async () => (await text(page, 'cost-chip')).includes('$0.0046'), T, 'the cost chip to show $0.0046')
  ok(`cost chip shows the exact cost: ${await text(page, 'cost-chip')}`)

  // 3. chip -> popover -> Usage page, filtered to this chat
  await page.locator(tid('cost-chip')).click()
  await page.locator(tid('cost-pop')).waitFor({ timeout: T })
  await page.locator(tid('cost-open-usage')).click()
  await page.locator(tid('usage-chat-filter')).waitFor({ timeout: T })
  assert(new URL(page.url()).pathname === '/settings/usage', `Usage opened at ${page.url()}`)
  await waitFor(async () => (await text(page, 'usage-total')) === '$0.0046', T, 'the filtered total to be $0.0046')
  ok('Usage opens in Settings with the "This chat" filter and total $0.0046')

  // 4. clear the filter: the old chat is estimated from its log
  await page.locator(tid('usage-chat-filter')).click()
  await page.locator(tid('usage-chat-filter')).waitFor({ state: 'detached', timeout: T })
  await waitFor(async () => (await page.getByText('Estimating old chats…').count()) === 0, 60_000, 'the estimating note to go away')
  await waitFor(
    async () => (await text(page, 'usage-legend-estimated')).includes(EXPECTED_ESTIMATE),
    T,
    `the Estimated legend to show ${EXPECTED_ESTIMATE}`
  )
  ok(`Estimated legend equals the seeded lines' price: ${EXPECTED_ESTIMATE}`)
  await page.locator(tid('usage-tab-chat')).click()
  await waitFor(async () => (await page.locator(tid('usage-row')).count()) === 2, T, 'two chats in the Chat tab')
  const keys = await page.locator(tid('usage-row')).evaluateAll((els) => els.map((e) => e.getAttribute('data-key')))
  assert(keys.includes(OLD_ID), `the old chat is listed (keys ${JSON.stringify(keys)})`)
  const rec = (await readFile(join(dataDir, 'usage-records.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  assert(
    rec.some(
      (r) =>
        r.kind === 'cost' &&
        r.chatId !== OLD_ID &&
        Math.abs(Object.values(r.models).reduce((a, m) => a + (m.costUsd ?? 0), 0) - 0.00461255) < 1e-9
    ),
    'one exact cost record is stored'
  )
  assert(!rec.some((r) => r.kind === 'cost' && r.chatId === OLD_ID), 'the old chat has no stored cost record (it is only estimated)')
  ok('Chat tab lists both chats; the exact record is stored, the old chat only estimated')

  // 5. a resumed turn: the CLI restores the session's last cost-state and adds the run to it, so only the difference counts
  const chats = JSON.parse(await readFile(join(dataDir, 'chats.json'), 'utf8')).chats
  const fresh = chats.find((c) => c.id !== OLD_ID)
  assert(fresh?.sessionId, 'the new chat saved its session id')
  await mkdir(join(h.root, 'home', '.claude', 'projects', 'p2'), { recursive: true })
  // The fixture's result: haiku-5-5, input 2, output 4, cache read 22835, cache write 21910, $0.00461255.
  const costState = {
    type: 'cost-state',
    sessionId: fresh.sessionId,
    totalCostUSD: 0.004,
    modelUsage: {
      'claude-haiku-5-5': { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 20000, cacheCreationInputTokens: 21910, costUSD: 0.004 }
    }
  }
  await writeFile(join(h.root, 'home', '.claude', 'projects', 'p2', `${fresh.sessionId}.jsonl`), JSON.stringify(costState) + '\n')
  // Records are keyed by the result's uuid, and the fake replays one fixture: each later run gets its own.
  const basic = await readFile(h.script, 'utf8')
  const resultUuid = (n) => writeFile(h.script, basic.replace(/("type":"result".*?"uuid":")[^"]+/, `$1e2e-usage-run-${n}`))
  await resultUuid(2)
  await page.goto(new URL(`/chat/${fresh.id}`, page.url()).href)
  await page.locator(tid('composer-input')).fill('again')
  await page.locator(tid('send-button')).click()
  const costsOf = async (id) =>
    (await readFile(join(dataDir, 'usage-records.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === 'cost' && r.chatId === id)
  await waitFor(async () => (await costsOf(fresh.id)).length === 2, 30_000, 'a second cost record')
  const second = (await costsOf(fresh.id)).sort((a, b) => a.at - b.at)[1]
  const m = second.models['claude-haiku-5-5']
  assert(second.v === 2, 'the record is a per-run one')
  assert(
    Math.abs(m.costUsd - 0.00061255) < 1e-9 && m.cacheRead === 2835 && m.cacheWrite === 0 && m.output === 0,
    `the second run counts only its own cost: ${JSON.stringify(m)}`
  )
  ok('a resumed turn records only what it added to the restored cost-state ($0.00061255, not the session total)')

  // 6. the old chat: 730K of context and an expired cache, so the composer says what the next message costs
  await page.goto(new URL(`/chat/${OLD_ID}`, page.url()).href)
  await page.locator(tid('cold-notice')).waitFor({ timeout: T })
  const notice = await text(page, 'cold-notice')
  assert(notice.includes('730K tokens') && notice.includes('idle 2 h'), `the cold notice reads ${JSON.stringify(notice)}`)
  await page.locator(tid('cold-dismiss')).click()
  await page.locator(tid('cold-notice')).waitFor({ state: 'detached', timeout: T })
  ok('a big chat with an expired cache shows the cold notice; Dismiss hides it')

  // 7. Agent Studio: Compact at 400K writes the CLI's key, and the agent's next run gets it as env
  // The menu button sits next to the row, in the same line.
  const line = page.locator('.agent-line').filter({ has: page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`) })
  await line.hover()
  await line.locator(tid('agent-menu-button')).click()
  await page.locator(tid('agent-menu-edit')).click()
  await page.locator(tid('compact-choice')).filter({ hasText: '400K' }).click()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await waitFor(
    async () => (await readFile(join(agentsDir, `${AGENT}.md`), 'utf8')).includes('autoCompactWindow: 400000'),
    T,
    'the agent file to hold autoCompactWindow: 400000'
  )
  await resultUuid(3)
  await page.goto(new URL(`/chat/${fresh.id}`, page.url()).href)
  await page.locator(tid('composer-input')).fill('third')
  await page.locator(tid('send-button')).click()
  await waitFor(async () => (await costsOf(fresh.id)).length === 3, 30_000, 'a third cost record')
  const env = JSON.parse(await readFile(envOut, 'utf8'))
  assert(
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW === '400000',
    `the run's env has CLAUDE_CODE_AUTO_COMPACT_WINDOW=${env.CLAUDE_CODE_AUTO_COMPACT_WINDOW}`
  )
  ok('Compact at 400K is saved as autoCompactWindow and reaches the next run as CLAUDE_CODE_AUTO_COMPACT_WINDOW')
  // The ring now fills up to 400K (where the agent compacts), not to the 1M window.
  await waitFor(
    async () => ((await page.locator(tid('context-chip')).getAttribute('data-tip')) ?? '').includes('/ 400K before compacting'),
    T,
    'the ring to measure against 400K'
  )
  await page.locator(tid('context-chip')).click()
  await waitFor(
    async () => (await text(page, 'context-popup')).includes('Compacts by itself at about 400K'),
    T,
    'the popover to name the Compact at size'
  )
  await page.keyboard.press('Escape')
  ok(`the context ring measures against Compact at: ${await page.locator(tid('context-chip')).getAttribute('data-tip')}`)

  // 8. the old chat now compacts by itself before its next request (400K < 730K), so no notice
  await page.goto(new URL(`/chat/${OLD_ID}`, page.url()).href)
  await page.locator(tid('composer-input')).waitFor({ timeout: T })
  await sleep(500)
  assert((await page.locator(tid('cold-notice')).count()) === 0, 'no cold notice once the agent compacts below the context size')
  ok('no cold notice once the agent compacts below that size by itself')

  // 9. keep warm: a big idle context gets a forked, unsaved ping that reads its cache, recorded as Keep warm; Off stops it
  // The fixture's requests report 150K of cache read, so the context is big enough to keep warm.
  const big = basic.replace(/"cache_read_input_tokens":\d+/g, '"cache_read_input_tokens":150000')
  await writeFile(h.script, big.replace(/("type":"result".*?"uuid":")[^"]+/, '$1e2e-usage-run-big'))
  await page.goto(new URL(`/chat/${fresh.id}`, page.url()).href)
  await page.locator(tid('composer-input')).fill('big one')
  await page.locator(tid('send-button')).click()
  await waitFor(async () => (await costsOf(fresh.id)).some((r) => r.id === 'e2e-usage-run-big'), 30_000, 'the big turn to be recorded')
  // The ping's own result id, so its record is not taken for the turn's, and its own session id: a fork that reports
  // the session it resumed is refused as an ignored --fork-session (the fake ignores the flag).
  const sid = JSON.parse(big.split('\n').find((l) => l.includes('"subtype":"init"'))).session_id
  await writeFile(h.script, big.replaceAll(sid, 'e2e-warm-fork').replace(/("type":"result".*?"uuid":")[^"]+/, '$1e2e-usage-warm'))
  // A ping resumes the chat's session; Agent Studio's loadout probe (the Compact at step opened it) is unsaved too, but
  // resumes nothing.
  const pings = async () =>
    (await readFile(invocations, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l).args)
      .filter((a) => a.includes('--no-session-persistence') && a.includes('--resume'))
  await waitFor(async () => (await pings()).length >= 1, 30_000, 'a keep-warm ping')
  const ping = (await pings())[0]
  assert(ping.includes('--fork-session') && ping.includes('--resume'), `the ping is not a fork of the session: ${JSON.stringify(ping)}`)
  await waitFor(
    async () => (await costsOf(fresh.id)).some((r) => r.agent === '#keepwarm'),
    T,
    'the ping cost to be recorded as keep warm'
  ).catch(async (e) => {
    const all = (await readFile(join(dataDir, 'usage-records.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((r) => r.kind === 'cost')
    throw new Error(
      `${e.message}; pings ${(await pings()).length}; cost records ${JSON.stringify(all.map((r) => [r.id, r.agent, r.chatId === fresh.id]))}`
    )
  })
  await page.goto(new URL('/settings/general', page.url()).href)
  await page.locator(tid('keep-warm-chats')).waitFor({ timeout: T })
  assert((await selectValue(page.locator(tid('keep-warm-chats')))) === '2', 'keep warm for chats does not default to 2 hours')
  await pickOption(page.locator(tid('keep-warm-chats')), '0')
  await waitFor(
    async () => (await readFile(join(dataDir, 'settings.json'), 'utf8').then(JSON.parse)).keepWarm?.chatHours === 0,
    T,
    'keep warm for chats to be saved as off'
  )
  await sleep(4000) // a ping already due may still run once
  const settled = (await pings()).length
  await sleep(7000)
  assert((await pings()).length === settled, 'pings went on after keep warm was turned off')
  ok('a big idle chat gets a forked ping recorded as Keep warm, and turning it off in Settings stops the pings')

  // 10. nothing unexpected
  // The restart in step 1 keeps the port, so the tab's reconnect can find it closed for a moment.
  const bad = unexpectedErrors(h.errors, [/WebSocket connection to '[^']*\/ws' failed: .*net::ERR_CONNECTION_REFUSED/])
  assert(bad.length === 0, `unexpected console/server errors:\n${bad.join('\n')}`)
  ok('no unexpected console or server errors')
}

const timer = setTimeout(() => {
  console.error(`FAIL: overall timeout ${OVERALL_TIMEOUT / 1000} s`)
  void stop().finally(() => process.exit(1))
}, OVERALL_TIMEOUT)
timer.unref()

let code = 0
try {
  await main()
  console.log('USAGE E2E PASSED')
} catch (err) {
  code = 1
  console.error(err instanceof Error ? err.message : err)
} finally {
  await stop()
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
process.exit(code)
