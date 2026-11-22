// End-to-end check of Codex agents in the built server + web UI (local mode) against the FAKE Codex app-server
// (backend/tests/fixtures/fake-codex.mjs, found through ZUMIBOT_CODEX_BIN) and the FAKE claude
// (backend/tests/fixtures/fake-claude.mjs): no real CLI call is ever made, so no login or quota is used.
// Usage: npm run e2e:codex (builds first)
//
// The fake Codex reads one script (the harness's h.codex.script, rewritten before each turn: notifications, server requests
// that wait for the answer, sleeps, real MCP calls, shell calls behind the PreToolUse hooks, subagents), logs every request it
// got (h.codex.log), every answer to its own requests (h.codex.answers), each hooked call and whether a hook blocked it
// (FAKE_CODEX_HOOKS_OUT) and each process and held command (FAKE_CODEX_PIDS). Request ids start at 0 in every process, one
// process per attempt, as the real one's do. It runs the `-c hooks.PreToolUse` hooks the server passes through `sh -c` (the
// real vault guard and the built dist/pauseHook.mjs) only once `-c hooks.state` trusts them by the hash its hooks/list gave,
// as real codex does (probe check 11).
// The harness's `fakeCodex` is a wrapper that first logs each Codex process's argv, folder and env names (never values), and
// sets FAKE_CODEX_HOOKS_LIST from a file while it exists (`empty`: codex lists no hooks, so none is ever trusted), then runs
// the fake. FAKE_CODEX_COMPACT_MS holds a compaction open long enough to see "Compacting…".
// The fake claude is fake-clone-claude.mjs: a room's moderator call (--json-schema) answers `{}` (routing falls back to the
// @mentions) and is logged with kind `moderator`; every other call is fake-claude.mjs. The Claude agent's turns read
// <FAKE_STDOUT_DIR>/<agent>.jsonl; what each fake claude was answered and started with is read from FAKE_RESPONSES_FILE and
// FAKE_INVOCATIONS_OUT.
//
// Hard rules enforced here:
//  - nothing in ~/.claude or ~/.codex is touched: the harness gives the server a throwaway HOME, agents dir, data dir and vault
//    key folder;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`, and so is every process the fake Codex logged (app-servers
//    and held commands); overall timeout 8 min.
//
// DOM hooks relied on (data-testid): new-agent, new-menu-agent, new-menu-group, new-chat-members, new-chat-member-option
//   (+ data-agent-name, aria-disabled), agent-engine, codex-models, codex-vault-note, agent-row (+ data-agent-name),
//   agent-engine-tag, agent-menu-button, agent-menu-edit, new-chat-folder, new-chat-choose-folder, composer-input,
//   send-button (title Stop while running), pause-button, resume-button, agent-message, user-message, approval-card
//   (+ data-status), approval-allow-once, approval-allow-chat, approval-deny, side-panel-toggle, side-menu, side-open-todos,
//   side-open-sides, side-open-files, side-open-desktop, side-open-dispatch, dispatch-panel, dispatch-row (+ data-id,
//   data-status), dispatch-detail (+ data-id), dispatch-report, todos-panel, todo-text, command-menu, command-option
//   (+ data-command-name), side-entry (+ data-side-id, data-state), files-panel, files-close, file-row (+ data-path), file-rows
//   (> [data-row] + data-kind), question-card (+ data-status), question-option (+ data-label), question-send, context-chip
//   (+ data-percent, title), context-popup, context-note, context-compact, sidebar-user (aria-label), usage-popover,
//   usage-codex, limit-notice (+ data-state), limit-cancel, ask-card (+ data-status), ask-open, edit-button, message-editor,
//   message-editor-input, message-editor-send. Agent Studio: #agent-name, #agent-description, #agent-prompt, button
//   "Save changes"; streaming shows as [data-streaming]; a running compaction as `.working` "Compacting…".
// Stored state read: <dataDir>/chats.json, <dataDir>/chats/<id>.json, <dataDir>/chats/<id>.btw.json,
//   <dataDir>/pause-flags/<hash>/paused, <agentsDir>/<agent>.md.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, pickOption } from './harness.mjs'
import { claimExpectedErrors, killOwnedChild } from './e2eChecks.mjs'

// Answers a room's moderator call with `{}`; every other call is fake-claude.mjs.
const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-clone-claude.mjs', import.meta.url))
const C = 'e2e-codex' // made in Agent Studio on the Codex engine
const A = 'e2e-claude-a' // a Claude agent that asks C
const PREFIX = 'zumibot-e2e-codex-'
const OVERALL_TIMEOUT = 8 * 60_000
const T = 15_000
const C_BODY = 'You are a Codex test agent. Keep replies short.'
// Verbatim from backend/src/core/asks/askPrompt.ts (askedSystem's first line).
const ASKED_LINE = `You are being asked by the agent @${A}`
// Verbatim from backend/src/core/chat/groupPrompts.ts (buildBriefing's first line, for C).
const BRIEFING_LINE = `You are @${C}, one of the members of a group chat with the user.`
// Verbatim from shared/src/pause.ts, backend/src/core/vault/vaultGuard.ts and frontend/src/state/agentEngine.ts.
const PAUSE_MARKER = '(zumibot-pause)'
const PAUSED_TEXT = 'Paused. Press Resume to continue.'
const VAULT_GUARD_TEXT =
  'ZumiBot keeps the vault private: agents may not read its files. Use vault_items and browser_fill_from_vault instead.'
// unguardedNoticeText with every guard on: the vault guard, a granted key and the pause hook (shared/src/engine.ts).
const UNGUARDED_TEXT =
  "Codex didn't confirm ZumiBot's hooks, so this reply runs without the vault guard or the agent's API keys, and Pause takes effect only when it ends."
const SIDE_DENY_TEXT = 'No tools in a side answer'
const CODEX_VAULT_NOTE =
  "Codex agents are kept off the vault's files as Claude agents are: a speed bump, not a wall. Agents run as the same user as this server, so a determined agent could still read the vault files. A reply whose guard can't start runs without it and without the agent's API keys, after a notice in the chat saying so."
// Warning indexes claimed only in the step that deliberately triggers them.
const expectedErrors = new Set()
const expectErrors = (start, pattern, count = 1) => {
  for (const i of claimExpectedErrors(h.errors, start, h.errors.length, pattern, count)) expectedErrors.add(i)
}
// How each Codex process starts (codexRunner.ts ARGS); then multi_agent, the question feature (always on) and the hooks.
const BASE_ARGV = ['app-server', '--listen', 'stdio://']
const QUESTION_FEATURE = ['--enable', 'default_mode_request_user_input']
// notes.txt before and after the fake's patch, and the hunk-only diff real codex sends for it (probe check 10).
const NOTES_BEFORE = 'line one\nline two\nline three\n'
const NOTES_AFTER = 'line one\nline TWO changed\nline three\n'
const NOTES_DIFF = '@@ -1,3 +1,3 @@\n line one\n-line two\n+line TWO changed\n line three\n'
const KEY_NAME = 'Codex deploy key'
const KEY_VALUE = 'cbx-e2e-7f3a9c1d5b2e'
const KEY_ENV = 'CB_E2E_KEY'
// A key under a name codex reads for itself: never in a Codex run's env, still scrubbed from its output.
const OWN_KEY_NAME = 'Codex own key'
const OWN_KEY_VALUE = 'cbx-e2e-own-4d2c8e6a1f9b'
const OWN_KEY_ENV = 'CODEX_E2E_KEY'

let h = null
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

const storedChats = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats
const metaOf = async (id) => (await storedChats()).find((c) => c.id === id)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])
// The chat's side questions; none until its first /btw is written.
const sidesOf = async (id) =>
  readFile(join(h.dataDir, 'chats', `${id}.btw.json`), 'utf8').then(
    (t) => JSON.parse(t).items,
    () => []
  )
const jsonLines = async (file) =>
  (await readFile(file, 'utf8').catch(() => ''))
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l))

// ---------- the fake Codex: its script, what it was asked and how its requests were answered ----------
const codexLog = () => jsonLines(h.codex.log)
const codexAnswers = () => jsonLines(h.codex.answers)
let hooksOut = null
let pidsFile = null
let listModeFile = null
/** Each hooked call ({id, tool, agentId, blocked}) the fake ran its trusted PreToolUse hooks for. */
const codexHooks = () => jsonLines(hooksOut)
/** Every app-server process ({pid, role: 'app-server'}) and held command ({pid, role: 'exec', id, threadId}) the fake started. */
const codexPids = () => jsonLines(pidsFile)
/**
 * Whether `pid` still runs as one of this suite's fake Codex processes: its env names this run's pids file, so a pid the system
 * gave to another process since is never taken for ours (nor killed).
 */
const alive = (pid) => {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(`FAKE_CODEX_PIDS=${pidsFile}`)
  } catch {
    return false
  }
}
/** The chat's pause flag, as ChatTmp names it: <data>/pause-flags/<first 16 hex of sha256(id)>/paused. */
const flagOf = (id) => join(h.dataDir, 'pause-flags', createHash('sha256').update(id).digest('hex').slice(0, 16), 'paused')
/** Codex lists no hooks while this is on, so none is ever trusted: the runs fall back to no hooks (and no keys). */
const hooksListed = async (on) => (on ? unlink(listModeFile).catch(() => {}) : writeFile(listModeFile, 'empty'))
/** The value of `-c <key>=…` in a Codex process's argv, or null. */
const configArg = (argv, key) => {
  for (let i = 0; i < argv.length - 1; i++)
    if (argv[i] === '-c' && argv[i + 1].startsWith(`${key}=`)) return argv[i + 1].slice(key.length + 1)
  return null
}
const codexScript = (...steps) =>
  writeFile(
    h.codex.script,
    steps
      .flat()
      .map((s) => JSON.stringify(s))
      .join('\n') + '\n'
  )
const note = (method, params) => ({ notify: { method, params: { threadId: '$THREAD', turnId: '$TURN', ...params } } })
const delta = (text) => note('item/agentMessage/delta', { itemId: 'msg-1', delta: text })
const message = (text) => note('item/completed', { item: { type: 'agentMessage', id: 'msg-1', text } })
const usage = (input, output) =>
  note('thread/tokenUsage/updated', {
    tokenUsage: {
      last: { inputTokens: input, cachedInputTokens: 0, outputTokens: output, totalTokens: input + output },
      total: { inputTokens: input, cachedInputTokens: 0, outputTokens: output, totalTokens: input + output },
      modelContextWindow: 258400
    }
  })
