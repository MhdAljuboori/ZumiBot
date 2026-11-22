// Smoke of a remote (AG-UI) agent against a REAL AG-UI server, through the built server and the web UI (local mode).
// Not part of `npm run e2e`: the server may spend a model's quota. Opt-in:
//   ZUMIBOT_SMOKE_AGUI         the endpoint URL (required; without it this prints how to run it and exits 0)
//   ZUMIBOT_SMOKE_AGUI_KEY     optional: the NAME of an env variable in this shell that holds the server's key (its value is
//                                never printed); it goes into the Vault, granted to the smoke agent, as its authKey
//   ZUMIBOT_SMOKE_AGUI_HEADER  optional: the auth header (default Authorization, which sends "Bearer <value>")
// for example:
//   ZUMIBOT_SMOKE_AGUI=http://127.0.0.1:8765/agent npm run smoke:agui
//   ZUMIBOT_SMOKE_AGUI=https://agents.example.com/run ZUMIBOT_SMOKE_AGUI_KEY=MY_AGENT_KEY npm run smoke:agui
//
// A loopback endpoint (127.0.0.0/8, ::1 or localhost) turns on the dev hook ZUMIBOT_AGUI_ALLOW_LOCAL=1 in the server's env
// (the harness is not production, so devEnv() honours it), which also lets plain http reach it; the smoke says so. Any other
// endpoint is checked as in production: https only, every address public. The harness runs with the fake claude and a temp
// HOME, data dir, agents dir and vault key folder: no claude call can reach a model, and nothing of the real data dir is read.
// The prompts are the ones the scripted Pydantic AI server keys on (docs/architecture/e2e.md, smoke:agui). Steps, each judged
// PASS, FAIL or INCONCLUSIVE (the server did something else, or it is not reachable; not a product verdict):
//   1. The agent is saved with `agents:save`, the call Agent Studio's Save makes, which confirms its endpoint on this machine;
//      the key, if any, is granted in the Vault. Test (`agents:testAgui`) checks the address and connects, sending no request.
//   2. "Reply with exactly one word: pong": PASS when the reply is `pong` and the chat is marked an AG-UI one.
//   3. "Run the approval demo": the server's interrupt must show as one Yes/No question (Pydantic AI's approval, its optional
//      fields pruned); Yes is answered, and PASS when the reply is `done: pretended to delete demo.txt`. No interrupt is
//      INCONCLUSIVE; an interrupt ZumiBot could not show (its notice) is FAIL.
//   4. "Run the slow demo" (a tool that waits 60 s): Stop is pressed once the remote tool row shows; PASS when the chat ends with
//      the stopped notice within 10 s and no error item.
// Any step that stores an empty reply fails (Pydantic AI opens an empty message before each tool call).
// Exit 0 all PASS, 1 any FAIL, 2 otherwise.

import { isIP } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from './harness.mjs'
import { killOwnedChild } from './e2eChecks.mjs'

const AGENT = 'smoke-agui'
const TURN_MS = 120_000
const STOP_MS = 10_000
const T = 15_000
// Verbatim from the scripted server (docs/architecture/e2e.md).
const PONG = 'pong'
const APPROVED = 'done: pretended to delete demo.txt'
// The start of AGUI_TEXT.interruptDeclined (shared/src/agui.ts).
const DECLINED = 'The agent asked for an approval ZumiBot could not show'
const tid = (id) => `[data-testid="${id}"]`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const endpoint = (process.env.ZUMIBOT_SMOKE_AGUI ?? '').trim()
if (endpoint === '') {
  console.log(
    [
      'smoke:agui runs a real AG-UI server, so it is opt-in. Name its endpoint with ZUMIBOT_SMOKE_AGUI, for example:',
      '  ZUMIBOT_SMOKE_AGUI=http://127.0.0.1:8765/agent npm run smoke:agui',
      'Optional: ZUMIBOT_SMOKE_AGUI_KEY (the name of an env variable holding the key) and ZUMIBOT_SMOKE_AGUI_HEADER.',
      'See docs/architecture/e2e.md.'
    ].join('\n')
  )
  process.exit(0)
}
const keyName = (process.env.ZUMIBOT_SMOKE_AGUI_KEY ?? '').trim() || null
const header = (process.env.ZUMIBOT_SMOKE_AGUI_HEADER ?? '').trim() || null

