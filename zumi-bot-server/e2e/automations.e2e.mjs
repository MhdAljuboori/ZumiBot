// End-to-end check of Zumi Bot's routine and workflow tools in the built server + web UI (local mode) against the
// FAKE claude (backend/tests/fixtures/fake-claude.mjs): no real CLI call is ever made, so no login or quota is used.
// Usage: npm run e2e:automations   (builds first)
//
// The tool calls are real: each Zumi Bot turn's script has an #MCP_CALL line, so the fake starts the
// zumibot_automations bridge from the --mcp-config the server passed (Zumi Bot's runs only), with the capability env
// the server gave it, and calls the tool over stdio, after a can_use_tool request (manual mode). The server answers the
// read, create and edit requests by itself (no card); the two delete tools get a card with Allow once and Deny only,
// answered on the page, and the fake waits on that answer (a deny skips the call, as the CLI does). Every #MCP_CALL's
// result is read from FAKE_MCP_RESULTS_OUT, what each request was answered from FAKE_RESPONSES_FILE, and FAKE_STDIN_OUT
// (written when a fake exits) says a run is over.
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server, Chrome and the browser context started here are stopped in `finally`; overall timeout 4 min.
//
// The page runs in its own context with the time zone Pacific/Chatham (not the server's), so a routine or workflow
// saved without a time zone proves the server used the one the page reported (app:setTimeZone).
//
// DOM hooks relied on (data-testid): composer-input, send-button, agent-message, approval-card (+ data-status,
//   data-request-id), approval-allow-once, approval-allow-chat, approval-allow-agent, approval-deny, message-list,
//   routine-editor, routine-name, workflow-editor, workflow-name, wf-canvas, wf-node; class approval-head.
// Stored state read: <dataDir>/chats.json, <dataDir>/chats/<id>.json, <dataDir>/settings.json.

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-claude.mjs', import.meta.url))
const CB = 'zumi-bot'
const AGENT = 'e2e-auto-writer'
const PREFIX = 'zumibot-e2e-automations-'
const OVERALL_TIMEOUT = 4 * 60_000
const T = 15_000
const ZONE = 'Pacific/Chatham' // the page's zone: neither UTC nor this machine's
const SERVER = 'zumibot_automations'
// Verbatim from shared/src/automations.ts (WRITE_REFUSED, STALE_REFUSED).
const WRITE_REFUSED = 'Routines and workflows can only be changed from a message the user sends.'
const STALE_REFUSED = 'It changed since you read it: read it again.'
// The canvas draws a step 220 by 72 (WorkflowCanvas.tsx NODE_HALF), every step from the same anchor.
const NODE = { w: 220, h: 72 }

const ROUTINE = 'Daily tech hashtags'
const WORKFLOW = 'Hashtags'
const DAILY = { freq: 'daily', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6] }

let h = null
let ctx = null
const made = [] // every mkdtemp dir made here
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

async function stop() {
  if (ctx) {
    const c = ctx
    ctx = null
    await Promise.race([c.close().catch(() => {}), sleep(10_000)])
  }
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

// One raw RPC over a fresh /ws socket from the page, so the auth cookie rides along.
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

const storedChats = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats
const metaOf = async (id) => (await storedChats()).find((c) => c.id === id)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])
const settingsFile = async () => readFile(join(h.dataDir, 'settings.json'), 'utf8').then(JSON.parse, () => ({}))

// ---------- the fake claude's script: one file, rewritten before each turn ----------
const SID = '7a2e3f40-5b6c-4d70-8e91-a2b3c4d5e6f7'
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
// A tool call as the manual-mode CLI makes it: tool_use, a can_use_tool request (req-<id>) it waits on, the result.
const call = (tool, args, id) => `#MCP_CALL ${line({ server: SERVER, tool, args, id, permission: `req-${id}` })}`
const script = (...lines) => writeFile(h.script, lines.join('\n') + '\n')
const turn = (calls, reply) => script(init(), ...calls, say(reply), result(reply))

// ---------- what the fakes did ----------
let resultsFile = null
let responsesFile = null
let stdinFile = null
const jsonLines = async (file) =>
  (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))
