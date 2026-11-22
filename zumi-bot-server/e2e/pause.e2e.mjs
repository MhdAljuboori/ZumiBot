// End-to-end check of Pause and Resume in the built server + web UI (local mode) against the FAKE claude: no real CLI turn is
// sent, so no login or quota is used. Usage: npm run e2e:pause   (builds first)
//
// The fake claude runs the real pause hook: its #PRE_TOOL lines run every PreToolUse hook command of the --settings the server
// passed (the built dist/pauseHook.mjs behind the `[ -e "$ZUMIBOT_PAUSE_FILE" ]` test), with agent_id for a subagent's call,
// and an exit 2 becomes the blocked call's error result, as the CLI does. FAKE_HOOKS_OUT logs each call and whether it was
// blocked; FAKE_INVOCATIONS_OUT logs every run's argv and CLAUDE_CODE_TMPDIR.
//
//  1-6 (one reply): a main Agent dispatch whose subagent makes a call, sleeps 3 s (Pause is pressed then) and makes another;
//      the subagent finishes and hands back, the main agent's next Agent call is blocked, it writes its status and ends.
//      Checked: the subagent's calls ran (one with the flag set) and the main one was blocked; the Paused notice and Resume;
//      a message typed while pausing is held with Send now; a server restart keeps all that; Resume sends Continue and then
//      the held message; every run's temp folder is the chat's own under <data>/claude-tmp.
//  7 Stop while pausing: the tray stays held (a typed message and a routine's message, neither starts) and Paused shows; the
//      routine skipped its fresh start, so Resume's Continue resumes the session and the routine's run then ends done.
//  8 A server restart mid-pause lands the pause: Paused shows, the tray is held and nothing starts.
//  9 A routine run whose own turn the user pauses is paused, not failed (its Recent runs row says how to go on); Resume's
//      Continue carries the run on, and it ends done, noted as resumed after a pause.
// 10 The same for a workflow's Agent step: its visit stays open (the run view's step shows paused), and Resume's Continue
//      carries it on to done, so the run ends done.
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are deleted, in `finally`;
//  - the server, Chrome and every fake claude and hook started here are stopped in `finally`, and the suite fails if any process
//    carrying this run's PAUSE_E2E_RUN mark outlives it; overall timeout 4 min.
//
// DOM hooks relied on (data-testid): composer-input, send-button (Stop while a reply runs and the box is empty), pause-button,
//   pausing-line, resume-button, tasks-tray, task-row, task-send, run-row (data-status), run-pause, wf-node (data-state).
// Stored state read: <dataDir>/chats.json (pause, held, inFlight, tasks, next), <dataDir>/chats/<id>.json,
//   <dataDir>/pause-flags/<hash>/paused, <dataDir>/routine-runs.json.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { start, unexpectedErrors } from './harness.mjs'

const AGENT = 'e2e-pause-agent'
const PREFIX = 'zumibot-e2e-pause-'
const OVERALL_TIMEOUT = 4 * 60_000
const T = 20_000
const MARKER = '(zumibot-pause)' // PAUSE_MARKER in shared/src/pause.ts
const PAUSED_TEXT = 'Paused. Press Resume to continue.' // NOTICE_TEXT.userPaused
// Every process this run starts inherits it (the harness passes non-ZUMIBOT_ variables on, Playwright gives Chrome our env).
const RUN_MARK = randomUUID()
process.env.PAUSE_E2E_RUN = RUN_MARK

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

async function waitFor(fn, timeout, what) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(50)
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

