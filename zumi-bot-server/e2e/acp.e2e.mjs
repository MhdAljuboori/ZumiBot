// End-to-end check of ACP agents (Agent Client Protocol) in the built server + web UI (local mode) against the FAKE ACP agent
// (backend/tests/fixtures/fake-acp-agent.mjs, behind the harness's `fakeAcp` shim) and the FAKE claude: no real CLI or agent
// is ever run, so no login or quota is used. See docs/architecture/protocol-engines.md.
// Usage: npm run e2e:acp (builds first)
//
// The fake ACP agent reads its script (h.acp.script, rewritten before each turn) when each process starts, one process per
// attempt; it logs every message it got, answers to its own requests included (h.acp.log), each process's argv, folder and env
// names (h.acp.start), and each process and held child (h.acp.pids). Its requests are numbered from 0 in every process.
// The ACP agent is made in Agent Studio (Engine = ACP agent, Command = the shim), so its launch is confirmed by the Save itself:
// nothing here writes protocol-launch.json, which the refused-launch step depends on.
// The fake claude is fake-clone-claude.mjs: a room's moderator call (--json-schema) answers `{}` (routing falls back to the
// @mentions); every other call is fake-claude.mjs, reading <FAKE_STDOUT_DIR>/<agent>.jsonl.
//
// Hard rules enforced here:
//  - nothing in ~/.claude or the real data dir is touched: the harness gives the server a throwaway HOME, agents dir, data dir
//    and vault key folder;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`, and so is every process the fake ACP agent logged; any of
//    them still running then is a FAIL; overall timeout 6 min.
//
// DOM hooks relied on (data-testid): new-agent, new-menu-agent, new-menu-group, agent-engine, acp-card, acp-command, acp-args,
//   acp-error, acp-compare, acp-test, acp-test-result, agent-row (+ data-agent-name), agent-engine-tag, agent-menu-button,
//   agent-menu-edit, new-chat-folder, new-chat-choose-folder, new-chat-members, new-chat-member-option (+ data-agent-name,
//   aria-disabled), composer-input, send-button (title Stop while running), agent-message, user-message,
//   user-message-actions, message-actions, copy-button, edit-button, resend-button, fork-button, version-switcher,
//   engine-info, approval-card (+ data-status), approval-allow-once, approval-deny, question-card (+ data-status),
//   question-option (+ data-label), question-send, error-bubble. Agent Studio: #agent-name, #agent-description,
//   #agent-prompt, button "Save changes". Streaming shows as [data-streaming].
// Stored state read: <dataDir>/chats.json, <dataDir>/chats/<id>.json, <dataDir>/protocol-launch.json (read only),
//   <agentsDir>/<agent>.md (edited once, outside Agent Studio, for the refused launch).

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from './harness.mjs'
import { killOwnedChild } from './e2eChecks.mjs'

// Answers a room's moderator call with `{}`; every other call is fake-claude.mjs.
const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-clone-claude.mjs', import.meta.url))
const C = 'e2e-acp' // made in Agent Studio on the ACP engine
const A = 'e2e-claude-a' // a Claude agent: the room's other member, and the chat whose Edit button proves the check not vacuous
const PREFIX = 'zumibot-e2e-acp-'
const OVERALL_TIMEOUT = 6 * 60_000
const T = 15_000
const C_BODY = 'You are an ACP test agent. Keep replies short.'
const ARGS = ['--acp', '--profile', 'fake-profile']
// Verbatim from shared/src/acp.ts (ACP_TEXT), shared/src/engine.ts and backend/src/core/chat/groupPrompts.ts.
const COMMAND_REQUIRED = 'Command is required for an ACP agent'
const REFUSED_YOLO = 'ZumiBot does not run an agent with --yolo, which lets it act without asking. Remove it in Agent Studio.'
const UNTRUSTED_TEXT = "This agent's command changed outside Agent Studio. Open it in Agent Studio and save to confirm."
const CRASH_TEXT = 'The agent stopped unexpectedly (exit 3).'
const RESEND_REFUSED = 'Edit, Resend and switching versions are not available for ACP agents.'
const FORK_REFUSED = 'Fork is not available for ACP agents.'
const BRIEFING_LINE = `You are @${C}, one of the members of a group chat with the user.`
// Exactly what the runner advertises (acpRunner.ts ACP_CLIENT_CAPABILITIES).
const CLIENT_CAPS = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
  auth: { terminal: false },
  elicitation: { form: {} },
  session: {}
}

let h = null
const made = [] // every mkdtemp dir made here
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
    await sleep(100)
  }
  throw new Error(`ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}`)
}

async function stop() {
  if (!h) return
  const cur = h
  h = null
  await Promise.race([cur.stop().catch(() => {}), sleep(30_000)])
  killOwnedChild(cur.server)
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
const rpcError = (page, method, ...args) =>
  rpc(page, method, ...args).then(
    () => null,
    (e) => (e instanceof Error ? e.message : String(e))
  )

const storedChats = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats
const metaOf = async (id) => (await storedChats()).find((c) => c.id === id)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])
const jsonLines = async (file) =>
  (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))