/** A reply in two deltas, then the whole message, as Codex streams it. */
const reply = (text) => [delta(text.slice(0, 6)), delta(text.slice(6)), message(text)]
let folder = null
const command = (id, cmd) => ({ type: 'commandExecution', id, command: cmd, cwd: folder })
/** A shell call that asks first (manual mode: `untrusted`), then ends as the answer would have it. */
const shell = (id, cmd, { declined = false } = {}) => [
  note('item/started', { item: { ...command(id, cmd), status: 'inProgress', aggregatedOutput: null, exitCode: null } }),
  {
    request: {
      method: 'item/commandExecution/requestApproval',
      params: { threadId: '$THREAD', turnId: '$TURN', itemId: id, command: cmd, cwd: folder, reason: null }
    }
  },
  note('item/completed', {
    item: {
      ...command(id, cmd),
      status: declined ? 'declined' : 'completed',
      aggregatedOutput: declined ? null : `${cmd}: ok\n`,
      exitCode: declined ? null : 0
    }
  })
]
/** A patch of one file that asks first (manual mode), then completes as applied: one fileChange item, as probe check 10 saw. */
const patch = (id, path, diff) => {
  const item = { type: 'fileChange', id, changes: [{ path, kind: { type: 'update', move_path: null }, diff }] }
  return [
    note('item/started', { item: { ...item, status: 'inProgress' } }),
    {
      request: {
        method: 'item/fileChange/requestApproval',
        params: { threadId: '$THREAD', turnId: '$TURN', itemId: id, reason: null, grantRoot: null }
      }
    },
    note('item/completed', { item: { ...item, status: 'completed' } })
  ]
}
/** The question probe check 15 recorded (needs the question feature flag): one choice with free text allowed. */
const askColor = (itemId) => ({
  request: {
    method: 'item/tool/requestUserInput',
    params: {
      threadId: '$THREAD',
      turnId: '$TURN',
      itemId,
      isBlocking: false,
      autoResolutionMs: null,
      questions: [
        {
          id: 'color',
          header: 'Color',
          question: 'Which color do you pick?',
          isOther: true,
          isSecret: false,
          options: [
            { label: 'Red', description: 'Pick red.' },
            { label: 'Blue', description: 'Pick blue.' }
          ]
        }
      ]
    }
  }
})

// ---------- the fake claude's scripts: one file per agent ----------
let scripts = null
let responsesFile = null
let invocationsFile = null
let procsFile = null
const SID_A = '5a6b7c8d-9e0f-4a1b-8c2d-3e4f5a6b7c8d'
const SID_C = '6b7c8d9e-0f1a-4b2c-9d3e-4f5a6b7c8d9e'
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
const askCall = (agent, msg, id) =>
  `#MCP_CALL ${line({ server: 'zumibot_agents', tool: 'ask', args: { agent, message: msg }, id, permission: `req-${id}` })}`
const script = (agent, ...lines) => writeFile(join(scripts, `${agent}.jsonl`), lines.flat().join('\n') + '\n')
const invocations = async () => (await jsonLines(invocationsFile)).map((l) => l.args)
const agentOf = (args) => args[args.indexOf('--agent') + 1]
const answered = async (requestId, behavior) =>
  (await jsonLines(responsesFile)).some((l) => l.response?.request_id === requestId && l.response?.response?.behavior === behavior)

// ---------- UI helpers ----------
const composer = (page) => page.locator(tid('composer-input'))
const pending = (page) => page.locator(`${tid('approval-card')}[data-status="pending"]`)
const textOf = async (loc) => ((await loc.textContent().catch(() => '')) ?? '').replace(/\s+/g, ' ').trim()

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

/** Watches the page for a pending approval card (`window.__cardSeen`) until `stopWatching`. */
const watchCards = (page) =>
  page.evaluate(() => {
    window.__cardSeen = false
    window.__cardObserver?.disconnect()
    window.__cardObserver = new MutationObserver(() => {
      if (document.querySelector('[data-testid="approval-card"][data-status="pending"]')) window.__cardSeen = true
    })
    window.__cardObserver.observe(document.body, { childList: true, subtree: true, attributes: true })
  })
const cardSeen = (page) => page.evaluate(() => (window.__cardObserver?.disconnect(), window.__cardSeen))

/** Opens the side panel's list (side-menu) from whatever the panel shows now. */
async function openSideMenu(page) {
  for (let i = 0; i < 4; i++) {
    if (
      await page
        .locator(tid('side-menu'))
        .isVisible()
        .catch(() => false)
    )
      return
    await page.click(tid('side-panel-toggle'))
    await sleep(150)
  }
  throw new Error('ASSERT FAILED: could not open the side panel list')
}

/** The `/` menu's command names, for the text typed so far ('/'), then the box is cleared. */
async function slashMenu(page) {
  await composer(page).click()
  await page.keyboard.type('/')
  const menu = page.locator(tid('command-menu'))
  await menu.waitFor({ timeout: T })
  const names = await menu.locator(tid('command-option')).evaluateAll((els) => els.map((e) => e.getAttribute('data-command-name')))
  await page.keyboard.press('Escape')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Backspace')
  return names
}