/** Every process but this one whose environment carries this run's mark: the server, Chrome, fake claudes, hooks. */
async function marked() {
  const found = []
  for (const pid of (await readdir('/proc')).filter((n) => /^\d+$/.test(n) && Number(n) !== process.pid)) {
    const env = await readFile(`/proc/${pid}/environ`, 'utf8').catch(() => '')
    if (env.split('\0').includes(`PAUSE_E2E_RUN=${RUN_MARK}`)) {
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
const invocations = () => jsonl('invocations.jsonl')
const metaOf = async (id) => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats.find((c) => c.id === id)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])
const hashOf = (id) => createHash('sha256').update(id).digest('hex').slice(0, 16)
const tmpOf = (id) => join(h.dataDir, 'claude-tmp', hashOf(id)) // ChatTmp.dirOf
const flagOf = (id) => join(h.dataDir, 'pause-flags', hashOf(id), 'paused') // ChatTmp.pauseFlagOf
const workflowRunOf = async (runId) =>
  Object.values(await readFile(join(h.dataDir, 'workflow-runs.json'), 'utf8').then(JSON.parse, () => ({})))
    .flat()
    .find((r) => r?.id === runId)
const runOf = async (routineId, runId) =>
  ((await readFile(join(h.dataDir, 'routine-runs.json'), 'utf8').then(JSON.parse, () => ({})))[routineId] ?? []).find((r) => r.id === runId)
/** The stored items after the last Paused notice, each as `kind:text` (notices by kind). */
const afterLastPause = (items) => {
  const at = items.findLastIndex((i) => i.type === 'notice' && i.kind === 'userPaused')
  return items
    .slice(at + 1)
    .map((i) => (i.type === 'user' || i.type === 'assistant' ? `${i.type}:${i.text}` : i.type === 'notice' ? `notice:${i.kind}` : i.type))
}
const lastKinds = (items, n) => items.slice(-n).map((i) => (i.type === 'notice' ? `notice:${i.kind}` : i.type))
const idleAndPaused = async (id) => {
  const m = await metaOf(id)
  return Boolean(m) && m.pause === 'paused' && !m.inFlight
}

// ---------- the fake claude's script: one file, read when a run starts ----------
const SID = randomUUID()
const line = (o) => JSON.stringify(o)
const init = () =>
  line({
    type: 'system',
    subtype: 'init',
    session_id: SID,
    model: 'claude-haiku-5-5',
    permissionMode: 'default',
    tools: ['Agent', 'Bash', 'Read']
  })
// Every model response has its own message id, shared by its calls: the server's safety cap counts blocked responses.
const assistant = (content, { parent = null, agent = null } = {}) =>
  line({
    type: 'assistant',
    message: {
      model: 'claude-haiku-5-5',
      id: `msg_${randomUUID()}`,
      type: 'message',
      role: 'assistant',
      content,
      stop_reason: null,
      usage: { input_tokens: 2, output_tokens: 2 }
    },
    parent_tool_use_id: parent,
    ...(agent ? { agent_id: agent } : {}),
    session_id: SID,
    uuid: randomUUID()
  })
const toolUse = (id, name, input, o) => assistant([{ type: 'tool_use', id, name, input }], o)
const say = (text, o) => assistant([{ type: 'text', text }], o)
const toolResult = (id, content, { parent = null, agent = null, extra = {} } = {}) =>
  line({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
    parent_tool_use_id: parent,
    ...(agent ? { agent_id: agent } : {}),
    session_id: SID,
    uuid: randomUUID(),
    ...extra
  })
const dispatch = (id, task, description) => [
  toolUse(id, 'Agent', { description, subagent_type: 'general-purpose', prompt: `${description}, then report.` }),
  line({
    type: 'system',
    subtype: 'task_started',
    task_id: task,
    tool_use_id: id,
    description,
    subagent_type: 'general-purpose',
    prompt: `${description}, then report.`,
    session_id: SID,
    uuid: randomUUID()
  }),
  line({
    type: 'user',
    parent_tool_use_id: id,
    agent_id: task,
    session_id: SID,
    message: { role: 'user', content: [{ type: 'text', text: `${description}, then report.` }] }
  })
]
const preTool = (spec) => `#PRE_TOOL ${JSON.stringify(spec)}`
const result = (text) => line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: SID, uuid: randomUUID() })
const script = (...lines) => writeFile(h.script, lines.flat(Infinity).join('\n') + '\n')
const reply = (text) => script(init(), say(text), result(text))

