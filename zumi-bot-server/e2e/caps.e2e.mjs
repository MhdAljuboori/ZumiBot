// End-to-end check of spend caps in the built server + web UI (local mode) against the FAKE claude: no real CLI turn is sent,
// so no login or quota is used. Usage: npm run e2e:caps   (builds first)
//
// The fake claude's script prices a request from its `usage` line (an Opus 5.5 request of 200 000 input tokens, $0.80 at list
// price) while the turn runs, so the cap is reached mid-turn; the turn then sleeps 5 s, and its next tool call runs the real pause
// hook (`#PRE_TOOL`), which must block it with the cap's words. Its result reports the exact $0.80, as the CLI's does.
//
//  1 An agent's daily cap ($0.50): the running reply pauses at once, its next tool call is blocked with "A spend cap paused this
//    task", and the reply lands paused with the cap's notice (amounts, what Resume allows) and Resume. The day is tripped in
//    spend-caps.json, and Settings › Usage lists the agent over its cap with Allow more today.
//  2 Resume goes on past it: Continue is sent and answered, the pause is gone, and the day's limit is what was spent plus the
//    cap; Settings no longer shows the agent over.
//  3 A workflow run's cap ($0.50): the Agent step's turn pauses at the cap, the run holds (waiting, capHold, its step paused)
//    and the run view's banner offers Continue; Continue resumes the step's chat and the run ends done, its limit raised.
//
// Hard rules: nothing in ~/.claude is touched (the harness gives the server a throwaway HOME, agents dir and data dir); only the
// mkdtemp dirs made here are removed; the server, Chrome and every fake claude and hook are stopped in `finally`, and the suite
// fails if a process carrying this run's CAPS_E2E_RUN mark outlives it; overall timeout 3 min.
//
// DOM hooks relied on (data-testid): composer-input, send-button, resume-button, usage-cap (data-agent, data-over),
// usage-cap-allow, wf-cap-hold, wf-cap-continue, wf-node (data-state).

import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start, unexpectedErrors } from './harness.mjs'

const AGENT = 'e2e-caps-agent'
const STEP_AGENT = 'e2e-caps-step'
const PREFIX = 'zumibot-e2e-caps-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 20_000
const CAP_BLOCK = 'A spend cap paused this task' // CAP_BLOCK_TEXT in shared/src/spendCaps.ts
const RUN_MARK = randomUUID()
process.env.CAPS_E2E_RUN = RUN_MARK

let h = null
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
    await sleep(50)
  }
  throw new Error(`ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}`)
}

async function marked() {
  const found = []
  for (const pid of (await readdir('/proc')).filter((n) => /^\d+$/.test(n) && Number(n) !== process.pid)) {
    const env = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '')
    if (env.split('\0').includes(`CAPS_E2E_RUN=${RUN_MARK}`)) {
      found.push(`${pid} ${(await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '')).replace(/\0/g, ' ').trim().slice(0, 160)}`)
    }
  }
  return found
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

let outDir = null
const jsonl = async (name) =>
  (await readFile(join(outDir, name), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
const hooks = () => jsonl('hooks.jsonl')
const metaOf = async (id) => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats.find((c) => c.id === id)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])
const capDays = async () => (await readFile(join(h.dataDir, 'spend-caps.json'), 'utf8').then(JSON.parse, () => ({ agents: {} }))).agents
const workflowRunOf = async (runId) =>
  Object.values(await readFile(join(h.dataDir, 'workflow-runs.json'), 'utf8').then(JSON.parse, () => ({})))
    .flat()
    .find((r) => r?.id === runId)
const idleAndPaused = async (id) => {
  const m = await metaOf(id)
  return Boolean(m) && m.pause === 'paused' && !m.inFlight
}

// ---------- the fake claude's script ----------
const SID = randomUUID()
const line = (o) => JSON.stringify(o)
const init = () =>
  line({ type: 'system', subtype: 'init', session_id: SID, model: 'claude-opus-5-5', permissionMode: 'default', tools: ['Bash'] })
const assistant = (content, usage = { input_tokens: 2, output_tokens: 2 }) =>
  line({
    type: 'assistant',
    message: { model: 'claude-opus-5-5', id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', content, stop_reason: null, usage },
    parent_tool_use_id: null,
    session_id: SID,
    uuid: randomUUID()
  })
const say = (text, usage) => assistant([{ type: 'text', text }], usage)
const toolUse = (id, name, input) => assistant([{ type: 'tool_use', id, name, input }])
const preTool = (spec) => `#PRE_TOOL ${JSON.stringify(spec)}`
const result = (text, usd = 0) =>
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    session_id: SID,
    uuid: randomUUID(),
    ...(usd > 0
      ? {
          total_cost_usd: usd,
          modelUsage: {
            'claude-opus-5-5': { inputTokens: 200_000, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: usd }
          }
        }
      : {})
  })
const script = (...lines) => writeFile(h.script, lines.flat(Infinity).join('\n') + '\n')
const reply = (text) => script(init(), say(text), result(text))