// ---------- the fake ACP agent: its script, what it got, how it started ----------
const acpLog = () => jsonLines(h.acp.log)
const acpStarts = () => jsonLines(h.acp.start)
const acpPids = () => jsonLines(h.acp.pids)
const methodsOf = (log) => log.filter((l) => typeof l.method === 'string').map((l) => l.method)
/** The answer the client sent to the fake's request `id` (the fake numbers its requests from 0 in each process). */
const answerTo = (log, id) => log.find((l) => l.method === undefined && l.id === id && ('result' in l || 'error' in l))
let pidsFile = null // h.acp.pids, kept past stop() for the leftover check
/**
 * Whether `pid` still runs as one of this suite's fake ACP processes: its env names this run's pids file, so a pid the system
 * gave to another process since is never taken for ours (nor killed).
 */
const alive = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`FAKE_ACP_PIDS=${pidsFile}`)
  } catch {
    return false
  }
}
// An agent that resumes its sessions and takes the instructions as a system prompt; its sessions are known for resume.
const BASE = {
  sessionId: 'acp-s1',
  sessions: ['acp-s1'],
  initialize: { agentCapabilities: { sessionCapabilities: { resume: {}, systemPrompt: {} } } }
}
const acpScript = (steps, extra = {}) => writeFile(h.acp.script, JSON.stringify({ ...BASE, ...extra, steps }))
const execCall = (id, command) => ({ toolCallId: id, title: command, kind: 'execute', rawInput: { command } })
/** A shell call announced, then asked about; the stream then reports how it ended. */
const shell = (id, command, status) => [
  { toolCall: { ...execCall(id, command), status: 'pending' } },
  { permission: { toolCall: execCall(id, command) } },
  {
    toolUpdate: {
      toolCallId: id,
      status,
      content: [{ type: 'content', content: { type: 'text', text: status === 'completed' ? `${command}: ok` : 'Rejected' } }]
    }
  }
]

// ---------- the fake claude's scripts: one file per agent ----------
let scripts = null
let invocationsFile = null
const SID_A = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d'
const SID_ROOM_A = '7c8d9e0f-1a2b-4c3d-8e4f-5a6b7c8d9e0f' // A's session in the room
const line = (o) => JSON.stringify(o)
const init = (sid) => line({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-haiku-5-5', permissionMode: 'default' })
const say = (sid, text) =>
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
    session_id: sid,
    uuid: randomUUID()
  })
const result = (sid, text) =>
  line({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: sid, uuid: randomUUID() })
const script = (agent, ...lines) => writeFile(join(scripts, `${agent}.jsonl`), lines.flat().join('\n') + '\n')