/** Whether the endpoint names this machine: the dev hook is then needed (loopback is never a public address). */
function loopback(url) {
  let host
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (host === 'localhost') return true
  if (isIP(host) === 4) return host.startsWith('127.')
  return isIP(host) === 6 && /^(0*:)*:?0*1$/.test(host)
}

let h = null
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

async function send(page, text) {
  await page.locator(tid('composer-input')).click()
  await page.keyboard.type(text)
  await page.click(tid('send-button'))
}

/** Waits until the chat (or, with no id yet, the one the page opens) has run and is idle again, or `until()` says to stop. */
async function turn(page, chatId, { until = null, timeout = TURN_MS } = {}) {
  const end = Date.now() + timeout
  const before = chatId ? (await itemsOf(chatId)).length : 0
  let started = false
  while (Date.now() < end) {
    chatId ??= /\/chat\/([^/?#]+)$/.exec(new URL(page.url()).pathname)?.[1] ?? null
    if (until && (await until(chatId))) return chatId
    const m = chatId ? await metaOf(chatId) : null
    if (m?.inFlight) started = true
    // The message is stored a moment before the chat is marked running, so it alone never ends a turn. A turn quicker than one
    // poll is seen by what it stored, in a new chat only: a chat with items already must be seen running (steps 3 and 4 wait).
    if (m && !m.inFlight && (started || (before === 0 && (await itemsOf(chatId)).some((i) => i.type !== 'user')))) return chatId
    await sleep(250)
  }
  throw new Error(`the turn did not end in ${timeout / 1000} s`)
}

const since = async (chatId, n) => (await itemsOf(chatId)).slice(n)
const replyOf = (items) =>
  items
    .filter((i) => i.type === 'assistant')
    .map((i) => i.text)
    .join('\n\n')
    .trim()
const errorsOf = (items) => items.filter((i) => i.type === 'error').map((i) => i.text)
const emptyReplies = (items) => items.filter((i) => i.type === 'assistant' && i.text.trim() === '').length
const words = (s) =>
  s
    .toLowerCase()
    .replace(/[.!\s]+$/, '')
    .trim()

async function main() {
  const local = loopback(endpoint)
  say(
    `smoke: AG-UI endpoint at ${(() => {
      try {
        return new URL(endpoint).host
      } catch {
        return '(not a URL)'
      }
    })()}${keyName ? `, key from $${keyName}` : ', no key'}${header ? `, header ${header}` : ''}`
  )
  if (local)
    say(
      'smoke: the endpoint is on this machine, so the dev hook ZUMIBOT_AGUI_ALLOW_LOCAL=1 is on (loopback, and plain http to it, allowed)'
    )
  const keyValue = keyName ? (process.env[keyName] ?? '') : null
  // The harness strips only ZUMIBOT_* names: without this the server, and whatever it spawns, would inherit the key.
  if (keyName) delete process.env[keyName]
  if (keyName && keyValue === '')
    return verdict('1 save + Test', 'INCONCLUSIVE', `ZUMIBOT_SMOKE_AGUI_KEY names ${keyName}, which is empty in this shell`)
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `zumibot-agui-smoke-${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const agentsDir = await mk('agents')
  h = await start({
    fake: true,
    agentsDir,
    env: { ZUMIBOT_TEST_PICK_FOLDER: folder, ...(local ? { ZUMIBOT_AGUI_ALLOW_LOCAL: '1' } : {}) }
  })
  const page = h.page
  await page.locator(tid('new-agent')).waitFor({ timeout: 30_000 })

  // 1. Save (confirms the endpoint), the key granted, and Test
  {
    const step = '1 save + Test'
    const launch = [
      `  endpoint: ${JSON.stringify(endpoint)}`,
      ...(keyName ? [`  authKey: ${keyName}`] : []),
      ...(header ? [`  authHeader: ${JSON.stringify(header)}`] : [])
    ]
    const raw = `---\nname: ${AGENT}\ndescription: AG-UI smoke agent.\nprovider: ag-ui\nagui:\n${launch.join('\n')}\n---\nYou are a remote smoke agent.\n`
    const saved = await rpc(page, 'agents:save', null, raw).catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    if (!saved?.ok) return verdict(step, 'INCONCLUSIVE', `the agent could not be saved: ${saved?.error ?? 'no answer'}`)
    await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: T })
    if (keyName)
      await rpc(page, 'vault:save', {
        kind: 'apiKey',
        name: 'Smoke AG-UI key',
        agents: [AGENT],
        env: keyName,
        value: keyValue,
        description: ''
      })
    const test = await rpc(page, 'agents:testAgui', AGENT)
    if ('error' in test) {
      // The server not running or not found is a setup problem; a refused certificate or address is a verdict.
      const unreachable = /could not find the address|\(ECONNREFUSED\)|\(EHOSTUNREACH\)|within 10 seconds/.test(test.error)
      return verdict(step, unreachable ? 'INCONCLUSIVE' : 'FAIL', test.error)
    }
    const note = `host ${test.host}, addresses ${JSON.stringify(test.addresses)}, ${test.tls ? 'TLS verified' : 'plain http (dev hook)'}, key ${test.authKey ?? 'none'}${test.authKey ? (test.authKeyGranted ? ' (granted)' : ' (NOT granted)') : ''}, hidden ${JSON.stringify(test.hidden)}`
    if (keyName && !test.authKeyGranted) return verdict(step, 'FAIL', `the key is not granted after the Vault save; ${note}`)
    verdict(step, 'PASS', note)
  }

  // 2. a chat that answers
  let chatId = null
  {
    const step = '2 a chat that answers'
    await page.click(`${tid('agent-row')}[data-agent-name="${AGENT}"]`)
    await page.click(tid('new-chat-folder'))
    await page.click(tid('new-chat-choose-folder'))
    await send(page, 'Reply with exactly one word: pong')
    chatId = await turn(page, null)
    const items = await itemsOf(chatId)
    const reply = replyOf(items)
    const errors = errorsOf(items)
    const meta = await metaOf(chatId)
    const note = `reply ${JSON.stringify(reply.slice(0, 200))}, session ${meta?.sessionEngine ?? 'none'}, errors ${JSON.stringify(errors)}`
    if (errors.length || !reply || meta?.sessionEngine !== 'ag-ui' || emptyReplies(items))
      verdict(step, 'FAIL', `${note}${emptyReplies(items) ? ', an empty reply stored' : ''}`)
    else if (words(reply) !== PONG) verdict(step, 'INCONCLUSIVE', `the server said something else; ${note}`)
    else verdict(step, 'PASS', note)
  }

  // 3. an interrupt, answered Yes on its card
  {
    const step = '3 an interrupt answered'
    const n = (await itemsOf(chatId)).length
    await send(page, 'Run the approval demo')
    let card = null
    await turn(page, chatId, {
      until: async () => {
        const pending = page.locator(`${tid('question-card')}[data-status="pending"]`).first()
        if (card !== null || (await pending.count()) === 0) return false
        const labels = await pending.locator(tid('question-option')).evaluateAll((els) => els.map((e) => e.getAttribute('data-label')))
        const tabs = await pending.locator(tid('question-tab')).count()
        card = { labels, tabs, text: ((await pending.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) }
        if (tabs === 0 && labels.includes('Yes') && labels.includes('No')) {
          await pending.locator(`${tid('question-option')}[data-label="Yes"] input`).click()
          await pending.locator(tid('question-send')).click()
          card.answered = true
          return false
        }
        // Not the Yes/No this step knows how to answer: stop the turn rather than guess.
        await page.locator(tid('send-button')).click()
        return false
      }
    })
    const items = await since(chatId, n)
    const reply = replyOf(items)
    const errors = errorsOf(items)
    const declined = items.filter((i) => i.type === 'notice' && i.text?.startsWith(DECLINED)).map((i) => i.text)
    const stored = items.find((i) => i.type === 'approval')
    const note = `card ${JSON.stringify(card)}, stored ${stored ? stored.status : 'none'}, notices ${JSON.stringify(declined)}, reply ${JSON.stringify(reply.slice(0, 200))}, errors ${JSON.stringify(errors)}`
    if (errors.length || emptyReplies(items)) verdict(step, 'FAIL', `${note}${emptyReplies(items) ? ', an empty reply stored' : ''}`)
    else if (card === null && declined.length > 0) verdict(step, 'FAIL', `the server's interrupt could not be shown as a card; ${note}`)
    else if (card === null) verdict(step, 'INCONCLUSIVE', `the server sent no interrupt; ${note}`)
    else if (!card.answered) verdict(step, 'INCONCLUSIVE', `the card is not a single Yes/No question, so it was not answered; ${note}`)
    else if (stored?.status !== 'answered' || reply !== APPROVED)
      verdict(
        step,
        reply === '' ? 'FAIL' : 'INCONCLUSIVE',
        `${reply === '' ? 'no reply after Yes' : "the reply is not the scripted server's"}; ${note}`
      )
    else verdict(step, 'PASS', note)
  }

  // 4. Stop while the remote tool runs
  {
    const step = '4 Stop during a 60 s remote tool'
    const n = (await itemsOf(chatId)).length
    const runsBefore = await page.locator(tid('tool-run')).count()
    await send(page, 'Run the slow demo')
    let stoppedAt = null
    await turn(page, chatId, {
      until: async () => {
        if (stoppedAt !== null) return true
        if ((await page.locator(tid('tool-run')).count()) <= runsBefore) return false
        const button = page.locator(tid('send-button'))
        if ((await button.getAttribute('data-tip')) !== 'Stop') return false
        await button.click()
        stoppedAt = Date.now()
        say('smoke: Stop pressed once the remote tool row showed')
        return true
      },
      timeout: 90_000
    })
    let ended = null
    while (stoppedAt !== null && Date.now() - stoppedAt < STOP_MS + 5_000) {
      const m = await metaOf(chatId)
      const notice = (await since(chatId, n)).some((i) => i.type === 'notice' && i.kind === 'stopped')
      if (m && !m.inFlight && notice) {
        ended = Date.now() - stoppedAt
        break
      }
      await sleep(200)
    }
    const items = await since(chatId, n)
    const errors = errorsOf(items)
    const tools = items
      .filter((i) => i.type === 'tool')
      .map((i) => `${i.input?.tool ?? i.name}: ${i.isError ? 'error' : 'ok'} ${JSON.stringify(String(i.result ?? '').slice(0, 80))}`)
    const note = `ended ${ended === null ? 'not within the wait' : `${(ended / 1000).toFixed(1)} s after Stop`}, tool rows ${JSON.stringify(tools)}, errors ${JSON.stringify(errors)}`
    if (stoppedAt === null) verdict(step, 'INCONCLUSIVE', `no remote tool row showed before the turn ended; ${note}`)
    else if (ended === null || ended > STOP_MS || errors.length || emptyReplies(items))
      verdict(step, 'FAIL', `${note}${emptyReplies(items) ? ', an empty reply stored' : ''}`)
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
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
console.log('agui smoke: summary')
for (const r of results) console.log(`  ${r.step}: ${r.v}`)
const code = results.some((r) => r.v === 'FAIL') ? 1 : results.every((r) => r.v === 'PASS') && results.length > 0 ? 0 : 2
console.log(code === 0 ? 'smoke:agui PASS' : code === 1 ? 'smoke:agui FAILED' : 'smoke:agui INCONCLUSIVE')
process.exit(code)