const STATUS = 'Paused: the build check is done and passed. Next step: deploy.'
const HANDBACK = 'Build checked: sub-ok.'
/** 1-6: the subagent's second call comes after the 3 s sleep, so with the flag set; the main thread's next call is blocked. */
const pauseScript = () => [
  init(),
  dispatch('toolu_A', 'task_a', 'Check the build'),
  toolUse('toolu_S1', 'Bash', { command: 'npm run build' }, { parent: 'toolu_A', agent: 'task_a' }),
  preTool({ id: 'toolu_S1', tool: 'Bash', agentId: 'task_a', parent: 'toolu_A' }),
  '#SLEEP 3000',
  toolResult('toolu_S1', 'build ok', { parent: 'toolu_A', agent: 'task_a' }),
  toolUse('toolu_S2', 'Read', { file_path: '/work/build.log' }, { parent: 'toolu_A', agent: 'task_a' }),
  preTool({ id: 'toolu_S2', tool: 'Read', agentId: 'task_a', parent: 'toolu_A' }),
  toolResult('toolu_S2', 'sub-ok', { parent: 'toolu_A', agent: 'task_a' }),
  say(HANDBACK, { parent: 'toolu_A', agent: 'task_a' }),
  line({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'task_a',
    patch: { status: 'completed', end_time: Date.now() },
    session_id: SID,
    uuid: randomUUID()
  }),
  toolResult('toolu_A', [{ type: 'text', text: HANDBACK }], {
    extra: {
      tool_use_result: {
        status: 'completed',
        agentType: 'general-purpose',
        content: [{ type: 'text', text: HANDBACK }],
        totalDurationMs: 3000,
        totalTokens: 1000,
        totalToolUseCount: 2
      }
    }
  }),
  toolUse('toolu_M2', 'Agent', { description: 'Deploy', subagent_type: 'general-purpose', prompt: 'Deploy it.' }),
  preTool({ id: 'toolu_M2', tool: 'Agent', agentId: null }),
  say(STATUS),
  result(STATUS)
]
/** 7, 8: a subagent that works until it is stopped (the run ends by Stop or by the server stopping). */
const longScript = (n) => [
  init(),
  dispatch(`toolu_L${n}`, `task_l${n}`, `Long review ${n}`),
  toolUse(`toolu_L${n}_1`, 'Bash', { command: 'sleep 60' }, { parent: `toolu_L${n}`, agent: `task_l${n}` }),
  preTool({ id: `toolu_L${n}_1`, tool: 'Bash', agentId: `task_l${n}`, parent: `toolu_L${n}` }),
  '#SLEEP 60000',
  result('never reached')
]