// ---------- UI helpers ----------
const composer = (page) => page.locator(tid('composer-input'))
const pending = (page) => page.locator(`${tid('approval-card')}[data-status="pending"]`)
const textOf = async (loc) => ((await loc.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()
const agentRow = (page, name) => page.locator(`${tid('agent-row')}[data-agent-name="${name}"]`)
const frontmatter = (raw) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? ''

async function pickFolder(page, dir) {
  await page.click(tid('new-chat-folder'))
  await page.click(tid('new-chat-choose-folder'))
  await waitFor(async () => (await page.locator(tid('new-chat-folder')).getAttribute('data-tip')) === dir, T, 'the folder to be set')
}

/** The open chat's id from the address bar, once it is a chat other than the given ones. */
async function openedChat(page, not = []) {
  let id = null
  await waitFor(
    async () => {
      const m = /\/chat\/([^/?#]+)$/.exec(new URL(page.url()).pathname)
      id = m ? decodeURIComponent(m[1]) : null
      return id !== null && !not.includes(id)
    },
    T,
    'a new chat to open'
  )
  return id
}

async function openChat(page, id) {
  await page.goto(`${h.origin}/chat/${encodeURIComponent(id)}`)
  await composer(page).waitFor({ timeout: T })
}

async function typeAndSend(page, text) {
  await composer(page).click()
  await page.keyboard.type(text)
  await page.click(tid('send-button'))
}

async function idle(ids, what) {
  await waitFor(
    async () => {
      for (const id of ids) {
        const m = await metaOf(id)
        if (!m || m.inFlight) return false
      }
      return true
    },
    T,
    what
  )
}

/** The reply is shown and every chat named is idle (ChatService clears inFlight only once the process has exited). */
async function waitReply(page, chatId, text, others = []) {
  await waitFor(async () => (await page.locator(tid('agent-message'), { hasText: text }).count()) > 0, T, `the reply "${text}"`)
  await idle([chatId, ...others], `the reply "${text}" to end`)
}

/** Opens Agent Studio on an existing agent from its sidebar row. */
async function editAgent(page, name) {
  await agentRow(page, name).hover()
  await page
    .locator(`.agent-block:has(${tid('agent-row')}[data-agent-name="${name}"]) ${tid('agent-menu-button')}`)
    .first()
    .click()
  await page.locator(tid('agent-menu-edit')).click()
  await page.locator(tid('agent-engine')).waitFor({ timeout: T })
}

/** The action buttons a hovered message shows (by data-testid), once its action row is there. */
async function actionsOf(msg, row) {
  await msg.hover()
  await msg.locator(tid(row)).waitFor({ timeout: T })
  await msg.locator(`${tid(row)} ${tid('copy-button')}`).waitFor({ timeout: T })
  return msg.locator(`${tid(row)} button[data-testid]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')))
}

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  scripts = await mk('scripts')
  const logs = await mk('logs')
  invocationsFile = join(logs, 'invocations.jsonl')
  await writeFile(
    join(agentsDir, `${A}.md`),
    `---\nname: ${A}\ndescription: Checks the repo with the user.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  h = await start({
    fake: FAKE,
    fakeAcp: true,
    dataDir,
    agentsDir,
    env: { ZUMIBOT_TEST_PICK_FOLDER: folder, FAKE_STDOUT_DIR: scripts, FAKE_INVOCATIONS_OUT: invocationsFile }
  })
  pidsFile = h.acp.pids
  const page = h.page
  const cFile = join(agentsDir, `${C}.md`)
  const trustFile = join(h.dataDir, 'protocol-launch.json')

  // 1. Agent Studio: a new agent on the ACP engine. Its card shows at once; Save is refused without a command and with a
  // refused argument (nothing written); with the shim as Command and three argument lines it saves provider: acp and its launch,
  // which the Save itself confirms on this machine. Test then runs the saved launch's `initialize` only.
  await page.locator(tid('new-agent')).waitFor({ timeout: 30_000 })
  await page.click(tid('new-agent'))
  await page.click(tid('new-menu-agent'))
  await page.locator('#agent-name').fill(C)
  await page.locator('#agent-description').fill('Runs over ACP for the e2e.')
  // The Engine dropdown (a SearchSelect): its options show while its menu is open.
  await page.locator(tid('agent-engine')).click()
  const acpOption = page.locator(`.search-select-menu ${tid('select-option')}[data-value="acp"]`)
  assert(
    (await textOf(acpOption)) === 'ACP agent' && !(await acpOption.isDisabled()),
    `the Engine select offers ${JSON.stringify(await textOf(acpOption))}`
  )
  await acpOption.click()
  await page.locator(tid('acp-card')).waitFor({ timeout: T })
  await page.locator('#agent-prompt').fill(C_BODY)
  const saveButton = page.getByRole('button', { name: 'Save changes', exact: true })
  await saveButton.click()
  await waitFor(async () => (await textOf(page.locator(tid('acp-error')))) === COMMAND_REQUIRED, T, 'the command error')
  await page.locator(tid('acp-command')).fill(h.acp.bin)
  await page.locator(tid('acp-args')).fill('--yolo')
  await waitFor(async () => (await textOf(page.locator(tid('acp-error')))) === REFUSED_YOLO, T, 'the refused argument error')
  await saveButton.click()
  await sleep(500)
  assert(!existsSync(cFile), 'Save wrote an agent with --yolo')
  await page.locator(tid('acp-args')).fill(ARGS.join('\n'))
  await waitFor(async () => (await page.locator(tid('acp-error')).count()) === 0, T, 'the launch error to clear')
  await saveButton.click()
  await waitFor(async () => existsSync(cFile), T, `${cFile} to be written`)
  const fm1 = frontmatter(await readFile(cFile, 'utf8'))
  assert(
    /^provider: acp$/m.test(fm1) && fm1.includes(h.acp.bin) && ARGS.every((a) => fm1.includes(a)) && !/^model:/m.test(fm1),
    `the agent file's frontmatter is ${JSON.stringify(fm1)}`
  )
  await waitFor(async () => existsSync(trustFile), T, 'the launch to be confirmed')
  const trusted1 = JSON.parse(await readFile(trustFile, 'utf8'))
  const entry1 = trusted1.agents?.[C]
  assert(
    entry1?.provider === 'acp' && entry1.command === h.acp.bin && same(entry1.args, ARGS),
    `protocol-launch.json holds ${JSON.stringify(trusted1)}`
  )
  await agentRow(page, C).waitFor({ timeout: T })
  assert(
    (await textOf(agentRow(page, C).locator(tid('agent-engine-tag')))) === 'ACP',
    `C's row tag reads ${JSON.stringify(await textOf(agentRow(page, C).locator(tid('agent-engine-tag'))))}`
  )
  const startsBeforeTest = (await acpStarts()).length
  const logBeforeTest = (await acpLog()).length
  await waitFor(async () => !(await page.locator(tid('acp-test')).isDisabled()), T, 'Test to be on for the saved agent')
  await page.locator(tid('acp-test')).click()
  const testResult = page.locator(tid('acp-test-result'))
  await testResult.waitFor({ timeout: 30_000 })
  const testText = await textOf(testResult)
  // The script is still the harness's empty one: the fake's defaults (no resume, no load, no systemPrompt).
  assert(
    testText.includes('Fake ACP 0.0.1') &&
      testText.includes('ACP v1') &&
      testText.includes('Each turn starts a new session') &&
      testText.includes('Sent in the first message'),
    `the Test result reads ${JSON.stringify(testText)}`
  )
  const probe = (await acpStarts()).slice(startsBeforeTest)
  assert(
    probe.length === 1 && same(probe[0].argv, ARGS) && probe[0].cwd !== folder && !probe[0].envKeys.some((k) => k.startsWith('ZUMIBOT_')),
    `the Test started ${JSON.stringify(probe.map((p) => ({ argv: p.argv, cwd: p.cwd })))}`
  )
  assert(
    same(methodsOf((await acpLog()).slice(logBeforeTest)), ['initialize']),
    `the Test sent ${JSON.stringify(methodsOf((await acpLog()).slice(logBeforeTest)))}`
  )
  ok(
    '1 Agent Studio: Engine "ACP agent" shows its card; Save is refused without a command and with --yolo; the shim and three arguments save provider: acp, confirmed in protocol-launch.json; the row reads ACP; Test sends initialize only, in another folder'
  )

  // 2. a chat: the reply streams over a new session; the agent got the run's capabilities, the body as its system prompt, no
  // ZUMIBOT_* name, and the saved arguments in the chat's folder
  await acpScript([{ text: 'Hello ' }, { sleep: 400 }, { text: 'from ACP' }, { usage: { used: 1200, size: 200000 } }])
  await agentRow(page, C).click()
  await pickFolder(page, folder)
  await page.evaluate(() => {
    window.__sawStreaming = false
    new MutationObserver(() => {
      if (document.querySelector('[data-streaming]')) window.__sawStreaming = true
    }).observe(document.body, { subtree: true, childList: true, attributes: true })
  })
  let mark = (await acpLog()).length
  let startsAt = (await acpStarts()).length
  await typeAndSend(page, 'Hello ACP')
  const cId = await openedChat(page)
  await waitReply(page, cId, 'Hello from ACP')
  assert(await page.evaluate(() => window.__sawStreaming), 'no [data-streaming] element was seen while the reply streamed')
  const log2 = (await acpLog()).slice(mark)
  assert(same(methodsOf(log2), ['initialize', 'session/new', 'session/prompt']), `the first turn sent ${JSON.stringify(methodsOf(log2))}`)
  const init2 = log2[0].params
  assert(
    init2.protocolVersion === 1 && same(init2.clientCapabilities, CLIENT_CAPS) && init2.clientInfo?.name === 'zumibot',
    `initialize was ${JSON.stringify(init2)}`
  )
  const new2 = log2.find((l) => l.method === 'session/new').params
  const system2 = new2.systemPrompt?.content?.[0]?.text ?? ''
  assert(
    new2.cwd === folder &&
      same(new2.mcpServers, []) &&
      new2.systemPrompt?.mode === 'append' &&
      system2.startsWith(C_BODY) &&
      !system2.includes('zumibot_todos'),
    `session/new was ${JSON.stringify(new2)}`
  )
  const prompt2 = log2.find((l) => l.method === 'session/prompt').params
  assert(
    prompt2.sessionId === 'acp-s1' && prompt2.prompt?.[0]?.text?.includes('Hello ACP') && !JSON.stringify(prompt2).includes(C_BODY),
    `session/prompt was ${JSON.stringify(prompt2)}`
  )
  const start2 = (await acpStarts()).slice(startsAt)
  assert(
    start2.length === 1 &&
      same(start2[0].argv, ARGS) &&
      start2[0].cwd === folder &&
      !start2[0].envKeys.some((k) => k.startsWith('ZUMIBOT_')),
    `the turn started ${JSON.stringify(start2.map((s) => ({ argv: s.argv, cwd: s.cwd, zumibot: s.envKeys.filter((k) => k.startsWith('ZUMIBOT_')) })))}`
  )
  const meta2 = await metaOf(cId)
  assert(
    meta2.sessionEngine === 'acp' && meta2.sessionId === 'acp-s1',
    `the chat's session is ${JSON.stringify({ sessionId: meta2.sessionId, sessionEngine: meta2.sessionEngine })}`
  )
  ok(
    '2 a chat: "Hello from ACP" streams over initialize (the run\'s exact capabilities), session/new (the body as systemPrompt, no bridges) and session/prompt; the agent ran with the saved arguments in the chat folder and no ZUMIBOT_* name; the session is stored as acp'
  )

  // 3. a card allowed once and a card denied, in one turn that resumes the session: the agent gets allow-once, then reject-once
  mark = (await acpLog()).length
  await acpScript([
    ...shell('call-ls', 'ls -la', 'completed'),
    ...shell('call-rm', 'rm -rf build', 'failed'),
    { text: 'Two files; I left build alone' }
  ])
  await typeAndSend(page, 'List the files, then clean the build')
  await pending(page).first().waitFor({ timeout: T })
  assert(
    (await pending(page).count()) === 1 && (await textOf(pending(page).first())).includes('ls -la'),
    `the first card reads ${JSON.stringify(await textOf(pending(page).first()))}`
  )
  await pending(page).first().locator(tid('approval-allow-once')).click()
  await waitFor(async () => (await textOf(pending(page).first())).includes('rm -rf build'), T, 'the second card')
  await pending(page).first().locator(tid('approval-deny')).click()
  await waitReply(page, cId, 'Two files; I left build alone')
  const log3 = (await acpLog()).slice(mark)
  assert(
    same(methodsOf(log3), ['initialize', 'session/resume', 'session/prompt']) &&
      log3.find((l) => l.method === 'session/resume').params.sessionId === 'acp-s1',
    `the second turn sent ${JSON.stringify(methodsOf(log3))}`
  )
  assert(
    same(answerTo(log3, 0)?.result, { outcome: { outcome: 'selected', optionId: 'allow-once' } }) &&
      same(answerTo(log3, 1)?.result, { outcome: { outcome: 'selected', optionId: 'reject-once' } }),
    `the agent's requests were answered ${JSON.stringify([answerTo(log3, 0), answerTo(log3, 1)])}`
  )
  const appr3 = (await itemsOf(cId)).filter((i) => i.type === 'approval')
  assert(
    same(
      appr3.map((a) => [a.toolName, a.input?.command, a.status]),
      [
        ['Bash', 'ls -la', 'allowed-once'],
        ['Bash', 'rm -rf build', 'denied']
      ]
    ),
    `the stored approvals are ${JSON.stringify(appr3.map((a) => [a.toolName, a.input?.command, a.status]))}`
  )
  ok(
    '3 a turn on the resumed session: a Bash card (ls -la) allowed once gives the agent allow-once, a second (rm -rf build) denied gives reject-once'
  )

  // 4. a question: the agent's elicitation form shows a question card; Blue answered on the page reaches it as accept {color}
  mark = (await acpLog()).length
  await acpScript([
    {
      elicitation: {
        message: 'Pick a color',
        requestedSchema: {
          type: 'object',
          properties: { color: { type: 'string', title: 'Which color do you pick?', enum: ['Red', 'Blue'] } },
          required: ['color']
        }
      }
    },
    { text: 'You picked blue' }
  ])
  await typeAndSend(page, 'Ask me a color')
  const qCard = page.locator(`${tid('question-card')}[data-status="pending"]`).first()
  await qCard.waitFor({ timeout: T })
  assert((await textOf(qCard)).includes('Which color do you pick?'), `the question card reads ${JSON.stringify(await textOf(qCard))}`)
  await qCard.locator(`${tid('question-option')}[data-label="Blue"] input`).click()
  await qCard.locator(tid('question-send')).click()
  await waitReply(page, cId, 'You picked blue')
  const log4 = (await acpLog()).slice(mark)
  assert(
    same(answerTo(log4, 0)?.result, { action: 'accept', content: { color: 'Blue' } }),
    `the elicitation was answered ${JSON.stringify(answerTo(log4, 0))}`
  )
  const q4 = (await itemsOf(cId)).filter((i) => i.type === 'approval').at(-1)
  assert(
    q4?.toolName === 'AskUserQuestion' && q4.status === 'answered',
    `the stored question is ${JSON.stringify(q4 && { toolName: q4.toolName, status: q4.status })}`
  )
  ok('4 an elicitation form shows a question card; Blue answered on the page reaches the agent as {action: accept, content: {color: Blue}}')

  // 5. no Edit, Resend or Fork: an ACP chat's user and agent messages offer neither, there is no version switcher, the "i"
  // names them, and the handlers refuse them; a Claude chat's do (so the check is not vacuous)
  const userMsg5 = page.locator(tid('user-message')).filter({ hasText: 'Ask me a color' }).last()
  const userActs = await actionsOf(userMsg5, 'user-message-actions')
  const agentMsg5 = page.locator(tid('agent-message')).filter({ hasText: 'You picked blue' }).last()
  const agentActs = await actionsOf(agentMsg5, 'message-actions')
  for (const b of ['edit-button', 'resend-button', 'fork-button'])
    assert(!userActs.includes(b) && !agentActs.includes(b), `the ACP chat offers ${b}: ${JSON.stringify({ userActs, agentActs })}`)
  assert((await page.locator(tid('version-switcher')).count()) === 0, 'the ACP chat shows a version switcher')
  const info5 = (await page.locator(tid('engine-info')).getAttribute('data-tip')) ?? ''
  assert(info5.startsWith("ACP agents can't use: Edit and Resend, Fork"), `the engine info reads ${JSON.stringify(info5)}`)
  const userItem5 = (await itemsOf(cId)).findLast((i) => i.type === 'user')
  const resendErr = await rpcError(page, 'chats:resend', cId, userItem5.id)
  const forkErr = await rpcError(page, 'chats:fork', cId, userItem5.id)
  assert(
    resendErr?.includes(RESEND_REFUSED) && forkErr?.includes(FORK_REFUSED),
    `the handlers answered ${JSON.stringify({ resendErr, forkErr })}`
  )
  await script(A, init(SID_A), say(SID_A, 'Claude says hi'), result(SID_A, 'Claude says hi'))
  await agentRow(page, A).click()
  await pickFolder(page, folder)
  await typeAndSend(page, 'Hello Claude')
  const aId = await openedChat(page, [cId])
  await waitReply(page, aId, 'Claude says hi')
  const claudeActs = await actionsOf(page.locator(tid('user-message')).filter({ hasText: 'Hello Claude' }).last(), 'user-message-actions')
  assert(
    ['edit-button', 'resend-button', 'fork-button'].every((b) => claudeActs.includes(b)),
    `the Claude chat's user message offers ${JSON.stringify(claudeActs)}`
  )
  ok(
    `5 the ACP chat's messages offer ${JSON.stringify(userActs)} / ${JSON.stringify(agentActs)}: no Edit, Resend, Fork or version switcher; the "i" names them; chats:resend and chats:fork are refused; a Claude chat offers all three`
  )

  // 6. Stop with a card open: the card is answered cancelled, session/cancel is sent, the chat ends with the stopped notice, and
  // neither the agent nor any child it left is still running: one in its process group, one in a session of its own, and one
  // below a child in its group (as claude-agent-acp's CLI runs a Bash shell in a session of its own)
  await openChat(page, cId)
  mark = (await acpLog()).length
  const pidsAt = (await acpPids()).length
  await acpScript([
    { text: 'Starting the long job' },
    { hold: true },
    { hold: 'session' },
    { hold: 'nested' },
    ...shell('call-sleep', 'sleep 100', 'completed').slice(0, 2),
    { text: 'Never finished' }
  ])
  await typeAndSend(page, 'Run the long job')
  await pending(page).first().waitFor({ timeout: T })
  const pids6 = (await acpPids()).slice(pidsAt)
  assert(
    ['agent', 'hold', 'session', 'middle', 'nested'].every((r) => pids6.some((p) => p.role === r)) && pids6.every((p) => alive(p.pid)),
    `the turn's processes are ${JSON.stringify(pids6)}`
  )
  const stopButton = page.locator(tid('send-button'))
  await waitFor(async () => (await stopButton.getAttribute('data-tip')) === 'Stop', T, 'the Stop button')
  await stopButton.click()
  await idle([cId], 'the ACP chat to stop')
  const items6 = await itemsOf(cId)
  assert(items6.at(-1)?.type === 'notice' && items6.at(-1).kind === 'stopped', `the chat ends with ${JSON.stringify(items6.at(-1))}`)
  const card6 = items6.filter((i) => i.type === 'approval').at(-1)
  assert(
    card6?.input?.command === 'sleep 100' && card6.status !== 'pending',
    `the open card is stored as ${JSON.stringify(card6 && { command: card6.input?.command, status: card6.status })}`
  )
  assert((await pending(page).count()) === 0, 'a card is still pending after Stop')
  const log6 = (await acpLog()).slice(mark)
  assert(
    log6.some((l) => l.method === 'session/cancel' && l.params?.sessionId === 'acp-s1') &&
      same(answerTo(log6, 0)?.result, { outcome: { outcome: 'cancelled' } }),
    `after Stop the agent got ${JSON.stringify(log6.filter((l) => l.method !== 'session/update'))}`
  )
  assert((await page.locator(tid('agent-message'), { hasText: 'Never finished' }).count()) === 0, 'the turn went on after Stop')
  await waitFor(async () => pids6.every((p) => !alive(p.pid)), T, 'the agent and its children to end')
  ok(
    `6 Stop with a card open: session/cancel, the card answered cancelled, the stopped notice; the agent and its tree, in its group or not (${pids6.length} processes), are gone`
  )

  // 7. a crash mid-turn: the error item names the exit code with the agent's stderr tail; the next turn runs again
  startsAt = (await acpStarts()).length
  const pidsAt7 = (await acpPids()).length
  await acpScript([{ text: 'Half an answer' }, { stderr: 'fake agent: something broke\n' }, { crash: 3 }])
  await typeAndSend(page, 'Do the risky thing')
  await waitFor(
    async () => (await page.locator(tid('error-bubble'), { hasText: CRASH_TEXT }).count()) > 0,
    T,
    'the crash error on the page'
  )
  await idle([cId], 'the crashed turn to end')
  const err7 = (await itemsOf(cId)).filter((i) => i.type === 'error').at(-1)
  assert(
    err7?.text?.startsWith(CRASH_TEXT) && err7.text.includes('fake agent: something broke'),
    `the crash error is ${JSON.stringify(err7)}`
  )
  await waitFor(async () => (await acpPids()).slice(pidsAt7).every((p) => !alive(p.pid)), T, 'the crashed agent to be gone')
  ok(
    '7 a crash (exit 3 after a chunk) ends the turn with "The agent stopped unexpectedly (exit 3)." and the stderr tail; nothing is left running'
  )

  // 8. a reseed after a failed load: the agent loads sessions (no resume) but knows none, so session/load fails; the turn starts
  // a new session in a new process, seeded from the visible chat, with the expired notice
  mark = (await acpLog()).length
  startsAt = (await acpStarts()).length
  await acpScript([{ text: 'Fresh session here' }], {
    sessionId: 'acp-s2',
    sessions: [],
    initialize: { agentCapabilities: { loadSession: true, sessionCapabilities: { systemPrompt: {} } } }
  })
  await typeAndSend(page, 'Are you still there?')
  await waitReply(page, cId, 'Fresh session here')
  const log8 = (await acpLog()).slice(mark)
  assert(
    same(methodsOf(log8), ['initialize', 'session/load', 'initialize', 'session/new', 'session/prompt']) &&
      log8.find((l) => l.method === 'session/load').params.sessionId === 'acp-s1',
    `the reseeded turn sent ${JSON.stringify(methodsOf(log8))}`
  )
  assert((await acpStarts()).length === startsAt + 2, 'the reseed did not start a new process')
  const seed8 = JSON.stringify(log8.find((l) => l.method === 'session/prompt').params.prompt)
  assert(seed8.includes('Hello ACP') && seed8.includes('Are you still there?'), `the reseed prompt is ${seed8.slice(0, 400)}`)
  const items8 = await itemsOf(cId)
  const userAt8 = items8.findLastIndex((i) => i.type === 'user')
  assert(
    items8.slice(userAt8).some((i) => i.type === 'notice' && i.kind === 'expired'),
    `no expired notice after the last message: ${JSON.stringify(items8.slice(userAt8).map((i) => i.kind ?? i.type))}`
  )
  assert((await metaOf(cId)).sessionId === 'acp-s2', `the chat's session is ${(await metaOf(cId)).sessionId}`)
  ok(
    '8 a failed session/load (-32002) reseeds once: a new process, session/new, the prompt seeded with the visible chat, the expired notice, session acp-s2'
  )

  // 9. a refused launch after an outside edit: the agent file's arguments change on disk, so the send is refused with the fixed
  // sentence and no agent starts; Agent Studio shows the confirmed launch beside the file's, and Save (no edit) confirms it
  const raw9 = await readFile(cFile, 'utf8')
  assert(raw9.includes('fake-profile'), 'the agent file lacks its argument')
  await writeFile(cFile, raw9.replace('fake-profile', 'swapped-profile'))
  startsAt = (await acpStarts()).length
  await acpScript([{ text: 'Should not run' }], { sessionId: 'acp-s2', sessions: ['acp-s2'] })
  await typeAndSend(page, 'Run with the new launch')
  await waitFor(
    async () => (await page.locator(tid('error-bubble'), { hasText: UNTRUSTED_TEXT }).count()) > 0,
    T,
    'the refused launch on the page'
  )
  await idle([cId], 'the refused turn to end')
  assert((await acpStarts()).length === startsAt, 'an agent started for a launch changed outside Agent Studio')
  assert((await itemsOf(cId)).filter((i) => i.type === 'error').at(-1)?.text === UNTRUSTED_TEXT, 'the refusal is not the stored error')
  await editAgent(page, C)
  const compare = page.locator(tid('acp-compare'))
  await compare.waitFor({ timeout: T })
  const compareText = await textOf(compare)
  assert(
    compareText.includes('fake-profile') && compareText.includes('swapped-profile'),
    `the compare box reads ${JSON.stringify(compareText)}`
  )
  await waitFor(async () => saveButton.isEnabled(), T, 'Save to be on with no edit')
  await saveButton.click()
  await waitFor(
    async () => {
      const t = JSON.parse(await readFile(trustFile, 'utf8'))
      return same(t.agents?.[C]?.args, ['--acp', '--profile', 'swapped-profile'])
    },
    T,
    'the new launch to be confirmed'
  )
  await compare.waitFor({ state: 'detached', timeout: T })
  await openChat(page, cId)
  startsAt = (await acpStarts()).length
  await acpScript([{ text: 'Running the confirmed launch' }], { sessionId: 'acp-s2', sessions: ['acp-s2'] })
  await typeAndSend(page, 'Try again')
  await waitReply(page, cId, 'Running the confirmed launch')
  const start9 = (await acpStarts()).slice(startsAt)
  assert(
    start9.length === 1 && same(start9[0].argv, ['--acp', '--profile', 'swapped-profile']),
    `the confirmed turn started ${JSON.stringify(start9.map((s) => s.argv))}`
  )
  ok(
    '9 an outside edit of the arguments refuses the send ("…changed outside Agent Studio…", no agent started); Agent Studio shows both launches, Save confirms the new one, and the next send runs it'
  )

  // 10. a room with an ACP member: the members picker offers it; both members answer their mentions; the ACP member's session
  // has its body and the room briefing as its system prompt and is stored as acp; the moderator is a claude call; the room
  // offers no Edit, Resend or Fork
  await script(A, init(SID_ROOM_A), say(SID_ROOM_A, 'Claude member here'), result(SID_ROOM_A, 'Claude member here'))
  await acpScript([{ text: 'ACP member here' }], { sessionId: 'acp-room-1', sessions: ['acp-room-1'] })
  mark = (await acpLog()).length
  startsAt = (await acpStarts()).length
  const invAt = (await jsonLines(invocationsFile)).length
  await page.click(tid('new-agent'))
  await page.click(tid('new-menu-group'))
  await page.locator(tid('new-chat-members')).click()
  const memberOption = (n) => page.locator(`${tid('new-chat-member-option')}[data-agent-name="${n}"]`)
  await memberOption(C).waitFor({ timeout: T })
  assert(
    (await memberOption(C).getAttribute('aria-disabled')) === 'false',
    `the ACP agent's member option is ${JSON.stringify(await textOf(memberOption(C)))}`
  )
  await memberOption(A).click()
  await memberOption(C).click()
  await page.keyboard.press('Escape')
  await pickFolder(page, folder)
  await composer(page).fill(`@${A} @${C} please say hello`)
  await page.click(tid('send-button'))
  const roomId = await openedChat(page, [cId, aId])
  await waitFor(
    async () => {
      const said = (await itemsOf(roomId)).filter((i) => i.type === 'assistant').map((i) => i.text)
      return said.includes('ACP member here') && said.includes('Claude member here') && !(await metaOf(roomId))?.inFlight
    },
    T,
    'both members to answer'
  )
  const room = (await metaOf(roomId)).group
  assert(
    same(room.sessionEngines, { [C]: 'acp' }) && room.sessions[C] === 'acp-room-1' && room.sessions[A] === SID_ROOM_A,
    `the room's sessions are ${JSON.stringify({ sessions: room.sessions, sessionEngines: room.sessionEngines })}`
  )
  const log10 = (await acpLog()).slice(mark)
  const roomSystem = log10.find((l) => l.method === 'session/new')?.params.systemPrompt?.content?.[0]?.text ?? ''
  assert(
    roomSystem.startsWith(C_BODY) && roomSystem.includes(BRIEFING_LINE),
    `the ACP member's system prompt is ${JSON.stringify(roomSystem.slice(0, 300))}`
  )
  const start10 = (await acpStarts()).slice(startsAt)
  assert(
    start10.length === 1 && start10[0].cwd === folder,
    `the room's ACP processes were ${JSON.stringify(start10.map((s) => ({ argv: s.argv, cwd: s.cwd })))}`
  )
  const moderated = (await jsonLines(invocationsFile)).slice(invAt).filter((l) => l.kind === 'moderator')
  assert(
    moderated.length >= 1 && moderated.every((l) => l.args.includes('--json-schema')),
    `the moderator calls were ${JSON.stringify(moderated.map((l) => l.args.slice(0, 4)))}`
  )
  const roomActs = await actionsOf(page.locator(tid('user-message')).filter({ hasText: 'please say hello' }).last(), 'user-message-actions')
  assert(
    !roomActs.includes('edit-button') && !roomActs.includes('resend-button') && !roomActs.includes('fork-button'),
    `the room's user message offers ${JSON.stringify(roomActs)}`
  )
  const roomInfo = (await page.locator(tid('engine-info')).first().getAttribute('data-tip')) ?? ''
  assert(roomInfo.startsWith("This room can't use: Edit and Resend, Fork"), `the room's engine info reads ${JSON.stringify(roomInfo)}`)
  ok(
    `10 a room of ${A} (Claude) and ${C} (ACP): both answer; the ACP member's system prompt has its body and the briefing, its session acp-room-1 is stored as acp; ${moderated.length} moderator call(s) on claude; no Edit, Resend or Fork in the room`
  )

  // Every process the fake ACP agent logged has ended by now (each turn ends its process group).
  const left = (await acpPids()).filter((p) => alive(p.pid))
  assert(left.length === 0, `fake ACP processes still running: ${JSON.stringify(left)}`)
  assert(h.errors.length === 0, `unexpected errors: ${h.errors.join(' | ')}`)
  ok(`no fake ACP process left of ${(await acpPids()).length} logged; no console or server errors`)
}

const timer = setTimeout(() => {
  console.error('FAIL overall timeout')
  void stop().finally(() => process.exit(1))
}, OVERALL_TIMEOUT)
timer.unref()

let failed = false
// The pids file lives in the harness's temp root, which stop() removes: read it first.
let logged = []
try {
  await main()
} catch (err) {
  failed = true
  console.error(`FAIL ${err instanceof Error ? err.message : err}`)
} finally {
  logged = pidsFile ? await jsonLines(pidsFile).catch(() => []) : []
  await stop()
  // The server stops every run it started: anything the fake ACP agent logged that still runs after that is a leak.
  const left = logged.filter((p) => alive(p.pid))
  for (const p of left) {
    try {
      process.kill(p.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  if (left.length) {
    failed = true
    console.error(`FAIL ${left.length} fake ACP process(es) outlived the server: ${JSON.stringify(left)}`)
  }
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
console.log(failed ? 'e2e:acp FAILED' : 'e2e:acp passed')
process.exit(failed ? 1 : 0)
