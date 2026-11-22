// End-to-end check of the workflow Room step in the built server + web UI (VPS mode) against the FAKE clone claude
// (backend/tests/fixtures/fake-clone-claude.mjs: the room moderator answers {}, member turns run fake-claude.mjs):
// no real CLI call is ever made, so no login or quota is used.
// Usage: npm run e2e:workflow-room   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// The template room has two members, alpha and beta. The step's prompt is "@alpha @beta {{input}}", so both answer on the
// user's mentions whatever the moderator says. Each member reads its own script, <FAKE_STDOUT_DIR>/<agent>.jsonl, at
// the start of each turn, so a script rewritten between cases changes the next run only. A card is a can_use_tool line
// plus #WAIT_RESPONSE, answered from the page. RPCs go over a fresh /ws socket from a second tab parked on a static file
// of the origin, so a navigation of the app tab never cuts one off.
//
// DOM hooks relied on (data-testid): approval-allow-step, wf-chat-bar, wf-chat-bar-link.
// Stored state read: <dataDir>/chats.json, <dataDir>/chats/<id>.json.

import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-clone-claude.mjs', import.meta.url))
const ALPHA = 'alpha'
const BETA = 'beta'
const ROLE = 'Make cards'
const PREFIX = 'zumibot-e2e-workflow-room-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 15_000
const CASES = 4

let h = null
let rpcPage = null
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

// One raw RPC over a fresh /ws socket from the parked tab, so the session cookie rides along.
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
const storedChats = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats
const metaOf = async (id) => (await storedChats()).find((c) => c.id === id)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])

// ---------- the fake claude's scripts ----------
const SID = '4c2a6d3b-8e5f-4a71-9b82-c3d4e5f60718'
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

