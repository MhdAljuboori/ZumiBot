// Smoke of an ACP agent against a REAL agent, through the built server and the web UI (local mode, manual permission mode).
// Not part of `npm run e2e`: the agent spends its own quota. Opt-in, named by ZUMIBOT_SMOKE_ACP (`<command> <args…>`, split
// on spaces, no quoting), for example:
//   ZUMIBOT_SMOKE_ACP='claude-agent-acp' npm run smoke:acp
//   ZUMIBOT_SMOKE_ACP='gemini --acp' npm run smoke:acp
// Without it, this prints how to run it and exits 0.
//
// The harness runs with fake:false, so the server keeps the real HOME and the agent signs in with its own login there (or an
// env key already in this shell, which reaches it as it would any run). The data dir, agents dir and vault key folder are temp
// ones: nothing of the real data dir is read or copied. Nothing here reads, prints or copies the agent's own login, and the
// arguments are never printed (only the command).
// Steps, each judged PASS, FAIL or INCONCLUSIVE (the model did something else, or the agent is not signed in; not a product
// verdict):
//   1. The agent is saved with `agents:save`, the call Agent Studio's Save makes, which confirms its launch on this machine.
//      Test (`agents:testAcp`) reads its `initialize`: what it supports and what ZumiBot hides.
//   2. A chat that answers: one short reply, its session stored as an ACP one.
//   3. "run `touch smoke.txt` then say done": a Bash card is approved on the page, and the file is there. ZumiBot puts the
//      agent in its `default` mode first, where it has one; a write is asked there (a read such as `ls` is not, by the Claude
//      adapter). A touch that ran with no card is INCONCLUSIVE: the agent's own settings decide which calls ask.
//   4. "run exactly: python3 -c "import time; time.sleep(60)"": Stop is pressed while it waits (after its card is approved, or
//      once it runs in the folder); the chat ends with the stopped notice and nothing is left running in the folder. A Python
//      wait, since the Claude adapter's CLI refuses a foreground `sleep 60`.
// Cards go through smokeGate.mjs: a Bash card is approved only when its command is exactly a shape its step asks for; any other
// card, or one whose request can't be read, is denied, printed and makes its step INCONCLUSIVE (never PASS).
// Exit 0 all PASS, 1 any FAIL, 2 otherwise.

import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from './harness.mjs'
import { killOwnedChild } from './e2eChecks.mjs'
import { isAllowedSmokeCommand } from './smokeGate.mjs'

const AGENT = 'smoke-acp'
const TURN_MS = 180_000
const T = 15_000
// Verbatim from shared/src/acp.ts (ACP_TEXT.notSignedIn's start).
const NOT_SIGNED_IN = 'The agent is not signed in.'
const tid = (id) => `[data-testid="${id}"]`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const launch = (process.env.ZUMIBOT_SMOKE_ACP ?? '').trim().split(/\s+/).filter(Boolean)
if (launch.length === 0) {
  console.log(
    [
      'smoke:acp runs a real ACP agent, so it is opt-in. Name the agent with ZUMIBOT_SMOKE_ACP="<command> <args…>", for example:',
      "  ZUMIBOT_SMOKE_ACP='claude-agent-acp' npm run smoke:acp",
      "  ZUMIBOT_SMOKE_ACP='gemini --acp' npm run smoke:acp",
      'The agent must already be signed in with its own login. See docs/architecture/e2e.md.'
    ].join('\n')
  )
  process.exit(0)
}
const [command, ...args] = launch