const STATUS = 'Stopped at the spend cap: the plan is written; deploying is next.'
/** One $0.80 request (200 000 input tokens at Opus 5.5's $4 per million), a pause's time to land, then a tool call the hook judges. */
const capScript = (n) => [
  init(),
  say('Planning the deploy.', { input_tokens: 200_000, output_tokens: 2 }),
  '#SLEEP 5000', // room for the cap's pause to land, also on a machine under load
  toolUse(`toolu_C${n}`, 'Bash', { command: 'make deploy' }),
  preTool({ id: `toolu_C${n}`, tool: 'Bash', agentId: null }),
  say(STATUS),
  result(STATUS, 0.8)
]

const composer = (page) => page.locator(tid('composer-input'))
async function typeAndSend(page, text) {
  await composer(page).fill(text)
  await page.locator(`${tid('send-button')}:not(.stop)`).click()
}

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const work = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  outDir = await mk('out')
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Spend caps e2e agent.\ndailySpendCap: 0.5\n---\nYou are a test agent.\n`
  )
  await writeFile(
    join(agentsDir, `${STEP_AGENT}.md`),
    `---\nname: ${STEP_AGENT}\ndescription: Spend caps e2e step agent.\n---\nYou are a test agent.\n`
  )
  h = await start({ fake: true, dataDir, agentsDir, env: { FAKE_HOOKS_OUT: join(outDir, 'hooks.jsonl') } })
  const page = h.page
  const chatId = (await rpc(page, 'chats:create', AGENT, work)).id
  await page.goto(`${h.origin}/chat/${chatId}`)
  await composer(page).waitFor({ timeout: 30_000 })

  // 1. the agent's daily cap pauses its running reply
  await script(capScript(1))
  await typeAndSend(page, 'Plan and deploy.')
  await waitFor(async () => (await metaOf(chatId))?.pause !== undefined, T, 'the cap to pause the reply')
  const pausing = await metaOf(chatId)
  assert(
    pausing.pauseCap?.scope?.kind === 'agent' && pausing.pauseCap.scope.agent === AGENT && pausing.pauseCap.capUsd === 0.5,
    `the pause's cap ${JSON.stringify(pausing.pauseCap)}`
  )
  await waitFor(() => idleAndPaused(chatId), 30_000, 'the cap pause to land')
  const hk = await hooks()
  assert(hk.length === 1 && hk[0].id === 'toolu_C1' && hk[0].blocked === true, `hook calls ${JSON.stringify(hk)}`)
  let items = await itemsOf(chatId)
  const blocked = items.find((i) => i.type === 'tool' && i.id === 'toolu_C1')
  assert(blocked?.isError && blocked.result?.includes(CAP_BLOCK), `the blocked call ${JSON.stringify(blocked)}`)
  const notice = items.at(-1)
  const want = 'Spend cap reached: @E2e Caps Agent spent $0.80 of its $0.50 daily cap. Press Resume to continue; it allows $0.50 more.'
  assert(notice?.type === 'notice' && notice.kind === 'userPaused' && notice.text === want, `the last item ${JSON.stringify(notice)}`)
  await page.getByText(want).waitFor({ timeout: T })
  await page.locator(tid('resume-button')).waitFor({ timeout: T })
  const day = (await capDays())[AGENT]
  assert(day?.tripped === true && /^\d{4}-\d{2}-\d{2}$/.test(day.day), `the stored day ${JSON.stringify(day)}`)
  await page.goto(`${h.origin}/settings/usage`)
  const row = page.locator(`${tid('usage-cap')}[data-agent="${AGENT}"]`)
  await row.waitFor({ timeout: T })
  assert((await row.getAttribute('data-over')) === 'true', 'Settings does not show the agent over its cap')
  await row.locator(tid('usage-cap-allow')).waitFor({ timeout: T })
  ok(
    "1 the agent's daily cap paused its running reply mid-turn: the next call was blocked with the cap's words, the notice and Resume show, Settings lists it over"
  )

  // 2. Resume goes on past the cap: one more cap's worth for today
  await page.goto(`${h.origin}/chat/${chatId}`)
  await reply('Deploying now.')
  await page.locator(tid('resume-button')).click()
  await waitFor(
    async () => {
      const m = await metaOf(chatId)
      return !m.inFlight && m.pause === undefined && (await itemsOf(chatId)).at(-1)?.text === 'Deploying now.'
    },
    30_000,
    'Continue to be answered'
  )
  items = await itemsOf(chatId)
  assert(items.at(-2)?.type === 'user' && items.at(-2).text === 'Continue', `before the reply ${JSON.stringify(items.at(-2))}`)
  const raised = (await capDays())[AGENT]
  assert(raised?.limitUsd === 1.3 && raised.tripped === undefined, `the day after Resume ${JSON.stringify(raised)}`)
  assert((await metaOf(chatId)).pauseCap === undefined, 'the pause cap outlived Resume')
  await page.goto(`${h.origin}/settings/usage`)
  await page.locator(`${tid('usage-cap')}[data-agent="${AGENT}"][data-over="false"]`).waitFor({ timeout: T })
  ok('2 Resume sent Continue and raised the day to what was spent plus the cap; Settings no longer shows it over')

  // 3. a workflow run's cap holds the run; Continue carries it on
  const wf = await rpc(page, 'workflows:save', {
    id: null,
    name: 'Caps e2e flow',
    enabled: false,
    timeZone: 'UTC',
    trigger: { kind: 'manual' },
    spendCap: 0.5,
    steps: [
      { id: 't', handle: 't', name: 'Start', kind: 'trigger', x: 0, y: 0 },
      { id: 'g', handle: 'g', name: 'Deploy', kind: 'agent', agent: STEP_AGENT, prompt: 'Plan and deploy.', cwd: work, x: 300, y: 0 }
    ],
    edges: [{ id: 't-out-g', from: 't', port: 'out', to: 'g' }]
  })
  assert(wf.spendCap === 0.5, `the saved workflow ${JSON.stringify(wf.spendCap)}`)
  await script(capScript(2))
  const wfRun = await rpc(page, 'workflows:run', wf.id)
  await waitFor(async () => (await workflowRunOf(wfRun.id))?.capHold !== undefined, 30_000, 'the run to be held')
  const stepChat = (await workflowRunOf(wfRun.id)).visits.find((v) => v.stepId === 'g').chatId
  await waitFor(() => idleAndPaused(stepChat), 30_000, "the cap pause to land on the step's turn")
  const held = await workflowRunOf(wfRun.id)
  assert(
    held.status === 'waiting' && held.capHold.kind === 'run' && held.capHold.limitUsd === 0.5,
    `the held run ${JSON.stringify({ status: held.status, capHold: held.capHold })}`
  )
  assert((await metaOf(stepChat)).pauseCap?.scope?.kind === 'workflow', "the step chat's pause cap")
  await waitFor(
    async () => (await workflowRunOf(wfRun.id)).visits.find((v) => v.stepId === 'g')?.capPaused === true,
    T,
    'the step to be marked paused by the cap'
  )
  await page.goto(`${h.origin}/workflows/${wf.id}/runs/${wfRun.id}`)
  await page.locator(tid('wf-cap-hold')).waitFor({ timeout: T })
  await page.locator(`${tid('wf-node')}[data-step-id="g"][data-state="paused"]`).waitFor({ timeout: T })
  await reply('Deployed.')
  await page.locator(tid('wf-cap-continue')).click()
  await waitFor(async () => (await workflowRunOf(wfRun.id))?.status === 'done', 30_000, 'the run to end done after Continue')
  const done = await workflowRunOf(wfRun.id)
  assert(
    done.capHold === undefined && Math.abs(done.capLimitUsd - 1.3) < 1e-9,
    `the ended run ${JSON.stringify({ capHold: done.capHold, capLimitUsd: done.capLimitUsd })}`
  )
  const visit = done.visits.find((v) => v.stepId === 'g')
  assert(
    visit.status === 'done' && visit.output === 'Deployed.' && visit.capPaused === undefined && visit.paused === undefined,
    `the step ${JSON.stringify(visit)}`
  )
  await page.locator(tid('wf-cap-hold')).waitFor({ state: 'detached', timeout: T })
  ok("3 a workflow run's cap held the run and paused its step; Continue resumed the step's chat and the run ended done")

  const bad = unexpectedErrors(h.errors, [])
  assert(bad.length === 0, `unexpected console/server errors:\n${bad.join('\n')}`)
  ok('4 no console or server errors')
}