/** The fake's record of one #MCP_CALL ({id, tool, text, isError}), once it is there. */
async function mcpResult(id) {
  let got = null
  await waitFor(
    async () => (got = (await jsonLines(resultsFile)).find((r) => r.id === id) ?? null) !== null,
    30_000,
    `the fake to log the result of ${id}`
  )
  return got
}
/** What the server answered the fake's can_use_tool request, or null while unanswered. */
const answerTo = async (requestId) =>
  (await jsonLines(responsesFile)).find((m) => m.response?.request_id === requestId)?.response?.response ?? null

// ---------- UI helpers ----------
const composer = (page) => page.locator(tid('composer-input'))
const cardOf = (page, requestId) => page.locator(`${tid('approval-card')}[data-request-id="${requestId}"]`)

async function typeAndSend(page, message) {
  await rm(stdinFile, { force: true })
  await composer(page).click()
  await page.keyboard.type(message)
  await page.click(tid('send-button'))
}

/** Waits until the reply `text` is shown, the chat is idle and the fake has exited. */
async function waitReply(page, chatId, reply, { cards = false } = {}) {
  await waitFor(
    async () => {
      // A request the server should answer by itself would wait on a card: fail at once, by name.
      if (!cards && (await page.locator(`${tid('approval-card')}[data-status="pending"]`).count()) > 0)
        throw new Error(`ASSERT FAILED: an approval card appeared before the reply "${reply}"`)
      return (await page.locator(tid('agent-message'), { hasText: reply }).count()) > 0
    },
    30_000,
    `the reply "${reply}"`
  )
  await waitFor(
    async () => {
      const m = await metaOf(chatId)
      return m && !m.inFlight && (await page.locator(tid('send-button')).textContent())?.trim() === 'Send'
    },
    30_000,
    `the reply "${reply}" to end`
  )
  await waitFor(async () => existsSync(stdinFile), 30_000, 'the fake claude to exit')
}

async function send(page, chatId, message, reply) {
  await typeAndSend(page, message)
  await waitReply(page, chatId, reply)
}