// ---------- UI helpers ----------
const composer = (page) => page.locator(tid('composer-input'))
// While a reply runs the button is Stop until the box holds text: click it only once it is Send again.
async function typeAndSend(page, text) {
  await composer(page).fill(text)
  await page.locator(`${tid('send-button')}:not(.stop)`).click()
}
const pressStop = (page) => page.locator(`${tid('send-button')}.stop`).click()
const taskTexts = (page) => page.locator(`${tid('task-row')} .task-text`).allTextContents()

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const work = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  outDir = await mk('out')
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Pause e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  h = await start({
    fake: true,
    dataDir,
    agentsDir,
    env: { FAKE_HOOKS_OUT: join(outDir, 'hooks.jsonl'), FAKE_INVOCATIONS_OUT: join(outDir, 'invocations.jsonl') }
  })
  const page = h.page
  const chatId = (await rpc(page, 'chats:create', AGENT, work)).id
  await page.goto(`${h.origin}/chat/${chatId}`)
  await composer(page).waitFor({ timeout: 30_000 })

  // 1. Pause while the subagent sleeps: the subagent still finishes, the main thread's next call is blocked
  await script(pauseScript())
  await typeAndSend(page, 'Check the build, then deploy.')
  await waitFor(async () => (await hooks()).length === 1, T, "the subagent's first call (before the pause)")
  await page.locator(tid('pause-button')).click()
  await waitFor(async () => (await metaOf(chatId))?.pause === 'pausing', T, 'the chat to be pausing')
  const pausing = await metaOf(chatId)
  assert(
    pausing.held === true && pausing.inFlight === true,
    `pausing meta ${JSON.stringify({ held: pausing.held, inFlight: pausing.inFlight })}`
  )
  assert(existsSync(flagOf(chatId)), 'no pause flag file while pausing')
  await page.locator(tid('pausing-line')).waitFor({ timeout: T })
  assert(await page.locator(tid('pause-button')).isDisabled(), 'the Pause button is not held while pausing')
  // 3 (part one): a message typed while pausing joins the queue
  const HELD = 'Also update the changelog.'
  await typeAndSend(page, HELD)
  await page.locator(tid('task-row')).waitFor({ timeout: T })
  await waitFor(() => idleAndPaused(chatId), 30_000, 'the pause to land')
  const hk = await hooks()
  const want = [
    { id: 'toolu_S1', tool: 'Bash', agentId: 'task_a', blocked: false },
    { id: 'toolu_S2', tool: 'Read', agentId: 'task_a', blocked: false },
    { id: 'toolu_M2', tool: 'Agent', agentId: null, blocked: true }
  ]
  assert(same(hk, want), `hook calls ${JSON.stringify(hk)}`)
  let items = await itemsOf(chatId)
  const agentRow = items.find((i) => i.type === 'tool' && i.id === 'toolu_A')
  assert(agentRow && !agentRow.isError && agentRow.result?.includes(HANDBACK), `the subagent's hand-back ${JSON.stringify(agentRow)}`)
  const blockedRow = items.find((i) => i.type === 'tool' && i.id === 'toolu_M2')
  assert(blockedRow && blockedRow.isError && blockedRow.result?.includes(MARKER), `the blocked main call ${JSON.stringify(blockedRow)}`)
  // The blocked Agent call never started a subagent; like a denied one, the panel lists it as failed.
  const entries = await rpc(page, 'dispatch:list', chatId)
  assert(
    same(
      entries.map((e) => [e.id, e.status]),
      [
        ['toolu_A', 'done'],
        ['toolu_M2', 'failed']
      ]
    ),
    `dispatch entries ${JSON.stringify(entries.map((e) => [e.id, e.status]))}`
  )
  assert(!existsSync(flagOf(chatId)), 'the pause flag file outlived the pause')
  ok("1 Pause mid-subagent: its calls ran (one with the flag set), it handed back, and the main thread's next call was blocked")

  // 2. the Paused notice ends the reply, after the agent's status, with Resume on it
  const tail = items.slice(-2)
  assert(tail[0].type === 'assistant' && tail[0].text === STATUS, `the status before the notice ${JSON.stringify(tail[0])}`)
  assert(
    tail[1].type === 'notice' && tail[1].kind === 'userPaused' && tail[1].text === PAUSED_TEXT,
    `the last item ${JSON.stringify(tail[1])}`
  )
  await page.locator(tid('resume-button')).waitFor({ timeout: T })
  assert((await page.locator(tid('pause-button')).count()) === 0, 'Pause is still offered once paused')
  ok("2 the reply ends with the agent's status and the Paused notice, which carries Resume")

  // 3. the message typed while pausing sits held, with Send now, and did not start
  let meta = await metaOf(chatId)
  assert(
    meta.held === true &&
      same(
        (meta.tasks ?? []).map((t) => t.text),
        [HELD]
      ),
    `held tray ${JSON.stringify({ held: meta.held, tasks: meta.tasks })}`
  )
  assert(same(await taskTexts(page), [HELD]), `the tray shows ${JSON.stringify(await taskTexts(page))}`)
  await page.locator(tid('task-send')).waitFor({ timeout: T })
  assert((await invocations()).length === 1, `${(await invocations()).length} runs started, not 1`)
  ok('3 the message typed while pausing is held in the tray with Send now, and nothing started')

  // 4. a server restart keeps the chat paused
  await h.restartServer()
  await page.reload()
  await page.locator(tid('resume-button')).waitFor({ timeout: 30_000 })
  await page.locator(tid('task-send')).waitFor({ timeout: T })
  await sleep(500) // a negative check: the queue's start-up pump must start nothing
  meta = await metaOf(chatId)
  assert(
    meta.pause === 'paused' && meta.held === true && !meta.inFlight && meta.tasks?.length === 1,
    `meta after the restart ${JSON.stringify({ pause: meta.pause, held: meta.held, inFlight: meta.inFlight, tasks: meta.tasks?.length })}`
  )
  assert((await invocations()).length === 1, 'a run started after the restart')
  items = await itemsOf(chatId)
  assert(
    items.at(-1).type === 'notice' && items.at(-1).kind === 'userPaused',
    `the last item after the restart ${JSON.stringify(items.at(-1))}`
  )
  ok('4 after a server restart the chat is still paused: Paused with Resume, the held message with Send now, nothing started')

  // 5. Resume sends Continue; the held message goes after that reply
  const RESUMED = 'Deploying now.'
  await reply(RESUMED) // read by both runs: Continue's, then the held message's
  await page.locator(tid('resume-button')).click()
  await waitFor(
    async () => {
      const m = await metaOf(chatId)
      return !m.inFlight && !m.tasks?.length && afterLastPause(await itemsOf(chatId)).filter((x) => x.startsWith('assistant:')).length === 2
    },
    30_000,
    'Continue and the held message to be answered'
  )
  const after = afterLastPause(await itemsOf(chatId))
  assert(
    same(after, ['user:Continue', `assistant:${RESUMED}`, `user:${HELD}`, `assistant:${RESUMED}`]),
    `after Resume ${JSON.stringify(after)}`
  )
  meta = await metaOf(chatId)
  assert(meta.pause === undefined && meta.held === undefined, `meta after Resume ${JSON.stringify({ pause: meta.pause, held: meta.held })}`)
  let inv = await invocations()
  assert(
    inv.length === 3 && inv.slice(1).every((x) => x.args[x.args.indexOf('--resume') + 1] === SID),
    `runs after Resume ${JSON.stringify(inv.map((x) => x.args.slice(0, 6)))}`
  )
  await page.locator(tid('resume-button')).waitFor({ state: 'detached', timeout: T })
  ok('5 Resume sends Continue on the same session, then the held message; the pause and the hold are gone')

  // 6. every run's CLAUDE_CODE_TMPDIR is the chat's own folder under <data>/claude-tmp
  const expected = tmpOf(chatId)
  assert(
    inv.every((x) => x.tmpdir === expected) && expected.startsWith(join(h.dataDir, 'claude-tmp') + sep),
    `tmpdirs ${JSON.stringify(inv.map((x) => x.tmpdir))}, not ${expected}`
  )
  assert(existsSync(expected), 'the chat temp folder does not exist')
  ok(`6 every run's CLAUDE_CODE_TMPDIR is the chat's folder ${expected.slice(h.dataDir.length + 1)}`)

  // 7. Stop while pausing: the tray stays held (a typed message and a routine's), Paused shows; Resume then runs both
  const ROUTINE = 'Routine check of the deploy.'
  const routine = await rpc(page, 'routines:save', {
    id: null,
    name: 'Pause e2e routine',
    enabled: true,
    timeZone: 'UTC',
    trigger: { kind: 'manual' },
    target: { kind: 'chat', chatId },
    prompt: ROUTINE,
    limitPolicy: 'wait',
    missedPolicy: 'run-once',
    sessionPolicy: 'fresh'
  })
  await script(longScript(1))
  await typeAndSend(page, 'Run the long review.')
  await waitFor(async () => (await hooks()).length === 4, T, "the long review's subagent call")
  await page.locator(tid('pause-button')).click()
  await waitFor(async () => (await metaOf(chatId))?.pause === 'pausing', T, 'the chat to be pausing')
  await waitFor(
    async () =>
      (await page
        .locator(tid('pausing-line'))
        .textContent()
        .catch(() => null)) === 'Pausing — waiting for 1 subagent',
    T,
    'the pausing line to count the running subagent'
  )
  const TYPED = 'Then check the logs.'
  await typeAndSend(page, TYPED)
  await page.locator(tid('task-row')).waitFor({ timeout: T })
  const run = await rpc(page, 'routines:runNow', routine.id)
  await waitFor(async () => (await metaOf(chatId))?.tasks?.length === 2, T, "the routine's message to join the tray")
  meta = await metaOf(chatId)
  assert(
    meta.tasks[1].id === run.messageId && meta.next?.fresh !== true,
    `the routine's task ${JSON.stringify({ tasks: meta.tasks.map((t) => t.id), runMessage: run.messageId, next: meta.next })}`
  )
  await pressStop(page)
  await waitFor(() => idleAndPaused(chatId), 30_000, 'Stop to land the pause')
  await sleep(500) // a negative check: Stop must not start the oldest queued message
  meta = await metaOf(chatId)
  items = await itemsOf(chatId)
  assert(same(lastKinds(items, 2), ['notice:stopped', 'notice:userPaused']), `the items end ${JSON.stringify(lastKinds(items, 3))}`)
  assert(
    !meta.inFlight &&
      meta.held === true &&
      same(
        meta.tasks.map((t) => t.text),
        [TYPED, ROUTINE]
      ),
    `meta after Stop ${JSON.stringify({ inFlight: meta.inFlight, held: meta.held, tasks: meta.tasks?.map((t) => t.text) })}`
  )
  assert((await invocations()).length === 4, `${(await invocations()).length} runs after Stop, not 4: a queued message started`)
  assert((await runOf(routine.id, run.id))?.status === 'running', `the routine run is ${JSON.stringify(await runOf(routine.id, run.id))}`)
  await page.locator(tid('resume-button')).waitFor({ timeout: T })
  await page.locator(tid('task-send')).first().waitFor({ timeout: T })
  await reply(RESUMED)
  await page.locator(tid('resume-button')).click()
  await waitFor(
    async () => (await runOf(routine.id, run.id))?.status === 'done' && !(await metaOf(chatId)).inFlight,
    30_000,
    'the routine run to end done after Resume'
  )
  const after7 = afterLastPause(await itemsOf(chatId))
  assert(
    same(after7, [
      'user:Continue',
      `assistant:${RESUMED}`,
      `user:${TYPED}`,
      `assistant:${RESUMED}`,
      `user:${ROUTINE}`,
      `assistant:${RESUMED}`
    ]),
    `after the second Resume ${JSON.stringify(after7)}`
  )
  inv = await invocations()
  assert(
    inv.length === 7 && inv[4].args[inv[4].args.indexOf('--resume') + 1] === SID,
    `Continue did not resume the paused session: ${JSON.stringify(inv[4]?.args.slice(0, 6))}`
  )
  ok(
    '7 Stop while pausing keeps the tray held (typed and routine messages, neither started) and shows Paused; the routine kept the session for Resume and ends done after it'
  )

  // 8. a server restart mid-pause lands the pause: Paused, the tray held, nothing starts
  await script(longScript(2))
  await typeAndSend(page, 'Run another long review.')
  await waitFor(async () => (await hooks()).length === 5, T, "the second long review's subagent call")
  await page.locator(tid('pause-button')).click()
  await waitFor(async () => (await metaOf(chatId))?.pause === 'pausing', T, 'the chat to be pausing')
  const LATE = 'And the release notes.'
  await typeAndSend(page, LATE)
  await page.locator(tid('task-row')).waitFor({ timeout: T })
  await h.restartServer()
  await page.reload()
  await page.locator(tid('resume-button')).waitFor({ timeout: 30_000 })
  await sleep(500) // a negative check: the start-up pump must start nothing
  meta = await metaOf(chatId)
  items = await itemsOf(chatId)
  assert(
    meta.pause === 'paused' &&
      !meta.inFlight &&
      meta.held === true &&
      same(
        meta.tasks?.map((t) => t.text),
        [LATE]
      ),
    `meta after the restart ${JSON.stringify({ pause: meta.pause, inFlight: meta.inFlight, held: meta.held, tasks: meta.tasks?.map((t) => t.text) })}`
  )
  assert(items.at(-1).type === 'notice' && items.at(-1).kind === 'userPaused', `the items end ${JSON.stringify(lastKinds(items, 3))}`)
  assert((await invocations()).length === 8, `${(await invocations()).length} runs after the restart, not 8`)
  await page.locator(tid('task-send')).waitFor({ timeout: T })
  ok(`8 a restart mid-pause lands it (${lastKinds(items, 2).join(', ')}): Paused with Resume, the tray held with Send now, nothing started`)

  // 9. a routine run whose own turn the user pauses is paused, not failed, and Resume's Continue carries it to done
  const own = await rpc(page, 'routines:save', {
    id: null,
    name: 'Pause e2e own turn',
    enabled: true,
    timeZone: 'UTC',
    trigger: { kind: 'manual' },
    target: { kind: 'new-chat', agent: AGENT, cwd: work },
    prompt: 'Check the build, then deploy.',
    limitPolicy: 'wait',
    missedPolicy: 'run-once',
    sessionPolicy: 'continue'
  })
  await script(pauseScript())
  const hooksBefore = (await hooks()).length
  const ownRun = await rpc(page, 'routines:runNow', own.id)
  await page.goto(`${h.origin}/chat/${ownRun.chatId}`)
  await waitFor(async () => (await hooks()).length === hooksBefore + 1, T, "the routine turn's first subagent call")
  await page.locator(tid('pause-button')).click()
  await waitFor(() => idleAndPaused(ownRun.chatId), 30_000, "the pause to land on the routine's turn")
  await waitFor(async () => (await runOf(own.id, ownRun.id))?.status === 'paused', T, 'the routine run to be paused')
  let stored = await runOf(own.id, ownRun.id)
  assert(stored.error === undefined && stored.endedAt === undefined, `the paused run ${JSON.stringify(stored)}`)
  const runRow = (status) => page.locator(`${tid('run-row')}[data-status="${status}"]`)
  await page.goto(`${h.origin}/routines/${own.id}`)
  await runRow('paused').waitFor({ timeout: T })
  const pausedLine = await runRow('paused').locator(tid('run-pause')).textContent()
  assert(pausedLine === 'Paused by you · press Resume in its chat to continue', `the paused run's line ${JSON.stringify(pausedLine)}`)
  await page.goto(`${h.origin}/chat/${ownRun.chatId}`)
  await reply(RESUMED)
  await page.locator(tid('resume-button')).click()
  await waitFor(async () => (await runOf(own.id, ownRun.id))?.status === 'done', 30_000, 'the routine run to end done after Resume')
  stored = await runOf(own.id, ownRun.id)
  const cont = (await itemsOf(ownRun.chatId)).find((i) => i.type === 'user' && i.text === 'Continue')
  assert(
    cont && stored.messageId === cont.id && stored.resumes === 1 && stored.error === undefined,
    `the resumed run ${JSON.stringify(stored)}`
  )
  await page.goto(`${h.origin}/routines/${own.id}`)
  await runRow('done').waitFor({ timeout: T })
  const doneLine = await runRow('done').locator(tid('run-pause')).textContent()
  assert(doneLine === 'Resumed after a pause', `the done run's line ${JSON.stringify(doneLine)}`)
  ok("9 a routine run whose own turn is paused shows paused, not failed; Resume's Continue carries it to done")

  // 10. a workflow Agent step whose turn the user pauses stays open, and Resume's Continue carries it on to done
  const wf = await rpc(page, 'workflows:save', {
    id: null,
    name: 'Pause e2e flow',
    enabled: false,
    timeZone: 'UTC',
    trigger: { kind: 'manual' },
    steps: [
      { id: 't', handle: 't', name: 'Start', kind: 'trigger', x: 0, y: 0 },
      { id: 'g', handle: 'g', name: 'Build', kind: 'agent', agent: AGENT, prompt: 'Check the build, then deploy.', cwd: work, x: 300, y: 0 }
    ],
    edges: [{ id: 't-out-g', from: 't', port: 'out', to: 'g' }]
  })
  await script(pauseScript())
  const hooksAtFlow = (await hooks()).length
  const wfRun = await rpc(page, 'workflows:run', wf.id)
  await waitFor(
    async () => Boolean((await workflowRunOf(wfRun.id))?.visits?.find((v) => v.stepId === 'g')?.chatId),
    T,
    "the Agent step's chat"
  )
  const stepChat = (await workflowRunOf(wfRun.id)).visits.find((v) => v.stepId === 'g').chatId
  await page.goto(`${h.origin}/chat/${stepChat}`)
  await waitFor(async () => (await hooks()).length === hooksAtFlow + 1, T, "the step turn's first subagent call")
  await page.locator(tid('pause-button')).click()
  await waitFor(() => idleAndPaused(stepChat), 30_000, "the pause to land on the step's turn")
  const stepVisit = async () => (await workflowRunOf(wfRun.id)).visits.find((v) => v.stepId === 'g')
  await waitFor(async () => (await stepVisit())?.paused === true, T, 'the step to be paused')
  let paused = await workflowRunOf(wfRun.id)
  assert(
    paused.status === 'running' && (await stepVisit()).status === 'running' && (await stepVisit()).error === undefined,
    `the paused run ${JSON.stringify({ status: paused.status, visit: await stepVisit() })}`
  )
  await page.goto(`${h.origin}/workflows/${wf.id}/runs/${wfRun.id}`)
  await page.locator(`${tid('wf-node')}[data-step-id="g"][data-state="paused"]`).waitFor({ timeout: T })
  await page.goto(`${h.origin}/chat/${stepChat}`)
  await reply(RESUMED)
  await page.locator(tid('resume-button')).click()
  await waitFor(async () => (await workflowRunOf(wfRun.id))?.status === 'done', 30_000, 'the workflow run to end done after Resume')
  const doneVisit = await stepVisit()
  const stepCont = (await itemsOf(stepChat)).find((i) => i.type === 'user' && i.text === 'Continue')
  assert(
    doneVisit.status === 'done' && doneVisit.output === RESUMED && doneVisit.resumes === 1 && doneVisit.messageId === stepCont?.id,
    `the resumed step ${JSON.stringify(doneVisit)}`
  )
  ok("10 a workflow Agent step whose turn is paused stays open, shown paused; Resume's Continue carries it to done")

  // 11. A tab that tries to reconnect while a restart (4, 8) has no server listening logs a refused socket: nothing else may show.
  const bad = unexpectedErrors(h.errors, [/WebSocket connection to '[^']*\/ws' failed: .*net::ERR_CONNECTION_REFUSED/])
  assert(bad.length === 0, `unexpected console/server errors:\n${bad.join('\n')}`)
  ok('11 no console or server errors')
}

/**
 * Stops the server and Chrome, kills (and reports) any process carrying this run's mark, and removes the dirs made here.
 * Shared by the normal end and the overall timeout; returns false when something outlived the run.
 */
let cleaning = null
function cleanup() {
  cleaning ??= (async () => {
    await stop()
    // Nothing this run started may outlive it: fake claudes and their hooks go with the server, Chrome with the harness.
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
console.log(code === 0 ? 'e2e:pause passed' : 'e2e:pause FAILED')
process.exit(code)