let cleaning = null
function cleanup() {
  cleaning ??= (async () => {
    if (h) {
      const cur = h
      h = null
      await Promise.race([cur.stop().catch(() => {}), sleep(30_000)])
    }
    let left = await marked()
    for (const end = Date.now() + 15_000; left.length && Date.now() < end; left = await marked()) await sleep(200)
    if (left.length) {
      console.error(`leftover processes (killed):\n${left.join('\n')}`)
      for (const l of left)
        try {
          process.kill(Number(l.split(' ')[0]), 'SIGKILL')
        } catch {
          /* gone */
        }
    }
    for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
    return left.length === 0
  })()
  return cleaning
}

const timer = setTimeout(() => {
  console.error(`FAIL: overall timeout ${OVERALL_TIMEOUT / 1000} s`)
  void cleanup().finally(() => process.exit(1))
}, OVERALL_TIMEOUT)
timer.unref()

let code = 0
try {
  await main()
} catch (err) {
  code = 1
  console.error(err instanceof Error ? err.message : err)
  if (h) console.error(JSON.stringify({ serverAndConsoleErrors: h.errors.slice(-20) }))
} finally {
  if (!(await cleanup())) code = 1
}
console.log(code === 0 ? 'e2e:caps passed' : 'e2e:caps FAILED')
process.exit(code)