const agentRow = (page, name) => page.locator(`${tid('agent-row')}[data-agent-name="${name}"]`)
const agentFile = (name, description) => `---\nname: ${name}\ndescription: ${description}\nmodel: haiku\n---\nYou are a test agent.\n`
const frontmatter = (raw) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? ''

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  scripts = await mk('scripts')
  const logs = await mk('logs')
  responsesFile = join(logs, 'responses.jsonl')
  invocationsFile = join(logs, 'invocations.jsonl')
  hooksOut = join(logs, 'codex-hooks.jsonl')
  pidsFile = join(logs, 'codex-pids.jsonl')
  listModeFile = join(logs, 'hooks-list-mode')
  await writeFile(join(agentsDir, `${A}.md`), agentFile(A, 'Checks the repo with the user.'))
  // The fake Codex behind a wrapper that logs each process's argv, folder and env names (never values), to see what a run was
  // given, and takes FAKE_CODEX_HOOKS_LIST from the mode file while it exists.
  procsFile = join(logs, 'codex-procs.jsonl')
  const wrapper = join(await mk('wrapper'), 'codex-procs.mjs')
  await writeFile(
    wrapper,
    [
      `import { appendFileSync, existsSync, readFileSync } from 'node:fs'`,
      `appendFileSync(${JSON.stringify(procsFile)}, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2), cwd: process.cwd(), env: Object.keys(process.env) }) + '\\n')`,
      `if (existsSync(${JSON.stringify(listModeFile)})) process.env.FAKE_CODEX_HOOKS_LIST = readFileSync(${JSON.stringify(listModeFile)}, 'utf8').trim()`,
      `await import(${JSON.stringify(new URL('../backend/tests/fixtures/fake-codex.mjs', import.meta.url).href)})`
    ].join('\n') + '\n'
  )
  h = await start({
    fake: FAKE,
    fakeCodex: wrapper,
    dataDir,
    agentsDir,
    env: {
      ZUMIBOT_TEST_PICK_FOLDER: folder,
      FAKE_STDOUT_DIR: scripts,
      FAKE_RESPONSES_FILE: responsesFile,
      FAKE_INVOCATIONS_OUT: invocationsFile,
      FAKE_CODEX_COMPACT_MS: '1500',
      FAKE_CODEX_HOOKS_OUT: hooksOut,
      FAKE_CODEX_PIDS: pidsFile
    }
  })
  const page = h.page
  const cFile = join(agentsDir, `${C}.md`)
  // The harness's vault key: made at the first vault save, in a folder of its own outside the data dir.
  const keyFile = join(h.root, 'vault-key', 'vault.key')

  // 1. Agent Studio: a new agent on the Codex engine, with a model the fake's model/list offers
  await page.locator(tid('new-agent')).waitFor({ timeout: 30_000 })
  await page.click(tid('new-agent'))
  await page.click(tid('new-menu-agent'))
  await page.locator('#agent-name').fill(C)
  await page.locator('#agent-description').fill('Runs on Codex for the e2e.')
  await waitFor(
    async () => {
      await page.locator(tid('agent-engine')).click()
      const offered =
        (await page.locator('.search-select-menu [data-testid="select-option"][data-value="codex"]').getAttribute('aria-disabled')) ===
        'false'
      await page.keyboard.press('Escape')
      return offered
    },
    T,
    'the Codex engine to be offered'
  )
  await pickOption(page.locator(tid('agent-engine')), 'codex')
  assert(
    (await textOf(page.locator(tid('codex-vault-note')))) === CODEX_VAULT_NOTE,
    `the Codex vault note reads ${JSON.stringify(await textOf(page.locator(tid('codex-vault-note'))))}`
  )
  const models = page.locator(tid('codex-models'))
  await models.getByRole('button', { name: 'gpt-fake-a', exact: true }).click()
  assert((await models.getByRole('button', { name: 'gpt-fake-hidden', exact: true }).count()) === 0, 'a hidden Codex model is offered')
  await page.locator('#agent-prompt').fill(C_BODY)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await waitFor(async () => existsSync(cFile), T, `${cFile} to be written`)
  const fm1 = frontmatter(await readFile(cFile, 'utf8'))
  assert(/^provider: codex$/m.test(fm1) && /^model: gpt-fake-a$/m.test(fm1), `the agent file's frontmatter is ${JSON.stringify(fm1)}`)
  await agentRow(page, C).waitFor({ timeout: T })
  assert(
    (await textOf(agentRow(page, C).locator(tid('agent-engine-tag')))) === 'Codex',
    `C's row tag reads ${JSON.stringify(await textOf(agentRow(page, C).locator(tid('agent-engine-tag'))))}`
  )
  assert((await agentRow(page, A).locator(tid('agent-engine-tag')).count()) === 0, 'the Claude agent shows an engine tag')
  ok(
    '1 Agent Studio: Engine Codex (with the vault note) and model gpt-fake-a write provider: codex; the row shows the Codex tag, the Claude agent none'
  )

  // 2. a send streams the fake's reply over a fresh thread
  await codexScript(delta('Hello '), { sleep: 400 }, delta('from Codex'), message('Hello from Codex'), usage(1200, 40))
  await agentRow(page, C).click()
  await pickFolder(page, folder)
  await page.evaluate(() => {
    window.__sawStreaming = false
    const check = () => {
      if (document.querySelector('[data-streaming]')) window.__sawStreaming = true
    }
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true })
  })
  // Agent Studio's model/list ran its own codex process before this
  let mark = (await codexLog()).length
  let procsAt = (await jsonLines(procsFile)).length
  await typeAndSend(page, 'Hello Codex')
  const cId = await openedChat(page)
  await waitReply(page, cId, 'Hello from Codex')
  assert(await page.evaluate(() => window.__sawStreaming), 'no [data-streaming] element was seen while the reply streamed')
  // The first run of a hook set: a model-free pre-flight lists the hooks for their hashes, then the run checks they are
  // trusted before any thread (probe check 11).
  const log1 = (await codexLog()).slice(mark)
  assert(
    JSON.stringify(log1.map((l) => l.method)) ===
      JSON.stringify(['initialize', 'hooks/list', 'initialize', 'hooks/list', 'thread/start', 'turn/start']),
    `the first turn asked ${JSON.stringify(log1.map((l) => l.method))}`
  )
  const start1 = log1[4].params
  assert(
    start1.cwd === folder &&
      start1.model === 'gpt-fake-a' &&
      start1.approvalPolicy === 'untrusted' &&
      start1.approvalsReviewer === 'user' &&
      start1.sandbox === 'workspace-write',
    `thread/start had ${JSON.stringify({ cwd: start1.cwd, model: start1.model, approvalPolicy: start1.approvalPolicy, approvalsReviewer: start1.approvalsReviewer, sandbox: start1.sandbox })}`
  )
  assert(start1.baseInstructions.startsWith(C_BODY), "thread/start's baseInstructions do not lead with the agent file's body")
  // Subagents on: the process's --enable multi_agent decides, so the thread names no switch (probe check 13).
  assert(
    !('features.multi_agent' in start1.config) &&
      start1.config['mcp_servers.zumibot_todos']?.env_vars?.includes('ZUMIBOT_TODOS_CAPABILITY'),
    `thread/start's config is ${JSON.stringify(Object.keys(start1.config))}`
  )
  assert(
    !JSON.stringify(start1).includes('dangerously') && start1.approvalPolicy !== 'never' && start1.sandbox !== 'danger-full-access',
    'thread/start bypasses approvals or the sandbox'
  )
  assert(log1[5].params.input?.[0]?.text?.includes('Hello Codex'), `turn/start's input is ${JSON.stringify(log1[5].params.input)}`)
  const procs1 = (await jsonLines(procsFile)).slice(procsAt)
  const [pre1, run1] = procs1
  const hooks1 = configArg(run1?.argv ?? [], 'hooks.PreToolUse')
  assert(
    procs1.length === 2 &&
      configArg(pre1.argv, 'hooks.PreToolUse') === hooks1 &&
      configArg(pre1.argv, 'hooks.state') === null &&
      configArg(run1.argv, 'hooks.state') !== null,
    `the first turn's processes were ${JSON.stringify(procs1.map((p) => p.argv))}`
  )
  assert(
    hooks1.includes(VAULT_GUARD_TEXT) && hooks1.includes('pauseHook.mjs') && hooks1.includes('ZUMIBOT_PAUSE_FILE'),
    `the run's hooks are ${hooks1}`
  )
  assert(
    run1.argv.includes('multi_agent') && run1.argv[run1.argv.indexOf('multi_agent') - 1] === '--enable',
    `the run's argv is ${JSON.stringify(run1.argv)}`
  )
  const meta1 = await metaOf(cId)
  assert(
    meta1.sessionEngine === 'codex' && meta1.sessionId === log1[5].params.threadId,
    `the chat's session is ${JSON.stringify({ sessionId: meta1.sessionId, sessionEngine: meta1.sessionEngine })}`
  )
  assert(meta1.context?.used === 1240, `the context meter holds ${JSON.stringify(meta1.context)}`)
  const threadId = meta1.sessionId
  ok(
    `2 the reply streams ([data-streaming] seen) over thread/start with the agent's model, body and untrusted policy, after a model-free pre-flight and a trusted check of the vault and pause hooks; subagents on; the chat keeps thread ${threadId.slice(0, 8)} as a codex session`
  )

  // 3. a Bash card allowed once: the fake gets accept, and the turn resumed the thread
  mark = (await codexLog()).length
  procsAt = (await jsonLines(procsFile)).length
  await codexScript(shell('cmd-ls', 'ls -la'), reply('There are 3 files'))
  await typeAndSend(page, 'List the files')
  await pending(page).first().waitFor({ timeout: T })
  assert((await pending(page).count()) === 1, `${await pending(page).count()} pending cards are shown`)
  assert((await textOf(pending(page).first())).includes('ls -la'), `the card reads ${JSON.stringify(await textOf(pending(page).first()))}`)
  await pending(page).first().locator(tid('approval-allow-once')).click()
  await waitReply(page, cId, 'There are 3 files')
  // The hooks' trust is cached: no pre-flight this time, only the run's own check.
  const resumed = (await codexLog()).slice(mark)
  assert(
    JSON.stringify(resumed.map((l) => l.method)) === JSON.stringify(['initialize', 'hooks/list', 'thread/resume', 'turn/start']) &&
      (await jsonLines(procsFile)).length === procsAt + 1,
    `the second turn asked ${JSON.stringify(resumed.map((l) => l.method))}`
  )
  assert(
    resumed[2].params.threadId === threadId && resumed[2].params.excludeTurns === true,
    `the second turn's resume was ${JSON.stringify({ threadId: resumed[2].params.threadId, excludeTurns: resumed[2].params.excludeTurns })}`
  )
  let answers = await codexAnswers()
  assert(
    answers.length === 1 && answers[0].id === 0 && answers[0].result?.decision === 'accept',
    `the fake was answered ${JSON.stringify(answers)}`
  )
  const appr1 = (await itemsOf(cId)).filter((i) => i.type === 'approval')
  assert(
    appr1.length === 1 && appr1[0].status === 'allowed-once' && appr1[0].toolName === 'Bash',
    `the stored approvals are ${JSON.stringify(appr1)}`
  )
  ok(
    '3a a Bash card (ls -la) allowed once: the fake gets {decision: accept}; the turn resumed the same thread (excludeTurns) on the cached hook trust'
  )

  // 3m. the model picker: Default (the agent file's model), Codex's visible models, a pick that reaches thread/resume, then Default
  const modelPicker = page.locator(tid('chat-model'))
  const pickerText = async () => (await modelPicker.textContent()).trim()
  assert((await pickerText()) === 'Default (gpt-fake-a)', `the Codex chat's model picker reads ${JSON.stringify(await pickerText())}`)
  await modelPicker.click()
  const offered = await page.locator(tid('chat-model-option')).evaluateAll((els) => els.map((e) => e.getAttribute('data-model')))
  assert(JSON.stringify(offered) === JSON.stringify(['', 'gpt-fake-a', 'gpt-fake-b']), `the picker offers ${JSON.stringify(offered)}`)
  await page.click(`${tid('chat-model-option')}[data-model="gpt-fake-b"]`)
  await waitFor(async () => (await pickerText()) === 'gpt-fake-b', T, 'the picker to read gpt-fake-b')
  assert((await metaOf(cId)).modelByHand === true, 'the pick was not stored as a pick by hand')
  mark = (await codexLog()).length
  await codexScript(reply('Running on b'))
  await typeAndSend(page, 'Which model?')
  await waitReply(page, cId, 'Running on b')
  const onB = (await codexLog()).slice(mark).find((l) => l.method === 'thread/resume')
  assert(
    onB?.params.threadId === threadId && onB.params.model === 'gpt-fake-b',
    `the picked turn resumed with ${JSON.stringify({ threadId: onB?.params.threadId, model: onB?.params.model })}`
  )
  await modelPicker.click()
  await page.click(`${tid('chat-model-option')}[data-model=""]`)
  await waitFor(async () => (await pickerText()) === 'Default (gpt-fake-a)', T, 'the picker to read Default (gpt-fake-a) again')
  const back = await metaOf(cId)
  assert(
    back.model === undefined && back.modelByHand === undefined,
    `Default left the chat's model as ${JSON.stringify({ model: back.model, modelByHand: back.modelByHand })}`
  )
  ok(
    '3m the Codex model picker reads Default (gpt-fake-a), offers the visible models only, gpt-fake-b reaches thread/resume on the same thread, and Default clears it'
  )

  // 11. the next turn's first card is request id 0 again (a new codex process): it shows and is answered, here with Allow for this chat
  await codexScript(shell('cmd-git', 'git status'), reply('Clean tree'))
  await typeAndSend(page, 'Check git')
  await pending(page).first().waitFor({ timeout: T })
  assert(
    (await textOf(pending(page).first())).includes('git status'),
    `the second card reads ${JSON.stringify(await textOf(pending(page).first()))}`
  )
  await pending(page).first().locator(tid('approval-allow-chat')).click()
  await waitReply(page, cId, 'Clean tree')
  answers = await codexAnswers()
  assert(
    answers.length === 2 && answers[1].id === 0 && answers[1].result?.decision === 'accept',
    `the fake was answered ${JSON.stringify(answers)}`
  )
  const appr2 = (await itemsOf(cId)).filter((i) => i.type === 'approval')
  assert(
    appr2.length === 2 && appr2[1].status === 'allowed-chat' && appr2[0].id !== appr2[1].id,
    `the stored approvals are ${JSON.stringify(appr2.map((a) => ({ id: a.id, status: a.status })))}`
  )
  ok(
    "11 the second turn's first card (request id 0 again, a new process) shows, is answered (Allow for this chat) and stored under its own id"
  )

  // 3b. Allow for this chat answers the same command next turn by itself: no card
  await watchCards(page)
  await codexScript(shell('cmd-git2', 'git status'), reply('Still clean'))
  await typeAndSend(page, 'Check git again')
  await waitReply(page, cId, 'Still clean')
  assert((await cardSeen(page)) === false, 'a pending card was shown for a command allowed for this chat')
  answers = await codexAnswers()
  assert(
    answers.length === 3 && answers[2].id === 0 && answers[2].result?.decision === 'accept',
    `the fake was answered ${JSON.stringify(answers)}`
  )
  const appr3 = (await itemsOf(cId)).filter((i) => i.type === 'approval')
  assert(appr3.length === 3 && appr3[2].status === 'auto-allowed', `the third approval is ${JSON.stringify(appr3[2])}`)
  ok('3b the same command next turn is auto-allowed by the chat rule: no card, the fake gets accept')

  // 3c. a declined card: the fake gets decline
  await codexScript(shell('cmd-rm', 'rm -rf build', { declined: true }), reply('I left the build folder alone'))
  await typeAndSend(page, 'Clean the build')
  await pending(page).first().waitFor({ timeout: T })
  await pending(page).first().locator(tid('approval-deny')).click()
  await waitReply(page, cId, 'I left the build folder alone')
  answers = await codexAnswers()
  assert(
    answers.length === 4 && answers[3].id === 0 && answers[3].result?.decision === 'decline',
    `the fake was answered ${JSON.stringify(answers)}`
  )
  const appr4 = (await itemsOf(cId)).filter((i) => i.type === 'approval').at(-1)
  assert(appr4?.status === 'denied', `the declined approval is ${JSON.stringify(appr4)}`)
  ok('3c a denied card gives the fake {decision: decline}')

  // 4 + 9a. Stop during a sleep: turn/interrupt, the stopped notice; the Pause button shows while it runs
  mark = (await codexLog()).length
  await codexScript(delta('Working on it'), { sleep: 30_000 }, message('Never finished'))
  await typeAndSend(page, 'Do something long')
  const stopButton = page.locator(tid('send-button'))
  await waitFor(async () => (await stopButton.getAttribute('data-tip')) === 'Stop', T, 'the Stop button')
  await waitFor(
    async () => (await page.locator('[data-streaming]', { hasText: 'Working on it' }).count()) > 0,
    T,
    'the streamed "Working on it"'
  )
  assert((await page.locator(tid('pause-button')).count()) === 1, 'a running Codex chat shows no Pause button')
  await stopButton.click()
  await idle([cId], 'the Codex chat to stop')
  const last4 = (await itemsOf(cId)).at(-1)
  assert(last4?.type === 'notice' && last4.kind === 'stopped', `the chat ends with ${JSON.stringify(last4)}`)
  assert(
    (await codexLog()).slice(mark).some((l) => l.method === 'turn/interrupt' && l.params.threadId === threadId),
    'no turn/interrupt was sent'
  )
  assert((await page.locator(tid('agent-message'), { hasText: 'Never finished' }).count()) === 0, 'the turn went on after Stop')
  ok('4 Stop during a sleep sends turn/interrupt and ends with the stopped notice; 9a the Pause button shows while it runs')

  // 4b. Pause: the first call runs, Pause is pressed, and the next main-thread call is blocked by the pause hook (the built
  // dist/pauseHook.mjs, which the fake runs through sh -c); the agent writes its status, the turn lands paused with the
  // Paused notice and Resume, and Resume sends Continue on the same thread
  const goFile = join(logs, 'pause-go')
  const PAUSE_STATUS = 'Paused after step one; step two is next.'
  await codexScript(
    { exec: { command: 'echo step-one', id: 'exec-step-one', output: 'step-one\n' } },
    { until: { file: goFile, ms: 20_000 } },
    { exec: { command: 'echo step-two', id: 'exec-step-two', output: 'step-two\n' } },
    reply(PAUSE_STATUS)
  )
  await typeAndSend(page, 'Run step one, then step two')
  await waitFor(async () => (await codexHooks()).some((l) => l.id === 'exec-step-one'), T, 'step one to pass the hooks')
  await page.locator(tid('pause-button')).click()
  await waitFor(async () => (await metaOf(cId))?.pause === 'pausing', T, 'the chat to be pausing')
  assert(existsSync(flagOf(cId)), 'no pause flag while pausing')
  await writeFile(goFile, '')
  await waitFor(
    async () => {
      const m = await metaOf(cId)
      return m?.pause === 'paused' && !m.inFlight
    },
    T,
    'the pause to land'
  )
  const hooked4 = (await codexHooks()).filter((l) => l.id.startsWith('exec-step-'))
  assert(
    JSON.stringify(hooked4.map((l) => [l.id, l.agentId, l.blocked])) ===
      JSON.stringify([
        ['exec-step-one', null, false],
        ['exec-step-two', null, true]
      ]),
    `the hooked calls were ${JSON.stringify(hooked4)}`
  )
  let items4 = await itemsOf(cId)
  const blocked4 = items4.find((i) => i.type === 'tool' && i.id === 'exec-step-two')
  assert(
    blocked4?.name === 'Blocked' && blocked4.isError === true && blocked4.result?.includes(PAUSE_MARKER),
    `the blocked call's row is ${JSON.stringify(blocked4)}`
  )
  assert(
    items4.some((i) => i.type === 'tool' && i.id === 'exec-step-one' && i.name === 'Bash' && !i.isError),
    'step one has no Bash row'
  )
  const tail4 = items4.slice(-2)
  assert(
    tail4[0]?.type === 'assistant' &&
      tail4[0].text === PAUSE_STATUS &&
      tail4[1]?.type === 'notice' &&
      tail4[1].kind === 'userPaused' &&
      tail4[1].text === PAUSED_TEXT,
    `the paused turn ends with ${JSON.stringify(tail4)}`
  )
  assert(!existsSync(flagOf(cId)), 'the pause flag outlived the pause')
  await page.locator(tid('resume-button')).waitFor({ timeout: T })
  assert((await page.locator(tid('pause-button')).count()) === 0, 'Pause is still offered once paused')
  mark = (await codexLog()).length
  await codexScript(reply('Step two done'))
  await page.locator(tid('resume-button')).click()
  await waitReply(page, cId, 'Step two done')
  const resume4 = (await codexLog()).slice(mark)
  const resumeTurn = resume4.find((l) => l.method === 'turn/start')
  assert(
    resume4.some((l) => l.method === 'thread/resume' && l.params.threadId === threadId) &&
      resumeTurn?.params.input?.[0]?.text?.includes('Continue'),
    `Resume asked ${JSON.stringify(resume4.map((l) => [l.method, l.params?.threadId]))} with ${JSON.stringify(resumeTurn?.params.input)}`
  )
  items4 = await itemsOf(cId)
  const userAt4 = items4.findLastIndex((i) => i.type === 'user')
  assert(items4[userAt4]?.text === 'Continue', `Resume sent ${JSON.stringify(items4[userAt4])}`)
  const meta4 = await metaOf(cId)
  assert(
    meta4.pause === undefined && meta4.held === undefined,
    `after Resume the chat holds ${JSON.stringify({ pause: meta4.pause, held: meta4.held })}`
  )
  ok(
    '4b Pause: step one ran, step two was blocked by the pause hook (a Blocked row with the pause text), the status then the Paused notice with Resume; Resume sends Continue on the same thread'
  )

  // 5. the fake's MCP call to the real zumibot_todos bridge (after the manual-mode elicitation, answered with no card)
  await watchCards(page)
  await codexScript(
    {
      request: {
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: '$THREAD',
          turnId: '$TURN',
          serverName: 'zumibot_todos',
          mode: 'form',
          message: 'Allow the zumibot_todos MCP server to run tool "add"?',
          requestedSchema: { type: 'object', properties: {} },
          _meta: {
            codex_approval_kind: 'mcp_tool_call',
            persist: ['session', 'always'],
            tool_params: { items: [{ text: 'Ship the Codex e2e' }] }
          }
        }
      }
    },
    { mcpCall: { server: 'zumibot_todos', tool: 'add', args: { items: [{ text: 'Ship the Codex e2e' }] } } },
    reply('Added it to the list')
  )
  await typeAndSend(page, 'Put the e2e on the list')
  await waitReply(page, cId, 'Added it to the list')
  assert((await cardSeen(page)) === false, 'a card was shown for the to-do call')
  answers = await codexAnswers()
  assert(answers.at(-1)?.result?.action === 'accept', `the elicitation was answered ${JSON.stringify(answers.at(-1))}`)
  const listed = (await rpc(page, 'todos:list', cId)).items
  assert(
    listed.length === 1 && listed[0].text === 'Ship the Codex e2e' && listed[0].addedBy === C,
    `the chat's to-dos are ${JSON.stringify(listed)}`
  )
  await openSideMenu(page)
  const menu = page.locator(tid('side-menu'))
  // 9b. the side panel's list: To-dos, Side questions, Files and Dispatched agents yes; no Desktop even with computerUse on
  // (computer use stays Claude-only: Codex has no forced approval for an MCP tool in auto mode, probe check 12)
  const plain = await readFile(cFile, 'utf8')
  await writeFile(cFile, plain.replace(/\n---\n/, '\ncomputerUse: true\n---\n'))
  await waitFor(
    async () => (await rpc(page, 'agents:list')).find((a) => a.name === C)?.computerUse === true,
    T,
    'C to read computerUse: true'
  )
  await sleep(300)
  for (const shown of ['side-open-todos', 'side-open-sides', 'side-open-files', 'side-open-dispatch']) {
    assert((await menu.locator(tid(shown)).count()) === 1, `the Codex chat's side panel lacks ${shown}`)
  }
  assert((await menu.locator(tid('side-open-desktop')).count()) === 0, "the Codex chat's side panel offers side-open-desktop")
  await writeFile(cFile, plain)
  await waitFor(
    async () => (await rpc(page, 'agents:list')).find((a) => a.name === C)?.computerUse === undefined,
    T,
    'C to drop computerUse'
  )
  await menu.locator(tid('side-open-todos')).click()
  await page.locator(tid('todos-panel')).waitFor({ timeout: T })
  await waitFor(
    async () => (await page.locator(`${tid('todos-panel')} ${tid('todo-text')}`).allTextContents()).includes('Ship the Codex e2e'),
    T,
    'the to-do in the panel'
  )
  ok(
    '5 the fake\'s mcpCall to zumibot_todos add (its elicitation accepted with no card) puts "Ship the Codex e2e" in the To-dos panel; 9b To-dos, Side questions, Files and Dispatched agents rows, no Desktop (computerUse on)'
  )

  // 9c + 9d. /btw is in the / menu, and a typed /btw answers from an ephemeral fork of the last completed turn; the side run's
  // deny hook blocks a read that runs without asking (no item at all), its command request is declined with no card, and the
  // chat gets no item
  const codexCommands = await slashMenu(page)
  assert(codexCommands.includes('todo') && codexCommands.includes('btw'), `the Codex chat's / menu lists ${JSON.stringify(codexCommands)}`)
  const items9 = await itemsOf(cId)
  const lastEnd = items9.findLast((i) => i.end)?.end
  assert(lastEnd?.engine === 'codex' && lastEnd.session === threadId, `the last turn's end stamp is ${JSON.stringify(lastEnd)}`)
  mark = (await codexLog()).length
  procsAt = (await jsonLines(procsFile)).length
  let answersAt = (await codexAnswers()).length
  await codexScript(
    { exec: { command: 'cat /etc/hostname', id: 'exec-side-read', output: 'host\n' } },
    shell('cmd-side', 'touch side-marker', { declined: true }),
    reply('Nothing is left')
  )
  await watchCards(page)
  await composer(page).fill('/btw what is left?')
  await page.click(tid('send-button'))
  let side = null
  await waitFor(
    async () => {
      side = (await sidesOf(cId)).find((s) => s.question === 'what is left?') ?? null
      return side !== null && side.state !== 'running' && side.state !== 'picking'
    },
    T,
    'the side answer to end'
  )
  assert(side.state === 'done' && side.answer === 'Nothing is left', `the side entry is ${JSON.stringify(side)}`)
  await page.locator(`${tid('side-entry')}[data-side-id="${side.id}"]`, { hasText: 'Nothing is left' }).waitFor({ timeout: T })
  assert((await cardSeen(page)) === false, "a card was shown for the side run's command")
  // The side hook set's own first run: its pre-flight, then the run's trusted check.
  const sideLog = (await codexLog()).slice(mark)
  assert(
    JSON.stringify(sideLog.map((l) => l.method)) ===
      JSON.stringify(['initialize', 'hooks/list', 'initialize', 'hooks/list', 'thread/fork', 'turn/start']),
    `the side run asked ${JSON.stringify(sideLog.map((l) => l.method))}`
  )
  const fork9 = sideLog[4].params
  assert(
    fork9.threadId === threadId && fork9.lastTurnId === lastEnd.at && fork9.ephemeral === true && fork9.excludeTurns === true,
    `the side fork was ${JSON.stringify({ threadId: fork9.threadId, lastTurnId: fork9.lastTurnId, ephemeral: fork9.ephemeral, excludeTurns: fork9.excludeTurns })}`
  )
  assert(
    fork9.sandbox === 'read-only' && fork9.approvalPolicy === 'untrusted' && fork9.approvalsReviewer === 'user',
    `the side fork's policy is ${JSON.stringify({ sandbox: fork9.sandbox, approvalPolicy: fork9.approvalPolicy, approvalsReviewer: fork9.approvalsReviewer })}`
  )
  const sideRun = (await jsonLines(procsFile)).slice(procsAt).at(-1)
  const sideHooks = configArg(sideRun?.argv ?? [], 'hooks.PreToolUse')
  assert(
    sideHooks?.includes(SIDE_DENY_TEXT) &&
      !sideHooks.includes(VAULT_GUARD_TEXT) &&
      configArg(sideRun.argv, 'hooks.state') !== null &&
      sideRun.argv[sideRun.argv.indexOf('multi_agent') - 1] === '--disable',
    `the side run's argv is ${JSON.stringify(sideRun?.argv)}`
  )
  assert(
    JSON.stringify((await codexHooks()).filter((l) => l.id === 'exec-side-read').map((l) => l.blocked)) === '[true]',
    "the side run's read was not blocked"
  )
  answers = (await codexAnswers()).slice(answersAt)
  assert(
    answers.length === 1 && answers[0].id === 0 && answers[0].result?.decision === 'decline',
    `the side run's request was answered ${JSON.stringify(answers)}`
  )
  assert((await itemsOf(cId)).length === items9.length, 'the side answer added chat items')
  assert(!(await metaOf(cId)).inFlight, 'the side answer left the chat running')
  ok(
    `9c the / menu lists ${JSON.stringify(codexCommands)}; 9d a typed /btw answers "Nothing is left" from an ephemeral read-only fork at turn ${lastEnd.at.slice(0, 8)}: its deny hook blocked the cat, its command was declined with no card`
  )

  // 9f. codex never trusts the side hook (its hooks/list lists none): cached, fresh, then a run with no hook, logged once; the
  // read runs, and decline-all still declines the command with no card
  await hooksListed(false)
  mark = (await codexLog()).length
  procsAt = (await jsonLines(procsFile)).length
  answersAt = (await codexAnswers()).length
  const errorsAt = h.errors.length
  await codexScript(
    { exec: { command: 'cat /etc/hostname', id: 'exec-side-read-2', output: 'host\n' } },
    shell('cmd-side-2', 'touch side-marker', { declined: true }),
    reply('Still nothing left')
  )
  await watchCards(page)
  await composer(page).fill('/btw anything else?')
  await page.click(tid('send-button'))
  let side2 = null
  await waitFor(
    async () => {
      side2 = (await sidesOf(cId)).find((s) => s.question === 'anything else?') ?? null
      return side2 !== null && side2.state !== 'running' && side2.state !== 'picking'
    },
    T,
    'the hookless side answer to end'
  )
  await hooksListed(true)
  assert(side2.state === 'done' && side2.answer === 'Still nothing left', `the hookless side entry is ${JSON.stringify(side2)}`)
  assert((await cardSeen(page)) === false, "a card was shown for the hookless side run's command")
  const side2Log = (await codexLog()).slice(mark).map((l) => l.method)
  // The cached trust's run finds its hook untrusted and ends before any thread; the fresh pre-flight finds none; then no hook.
  assert(
    JSON.stringify(side2Log) ===
      JSON.stringify(['initialize', 'hooks/list', 'initialize', 'hooks/list', 'initialize', 'thread/fork', 'turn/start']),
    `the hookless side run asked ${JSON.stringify(side2Log)}`
  )
  const side2Run = (await jsonLines(procsFile)).slice(procsAt).at(-1)
  assert(
    configArg(side2Run.argv, 'hooks.PreToolUse') === null && configArg(side2Run.argv, 'hooks.state') === null,
    `the hookless side run's argv is ${JSON.stringify(side2Run.argv)}`
  )
  assert(
    JSON.stringify((await codexHooks()).filter((l) => l.id === 'exec-side-read-2').map((l) => l.blocked)) === '[false]',
    "the hookless side run's read was blocked"
  )
  answers = (await codexAnswers()).slice(answersAt)
  assert(
    answers.length === 1 && answers[0].result?.decision === 'decline',
    `the hookless side run's request was answered ${JSON.stringify(answers)}`
  )
  expectErrors(errorsAt, /codex side hook not confirmed: running the side answer without the deny hook/)
  assert((await itemsOf(cId)).length === items9.length, 'the hookless side answer added chat items')
  ok(
    '9f with the side hook never trusted, the side answer runs with no hook after cached and fresh tries (one log line): its read ran, its command was still declined with no card'
  )

  // 6. Edit of the last message forks the thread at the turn before it (thread/fork with that turn's id, kept inclusive),
  // with only the new text as input: no thread/start, no thread/resume, no expired notice
  const items6 = await itemsOf(cId)
  const editAt = items6.findLastIndex((i) => i.type === 'user' && i.text === 'Put the e2e on the list')
  const cutAt = items6.slice(0, editAt).findLastIndex((i) => i.end)
  const cutEnd = items6[cutAt]?.end
  assert(
    cutEnd?.engine === 'codex' && cutEnd.session === threadId && items6.slice(cutAt + 1, editAt).every((i) => i.type !== 'user'),
    `the turn before the edited message ends with ${JSON.stringify(cutEnd)}`
  )
  mark = (await codexLog()).length
  await codexScript(reply('Edited answer'), usage(2000, 30))
  const lastUser = page.locator(tid('user-message')).filter({ hasText: 'Put the e2e on the list' }).last()
  await lastUser.hover()
  await lastUser.locator(tid('edit-button')).click()
  await page.locator(tid('message-editor-input')).fill('Put the codex e2e on the list')
  await page.locator(tid('message-editor-send')).click()
  await page.locator(tid('message-editor')).waitFor({ state: 'detached', timeout: T })
  await waitReply(page, cId, 'Edited answer')
  const edit = (await codexLog()).slice(mark)
  const editMethods = edit.map((l) => l.method)
  assert(
    JSON.stringify(editMethods) === JSON.stringify(['initialize', 'hooks/list', 'thread/fork', 'turn/start']),
    `the edit asked ${JSON.stringify(editMethods)}`
  )
  const fork6 = edit[2].params
  // excludeTurns on every fork since probe check 16: the answer leaves the turns out and the model still remembers them.
  assert(
    fork6.threadId === threadId && fork6.lastTurnId === cutEnd.at && fork6.ephemeral === undefined && fork6.excludeTurns === true,
    `the edit's fork was ${JSON.stringify({ threadId: fork6.threadId, lastTurnId: fork6.lastTurnId, ephemeral: fork6.ephemeral, excludeTurns: fork6.excludeTurns })}`
  )
  assert(
    fork6.sandbox === 'workspace-write' && fork6.approvalPolicy === 'untrusted' && fork6.baseInstructions.startsWith(C_BODY),
    "the edit's fork lacks the thread params of a start"
  )
  const input6 = edit[3].params.input?.[0]?.text ?? ''
  assert(
    input6.includes('Put the codex e2e on the list') && !input6.includes('Hello from Codex'),
    `the forked turn's input is ${JSON.stringify(input6.slice(0, 400))}`
  )
  const meta6 = await metaOf(cId)
  assert(
    meta6.sessionId !== threadId &&
      meta6.sessionId === edit[3].params.threadId &&
      meta6.sessionEngine === 'codex' &&
      meta6.next === undefined,
    `after the edit the chat's session is ${JSON.stringify({ sessionId: meta6.sessionId, sessionEngine: meta6.sessionEngine, next: meta6.next })}`
  )
  const items6b = await itemsOf(cId)
  assert(
    !items6b.slice(items6b.findLastIndex((i) => i.type === 'user')).some((i) => i.type === 'notice' && i.kind === 'expired'),
    'the edit reseeded (expired notice)'
  )
  const forkedThread = meta6.sessionId
  ok(
    `6 Edit forks thread ${threadId.slice(0, 8)} at turn ${cutEnd.at.slice(0, 8)} (thread/fork, no start or resume, only the new text sent), and keeps the fork ${forkedThread.slice(0, 8)}`
  )

  // 16. Compact: thread/compact/start on the chat's thread, "Compacting…" while it runs, then the compacted ring; no note
  // field for Codex, and no message added
  mark = (await codexLog()).length
  const items16 = (await itemsOf(cId)).length
  const chip = page.locator(tid('context-chip'))
  await chip.waitFor({ timeout: T })
  await chip.click()
  await page.locator(tid('context-popup')).waitFor({ timeout: T })
  assert((await page.locator(tid('context-note')).count()) === 0, "the Codex chat's Compact offers a note field")
  await page.locator(tid('context-compact')).click()
  await page.locator('.working').filter({ hasText: 'Compacting…' }).waitFor({ timeout: T })
  await idle([cId], 'the compaction to end')
  // Codex reports no size after a compaction, so the ring names none.
  await waitFor(
    async () =>
      (await chip.getAttribute('data-percent')) === '0' &&
      (await chip.getAttribute('data-tip')) === 'Compacted · exact size after the next reply',
    T,
    'the ring to read compacted'
  )
  const compactLog = (await codexLog()).slice(mark)
  assert(
    JSON.stringify(compactLog.map((l) => l.method)) === JSON.stringify(['initialize', 'thread/resume', 'thread/compact/start']) &&
      compactLog[1].params.threadId === forkedThread &&
      compactLog[2].params.threadId === forkedThread,
    `the compaction asked ${JSON.stringify(compactLog.map((l) => [l.method, l.params?.threadId]))}`
  )
  assert((await itemsOf(cId)).length === items16, 'compacting added or removed chat items')
  const meta16 = await metaOf(cId)
  assert(
    meta16.context?.used === null && meta16.context.compacted === undefined && meta16.sessionId === forkedThread && !meta16.compacting,
    `after compacting the chat holds ${JSON.stringify({ context: meta16.context, sessionId: meta16.sessionId, compacting: meta16.compacting })}`
  )
  ok(
    `16 Compact (no note field) runs thread/compact/start on ${forkedThread.slice(0, 8)}, shows "Compacting…", then the ring reads "${await chip.getAttribute('data-tip')}"; no item added`
  )

  // 13. a patch: its card carries the diff, and once allowed the Files panel lists notes.txt with that diff
  const notesPath = join(folder, 'notes.txt')
  await writeFile(notesPath, NOTES_BEFORE)
  answersAt = (await codexAnswers()).length
  await codexScript(patch('patch-1', notesPath, NOTES_DIFF), reply('Changed line two'))
  await typeAndSend(page, 'Change line two of notes.txt')
  await pending(page).first().waitFor({ timeout: T })
  assert(
    (await textOf(pending(page).first())).includes('notes.txt'),
    `the patch card reads ${JSON.stringify(await textOf(pending(page).first()))}`
  )
  const patchCard = (await itemsOf(cId)).filter((i) => i.type === 'approval').at(-1)
  assert(
    patchCard?.toolName === 'ApplyPatch' &&
      patchCard.input?.changes?.[0]?.path === notesPath &&
      patchCard.input.changes[0].diff === NOTES_DIFF,
    `the stored patch card is ${JSON.stringify(patchCard)}`
  )
  // The patch lands as the card is allowed, as codex writes it then; the Files panel reads the file after the change.
  await writeFile(notesPath, NOTES_AFTER)
  await pending(page).first().locator(tid('approval-allow-once')).click()
  await waitReply(page, cId, 'Changed line two')
  answers = (await codexAnswers()).slice(answersAt)
  assert(answers.length === 1 && answers[0].result?.decision === 'accept', `the patch request was answered ${JSON.stringify(answers)}`)
  await openSideMenu(page)
  await page.locator(tid('side-open-files')).click()
  await page.locator(tid('files-panel')).waitFor({ timeout: T })
  const notesRow = page.locator(`${tid('file-row')}[data-path$="/notes.txt"]`)
  await notesRow.waitFor({ timeout: T })
  await notesRow.click()
  await page
    .locator(`${tid('file-rows')} > [data-row]`)
    .first()
    .waitFor({ timeout: T })
  const rows = await page
    .locator(`${tid('file-rows')} > [data-row]`)
    .evaluateAll((els) =>
      els.map((e) => ({ kind: e.dataset.kind ?? e.dataset.testid, code: e.querySelector('.code')?.textContent ?? e.textContent }))
    )
  assert(
    rows.some((r) => r.kind === 'del' && r.code === 'line two') && rows.some((r) => r.kind === 'add' && r.code === 'line TWO changed'),
    `the Files panel's diff of notes.txt is ${JSON.stringify(rows)}`
  )
  const change = (await itemsOf(cId)).find((i) => i.type === 'tool' && i.name === 'ApplyPatch')?.changes?.[0]
  assert(change && change.path === notesPath && change.op === 'update', `the patch's stored change is ${JSON.stringify(change)}`)
  await page.locator(tid('files-close')).click()
  ok('13 a patch card carries its diff; allowed once (accept), the Files panel lists notes.txt with -line two / +line TWO changed')

  // 14. a question card answered on the page: the fake gets the answer by question id
  answersAt = (await codexAnswers()).length
  await codexScript(askColor('q-1'), reply('You picked blue'))
  await typeAndSend(page, 'Ask me a color')
  const qCard = page.locator(`${tid('question-card')}[data-status="pending"]`).first()
  await qCard.waitFor({ timeout: T })
  assert((await textOf(qCard)).includes('Which color do you pick?'), `the question card reads ${JSON.stringify(await textOf(qCard))}`)
  await qCard.locator(`${tid('question-option')}[data-label="Blue"] input`).click()
  await qCard.locator(tid('question-send')).click()
  await waitReply(page, cId, 'You picked blue')
  answers = (await codexAnswers()).slice(answersAt)
  assert(
    answers.length === 1 && JSON.stringify(answers[0].result) === JSON.stringify({ answers: { color: { answers: ['Blue'] } } }),
    `the question was answered ${JSON.stringify(answers)}`
  )
  const qItem = (await itemsOf(cId)).filter((i) => i.type === 'approval').at(-1)
  assert(
    qItem?.toolName === 'AskUserQuestion' && qItem.status === 'answered',
    `the stored question is ${JSON.stringify(qItem && { toolName: qItem.toolName, status: qItem.status })}`
  )
  ok('14 a requestUserInput question shows a card; Blue answered on the page reaches the fake as {answers: {color: {answers: [Blue]}}}')

  // 18. a subagent: the spawn is an Agent dispatch, its call passes the hooks as a subagent's (agent_id), its approval is a card
  // naming it, its last message is the report, and the Dispatched agents panel shows it done with that report
  const CHILD_REPORT = 'Reviewer report: the build is clean.'
  const CHILD = 'reviewer-thread'
  const childNote = (method, params) => ({ notify: { method, params: { threadId: CHILD, turnId: `${CHILD}-turn`, ...params } } })
  answersAt = (await codexAnswers()).length
  procsAt = (await jsonLines(procsFile)).length
  await codexScript(
    { spawn: { name: 'reviewer', id: 'call_spawn_reviewer', threadId: CHILD } },
    { exec: { command: 'echo child-check', id: 'exec-child', output: 'child-check\n', agent: { threadId: CHILD } } },
    {
      request: {
        method: 'item/commandExecution/requestApproval',
        params: { threadId: CHILD, turnId: `${CHILD}-turn`, itemId: 'child-npm', command: 'npm test', cwd: folder, reason: null }
      }
    },
    childNote('item/completed', { item: { type: 'agentMessage', id: 'child-msg', text: CHILD_REPORT } }),
    { childEnd: { threadId: CHILD } },
    { collab: { tool: 'wait', id: 'call_wait_reviewer', receivers: [CHILD] } },
    { collab: { tool: 'wait', id: 'call_wait_reviewer', status: 'completed', receivers: [CHILD] } },
    reply('The reviewer found nothing')
  )
  await typeAndSend(page, 'Ask a reviewer to check the build')
  await pending(page).first().waitFor({ timeout: T })
  const childCard = await textOf(pending(page).first())
  assert(
    childCard.includes('npm test') && childCard.includes('From subagent reviewer'),
    `the subagent's card reads ${JSON.stringify(childCard)}`
  )
  await pending(page).first().locator(tid('approval-allow-once')).click()
  await waitReply(page, cId, 'The reviewer found nothing')
  answers = (await codexAnswers()).slice(answersAt)
  assert(answers.length === 1 && answers[0].result?.decision === 'accept', `the subagent's request was answered ${JSON.stringify(answers)}`)
  const hooked18 = (await codexHooks()).filter((l) => ['call_spawn_reviewer', 'exec-child', 'call_wait_reviewer'].includes(l.id))
  assert(
    JSON.stringify(hooked18.map((l) => [l.tool, l.agentId, l.blocked])) ===
      JSON.stringify([
        ['collaborationspawn_agent', null, false],
        ['Bash', CHILD, false],
        ['collaborationwait_agent', null, false]
      ]),
    `the hooked calls were ${JSON.stringify(hooked18)}`
  )
  const agentRow18 = (await itemsOf(cId)).find((i) => i.type === 'tool' && i.id === 'call_spawn_reviewer')
  assert(
    agentRow18?.name === 'Agent' && !agentRow18.isError && agentRow18.result?.includes(CHILD_REPORT),
    `the dispatch's row is ${JSON.stringify(agentRow18)}`
  )
  const entries18 = await rpc(page, 'dispatch:list', cId)
  assert(
    JSON.stringify(entries18.map((e) => [e.id, e.status])) === JSON.stringify([['call_spawn_reviewer', 'done']]),
    `the dispatch entries are ${JSON.stringify(entries18.map((e) => [e.id, e.status]))}`
  )
  const run18 = (await jsonLines(procsFile)).slice(procsAt).at(-1)
  assert(run18.argv[run18.argv.indexOf('multi_agent') - 1] === '--enable', `the subagent turn's argv is ${JSON.stringify(run18.argv)}`)
  await openSideMenu(page)
  await page.locator(tid('side-open-dispatch')).click()
  await page.locator(tid('dispatch-panel')).waitFor({ timeout: T })
  const row18 = page.locator(`${tid('dispatch-row')}[data-id="call_spawn_reviewer"]`)
  await waitFor(async () => (await row18.getAttribute('data-status').catch(() => null)) === 'done', T, 'the reviewer row to read done')
  await row18.click()
  const detail18 = page.locator(`${tid('dispatch-detail')}[data-id="call_spawn_reviewer"] ${tid('dispatch-report')}`)
  await detail18.waitFor({ timeout: T })
  assert((await textOf(detail18)).includes(CHILD_REPORT), `the reviewer's report reads ${JSON.stringify(await textOf(detail18))}`)
  await page.click(tid('side-panel-toggle'))
  ok(
    '18 a Codex subagent: an Agent dispatch whose call passed the hooks as a subagent\'s, whose card said "From subagent reviewer", and whose report shows in the Dispatched agents panel, done'
  )

  // 18b. Stop while a subagent's command runs: turn/interrupt alone leaves a child running (probe check 13), so the process
  // exit ends it; its dispatch ends stopped, and no app-server or held command of that turn is left
  const SLEEPER = 'sleeper-thread'
  const pidsAt = (await codexPids()).length
  await codexScript(
    { spawn: { name: 'sleeper', id: 'call_spawn_sleeper', threadId: SLEEPER } },
    { exec: { command: 'sleep 60', id: 'exec-sleeper', hold: 60_000, agent: { threadId: SLEEPER } } },
    reply('Never reached')
  )
  await typeAndSend(page, 'Have a subagent wait a minute')
  let held18 = null
  await waitFor(
    async () => (held18 = (await codexPids()).slice(pidsAt).find((p) => p.role === 'exec' && p.id === 'exec-sleeper') ?? null) !== null,
    T,
    "the subagent's held command"
  )
  assert(alive(held18.pid), "the subagent's command is not running")
  await page.locator(tid('send-button')).click()
  await idle([cId], 'the subagent turn to stop')
  const started18 = (await codexPids()).slice(pidsAt)
  await waitFor(async () => started18.every((p) => !alive(p.pid)), 5000, 'every process of the stopped turn to end')
  const entry18 = (await rpc(page, 'dispatch:list', cId)).find((e) => e.id === 'call_spawn_sleeper')
  assert(
    entry18?.status === 'stopped',
    `the stopped subagent's entry is ${JSON.stringify(entry18 && { id: entry18.id, status: entry18.status })}`
  )
  const last18 = (await itemsOf(cId)).at(-1)
  assert(last18?.type === 'notice' && last18.kind === 'stopped', `the stopped turn ends with ${JSON.stringify(last18)}`)
  ok(
    `18b Stop with a subagent's command running: the stopped notice, the dispatch ends stopped, and none of the turn's ${started18.length} processes is left`
  )

  // 12. a vault API key granted to the Codex agent rides in the Codex env beside the trusted vault guard (never in the hook
  // pre-flight's), and its value in the output reads [vault: <name>]
  await rpc(page, 'vault:save', { kind: 'apiKey', name: KEY_NAME, agents: [C], env: KEY_ENV, value: KEY_VALUE, description: '' })
  assert(existsSync(keyFile), `no vault key at ${keyFile} after the first save`)
  // The vault hooks' trust is cached from the first turn and the hooks did not change: one process, its own trusted check.
  await codexScript(delta(`The key is ${KEY_VALUE.slice(0, 9)}`), delta(`${KEY_VALUE.slice(9)} ok`), message(`The key is ${KEY_VALUE} ok`))
  procsAt = (await jsonLines(procsFile)).length
  mark = (await codexLog()).length
  await typeAndSend(page, 'Print the key')
  // Whatever the turn left after the message, once it ended (the reply is matched below, value hidden from the log).
  const replyTo = async (text) => {
    let said = null
    await waitFor(
      async () => {
        const items = await itemsOf(cId)
        const at = items.findLastIndex((i) => i.type === 'user')
        said = items[at]?.text === text ? (items.slice(at + 1).find((i) => i.type === 'assistant' || i.type === 'error') ?? null) : null
        return said !== null && !(await metaOf(cId)).inFlight
      },
      T,
      `the reply to "${text}" to end`
    )
    return said
  }
  const said = await replyTo('Print the key')
  assert(
    said?.text?.includes(`The key is [vault: ${KEY_NAME}] ok`),
    `the key reply is stored as ${JSON.stringify(said)?.replaceAll(KEY_VALUE, '<the key value>')}`
  )
  await page.locator(tid('agent-message'), { hasText: `[vault: ${KEY_NAME}]` }).waitFor({ timeout: T })
  assert(!(await page.content()).includes(KEY_VALUE), 'the key value is on the page')
  assert(!JSON.stringify(await itemsOf(cId)).includes(KEY_VALUE), 'the key value is in the stored chat')
  const keyRun = (await jsonLines(procsFile)).slice(procsAt)
  assert(
    keyRun.length === 1 &&
      keyRun[0].env.includes('ZUMIBOT_TODOS_CAPABILITY') &&
      keyRun[0].env.includes(KEY_ENV) &&
      configArg(keyRun[0].argv, 'hooks.state') !== null,
    `the Codex processes were ${JSON.stringify(keyRun.map((p) => ({ env: p.env.filter((n) => n.startsWith('ZUMIBOT_') || n === KEY_ENV), hooks: configArg(p.argv, 'hooks.state') !== null })))}`
  )
  assert(
    (await jsonLines(procsFile))
      .filter((p) => configArg(p.argv, 'hooks.PreToolUse') !== null && configArg(p.argv, 'hooks.state') === null)
      .every((p) => !p.env.includes(KEY_ENV)),
    'a hook pre-flight got the key'
  )
  ok(
    `12 a granted API key is in the Codex process's env beside the trusted hooks, and its value in the reply shows and is stored as [vault: ${KEY_NAME}]`
  )

  // 12b. the vault guard's hook blocks a read of the vault key's folder: no item for the call, a Blocked row with its text
  await codexScript({ exec: { command: `cat ${keyFile}`, id: 'exec-read-key', output: 'never read\n' } }, reply('The vault is off limits'))
  await typeAndSend(page, 'Read the vault key')
  await waitReply(page, cId, 'The vault is off limits')
  const blocked12 = (await itemsOf(cId)).find((i) => i.type === 'tool' && i.id === 'exec-read-key')
  assert(
    blocked12?.name === 'Blocked' &&
      blocked12.isError === true &&
      blocked12.result?.includes(VAULT_GUARD_TEXT) &&
      !JSON.stringify(blocked12).includes('never read'),
    `the blocked read's row is ${JSON.stringify(blocked12)}`
  )
  assert(
    JSON.stringify((await codexHooks()).filter((l) => l.id === 'exec-read-key').map((l) => l.blocked)) === '[true]',
    'the key read was not blocked'
  )
  ok("12b the vault guard's hook blocks `cat <vault key>`: a Blocked row with the guard's text, and the call never ran")

  // 12c. a key under a name codex reads for itself (CODEX_*) never reaches a Codex run's env, and its value is still scrubbed
  const ownKey = await rpc(page, 'vault:save', {
    kind: 'apiKey',
    name: OWN_KEY_NAME,
    agents: [C],
    env: OWN_KEY_ENV,
    value: OWN_KEY_VALUE,
    description: ''
  })
  await codexScript(reply(`Own key ${OWN_KEY_VALUE} here`))
  procsAt = (await jsonLines(procsFile)).length
  let errorsAt12 = h.errors.length
  await typeAndSend(page, 'Print the own key')
  const saidOwn = await replyTo('Print the own key')
  assert(
    saidOwn?.text?.includes(`Own key [vault: ${OWN_KEY_NAME}] here`) && !JSON.stringify(await itemsOf(cId)).includes(OWN_KEY_VALUE),
    `the own key's reply is stored as ${JSON.stringify(saidOwn)?.replaceAll(OWN_KEY_VALUE, '<the own key value>')}`
  )
  const ownRun = (await jsonLines(procsFile)).slice(procsAt)
  assert(
    ownRun.length === 1 && !ownRun[0].env.includes(OWN_KEY_ENV) && ownRun[0].env.includes(KEY_ENV),
    `the own key's run got the env names ${JSON.stringify(ownRun.map((p) => p.env.filter((n) => n === KEY_ENV || n === OWN_KEY_ENV)))}`
  )
  expectErrors(errorsAt12, /vault API keys left out of a Codex run: their names are reserved by codex/)
  await rpc(page, 'vault:delete', ownKey.id)
  ok(`12c a ${OWN_KEY_ENV} key is left out of the Codex env (logged by code only), and its value still reads [vault: ${OWN_KEY_NAME}]`)

  // 12d. codex never trusts the hooks: the cached trust's run ends before any thread, a fresh pre-flight finds none, then the
  // turn runs with no hooks and no keys, logged once
  await hooksListed(false)
  await codexScript(reply('Ran without the guard'))
  procsAt = (await jsonLines(procsFile)).length
  mark = (await codexLog()).length
  errorsAt12 = h.errors.length
  await typeAndSend(page, 'Run unguarded')
  await waitReply(page, cId, 'Ran without the guard')
  await hooksListed(true)
  // The downgrade shows in the chat, ahead of its reply, once: no guarded turn before it had one.
  const items12d = await itemsOf(cId)
  const unguarded12d = items12d.filter((i) => i.type === 'notice' && i.kind === 'unguarded')
  const reply12d = items12d.findLastIndex((i) => i.type === 'assistant')
  assert(
    unguarded12d.length === 1 && unguarded12d[0].text === UNGUARDED_TEXT && items12d.indexOf(unguarded12d[0]) === reply12d - 1,
    `the chat's unguarded notices are ${JSON.stringify(unguarded12d)}`
  )
  const shown12d = page.locator(tid('unguarded-notice'))
  await waitFor(
    async () => (await shown12d.count()) === 1 && (await shown12d.textContent()) === UNGUARDED_TEXT,
    T,
    'the unguarded notice on the page'
  )
  const log12d = (await codexLog()).slice(mark).map((l) => l.method)
  assert(
    JSON.stringify(log12d) ===
      JSON.stringify(['initialize', 'hooks/list', 'initialize', 'hooks/list', 'initialize', 'thread/resume', 'turn/start']),
    `the unguarded turn asked ${JSON.stringify(log12d)}`
  )
  const bare = (await jsonLines(procsFile)).slice(procsAt).at(-1)
  assert(
    configArg(bare.argv, 'hooks.PreToolUse') === null && configArg(bare.argv, 'hooks.state') === null && !bare.env.includes(KEY_ENV),
    `the unguarded run's argv and env were ${JSON.stringify({ argv: bare.argv, key: bare.env.includes(KEY_ENV) })}`
  )
  expectErrors(errorsAt12, /codex hooks not confirmed: running without the vault guard, the pause hook or API keys/)
  ok(
    '12d with the hooks never trusted, the turn runs after cached and fresh tries with no hooks and no API key (one log line), after an unguarded notice in the chat'
  )

  // 8. a usage limit: the limit notice waits to continue, and Don't continue ends the wait
  // The Claude reading before Codex reports one, for 15.
  const usageName = page.locator(tid('sidebar-user'))
  const claudeRing = await usageName.getAttribute('aria-label')
  const claudeUsage = (await rpc(page, 'app:account')).usage ?? null
  const resetsAt = Math.floor(Date.now() / 1000) + 3600
  const limitError = { message: "You've hit your usage limit.", codexErrorInfo: 'usageLimitExceeded', additionalDetails: null }
  await codexScript(
    note('account/rateLimits/updated', {
      rateLimits: {
        limitId: 'codex',
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: resetsAt + 86400 },
        credits: null,
        planType: 'plus',
        rateLimitReachedType: 'primary'
      }
    }),
    note('error', { error: limitError, willRetry: false }),
    {
      notify: {
        method: 'turn/completed',
        params: { threadId: '$THREAD', turn: { id: '$TURN', items: [], status: 'failed', error: limitError } }
      }
    }
  )
  await typeAndSend(page, 'One more thing')
  const limitNotice = page.locator(tid('limit-notice')).last()
  await waitFor(async () => (await limitNotice.getAttribute('data-state').catch(() => null)) === 'waiting', T, 'the limit notice to wait')
  const err8 = (await itemsOf(cId)).filter((i) => i.type === 'error').at(-1)
  assert(err8?.limit?.resetsAt === resetsAt * 1000, `the limit error is ${JSON.stringify(err8)}`)
  await waitFor(async () => (await metaOf(cId)).resume?.at === resetsAt * 1000 + 60_000, T, 'the wait to be stored 60 s past the reset')
  await limitNotice.locator(tid('limit-cancel')).click()
  await waitFor(async () => (await metaOf(cId)).resume === undefined, T, "Don't continue to drop the wait")
  await waitFor(
    async () => (await limitNotice.getAttribute('data-state').catch(() => null)) === 'stopped',
    T,
    'the limit notice to stop waiting'
  )
  ok(
    "8 a usageLimitExceeded error after a full rate-limit snapshot shows the limit notice waiting until 60 s past the reset; Don't continue ends it"
  )

  // 15. that snapshot is Codex's own reading in the Usage popover; Claude's ring and reading are unchanged
  const account15 = await rpc(page, 'app:account')
  assert(
    account15.codex?.session?.percent === 100 &&
      account15.codex.session.resetsAt === resetsAt * 1000 &&
      account15.codex.weekly?.percent === 40,
    `the account's Codex reading is ${JSON.stringify(account15.codex)}`
  )
  assert(
    JSON.stringify(account15.usage ?? null) === JSON.stringify(claudeUsage),
    `the Claude reading changed: ${JSON.stringify(claudeUsage)} -> ${JSON.stringify(account15.usage)}`
  )
  await usageName.click()
  const codexBlock = page.locator(`${tid('usage-popover')} ${tid('usage-codex')}`)
  await codexBlock.waitFor({ timeout: T })
  const codexText = await textOf(codexBlock)
  assert(
    /Codex usage limits/.test(codexText) && /Session limit.*100%/.test(codexText) && /Weekly limit.*40%/.test(codexText),
    `the popover's Codex block reads ${JSON.stringify(codexText)}`
  )
  assert(
    (await usageName.getAttribute('aria-label')) === claudeRing,
    `the Claude ring reads ${JSON.stringify(await usageName.getAttribute('aria-label'))}, was ${JSON.stringify(claudeRing)}`
  )
  await usageName.click()
  await page.locator(tid('usage-popover')).waitFor({ state: 'detached', timeout: T })
  ok(
    `15 the Usage popover shows "Codex usage limits" (session 100%, weekly 40%) from the snapshot; the Claude ring still reads ${JSON.stringify(claudeRing)}`
  )

  // 7. a Claude agent asks the Codex agent: the A→B chat runs on Codex and shows its reply
  await script(
    A,
    init(SID_A),
    askCall(`@${C}`, 'Summarise the repo for me', 'toolu_ask1'),
    say(SID_A, 'Codex says all good'),
    result(SID_A, 'Codex says all good')
  )
  mark = (await codexLog()).length
  await codexScript(reply('Codex summary: all good'))
  await agentRow(page, A).click()
  await pickFolder(page, folder)
  // 9e. the Claude chat's / menu does offer /btw
  const claudeCommands = await slashMenu(page)
  assert(claudeCommands.includes('btw'), `the Claude chat's / menu lists ${JSON.stringify(claudeCommands)}`)
  await typeAndSend(page, 'Ask the Codex agent about the repo')
  const aId = await openedChat(page, [cId])
  const askCard = page.locator(tid('ask-card')).first()
  await waitFor(async () => (await askCard.getAttribute('data-status').catch(() => null)) === 'done', T, 'the ask card to read done')
  const bChat = (await storedChats()).find((c) => c.asked?.from === aId)
  assert(
    bChat && bChat.agentName === C && bChat.sessionEngine === 'codex',
    `the A→B chat is ${JSON.stringify(bChat && { agentName: bChat.agentName, sessionEngine: bChat.sessionEngine })}`
  )
  await waitReply(page, aId, 'Codex says all good', [bChat.id])
  assert(await answered('req-toolu_ask1', 'allow'), 'the server sent no allow for the ask tool request')
  const askTool = (await itemsOf(aId)).find((i) => i.type === 'tool' && i.name === 'mcp__zumibot_agents__ask')
  assert(askTool && !askTool.isError && askTool.result?.includes('Codex summary: all good'), `A's ask result is ${JSON.stringify(askTool)}`)
  const askStart = (await codexLog()).slice(mark).find((l) => l.method === 'thread/start')
  assert(askStart?.params.baseInstructions.includes(ASKED_LINE), "the Codex thread's instructions lack the asked paragraph")
  await askCard.locator(tid('ask-open')).click()
  assert((await openedChat(page, [aId])) === bChat.id, 'Open conversation opened another chat')
  await page.locator(tid('agent-message'), { hasText: 'Codex summary: all good' }).waitFor({ timeout: T })
  ok(
    `7 the Claude agent's ask runs ${C} on Codex in the A→B chat, which shows "Codex summary: all good"; A's tool result holds it; 9e the Claude chat's / menu has btw`
  )

  // 19. a room with a Claude and a Codex member: the members picker offers the Codex agent, both answer the user's mentions,
  // the Codex member's thread holds the room briefing after its body, its session is stored as a codex one, and the moderator
  // is a claude call (no Codex process for it)
  await script(A, init(SID_ROOM_A), say(SID_ROOM_A, 'Claude member here'), result(SID_ROOM_A, 'Claude member here'))
  await codexScript(reply('Codex member here'))
  mark = (await codexLog()).length
  procsAt = (await jsonLines(procsFile)).length
  const invAt = (await jsonLines(invocationsFile)).length
  await page.click(tid('new-agent'))
  await page.click(tid('new-menu-group'))
  await page.locator(tid('new-chat-members')).click()
  const memberOption = (n) => page.locator(`${tid('new-chat-member-option')}[data-agent-name="${n}"]`)
  await memberOption(C).waitFor({ timeout: T })
  assert(
    (await memberOption(C).getAttribute('aria-disabled')) === 'false',
    `the Codex agent's member option is ${JSON.stringify(await textOf(memberOption(C)))}`
  )
  await memberOption(A).click()
  await memberOption(C).click()
  await page.keyboard.press('Escape')
  await pickFolder(page, folder)
  await composer(page).fill(`@${A} @${C} please say hello`)
  await page.click(tid('send-button'))
  const roomId = await openedChat(page, [cId, aId, bChat.id])
  await waitFor(
    async () => {
      const said = (await itemsOf(roomId)).filter((i) => i.type === 'assistant').map((i) => i.text)
      return said.includes('Codex member here') && said.includes('Claude member here') && !(await metaOf(roomId))?.inFlight
    },
    T,
    'both members to answer'
  )
  const room = (await metaOf(roomId)).group
  const roomStart = (await codexLog()).slice(mark).find((l) => l.method === 'thread/start')
  assert(
    roomStart?.params.baseInstructions.startsWith(C_BODY) && roomStart.params.baseInstructions.includes(BRIEFING_LINE),
    "the Codex member's instructions lack its body or the room briefing"
  )
  assert(
    JSON.stringify(room.sessionEngines) === JSON.stringify({ [C]: 'codex' }) &&
      room.sessions[C] === (await codexLog()).slice(mark).find((l) => l.method === 'turn/start')?.params.threadId &&
      room.sessions[A] === SID_ROOM_A,
    `the room's sessions are ${JSON.stringify({ sessions: room.sessions, sessionEngines: room.sessionEngines })}`
  )
  const moderated = (await jsonLines(invocationsFile)).slice(invAt).filter((l) => l.kind === 'moderator')
  assert(
    moderated.length >= 1 && moderated.every((l) => l.args.includes('--json-schema')),
    `the moderator calls were ${JSON.stringify(moderated.map((l) => l.args.slice(0, 4)))}`
  )
  const roomProcs = (await jsonLines(procsFile)).slice(procsAt)
  assert(
    roomProcs.length === 1 && configArg(roomProcs[0].argv, 'hooks.state') !== null && roomProcs[0].cwd === folder,
    `the room's Codex processes were ${JSON.stringify(roomProcs.map((p) => p.argv))}`
  )
  ok(
    `19 a room of ${A} (Claude) and ${C} (Codex): both answer; the Codex member's thread has the briefing, its session is stored as codex, and the ${moderated.length} moderator call(s) ran on claude`
  )

  // 20. computerUse: true on the Codex agent gives its run no desktop server or capability, and its chat no Desktop row
  // (computer use stays Claude-only: probe check 12)
  await openChat(page, cId)
  const plain20 = await readFile(cFile, 'utf8')
  await writeFile(cFile, plain20.replace(/\n---\n/, '\ncomputerUse: true\n---\n'))
  await waitFor(
    async () => (await rpc(page, 'agents:list')).find((a) => a.name === C)?.computerUse === true,
    T,
    'C to read computerUse: true'
  )
  await codexScript(reply('No desktop here'))
  mark = (await codexLog()).length
  procsAt = (await jsonLines(procsFile)).length
  await typeAndSend(page, 'Use the desktop')
  await waitReply(page, cId, 'No desktop here')
  const desk = (await codexLog()).slice(mark).find((l) => l.method === 'thread/resume' || l.method === 'thread/start')
  assert(
    desk &&
      !Object.keys(desk.params.config).some((k) => k.includes('desktop')) &&
      !desk.params.baseInstructions.includes('desktop_screenshot'),
    `the run's config is ${JSON.stringify(desk && Object.keys(desk.params.config))}`
  )
  assert(
    (await jsonLines(procsFile)).slice(procsAt).every((p) => !p.env.includes('ZUMIBOT_DESKTOP_CAPABILITY')),
    'a Codex run got the desktop capability'
  )
  await openSideMenu(page)
  assert(
    (await page.locator(`${tid('side-menu')} ${tid('side-open-desktop')}`).count()) === 0,
    "the Codex chat's side panel offers side-open-desktop"
  )
  await page.click(tid('side-panel-toggle'))
  await writeFile(cFile, plain20)
  await waitFor(
    async () => (await rpc(page, 'agents:list')).find((a) => a.name === C)?.computerUse === undefined,
    T,
    'C to drop computerUse'
  )
  ok('20 with computerUse: true the Codex run gets no desktop server, prompt or capability, and the chat no Desktop row')

  // 17. how every Codex process in the chat folder started: a hook pre-flight (`-c hooks.PreToolUse` with no trust, multi_agent
  // off, no feature, none of the run's keys), a main turn (subagents on, the question feature, and the vault and pause hooks
  // with their trust, or none after an untrusted fallback), or a side answer or compaction (multi_agent off, the question
  // feature, the side's deny hook with its trust or none). Agent Studio's model/list process (in the home folder) runs no turn.
  const procs = await jsonLines(procsFile)
  const runs = procs.filter((p) => p.cwd === folder)
  const flags = (p) => p.argv.slice(BASE_ARGV.length, p.argv.indexOf('-c') < 0 ? undefined : p.argv.indexOf('-c'))
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const preflights = runs.filter((p) => configArg(p.argv, 'hooks.PreToolUse') !== null && configArg(p.argv, 'hooks.state') === null)
  const mains = runs.filter((p) => same(flags(p), ['--enable', 'multi_agent', ...QUESTION_FEATURE]))
  const others = runs.filter((p) => same(flags(p), ['--disable', 'multi_agent', ...QUESTION_FEATURE]))
  for (const p of runs) {
    assert(
      same(p.argv.slice(0, BASE_ARGV.length), BASE_ARGV) && !/dangerously|bypass|danger-full-access/i.test(p.argv.join(' ')),
      `a Codex process started as ${JSON.stringify(p.argv)}`
    )
  }
  assert(
    preflights.length + mains.length + others.length === runs.length,
    `Codex processes of no known shape: ${JSON.stringify(runs.filter((p) => !preflights.includes(p) && !mains.includes(p) && !others.includes(p)).map((p) => p.argv))}`
  )
  assert(
    preflights.every(
      (p) => same(flags(p), ['--disable', 'multi_agent']) && p.argv.length === BASE_ARGV.length + 4 && !p.env.includes(KEY_ENV)
    ),
    `pre-flights started as ${JSON.stringify(preflights.map((p) => p.argv))}`
  )
  // A process with hooks carries both arguments, one hook set per kind of run.
  const hookSet = (p) => configArg(p.argv, 'hooks.PreToolUse')
  const guarded = (p) => p.argv.length === BASE_ARGV.length + 4 + 4 && hookSet(p) !== null && configArg(p.argv, 'hooks.state') !== null
  const bareRun = (p) => p.argv.length === BASE_ARGV.length + 4
  assert(
    mains.every((p) => (guarded(p) && hookSet(p) === hooks1) || bareRun(p)) && mains.filter(guarded).length >= 15,
    `main turns started as ${JSON.stringify([...new Set(mains.map((p) => JSON.stringify(p.argv)))])}`
  )
  assert(
    others.every((p) => (guarded(p) && hookSet(p) === sideHooks) || bareRun(p)),
    `side answers and compactions started as ${JSON.stringify([...new Set(others.map((p) => JSON.stringify(p.argv)))])}`
  )
  assert(
    new Set(preflights.map(hookSet)).size === 2 && preflights.every((p) => [hooks1, sideHooks].includes(hookSet(p))),
    'a pre-flight listed another hook set'
  )
  assert(
    procs.filter((p) => p.cwd !== folder).every((p) => !p.argv.includes('--enable') && configArg(p.argv, 'hooks.PreToolUse') === null),
    'a Codex process outside the chat folder had a feature or a hook turned on'
  )
  ok(
    `17 the chat folder's ${runs.length} Codex processes: ${preflights.length} model-free hook pre-flights, ${mains.length} main turns (subagents on, ${mains.filter(guarded).length} with the trusted vault and pause hooks), ${others.length} side answers and compactions`
  )

  // 10. the agent switched to Claude in Agent Studio: its chat's next turn starts fresh (expired notice), no --resume
  await openChat(page, cId)
  await agentRow(page, C).hover()
  await page
    .locator(`.agent-block:has(${tid('agent-row')}[data-agent-name="${C}"]) ${tid('agent-menu-button')}`)
    .first()
    .click()
  await page.locator(tid('agent-menu-edit')).click()
  await page.locator(tid('agent-engine')).waitFor({ timeout: T })
  await pickOption(page.locator(tid('agent-engine')), 'claude')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await waitFor(async () => !/^provider:/m.test(frontmatter(await readFile(cFile, 'utf8'))), T, 'the provider key to be removed')
  const fm10 = frontmatter(await readFile(cFile, 'utf8'))
  assert(!/^model: gpt-fake-a$/m.test(fm10), `the Claude agent kept the Codex model: ${JSON.stringify(fm10)}`)
  await waitFor(async () => (await agentRow(page, C).locator(tid('agent-engine-tag')).count()) === 0, T, 'the Codex tag to go')
  await script(C, init(SID_C), say(SID_C, 'Claude here now'), result(SID_C, 'Claude here now'))
  const before10 = (await codexLog()).length
  await openChat(page, cId)
  await typeAndSend(page, 'Are you still there?')
  await waitReply(page, cId, 'Claude here now')
  const items10 = await itemsOf(cId)
  const userAt = items10.findLastIndex((i) => i.type === 'user')
  assert(
    items10.slice(userAt).some((i) => i.type === 'notice' && i.kind === 'expired'),
    `no expired notice after the last message: ${JSON.stringify(items10.slice(userAt).map((i) => i.kind ?? i.type))}`
  )
  const runC = (await invocations()).filter((a) => agentOf(a) === C)
  assert(runC.length === 1 && !runC[0].includes('--resume'), `the fake claude for ${C} got ${JSON.stringify(runC)}`)
  assert((await codexLog()).length === before10, 'codex was started for a Claude agent')
  const meta10 = await metaOf(cId)
  assert(
    meta10.sessionId === SID_C && meta10.sessionEngine === undefined,
    `the chat's session is ${JSON.stringify({ sessionId: meta10.sessionId, sessionEngine: meta10.sessionEngine })}`
  )
  ok(
    '10 switched to Claude in Agent Studio: the next turn runs the fake claude with no --resume, after the expired notice, and the chat drops sessionEngine'
  )

  const bad = h.errors.filter((_, i) => !expectedErrors.has(i))
  assert(bad.length === 0, `unexpected errors: ${bad.join(' | ')}`)
  ok('no console or server errors but the fixed lines 9f, 12c and 12d expect')
}

/** Every process the fake Codex logged (app-servers and held commands) that still runs is killed: none may outlive the suite. */
async function killLeftovers() {
  if (!pidsFile) return []
  const left = (await jsonLines(pidsFile).catch(() => [])).filter((p) => alive(p.pid))
  for (const p of left) {
    try {
      process.kill(p.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  return left
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
  // The server stops every run it started: anything the fake Codex logged that still runs after that is a leak.
  const left = await killLeftovers()
  if (left.length) {
    failed = true
    console.error(`FAIL ${left.length} fake Codex process(es) outlived the server: ${JSON.stringify(left)}`)
  }
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
console.log(failed ? 'e2e:codex FAILED' : 'e2e:codex passed')
process.exit(failed ? 1 : 0)