const routinesNow = async (page) => (await rpc(page, 'routines:list')).routines
const workflowsNow = async (page) => (await rpc(page, 'workflows:list')).workflows
const policiesOf = (r) => ({ limit: r.limitPolicy ?? 'wait', missed: r.missedPolicy ?? 'run-once', session: r.sessionPolicy ?? 'continue' })
const routineInput = (o) => ({
  id: null,
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  limitPolicy: 'wait',
  missedPolicy: 'run-once',
  sessionPolicy: 'continue',
  command: null,
  ...o
})

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  const logs = await mk('logs')
  resultsFile = join(logs, 'mcp-results.jsonl')
  responsesFile = join(logs, 'responses.jsonl')
  stdinFile = join(logs, 'stdin.jsonl')
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Automations e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  h = await start({
    fake: FAKE,
    dataDir,
    agentsDir,
    env: { FAKE_MCP_RESULTS_OUT: resultsFile, FAKE_RESPONSES_FILE: responsesFile, FAKE_STDIN_OUT: stdinFile }
  })

  // The harness's own tab reported this machine's zone at load: close it, so the last zone reported is the page's.
  await h.page.close()
  ctx = await h.newContext({ timezoneId: ZONE })
  const page = await ctx.newPage()
  await page.goto(h.origin)
  await page.locator(tid('composer-input')).waitFor({ timeout: 30_000 })
  assert(
    (await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)) === ZONE,
    'the page does not run in the chosen time zone'
  )
  await waitFor(async () => (await settingsFile()).timeZone === ZONE, T, `the server to keep the zone the page reported (${ZONE})`)
  assert(
    !new Set(['UTC', Intl.DateTimeFormat().resolvedOptions().timeZone]).has(ZONE),
    'the page zone is not distinct from UTC or the server zone'
  )

  // The new-chat screen remembers this as the agent's folder, so a routine or step that names none should get it.
  await rpc(page, 'chats:create', AGENT, folder)
  assert((await settingsFile()).lastFolderByAgent?.[AGENT] === folder, "the agent's folder was not remembered")
  const chatId = (await rpc(page, 'chats:create', CB, agentsDir)).id
  await page.goto(`${h.origin}/chat/${encodeURIComponent(chatId)}`)
  await composer(page).waitFor({ timeout: T })

  // 1. routine_save from a message the user sent creates an enabled daily routine with the defaults filled in
  await turn(
    [
      call(
        'routine_save',
        {
          routine: {
            name: ROUTINE,
            trigger: { kind: 'schedule', schedule: DAILY },
            target: { kind: 'new-chat', agent: AGENT },
            prompt: 'Find the trending tech hashtags and draft a post for each.'
          }
        },
        'toolu_rsave'
      )
    ],
    'The routine is ready.'
  )
  // No @ typed: the composer's mention menu is not what this checks.
  await send(
    page,
    chatId,
    '/create-routine everyday at 9 using the e2e auto writer to draft a post per trending tech hashtag',
    'The routine is ready.'
  )
  const saved = await mcpResult('toolu_rsave')
  assert(!saved.isError, `routine_save failed: ${saved.text}`)
  assert((await answerTo('req-toolu_rsave'))?.behavior === 'allow', 'the server did not allow routine_save by itself')
  const out1 = JSON.parse(saved.text)
  const routine = (await routinesNow(page)).find((r) => r.name === ROUTINE)
  assert(routine, `routines:list has no "${ROUTINE}"`)
  assert(out1.id === routine.id && out1.path === `/routines/${routine.id}` && out1.enabled === true, `the tool result is ${saved.text}`)
  assert(!/hooks|secret/i.test(saved.text), 'the tool result names a hook or secret')
  assert(routine.enabled === true, 'the routine was saved off')
  assert(routine.timeZone === ZONE, `the routine's zone is ${routine.timeZone}, not the page's ${ZONE}`)
  assert(
    JSON.stringify(routine.trigger) === JSON.stringify({ kind: 'schedule', schedule: DAILY }),
    `the trigger is ${JSON.stringify(routine.trigger)}`
  )
  assert(
    routine.target.kind === 'new-chat' && routine.target.agent === AGENT && routine.target.cwd === folder,
    `the target is ${JSON.stringify(routine.target)}, not a new chat in the agent's folder`
  )
  assert(
    JSON.stringify(policiesOf(routine)) === JSON.stringify({ limit: 'wait', missed: 'run-once', session: 'continue' }),
    `the policies are ${JSON.stringify(policiesOf(routine))}`
  )
  assert(typeof routine.nextRunAt === 'number' && routine.nextRunAt > Date.now(), 'the routine has no next run')
  ok(`1 routine_save made "${ROUTINE}": on, daily 09:00 in ${ZONE}, a new chat with @${AGENT} in its folder, default policies, no card`)

  // 2. workflow_save with handles and no positions: the steps are placed left to right, none on another
  await turn(
    [
      call(
        'workflow_save',
        {
          workflow: {
            name: WORKFLOW,
            trigger: { kind: 'manual' },
            steps: [
              {
                handle: 'explore',
                name: 'Explore x.com',
                kind: 'agent',
                agent: AGENT,
                prompt: 'Find new tech hashtags on x.com, one per line.'
              },
              {
                handle: 'filter',
                name: 'Claude only',
                kind: 'llm',
                prompt: 'Keep only the Claude-related hashtags, one per line:\n\n{{input}}'
              },
              {
                handle: 'draft',
                name: 'Draft articles',
                kind: 'foreach',
                agent: AGENT,
                prompt: 'Write an article on {{item}}, save it as a Notion page and end with its link.'
              },
              { handle: 'tell', name: 'Tell me', kind: 'notify', title: 'Hashtag articles', body: '{{input}}' }
            ],
            edges: [
              { from: 'trigger', to: 'explore' },
              { from: 'explore', to: 'filter' },
              { from: 'filter', to: 'draft' },
              { from: 'draft', to: 'tell' }
            ]
          }
        },
        'toolu_wsave'
      )
    ],
    'The workflow is ready.'
  )
  await send(
    page,
    chatId,
    '/create-workflow manually explore hashtags, keep the Claude ones, draft an article for each, notify me',
    'The workflow is ready.'
  )
  const wsaved = await mcpResult('toolu_wsave')
  assert(!wsaved.isError, `workflow_save failed: ${wsaved.text}`)
  const out2 = JSON.parse(wsaved.text)
  const workflow = (await workflowsNow(page)).find((w) => w.name === WORKFLOW)
  assert(workflow, `workflows:list has no "${WORKFLOW}"`)
  assert(
    out2.id === workflow.id &&
      out2.path === `/workflows/${workflow.id}` &&
      out2.enabled === true &&
      Array.isArray(out2.problems) &&
      out2.problems.length === 0,
    `the tool result is ${wsaved.text}`
  )
  assert(
    workflow.enabled === true && workflow.timeZone === ZONE && workflow.trigger.kind === 'manual',
    `the workflow is ${JSON.stringify({ enabled: workflow.enabled, timeZone: workflow.timeZone, trigger: workflow.trigger })}`
  )
  const byHandle = new Map(workflow.steps.map((s) => [s.kind === 'trigger' ? 'trigger' : s.handle, s]))
  assert(
    workflow.steps.length === 5 && ['trigger', 'explore', 'filter', 'draft', 'tell'].every((k) => byHandle.has(k)),
    `the steps are ${JSON.stringify(workflow.steps.map((s) => s.handle))}`
  )
  assert(byHandle.get('explore').cwd === folder && byHandle.get('draft').cwd === folder, "the agent steps did not get the agent's folder")
  assert(workflow.edges.length === 4, `the workflow has ${workflow.edges.length} edges`)
  const xs = ['trigger', 'explore', 'filter', 'draft', 'tell'].map((k) => byHandle.get(k).x)
  assert(
    xs.every((x, i) => i === 0 || x > xs[i - 1]),
    `the chain is not laid out left to right: x = ${JSON.stringify(xs)}`
  )
  const steps = workflow.steps
  for (let i = 0; i < steps.length; i++) {
    for (let j = i + 1; j < steps.length; j++) {
      const [a, b] = [steps[i], steps[j]]
      assert(Number.isFinite(a.x) && Number.isFinite(a.y), `step ${a.handle} has no position`)
      assert(
        Math.abs(a.x - b.x) >= NODE.w || Math.abs(a.y - b.y) >= NODE.h,
        `steps ${a.handle} (${a.x},${a.y}) and ${b.handle} (${b.x},${b.y}) overlap`
      )
    }
  }
  assert((await answerTo('req-toolu_wsave'))?.behavior === 'allow', 'the server did not allow workflow_save by itself')
  ok(`2 workflow_save made "${WORKFLOW}": on, ${ZONE}, 5 steps left to right, none overlapping, no problems, no card`)

  // 3. the reply's links to the routine and the workflow open them in this same tab
  const rid = routine.id
  const wid = workflow.id
  const LINKS_REPLY = 'Both are ready.'
  await turn([], `${LINKS_REPLY}\n\n[${ROUTINE}](/routines/${rid})\n\n[${WORKFLOW}](/workflows/${wid})`)
  await send(page, chatId, 'Give me both links', LINKS_REPLY)
  let popups = 0
  const onPage = () => popups++
  ctx.on('page', onPage)
  page.on('popup', onPage)
  const routineLink = page.locator(`${tid('agent-message')} a[href="/routines/${rid}"]`)
  const workflowLink = page.locator(`${tid('agent-message')} a[href="/workflows/${wid}"]`)
  await routineLink.waitFor({ timeout: T })
  assert(
    (await routineLink.getAttribute('target')) === null && (await workflowLink.getAttribute('target')) === null,
    'an in-app link opens a new tab'
  )
  assert(
    (await routineLink.textContent()) === ROUTINE && (await workflowLink.textContent()) === WORKFLOW,
    'the links do not read the names'
  )
  await routineLink.click()
  await page.locator(tid('routine-editor')).waitFor({ timeout: T })
  await waitFor(async () => (await page.evaluate(() => location.pathname)) === `/routines/${rid}`, T, 'the address to name the routine')
  await waitFor(async () => (await page.locator(tid('routine-name')).inputValue()) === ROUTINE, T, `the editor to show "${ROUTINE}"`)
  assert(ctx.pages().length === 1 && popups === 0, `the routine link opened another page (${ctx.pages().length} pages, ${popups} popups)`)
  await page.goBack()
  await waitFor(async () => (await page.evaluate(() => location.pathname)) === `/chat/${chatId}`, T, 'Back to return to the chat')
  await workflowLink.waitFor({ timeout: T })
  await workflowLink.click()
  await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
  await waitFor(async () => (await page.evaluate(() => location.pathname)) === `/workflows/${wid}`, T, 'the address to name the workflow')
  await waitFor(async () => (await page.locator(tid('workflow-name')).inputValue()) === WORKFLOW, T, `the canvas to show "${WORKFLOW}"`)
  await page.locator(tid('wf-canvas')).waitFor({ timeout: T })
  await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 5, T, 'the canvas to draw the 5 steps')
  assert(ctx.pages().length === 1 && popups === 0, `the workflow link opened another page (${ctx.pages().length} pages, ${popups} popups)`)
  ctx.off('page', onPage)
  page.off('popup', onPage)
  ok('3 the reply links open the Routines editor, then the workflow canvas, in the same tab (1 page, no popup)')

  // 4. routine_delete: a card with Allow once and Deny only; Deny keeps the routine, Allow once removes it
  await page.goto(`${h.origin}/chat/${encodeURIComponent(chatId)}`)
  await composer(page).waitFor({ timeout: T })
  const del = { id: rid, name: ROUTINE }
  const askDelete = async (id, reply) => {
    await turn([call('routine_delete', del, id)], reply)
    await typeAndSend(page, `/delete-routine ${ROUTINE}`)
    const card = cardOf(page, `req-${id}`)
    await card.waitFor({ timeout: 30_000 })
    await waitFor(async () => (await card.getAttribute('data-status')) === 'pending', T, 'the delete card to wait')
    const head = ((await card.locator('.approval-head').textContent()) ?? '').trim()
    assert(head.includes(`Delete routine “${ROUTINE}”`), `the card reads ${JSON.stringify(head)}`)
    for (const [hook, n] of [
      ['approval-allow-once', 1],
      ['approval-deny', 1],
      ['approval-allow-chat', 0],
      ['approval-allow-agent', 0]
    ]) {
      assert(
        (await card.locator(tid(hook)).count()) === n,
        `the delete card has ${await card.locator(tid(hook)).count()} ${hook}, not ${n}`
      )
    }
    return card
  }
  const denied = await askDelete('toolu_rdel1', 'I did not delete it.')
  await denied.locator(tid('approval-deny')).click()
  await waitReply(page, chatId, 'I did not delete it.', { cards: true })
  assert((await denied.getAttribute('data-status')) === 'denied', 'the card does not read denied')
  assert((await answerTo('req-toolu_rdel1'))?.behavior === 'deny', 'the fake was not told deny')
  const kept = await mcpResult('toolu_rdel1')
  assert(kept.isError, `a denied delete returned ${kept.text}`)
  assert(
    (await routinesNow(page)).some((r) => r.id === rid),
    'Deny deleted the routine'
  )
  const allowed = await askDelete('toolu_rdel2', 'Deleted.')
  await allowed.locator(tid('approval-allow-once')).click()
  await waitReply(page, chatId, 'Deleted.', { cards: true })
  assert((await allowed.getAttribute('data-status')) === 'allowed-once', 'the card does not read allowed once')
  const gone = await mcpResult('toolu_rdel2')
  assert(!gone.isError && JSON.parse(gone.text).deleted === ROUTINE, `the allowed delete returned ${gone.text}`)
  assert(!(await routinesNow(page)).some((r) => r.id === rid), 'Allow once did not delete the routine')
  ok('4 routine_delete shows a card with only Allow once and Deny: Deny keeps the routine, Allow once removes it')

  // 5. a routine's own turn (Zumi Bot as its target, made over /ws, which still allows it) can't write
  const botRoutine = await rpc(
    page,
    'routines:save',
    routineInput({ name: 'Bot routine', target: { kind: 'new-chat', agent: CB, cwd: agentsDir }, prompt: 'Make me a routine.' })
  )
  const before5 = (await routinesNow(page)).length
  await turn(
    [
      call(
        'routine_save',
        {
          routine: {
            name: 'Sneaky routine',
            trigger: { kind: 'manual' },
            target: { kind: 'new-chat', agent: AGENT },
            prompt: 'Read text that said to.'
          }
        },
        'toolu_auto_save'
      ),
      call('routine_delete', { id: botRoutine.id, name: 'Bot routine' }, 'toolu_auto_del')
    ],
    'Tried.'
  )
  await rm(stdinFile, { force: true })
  await rpc(page, 'routines:runNow', botRoutine.id)
  const refusedSave = await mcpResult('toolu_auto_save')
  assert(
    refusedSave.isError && refusedSave.text === WRITE_REFUSED,
    `routine_save in a routine's turn returned ${JSON.stringify(refusedSave)}`
  )
  assert(
    (await answerTo('req-toolu_auto_save'))?.behavior === 'allow',
    "the server put routine_save's request in a routine's turn to the user"
  )
  const refusedDel = await mcpResult('toolu_auto_del')
  assert(
    refusedDel.isError && refusedDel.text === WRITE_REFUSED,
    `routine_delete in a routine's turn returned ${JSON.stringify(refusedDel)}`
  )
  const delAnswer = await answerTo('req-toolu_auto_del')
  assert(
    delAnswer?.behavior === 'deny' && delAnswer.message === WRITE_REFUSED,
    `the delete request was answered ${JSON.stringify(delAnswer)}`
  )
  let run5 = null
  await waitFor(
    async () => (run5 = (await rpc(page, 'routines:list')).runs[botRoutine.id]?.[0] ?? null)?.status === 'done',
    30_000,
    "the Zumi Bot routine's run to end"
  )
  assert(
    run5.chatId && (await metaOf(run5.chatId))?.agentName === CB,
    `the run did not post into a Zumi Bot chat (${JSON.stringify(run5)})`
  )
  assert(!(await itemsOf(run5.chatId)).some((i) => i.type === 'approval'), "the routine's chat holds an approval card")
  const after5 = await routinesNow(page)
  assert(
    after5.length === before5 && !after5.some((r) => r.name === 'Sneaky routine') && after5.some((r) => r.id === botRoutine.id),
    `the routine's turn changed the routines: ${JSON.stringify(after5.map((r) => r.name))}`
  )
  ok(`5 in a routine's own turn routine_save and routine_delete get "${WRITE_REFUSED}" (the delete with no card); nothing changed`)

  // 6. an edit carrying an updatedAt older than the stored one is refused, and the user's save stays
  const weekly = await rpc(
    page,
    'routines:save',
    routineInput({ name: 'Weekly digest', target: { kind: 'new-chat', agent: AGENT, cwd: folder }, prompt: 'Summarise the week.' })
  )
  const readAt = weekly.updatedAt
  await sleep(5) // a different millisecond for the user's own save
  const mine = await rpc(
    page,
    'routines:save',
    routineInput({
      id: weekly.id,
      name: 'Weekly digest',
      target: { kind: 'new-chat', agent: AGENT, cwd: folder },
      prompt: 'Summarise the week, my way.'
    })
  )
  assert(mine.updatedAt !== readAt, 'the user save kept the same updatedAt')
  await turn(
    [
      call(
        'routine_save',
        {
          routine: {
            id: weekly.id,
            updatedAt: readAt,
            name: 'Weekly digest',
            trigger: { kind: 'manual' },
            target: { kind: 'new-chat', agent: AGENT, cwd: folder },
            prompt: 'Overwritten by Zumi Bot.'
          }
        },
        'toolu_stale'
      )
    ],
    'It changed meanwhile.'
  )
  await send(page, chatId, '/edit-routine Weekly digest: change the prompt', 'It changed meanwhile.')
  const stale = await mcpResult('toolu_stale')
  assert(stale.isError && stale.text === STALE_REFUSED, `the stale edit returned ${JSON.stringify(stale)}`)
  const after6 = (await routinesNow(page)).find((r) => r.id === weekly.id)
  assert(
    after6?.prompt === 'Summarise the week, my way.' && after6.updatedAt === mine.updatedAt,
    `the stale edit changed the routine: ${JSON.stringify(after6)}`
  )
  ok(`6 a routine_save with an old updatedAt gets "${STALE_REFUSED}" and the user's own save stays`)

  const bad = unexpectedErrors(h.errors, [])
  assert(bad.length === 0, `unexpected errors: ${bad.join(' | ')}`)
  ok('no console or server errors')
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
console.log(failed ? 'e2e:automations FAILED' : 'e2e:automations passed')
process.exit(failed ? 1 : 0)