// ---------- workflow builders: ids double as handles ----------
const step = (id, kind, name, x, y, extra = {}) => ({ id, handle: id, name, kind, x, y, ...extra })
const edge = (from, port, to) => ({ id: `${from}-${port}-${to}`, from, port, to })

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  const scripts = await mk('scripts')
  const say1 = (agent, text) => writeFile(join(scripts, `${agent}.jsonl`), [init(), say(text), result(text)].join('\n') + '\n')
  // beta asks to run `echo hi` (a card), then answers; alpha answers a little later.
  const betaCard = (requestId) =>
    writeFile(
      join(scripts, `${BETA}.jsonl`),
      [init(), ...request(requestId, 'Bash', { command: 'echo hi', description: 'say hi' }), say('BETA-DONE'), result('BETA-DONE')].join(
        '\n'
      ) + '\n'
    )
  const alphaSlow = (text) => writeFile(join(scripts, `${ALPHA}.jsonl`), [init(), '#SLEEP 800', say(text), result(text)].join('\n') + '\n')
  for (const a of [ALPHA, BETA]) {
    await writeFile(
      join(agentsDir, `${a}.md`),
      `---\nname: ${a}\ndescription: Room step e2e agent ${a}.\nmodel: haiku\n---\nYou are ${a}.\n`
    )
  }
  await mkdir(scripts, { recursive: true })
  await say1(BETA, 'BETA-DONE')
  await alphaSlow('ALPHA-DONE')

  h = await start({ mode: 'vps', fake: FAKE, dataDir, agentsDir, env: { FAKE_STDOUT_DIR: scripts } })
  const page = h.page
  await page.locator(tid('mode-tab-workflows')).waitFor({ timeout: 30_000 })
  rpcPage = await h.newPage()
  await rpcPage.goto(`${h.origin}/favicon.png`)
  assert(new URL(rpcPage.url()).pathname === '/favicon.png', `the RPC tab landed on ${rpcPage.url()}`)
  // A new tab comes to the front: the app tab behind it gets no animation frames, which stalls every click on it.
  await page.bringToFront()

  const template = (await rpc('chats:createGroup', [ALPHA, BETA], folder, ROLE)).id
  const w = await rpc('workflows:save', {
    id: null,
    name: 'Room flow',
    enabled: true,
    timeZone: 'UTC',
    trigger: { kind: 'manual' },
    steps: [
      step('t', 'trigger', 'Manual', 0, 0),
      step('room', 'room', 'Room', 320, 0, { room: template, prompt: `@${ALPHA} @${BETA} {{input}}` })
    ],
    edges: [edge('t', 'out', 'room')]
  })
  assert(w.enabled === true, 'the workflow saved off, so it has problems')
  const roomStep = async () => (await rpc('workflows:list')).workflows.find((x) => x.id === w.id).steps.find((x) => x.id === 'room')
  ok(`template room ${template} (alpha, beta), workflow "Room flow" saved with a Room step`)

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
  const archived = (m) => (m.archivedAt ?? 0) > (m.unarchivedAt ?? 0)
  const lastReply = (items) => items.filter((i) => i.type === 'assistant' && i.text).at(-1)?.text
  let copy1 = null

  await runCase(1, 'a run copies the room', async () => {
    const { id: runId } = await rpc('workflows:run', w.id, 'card one')
    const done = await runUntil(runId, ended, 'the run to end')
    assert(done.status === 'done', `the run ended ${done.status}: ${done.error}`)
    const v = done.visits.find((x) => x.stepId === 'room')
    assert(v && v.status === 'done' && v.chatId, `the room visit is ${JSON.stringify(v)}`)
    copy1 = v.chatId
    assert(copy1 !== template, 'the visit ran in the template itself')
    let meta = null
    await waitFor(async () => (meta = await metaOf(copy1)) && archived(meta), T, 'the copy to be archived')
    assert(meta.group && meta.group.members.length === 2, `the copy is not a two-member room: ${JSON.stringify(meta.group)}`)
    assert(
      meta.workflow?.runId === runId && meta.workflow.workflowId === w.id && meta.workflow.stepId === 'room',
      `the copy's workflow link is ${JSON.stringify(meta.workflow)}`
    )
    const items = await itemsOf(copy1)
    const last = lastReply(items)
    assert(
      ['ALPHA-DONE', 'BETA-DONE'].includes(last) && v.output === last,
      `the output ${JSON.stringify(v.output)} is not the copy's last reply ${JSON.stringify(last)}`
    )
    assert(
      items.some((i) => i.type === 'user' && i.text.startsWith(`@${ALPHA} @${BETA} `) && i.text.includes('card one')),
      `the prompt was not posted into the copy: ${JSON.stringify(items.filter((i) => i.type === 'user').map((i) => i.text))}`
    )
    assert((await itemsOf(template)).length === 0, 'the template room has items')
    assert(!archived(await metaOf(template)), 'the template room was archived')
    ok(
      `run ${runId} done: the output "${v.output}" is the last reply of copy ${copy1} (a room, linked to the run, archived); the template stayed empty`
    )
  })

  let runWaiting = null
  await runCase(2, 'allow for this step', async () => {
    await betaCard('card-1')
    const { id: runId } = await rpc('workflows:run', w.id, 'card two')
    runWaiting = runId
    const waiting = await runUntil(runId, (r) => r.status === 'waiting', "the run to wait on beta's card")
    const v = waiting.visits.find((x) => x.stepId === 'room')
    assert(v?.chatId, 'the waiting visit has no copy')
    await page.goto(`${h.origin}/chat/${v.chatId}`)
    const allow = page.locator(tid('approval-allow-step'))
    await allow.waitFor({ timeout: T })
    await allow.click()
    const done = await runUntil(runId, ended, 'the run to end after the card was allowed')
    assert(done.status === 'done', `the run ended ${done.status}: ${done.error}`)
    const rules = (await roomStep()).rules
    assert(
      JSON.stringify(rules) === JSON.stringify([{ tool: 'Bash', command: 'echo hi', agent: BETA }]),
      `the step's rules are ${JSON.stringify(rules)}`
    )
    ok(`the run waited on beta's Bash card, "Allow for this step" saved ${JSON.stringify(rules)} into the step, and the run ended done`)
  })

  await runCase(3, 'the next run asks nothing', async () => {
    await betaCard('card-2')
    const { id: runId } = await rpc('workflows:run', w.id, 'card three')
    let sawWaiting = false
    let last = null
    await waitFor(
      async () => {
        last = await getRun(runId)
        if (last?.status === 'waiting') sawWaiting = true
        return last !== null && ended(last)
      },
      30_000,
      'the third run to end'
    )
    assert(last.status === 'done', `the run ended ${last.status}: ${last.error}`)
    assert(!sawWaiting, 'the run waited on a card the rule should have let through')
    const v = last.visits.find((x) => x.stepId === 'room')
    const card = (await itemsOf(v.chatId)).find((i) => i.type === 'approval' && i.toolName === 'Bash' && i.input?.command === 'echo hi')
    assert(card && card.status === 'auto-allowed-workflow', `the card is ${JSON.stringify(card)}`)
    assert(runWaiting !== runId, 'the same run')
    ok("the third run never waited: beta's `echo hi` card is stored as auto-allowed-workflow")
  })

  await runCase(4, 'the room bar shows', async () => {
    assert(copy1, 'case 1 made no copy')
    // The copy is archived; the address still opens it.
    await page.goto(`${h.origin}/chat/${copy1}`)
    const bar = page.locator(tid('wf-chat-bar'))
    await bar.waitFor({ timeout: T })
    assert(((await bar.textContent()) ?? '').includes('Room flow'), `the workflow bar reads ${JSON.stringify(await bar.textContent())}`)
    await page.locator(tid('wf-chat-bar-link')).waitFor({ timeout: T })
    ok(`the copy's chat shows the workflow bar: ${JSON.stringify(await bar.textContent())}`)
  })

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
const passed = results.filter((r) => r[2] === 'PASS').length
console.log(`cases: ${passed} passed, ${results.length - passed} failed, ${CASES - results.length} not run`)
console.log(failed ? 'e2e:workflow-room FAILED' : 'e2e:workflow-room passed')
process.exit(failed ? 1 : 0)