let h = null
let folder = null
const made = []
const results = []
const t0 = Date.now()
const say = (m) => console.log(`${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
const verdict = (step, v, note) => {
  results.push({ step, v, note })
  say(`smoke: ${step}: ${v}${note ? ` (${note})` : ''}`)
}

const storedChats = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats
const metaOf = async (id) => (await storedChats()).find((c) => c.id === id)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])

const rpc = (page, method, ...rpcArgs) =>
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
    { method, args: rpcArgs }
  )

/** Processes (pid, args) whose working folder is `dir` or below and whose command line matches `re`. Linux /proc only. */
function processesIn(dir, re) {
  const found = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const cwd = readlinkSync(`/proc/${name}/cwd`)
      if (cwd !== dir && !cwd.startsWith(`${dir}/`)) continue
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
      if (re.test(cmd)) found.push({ pid: Number(name), args: cmd })
    } catch {
      /* gone, or not ours to read */
    }
  }
  return found
}

/** The request a pending card stands for, as the server stored it: the tool and, for Bash, the exact command; null if unread. */
async function storedRequest(chatId, id) {
  if (!chatId || !id) return null
  for (let i = 0; i < 20; i++) {
    const item = (await itemsOf(chatId)).find((x) => x.type === 'approval' && x.id === id)
    if (item)
      return {
        tool: String(item.toolName),
        command: item.toolName === 'Bash' && typeof item.input?.command === 'string' ? item.input.command : null,
        input: item.input
      }
    await sleep(150)
  }
  return null
}

/** Answers one pending card at `step` ('touch', 'wait', or 'none'): Allow once only when the gate says so, else Deny (fail closed). */
async function answerCard(chatId, card, step) {
  const id = await card.getAttribute('data-request-id').catch(() => null)
  const req = await storedRequest(chatId, id).catch(() => null)
  const allow = req !== null && req.tool === 'Bash' && isAllowedSmokeCommand(req.command, step)
  const text =
    req === null
      ? '(a card whose request could not be read)'
      : (req.command ?? `${req.tool} ${JSON.stringify(req.input ?? null).slice(0, 300)}`)
  await card.locator(tid(allow ? 'approval-allow-once' : 'approval-deny')).click()
  if (!allow) say(`smoke: denied card at step ${step}: ${text}`)
  return { id, tool: req?.tool ?? null, text, allowed: allow }
}

/**
 * Sends `text` in the open chat (or, with `sent`, follows a turn already sent from the new-chat screen) and answers every pending
 * card at `step`, until the chat is idle again or `until()` says to stop waiting. Returns the chat id and the cards answered.
 */
async function turn(page, chatId, text, { step, until = null, timeout = TURN_MS, sent = false } = {}) {
  const before = chatId ? (await itemsOf(chatId)).length : 0
  if (!sent) {
    await page.locator(tid('composer-input')).click()
    await page.keyboard.type(text)
    await page.click(tid('send-button'))
  }
  const cards = []
  const end = Date.now() + timeout
  let started = false
  while (Date.now() < end) {
    chatId ??= /\/chat\/([^/?#]+)$/.exec(new URL(page.url()).pathname)?.[1] ?? null
    const card = page.locator(`${tid('approval-card')}[data-status="pending"]`).first()
    if (chatId && (await card.count())) {
      const id = await card.getAttribute('data-request-id').catch(() => null)
      if (!cards.some((c) => c.id === id)) cards.push(await answerCard(chatId, card, step))
    }
    if (until && (await until(cards))) return { chatId, cards }
    const m = chatId ? await metaOf(chatId) : null
    if (m?.inFlight) started = true
    if (started && m && !m.inFlight && (await itemsOf(chatId)).length > before) return { chatId, cards }
    await sleep(250)
  }
  throw new Error(`the turn "${text}" did not end in ${timeout / 1000} s`)
}

const denials = (cards) => cards.filter((c) => !c.allowed).map((c) => c.text)
const cardList = (cards) => JSON.stringify(cards.map((c) => `${c.allowed ? 'allowed' : 'denied'}: ${c.text}`))
const lastReply = async (chatId) => (await itemsOf(chatId)).filter((i) => i.type === 'assistant').at(-1)?.text ?? ''
const errorsSince = async (chatId, n) =>
  (await itemsOf(chatId))
    .slice(n)
    .filter((i) => i.type === 'error')
    .map((i) => i.text)
/** A signed-out agent is a setup problem, not a product verdict. */
const signedOut = (errors) => errors.some((e) => e.startsWith(NOT_SIGNED_IN))

async function main() {
  say(`smoke: ACP agent command ${JSON.stringify(command)} with ${args.length} argument(s)`)
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `zumibot-acp-smoke-${n}-`))), made.at(-1))
  folder = await mk('folder')
  for (const [f, body] of [
    ['alpha.txt', 'one\n'],
    ['beta.txt', 'two\n'],
    ['notes.md', '# Notes\n']
  ])
    await writeFile(join(folder, f), body)
  spawnSync('git', ['init', '-q'], { cwd: folder })
  const agentsDir = await mk('agents')
  h = await start({ agentsDir, env: { ZUMIBOT_TEST_PICK_FOLDER: folder } })
  const page = h.page
  await page.locator(tid('new-agent')).waitFor({ timeout: 30_000 })

  // 1. Save (confirms the launch) and Test
  {
    const body =
      'You are a helpful coding agent. Keep replies to one or two sentences. Run only the exact commands the user names, as they are written, and run nothing else first. Do not read files the user did not name.'
    const raw = `---\nname: ${AGENT}\ndescription: ACP smoke agent.\nprovider: acp\nacp:\n  command: ${JSON.stringify(command)}\n  args: ${JSON.stringify(args)}\n---\n${body}\n`
    const saved = await rpc(page, 'agents:save', null, raw)
    if (!saved?.ok) return verdict('1 save + Test', 'INCONCLUSIVE', `the agent could not be saved: ${saved?.error ?? 'no answer'}`)
    await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: T })
    const test = await rpc(page, 'agents:testAcp', AGENT)
    if ('error' in test) {
      const notFound = /could not find the command/.test(test.error)
      return verdict('1 save + Test', notFound ? 'INCONCLUSIVE' : 'FAIL', test.error)
    }
    const info = test.agentInfo ? `${test.agentInfo.title ?? test.agentInfo.name} ${test.agentInfo.version ?? ''}`.trim() : 'not named'
    verdict(
      '1 save + Test',
      'PASS',
      `agent ${info}, protocol ${test.protocolVersion}, resume ${test.resume}, load ${test.loadSession}, systemPrompt ${test.systemPrompt}, image ${test.image}, sign-in ${JSON.stringify(test.authMethods.map((m) => m.name))}, hidden ${JSON.stringify(test.hidden)}`
    )
  }

  // 2. a chat that answers
  let chatId = null
  {
    await page.click(`${tid('agent-row')}[data-agent-name="${AGENT}"]`)
    await page.click(tid('new-chat-folder'))
    await page.click(tid('new-chat-choose-folder'))
    await page.locator(tid('composer-input')).click()
    await page.keyboard.type('Reply with exactly one word: pong')
    await page.click(tid('send-button'))
    let cards
    ;({ chatId, cards } = await turn(page, null, 'pong', { step: 'none', sent: true }))
    const meta = await metaOf(chatId)
    const reply = await lastReply(chatId)
    const errors = await errorsSince(chatId, 0)
    const note = `reply ${JSON.stringify(reply.slice(0, 200))}, session ${meta?.sessionEngine ?? 'none'}, cards ${cardList(cards)}, errors ${JSON.stringify(errors)}`
    if (signedOut(errors)) return verdict('2 a chat that answers', 'INCONCLUSIVE', `the agent is not signed in; ${note}`)
    if (errors.length || !reply.trim() || meta?.sessionEngine !== 'acp') verdict('2 a chat that answers', 'FAIL', note)
    else if (cards.length) verdict('2 a chat that answers', 'INCONCLUSIVE', `cards outside the allowlist were denied; ${note}`)
    else verdict('2 a chat that answers', 'PASS', note)
  }

  // 3. a write behind an approved card
  {
    const step = '3 touch + approved card'
    const n = (await itemsOf(chatId)).length
    const { cards } = await turn(page, chatId, 'run `touch smoke.txt` then say done', { step: 'touch' })
    const reply = await lastReply(chatId)
    const errors = await errorsSince(chatId, n)
    const tools = (await itemsOf(chatId)).slice(n).filter((i) => i.type === 'tool')
    const wrote = await readFile(join(folder, 'smoke.txt')).then(
      () => true,
      () => false
    )
    const approved = cards.some((c) => c.allowed)
    const note = `cards ${cardList(cards)}, tool rows ${JSON.stringify(tools.map((t) => t.name))}, file ${wrote ? 'made' : 'missing'}, reply ${JSON.stringify(reply.slice(0, 200))}, errors ${JSON.stringify(errors)}`
    if (errors.length) verdict(step, 'FAIL', note)
    else if (denials(cards).length) verdict(step, 'INCONCLUSIVE', `cards outside the allowlist were denied; ${note}`)
    else if (!approved)
      verdict(
        step,
        'INCONCLUSIVE',
        `no card was approved (the agent ${wrote ? 'wrote without asking: its own settings decide' : 'ran no touch'}); ${note}`
      )
    else if (!wrote) verdict(step, 'FAIL', `the approved touch made no file; ${note}`)
    else verdict(step, 'PASS', note)
  }

  // 4. Stop while a 60 s wait runs: nothing is left in the folder
  {
    const step = '4 Stop during a 60 s wait'
    const n = (await itemsOf(chatId)).length
    let runningAt = null
    let stopped = false
    const { cards } = await turn(page, chatId, 'run exactly this shell command, then say done: python3 -c "import time; time.sleep(60)"', {
      step: 'wait',
      // Stop a few seconds after the wait was allowed (or seen running, when the agent did not ask), while it runs.
      until: async (seen) => {
        if (runningAt === null && (seen.some((c) => c.allowed) || processesIn(folder, /time\.sleep\(60\)/).length > 0))
          runningAt = Date.now()
        if (stopped || runningAt === null || Date.now() - runningAt < 4000) return false
        const button = page.locator(tid('send-button'))
        if ((await button.getAttribute('data-tip')) !== 'Stop') return false
        const running = processesIn(folder, /./).length
        await button.click()
        stopped = true
        say(`smoke: Stop pressed (${running} process(es) running in the folder)`)
        return true
      },
      timeout: 120_000
    })
    let notice = null
    const end = stopped ? Date.now() + 30_000 : 0
    while (Date.now() < end) {
      const m = await metaOf(chatId)
      notice = (await itemsOf(chatId)).slice(n).find((i) => i.type === 'notice' && i.kind === 'stopped') ?? null
      if (m && !m.inFlight && notice) break
      await sleep(250)
    }
    // The tree gets SIGTERM, then SIGKILL after the runner's 5 s force grace: judge only once that grace has passed.
    await sleep(7000)
    const left = processesIn(folder, /./)
    const note = `cards ${cardList(cards)}, stopped notice ${notice ? 'yes' : 'no'}, processes left in the folder ${JSON.stringify(left.map((p) => p.args.split(' ')[0]))}`
    for (const p of left)
      try {
        process.kill(p.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    if (!stopped) verdict(step, 'INCONCLUSIVE', `no wait ran; ${note}`)
    else if (!notice || left.length > 0) verdict(step, 'FAIL', note)
    else if (denials(cards).length) verdict(step, 'INCONCLUSIVE', `cards outside the allowlist were denied; ${note}`)
    else verdict(step, 'PASS', note)
  }
}

try {
  await main()
} catch (err) {
  verdict('run', 'INCONCLUSIVE', `the smoke could not finish: ${err instanceof Error ? err.message : String(err)}`)
} finally {
  if (h) {
    await Promise.race([h.stop().catch(() => {}), sleep(30_000)])
    killOwnedChild(h.server)
  }
  // Anything a crash left in the temp folders goes before they are deleted.
  for (const d of made)
    for (const p of processesIn(d, /./))
      try {
        process.kill(p.pid, 'SIGKILL')
      } catch {
        /* gone */
      }
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
console.log('acp smoke: summary')
for (const r of results) console.log(`  ${r.step}: ${r.v}`)
const code = results.some((r) => r.v === 'FAIL') ? 1 : results.every((r) => r.v === 'PASS') && results.length > 0 ? 0 : 2
console.log(code === 0 ? 'smoke:acp PASS' : code === 1 ? 'smoke:acp FAILED' : 'smoke:acp INCONCLUSIVE')
process.exit(code)
