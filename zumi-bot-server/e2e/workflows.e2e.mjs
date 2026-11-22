// End-to-end check of Workflows in the built server + web UI (VPS mode, for Web Push) against the FAKE workflow claude
// (backend/tests/fixtures/fake-workflow-claude.mjs): no real CLI call is ever made, so no login or quota is used.
// Usage: npm run e2e:workflows   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server, Chrome and the fake push server started here are stopped in `finally`; overall timeout 5 min.
// The fake answers a Condition yes when its stdin holds YES and no when it holds NO, so a run's input (or the question)
// picks the branch; an LLM call answers "LLM:" plus its stdin; an Agent step (argv has --agent) is fake-claude.mjs.
// ZUMIBOT_TEST_WAIT_SCALE=60 makes a Wait of N minutes last N seconds. Pushes go to a local fake push service
// (ZUMIBOT_TEST_PUSH_ORIGIN) through a device enabled by a raw /ws RPC with keys made here; each is decrypted
// (RFC 8291) here. RPCs go over a fresh /ws socket from a second tab parked on a static file of the origin, so a
// navigation of the app tab never cuts one off.
//
// DOM hooks relied on (data-testid): mode-tab-workflows, workflows-waiting, workflow-row (+ data-workflow-id),
//   workflow-run-row (+ data-run-id), workflows-placeholder, new-workflow, workflow-editor, workflow-name, wf-canvas,
//   wf-node (+ data-step-id, data-state), wf-port-yes, wf-port-no, wf-port-add-<port>, wf-add, wf-add-menu,
//   wf-add-llm, wf-add-wait, wf-add-notify, wf-edge-bar, wf-edge-add, wf-edge-delete, rf__edge-<id> (React Flow's), wf-save,
//   wf-unsaved, wf-enabled, wf-more, wf-delete, wf-duplicate, wf-notice (+ data-tone), wf-run, wf-run-dialog, wf-run-input,
//   wf-run-confirm, wf-notice-run, wf-test-input, wf-test, wf-test-result, workflow-run-view (+ data-narrow),
//   wf-run-status (+ data-status), wf-stop, wf-run-step, wf-run-notrun, wf-approval, wf-approval-text,
//   wf-approval-note, wf-approve, wf-reject, wf-visit (+ data-status), wf-visit-input, wf-visit-error, wf-retry,
//   wf-open-chat, wf-chat-bar, wf-chat-bar-link, wf-timeline, wf-run-cost, wf-visit-cost, workflow-run-cost,
//   wf-run-progress, workflow-run-progress, wf-node-progress, wf-items-count, wf-items, wf-item (+ data-status, data-item-n),
//   wf-item-retry, wf-timeline-progress,
//   wf-selection-inspector, wf-selection-remove, wf-step-inspector (+ data-step-id), wf-inspector-empty, wf-inspector,
//   wf-step-name, wf-prompt, wf-notify-title, wf-discard, wf-toolbar, wf-tool-select, wf-tool-pan (+ aria-pressed),
//   wf-tool-note, wf-zoom-reset, wf-ctx-menu, wf-ctx-<action> (+ aria-disabled); wf-canvas's data-pan; React Flow's
//   .react-flow__node.selected, .react-flow__edge[aria-label] and .react-flow__viewport (its transform is the view).
//   Notes: wf-note (+ data-note-id, data-color), wf-note-input, wf-note-bar, wf-note-color, wf-note-colors,
//   wf-note-swatch-<n>, wf-note-custom, wf-note-hex, wf-note-recent, .markdown-img-alt; React Flow's
//   .react-flow__node-note[data-id] (its transform is the note's place, its offset size the note's) and its resizer's
//   .react-flow__resize-control.handle.bottom.right.
//   Groups: wf-group (+ data-group-id, data-broken), wf-group-head, wf-group-toggle, wf-group-name, wf-group-name-input,
//   wf-group-desc, wf-group-desc-input, wf-group-warn, wf-group-collapsed (+ data-group-id, data-state), wf-group-count,
//   wf-node-state, wf-canvas-group-inspector (+ data-group-id), wf-canvas-group-name, wf-canvas-group-count; React Flow's
//   .react-flow__node-groupBox / -groupCollapsed[data-id] (their transform is the place), the collapsed node's
//   .react-flow__handle.target and each edge's path.react-flow__edge-path (its ends must meet the handles).
//   Audit log: wf-run-tabs, wf-tab-canvas, wf-tab-audit, wf-audit (+ data-state), wf-audit-pending, wf-audit-trigger,
//   wf-audit-entry (+ data-step-id, data-kind, data-status), wf-audit-input, wf-audit-output, wf-audit-edited,
//   wf-audit-reason, wf-audit-note, wf-audit-asked, wf-audit-sent, wf-audit-item (+ data-item-n), wf-audit-carried,
//   wf-audit-end (+ data-status); on a phone the log's wf-retry and wf-item-retry.
//   New steps (case 20): wf-port-error, wf-http-method, wf-http-key, wf-on-failure, wf-visit-request, wf-visit-handled,
//   wf-open-run, wf-run-parent, wf-audit-request, wf-audit-handled, wf-audit-open-run.
//   Run at once and History (case 21): wf-foreach-concurrency, wf-foreach-concurrency-hint, wf-history, history-dialog,
//   history-row (+ data-current), history-current, history-changes, history-restore, history-close.
//   Routine parity (cases 22-26): wf-from (the "from workflow" line on a message a Chat step sent), chat-row (+ data-chat-id),
//   agent-row (+ data-agent-name), agent-toggle (+ aria-expanded), wf-chat-bar (absent in a Chat step's chat).
// Stored state read: <dataDir>/chats.json, <dataDir>/chats/<id>.json, the fake's argv log, FAKE_INVOCATIONS_OUT (each agent
// run's argv: a Start fresh run has no --resume) and FAKE_STDIN_OUT (the last agent run's stdin), localStorage cb.wf.collapsed.<id>. Cases 16, 17 and 18
// copy and paste through headless Chrome's own clipboard (real Ctrl+C, Ctrl+V), and case 16 dispatches synthetic paste
// events only where the brief names text it chose.

import { createDecipheriv, createECDH, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { freePort, start, unexpectedErrors, pickOption, selectValue } from './harness.mjs'

const FAKE = fileURLToPath(new URL('../backend/tests/fixtures/fake-workflow-claude.mjs', import.meta.url))
const AGENT = 'e2e-workflow-agent'
const AGENT2 = 'e2e-workflow-second' // has the /digest command (case 25) and is the Room step's second member (case 24)
const LIMIT_SKIP_TEXT = 'Skipped at the usage limit'
const PREFIX = 'zumibot-e2e-workflows-'
const OVERALL_TIMEOUT = 5 * 60_000
const T = 15_000
const DEVICE = 'e2e-workflow-device'
const EDITED = 'EDITED-SUMMARY-91'
const NOTE = 'NOTE-FROM-E2E-7'
const PAYLOAD_KEYS = ['v', 'kind', 'tag', 'chatId', 'title', 'agent', 'at', 'run', 'body', 'message']
const CAP_TEXT = 'Ran too many times'
const CASES = 26

let h = null
let push = null
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
const node = (page, stepId) => page.locator(`${tid('wf-node')}[data-step-id="${stepId}"]`)

async function waitFor(fn, timeout, what) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`ASSERT FAILED: timed out after ${timeout} ms waiting for ${what}`)
}

async function stop() {
  if (h) {
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
  if (push) {
    const p = push
    push = null
    p.server.closeAllConnections()
    await new Promise((r) => p.server.close(r))
  }
}

// ---------- the fake push service and RFC 8291 decrypt (as in e2e:notifications), kept apart from the code under test ----------
async function startPushServer() {
  const port = await freePort()
  const got = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      got.push({ method: req.method, path: req.url, headers: req.headers, body: Buffer.concat(chunks) })
      res.writeHead(201).end()
    })
  })
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${port}`, server, got }
}

function decrypt(body, uaPrivate, auth) {
  const salt = body.subarray(0, 16)
  const idLen = body[20]
  const asPublic = body.subarray(21, 21 + idLen)
  const ct = body.subarray(21 + idLen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const uaPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  assert(plain[plain.length - 1] === 2, 'the push record does not end with the last-record delimiter')
  return plain.subarray(0, plain.length - 1).toString('utf8')
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
const visitsOf = (r, stepId) => r.visits.filter((v) => v.stepId === stepId)
const storedChats = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats

// ---------- workflow builders: ids double as handles ----------
const step = (id, kind, name, x, y, extra = {}) => ({ id, handle: id, name, kind, x, y, ...extra })
const edge = (from, port, to) => ({ id: `${from}-${port}-${to}`, from, port, to })
const draft = (name, steps, edges, over = {}) => ({
  id: null,
  name,
  enabled: true,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps,
  edges,
  ...over
})
async function save(input) {
  const w = await rpc('workflows:save', input)
  // Saved on: a save never turns on a workflow with problems, so this proves it has none.
  assert(w.enabled === input.enabled, `"${input.name}" saved with enabled ${w.enabled}, so it has problems`)
  return w
}

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const folder = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  const logs = await mk('logs')
  const argsOut = join(logs, 'bare-args.jsonl')
  // Case 16: while the hold file exists an agent turn on a "#HOLD" item waits; while the fail file exists "#FAIL" fails.
  const holdFile = join(logs, 'agent-hold')
  const failFile = join(logs, 'agent-fail')
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Workflows e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  await writeFile(
    join(agentsDir, `${AGENT2}.md`),
    `---\nname: ${AGENT2}\ndescription: Workflows e2e second agent.\nmodel: haiku\ncommands:\n  - name: digest\n    description: Make a digest.\n    prompt: |\n      Make a digest of: $ARGUMENTS\n---\nYou are a second test agent.\n`
  )
  // Cases 22-26: every agent run's argv (a Chat step's Start fresh leaves no --resume) and the last run's stdin (a command's filled prompt).
  const invocations = join(logs, 'invocations.jsonl')
  const stdinOut = join(logs, 'stdin.txt')
  push = await startPushServer()
  h = await start({
    mode: 'vps',
    fake: FAKE,
    dataDir,
    agentsDir,
    env: {
      ZUMIBOT_TEST_PUSH_ORIGIN: push.origin,
      ZUMIBOT_TEST_WAIT_SCALE: '60',
      FAKE_WORKFLOW_ARGS_OUT: argsOut,
      FAKE_AGENT_HOLD_FILE: holdFile,
      FAKE_AGENT_FAIL_FILE: failFile,
      FAKE_INVOCATIONS_OUT: invocations,
      FAKE_STDIN_OUT: stdinOut
    }
  })
  const page = h.page
  // Every workflows:save the app sends (the page's own socket), for New → Save → New.
  const saves = []
  page.on('websocket', (ws) =>
    ws.on('framesent', (f) => {
      try {
        const m = JSON.parse(String(f.payload))
        if (m.method === 'workflows:save') saves.push(m.args[0])
      } catch {
        /* not ours */
      }
    })
  )
  await page.locator(tid('mode-tab-workflows')).waitFor({ timeout: 30_000 })
  rpcPage = await h.newPage()
  await rpcPage.goto(`${h.origin}/favicon.png`)
  assert(new URL(rpcPage.url()).pathname === '/favicon.png', `the RPC tab landed on ${rpcPage.url()}`)
  // A new tab comes to the front: the app tab behind it gets no animation frames, which stalls every click on it.
  await page.bringToFront()

  // The push device: a subscription a browser would make, pointing at the fake push service.
  const ua = createECDH('prime256v1')
  ua.generateKeys()
  const auth = randomBytes(16)
  const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
  await rpc('notify:enable', DEVICE, { channel: 'push', label: 'e2e', subscription: { endpoint: `${push.origin}/wf`, keys } })
  const pushes = () => push.got.map((g) => JSON.parse(decrypt(g.body, ua.getPrivateKey(), auth)))
  async function waitPush(pred, what) {
    let found = null
    await waitFor(async () => (found = pushes().find(pred) ?? null) !== null, T, what)
    assert(
      Object.keys(found).every((k) => PAYLOAD_KEYS.includes(k)),
      `a push has extra fields: ${Object.keys(found)}`
    )
    return found
  }
  ok('push device enabled against the fake push service')

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

  const runUrl = (wid, runId) => `${h.origin}/workflows/${wid}/runs/${runId}`
  // What must never push: a stopped run, an Agent step chat's reply. Checked again at the end, after any late push.
  const silent = { runs: [], chats: [] }
  let triage = null
  let r2 = null
  let r8a = null

  await runCase(
    1,
    'build trigger → Condition(yes/no LLM) → Approval → Notify by RPC; the editor shows nodes, port names and a step test',
    async () => {
      // The main workflow: trigger → Condition (yes: LLM, no: LLM) → Approval → Notify.
      triage = await save(
        draft(
          'Triage flow',
          [
            step('trig', 'trigger', 'Trigger', 0, 120),
            step('check', 'condition', 'Ready?', 260, 120, { question: 'Is this ready to act on?', model: 'haiku' }),
            step('yes-sum', 'llm', 'Good news', 540, 0, { prompt: 'Summarise the good news', model: 'haiku' }),
            step('no-sum', 'llm', 'Follow-up', 540, 240, { prompt: 'Draft a follow-up question', model: 'haiku' }),
            step('approve', 'approval', 'Send it?', 820, 120, { question: 'Send this summary?', editable: true }),
            step('tell', 'notify', 'Tell me', 1100, 120, { title: 'Triage done', body: '{{input}}' })
          ],
          [
            edge('trig', 'out', 'check'),
            edge('check', 'yes', 'yes-sum'),
            edge('check', 'no', 'no-sum'),
            edge('yes-sum', 'out', 'approve'),
            edge('no-sum', 'out', 'approve'),
            edge('approve', 'approved', 'tell')
          ]
        )
      )
      await page.click(tid('mode-tab-workflows'))
      await page.locator(`${tid('workflow-row')}[data-workflow-id="${triage.id}"] .routine-row`).click()
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 6, T, 'six steps on the canvas')
      const names = (await page.locator('.wf-node-name').allTextContents()).map((s) => s.trim()).sort()
      assert(
        JSON.stringify(names) === JSON.stringify(['Follow-up', 'Good news', 'Ready?', 'Send it?', 'Tell me', 'Trigger']),
        `the nodes are ${JSON.stringify(names)}`
      )
      await waitFor(async () => (await page.locator('.react-flow__edge').count()) === 6, T, 'six edges on the canvas')
      // The lines carry no text: each branch is named at its port, as n8n does.
      assert((await page.locator('.react-flow__edge-text').count()) === 0, 'an edge still has a text label')
      const portNames = (await page.locator('.wf-port-label').allTextContents()).map((s) => s.trim()).sort()
      assert(
        JSON.stringify(portNames) === JSON.stringify(['Approved', 'No', 'Rejected', 'Yes']),
        `the port names are ${JSON.stringify(portNames)}`
      )
      for (const port of ['yes', 'no', 'approved']) {
        assert((await page.locator(`.react-flow__edge.wf-edge-${port}`).count()) === 1, `no single ${port} edge`)
      }
      assert(
        (await node(page, 'check').locator(tid('wf-port-yes')).count()) === 1 &&
          (await node(page, 'check').locator(tid('wf-port-no')).count()) === 1,
        'the Condition has no Yes/No ports'
      )
      // Only the ports nothing leaves get a +: the Approval's Rejected and the Notify's out.
      const adds = await page
        .locator('[data-testid^="wf-port-add-"]')
        .evaluateAll((els) =>
          els.map((e) => `${e.closest('[data-step-id]')?.getAttribute('data-step-id')}:${e.getAttribute('data-testid')}`).sort()
        )
      assert(
        JSON.stringify(adds) === JSON.stringify(['approve:wf-port-add-rejected', 'tell:wf-port-add-out']),
        `the free port buttons are ${JSON.stringify(adds)}`
      )
      assert((await page.locator(tid('wf-unsaved')).count()) === 0, 'opening the workflow made it unsaved')
      ok('the editor shows the six steps, Yes/No/Approved/Rejected port names, unlabelled edges and a + on each free port')

      // Run step on the Condition: a bare call with a JSON schema, nothing stored as a run.
      await node(page, 'check').click()
      await page.locator(tid('wf-test-input')).fill('YES please')
      await page.click(tid('wf-test'))
      await waitFor(
        async () =>
          /Answer:\s*Yes/.test(
            (await page
              .locator(tid('wf-test-result'))
              .textContent()
              .catch(() => '')) ?? ''
          ),
        T,
        'the step test to answer Yes'
      )
      const calls = (await readFile(argsOut, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
      const cond = calls.find((a) => a.includes('--json-schema'))
      assert(cond, 'the step test made no Condition call')
      for (const a of calls) {
        const at = (flag) => a.indexOf(flag)
        assert(at('--tools') >= 0 && a[at('--tools') + 1] === '', `a bare call has tools: ${JSON.stringify(a)}`)
        assert(at('--setting-sources') >= 0 && a[at('--setting-sources') + 1] === '', 'a bare call reads settings')
        assert(a.includes('--strict-mcp-config') && a.includes('--no-session-persistence'), 'a bare call may use MCP or a session')
        assert(
          !a.includes('--dangerously-skip-permissions') && !a.some((x) => /bypassPermissions/.test(x)),
          'a bare call skips permissions'
        )
        assert(!a.includes('--agent'), 'a bare call names an agent')
      }
      assert(((await rpc('workflows:list')).runs[triage.id] ?? []).length === 0, 'the step test stored a run')
      ok('Run step answers Yes; every bare call so far has no tools, settings, MCP, session or agent')
    }
  )

  await runCase(
    2,
    'run by hand with input YES: the yes branch runs, Approval waits, the rail dot shows, a "needs your approval" push arrives',
    async () => {
      await page.click(tid('wf-run'))
      await page.locator(tid('wf-run-dialog')).waitFor({ timeout: T })
      await page.locator(tid('wf-run-input')).fill('YES')
      await page.click(tid('wf-run-confirm'))
      await page.locator(tid('wf-notice-run')).click({ timeout: T })
      await page.waitForURL(/\/workflows\/[^/]+\/runs\/[^/]+$/, { timeout: T })
      const runId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
      r2 = await runUntil(runId, (r) => r.status === 'waiting', 'the run to wait on the approval')
      assert(r2.via === 'manual' && r2.input === 'YES', `the run has via ${r2.via}, input ${JSON.stringify(r2.input)}`)
      assert(
        visitsOf(r2, 'check')[0]?.port === 'yes' && visitsOf(r2, 'check')[0]?.output === 'YES',
        'the Condition did not leave by yes passing its input through'
      )
      assert(visitsOf(r2, 'yes-sum')[0]?.status === 'done' && visitsOf(r2, 'no-sum').length === 0, 'not exactly the yes branch ran')
      assert(visitsOf(r2, 'approve')[0]?.status === 'waiting', 'the Approval is not waiting')
      await page.locator(tid('workflows-waiting')).waitFor({ timeout: T })
      const p = await waitPush((x) => x.kind === 'waiting' && x.run?.runId === runId, 'the approval push')
      assert(p.title === 'Triage flow needs your approval', `the approval push is titled ${JSON.stringify(p.title)}`)
      assert(
        p.tag === `workflow:${runId}:waiting` && p.chatId === null && p.run.workflowId === triage.id && p.body === undefined,
        `the approval push is ${JSON.stringify(p)}`
      )
      // The audit log is for an ended run: while this one waits its tab shows only a note, at the /audit address.
      await page.click(tid('wf-tab-audit'))
      await page.waitForURL(`${runUrl(triage.id, runId)}/audit`, { timeout: T })
      const pending = page.locator(`${tid('wf-audit')}[data-state="pending"]`)
      await pending.waitFor({ timeout: T })
      assert(
        ((await pending.textContent()) ?? '').includes('The audit log shows once this run ends.'),
        `the pending note reads ${JSON.stringify(await pending.textContent())}`
      )
      ok(`run ${runId} waits on its approval; the rail dot and the push show it, and its audit log tab says it shows once the run ends`)
    }
  )

  await runCase(
    3,
    'edit the approval text and add a note on the page, Approve: the Notify push carries title and body, the run is done',
    async () => {
      await page.click(tid('wf-tab-canvas')) // case 2 left the Audit log tab open
      // A second tab stays on the waiting run's Audit log: when the run ends its note becomes the log, with no reload.
      const watcher = await h.newPage()
      await watcher.goto(`${runUrl(triage.id, r2.id)}/audit`)
      await watcher.locator(`${tid('wf-audit')}[data-state="pending"]`).waitFor({ timeout: T })
      await page.bringToFront() // a tab behind gets no animation frames, which stalls clicks on it
      const box = page.locator(tid('wf-approval'))
      await box.waitFor({ timeout: T })
      const waiting = visitsOf(r2, 'approve')[0]
      assert((await page.locator(tid('wf-approval-text')).inputValue()) === waiting.input, 'the approval box does not hold the step input')
      assert(waiting.input.startsWith('LLM:'), `the approval input is not the yes LLM's output: ${waiting.input.slice(0, 40)}`)
      // The yes LLM's $0.01 (the fake Condition reports $0); the run still waits, so it may spend more.
      const costOf = async (sel) =>
        await page
          .locator(sel)
          .textContent({ timeout: 500 })
          .catch(() => null)
      await waitFor(async () => (await costOf(tid('wf-run-cost'))) === '$0.01 so far', T, 'the header to show the cost so far')
      await page.locator(tid('wf-approval-text')).fill(EDITED)
      await page.locator(tid('wf-approval-note')).fill(NOTE)
      await page.click(tid('wf-approve'))
      const done = await runUntil(r2.id, ended, 'the run to end after Approve')
      assert(done.status === 'done', `the run ended ${done.status}: ${done.error}`)
      await watcher.bringToFront() // to read it; bringing a tab forward reloads nothing
      await watcher.locator(`${tid('wf-audit')}[data-state="ready"]`).waitFor({ timeout: T })
      assert(watcher.url() === `${runUrl(triage.id, r2.id)}/audit`, `the watching tab moved to ${watcher.url()}`)
      await watcher.close()
      await page.bringToFront()
      const answered = visitsOf(done, 'approve')[0]
      assert(
        answered.port === 'approved' && answered.output === `${EDITED}\n\nNote from the user: ${NOTE}`,
        `the approval output is ${JSON.stringify(answered.output)}`
      )
      const told = visitsOf(done, 'tell')[0]
      assert(
        told?.status === 'done' && told.input.includes(EDITED) && told.input.includes(NOTE),
        'the Notify step did not get the edited text'
      )
      const p = await waitPush((x) => x.kind === 'workflow' && x.run?.runId === r2.id, 'the Notify push')
      assert(
        p.title === 'Triage done' && p.body.includes(EDITED) && p.body.includes(`Note from the user: ${NOTE}`),
        `the Notify push is ${JSON.stringify(p)}`
      )
      assert(
        p.tag === `workflow:${r2.id}` && p.chatId === null && p.run.workflowId === triage.id,
        `the Notify push slot is ${JSON.stringify(p)}`
      )
      assert(p.message === told.id, `the Notify push names message ${JSON.stringify(p.message)}, not its visit ${told.id}`)
      await waitFor(
        async () => (await page.locator(`${tid('wf-run-status')}[data-status="done"]`).count()) === 1,
        T,
        'the page to show the run done'
      )
      assert(
        visitsOf(done, 'yes-sum')[0]?.costUsd === 0.01 && done.visits.filter((v) => v.costUsd).length === 1,
        `the visits' costs are ${JSON.stringify(done.visits.map((v) => v.costUsd ?? null))}`
      )
      await waitFor(async () => (await costOf(tid('wf-run-cost'))) === '$0.01', T, 'the header to show the run cost')
      await waitFor(
        async () => (await costOf(`${tid('workflow-run-row')}[data-run-id="${r2.id}"] ${tid('workflow-run-cost')}`)) === '$0.01',
        T,
        "the run's sidebar row to show its cost"
      )
      await node(page, 'yes-sum').click()
      await waitFor(
        async () => (await costOf(`${tid('wf-run-step')} ${tid('wf-visit-cost')}`)) === '$0.01',
        T,
        'the LLM visit to show its cost'
      )
      await node(page, 'tell').click()
      assert((await page.locator(`${tid('wf-run-step')} ${tid('wf-visit-cost')}`).count()) === 0, 'the Notify visit shows a cost')
      await waitFor(
        async () =>
          (
            (await page
              .locator(`${tid('wf-run-step')} ${tid('wf-visit-input')}`)
              .textContent()
              .catch(() => '')) ?? ''
          ).includes(EDITED),
        T,
        "the Notify step's input to show the edited text"
      )
      await waitFor(async () => (await page.locator(tid('workflows-waiting')).count()) === 0, T, 'the rail dot to go')

      // The Audit log tab of the ended run: trigger first, then each visit by start time, per-kind boxes, the end line.
      await page.click(tid('wf-tab-audit'))
      await page.waitForURL(`${runUrl(triage.id, r2.id)}/audit`, { timeout: T })
      const log = page.locator(`${tid('wf-audit')}[data-state="ready"]`)
      await log.waitFor({ timeout: T })
      const has = async (loc, text) => ((await loc.first().textContent({ timeout: T })) ?? '').includes(text)
      const trigger = log.locator(tid('wf-audit-trigger'))
      assert(await has(trigger, 'YES'), 'the audit trigger does not hold the run input YES')
      const entries = log.locator(tid('wf-audit-entry'))
      const shown = await entries.evaluateAll((els) => els.map((e) => e.getAttribute('data-step-id')))
      const expected = done.visits
        .filter((v) => v.stepId !== 'trig')
        .sort((a, b) => a.startedAt - b.startedAt)
        .map((v) => v.stepId)
      assert(
        JSON.stringify(shown) === JSON.stringify(expected) && expected.join(',') === 'check,yes-sum,approve,tell',
        `the log shows ${JSON.stringify(shown)}, the visits are ${JSON.stringify(expected)}`
      )
      assert(
        await trigger.evaluate((t) =>
          Boolean(t.compareDocumentPosition(document.querySelector('[data-testid="wf-audit-entry"]')) & Node.DOCUMENT_POSITION_FOLLOWING)
        ),
        'the trigger does not come before the first entry'
      )
      const entry = (id) => log.locator(`${tid('wf-audit-entry')}[data-step-id="${id}"]`)
      assert(
        (await entry('check').locator(tid('wf-audit-reason')).count()) === 1 &&
          (await entry('check').locator(tid('wf-audit-output')).count()) === 0,
        'the Condition entry lacks its reason or still shows an Output'
      )
      const out = entry('approve').locator(tid('wf-audit-output'))
      assert(
        (await has(out, EDITED)) && (await out.locator(tid('wf-audit-edited')).count()) === 1,
        'the Approval output lacks the edited text or its edited tag'
      )
      assert(await has(entry('approve').locator(tid('wf-audit-note')), NOTE), 'the Approval entry lacks the note')
      assert(await has(entry('tell').locator(tid('wf-audit-sent')), 'Triage done'), 'the Notify entry does not show what it sent')
      const end = log.locator(`${tid('wf-audit-end')}[data-status="done"]`)
      await end.waitFor({ timeout: T })
      assert(await has(end, '$0.01'), `the end line reads ${JSON.stringify(await end.textContent())}`)
      await page.reload()
      await page.locator(`${tid('wf-audit')}[data-state="ready"]`).waitFor({ timeout: T })
      await page.goBack()
      await page.locator(tid('wf-canvas')).waitFor({ timeout: T })
      assert(page.url() === runUrl(triage.id, r2.id), `Back went to ${page.url()}`)
      await page.goto(`${runUrl(triage.id, 'nope')}/audit`)
      await page.locator(tid('workflow-run-unavailable')).waitFor({ timeout: T })
      ok(
        'Approve sends the edited text on; Notify pushes "Triage done" with it; the run is done, costs $0.01 (header, row, visit) and the dot is gone; its audit log lists check, yes-sum, approve, tell with the reason, the edited output and note, what Notify sent and a $0.01 end line, survives a reload, Back returns to the canvas, and a missing run is unavailable'
      )
    }
  )

  await runCase(4, 'run with NO: the no branch runs and the yes branch shows "not run"; Reject ends the branch', async () => {
    const { id: runId } = await rpc('workflows:run', triage.id, 'NO')
    const r = await runUntil(runId, (x) => x.status === 'waiting', 'the NO run to wait on the approval')
    assert(
      visitsOf(r, 'check')[0]?.port === 'no' && visitsOf(r, 'no-sum')[0]?.status === 'done' && visitsOf(r, 'yes-sum').length === 0,
      'not exactly the no branch ran'
    )
    await page.locator(`${tid('workflow-run-row')}[data-run-id="${runId}"]`).click({ timeout: T })
    await page.waitForURL(runUrl(triage.id, runId), { timeout: T })
    await page.locator(tid('wf-approval')).waitFor({ timeout: T })
    await waitFor(async () => (await node(page, 'no-sum').getAttribute('data-state')) === 'done', T, 'the no branch to show done')
    assert((await node(page, 'yes-sum').getAttribute('data-state')) === null, 'the yes branch shows a state')
    // The edges the run sent something along are green; the branch not taken and what comes after the approval are not.
    const carried = async (id) => /\bcarried\b/.test((await page.locator(tid(`rf__edge-${id}`)).getAttribute('class')) ?? '')
    for (const id of ['trig-out-check', 'check-no-no-sum', 'no-sum-out-approve'])
      assert(await carried(id), `${id} is not marked as carried`)
    for (const id of ['check-yes-yes-sum', 'yes-sum-out-approve', 'approve-approved-tell'])
      assert(!(await carried(id)), `${id} is marked as carried`)
    assert(
      (await page.locator('[data-testid^="wf-port-add-"]').count()) === 0 && (await page.locator(tid('wf-edge-bar')).count()) === 0,
      'the read-only run view offers + or trash'
    )
    await node(page, 'yes-sum').click()
    await page.locator(tid('wf-run-notrun')).waitFor({ timeout: T })
    await node(page, 'approve').click()
    await page.click(tid('wf-reject'))
    const done = await runUntil(runId, ended, 'the run to end after Reject')
    assert(
      done.status === 'done' && visitsOf(done, 'approve')[0].port === 'rejected' && visitsOf(done, 'tell').length === 0,
      `Reject left ${done.status} with ${visitsOf(done, 'tell').length} Notify visits`
    )
    ok('the NO run took the no branch (its edges green), the yes branch reads "not run", and Reject with nothing drawn ends it done')
  })

  let longWait = null
  await runCase(
    5,
    'a Wait of 1 min with ZUMIBOT_TEST_WAIT_SCALE=60 continues after about 1 s; Stop ends a waiting run silently',
    async () => {
      const w = await save(
        draft(
          'Wait flow',
          [
            step('trig', 'trigger', 'Trigger', 0, 0),
            step('pause', 'wait', 'Pause', 260, 0, { minutes: 1 }),
            step('after', 'llm', 'After', 520, 0, { prompt: 'After the wait', model: 'haiku' })
          ],
          [edge('trig', 'out', 'pause'), edge('pause', 'out', 'after')]
        )
      )
      const { id: runId } = await rpc('workflows:run', w.id, 'hold')
      const done = await runUntil(runId, ended, 'the Wait run to end', 15_000)
      assert(done.status === 'done', `the Wait run ended ${done.status}`)
      const v = visitsOf(done, 'pause')[0]
      assert(v.until - v.startedAt === 1_000, `the Wait was armed for ${v.until - v.startedAt} ms, not 1 000`)
      const took = v.endedAt - v.startedAt
      assert(took >= 950 && took < 5_000, `the Wait took ${took} ms`)
      assert(v.output === 'hold' && visitsOf(done, 'after')[0]?.input === 'hold', 'the Wait did not pass its input through')
      ok(`the 1-minute Wait ended after ${took} ms and passed its input on`)

      // Stop in the run view clears a Wait: the run is stopped, nothing after it runs, and no failure is pushed.
      longWait = await save(
        draft(
          'Long wait',
          [
            step('trig', 'trigger', 'Trigger', 0, 0),
            step('hold', 'wait', 'Hold', 260, 0, { minutes: 12 }),
            step('after', 'llm', 'After', 520, 0, { prompt: 'After the long wait', model: 'haiku' })
          ],
          [edge('trig', 'out', 'hold'), edge('hold', 'out', 'after')]
        )
      )
      const { id: stopRun } = await rpc('workflows:run', longWait.id, 'never')
      await page.goto(runUrl(longWait.id, stopRun))
      await page.click(tid('wf-stop'), { timeout: T })
      const stopped = await runUntil(stopRun, ended, 'the stopped run to end')
      assert(
        stopped.status === 'stopped' && visitsOf(stopped, 'hold')[0].status === 'stopped' && visitsOf(stopped, 'after').length === 0,
        `Stop left the run ${stopped.status}`
      )
      await waitFor(
        async () => (await page.locator(`${tid('wf-run-status')}[data-status="stopped"]`).count()) === 1,
        T,
        'the page to show the run stopped'
      )
      assert((await page.locator(tid('wf-stop')).count()) === 0, 'Stop still shows on a stopped run')
      assert(!pushes().some((x) => x.run?.runId === stopRun), 'the stopped run sent a push')
      silent.runs.push(stopRun)
      ok('Stop in the run view ended the waiting run as stopped, silently')
    }
  )

  await runCase(6, 'a loop that always answers no fails at 20 with "Ran too many times"; Retry shows and the step runs again', async () => {
    const w = await save(
      draft(
        'Loop flow',
        [
          step('trig', 'trigger', 'Trigger', 0, 0),
          step('poll', 'llm', 'Poll', 260, 0, { prompt: 'Poll the build', model: 'haiku' }),
          // NO in the question: the fake answers no whatever the poll says.
          step('check', 'condition', 'Finished?', 520, 0, { question: 'Did it finish? (fake answer: NO)', model: 'haiku' }),
          step('end', 'llm', 'Report', 780, 0, { prompt: 'Report it', model: 'haiku' })
        ],
        [edge('trig', 'out', 'poll'), edge('poll', 'out', 'check'), edge('check', 'no', 'poll'), edge('check', 'yes', 'end')]
      )
    )
    const { id: runId } = await rpc('workflows:run', w.id, 'v1')
    const r = await runUntil(runId, ended, 'the loop to hit the cap', 60_000)
    const polls = visitsOf(r, 'poll')
    assert(r.status === 'failed' && r.error === CAP_TEXT, `the loop ended ${r.status}: ${r.error}`)
    assert(
      polls.filter((v) => v.status === 'done').length === 20 &&
        polls.at(-1).status === 'failed' &&
        polls.at(-1).error === CAP_TEXT &&
        polls.at(-1).n === 21,
      'the poll did not fail at its 21st visit'
    )
    assert(
      visitsOf(r, 'check').filter((v) => v.status === 'done').length === 20 && visitsOf(r, 'end').length === 0,
      'the check did not answer no 20 times'
    )
    const failed = await waitPush((x) => x.kind === 'routine-failed' && x.run?.runId === runId, 'the run-failed push')
    assert(failed.title === 'Loop flow' && failed.tag === `workflow:${runId}`, `the failed push is ${JSON.stringify(failed)}`)

    await page.goto(runUrl(w.id, runId))
    await waitFor(
      async () =>
        (await node(page, 'poll')
          .getAttribute('data-state')
          .catch(() => null)) === 'failed',
      T,
      'the poll to show failed'
    )
    await node(page, 'poll').click()
    const capped = page.locator(`${tid('wf-run-step')} ${tid('wf-visit')}[data-status="failed"]`)
    await waitFor(async () => (await capped.count()) === 1, T, 'one failed poll visit')
    assert(
      ((await capped.locator(tid('wf-visit-error')).textContent()) ?? '').includes(CAP_TEXT),
      'the failed visit does not say "Ran too many times"'
    )
    await capped.locator(tid('wf-retry')).click()
    const again = await runUntil(runId, (x) => ended(x) && x.visits.length > r.visits.length, 'the retried run to end again', 60_000)
    const polls2 = visitsOf(again, 'poll')
    const checks = visitsOf(again, 'check')
    // Retry gives every step at its allowance 20 more (the check was at 20 too), so the whole loop runs 20 more rounds
    // and the poll hits the cap again at its 42nd visit.
    assert(
      polls2.filter((v) => v.status === 'done').length === 40 && checks.filter((v) => v.status === 'done').length === 40,
      `after Retry the poll ran ${polls2.filter((v) => v.status === 'done').length} times and the check ${checks.filter((v) => v.status === 'done').length}`
    )
    assert(
      again.status === 'failed' && polls2.at(-1).status === 'failed' && polls2.at(-1).error === CAP_TEXT && polls2.at(-1).n === 42,
      `after Retry the run is ${again.status}, the poll's last visit ${polls2.at(-1).status} (${polls2.at(-1).n})`
    )
    ok('the loop failed at the cap with Retry offered; one Retry ran poll and check 20 more rounds each before the cap again')
  })

  await runCase(
    7,
    'an Agent step makes a dated workflow chat whose reply is the output; the chat is archived, Open chat shows the workflow bar and its link returns',
    async () => {
      const w = await save(
        draft(
          'Agent flow',
          [
            step('trig', 'trigger', 'Trigger', 0, 0),
            step('agent', 'agent', 'Agent', 260, 0, { agent: AGENT, prompt: 'Say hello', cwd: folder })
          ],
          [edge('trig', 'out', 'agent')]
        )
      )
      const day = () => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(Date.now())
      const before = day()
      const { id: runId } = await rpc('workflows:run', w.id, 'hi')
      const done = await runUntil(runId, ended, 'the Agent run to end', 30_000)
      assert(done.status === 'done', `the Agent run ended ${done.status}: ${done.error}`)
      const v = visitsOf(done, 'agent')[0]
      assert(v.output === 'pong' && v.chatId, `the Agent step output is ${JSON.stringify(v.output)}`)
      let meta = null
      await waitFor(
        async () => (meta = (await storedChats()).find((c) => c.id === v.chatId)) && (meta.archivedAt ?? 0) > (meta.unarchivedAt ?? 0),
        T,
        'the step chat to be archived'
      )
      assert(
        [`Agent flow · Agent · ${before}`, `Agent flow · Agent · ${day()}`].includes(meta.title),
        `the chat is titled ${JSON.stringify(meta.title)}`
      )
      assert(
        meta.agentName === AGENT && meta.workflow?.workflowId === w.id && meta.workflow.runId === runId && meta.workflow.stepId === 'agent',
        `the chat's workflow link is ${JSON.stringify(meta.workflow)}`
      )
      assert(!pushes().some((p) => p.chatId === v.chatId), "the step chat's reply sent a push")
      silent.chats.push(v.chatId)

      await page.goto(runUrl(w.id, runId))
      await node(page, 'agent').click({ timeout: T })
      await page.locator(`${tid('wf-run-step')} ${tid('wf-open-chat')}`).click({ timeout: T })
      await page.waitForURL(new RegExp(`/${encodeURIComponent(v.chatId)}$`), { timeout: T })
      const bar = page.locator(tid('wf-chat-bar'))
      await bar.waitFor({ timeout: T })
      assert(
        ((await bar.textContent()) ?? '').includes('Step "Agent" of workflow Agent flow'),
        `the workflow bar reads ${JSON.stringify(await bar.textContent())}`
      )
      await page.click(tid('wf-chat-bar-link'))
      await page.waitForURL(runUrl(w.id, runId), { timeout: T })
      await page.locator(tid('workflow-run-view')).waitFor({ timeout: T })
      ok(`step chat "${meta.title}" answered "pong", is archived and pushed nothing; its bar links back to the run`)
    }
  )

  await runCase(8, 'restart the server mid-approval and mid-wait: the approval still waits, the wait finishes', async () => {
    const { id: approvalRun } = await rpc('workflows:run', triage.id, 'YES')
    r8a = await runUntil(approvalRun, (x) => x.status === 'waiting', 'the approval run to wait')
    const { id: waitRun } = await rpc('workflows:run', longWait.id, 'later')
    const held = await runUntil(waitRun, (x) => visitsOf(x, 'hold')[0]?.until !== undefined, 'the long Wait to be armed')
    const until = visitsOf(held, 'hold')[0].until
    assert(until - visitsOf(held, 'hold')[0].startedAt === 12_000, 'the long Wait is not armed for 12 s')
    await page.locator(tid('workflows-waiting')).waitFor({ timeout: T })

    await h.restartServer()
    assert(Date.now() < until - 1_000, 'the restart took longer than the Wait, so it proves nothing')
    const mid = await getRun(waitRun)
    assert(
      mid.status === 'running' && visitsOf(mid, 'hold')[0].status === 'running' && visitsOf(mid, 'hold')[0].until === until,
      'the Wait did not survive the restart as stored'
    )
    const still = await getRun(approvalRun)
    assert(
      still.status === 'waiting' && visitsOf(still, 'approve')[0].status === 'waiting',
      `after the restart the approval run is ${still.status}`
    )
    const done = await runUntil(waitRun, ended, 'the long Wait to finish after the restart', 30_000)
    const v = visitsOf(done, 'hold')[0]
    assert(
      done.status === 'done' && v.status === 'done' && v.endedAt >= until && visitsOf(done, 'after')[0]?.status === 'done',
      `after the restart the Wait run is ${done.status}`
    )
    await page.locator(tid('workflows-waiting')).waitFor({ timeout: T })
    ok('after a restart the approval still waits (rail dot back) and the re-armed Wait ended on time')
  })

  await runCase(9, 'a GitHub-signed webhook → 202 and a run; a filter mismatch → a skipped run; a bad signature → 401', async () => {
    const w = await save(
      draft(
        'Hook flow',
        [
          step('trig', 'trigger', 'Trigger', 0, 0),
          step('review', 'llm', 'Review', 260, 0, { prompt: 'Review PR {{trigger.body.number}}', model: 'haiku' })
        ],
        [edge('trig', 'out', 'review')],
        { trigger: { kind: 'webhook', sample: null, filters: [{ field: 'body.action', equals: 'opened' }] } }
      )
    )
    const hook = await rpc('workflows:webhook', w.id)
    assert(hook.url === `${h.origin}/hooks/${w.id}`, `the hook URL is ${hook.url}`)
    const sign = (secret, body) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
    const call = (body, signature) =>
      fetch(hook.url, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', 'X-Hub-Signature-256': signature },
        body
      })

    const opened = JSON.stringify({ action: 'opened', number: 7 })
    const res = await call(opened, sign(hook.secret, opened))
    const out = await res.json()
    assert(res.status === 202 && out.runId && !out.skipped, `the signed call got ${res.status} ${JSON.stringify(out)}`)
    const run = await runUntil(out.runId, ended, 'the webhook run to end')
    assert(
      run.status === 'done' && run.via === 'webhook' && run.call?.body?.action === 'opened',
      `the webhook run is ${run.status} via ${run.via}`
    )
    assert(visitsOf(run, 'review')[0]?.output?.includes('7'), 'the review step did not get the PR number')

    const closed = JSON.stringify({ action: 'closed', number: 8 })
    const res2 = await call(closed, sign(hook.secret, closed))
    const out2 = await res2.json()
    assert(res2.status === 202 && out2.runId && out2.skipped === true, `the filtered call got ${res2.status} ${JSON.stringify(out2)}`)
    const skipped = await getRun(out2.runId)
    assert(
      skipped.status === 'skipped' && skipped.error === 'Filter did not match' && skipped.visits.length === 0,
      `the filtered call made a ${skipped.status} run: ${skipped.error}`
    )

    const bad = await call(opened, sign(`${hook.secret}x`, opened))
    assert(bad.status === 401, `a bad signature got ${bad.status}`)
    const runs = (await rpc('workflows:list')).runs[w.id] ?? []
    assert(runs.length === 2, `the hook has ${runs.length} runs, not 2`)
    ok('signed call ran; filtered call is a skipped run with its reason; a bad signature is a 401 and starts nothing')
  })

  await runCase(10, 'phone viewport (375×812): the run view is a list, and Approve works', async () => {
    const ctx = await h.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true })
    try {
      const phone = await ctx.newPage()
      await phone.goto(runUrl(triage.id, r8a.id))
      const view = phone.locator(tid('workflow-run-view'))
      await view.waitFor({ timeout: 30_000 })
      assert((await view.getAttribute('data-narrow')) === 'true', 'the run view is not the phone list')
      await phone.locator(tid('wf-timeline')).waitFor({ timeout: T })
      assert((await phone.locator(tid('wf-canvas')).count()) === 0, 'the phone shows the canvas')
      assert(
        (await phone.locator(`${tid('wf-timeline')} ${tid('wf-visit')}`).count()) === r8a.visits.length,
        'the list does not hold every visit'
      )
      await phone.locator(tid('wf-approval')).waitFor({ timeout: T })
      await phone.click(tid('wf-approve'))
      const done = await runUntil(r8a.id, ended, 'the phone-approved run to end')
      assert(done.status === 'done' && visitsOf(done, 'approve')[0].port === 'approved', `the phone-approved run is ${done.status}`)
      const p = await waitPush((x) => x.kind === 'workflow' && x.run?.runId === r8a.id, 'the Notify push of the phone-approved run')
      assert(p.title === 'Triage done', `the Notify push is titled ${p.title}`)
      await waitFor(
        async () => (await phone.locator(`${tid('wf-run-status')}[data-status="done"]`).count()) === 1,
        T,
        'the phone to show the run done'
      )
      // An ended run is the audit log on a phone, with no visit list.
      await phone.locator(`${tid('wf-audit')}[data-state="ready"]`).waitFor({ timeout: T })
      assert((await phone.locator(tid('wf-timeline')).count()) === 0, 'the finished run still shows the visit list on the phone')
    } finally {
      await ctx.close()
    }
    ok('the phone shows the visits as a list with the approval on top; Approve there finished the run')
  })

  await runCase(
    11,
    'New → Save → New: the second New is a blank draft (id null), its save makes a second workflow, the first is untouched',
    async () => {
      await page.goto(`${h.origin}/workflows`) // a fresh socket, after the frame listener
      await page.locator(tid('workflows-placeholder')).waitFor({ timeout: T })
      const before = saves.length
      await page.click(tid('new-workflow'))
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      assert((await page.locator(tid('workflow-name')).inputValue()) === 'New workflow', 'the new workflow is not called "New workflow"')
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 1, T, 'a new workflow with only its trigger')
      await page.locator(tid('workflow-name')).fill('Draft one')
      await page.click(tid('wf-add'))
      await page.locator(tid('wf-add-menu')).waitFor({ timeout: T })
      await page.click(tid('wf-add-llm'))
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 2, T, 'the added LLM step')
      await page.click(tid('wf-save'))
      await page.waitForURL(/\/workflows\/[^/]+$/, { timeout: T })
      const firstId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
      await waitFor(async () => saves.length === before + 1, T, 'the first save frame')
      assert(saves[before].id === null, `the first save sent id ${saves[before].id}`)
      // Its LLM step has no prompt and no way in, so the switch refuses to turn it on.
      await page.click(tid('wf-enabled'))
      await waitFor(
        async () =>
          /Fix this workflow's problems/.test(
            (await page
              .locator(`${tid('wf-notice')}[data-tone="error"]`)
              .textContent()
              .catch(() => '')) ?? ''
          ),
        T,
        'the switch to refuse'
      )
      assert(
        (await page.locator(tid('wf-enabled')).getAttribute('aria-checked')) === 'false',
        'the switch turned on a workflow with problems'
      )
      const first = (await rpc('workflows:list')).workflows.find((x) => x.id === firstId)
      assert(
        first && first.name === 'Draft one' && first.steps.length === 2 && !first.enabled,
        `the first save stored ${JSON.stringify(first && { name: first.name, steps: first.steps.length, enabled: first.enabled })}`
      )

      await page.click(tid('new-workflow'))
      await page.waitForURL(`${h.origin}/workflows`, { timeout: T })
      await waitFor(async () => (await page.locator(tid('workflow-name')).inputValue()) === 'New workflow', T, 'the second New to be blank')
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 1, T, 'the second New to hold only its trigger')
      assert(await page.locator(tid('wf-save')).isEnabled(), 'Save is disabled on the blank draft')
      await page.click(tid('wf-more'))
      assert(await page.locator(tid('wf-delete')).isDisabled(), 'the blank draft can be deleted, so it has an id')
      await page.click(tid('wf-more'))
      await page.locator(tid('workflow-name')).fill('Draft two')
      await page.click(tid('wf-enabled')) // a lone trigger has no problems
      assert((await page.locator(tid('wf-enabled')).getAttribute('aria-checked')) === 'true', 'the switch did not turn on')
      await page.click(tid('wf-save'))
      await page.waitForURL((u) => /\/workflows\/[^/]+$/.test(u.pathname) && !u.pathname.endsWith(firstId), { timeout: T })
      await waitFor(async () => saves.length === before + 2, T, 'the second save frame')
      assert(
        saves[before + 1].id === null && saves[before + 1].steps.length === 1,
        `the second save sent ${JSON.stringify({ id: saves[before + 1].id, steps: saves[before + 1].steps.length })}`
      )
      const list = (await rpc('workflows:list')).workflows
      const second = list.find((x) => x.name === 'Draft two')
      const firstAfter = list.find((x) => x.id === firstId)
      assert(
        second && second.id !== firstId && second.steps.length === 1 && second.enabled,
        'the second save did not make a second workflow, on'
      )
      assert(JSON.stringify(firstAfter) === JSON.stringify(first), 'the first workflow changed')
      ok('the second New was blank and unsaved (id null); its save made a second workflow and left the first as it was')
    }
  )

  await runCase(12, 'the routines webhook with the X-ZumiBot-Secret header still works through the shared /hooks handler', async () => {
    const d = await rpc('routines:draftWebhook')
    const send = (secret, body) =>
      fetch(d.url, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/json', 'X-ZumiBot-Secret': secret },
        body: JSON.stringify(body)
      })
    const test = await send(d.secret, { topic: 'ai' })
    assert(test.status === 202 && (await test.json()).status === 'test call captured', `the routine test call got ${test.status}`)
    const wrong = await send('w'.repeat(d.secret.length), { topic: 'ai' })
    assert(wrong.status === 401, `a wrong routine secret got ${wrong.status}`)
    await rpc('routines:save', {
      id: d.id,
      name: 'Old hook',
      enabled: true,
      timeZone: 'UTC',
      trigger: { kind: 'webhook', sample: null },
      target: { kind: 'new-chat', agent: AGENT, cwd: folder },
      prompt: 'Look at {{body.topic}}',
      limitPolicy: 'wait',
      missedPolicy: 'run-once',
      sessionPolicy: 'continue',
      command: null
    })
    const real = await send(d.secret, { topic: 'space' })
    const out = await real.json()
    assert(real.status === 202 && out.runId, `the routine call got ${real.status} ${JSON.stringify(out)}`)
    await waitFor(
      async () => ((await rpc('routines:list')).runs[d.id] ?? []).some((x) => x.id === out.runId && x.status === 'done'),
      30_000,
      'the routine run to be done'
    )
    ok('the routine hook captured a test call, refused a wrong secret and ran on a real call')
  })

  await runCase(
    13,
    "connectors: a free port's + adds a connected step, an edge's trash removes it and its + puts a step into it",
    async () => {
      const flow = await save(
        draft(
          'Connectors',
          [step('trig', 'trigger', 'Trigger', 0, 0), step('first', 'llm', 'First', 320, 0, { prompt: 'x', model: 'haiku' })],
          [edge('trig', 'out', 'first')],
          { enabled: false }
        )
      )
      await page.goto(`${h.origin}/workflows/${flow.id}`)
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 2, T, 'the two steps on the canvas')
      const edgeNamed = (name) => page.locator(`.react-flow__edge[aria-label="${name}"]`)
      const edgeNames = async () =>
        (await page.locator('.react-flow__edge').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).sort()
      // A level edge has a box 0 high, which Playwright counts as hidden: point at its middle instead, where its wide
      // invisible stroke still takes the pointer. A new step may pan the view (a 250 ms animation), so wait until the edge
      // holds still first, or it slides out from under the pointer and its toolbar goes.
      const hoverEdge = async (name) => {
        const mid = () =>
          edgeNamed(name).evaluate((el) => {
            const b = el.getBoundingClientRect()
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
          })
        let r = await mid()
        await waitFor(
          async () => {
            await sleep(100)
            const next = await mid()
            const still = next.x === r.x && next.y === r.y
            r = next
            return still
          },
          T,
          `${name} to hold still`
        )
        await page.mouse.move(r.x, r.y)
      }

      // The trigger's port is taken, First's is free: its + offers the add menu and the new step comes connected.
      assert((await node(page, 'trig').locator('[data-testid^="wf-port-add-"]').count()) === 0, 'the connected trigger port has a +')
      await node(page, 'first').locator(tid('wf-port-add-out')).click()
      await page.locator(tid('wf-add-menu')).waitFor({ timeout: T })
      await page.click(tid('wf-add-wait'))
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 3, T, 'the Wait added from the port')
      await waitFor(async () => (await edgeNamed('First → Wait').count()) === 1, T, 'the Wait to come connected to First')
      assert(
        (await node(page, 'first').locator('[data-testid^="wf-port-add-"]').count()) === 0,
        'the + stayed on a port that is now connected'
      )

      // Hovering an edge shows its toolbar; the trash removes only that edge, and First's + comes back.
      await hoverEdge('First → Wait')
      await page.locator(tid('wf-edge-bar')).waitFor({ timeout: T })
      await page.click(tid('wf-edge-delete'))
      await waitFor(async () => (await edgeNamed('First → Wait').count()) === 0, T, 'the trash to remove First → Wait')
      assert((await page.locator(tid('wf-node')).count()) === 3, 'the trash removed a step')
      await node(page, 'first').locator(tid('wf-port-add-out')).waitFor({ timeout: T })

      // The edge's + puts the new step into it: Trigger → Notify → First.
      await page.mouse.move(0, 0)
      await waitFor(async () => (await page.locator(tid('wf-edge-bar')).count()) === 0, T, 'the toolbar to hide once the pointer left')
      await hoverEdge('Trigger → First')
      await page.locator(tid('wf-edge-bar')).waitFor({ timeout: T })
      await page.click(tid('wf-edge-add'))
      await page.locator(tid('wf-add-menu')).waitFor({ timeout: T })
      await page.click(tid('wf-add-notify'))
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 4, T, 'the Notify put into the edge')
      // React Flow draws a new step's edges only once the step is measured, a frame after the step itself shows.
      let names = []
      await waitFor(
        async () => JSON.stringify((names = await edgeNames())) === JSON.stringify(['Notify → First', 'Trigger → Notify']),
        T,
        'Trigger → Notify → First'
      ).catch((err) => {
        throw new Error(`${err.message}; the edges are ${JSON.stringify(names)}`)
      })

      await page.click(tid('wf-save'))
      await waitFor(async () => (await page.locator(tid('wf-unsaved')).count()) === 0, T, 'the save')
      const stored = (await rpc('workflows:list')).workflows.find((x) => x.id === flow.id)
      const byId = Object.fromEntries(stored.steps.map((x) => [x.id, x.name]))
      const links = stored.edges.map((e) => `${byId[e.from]}:${e.port}>${byId[e.to]}`).sort()
      assert(
        stored.steps.length === 4 && JSON.stringify(links) === JSON.stringify(['Notify:out>First', 'Trigger:out>Notify']),
        `the stored workflow has ${stored.steps.length} steps and ${JSON.stringify(links)}`
      )
      ok(
        "a port's + added a connected Wait; the edge trash removed only its edge; the edge + put a Notify between Trigger and First; all saved"
      )
    }
  )

  await runCase(
    14,
    'Duplicate: unsaved edits are saved first, the copy opens off as "<name> (2)" with the same steps and no runs',
    async () => {
      const src = await save(
        draft(
          'Copy me',
          [step('trig', 'trigger', 'Trigger', 0, 0), step('sum', 'llm', 'Sum', 260, 0, { prompt: 'Sum it up', model: 'haiku' })],
          [edge('trig', 'out', 'sum')]
        )
      )
      await rpc('workflows:run', src.id)
      await page.goto(`${h.origin}/workflows/${src.id}`)
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 2, T, 'the source on the canvas')
      await page.locator(tid('workflow-name')).fill('Copy me edited')
      await page.locator(tid('wf-unsaved')).waitFor({ timeout: T })
      await page.click(tid('wf-more'))
      assert(
        (await page.locator(tid('wf-duplicate')).textContent()) === 'Save and duplicate',
        'Duplicate does not say it saves the edits first'
      )
      await page.click(tid('wf-duplicate'))
      await page.waitForURL((u) => /\/workflows\/[^/]+$/.test(u.pathname) && !u.pathname.endsWith(src.id), { timeout: T })
      const copyId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop())
      await waitFor(async () => (await page.locator(tid('workflow-name')).inputValue()) === 'Copy me edited (2)', T, "the copy's editor")
      assert((await page.locator(tid('workflows-placeholder')).count()) === 0, 'the copy reads as deleted')
      assert((await page.locator(tid('wf-enabled')).getAttribute('aria-checked')) === 'false', 'the copy opened on')
      assert((await page.locator(tid('wf-unsaved')).count()) === 0, 'the copy opened with unsaved changes')
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 2, T, "the copy's steps on the canvas")
      await page.locator(`${tid('workflow-row')}[data-workflow-id="${copyId}"]`).waitFor({ timeout: T })

      const snap = await rpc('workflows:list')
      const source = snap.workflows.find((x) => x.id === src.id)
      const copy = snap.workflows.find((x) => x.id === copyId)
      assert(
        source.name === 'Copy me edited' && source.enabled,
        `the source is ${JSON.stringify({ name: source.name, enabled: source.enabled })}`
      )
      assert(
        copy &&
          !copy.enabled &&
          JSON.stringify(copy.steps) === JSON.stringify(source.steps) &&
          JSON.stringify(copy.edges) === JSON.stringify(source.edges),
        "the copy is not an off copy of the source's steps and edges"
      )
      assert((snap.runs[src.id] ?? []).length === 1 && (snap.runs[copyId] ?? []).length === 0, 'the runs were copied or lost')

      // A clean copy duplicates as it is, under the next free number.
      await page.click(tid('wf-more'))
      assert((await page.locator(tid('wf-duplicate')).textContent()) === 'Duplicate', 'a clean workflow offers "Save and duplicate"')
      await page.click(tid('wf-duplicate'))
      await waitFor(async () => (await page.locator(tid('workflow-name')).inputValue()) === 'Copy me edited (3)', T, 'the copy of the copy')
      // The address follows in an effect after the render that shows the name, which may run a moment later.
      await waitFor(async () => !new URL(page.url()).pathname.endsWith(copyId), T, 'the copy of the copy to open at its own address')
      ok('Save and duplicate saved the edit, then opened an off "(2)" copy with the same steps and no runs; Duplicate of it made "(3)"')
    }
  )

  await runCase(
    15,
    'selection: a plain-drag box and Ctrl-click pick steps, a drag moves them together, Ctrl+A and Delete take all but the trigger',
    async () => {
      const flow = await save(
        draft(
          'Groups',
          [
            step('trig', 'trigger', 'Trigger', 0, 100),
            step('ga', 'llm', 'Group A', 320, 0, { prompt: 'a', model: 'haiku' }),
            step('gb', 'llm', 'Group B', 320, 200, { prompt: 'b', model: 'haiku' }),
            step('gc', 'llm', 'Group C', 640, 100, { prompt: 'c', model: 'haiku' })
          ],
          [edge('trig', 'out', 'ga'), edge('trig', 'out', 'gb'), edge('ga', 'out', 'gc'), edge('gb', 'out', 'gc')],
          { enabled: false }
        )
      )
      await page.goto(`${h.origin}/workflows/${flow.id}`)
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 4, T, 'the four steps on the canvas')
      const picked = async () =>
        (
          await page.locator('.react-flow__node.selected [data-testid="wf-node"]').evaluateAll((els) => els.map((e) => e.dataset.stepId))
        ).sort()
      const groupTitle = async () =>
        await page
          .locator(`${tid('wf-selection-inspector')} h3`)
          .textContent()
          .catch(() => null)
      const box = async (id) => node(page, id).boundingBox()

      // A plain drag from the empty canvas around Group A and Group B (no key held, as in n8n): both picked, the selection's inspector shows.
      const a = await box('ga')
      const b = await box('gb')
      await page.mouse.move(a.x - 16, a.y - 16)
      await page.mouse.down()
      await page.mouse.move(b.x + b.width + 16, b.y + b.height + 16, { steps: 8 })
      await page.mouse.up()
      await waitFor(async () => JSON.stringify(await picked()) === JSON.stringify(['ga', 'gb']), T, 'the box to pick Group A and Group B')
      await waitFor(async () => (await groupTitle()) === '2 items selected', T, 'the selection inspector for two steps')

      // Ctrl-click adds Group C; dragging any of the three moves all three, and the group stays picked after the drop.
      await node(page, 'gc').click({ modifiers: ['Control'] })
      await waitFor(async () => (await groupTitle()) === '3 items selected', T, 'Ctrl-click to add Group C')
      const before = Object.fromEntries(
        (await rpc('workflows:list')).workflows.find((x) => x.id === flow.id).steps.map((x) => [x.id, { x: x.x, y: x.y }])
      )
      const from = await box('ga')
      await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
      await page.mouse.down()
      await page.mouse.move(from.x + from.width / 2 + 120, from.y + from.height / 2 + 90, { steps: 10 })
      await page.mouse.up()
      await page.locator(tid('wf-unsaved')).waitFor({ timeout: T })
      assert((await groupTitle()) === '3 items selected', `the drop changed the selection to ${JSON.stringify(await picked())}`)
      await page.click(tid('wf-save'))
      await waitFor(async () => (await page.locator(tid('wf-unsaved')).count()) === 0, T, 'the save after the group move')
      const after = Object.fromEntries(
        (await rpc('workflows:list')).workflows.find((x) => x.id === flow.id).steps.map((x) => [x.id, { x: x.x, y: x.y }])
      )
      const moved = (id) => ({ dx: after[id].x - before[id].x, dy: after[id].y - before[id].y })
      const d = moved('ga')
      assert(d.dx > 0 && d.dy > 0, `Group A moved by ${JSON.stringify(d)}`)
      assert(
        ['gb', 'gc'].every((id) => JSON.stringify(moved(id)) === JSON.stringify(d)),
        `the group did not move together: ${JSON.stringify({ ga: d, gb: moved('gb'), gc: moved('gc') })}`
      )
      assert(JSON.stringify(moved('trig')) === JSON.stringify({ dx: 0, dy: 0 }), 'the trigger moved with a group it was not in')

      // A plain click on a picked step edits that step alone; Ctrl+A picks all four, Esc clears, Delete takes all but the trigger.
      await node(page, 'gb').click()
      await waitFor(
        async () => (await page.locator(`${tid('wf-step-inspector')}[data-step-id="gb"]`).count()) === 1,
        T,
        'a plain click to edit Group B alone'
      )
      assert(JSON.stringify(await picked()) === JSON.stringify(['gb']), `a plain click left ${JSON.stringify(await picked())} picked`)
      await page.keyboard.press('Control+A')
      await waitFor(async () => (await groupTitle()) === '4 items selected', T, 'Ctrl+A to pick every step')
      assert((await page.locator(tid('wf-selection-remove')).textContent()) === 'Delete 3 items', 'the selection button counts the trigger')
      await page.keyboard.press('Escape')
      await page.locator(tid('wf-inspector-empty')).waitFor({ timeout: T })
      assert((await picked()).length === 0, 'Esc left steps picked')
      await page.keyboard.press('Control+A')
      await waitFor(async () => (await groupTitle()) === '4 items selected', T, 'Ctrl+A again')
      await page.keyboard.press('Delete')
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 1, T, 'Delete to remove the group but the trigger')
      assert((await node(page, 'trig').count()) === 1, 'Delete removed the trigger')
      ok(
        'a plain-drag box picked two steps, Ctrl-click a third; one drag moved all three by the same amount and kept them picked; a click narrowed to one; Ctrl+A, Esc and Delete behaved'
      )
    }
  )

  await runCase(
    16,
    'canvas: Ctrl+drag, wheel and Ctrl+wheel move the view; Ctrl-click toggles; undo/redo; copy/paste across workflows; a field keeps its own paste',
    async () => {
      const source = await save(
        draft(
          'Source',
          [
            step('trig', 'trigger', 'Trigger', 0, 100),
            step('a', 'llm', 'Alpha', 320, 100, { prompt: 'Say {{input}}', model: 'haiku' }),
            step('b', 'notify', 'Beta', 640, 100, { title: 'Done', body: '{{steps.a.output}}' })
          ],
          [edge('trig', 'out', 'a'), edge('a', 'out', 'b')]
        )
      )
      const target = await save(draft('Target', [step('trig', 'trigger', 'Trigger', 0, 100)], [], { enabled: false }))
      await page.goto(`${h.origin}/workflows/${source.id}`)
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 3, T, 'the three Source steps')
      await waitFor(async () => (await page.locator('.react-flow__edge').count()) === 2, T, 'the two Source edges')

      // ---- helpers ----
      const view = () =>
        page.locator('.react-flow__viewport').evaluate((el) => {
          const m = new DOMMatrix(getComputedStyle(el).transform)
          return { x: m.e, y: m.f, k: m.a }
        })
      const viewText = (v) => `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}) ×${v.k.toFixed(3)}`
      const pickedNow = async () =>
        (
          await page.locator('.react-flow__node.selected [data-testid="wf-node"]').evaluateAll((els) => els.map((e) => e.dataset.stepId))
        ).sort()
      const selTitle = () =>
        page
          .locator(`${tid('wf-selection-inspector')} h3`)
          .textContent({ timeout: 500 })
          .catch(() => null)
      const inspecting = async (id) => (await page.locator(`${tid('wf-step-inspector')}[data-step-id="${id}"]`).count()) === 1
      const nodeCount = () => page.locator(tid('wf-node')).count()
      const edgeCount = (name) => page.locator(`.react-flow__edge[aria-label="${name}"]`).count()
      const focused = () =>
        page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null)
      const unsaved = async () => (await page.locator(tid('wf-unsaved')).count()) === 1
      // A spot on the empty canvas: its top middle, above the steps (they sit in the middle row once the view fits them), and
      // over 40 px in from the edge, where a box drawn to it would make React Flow pan on its own.
      const empty = async () => {
        const c = await page.locator(tid('wf-canvas')).boundingBox()
        return { x: c.x + c.width / 2, y: c.y + 80 }
      }
      const drag = async (p, dx, dy, button = 'left') => {
        await page.mouse.move(p.x, p.y)
        await page.mouse.down({ button })
        await page.mouse.move(p.x + dx, p.y + dy, { steps: 8 })
        await page.mouse.up({ button })
      }
      const moved = (a, b) => a.x !== b.x || a.y !== b.y
      const center = async (id) => {
        const b = await node(page, id).boundingBox()
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      }
      // Clicks on the empty canvas: nothing picked, every menu closed, focus off any field.
      const clickEmpty = async () => {
        const p = await empty()
        await page.mouse.click(p.x, p.y)
      }

      // ---- the view: Ctrl+drag, middle drag and Space+drag pan; the wheel pans; Ctrl+wheel zooms ----
      const v0 = await view()
      let at = await empty()
      await page.mouse.move(at.x, at.y)
      await page.keyboard.down('Control')
      await drag(at, 120, 60)
      await page.keyboard.up('Control')
      const v1 = await view()
      assert(
        Math.abs(v1.x - v0.x - 120) < 2 && Math.abs(v1.y - v0.y - 60) < 2 && v1.k === v0.k,
        `Ctrl+drag moved the view from ${viewText(v0)} to ${viewText(v1)}`
      )
      assert((await pickedNow()).length === 0, `Ctrl+drag picked ${JSON.stringify(await pickedNow())}`)
      await drag(at, -60, -30, 'middle')
      const v2 = await view()
      assert(
        Math.abs(v2.x - v1.x + 60) < 2 && Math.abs(v2.y - v1.y + 30) < 2 && v2.k === v1.k,
        `a middle drag moved the view from ${viewText(v1)} to ${viewText(v2)}`
      )
      await page.keyboard.down('Space')
      await drag(at, -60, -30)
      await page.keyboard.up('Space')
      const v3 = await view()
      assert(
        Math.abs(v3.x - v2.x + 60) < 2 && Math.abs(v3.y - v2.y + 30) < 2 && v3.k === v2.k,
        `Space+drag moved the view from ${viewText(v2)} to ${viewText(v3)}`
      )
      assert((await pickedNow()).length === 0, 'Space+drag picked steps')
      // A plain drag on empty canvas boxes (the view stays) and Pan mode (the toolbar's hand) makes it pan.
      await drag(at, 40, 40)
      assert(!moved(await view(), v3), 'a plain drag on empty canvas moved the view')
      await page.mouse.move(at.x, at.y)
      await page.mouse.wheel(0, 300)
      await waitFor(async () => (await view()).y !== v3.y, T, 'the wheel to move the view')
      const v4 = await view()
      assert(v4.y < v3.y && v4.x === v3.x && v4.k === v3.k, `the wheel moved the view from ${viewText(v3)} to ${viewText(v4)}, not up only`)
      await page.keyboard.down('Control')
      await page.mouse.wheel(0, -200)
      await page.keyboard.up('Control')
      await waitFor(async () => (await view()).k > v4.k, T, 'Ctrl+wheel to zoom in')
      ok(
        `Ctrl+drag, middle drag and Space+drag pan, a plain drag does not, the wheel scrolls (y ${v3.y.toFixed(0)} → ${v4.y.toFixed(0)}) and Ctrl+wheel zooms (×${v4.k.toFixed(2)} → ×${(await view()).k.toFixed(2)})`
      )

      // The zoom keys and buttons: reset to 100%, - zooms out, 1 fits the workflow again as it opened.
      await page.click(tid('wf-zoom-reset'))
      await waitFor(async () => Math.abs((await view()).k - 1) < 1e-6, T, 'the reset zoom button to zoom to 100%')
      await page.keyboard.press('-')
      await waitFor(async () => (await view()).k < 0.999, T, '- to zoom out')
      await page.keyboard.press('0')
      await waitFor(async () => Math.abs((await view()).k - 1) < 1e-6, T, '0 to zoom to 100%')
      await page.keyboard.press('1')
      await waitFor(
        async () => {
          const v = await view()
          return Math.abs(v.x - v0.x) < 1 && Math.abs(v.y - v0.y) < 1 && Math.abs(v.k - v0.k) < 1e-6
        },
        T,
        '1 to fit the workflow as it opened'
      )
      ok('the reset button and 0 zoom to 100%, - zooms out, 1 fits the workflow back to its opening view')

      // ---- the toolbar and Pan mode ----
      const pressed = async (id) => page.locator(tid(id)).getAttribute('aria-pressed')
      assert(
        (await pressed('wf-tool-select')) === 'true' && (await pressed('wf-tool-pan')) === 'false',
        'the canvas did not open in Select mode'
      )
      assert(
        !(await page.locator(tid('wf-tool-note')).isDisabled()) &&
          /Shift\+S/.test((await page.locator(tid('wf-tool-note')).getAttribute('data-tip')) ?? ''),
        'the sticky note tool is disabled or its tooltip does not name Shift+S'
      )
      assert(
        /\bH\b/.test((await page.locator(tid('wf-tool-pan')).getAttribute('data-tip')) ?? '') &&
          /\(N\)/.test((await page.locator(tid('wf-add')).getAttribute('data-tip')) ?? ''),
        'a toolbar tooltip does not name its key'
      )
      await page.click(tid('wf-tool-pan'))
      await waitFor(
        async () => (await pressed('wf-tool-pan')) === 'true' && (await page.locator(tid('wf-canvas')).getAttribute('data-pan')) === 'true',
        T,
        'the hand to turn on Pan mode'
      )
      at = await empty()
      let before = await view()
      await drag(at, 50, 20)
      assert(moved(await view(), before), 'a left drag in Pan mode did not pan')
      assert((await pickedNow()).length === 0, 'a left drag in Pan mode picked steps')
      await page.click(tid('wf-tool-select'))
      await waitFor(
        async () =>
          (await pressed('wf-tool-select')) === 'true' && (await page.locator(tid('wf-canvas')).getAttribute('data-pan')) === 'false',
        T,
        'the arrow to turn Select mode back on'
      )
      before = await view()
      await drag(at, 50, 20)
      assert(!moved(await view(), before), 'a left drag in Select mode panned')
      // H toggles Pan mode, and a held H flips it once: the second keydown is a repeat (an odd count of them could not tell).
      await clickEmpty()
      await page.evaluate(() => {
        window.__repeats = []
        window.addEventListener('keydown', (e) => window.__repeats.push(`${e.key}:${e.repeat}`), true)
      })
      await page.keyboard.down('h')
      await page.keyboard.down('h')
      await page.keyboard.up('h')
      await sleep(150)
      assert(
        JSON.stringify(await page.evaluate(() => window.__repeats)) === '["h:false","h:true"]',
        `the held H sent ${JSON.stringify(await page.evaluate(() => window.__repeats))}`
      )
      assert((await pressed('wf-tool-pan')) === 'true', 'a held H did not leave Pan mode on')
      before = await view()
      await drag(at, -50, -20)
      assert(moved(await view(), before), 'a left drag after H did not pan')
      await page.keyboard.press('h')
      await waitFor(async () => (await pressed('wf-tool-select')) === 'true', T, 'H again to go back to Select mode')
      before = await view()
      await drag(at, -50, -20)
      assert(!moved(await view(), before), 'a left drag after H twice panned')
      await page.keyboard.press('1')
      ok(
        'the hand and H pan with a left drag, the arrow and H again box; a held H flipped the mode once; the note tool is on; tooltips name the keys'
      )

      // N opens the Add step menu (a held N does not flip it), N again closes it; the toolbar's + does the same.
      await clickEmpty()
      await page.keyboard.down('n')
      await page.keyboard.down('n')
      await page.keyboard.up('n')
      await sleep(150)
      assert((await page.locator(tid('wf-add-menu')).count()) === 1, 'a held N did not leave the Add step menu open')
      await page.keyboard.press('n')
      await waitFor(async () => (await page.locator(tid('wf-add-menu')).count()) === 0, T, 'N again to close the Add step menu')
      await page.click(tid('wf-add'))
      await page.locator(tid('wf-add-menu')).waitFor({ timeout: T })
      assert((await page.locator(tid('wf-add')).getAttribute('aria-expanded')) === 'true', 'the + button does not say its menu is open')
      await page.click(tid('wf-add-wait'))
      await waitFor(async () => (await nodeCount()) === 4, T, 'the Wait added from the toolbar')
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await nodeCount()) === 3, T, 'Ctrl+Z to take the added Wait away')
      await waitFor(async () => !(await unsaved()), T, 'the undone add to leave the workflow as saved')
      ok('N opens the Add step menu once however long it is held, N closes it; the toolbar + adds a Wait that Ctrl+Z takes away')

      // ---- the right-click menu ----
      // It closes the Add step menu, N closes it in turn; it stays inside the canvas near its corner; Esc and a click outside close it.
      await page.keyboard.press('n')
      await page.locator(tid('wf-add-menu')).waitFor({ timeout: T })
      at = await empty()
      await page.mouse.click(at.x, at.y, { button: 'right' })
      await page.locator(tid('wf-ctx-menu')).waitFor({ timeout: T })
      assert((await page.locator(tid('wf-add-menu')).count()) === 0, 'the right-click menu left the Add step menu open')
      assert(
        (await page.locator(tid('wf-ctx-addStep')).count()) === 1 && (await page.locator(tid('wf-ctx-paste')).count()) === 1,
        'the empty canvas menu lacks Add step or Paste'
      )
      await page.keyboard.press('n')
      await page.locator(tid('wf-add-menu')).waitFor({ timeout: T })
      assert((await page.locator(tid('wf-ctx-menu')).count()) === 0, 'N left the right-click menu open')
      await page.keyboard.press('Escape')
      await waitFor(async () => (await page.locator(tid('wf-add-menu')).count()) === 0, T, 'Esc to close the Add step menu')
      const cb = await page.locator(tid('wf-canvas')).boundingBox()
      const corner = { x: cb.x + cb.width - 6, y: cb.y + cb.height - 40 }
      await page.mouse.click(corner.x, corner.y, { button: 'right' })
      const ctx = page.locator(tid('wf-ctx-menu'))
      await ctx.waitFor({ timeout: T })
      await waitFor(
        async () => {
          const m = await ctx.boundingBox()
          return m !== null && m.x >= cb.x && m.y >= cb.y && m.x + m.width <= cb.x + cb.width && m.y + m.height <= cb.y + cb.height
        },
        T,
        'the menu opened by the corner to stay inside the canvas'
      )
      const mb = await ctx.boundingBox()
      assert(mb.x < corner.x && mb.y < corner.y, `the corner menu at ${JSON.stringify(mb)} was not moved in from ${JSON.stringify(corner)}`)
      await page.keyboard.press('Escape')
      await waitFor(async () => (await ctx.count()) === 0, T, 'Esc to close the right-click menu')
      await page.mouse.click(at.x, at.y, { button: 'right' })
      await ctx.waitFor({ timeout: T })
      await page
        .locator(`${tid('wf-inspector')} h3`)
        .first()
        .click()
      await waitFor(async () => (await ctx.count()) === 0, T, 'a click outside the canvas to close the right-click menu')
      ok(
        'the right-click menu and the Add step menu close each other, a corner menu stays inside the canvas, Esc and a click outside close it'
      )

      // A right-click on a step inside a box acts on the whole box; Esc closes the menu and keeps the box. A right-click on a
      // step outside it picks that step alone: Open and Rename, and the trigger cannot be copied or deleted.
      // The box is drawn with Shift held, which still boxes as it did before a plain drag did (case 15 draws one with no key).
      const ba = await node(page, 'a').boundingBox()
      const bb = await node(page, 'b').boundingBox()
      await page.keyboard.down('Shift')
      await page.mouse.move(ba.x - 16, ba.y - 16)
      await page.mouse.down()
      await page.mouse.move(bb.x + bb.width + 16, bb.y + bb.height + 16, { steps: 8 })
      await page.mouse.up()
      await page.keyboard.up('Shift')
      await waitFor(async () => JSON.stringify(await pickedNow()) === JSON.stringify(['a', 'b']), T, 'the Shift box to pick Alpha and Beta')
      const ca = await center('a')
      await page.mouse.click(ca.x, ca.y, { button: 'right' })
      await ctx.waitFor({ timeout: T })
      assert(
        (await page.locator(tid('wf-ctx-open')).count()) === 0 &&
          (await page.locator(tid('wf-ctx-copy')).getAttribute('aria-disabled')) === null,
        'a right-click inside the box did not open the selection menu'
      )
      assert(
        (await page.locator(tid('wf-ctx-delete')).count()) === 1 && (await selTitle()) === '2 items selected',
        'the selection menu lost the box'
      )
      await page.keyboard.press('Escape')
      await waitFor(async () => (await ctx.count()) === 0, T, 'Esc to close the selection menu')
      assert((await selTitle()) === '2 items selected', 'Esc in the menu also cleared the selection')
      const ct = await center('trig')
      await page.mouse.click(ct.x, ct.y, { button: 'right' })
      await ctx.waitFor({ timeout: T })
      await waitFor(() => inspecting('trig'), T, 'a right-click on the trigger to pick it alone')
      assert(
        (await page.locator(tid('wf-ctx-open')).count()) === 1 && (await page.locator(tid('wf-ctx-rename')).count()) === 1,
        'the step menu lacks Open or Rename'
      )
      assert(
        (await page.locator(tid('wf-ctx-copy')).getAttribute('aria-disabled')) === 'true' &&
          (await page.locator(tid('wf-ctx-delete')).getAttribute('aria-disabled')) === 'true',
        'the trigger can be copied or deleted from its menu'
      )
      await page.keyboard.press('Escape')
      await waitFor(async () => (await ctx.count()) === 0, T, 'Esc to close the step menu')
      ok(
        'a right-click inside the box shows the selection menu and keeps the box; one on the trigger picks it alone, with Copy and Delete off'
      )

      // ---- picking and the keys ----
      // Ctrl-click picks a step and Ctrl-click again lets it go, without moving the view or the step.
      await clickEmpty()
      const vc = await view()
      const pa = await node(page, 'a').boundingBox()
      await node(page, 'a').click({ modifiers: ['Control'] })
      await waitFor(async () => JSON.stringify(await pickedNow()) === '["a"]', T, 'Ctrl-click to pick Alpha')
      await node(page, 'a').click({ modifiers: ['Control'] })
      await waitFor(async () => (await pickedNow()).length === 0, T, 'Ctrl-click again to let Alpha go')
      assert(!moved(await view(), vc) && (await view()).k === vc.k, 'Ctrl-click moved the view')
      assert(JSON.stringify(await node(page, 'a').boundingBox()) === JSON.stringify(pa) && !(await unsaved()), 'Ctrl-click moved the step')

      // Arrows walk the graph; Shift+Right with several picked adds everything after the last one picked.
      await node(page, 'trig').click()
      await page.keyboard.press('ArrowRight')
      await waitFor(() => inspecting('a'), T, 'Right to select Alpha')
      await page.keyboard.press('ArrowRight')
      await waitFor(() => inspecting('b'), T, 'Right again to select Beta')
      await page.keyboard.press('ArrowLeft')
      await waitFor(() => inspecting('a'), T, 'Left to go back to Alpha')
      await node(page, 'b').click()
      await node(page, 'trig').click({ modifiers: ['Control'] })
      await waitFor(async () => (await selTitle()) === '2 items selected', T, 'Beta and the trigger picked')
      await page.keyboard.press('Shift+ArrowRight')
      await waitFor(async () => (await selTitle()) === '3 items selected', T, 'Shift+Right to add what follows the trigger')
      assert(
        JSON.stringify(await pickedNow()) === JSON.stringify(['a', 'b', 'trig']),
        `Shift+Right left ${JSON.stringify(await pickedNow())} picked`
      )
      ok(
        'Ctrl-click picks and lets go without moving the view or the step; arrows walk trigger → Alpha → Beta; Shift+Right adds from the last picked'
      )

      // After a click on a step: Esc clears, then Delete and Enter do nothing; Enter opens the inspector at the prompt, F2 at
      // the name with its text selected; a double-click opens a Notify at its title and an LLM at its prompt.
      await node(page, 'a').click()
      await waitFor(() => inspecting('a'), T, 'a click to select Alpha')
      await page.keyboard.press('Escape')
      await page.locator(tid('wf-inspector-empty')).waitFor({ timeout: T })
      await page.keyboard.press('Delete')
      await page.keyboard.press('Enter')
      await sleep(150)
      assert(
        (await nodeCount()) === 3 && (await page.locator(tid('wf-inspector-empty')).count()) === 1,
        'Delete or Enter acted with nothing selected'
      )
      await node(page, 'a').click()
      await page.keyboard.press('Enter')
      await waitFor(async () => (await focused()) === 'wf-prompt', T, `Enter to focus Alpha's prompt (focus is on ${await focused()})`)
      await node(page, 'a').click()
      await page.keyboard.press('F2')
      await waitFor(async () => (await focused()) === 'wf-step-name', T, "F2 to focus Alpha's name")
      const sel = await page
        .locator(tid('wf-step-name'))
        .evaluate((el) => ({ from: el.selectionStart, to: el.selectionEnd, len: el.value.length }))
      assert(sel.from === 0 && sel.to === sel.len && sel.len > 0, `F2 left the name's selection at ${JSON.stringify(sel)}`)
      await node(page, 'b').dblclick()
      await waitFor(
        async () => (await inspecting('b')) && (await focused()) === 'wf-notify-title',
        T,
        `a double-click to open Beta at its title (focus is on ${await focused()})`
      )
      await node(page, 'a').dblclick()
      await waitFor(
        async () => (await inspecting('a')) && (await focused()) === 'wf-prompt',
        T,
        `a double-click to open Alpha at its prompt (focus is on ${await focused()})`
      )
      ok(
        'Esc cleared, Delete and Enter then did nothing; Enter and a double-click open the prompt (LLM) or the title (Notify); F2 selects the name'
      )

      // ---- undo and redo ----
      await node(page, 'b').click()
      await page.keyboard.press('Delete')
      await waitFor(
        async () => (await nodeCount()) === 2 && (await edgeCount('Alpha → Beta')) === 0,
        T,
        'Delete to remove Beta and its edge'
      )
      await page.keyboard.press('Control+Z')
      await waitFor(
        async () => (await nodeCount()) === 3 && (await edgeCount('Alpha → Beta')) === 1,
        T,
        'Ctrl+Z to bring Beta and its edge back'
      )
      await page.keyboard.press('Control+Shift+Z')
      await waitFor(
        async () => (await nodeCount()) === 2 && (await edgeCount('Alpha → Beta')) === 0,
        T,
        'Ctrl+Shift+Z to remove them again'
      )
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await nodeCount()) === 3 && (await edgeCount('Alpha → Beta')) === 1, T, 'Ctrl+Z to bring them back again')
      await page.keyboard.press('Control+Y')
      await waitFor(async () => (await nodeCount()) === 2, T, 'Ctrl+Y to redo the delete')
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await nodeCount()) === 3 && (await edgeCount('Alpha → Beta')) === 1, T, 'Ctrl+Z after Ctrl+Y')
      await waitFor(async () => !(await unsaved()), T, 'the undone delete to leave the workflow as saved')

      // In a field Ctrl+Z is the field's own: the step deleted before stays deleted; on the canvas it comes back.
      await node(page, 'b').click()
      await page.keyboard.press('Delete')
      await waitFor(async () => (await nodeCount()) === 2, T, 'Delete to remove Beta')
      await node(page, 'a').click()
      const name = page.locator(tid('wf-step-name'))
      await name.click()
      await page.keyboard.press('Control+Z')
      await sleep(200)
      assert((await nodeCount()) === 2 && (await name.inputValue()) === 'Alpha', 'Ctrl+Z in the name field undid the canvas')
      await page.keyboard.press('End')
      await page.keyboard.type('X')
      await waitFor(async () => (await name.inputValue()) === 'AlphaX', T, 'typing in the name field')
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await name.inputValue()) === 'Alpha', T, "the field's own Ctrl+Z to take the typing back")
      await sleep(200)
      assert((await nodeCount()) === 2, "the field's Ctrl+Z brought Beta back")
      await clickEmpty()
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await nodeCount()) === 3, T, 'Ctrl+Z on the canvas to bring Beta back')
      await waitFor(async () => !(await unsaved()), T, 'the canvas undo to leave the workflow as saved')

      // Discard changes forgets the history, both ways. The Ctrl+Z before it leaves a redo step (Alpha's delete), so a kept
      // history would redo to Trigger alone: Ctrl+Shift+Z goes first, since a Ctrl+Z before it would push the saved state
      // onto the redo stack and the redo would then only bring that back. Ctrl+Z alone cannot tell: its step back is the
      // saved state too.
      const discarded = async () =>
        JSON.stringify((await page.locator(tid('wf-node')).evaluateAll((els) => els.map((e) => e.dataset.stepId))).sort()) ===
          '["a","b","trig"]' &&
        (await edgeCount('Alpha → Beta')) === 1 &&
        !(await unsaved())
      await node(page, 'b').click()
      await page.keyboard.press('Delete')
      await waitFor(async () => (await nodeCount()) === 2, T, 'Delete to remove Beta')
      await node(page, 'a').click()
      await page.keyboard.press('Delete')
      await waitFor(async () => (await nodeCount()) === 1, T, 'Delete to remove Alpha')
      await page.keyboard.press('Control+Z')
      await waitFor(
        async () => (await nodeCount()) === 2 && (await node(page, 'a').count()) === 1,
        T,
        'Ctrl+Z to bring Alpha back, leaving its delete to redo'
      )
      await page.click(tid('wf-more'))
      await page.click(tid('wf-discard'))
      await waitFor(discarded, T, 'Discard changes to restore the saved steps and edge')
      await clickEmpty()
      await page.keyboard.press('Control+Shift+Z')
      await sleep(300)
      assert(
        await discarded(),
        `Ctrl+Shift+Z after Discard changes redid an edit from before it: ${await nodeCount()} steps, unsaved ${await unsaved()}`
      )
      await page.keyboard.press('Control+Z')
      await sleep(300)
      assert(
        await discarded(),
        `Ctrl+Z after Discard changes undid an edit from before it: ${await nodeCount()} steps, unsaved ${await unsaved()}`
      )
      ok(
        "Delete, Ctrl+Z, Ctrl+Shift+Z, Ctrl+Z, Ctrl+Y, Ctrl+Z; Ctrl+Z in the name field is the field's own; Discard changes clears the history"
      )

      // ---- copy and paste across workflows ----
      // Each copy the page makes, read after the editor wrote it (a window listener runs after the document's).
      await page.evaluate(() => {
        window.__clips = []
        window.addEventListener('copy', (e) => window.__clips.push(e.clipboardData?.getData('text/plain') ?? ''))
      })
      // Text selected earlier in the sidebar (as a drag over it would) is let go by the click on a step, so Ctrl+C is the
      // canvas's: a step's press keeps a text selection, and the editor leaves a live one to the browser. The trigger is
      // picked too: it is never copied.
      await page.locator(`${tid('workflow-row')}[data-workflow-id="${source.id}"] .routine-row`).evaluate((el) => {
        const r = document.createRange()
        r.selectNodeContents(el)
        window.getSelection().removeAllRanges()
        window.getSelection().addRange(r)
      })
      assert((await page.evaluate(() => window.getSelection().toString())).includes('Source'), 'the sidebar text was not selected')
      await node(page, 'a').click()
      await node(page, 'b').click({ modifiers: ['Control'] })
      await node(page, 'trig').click({ modifiers: ['Control'] })
      await waitFor(async () => (await selTitle()) === '3 items selected', T, 'Alpha, Beta and the trigger picked')
      assert((await page.evaluate(() => window.getSelection().toString())) === '', 'a click on a step kept the sidebar text selected')
      await page.keyboard.press('Control+C')
      let clipText = null
      await waitFor(async () => (clipText = await page.evaluate(() => window.__clips.at(-1) ?? null)) !== null, T, 'Ctrl+C to fire a copy')
      assert(clipText !== '', 'Ctrl+C left the copy to the browser, so no clip was written')
      const clip = JSON.parse(clipText)
      assert(
        clip.zumibot === 'workflow-clip' && clip.v === 1 && JSON.stringify(clip.steps.map((s) => s.id).sort()) === '["a","b"]',
        `the clip is ${clipText.slice(0, 200)}`
      )
      assert(
        clip.edges.length === 1 && clip.edges[0].from === 'a' && clip.edges[0].to === 'b',
        `the clip's edges are ${JSON.stringify(clip.edges)}: only the one between copied steps belongs`
      )

      await page.locator(`${tid('workflow-row')}[data-workflow-id="${target.id}"] .routine-row`).click()
      await page.waitForURL(`${h.origin}/workflows/${target.id}`, { timeout: T })
      await waitFor(async () => (await nodeCount()) === 1, T, 'the Target with its trigger only')
      at = await empty()
      await page.mouse.click(at.x, at.y)
      // Where the pointer is in flow coordinates, as the canvas reads it.
      const want = await page.evaluate(({ x, y }) => {
        const r = document.querySelector('.react-flow').getBoundingClientRect()
        const m = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform)
        return { x: (x - r.left - m.e) / m.a, y: (y - r.top - m.f) / m.a }
      }, at)
      await page.keyboard.press('Control+V')
      await waitFor(async () => (await nodeCount()) === 3, T, 'Ctrl+V to paste two steps into the Target')
      await waitFor(async () => (await edgeCount('Alpha → Beta')) === 1, T, 'the pasted edge')
      await waitFor(async () => (await selTitle()) === '2 items selected', T, 'the pasted steps to be picked')
      await page.click(tid('wf-save'))
      await waitFor(async () => !(await unsaved()), T, 'the Target saved')
      const stored = (await rpc('workflows:list')).workflows.find((x) => x.id === target.id)
      const pasted = stored.steps.filter((x) => x.kind !== 'trigger')
      const pa2 = pasted.find((x) => x.name === 'Alpha')
      const pb2 = pasted.find((x) => x.name === 'Beta')
      assert(
        stored.steps.length === 3 && stored.steps.filter((x) => x.kind === 'trigger').length === 1 && pa2 && pb2,
        `the Target holds ${JSON.stringify(stored.steps.map((x) => [x.id, x.kind, x.name]))}`
      )
      assert(pa2.handle === 'a' && pb2.handle === 'b', `the pasted handles are ${pa2.handle}, ${pb2.handle}, not a and b`)
      assert(
        !['a', 'b', 'trig'].includes(pa2.id) && !['a', 'b', 'trig'].includes(pb2.id) && pa2.id !== pb2.id,
        `the pasted ids are ${pa2.id}, ${pb2.id}`
      )
      assert(
        pa2.kind === 'llm' && pa2.prompt === 'Say {{input}}' && pb2.kind === 'notify' && pb2.body === '{{steps.a.output}}',
        'the pasted steps lost their settings'
      )
      assert(
        stored.edges.length === 1 &&
          stored.edges[0].from === pa2.id &&
          stored.edges[0].to === pb2.id &&
          stored.edges[0].port === 'out' &&
          stored.edges[0].id !== 'a-out-b',
        `the Target's edges are ${JSON.stringify(stored.edges)}`
      )
      assert(pb2.x - pa2.x === 320 && pb2.y === pa2.y, `the pasted layout is ${pa2.x},${pa2.y} and ${pb2.x},${pb2.y}`)
      assert(
        Math.abs(pa2.x - want.x) <= 20 && Math.abs(pa2.y - want.y) <= 20,
        `the paste landed at ${pa2.x},${pa2.y}, not at the pointer ${want.x.toFixed(0)},${want.y.toFixed(0)}`
      )
      ok(
        `Ctrl+C in Source and Ctrl+V in Target pasted Alpha and Beta at the pointer with new ids, handles a and b, and their edge; the trigger stayed behind`
      )

      // ---- a field keeps its paste; text that is not a clip is not taken ----
      await page.locator(`${tid('workflow-row')}[data-workflow-id="${source.id}"] .routine-row`).click()
      await page.waitForURL(`${h.origin}/workflows/${source.id}`, { timeout: T })
      await waitFor(async () => (await nodeCount()) === 3, T, 'Source again')
      const paste = (selector, text) =>
        page.evaluate(
          ({ selector, text }) => {
            const el = selector ? document.querySelector(selector) : (document.activeElement ?? document.body)
            const data = new DataTransfer()
            data.setData('text/plain', text)
            const ev = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })
            el.dispatchEvent(ev)
            return ev.defaultPrevented
          },
          { selector, text }
        )
      await node(page, 'a').click()
      await name.click()
      assert((await focused()) === 'wf-step-name', 'the name field did not take focus')
      assert((await paste(tid('wf-step-name'), clipText)) === false, 'the editor took a paste meant for the name field')
      await sleep(200)
      assert((await nodeCount()) === 3 && !(await unsaved()), 'a paste into the name field added steps')
      await clickEmpty()
      assert((await paste(null, 'hello')) === false, 'the editor took text that is not a clip')
      await sleep(200)
      assert(
        (await nodeCount()) === 3 && (await page.locator(tid('wf-notice')).count()) === 0 && !(await unsaved()),
        'text that is not a clip changed the workflow or showed a notice'
      )
      // The same event with the clip on the empty canvas is taken (so the two above were refused, not lost), as one undo step.
      assert((await paste(null, clipText)) === true, 'the editor did not take a clip pasted on the canvas')
      await waitFor(async () => (await nodeCount()) === 5, T, 'the clip pasted on the canvas')
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await nodeCount()) === 3 && !(await unsaved()), T, 'one Ctrl+Z to take the whole paste back')
      ok(
        'a clip pasted while the name field has focus is the field\'s; "hello" on the canvas changes nothing and shows nothing; a clip there pastes as one undo step'
      )

      // ---- a run's read-only canvas: a left drag pans, and there is no toolbar or right-click menu ----
      const { id: runId } = await rpc('workflows:run', source.id, 'hi')
      await runUntil(runId, ended, 'the Source run to end')
      await page.goto(runUrl(source.id, runId))
      await page.locator(tid('workflow-run-view')).waitFor({ timeout: T })
      await waitFor(async () => (await nodeCount()) === 3, T, 'the run view canvas')
      assert(
        (await page.locator(tid('wf-toolbar')).count()) === 0 && (await page.locator(tid('wf-zoom-reset')).count()) === 1,
        'the run view has a toolbar, or no zoom buttons'
      )
      at = await empty()
      before = await view()
      await drag(at, 70, 30)
      const after = await view()
      assert(
        Math.abs(after.x - before.x - 70) < 2 && Math.abs(after.y - before.y - 30) < 2,
        `a left drag in the run view moved it from ${viewText(before)} to ${viewText(after)}`
      )
      await page.mouse.click(at.x, at.y, { button: 'right' })
      await sleep(150)
      assert((await page.locator(tid('wf-ctx-menu')).count()) === 0, 'the run view has a right-click menu')
      ok('the run view pans on a left drag, with zoom buttons but no toolbar or right-click menu')
    }
  )

  await runCase(
    17,
    'notes: Shift+S adds one at the pointer, Markdown edits render, colors and resize persist, a drag moves the note only, typing never hits canvas keys, a run shows it',
    async () => {
      const flow = await save(
        draft(
          'Notes',
          [step('trig', 'trigger', 'Trigger', 0, 100), step('a', 'llm', 'Alpha', 320, 100, { prompt: 'Say {{input}}', model: 'haiku' })],
          [edge('trig', 'out', 'a')]
        )
      )
      // Every request the page makes, for the images a note must never load (a same-origin one too: the CSP would let it through).
      const asked = []
      const onRequest = (r) => asked.push(r.url())
      page.on('request', onRequest)
      await page.goto(`${h.origin}/workflows/${flow.id}`)
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 2, T, 'the two steps on the canvas')

      // ---- helpers ----
      const TEXT = '# Phase one\nN1+ text'
      const view = () =>
        page.locator('.react-flow__viewport').evaluate((el) => {
          const m = new DOMMatrix(getComputedStyle(el).transform)
          return { x: m.e, y: m.f, k: m.a }
        })
      // A flow point on the screen, as the canvas draws it now.
      const toScreen = (fx, fy) =>
        page.evaluate(
          ({ fx, fy }) => {
            const r = document.querySelector('.react-flow').getBoundingClientRect()
            const m = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform)
            return { x: r.left + m.e + fx * m.a, y: r.top + m.f + fy * m.a }
          },
          { fx, fy }
        )
      // What a click at a screen point would land on: `note:<id>`, `step:<id>`, `edge`, `pane`, or the element's class.
      const hit = (p) =>
        page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y)
          const n = el?.closest('.react-flow__node')
          if (n) return `${n.classList.contains('react-flow__node-note') ? 'note' : 'step'}:${n.dataset.id}`
          if (el?.closest('.react-flow__edge')) return 'edge'
          if (el?.classList.contains('react-flow__pane')) return 'pane'
          return String(el?.className?.baseVal ?? el?.className ?? el?.tagName)
        }, p)
      const noteNode = (id) => page.locator(`.react-flow__node-note[data-id="${id}"]`)
      const noteIds = () => page.locator('.react-flow__node-note').evaluateAll((els) => els.map((e) => e.dataset.id))
      const pickedNotes = () => page.locator('.react-flow__node-note.selected').evaluateAll((els) => els.map((e) => e.dataset.id))
      const pickedSteps = async () =>
        (
          await page.locator('.react-flow__node.selected [data-testid="wf-node"]').evaluateAll((els) => els.map((e) => e.dataset.stepId))
        ).sort()
      // A node's place in flow coordinates (React Flow's own transform on it) and its unscaled size.
      const placeOf = (sel) =>
        page.locator(sel).evaluate((el) => {
          const m = new DOMMatrix(getComputedStyle(el).transform)
          return { x: m.e, y: m.f }
        })
      const notePos = (id) => placeOf(`.react-flow__node-note[data-id="${id}"]`)
      const noteSize = (id) => noteNode(id).evaluate((el) => ({ width: el.offsetWidth, height: el.offsetHeight }))
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
      const nodeCount = () => page.locator(tid('wf-node')).count()
      const noteCount = () => page.locator(tid('wf-note')).count()
      const edgeCount = (name) => page.locator(`.react-flow__edge[aria-label="${name}"]`).count()
      const unsaved = async () => (await page.locator(tid('wf-unsaved')).count()) === 1
      const focused = () =>
        page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null)
      const selTitle = () =>
        page
          .locator(`${tid('wf-selection-inspector')} h3`)
          .textContent({ timeout: 500 })
          .catch(() => null)
      const noteText = (sel) =>
        page
          .locator(`${tid('wf-note')} ${sel}`)
          .first()
          .textContent({ timeout: 500 })
          .catch(() => null)
      const centreOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
      const inside = (p, b, margin = 0) =>
        p.x >= b.x + margin && p.x <= b.x + b.width - margin && p.y >= b.y + margin && p.y <= b.y + b.height - margin
      // The canvas's top-right corner, inside it and away from its edge (React Flow pans on its own within 40 px of one).
      const corner = async () => {
        const c = await page.locator(tid('wf-canvas')).boundingBox()
        return { x: c.x + c.width - 60, y: c.y + 60 }
      }
      const clickEmpty = async () => {
        const p = await corner()
        assert((await hit(p)) === 'pane', `the canvas corner is ${await hit(p)}, not empty canvas`)
        await page.mouse.click(p.x, p.y)
      }
      const drag = async (from, to) => {
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move(to.x, to.y, { steps: 12 })
        await page.mouse.up()
      }
      // React Flow starts a node drag at the first move past its 1 px threshold and measures from there: a 2 px first move
      // makes the rest of the drag exactly (dx, dy).
      const dragNode = async (from, dx, dy) => {
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move(from.x + 2, from.y + 2)
        await page.mouse.move(from.x + 2 + dx, from.y + 2 + dy, { steps: 10 })
        await page.mouse.up()
      }
      // A pan animates (an added step's reveal): read a box once it holds still.
      const settled = async (locator, what) => {
        let r = await locator.boundingBox()
        await waitFor(
          async () => {
            await sleep(100)
            const next = await locator.boundingBox()
            const still = same(next, r)
            r = next
            return still
          },
          T,
          what
        )
        return r
      }
      // A drag (React Flow's resizer too, on d3-drag) swallows the next click until a 0 ms timer it set on release fires,
      // and a busy page can run the test's next click first. A timer set now fires after that one; two frames then let
      // the release's own render settle.
      const afterDrag = () =>
        page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 0)))
      const resetZoom = async () => {
        await page.click(tid('wf-zoom-reset'))
        await waitFor(async () => (await view()).k === 1, T, 'the reset zoom button to zoom to 100%')
        await sleep(200) // the zoom animates its last frames to the same scale
      }

      // ---- Shift+S puts a default note, centred on the pointer and on the grid, picked and not open ----
      // At 100% a screen pixel is a flow unit, so the resize below lands on exact sizes.
      await resetZoom()
      const at = await toScreen(140, -60)
      assert((await hit(at)) === 'pane', `the spot for the note is ${await hit(at)}`)
      await page.mouse.move(at.x, at.y)
      await page.keyboard.press('Shift+S')
      await waitFor(async () => (await noteCount()) === 1, T, 'Shift+S to add a note')
      const [n1] = await noteIds()
      const box1 = await page.locator(tid('wf-note')).boundingBox()
      assert(inside(at, box1), `the note at ${JSON.stringify(box1)} does not hold the pointer ${JSON.stringify(at)}`)
      // Its top-left is the pointer less half the default size (240×160), on the 20 px grid.
      assert(
        same(await notePos(n1), { x: 20, y: -140 }) && same(await noteSize(n1), { width: 240, height: 160 }),
        `the note sits at ${JSON.stringify(await notePos(n1))}, ${JSON.stringify(await noteSize(n1))}`
      )
      assert(same(await pickedNotes(), [n1]) && (await nodeCount()) === 2, 'the new note is not the selection, or a step went')
      assert(
        (await page.locator(tid('wf-note-input')).count()) === 0 && (await page.locator(tid('wf-inspector-empty')).count()) === 1,
        'the new note opened for editing, or the inspector is not the overview'
      )
      assert((await noteText('h2')) === 'Note', `the default note reads ${await noteText('h2')}`)
      ok('Shift+S added a 240×160 note centred on the pointer at (20, -140), picked, not open, the overview in the inspector')

      // ---- typing in the note never reaches a canvas key ----
      const inNote = await toScreen(230, -10)
      await page.mouse.dblclick(inNote.x, inNote.y)
      await waitFor(
        async () => (await focused()) === 'wf-note-input',
        T,
        `a double-click to open the note (focus is on ${await focused()})`
      )
      const v0 = await view()
      // Ctrl+A selects the text (not every item); the text holds h (Pan mode), n (Add step), 1 (fit), + (zoom) and an Enter
      // (open); then Shift+S, -, 0 and Delete, each undone by a Backspace where it typed.
      // A pause longer than the history's 1 s coalescing window splits the typing, so only a session that lands as one
      // edit undoes it in one step below (edits keyed per keystroke would take two).
      await page.keyboard.press('Control+A')
      await page.keyboard.type('# Phase one\n')
      await sleep(1200)
      await page.keyboard.type('N1+ text')
      for (const k of ['Shift+S', 'Backspace', '-', 'Backspace', '0', 'Backspace', 'Delete']) await page.keyboard.press(k)
      await sleep(300) // past the 150 ms a zoom key animates
      assert(
        (await page.locator(tid('wf-note-input')).inputValue()) === TEXT,
        `the note's text is ${JSON.stringify(await page.locator(tid('wf-note-input')).inputValue())}`
      )
      assert(
        (await nodeCount()) === 2 && (await noteCount()) === 1,
        `typing changed the items: ${await nodeCount()} steps, ${await noteCount()} notes`
      )
      assert(same(await view(), v0), `typing moved or zoomed the view from ${JSON.stringify(v0)} to ${JSON.stringify(await view())}`)
      assert(
        (await page.locator(tid('wf-canvas')).getAttribute('data-pan')) === 'false' &&
          (await page.locator(tid('wf-tool-pan')).getAttribute('aria-pressed')) === 'false',
        'typing h turned Pan mode on'
      )
      assert(
        (await page.locator(tid('wf-add-menu')).count()) === 0 && (await page.locator(tid('wf-selection-inspector')).count()) === 0,
        'typing opened the Add step menu or Ctrl+A picked every item'
      )
      assert(
        (await focused()) === 'wf-note-input' && same(await pickedNotes(), [n1]),
        'typing took focus or the selection away from the note'
      )
      // A click on empty canvas ends the session: the Markdown renders.
      await clickEmpty()
      await waitFor(
        async () => (await page.locator(tid('wf-note-input')).count()) === 0 && (await noteText('h1')) === 'Phase one',
        T,
        'the heading to render'
      )
      assert((await noteText('p')) === 'N1+ text' && (await unsaved()), `the note's paragraph reads ${await noteText('p')}`)
      ok(
        'typed Markdown with h, n, 1, +, Enter, Shift+S, -, 0 and Delete in it: only the text changed; a click outside renders "Phase one"'
      )

      // ---- one editing session is one undo step ----
      await page.keyboard.press('Control+Z')
      await waitFor(
        async () => (await noteCount()) === 1 && (await noteText('h2')) === 'Note' && (await noteText('p')) === 'Double-click to edit.',
        T,
        'one Ctrl+Z to bring the whole default text back'
      )
      assert((await page.locator(`${tid('wf-note')} h1`).count()) === 0, 'Ctrl+Z left part of the typed text')
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await noteCount()) === 0 && !(await unsaved()), T, 'a second Ctrl+Z to take the added note away')
      await page.keyboard.press('Control+Shift+Z')
      await waitFor(async () => (await noteCount()) === 1 && (await noteText('h2')) === 'Note', T, 'Ctrl+Shift+Z to add the note back')
      await page.keyboard.press('Control+Shift+Z')
      await waitFor(
        async () => (await noteText('h1')) === 'Phase one' && (await noteText('p')) === 'N1+ text',
        T,
        'Ctrl+Shift+Z to put the typed text back'
      )
      assert(same(await noteIds(), [n1]), 'the redone note has another id')
      ok('the editing session undid in one Ctrl+Z, the add in the next; two Ctrl+Shift+Z brought both back')

      // ---- colors: a preset from the hover bar, then a custom hex, which shows as a recent color next time ----
      const openColors = async () => {
        const c = await toScreen(140, -60)
        await page.mouse.move(c.x, c.y)
        await page.locator(tid('wf-note-bar')).waitFor({ state: 'visible', timeout: T })
        await page.click(tid('wf-note-color'))
        await page.locator(tid('wf-note-colors')).waitFor({ timeout: T })
      }
      await openColors()
      await page.click(tid('wf-note-swatch-5'))
      await waitFor(
        async () =>
          (await page.locator(tid('wf-note')).getAttribute('data-color')) === '5' &&
          (await page.locator(tid('wf-note-colors')).count()) === 0,
        T,
        'the blue preset to apply and close the popover'
      )
      await openColors()
      await page.click(tid('wf-note-custom'))
      await page.click(tid('wf-note-hex'))
      await page.keyboard.type('#123456')
      await waitFor(async () => (await page.locator(tid('wf-note')).getAttribute('data-color')) === '#123456', T, 'the custom hex to apply')
      const look = await page
        .locator(tid('wf-note'))
        .evaluate((el) => ({ bg: getComputedStyle(el).backgroundColor, ink: el.classList.contains('ink-light') }))
      assert(look.bg === 'rgb(18, 52, 86)' && look.ink, `the custom note looks ${JSON.stringify(look)}`)
      await page.keyboard.press('Enter')
      await waitFor(async () => (await page.locator(tid('wf-note-colors')).count()) === 0, T, 'Enter in the hex field to close the popover')
      assert(
        (await page.evaluate(() => localStorage.getItem('cb.wf.noteColors'))) === '["#123456"]',
        'the custom color was not kept as a recent one'
      )
      await openColors()
      const recents = await page
        .locator(tid('wf-note-recent'))
        .evaluateAll((els) => els.map((e) => [e.getAttribute('aria-label'), e.getAttribute('aria-pressed')]))
      assert(same(recents, [['#123456', 'true']]), `the recent colors are ${JSON.stringify(recents)}`)
      await page.keyboard.press('Escape')
      await waitFor(async () => (await page.locator(tid('wf-note-colors')).count()) === 0, T, 'Esc to close the color popover')
      ok('the hover bar set blue (5), then Custom… #123456 with light ink; the popover lists it as the one recent color')

      // ---- resize from the bottom-right grip: +100/+60 at 100% is 340×220 on the grid, the top-left stays ----
      const grab = await toScreen(40, 0)
      await page.mouse.click(grab.x, grab.y)
      await waitFor(async () => same(await pickedNotes(), [n1]), T, 'a click to pick the note')
      const grip = noteNode(n1).locator('.react-flow__resize-control.handle.bottom.right')
      await grip.waitFor({ state: 'visible', timeout: T })
      const g = centreOf(await grip.boundingBox())
      await drag(g, { x: g.x + 100, y: g.y + 60 })
      await waitFor(
        async () => same(await noteSize(n1), { width: 340, height: 220 }),
        T,
        `the resize to land at 340×220 (it is ${JSON.stringify(await noteSize(n1))})`
      )
      assert(same(await notePos(n1), { x: 20, y: -140 }), `the resize moved the note to ${JSON.stringify(await notePos(n1))}`)
      await afterDrag()

      // ---- save and reload: text, color and size as left ----
      await page.click(tid('wf-save'))
      await waitFor(async () => !(await unsaved()), T, 'the save')
      const storedNotes = async () => (await rpc('workflows:list')).workflows.find((x) => x.id === flow.id).notes ?? []
      let notes = await storedNotes()
      assert(
        notes.length === 1 && notes[0].id === n1 && notes[0].text === TEXT && notes[0].color === '#123456',
        `the stored notes are ${JSON.stringify(notes)}`
      )
      assert(
        notes[0].width === 340 &&
          notes[0].height === 220 &&
          notes[0].width % 20 === 0 &&
          notes[0].height % 20 === 0 &&
          notes[0].x === 20 &&
          notes[0].y === -140,
        `the stored note box is ${JSON.stringify(notes[0])}`
      )
      await page.reload()
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      await waitFor(async () => (await nodeCount()) === 2 && (await noteCount()) === 1, T, 'the reloaded canvas')
      assert(
        (await noteText('h1')) === 'Phase one' && (await page.locator(tid('wf-note')).getAttribute('data-color')) === '#123456',
        'the reloaded note lost its text or color'
      )
      assert(
        same(await noteSize(n1), { width: 340, height: 220 }) && same(await notePos(n1), { x: 20, y: -140 }),
        `the reloaded note is ${JSON.stringify(await noteSize(n1))} at ${JSON.stringify(await notePos(n1))}`
      )
      ok('the grip resized the note to 340×220 in place; saved and reloaded, it keeps text, color #123456 and size')

      // ---- the note's right-click menu: Edit, Color, Copy, Cut, Duplicate, Group (off: a lone note), Delete; Edit opens it, Esc keeps it picked ----
      await resetZoom()
      const body = await toScreen(60, 40)
      assert((await hit(body)) === `note:${n1}`, `the note's lower left is ${await hit(body)}`)
      await page.mouse.click(body.x, body.y, { button: 'right' })
      await page.locator(tid('wf-ctx-menu')).waitFor({ timeout: T })
      const rows = await page
        .locator(`${tid('wf-ctx-menu')} [role="menuitem"]`)
        .evaluateAll((els) => els.map((e) => `${e.dataset.testid}${e.getAttribute('aria-disabled') ? ' (off)' : ''}`))
      assert(
        same(rows, ['wf-ctx-edit', 'wf-ctx-color', 'wf-ctx-copy', 'wf-ctx-cut', 'wf-ctx-duplicate', 'wf-ctx-group (off)', 'wf-ctx-delete']),
        `the note's menu is ${JSON.stringify(rows)}`
      )
      await page.click(tid('wf-ctx-edit'))
      await waitFor(async () => (await focused()) === 'wf-note-input', T, 'Edit to open the note')
      assert((await page.locator(tid('wf-note-input')).inputValue()) === TEXT, 'Edit opened another text')
      await page.keyboard.press('Escape')
      await waitFor(async () => (await page.locator(tid('wf-note-input')).count()) === 0, T, 'Esc to end the editing session')
      assert(
        same(await pickedNotes(), [n1]) && !(await unsaved()) && (await noteText('h1')) === 'Phase one',
        'Esc dropped the note from the selection, or an unchanged session made an edit'
      )
      await page.mouse.click(body.x, body.y, { button: 'right' })
      await page.click(tid('wf-ctx-color'))
      await page.locator(tid('wf-note-colors')).waitFor({ timeout: T })
      await page.keyboard.press('Escape')
      await waitFor(async () => (await page.locator(tid('wf-note-colors')).count()) === 0, T, 'Esc to close the popover the menu opened')
      ok(
        'the note menu lists Edit, Color, Copy, Cut, Duplicate, Delete; Edit opened the text, Esc closed it and kept the note picked; Color opened the popover'
      )

      // ---- a drag by the note's body moves the note only: Alpha ends up on it, where it was ----
      const stepsBefore = (await rpc('workflows:list')).workflows.find((x) => x.id === flow.id).steps.map((x) => [x.id, x.x, x.y])
      await dragNode(body, 240, 180)
      await waitFor(
        async () => same(await notePos(n1), { x: 260, y: 40 }),
        T,
        `the note to land at (260, 40) (it is at ${JSON.stringify(await notePos(n1))})`
      )
      await afterDrag()
      await page.click(tid('wf-save'))
      await waitFor(async () => !(await unsaved()), T, 'the save after the drag')
      const listed = (await rpc('workflows:list')).workflows.find((x) => x.id === flow.id)
      assert(
        listed.notes.length === 1 && listed.notes[0].x === 260 && listed.notes[0].y === 40,
        `the stored note is ${JSON.stringify(listed.notes)}`
      )
      assert(
        same(
          listed.steps.map((x) => [x.id, x.x, x.y]),
          stepsBefore
        ),
        `the drag moved steps: ${JSON.stringify(listed.steps.map((x) => [x.id, x.x, x.y]))}`
      )
      // Painted under steps and edges: Alpha's middle (on the note) is Alpha, a point of Trigger → Alpha over the note is the
      // edge, and just below that point it is the note.
      const noteBox = await page.locator(tid('wf-note')).boundingBox()
      const aMid = centreOf(await node(page, 'a').boundingBox())
      assert(inside(aMid, noteBox) && (await hit(aMid)) === 'step:a', `Alpha's middle on the note is ${await hit(aMid)}`)
      const trigBox = await node(page, 'trig').boundingBox()
      const aBox = await node(page, 'a').boundingBox()
      const onLine = (
        await page.evaluate(() => {
          const path = document.querySelector('.react-flow__edge[aria-label="Trigger → Alpha"] path.react-flow__edge-path')
          const ctm = path.getScreenCTM()
          const len = path.getTotalLength()
          return Array.from({ length: 41 }, (_, i) => {
            const p = path.getPointAtLength((len * i) / 40)
            const s = new DOMPoint(p.x, p.y).matrixTransform(ctm)
            return { x: s.x, y: s.y }
          })
        })
      ).filter(
        (p) =>
          inside(p, noteBox, 12) &&
          !inside(p, { x: aBox.x - 12, y: aBox.y - 12, width: aBox.width + 24, height: aBox.height + 24 }) &&
          !inside(p, { x: trigBox.x - 12, y: trigBox.y - 12, width: trigBox.width + 24, height: trigBox.height + 24 })
      )
      assert(onLine.length > 0, 'no point of Trigger → Alpha lies over the note')
      const linePt = onLine[Math.floor(onLine.length / 2)]
      assert((await hit(linePt)) === 'edge', `a point of the edge over the note is ${await hit(linePt)}`)
      assert(
        (await hit({ x: linePt.x, y: linePt.y + 25 })) === `note:${n1}`,
        `just below the edge is ${await hit({ x: linePt.x, y: linePt.y + 25 })}, not the note`
      )
      ok(
        'a drag by its body moved the note to (260, 40) under Alpha, whose saved place is unchanged; the step and the edge paint over the note'
      )

      // ---- among notes the smaller is on top, whichever was added last ----
      await page.keyboard.press('1')
      await waitFor(async () => (await view()).k < 1, T, '1 to fit the workflow with its note')
      await sleep(200)
      const q = await toScreen(260, 300)
      assert((await hit(q)) === 'pane', `the spot below the note is ${await hit(q)}`)
      await page.mouse.click(q.x, q.y, { button: 'right' })
      await page.click(tid('wf-ctx-addNote'))
      await waitFor(async () => (await noteCount()) === 2, T, 'Add sticky note from the canvas menu')
      const n2 = (await noteIds()).find((id) => id !== n1)
      assert(
        same(await notePos(n2), { x: 140, y: 220 }) && same(await pickedNotes(), [n2]),
        `the menu's note sits at ${JSON.stringify(await notePos(n2))}, not centred where the menu opened, or is not picked`
      )
      // Where the two overlap, the new 240×160 note is smaller than the 340×220 one, so it is the one hit.
      const both = await toScreen(320, 240)
      assert((await hit(both)) === `note:${n2}`, `the overlap is ${await hit(both)} while the new note is smaller`)
      await page.mouse.click(both.x, both.y)
      await waitFor(async () => same(await pickedNotes(), [n2]), T, 'a click in the overlap to pick the smaller note')
      // Made bigger than the first, it goes under it, though it was added after it.
      const grip2 = noteNode(n2).locator('.react-flow__resize-control.handle.bottom.right')
      await grip2.waitFor({ state: 'visible', timeout: T })
      const g2 = centreOf(await grip2.boundingBox())
      await drag(g2, { x: g2.x + 150, y: g2.y + 110 })
      await waitFor(
        async () => {
          const s = await noteSize(n2)
          return s.width * s.height > 340 * 220
        },
        T,
        `the second note to grow past the first (it is ${JSON.stringify(await noteSize(n2))})`
      )
      await afterDrag()
      const n2Size = await noteSize(n2)
      // The drag was off the grid at this zoom (150 and 110 screen pixels), and the size still lands on it.
      assert(
        n2Size.width % 20 === 0 && n2Size.height % 20 === 0,
        `the resized note is ${n2Size.width}×${n2Size.height}, off the 20 px grid`
      )
      assert((await hit(both)) === `note:${n1}`, `the overlap is ${await hit(both)} once the first note is the smaller`)
      await page.mouse.click(both.x, both.y)
      await waitFor(async () => same(await pickedNotes(), [n1]), T, 'a click in the overlap to pick the now smaller first note')
      ok(
        `in the overlap the smaller note is hit and picked: the new one at 240×160, the first once the new one grew to ${n2Size.width}×${n2Size.height}`
      )

      // ---- Delete takes a picked note away and Ctrl+Z brings it back; Ctrl+A picks steps and notes ----
      const n2Only = await toScreen(200, 320)
      assert((await hit(n2Only)) === `note:${n2}`, `the second note's lower left is ${await hit(n2Only)}`)
      await page.mouse.click(n2Only.x, n2Only.y)
      await waitFor(async () => same(await pickedNotes(), [n2]), T, 'a click to pick the second note')
      await page.keyboard.press('Delete')
      await waitFor(async () => same(await noteIds(), [n1]) && (await nodeCount()) === 2, T, 'Delete to remove the second note only')
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await noteCount()) === 2, T, 'Ctrl+Z to bring the second note back')
      assert(same(await noteSize(n2), n2Size) && same(await notePos(n2), { x: 140, y: 220 }), 'the second note came back with another box')
      await page.keyboard.press('Control+Shift+Z')
      await waitFor(
        async () => same(await noteIds(), [n1]) && !(await unsaved()),
        T,
        'Ctrl+Shift+Z to delete it again, leaving the workflow as saved'
      )
      await page.keyboard.press('Control+A')
      await waitFor(async () => (await selTitle()) === '3 items selected', T, 'Ctrl+A to pick both steps and the note')
      assert(
        same(await pickedNotes(), [n1]) && same(await pickedSteps(), ['a', 'trig']),
        `Ctrl+A picked ${JSON.stringify(await pickedSteps())} and ${JSON.stringify(await pickedNotes())}`
      )
      assert(
        (await page.locator(tid('wf-selection-remove')).textContent()) === 'Delete 2 items',
        'the selection button counts the trigger, or not the note'
      )
      await page.keyboard.press('Escape')
      await page.locator(tid('wf-inspector-empty')).waitFor({ timeout: T })
      ok(
        'Delete removed the picked note, Ctrl+Z restored it as it was, Ctrl+Shift+Z removed it again; Ctrl+A picked 2 steps and the note ("3 items selected")'
      )

      // ---- copy a note and a step together, paste: both come back with new ids, as laid out ----
      await page.evaluate(() => {
        window.__clips = []
        window.addEventListener('copy', (e) => window.__clips.push(e.clipboardData?.getData('text/plain') ?? ''))
      })
      const n1Spot = await toScreen(290, 230)
      assert((await hit(n1Spot)) === `note:${n1}`, `the note's lower left is ${await hit(n1Spot)}`)
      await page.mouse.click(n1Spot.x, n1Spot.y)
      await node(page, 'a').click({ modifiers: ['Control'] })
      await waitFor(
        async () => (await selTitle()) === '2 items selected' && same(await pickedNotes(), [n1]),
        T,
        'the note and Alpha picked'
      )
      await page.keyboard.press('Control+C')
      let clipText = null
      await waitFor(async () => (clipText = await page.evaluate(() => window.__clips.at(-1) ?? null)) !== null, T, 'Ctrl+C to fire a copy')
      const clip = JSON.parse(clipText)
      assert(
        same(
          clip.steps.map((s) => s.id),
          ['a']
        ) && clip.edges.length === 0,
        `the clip's steps are ${JSON.stringify(clip.steps.map((s) => s.id))}, its edges ${JSON.stringify(clip.edges)}`
      )
      assert(
        clip.notes.length === 1 &&
          clip.notes[0].id === n1 &&
          clip.notes[0].text === TEXT &&
          clip.notes[0].color === '#123456' &&
          clip.notes[0].width === 340,
        `the clip's notes are ${JSON.stringify(clip.notes)}`
      )
      await clickEmpty()
      await page.keyboard.press('Control+V')
      await waitFor(async () => (await nodeCount()) === 3 && (await noteCount()) === 2, T, 'Ctrl+V to paste the step and the note')
      await waitFor(async () => (await selTitle()) === '2 items selected', T, 'the pasted step and note to be picked')
      const pastedNote = (await noteIds()).find((id) => id !== n1)
      const pastedStep = (await page.locator(tid('wf-node')).evaluateAll((els) => els.map((e) => e.dataset.stepId))).find(
        (id) => id !== 'trig' && id !== 'a'
      )
      assert(
        pastedNote !== undefined && pastedStep !== undefined && pastedNote !== pastedStep,
        `the pasted ids are ${pastedNote} and ${pastedStep}`
      )
      assert(same(await pickedNotes(), [pastedNote]) && same(await pickedSteps(), [pastedStep]), 'the pasted items are not the selection')
      const pn = await notePos(pastedNote)
      const ps = await placeOf(`.react-flow__node-step[data-id="${pastedStep}"]`)
      assert(
        ps.x - pn.x === 60 && ps.y - pn.y === 60 && same(await noteSize(pastedNote), { width: 340, height: 220 }),
        `the paste laid out the step at ${JSON.stringify(ps)} and the note at ${JSON.stringify(pn)}`
      )
      await page.keyboard.press('Control+Z')
      await waitFor(
        async () => (await nodeCount()) === 2 && (await noteCount()) === 1 && !(await unsaved()),
        T,
        'one Ctrl+Z to take the paste back'
      )
      ok('Ctrl+C on the note and Alpha, Ctrl+V: a new note and a new step, both picked, 60/60 apart as before; one Ctrl+Z took them back')

      // ---- a connection dropped over a note opens the Add step menu; one dropped on a step over a note connects ----
      const drop = await toScreen(450, 230)
      assert((await hit(drop)) === `note:${n1}`, `the drop spot is ${await hit(drop)}, not the note`)
      const aPort = centreOf(await node(page, 'a').locator(tid('wf-port-out')).boundingBox())
      await drag(aPort, drop)
      await page.locator(tid('wf-add-menu')).waitFor({ timeout: T })
      assert((await page.locator('.react-flow__edge').count()) === 1, 'the drop over the note made an edge before a step was picked')
      await page.click(tid('wf-add-wait'))
      await waitFor(
        async () => (await nodeCount()) === 3 && (await edgeCount('Alpha → Wait')) === 1,
        T,
        'the Wait to come connected to Alpha'
      )
      const wait = page.locator(`${tid('wf-node')}[data-kind="wait"]`)
      await settled(wait, 'the new Wait to hold still')
      const wPort = centreOf(await wait.locator(tid('wf-port-out')).boundingBox())
      const aOn = centreOf(await settled(node(page, 'a'), 'Alpha to hold still'))
      assert(
        inside(aOn, await page.locator(tid('wf-note')).boundingBox()) && (await hit(aOn)) === 'step:a',
        `Alpha's middle is ${await hit(aOn)}, or not over the note`
      )
      await drag(wPort, aOn)
      await waitFor(async () => (await edgeCount('Wait → Alpha')) === 1, T, 'a drop on Alpha (over the note) to connect Wait → Alpha')
      assert((await page.locator(tid('wf-add-menu')).count()) === 0, 'a drop on a step opened the Add step menu')
      await clickEmpty()
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await edgeCount('Wait → Alpha')) === 0 && (await nodeCount()) === 3, T, 'Ctrl+Z to take Wait → Alpha away')
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await nodeCount()) === 2 && !(await unsaved()), T, 'Ctrl+Z to take the Wait away')
      ok(
        'a connection from Alpha dropped over the note opened the Add step menu and the Wait came connected; one dropped on Alpha over the note connected'
      )

      // ---- a note's Markdown makes no image request: alt text instead of <img> ----
      const IMG = `${TEXT}\n\n![x](http://127.0.0.1:1/never.png) ![y](/e2e-never.png)`
      await page.mouse.click(n1Spot.x, n1Spot.y)
      await waitFor(async () => same(await pickedNotes(), [n1]), T, 'a click to pick the note')
      await page.keyboard.press('Enter')
      await waitFor(async () => (await focused()) === 'wf-note-input', T, 'Enter to open the note')
      assert((await page.locator(tid('wf-note-input')).inputValue()) === TEXT, 'the Enter that opened the note also typed in it')
      await page.locator(tid('wf-note-input')).fill(IMG)
      // Typed and still open, the text is no edit yet, yet unsaved: the pill shows, Save is on, and a tab close would ask.
      await waitFor(async () => await unsaved(), T, 'the text typed in the open note to count as unsaved')
      assert(
        (await focused()) === 'wf-note-input' &&
          (await page.locator(tid('wf-save')).isEnabled()) &&
          (await page.evaluate(() => typeof window.onbeforeunload === 'function')),
        'the open note closed, Save is off, or a tab close would not ask'
      )
      // Ctrl+S in the open note saves what it holds.
      await page.keyboard.press('Control+S')
      await waitFor(
        async () =>
          (await page.locator(tid('wf-note-input')).count()) === 0 && !(await unsaved()) && (await storedNotes())[0]?.text === IMG,
        T,
        'Ctrl+S in the open note to save its text'
      )
      assert(await page.evaluate(() => window.onbeforeunload === null), 'a tab close still asks after the save')
      await waitFor(
        async () =>
          (await page.locator(tid('wf-note-input')).count()) === 0 &&
          (await page.locator(`${tid('wf-note')} .markdown-img-alt`).count()) === 2,
        T,
        'the images to render as alt text'
      )
      const alts = await page.locator(`${tid('wf-note')} .markdown-img-alt`).evaluateAll((els) => els.map((e) => e.textContent))
      assert(
        same(alts, ['x', 'y']) && (await page.locator(`${tid('wf-note')} img`).count()) === 0,
        `the note shows ${JSON.stringify(alts)} and ${await page.locator(`${tid('wf-note')} img`).count()} images`
      )
      await sleep(300)
      assert(
        asked.filter((u) => u.includes('never.png')).length === 0,
        `the note asked for ${JSON.stringify(asked.filter((u) => u.includes('never.png')))}`
      )
      notes = await storedNotes()
      assert(
        notes.length === 1 &&
          notes[0].text === IMG &&
          notes[0].x === 260 &&
          notes[0].y === 40 &&
          notes[0].width === 340 &&
          notes[0].height === 220 &&
          notes[0].color === '#123456',
        `the stored notes are ${JSON.stringify(notes)}`
      )
      ok(
        'Enter opened the note without typing; typed text left open counted as unsaved and Ctrl+S saved it; two image links render as alt text "x" and "y", no <img>, no request'
      )

      // ---- a run started now shows the note read-only: no bar, no resizer, no editor, and a drag does not move it ----
      const { id: runId } = await rpc('workflows:run', flow.id, 'hi')
      const done = await runUntil(runId, ended, 'the Notes run to end')
      assert(
        done.status === 'done' && (done.snapshot.notes ?? []).length === 1 && done.snapshot.notes[0].id === n1,
        `the run ended ${done.status} with ${JSON.stringify(done.snapshot.notes)}`
      )
      await page.goto(runUrl(flow.id, runId))
      await page.locator(tid('workflow-run-view')).waitFor({ timeout: T })
      await waitFor(async () => (await nodeCount()) === 2 && (await noteCount()) === 1, T, 'the run view with its steps and note')
      assert(
        (await noteText('h1')) === 'Phase one' && (await page.locator(`${tid('wf-note')} img`).count()) === 0,
        'the run view note lost its heading or shows an image'
      )
      const ro = await toScreen(290, 230)
      assert((await hit(ro)) === `note:${n1}`, `the run view note's lower left is ${await hit(ro)}`)
      await page.mouse.move(ro.x, ro.y)
      await sleep(150)
      assert(
        (await page.locator(tid('wf-note-bar')).count()) === 0 && (await page.locator('.react-flow__resize-control').count()) === 0,
        'the run view note has a hover bar or a resizer'
      )
      await page.mouse.dblclick(ro.x, ro.y)
      await sleep(150)
      assert(
        (await page.locator(tid('wf-note-input')).count()) === 0 && (await pickedNotes()).length === 0,
        'the run view note opened for editing or was picked'
      )
      const roPos = await notePos(n1)
      const roView = await view()
      const offset = async () => (await page.locator(tid('wf-note')).boundingBox()).x - (await node(page, 'a').boundingBox()).x
      const roOffset = await offset()
      await drag(ro, { x: ro.x + 70, y: ro.y + 30 })
      const after = await view()
      assert(
        same(await notePos(n1), roPos) && Math.abs((await offset()) - roOffset) < 0.5,
        `a drag on the run view note moved it from ${JSON.stringify(roPos)} to ${JSON.stringify(await notePos(n1))}`
      )
      assert(
        Math.abs(after.x - roView.x - 70) < 2 && Math.abs(after.y - roView.y - 30) < 2,
        `a drag on the run view note did not pan: ${JSON.stringify(roView)} → ${JSON.stringify(after)}`
      )
      assert(
        asked.filter((u) => u.includes('never.png')).length === 0,
        `the run view note asked for ${JSON.stringify(asked.filter((u) => u.includes('never.png')))}`
      )
      page.off('request', onRequest)
      ok('the run view shows the note read-only: no hover bar, resizer or editor; a drag on it pans the view and leaves the note in place')
    }
  )

  await runCase(
    18,
    'groups: Ctrl+G names a chain, collapse reroutes edges and survives a reload, a drag moves it, expand pushes a neighbor, a broken group is ungrouped on save, copy to another workflow, a run shows it expanded',
    async () => {
      const BROKEN = 'Steps outside can only connect into the first step of the group'
      // trig sits below the row, so an edge from it into Beta curves under Alpha, where its hover toolbar can be reached.
      const flow = await save(
        draft(
          'Grouped',
          [
            step('trig', 'trigger', 'Trigger', 0, 300),
            step('a', 'llm', 'Alpha', 320, 100, { prompt: 'Say {{input}}', model: 'haiku' }),
            step('b', 'llm', 'Beta', 640, 100, { prompt: 'Use {{steps.a.output}}', model: 'haiku' }),
            step('c', 'llm', 'Gamma', 1280, 100, { prompt: 'c', model: 'haiku' }),
            step('side', 'llm', 'Side', 640, 400, { prompt: 's', model: 'haiku' })
          ],
          [edge('trig', 'out', 'a'), edge('a', 'out', 'b'), edge('b', 'out', 'c'), edge('c', 'out', 'side')],
          { enabled: false }
        )
      )
      // The paste target already has a step with the handle `a`, so the pasted Alpha must take another.
      const target = await save(
        draft(
          'Grouped target',
          [
            step('trig', 'trigger', 'Trigger', 0, 100),
            { ...step('x', 'llm', 'Taken', 320, 100, { prompt: 'x', model: 'haiku' }), handle: 'a' }
          ],
          [edge('trig', 'out', 'x')],
          { enabled: false }
        )
      )
      await page.goto(`${h.origin}/workflows/${flow.id}`)
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      await waitFor(
        async () => (await page.locator(tid('wf-node')).count()) === 5 && (await page.locator('.react-flow__edge').count()) === 4,
        T,
        'the five steps and four edges'
      )

      // ---- helpers ----
      const view = () =>
        page.locator('.react-flow__viewport').evaluate((el) => {
          const m = new DOMMatrix(getComputedStyle(el).transform)
          return { x: m.e, y: m.f, k: m.a }
        })
      const toScreen = (fx, fy) =>
        page.evaluate(
          ({ fx, fy }) => {
            const r = document.querySelector('.react-flow').getBoundingClientRect()
            const m = new DOMMatrix(getComputedStyle(document.querySelector('.react-flow__viewport')).transform)
            return { x: r.left + m.e + fx * m.a, y: r.top + m.f + fy * m.a }
          },
          { fx, fy }
        )
      // What a click at a screen point lands on: `head:<group>`, `box:`, `collapsed:`, `note:`, `step:<id>`, `edge` or `pane`.
      const hit = (p) =>
        page.evaluate(({ x, y }) => {
          const el = document.elementFromPoint(x, y)
          const head = el?.closest('[data-testid="wf-group-head"]')
          if (head) return `head:${head.closest('[data-testid="wf-group"]').dataset.groupId}`
          const n = el?.closest('.react-flow__node')
          if (n) {
            const c = n.classList
            return `${c.contains('react-flow__node-note') ? 'note' : c.contains('react-flow__node-groupCollapsed') ? 'collapsed' : c.contains('react-flow__node-groupBox') ? 'box' : 'step'}:${n.dataset.id}`
          }
          if (el?.closest('.react-flow__edge')) return 'edge'
          if (el?.classList.contains('react-flow__pane')) return 'pane'
          return String(el?.className?.baseVal ?? el?.className ?? el?.tagName)
        }, p)
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
      const centreOf = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })
      // A node's place in flow coordinates: React Flow's own transform on it.
      const placeOf = (sel) =>
        page.locator(sel).evaluate((el) => {
          const m = new DOMMatrix(getComputedStyle(el).transform)
          return { x: m.e, y: m.f }
        })
      const stepAt = (id) => placeOf(`.react-flow__node-step[data-id="${id}"]`)
      const folded = (id) => page.locator(`.react-flow__node-groupCollapsed[data-id="${id}"]`)
      const foldedAt = (id) => placeOf(`.react-flow__node-groupCollapsed[data-id="${id}"]`)
      const groupCount = () => page.locator(tid('wf-group')).count()
      const foldedCount = () => page.locator(tid('wf-group-collapsed')).count()
      const boxName = () =>
        page
          .locator(`${tid('wf-group')} ${tid('wf-group-name')}`)
          .first()
          .textContent({ timeout: 500 })
          .catch(() => null)
      const foldedName = (id) =>
        folded(id)
          .locator(tid('wf-group-name'))
          .textContent({ timeout: 500 })
          .catch(() => null)
      const shownSteps = async () => (await page.locator(tid('wf-node')).evaluateAll((els) => els.map((e) => e.dataset.stepId))).sort()
      const edgeNames = async () =>
        (await page.locator('.react-flow__edge').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))).sort()
      const pickedSteps = async () =>
        (
          await page.locator('.react-flow__node.selected [data-testid="wf-node"]').evaluateAll((els) => els.map((e) => e.dataset.stepId))
        ).sort()
      const selTitle = () =>
        page
          .locator(`${tid('wf-selection-inspector')} h3`)
          .textContent({ timeout: 500 })
          .catch(() => null)
      const unsaved = async () => (await page.locator(tid('wf-unsaved')).count()) === 1
      const focused = () =>
        page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null)
      const ctx = page.locator(tid('wf-ctx-menu'))
      const rows = () => page.locator(`${tid('wf-ctx-menu')} [role="menuitem"]`).evaluateAll((els) => els.map((e) => e.dataset.testid))
      const listed = async (id = flow.id) => (await rpc('workflows:list')).workflows.find((x) => x.id === id)
      const places = async (id = flow.id) => Object.fromEntries((await listed(id)).steps.map((s) => [s.id, { x: s.x, y: s.y }]))
      const collapsedKey = (id = flow.id) => page.evaluate((k) => localStorage.getItem(k), `cb.wf.collapsed.${id}`)
      const saveNow = async (what) => {
        assert(await unsaved(), `nothing to save before ${what}`)
        await page.click(tid('wf-save'))
        await waitFor(async () => !(await unsaved()), T, what)
      }
      // A spot on empty canvas away from the edges (React Flow pans on its own within 40 px of one) and the toolbar.
      const emptySpot = async () => {
        const c = await page.locator(tid('wf-canvas')).boundingBox()
        for (const [fx, fy] of [
          [0.5, 0.1],
          [0.3, 0.1],
          [0.7, 0.1],
          [0.5, 0.75],
          [0.85, 0.5]
        ]) {
          const p = { x: c.x + c.width * fx, y: c.y + c.height * fy }
          if ((await hit(p)) === 'pane') return p
        }
        throw new Error('ASSERT FAILED: no empty spot on the canvas')
      }
      const clickEmpty = async () => {
        const p = await emptySpot()
        await page.mouse.click(p.x, p.y)
      }
      const drag = async (from, to) => {
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move(to.x, to.y, { steps: 12 })
        await page.mouse.up()
      }
      // React Flow starts a node drag at the first move past its 1 px threshold and measures from there: a 2 px first move
      // makes the rest of the drag exactly (dx, dy).
      const dragNode = async (from, dx, dy) => {
        await page.mouse.move(from.x, from.y)
        await page.mouse.down()
        await page.mouse.move(from.x + 2, from.y + 2)
        await page.mouse.move(from.x + 2 + dx, from.y + 2 + dy, { steps: 10 })
        await page.mouse.up()
      }
      const boxAround = async (ids) => {
        const boxes = await Promise.all(ids.map((id) => node(page, id).boundingBox()))
        const from = { x: Math.min(...boxes.map((b) => b.x)) - 16, y: Math.min(...boxes.map((b) => b.y)) - 16 }
        assert((await hit(from)) === 'pane', `the box would start on ${await hit(from)}, not empty canvas`)
        await drag(from, { x: Math.max(...boxes.map((b) => b.x + b.width)) + 16, y: Math.max(...boxes.map((b) => b.y + b.height)) + 16 })
        await waitFor(
          async () => same(await pickedSteps(), [...ids].sort()) && (await selTitle()) === `${ids.length} items selected`,
          T,
          `a box to pick ${ids.join(', ')}`
        )
      }
      const hoverEdge = async (name) => {
        const mid = () =>
          page.locator(`.react-flow__edge[aria-label="${name}"]`).evaluate((el) => {
            const b = el.getBoundingClientRect()
            return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
          })
        let r = await mid()
        await waitFor(
          async () => {
            await sleep(100)
            const next = await mid()
            const still = next.x === r.x && next.y === r.y
            r = next
            return still
          },
          T,
          `${name} to hold still`
        )
        assert((await hit(r)) === 'edge', `the middle of ${name} is ${await hit(r)}, not the edge`)
        await page.mouse.move(r.x, r.y)
      }
      const removeEdgeByTrash = async (name) => {
        await hoverEdge(name)
        await page.locator(tid('wf-edge-bar')).waitFor({ timeout: T })
        await page.click(tid('wf-edge-delete'))
        await waitFor(async () => !(await edgeNames()).includes(name), T, `the trash to remove ${name}`)
      }
      // Where a drawn edge starts and ends on the screen.
      const edgeEnds = (name) =>
        page.evaluate((name) => {
          const path = document.querySelector(`.react-flow__edge[aria-label="${name}"] path.react-flow__edge-path`)
          if (!path) return null
          const ctm = path.getScreenCTM()
          const len = path.getTotalLength()
          const at = (l) => {
            const p = path.getPointAtLength(l)
            const s = new DOMPoint(p.x, p.y).matrixTransform(ctm)
            return { x: s.x, y: s.y }
          }
          return { start: at(0), end: at(len) }
        }, name)
      // An edge starts at a source handle's right edge and ends at a target's left edge: half a handle across from its
      // middle and level with it. A handle measured before it moved (or appeared) puts the end elsewhere, or draws no edge.
      const meets = async (name, end, handle) => {
        const e = await edgeEnds(name)
        const b = await handle.boundingBox().catch(() => null)
        if (!e || !b) return false
        const { k } = await view()
        const c = centreOf(b)
        return Math.abs(e[end].x - c.x) / k <= 8 && Math.abs(e[end].y - c.y) / k <= 2
      }
      const foldIn = (id) => folded(id).locator('.react-flow__handle.target')
      const foldOut = (id) => folded(id).locator(tid('wf-port-out'))
      // Deploy collapsed: the trigger's edge goes into its input, Beta's out of its port, Gamma → Side as it was.
      const routed = async (id) =>
        same(await edgeNames(), ['Beta → Gamma', 'Gamma → Side', 'Trigger → Alpha']) &&
        (await meets('Trigger → Alpha', 'end', foldIn(id))) &&
        (await meets('Beta → Gamma', 'start', foldOut(id)))
      const portOf = async (id) => centreOf(await node(page, id).locator(tid('wf-port-out')).boundingBox())

      // ---- Ctrl+G on a plain-drag box: "Group 1" opens for typing with its text selected; Deploy + Enter names it ----
      await boxAround(['a', 'b'])
      await page.keyboard.press('Control+G')
      await waitFor(
        async () => (await focused()) === 'wf-group-name-input',
        T,
        `Ctrl+G to open the new group's name (focus is on ${await focused()})`
      )
      const nameSel = await page
        .locator(tid('wf-group-name-input'))
        .evaluate((el) => ({ value: el.value, from: el.selectionStart, to: el.selectionEnd }))
      assert(same(nameSel, { value: 'Group 1', from: 0, to: 7 }), `the new group's name field is ${JSON.stringify(nameSel)}`)
      assert(
        (await groupCount()) === 1 && (await page.locator('.react-flow__node.selected').count()) === 0,
        'Ctrl+G did not make one group, or left items picked'
      )
      await page.keyboard.type('Deploy')
      await page.keyboard.press('Enter')
      await waitFor(
        async () => (await page.locator(tid('wf-group-name-input')).count()) === 0 && (await boxName()) === 'Deploy',
        T,
        'Enter to name the group Deploy'
      )
      const gid = await page.locator(tid('wf-group')).getAttribute('data-group-id')
      assert((await page.locator(tid('wf-group')).getAttribute('data-broken')) === 'false', 'the new group reads as broken')
      // The box is the app's own node type: React Flow's built-in `group` would get its stylesheet's padding, border and fill.
      assert(
        await page.evaluate(() => document.querySelector('.react-flow__node-group') === null),
        'a group box is a React Flow `group` node'
      )
      const boxSel = `.react-flow__node-groupBox[data-id="${gid}"]`
      assert((await page.locator(boxSel).count()) === 1, 'the group box is not a groupBox node')
      // Derived from the members: Alpha's top-left less 24 px of padding and a 36 px header, Beta's right edge plus 24.
      const boxSize = await page.locator(boxSel).evaluate((el) => el.offsetWidth)
      assert(
        same(await placeOf(boxSel), { x: 296, y: 40 }) && boxSize === 588,
        `the box sits at ${JSON.stringify(await placeOf(boxSel))}, ${boxSize} wide`
      )
      // The typed name is an undo step of its own: Ctrl+Z restores "Group 1", the next takes the group away.
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await boxName()) === 'Group 1', T, 'Ctrl+Z to take the name back to Group 1')
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await groupCount()) === 0 && !(await unsaved()), T, 'a second Ctrl+Z to take the group away')
      await page.keyboard.press('Control+Shift+Z')
      await page.keyboard.press('Control+Shift+Z')
      await waitFor(
        async () => (await boxName()) === 'Deploy' && (await page.locator(tid('wf-group')).getAttribute('data-group-id')) === gid,
        T,
        'two Ctrl+Shift+Z to bring back Deploy'
      )
      await saveNow('the save of the new group')
      let stored = await listed()
      assert(
        stored.groups.length === 1 && same({ ...stored.groups[0] }, { id: gid, name: 'Deploy', steps: ['a', 'b'], notes: [] }),
        `the stored groups are ${JSON.stringify(stored.groups)}`
      )
      ok(
        `a plain-drag box and Ctrl+G made "Group 1" with its name selected; Deploy + Enter renamed it; the box is a groupBox node at (296, 40), 588 wide; two Ctrl+Z undid name then group; saved as {${gid}: Deploy, [a, b]}`
      )

      // ---- the header fields: a blank name reverts, Esc cancels, canvas keys only type, the description stops at 145 ----
      const v0 = await view()
      const quiet = async (what) => {
        assert(same(await view(), v0), `${what} moved or zoomed the view`)
        assert(
          (await page.locator(tid('wf-canvas')).getAttribute('data-pan')) === 'false' &&
            (await page.locator(tid('wf-add-menu')).count()) === 0,
          `${what} turned Pan mode on or opened the Add step menu`
        )
        assert(
          (await page.locator(tid('wf-node')).count()) === 5 &&
            (await page.locator(tid('wf-note')).count()) === 0 &&
            (await groupCount()) === 1,
          `${what} added or removed items`
        )
      }
      const openName = async () => {
        await page.locator(`${tid('wf-group')} ${tid('wf-group-name')}`).click()
        await waitFor(async () => (await focused()) === 'wf-group-name-input', T, 'a click on the name to open it')
      }
      await openName()
      await page.keyboard.press('Control+A')
      await page.keyboard.press('Backspace')
      await page.keyboard.press('Enter')
      await waitFor(
        async () => (await page.locator(tid('wf-group-name-input')).count()) === 0 && (await boxName()) === 'Deploy',
        T,
        'a blank name to revert to Deploy'
      )
      assert(!(await unsaved()), 'a blank name made an edit')
      await openName()
      await page.keyboard.type('Nope')
      await page.keyboard.press('Escape')
      await waitFor(
        async () => (await page.locator(tid('wf-group-name-input')).count()) === 0 && (await boxName()) === 'Deploy',
        T,
        'Esc to cancel the typed name'
      )
      assert(!(await unsaved()) && (await groupCount()) === 1, 'Esc made an edit or took the group')
      await openName()
      await page.keyboard.press('End')
      await page.keyboard.type('nh1+-0')
      for (const k of ['Shift+S', 'Delete']) await page.keyboard.press(k)
      await sleep(300) // past the 150 ms a zoom key animates
      assert(
        (await page.locator(tid('wf-group-name-input')).inputValue()) === 'Deploynh1+-0S',
        `the name field holds ${JSON.stringify(await page.locator(tid('wf-group-name-input')).inputValue())}`
      )
      await quiet('typing in the name')
      await page.keyboard.press('Escape')
      await waitFor(async () => (await boxName()) === 'Deploy' && !(await unsaved()), T, 'Esc to drop the typed keys')
      const addDesc = page.locator(`${tid('wf-group')} ${tid('wf-group-desc')}`)
      assert((await addDesc.textContent()) === 'Add description', `the empty description reads ${await addDesc.textContent()}`)
      await addDesc.click()
      await waitFor(async () => (await focused()) === 'wf-group-desc-input', T, 'Add description to open the description')
      const LONG = 'nh1+-0 '.repeat(25).slice(0, 150)
      await page.keyboard.type(LONG)
      await sleep(300)
      const descValue = await page.locator(tid('wf-group-desc-input')).inputValue()
      assert(
        descValue === LONG.slice(0, 145),
        `150 typed characters left ${descValue.length} in the description: ${JSON.stringify(descValue)}`
      )
      await quiet('typing in the description')
      await page.keyboard.press('Enter')
      await waitFor(
        async () => (await addDesc.textContent()) === LONG.slice(0, 145) && (await unsaved()),
        T,
        'Enter to land the description'
      )
      await page.keyboard.press('Control+Z')
      await waitFor(
        async () => (await addDesc.textContent()) === 'Add description' && !(await unsaved()),
        T,
        'Ctrl+Z to take the description away'
      )
      ok(
        'a blank name reverted, Esc cancelled, n h 1 + - 0 Shift+S Delete only typed in the name; 150 typed characters left 145 in the description, which Enter landed and Ctrl+Z took back'
      )

      // ---- the header's menu acts on its group; the canvas menu collapses and expands all ----
      const hb = await page.locator(`${tid('wf-group')} ${tid('wf-group-head')}`).boundingBox()
      const headSpot = { x: hb.x + hb.width - 30, y: hb.y + hb.height / 2 }
      assert((await hit(headSpot)) === `head:${gid}`, `the header's right end is ${await hit(headSpot)}`)
      const HEAD_ROWS = [
        'wf-ctx-rename',
        'wf-ctx-editDescription',
        'wf-ctx-collapse',
        'wf-ctx-selectGroup',
        'wf-ctx-copyGroup',
        'wf-ctx-ungroup',
        'wf-ctx-deleteGroup'
      ]
      await page.mouse.click(headSpot.x, headSpot.y, { button: 'right' })
      await ctx.waitFor({ timeout: T })
      assert(same(await rows(), HEAD_ROWS), `the group header's menu is ${JSON.stringify(await rows())}`)
      assert(
        (await page.locator('.react-flow__node.selected').count()) === 0 && (await groupCount()) === 1,
        'the header right-click picked something or collapsed the group'
      )
      await page.click(tid('wf-ctx-selectGroup'))
      await waitFor(
        async () => same(await pickedSteps(), ['a', 'b']) && (await selTitle()) === '2 items selected',
        T,
        'Select its items to pick Alpha and Beta'
      )
      await page.mouse.click(headSpot.x, headSpot.y, { button: 'right' })
      await page.click(tid('wf-ctx-rename'))
      await waitFor(async () => (await focused()) === 'wf-group-name-input', T, "the menu's Rename to open the name in the header")
      await page.keyboard.press('Escape')
      await waitFor(async () => (await page.locator(tid('wf-group-name-input')).count()) === 0, T, 'Esc to close the name')
      const pane = await emptySpot()
      await page.mouse.click(pane.x, pane.y, { button: 'right' })
      await ctx.waitFor({ timeout: T })
      assert(
        same(await rows(), [
          'wf-ctx-addStep',
          'wf-ctx-addNote',
          'wf-ctx-paste',
          'wf-ctx-selectAll',
          'wf-ctx-expandAll',
          'wf-ctx-collapseAll',
          'wf-ctx-fit'
        ]),
        `the canvas menu is ${JSON.stringify(await rows())}`
      )
      await page.click(tid('wf-ctx-collapseAll'))
      await waitFor(async () => (await foldedCount()) === 1 && (await groupCount()) === 0, T, 'Collapse all groups')
      const fc = centreOf(await folded(gid).boundingBox())
      await page.mouse.click(fc.x, fc.y, { button: 'right' })
      await ctx.waitFor({ timeout: T })
      assert(
        same(
          await rows(),
          HEAD_ROWS.map((r) => (r === 'wf-ctx-collapse' ? 'wf-ctx-expand' : r))
        ),
        `the collapsed group's menu is ${JSON.stringify(await rows())}`
      )
      await page.click(tid('wf-ctx-expand'))
      await waitFor(async () => (await groupCount()) === 1 && (await foldedCount()) === 0, T, "the collapsed group's Expand")
      assert(!(await unsaved()), 'expanding with nothing in the way made an edit')
      ok(
        'the header menu lists Rename … Delete group without picking anything; Select its items picked Alpha and Beta; Rename opened the name; the canvas menu offers Expand all and Collapse all; a collapsed group offers Expand'
      )

      // ---- the chevron collapses: one node, members hidden, the crossing edges drawn to its handles; not an edit ----
      await page.locator(`${tid('wf-group')} ${tid('wf-group-toggle')}`).click()
      await waitFor(async () => (await foldedCount()) === 1 && (await groupCount()) === 0, T, 'the chevron to collapse Deploy')
      assert(same(await shownSteps(), ['c', 'side', 'trig']), `collapsed, the canvas shows ${JSON.stringify(await shownSteps())}`)
      await waitFor(() => routed(gid), T, `the edges into and out of Deploy drawn to its handles (${JSON.stringify(await edgeNames())})`)
      assert(
        same(await foldedAt(gid), { x: 296, y: 40 }) && (await folded(gid).locator(tid('wf-group-count')).textContent()) === '2 steps',
        "the collapsed node is not at the box's top-left, or does not count 2 steps"
      )
      assert(!(await unsaved()) && (await page.locator(tid('wf-save')).isDisabled()), 'collapsing made an edit')
      assert((await collapsedKey()) === JSON.stringify([gid]), `the collapse state stored is ${await collapsedKey()}`)
      // The group's only input goes, and its handle with it. React Flow keeps a gone handle's old bounds, so the node is
      // expanded and collapsed again: mounted with no input, it must measure the input that comes back afresh.
      const refold = async () => {
        await folded(gid).locator(tid('wf-group-toggle')).click()
        await waitFor(async () => (await groupCount()) === 1 && (await foldedCount()) === 0, T, 'the chevron to expand Deploy')
        await page.locator(`${tid('wf-group')} ${tid('wf-group-toggle')}`).click()
        await waitFor(
          async () => (await foldedCount()) === 1 && (await groupCount()) === 0 && (await foldIn(gid).count()) === 0,
          T,
          'the chevron to collapse Deploy, with no input'
        )
        // React Flow measures a new node in a ResizeObserver callback, a frame after it mounts. An input added before that
        // would be measured with the node and prove nothing, so two frames go by first.
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))))
      }
      await removeEdgeByTrash('Trigger → Alpha')
      await waitFor(async () => (await foldIn(gid).count()) === 0, T, 'the input handle to go with the only edge in')
      await refold()
      await page.keyboard.press('Control+Z')
      await waitFor(
        () => routed(gid),
        T,
        `Ctrl+Z to draw the restored edge into the input handle (${JSON.stringify(await edgeEnds('Trigger → Alpha'))})`
      )
      await page.keyboard.press('Control+Shift+Z')
      await waitFor(
        async () => (await foldIn(gid).count()) === 0 && same(await edgeNames(), ['Beta → Gamma', 'Gamma → Side']),
        T,
        'Ctrl+Shift+Z to remove it again'
      )
      await refold()
      // A connection dropped on the collapsed group's body, with no entry yet, joins its head step (Alpha), drawn to the new handle.
      await drag(await portOf('trig'), centreOf(await folded(gid).boundingBox()))
      await waitFor(
        () => routed(gid),
        T,
        `a drop on the collapsed group to connect Trigger → Alpha into its input (${JSON.stringify(await edgeNames())})`
      )
      assert((await page.locator(tid('wf-add-menu')).count()) === 0, 'a drop on the collapsed group opened the Add step menu')
      await page.keyboard.press('Control+Z')
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await routed(gid)) && !(await unsaved()), T, 'two Ctrl+Z back to the saved edges')
      await page.reload()
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      await waitFor(
        async () => (await foldedCount()) === 1 && (await groupCount()) === 0 && same(await shownSteps(), ['c', 'side', 'trig']),
        T,
        'the reload to keep Deploy collapsed'
      )
      await waitFor(() => routed(gid), T, 'the reloaded edges drawn to the collapsed handles')
      ok(
        'collapsed: one node at (296, 40), "2 steps", edges in and out drawn to its handles, not an edit, kept in localStorage and over a reload; the input handle follows a removed, restored and dropped edge'
      )

      // ---- F2 on the picked collapsed group renames it in its panel; a click outside and Ctrl+Z undo the typing ----
      await folded(gid).locator(tid('wf-group-count')).click()
      await waitFor(
        async () => (await page.locator(`${tid('wf-canvas-group-inspector')}[data-group-id="${gid}"]`).count()) === 1,
        T,
        'a click to pick the collapsed group'
      )
      assert(
        (await page.locator(tid('wf-canvas-group-count')).textContent()) === '2 steps, shown as one node.',
        'the group panel does not count 2 steps'
      )
      await page.keyboard.press('F2')
      await waitFor(async () => (await focused()) === 'wf-canvas-group-name', T, 'F2 to focus the group name')
      const f2 = await page
        .locator(tid('wf-canvas-group-name'))
        .evaluate((el) => ({ value: el.value, from: el.selectionStart, to: el.selectionEnd }))
      assert(same(f2, { value: 'Deploy', from: 0, to: 6 }), `F2 left the name field at ${JSON.stringify(f2)}`)
      await page.keyboard.type('Ship')
      await waitFor(async () => (await foldedName(gid)) === 'Ship' && (await unsaved()), T, 'the typed name to show on the collapsed node')
      await clickEmpty()
      await page.keyboard.press('Control+Z')
      await waitFor(async () => (await foldedName(gid)) === 'Deploy' && !(await unsaved()), T, 'Ctrl+Z to take the typed name back')
      ok('F2 on the picked collapsed group selected its name in the panel; "Ship" showed on the node; Ctrl+Z on the canvas took it back')

      // ---- a drag of the collapsed group moves both members by the same whole-grid amount, as one edit ----
      const before = await places()
      const { k } = await view()
      await dragNode(centreOf(await folded(gid).locator(tid('wf-group-count')).boundingBox()), 80 * k, 0)
      await waitFor(
        async () => same(await foldedAt(gid), { x: 376, y: 40 }) && (await unsaved()),
        T,
        `the collapsed group to land 80 to the right (it is at ${JSON.stringify(await foldedAt(gid))})`
      )
      await page.keyboard.press('Control+Z')
      await waitFor(
        async () => same(await foldedAt(gid), { x: 296, y: 40 }) && !(await unsaved()),
        T,
        'one Ctrl+Z to put both members back'
      )
      await page.keyboard.press('Control+Shift+Z')
      await waitFor(async () => same(await foldedAt(gid), { x: 376, y: 40 }), T, 'Ctrl+Shift+Z to move them again')
      await saveNow('the save of the group drag')
      let after = await places()
      const moved = (id) => ({ dx: after[id].x - before[id].x, dy: after[id].y - before[id].y })
      assert(
        same(moved('a'), { dx: 80, dy: 0 }) && same(moved('b'), { dx: 80, dy: 0 }),
        `the members moved by ${JSON.stringify({ a: moved('a'), b: moved('b') })}`
      )
      assert(
        ['trig', 'c', 'side'].every((id) => same(moved(id), { dx: 0, dy: 0 })),
        `a step outside the group moved: ${JSON.stringify(after)}`
      )
      ok('a drag of the collapsed node moved Alpha and Beta by (80, 0) each, one Ctrl+Z put both back, and the save shows it')

      // ---- expanding pushes the step dropped where the box opens: right to the grid line past the box plus 40 ----
      // Side goes just right of the collapsed node (376..596), from (640, 400) to (620, 40), inside where Deploy's box opens.
      await dragNode(centreOf(await node(page, 'side').boundingBox()), -20 * k, -360 * k)
      await waitFor(
        async () => same(await stepAt('side'), { x: 620, y: 40 }),
        T,
        `Side to land at (620, 40) (it is at ${JSON.stringify(await stepAt('side'))})`
      )
      await saveNow('the save of Side by the group')
      assert(same((await places()).side, { x: 620, y: 40 }), `Side was saved at ${JSON.stringify((await places()).side)}`)
      await folded(gid).locator(tid('wf-group-toggle')).click()
      await waitFor(
        async () => (await groupCount()) === 1 && (await foldedCount()) === 0 && (await unsaved()),
        T,
        'the chevron to expand Deploy and push Side'
      )
      // The box's right edge is Beta's (720 + its width) plus 24 of padding; the push clears it by 40, up to the grid.
      const bWidth = await node(page, 'b').evaluate((el) => el.offsetWidth)
      const pushedTo = Math.ceil((720 + bWidth + 24 + 40) / 20) * 20
      assert(bWidth === 220 && pushedTo === 1020, `Beta is ${bWidth} wide, so the push goes to ${pushedTo}`)
      await waitFor(
        async () => same(await stepAt('side'), { x: 1020, y: 40 }),
        T,
        `Side to be pushed to (1020, 40) (it is at ${JSON.stringify(await stepAt('side'))})`
      )
      await saveNow('the save of the push')
      after = await places()
      assert(
        same(after, { ...before, a: { x: 400, y: 100 }, b: { x: 720, y: 100 }, side: { x: 1020, y: 40 } }),
        `the saved places are ${JSON.stringify(after)}`
      )
      ok(
        "Side dropped by the collapsed group at (620, 40); expanding pushed it to (1020, 40) (Beta's right 940 + 24 + 40, up to the grid) and only it; saved"
      )

      // ---- the group keys: Ctrl+Shift+G, Alt+G and Shift+Alt+G (picked or all), Enter, Delete ----
      await node(page, 'a').click()
      await waitFor(
        async () => (await page.locator(`${tid('wf-step-inspector')}[data-step-id="a"]`).count()) === 1,
        T,
        'a click to pick Alpha'
      )
      await page.keyboard.press('Control+Shift+G')
      await waitFor(async () => (await groupCount()) === 0 && (await unsaved()), T, 'Ctrl+Shift+G to ungroup')
      assert(same(await shownSteps(), ['a', 'b', 'c', 'side', 'trig']), 'ungrouping removed steps')
      await page.keyboard.press('Control+Z')
      await waitFor(
        async () => (await groupCount()) === 1 && (await boxName()) === 'Deploy' && !(await unsaved()),
        T,
        'Ctrl+Z to bring the group back'
      )
      await clickEmpty()
      await page.keyboard.press('Shift+Alt+G')
      await waitFor(
        async () => (await foldedCount()) === 1 && (await groupCount()) === 0,
        T,
        'Shift+Alt+G with nothing picked to collapse every group'
      )
      await page.keyboard.press('Alt+G')
      await waitFor(
        async () => (await groupCount()) === 1 && (await foldedCount()) === 0,
        T,
        'Alt+G with nothing picked to expand every group'
      )
      assert(!(await unsaved()), 'collapsing and expanding made an edit')
      await node(page, 'a').click()
      await page.keyboard.press('Shift+Alt+G')
      await waitFor(
        async () => (await foldedCount()) === 1 && (await page.locator(tid('wf-inspector-empty')).count()) === 1,
        T,
        "Shift+Alt+G to collapse the picked Alpha's group and let the hidden Alpha go"
      )
      assert((await page.locator('.react-flow__node.selected').count()) === 0, 'a hidden member stayed picked')
      await folded(gid).locator(tid('wf-group-count')).click()
      await page.locator(tid('wf-canvas-group-inspector')).waitFor({ timeout: T })
      await page.keyboard.press('Enter')
      await waitFor(
        async () => (await groupCount()) === 1 && (await foldedCount()) === 0 && !(await unsaved()),
        T,
        'Enter on the picked collapsed group to expand it'
      )
      await page.locator(`${tid('wf-group')} ${tid('wf-group-toggle')}`).click()
      await waitFor(async () => (await foldedCount()) === 1, T, 'the chevron to collapse it again')
      await folded(gid).locator(tid('wf-group-count')).click()
      await page.locator(tid('wf-canvas-group-inspector')).waitFor({ timeout: T })
      await page.keyboard.press('Delete')
      await waitFor(
        async () =>
          (await foldedCount()) === 0 && same(await shownSteps(), ['c', 'side', 'trig']) && same(await edgeNames(), ['Gamma → Side']),
        T,
        'Delete to take the collapsed group and its members'
      )
      await page.keyboard.press('Control+Z')
      await waitFor(
        async () => (await foldedCount()) === 1 && (await routed(gid)) && !(await unsaved()),
        T,
        'one Ctrl+Z to bring the group, its members and their edges back'
      )
      await folded(gid).locator(tid('wf-group-toggle')).click()
      await waitFor(
        async () => (await groupCount()) === 1 && same(await shownSteps(), ['a', 'b', 'c', 'side', 'trig']),
        T,
        'the chevron to expand Deploy'
      )
      ok(
        "Ctrl+Shift+G ungrouped (steps kept) and Ctrl+Z regrouped; Shift+Alt+G and Alt+G act on all with nothing picked, on the picked step's group otherwise; Enter expanded; Delete took group and members, one Ctrl+Z brought them back"
      )

      // ---- an edge from outside into Beta breaks the group; the save ungroups it, says so, and cannot be undone ----
      await drag(await portOf('trig'), centreOf(await node(page, 'b').boundingBox()))
      await waitFor(async () => (await edgeNames()).includes('Trigger → Beta'), T, 'a drop on Beta to connect Trigger → Beta')
      await waitFor(
        async () => (await page.locator(tid('wf-group')).getAttribute('data-broken')) === 'true',
        T,
        'the group to show as broken'
      )
      assert(
        (await page.locator(tid('wf-group-warn')).textContent()) === `Will be ungrouped on save: ${BROKEN}`,
        `the header warns ${await page.locator(tid('wf-group-warn')).textContent()}`
      )
      await page.click(tid('wf-save'))
      await waitFor(
        async () =>
          !(await unsaved()) &&
          (await page
            .locator(`${tid('wf-notice')} .wf-notice-text`)
            .textContent({ timeout: 500 })
            .catch(() => null)) === `Ungrouped Deploy: ${BROKEN}.`,
        T,
        'the save to ungroup Deploy and say why'
      )
      assert(
        (await page.locator(tid('wf-notice')).getAttribute('data-tone')) === 'warn' && (await groupCount()) === 0,
        'the ungroup notice is not a warning, or the group still shows'
      )
      stored = await listed()
      assert(
        (stored.groups ?? []).length === 0 && stored.edges.length === 5,
        `the save kept ${JSON.stringify(stored.groups)} and ${stored.edges.length} edges`
      )
      await page.keyboard.press('Control+Z')
      await sleep(300)
      assert(
        (await groupCount()) === 0 && (await edgeNames()).includes('Trigger → Beta') && !(await unsaved()),
        'Ctrl+Z after the ungrouping save brought back the group or the edge'
      )
      await removeEdgeByTrash('Trigger → Beta')
      await saveNow('the save without Trigger → Beta')
      assert((await listed()).edges.length === 4, 'the removed edge is still stored')
      ok(
        `Trigger → Beta made Deploy broken ("Will be ungrouped on save: …"); Save ungrouped it with "Ungrouped Deploy: ${BROKEN}.", reset the history, and the trash then removed the edge`
      )

      // ---- group again (Enter keeps "Group 1": one Ctrl+Z undoes it), collapse, copy it and paste into another workflow ----
      await boxAround(['a', 'b'])
      await page.keyboard.press('Control+G')
      await waitFor(async () => (await focused()) === 'wf-group-name-input', T, 'Ctrl+G again')
      await page.keyboard.press('Enter')
      await waitFor(
        async () => (await page.locator(tid('wf-group-name-input')).count()) === 0 && (await boxName()) === 'Group 1',
        T,
        'Enter to keep Group 1'
      )
      const gid2 = await page.locator(tid('wf-group')).getAttribute('data-group-id')
      await page.keyboard.press('Control+Z')
      await waitFor(
        async () => (await groupCount()) === 0 && !(await unsaved()),
        T,
        'one Ctrl+Z to take away a group whose default name was kept'
      )
      await page.keyboard.press('Control+Shift+Z')
      await waitFor(async () => (await groupCount()) === 1, T, 'Ctrl+Shift+Z to make it again')
      await saveNow('the save of Group 1')
      stored = await listed()
      assert(
        stored.groups.length === 1 && same({ ...stored.groups[0] }, { id: gid2, name: 'Group 1', steps: ['a', 'b'], notes: [] }),
        `the stored groups are ${JSON.stringify(stored.groups)}`
      )
      await page.locator(`${tid('wf-group')} ${tid('wf-group-toggle')}`).click()
      await waitFor(async () => (await foldedCount()) === 1, T, 'the chevron to collapse Group 1')
      await folded(gid2).locator(tid('wf-group-count')).click()
      await page.locator(tid('wf-canvas-group-inspector')).waitFor({ timeout: T })
      await page.evaluate(() => {
        window.__clips = []
        window.addEventListener('copy', (e) => window.__clips.push(e.clipboardData?.getData('text/plain') ?? ''))
      })
      await page.keyboard.press('Control+C')
      let clipText = null
      await waitFor(async () => (clipText = await page.evaluate(() => window.__clips.at(-1) ?? null)) !== null, T, 'Ctrl+C to fire a copy')
      const clip = JSON.parse(clipText)
      assert(
        same(
          clip.steps.map((s) => s.id),
          ['a', 'b']
        ) &&
          same(
            clip.edges.map((e) => `${e.from}>${e.to}`),
            ['a>b']
          ),
        `the clip holds ${JSON.stringify(clip.steps.map((s) => s.id))} and ${JSON.stringify(clip.edges)}`
      )
      assert(
        clip.groups.length === 1 && same({ ...clip.groups[0] }, { id: gid2, name: 'Group 1', steps: ['a', 'b'], notes: [] }),
        `the clip's groups are ${JSON.stringify(clip.groups)}`
      )
      await page.locator(`${tid('workflow-row')}[data-workflow-id="${target.id}"] .routine-row`).click()
      await page.waitForURL(`${h.origin}/workflows/${target.id}`, { timeout: T })
      await waitFor(async () => (await page.locator(tid('wf-node')).count()) === 2, T, 'the target with its two steps')
      await clickEmpty()
      await page.keyboard.press('Control+V')
      await waitFor(
        async () =>
          (await page.locator(tid('wf-node')).count()) === 4 && (await groupCount()) === 1 && (await edgeNames()).includes('Alpha → Beta'),
        T,
        'Ctrl+V to paste the group, expanded, with its two steps and their edge'
      )
      await saveNow('the save of the pasted group')
      const tw = await listed(target.id)
      const pa = tw.steps.find((s) => s.name === 'Alpha')
      const pb = tw.steps.find((s) => s.name === 'Beta')
      assert(
        tw.steps.length === 4 &&
          pa &&
          pb &&
          ![flow.id, 'a', 'b', 'x', 'trig'].includes(pa.id) &&
          ![flow.id, 'a', 'b', 'x', 'trig'].includes(pb.id) &&
          pa.id !== pb.id,
        `the target holds ${JSON.stringify(tw.steps.map((s) => [s.id, s.handle, s.name]))}`
      )
      assert(
        pa.handle === 'a-2' && pb.handle === 'b' && pb.prompt === 'Use {{steps.a-2.output}}',
        `the pasted handles are ${pa.handle}, ${pb.handle}; Beta's prompt is ${JSON.stringify(pb.prompt)}`
      )
      assert(
        tw.edges.some((e) => e.from === pa.id && e.to === pb.id && e.port === 'out'),
        `the pasted edge is missing from ${JSON.stringify(tw.edges)}`
      )
      assert(
        tw.groups.length === 1 &&
          ![gid, gid2].includes(tw.groups[0].id) &&
          tw.groups[0].name === 'Group 1' &&
          same([...tw.groups[0].steps].sort(), [pa.id, pb.id].sort()) &&
          tw.groups[0].notes.length === 0,
        `the target's groups are ${JSON.stringify(tw.groups)}`
      )
      ok(
        `Enter kept "Group 1" (one Ctrl+Z took it away); collapsed, picked and Ctrl+C'd, it pasted into the target as one new group (${tw.groups[0].id}) of two new steps, handles a-2 and b, the edge and the template rewritten`
      )

      // ---- a run shows the group expanded; collapsed there (with the run's state mark) only for this look ----
      assert((await collapsedKey()) === JSON.stringify([gid2]), `the editor stored ${await collapsedKey()} as collapsed`)
      const { id: runId } = await rpc('workflows:run', flow.id)
      const done = await runUntil(runId, ended, 'the Grouped run to end')
      assert(
        done.status === 'done' && (done.snapshot.groups ?? []).length === 1 && done.snapshot.groups[0].id === gid2,
        `the run ended ${done.status} with groups ${JSON.stringify(done.snapshot.groups)}`
      )
      await page.goto(runUrl(flow.id, runId))
      await page.locator(tid('workflow-run-view')).waitFor({ timeout: T })
      await waitFor(
        async () => (await page.locator(tid('wf-node')).count()) === 5 && (await groupCount()) === 1 && (await foldedCount()) === 0,
        T,
        'the run view with Group 1 expanded'
      )
      assert((await page.locator(`${tid('wf-group')} ${tid('wf-group-desc')}`).count()) === 0, 'the run view offers Add description')
      // The editor's stored state (Group 1 collapsed) did not reach the run view. A value no editor would write takes its
      // place now, so any write the run view makes shows.
      const kept = '["kept-by-the-editor"]'
      await page.evaluate(({ key, kept }) => localStorage.setItem(key, kept), { key: `cb.wf.collapsed.${flow.id}`, kept })
      const rh = await page.locator(`${tid('wf-group')} ${tid('wf-group-head')}`).boundingBox()
      await page.mouse.click(rh.x + rh.width - 30, rh.y + rh.height / 2, { button: 'right' })
      await sleep(150)
      assert((await ctx.count()) === 0, 'the run view has a group menu')
      // A click on the name there is a click on the header: it collapses, never opens the name for typing.
      await page.locator(`${tid('wf-group')} ${tid('wf-group-name')}`).click()
      await waitFor(
        async () => (await foldedCount()) === 1 && (await groupCount()) === 0,
        T,
        'a click on the header to collapse the group in the run view'
      )
      assert((await page.locator(tid('wf-group-name-input')).count()) === 0, 'the run view opened the name for typing')
      const mark = folded(gid2).locator(tid('wf-node-state'))
      const runStates = () =>
        page.locator(tid('wf-node')).evaluateAll((els) => Object.fromEntries(els.map((e) => [e.dataset.stepId, e.dataset.state ?? null])))
      assert(
        (await folded(gid2).locator(tid('wf-group-collapsed')).getAttribute('data-state')) === 'done' &&
          (await mark.count()) === 1 &&
          (await mark.getAttribute('class')) === 'wf-node-state done',
        `the collapsed group in the run is ${await folded(gid2).locator(tid('wf-group-collapsed')).getAttribute('data-state')} (${await mark.count()} marks), its neighbors ${JSON.stringify(await runStates())}`
      )
      // A drag on it pans the view and leaves it in place, still collapsed.
      const rp = await foldedAt(gid2)
      const rv = await view()
      const rc = centreOf(await folded(gid2).locator(tid('wf-group-count')).boundingBox())
      await drag(rc, { x: rc.x + 60, y: rc.y + 30 })
      const rv2 = await view()
      assert(
        same(await foldedAt(gid2), rp) && (await foldedCount()) === 1,
        `a drag moved or expanded the run's collapsed group (${JSON.stringify(await foldedAt(gid2))})`
      )
      assert(
        Math.abs(rv2.x - rv.x - 60) < 2 && Math.abs(rv2.y - rv.y - 30) < 2,
        `a drag on the run's collapsed group did not pan: ${JSON.stringify(rv)} → ${JSON.stringify(rv2)}`
      )
      assert((await collapsedKey()) === kept, `collapsing in the run view stored ${await collapsedKey()}`)
      await folded(gid2).locator(tid('wf-group-count')).click()
      await waitFor(
        async () => (await groupCount()) === 1 && (await foldedCount()) === 0,
        T,
        'a click on the collapsed group in a run to expand it'
      )
      await page.locator(`${tid('wf-group')} ${tid('wf-group-toggle')}`).click()
      await waitFor(async () => (await foldedCount()) === 1, T, 'the chevron to collapse it in the run view')
      await page.reload()
      await page.locator(tid('workflow-run-view')).waitFor({ timeout: T })
      await waitFor(
        async () => (await groupCount()) === 1 && (await foldedCount()) === 0,
        T,
        'the reloaded run view to show the group expanded again'
      )
      assert((await collapsedKey()) === kept, 'the run view changed the stored collapse state')
      ok(
        'the run shows Group 1 expanded with no description field or menu; the header collapses it to a node marked done; a drag pans; a click expands; nothing is remembered over a reload'
      )

      // ---- a wrapper note and a member note: stacking, the header over the backdrop, a push that leaves the backdrop ----
      const back = await save(
        draft(
          'Backdrop',
          [
            step('trig', 'trigger', 'Trigger', 0, 100),
            step('p', 'llm', 'Plan', 320, 100, { prompt: 'p', model: 'haiku' }),
            step('q', 'llm', 'Queue', 640, 100, { prompt: 'q', model: 'haiku' }),
            step('loose', 'llm', 'Loose', 600, 260, { prompt: 'l', model: 'haiku' })
          ],
          [edge('trig', 'out', 'p'), edge('p', 'out', 'q')],
          {
            enabled: false,
            notes: [
              // The wrapper holds the collapsed node's whole footprint (296..516 × 40..104): a backdrop the push leaves alone.
              { id: 'wrap', x: 260, y: 0, width: 300, height: 140, color: 2, text: '## Phase' },
              { id: 'inner', x: 320, y: 220, width: 200, height: 100, color: 5, text: 'Inside' }
            ],
            groups: [{ id: 'g', name: 'Phase', steps: ['p', 'q'], notes: ['inner'] }]
          }
        )
      )
      await page.evaluate((key) => localStorage.setItem(key, '["g"]'), `cb.wf.collapsed.${back.id}`)
      await page.goto(`${h.origin}/workflows/${back.id}`)
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      await waitFor(
        async () =>
          (await foldedCount()) === 1 &&
          same(await shownSteps(), ['loose', 'trig']) &&
          same(await page.locator('.react-flow__node-note').evaluateAll((els) => els.map((e) => e.dataset.id)), ['wrap']),
        T,
        'Backdrop opened with Phase collapsed over its wrapper note'
      )
      assert(
        (await folded('g').locator(tid('wf-group-count')).textContent()) === '2 steps · 1 note',
        'the collapsed node does not count 2 steps and a note'
      )
      // Collapsed from the first frame (its members never measured): the trigger's edge is still drawn into its input.
      await waitFor(
        async () => same(await edgeNames(), ['Trigger → Plan']) && (await meets('Trigger → Plan', 'end', foldIn('g'))),
        T,
        `Trigger → Plan drawn into the collapsed Phase (${JSON.stringify(await edgeNames())})`
      )
      await folded('g').locator(tid('wf-group-toggle')).click()
      // The box spans 296..884 × 40..344 (Queue's right edge and the inner note's bottom, plus padding): Loose moves to
      // 884 + 40 on the grid, 940; the wrapper note, behind the group, stays.
      await waitFor(
        async () => (await groupCount()) === 1 && same(await stepAt('loose'), { x: 940, y: 260 }),
        T,
        `expanding Phase to push Loose to (940, 260) (it is at ${JSON.stringify(await stepAt('loose').catch(() => null))})`
      )
      assert(
        same(await placeOf('.react-flow__node-note[data-id="wrap"]'), { x: 260, y: 0 }),
        `the wrapper note moved to ${JSON.stringify(await placeOf('.react-flow__node-note[data-id="wrap"]'))}`
      )
      await page.keyboard.press('Control+Z')
      await waitFor(
        async () => same(await stepAt('loose'), { x: 600, y: 260 }) && (await groupCount()) === 1 && !(await unsaved()),
        T,
        'Ctrl+Z to put Loose back and leave Phase expanded'
      )
      await page.keyboard.press('Control+Shift+Z')
      await waitFor(async () => same(await stepAt('loose'), { x: 940, y: 260 }), T, 'Ctrl+Shift+Z to push it again')
      await saveNow('the save of the push')
      const bw = await listed(back.id)
      const spot = (list) => Object.fromEntries(list.map((x) => [x.id, [x.x, x.y]]))
      assert(
        same(spot(bw.steps), { trig: [0, 100], p: [320, 100], q: [640, 100], loose: [940, 260] }) &&
          same(spot(bw.notes), { wrap: [260, 0], inner: [320, 220] }),
        `the saved Backdrop is ${JSON.stringify({ steps: spot(bw.steps), notes: spot(bw.notes) })}`
      )
      ok(
        'Phase expanded over its wrapper note: Loose pushed from 600 to 940 (884 + 40 on the grid), the wrapper stayed at (260, 0); Ctrl+Z and Ctrl+Shift+Z; saved'
      )

      // Painted order: wrapper note (-1000) < box (-500) < its own note (-400 + its rank) < steps and edges (0).
      const zOf = (sel) => page.locator(sel).evaluate((el) => getComputedStyle(el).zIndex)
      const z = {
        wrap: await zOf('.react-flow__node-note[data-id="wrap"]'),
        box: await zOf('.react-flow__node-groupBox[data-id="g"]'),
        inner: await zOf('.react-flow__node-note[data-id="inner"]'),
        steps: [...new Set(await page.locator('.react-flow__node-step').evaluateAll((els) => els.map((e) => getComputedStyle(e).zIndex)))],
        edges: [
          ...new Set(
            await page.locator('.react-flow__edge').evaluateAll((els) => els.map((e) => getComputedStyle(e.ownerSVGElement).zIndex))
          )
        ]
      }
      assert(same(z, { wrap: '-1000', box: '-500', inner: '-399', steps: ['0'], edges: ['0'] }), `the z order is ${JSON.stringify(z)}`)
      // The pointer: the header takes it over the wrapper note; the box's body passes it to the wrapper below, to the
      // canvas where nothing is under it; the member note and the steps take their own.
      const at = async (fx, fy) => hit(await toScreen(fx, fy))
      const hits = {
        head: await at(500, 52),
        overWrap: await at(306, 120),
        bare: await at(720, 300),
        inner: await at(420, 270),
        step: await at(430, 140)
      }
      assert(
        same(hits, { head: 'head:g', overWrap: 'note:wrap', bare: 'pane', inner: 'note:inner', step: 'step:p' }),
        `the pointer lands on ${JSON.stringify(hits)}`
      )
      ok(`stacking ${JSON.stringify(z)}; the header takes the pointer over the wrapper note, the box's body passes it on`)

      // The header's Copy group copies the expanded group's members (steps and note) with the group; Paste makes a new one.
      const head = await toScreen(500, 52)
      await page.mouse.click(head.x, head.y, { button: 'right' })
      await ctx.waitFor({ timeout: T })
      await page.click(tid('wf-ctx-copyGroup'))
      // Low on the canvas, so the copy's box opens below Phase's and the two headers stay apart.
      const cb = await page.locator(tid('wf-canvas')).boundingBox()
      const room = { x: cb.x + cb.width * 0.3, y: cb.y + cb.height * 0.72 }
      assert((await hit(room)) === 'pane', `the spot to paste at is ${await hit(room)}`)
      await page.mouse.click(room.x, room.y, { button: 'right' })
      await ctx.waitFor({ timeout: T })
      assert((await page.locator(tid('wf-ctx-paste')).getAttribute('aria-disabled')) === null, 'Copy group left Paste off')
      await page.click(tid('wf-ctx-paste'))
      await waitFor(
        async () =>
          (await groupCount()) === 2 &&
          (await page.locator(tid('wf-node')).count()) === 6 &&
          (await page.locator(tid('wf-note')).count()) === 3,
        T,
        'Paste to add a second group with two steps and a note'
      )
      await saveNow('the save of the pasted group')
      const bw2 = await listed(back.id)
      const ng = bw2.groups.find((g) => g.id !== 'g')
      const byId = Object.fromEntries(bw2.steps.map((s) => [s.id, s.name]))
      assert(
        bw2.groups.length === 2 &&
          ng &&
          ng.name === 'Phase' &&
          same(
            ng.steps.map((id) => byId[id]),
            ['Plan', 'Queue']
          ) &&
          !ng.steps.some((id) => ['p', 'q'].includes(id)),
        `the groups are ${JSON.stringify(bw2.groups)}`
      )
      assert(
        ng.notes.length === 1 && ng.notes[0] !== 'inner' && bw2.notes.find((n) => n.id === ng.notes[0])?.text === 'Inside',
        `the pasted group's notes are ${JSON.stringify(ng.notes)}`
      )
      assert(
        bw2.edges.some((e) => e.from === ng.steps[0] && e.to === ng.steps[1]),
        'the pasted group lost its edge'
      )
      ok(`Copy group on the expanded header and Paste made a second Phase (${ng.id}) of new Plan, Queue and note copies with their edge`)

      // With two groups, each header's menu acts on its own: Ungroup and Delete group on the copy, Edit description and
      // Collapse on Phase, the other group left as it was each time.
      const groupIds = async () => (await page.locator(tid('wf-group')).evaluateAll((els) => els.map((e) => e.dataset.groupId))).sort()
      const headOf = (id) => page.locator(`${tid('wf-group')}[data-group-id="${id}"] ${tid('wf-group-head')}`)
      const menuOn = async (id, action) => {
        const b = await headOf(id).boundingBox()
        const p = { x: b.x + b.width - 30, y: b.y + b.height / 2 }
        assert((await hit(p)) === `head:${id}`, `the right end of ${id}'s header is ${await hit(p)}`)
        await page.mouse.click(p.x, p.y, { button: 'right' })
        await ctx.waitFor({ timeout: T })
        await page.click(tid(`wf-ctx-${action}`))
      }
      const counts = async () => [await page.locator(tid('wf-node')).count(), await page.locator(tid('wf-note')).count()]
      await menuOn(ng.id, 'ungroup')
      await waitFor(
        async () => same(await groupIds(), ['g']) && same(await counts(), [6, 3]) && (await unsaved()),
        T,
        "the copy's Ungroup to take only the copy's group"
      )
      await page.keyboard.press('Control+Z')
      await waitFor(
        async () => same(await groupIds(), ['g', ng.id].sort()) && !(await unsaved()),
        T,
        "Ctrl+Z to bring the copy's group back"
      )
      await menuOn('g', 'editDescription')
      await waitFor(
        async () => (await focused()) === 'wf-group-desc-input' && (await headOf('g').locator(tid('wf-group-desc-input')).count()) === 1,
        T,
        "Phase's Edit description to open its own description"
      )
      await page.keyboard.type('Plans then queues')
      await page.keyboard.press('Enter')
      await waitFor(
        async () => (await headOf('g').locator(tid('wf-group-desc')).textContent()) === 'Plans then queues',
        T,
        'the description to land on Phase'
      )
      assert((await headOf(ng.id).locator(tid('wf-group-desc')).textContent()) === 'Add description', "the copy's description changed too")
      await menuOn('g', 'collapse')
      await waitFor(
        async () => (await folded('g').count()) === 1 && same(await groupIds(), [ng.id]),
        T,
        "Phase's Collapse to collapse only Phase"
      )
      assert(
        (await folded('g').locator(tid('wf-group-info')).getAttribute('data-tip')) === 'Plans then queues',
        'the collapsed Phase does not show its description as the info tooltip'
      )
      await menuOn(ng.id, 'deleteGroup')
      await waitFor(
        async () => (await groupCount()) === 0 && (await folded('g').count()) === 1 && same(await counts(), [2, 1]),
        T,
        "the copy's Delete group to take the copy and its members, and leave Phase"
      )
      await page.keyboard.press('Control+Z')
      await waitFor(
        async () => same(await groupIds(), [ng.id]) && same(await counts(), [4, 2]),
        T,
        'one Ctrl+Z to bring the copy, its steps and its note back'
      )
      await saveNow('the save of the description')
      const bw3 = await listed(back.id)
      assert(
        bw3.groups.length === 2 &&
          bw3.groups.find((g) => g.id === 'g')?.description === 'Plans then queues' &&
          bw3.groups.find((g) => g.id === ng.id)?.description === undefined,
        `the saved groups are ${JSON.stringify(bw3.groups)}`
      )
      ok(
        "each header's menu acted on its own group: Ungroup and Delete group (undone) on the copy, Edit description and Collapse on Phase, whose info tooltip shows it"
      )
    }
  )

  await runCase(
    19,
    'a For each step runs one fresh chat per line, shows its progress, keeps going past a failed item and retries only it',
    async () => {
      const w = await save(
        draft(
          'For each flow',
          [
            step('trig', 'trigger', 'Trigger', 0, 0),
            step('each', 'foreach', 'Each', 260, 0, { agent: AGENT, prompt: 'Check {{item}}', cwd: folder })
          ],
          [edge('trig', 'out', 'each')]
        )
      )
      await writeFile(holdFile, 'hold')
      await writeFile(failFile, 'fail')
      const { id: runId } = await rpc('workflows:run', w.id, 'alpha\n#HOLD beta\n#FAIL gamma')
      const itemsOf = (r) => visitsOf(r, 'each').at(-1)?.items ?? []
      await runUntil(runId, (r) => itemsOf(r)[1]?.status === 'running', 'beta to be running (held)')

      // While beta holds: the run header, the sidebar's run row and the canvas node all show 2 / 3 and the item.
      await page.goto(runUrl(w.id, runId))
      await page.locator(tid('workflow-run-view')).waitFor({ timeout: T })
      const text = async (loc) => ((await loc.first().textContent({ timeout: T })) ?? '').replace(/\s+/g, ' ').trim()
      await waitFor(
        async () =>
          (await page.locator(tid('wf-run-progress')).count()) === 1 &&
          (await text(page.locator(tid('wf-run-progress')))) === '2 / 3 · #HOLD beta',
        T,
        'the run header to read 2 / 3 · #HOLD beta'
      )
      await waitFor(
        async () =>
          (await text(page.locator(`${tid('workflow-run-row')}[data-run-id="${runId}"] ${tid('workflow-run-progress')}`))) ===
          '2 / 3 · #HOLD beta',
        T,
        "the sidebar's run row to read 2 / 3 · #HOLD beta"
      )
      await waitFor(
        async () => (await text(node(page, 'each').locator(tid('wf-node-progress')))) === '2 / 3 · #HOLD beta',
        T,
        'the node to read 2 / 3 · #HOLD beta'
      )

      // On a phone the running run is still the visit list: its For each row opens the item list with three items.
      const phoneCtx = () => h.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true })
      let ctx = await phoneCtx()
      try {
        const phone = await ctx.newPage()
        await phone.goto(runUrl(w.id, runId))
        await phone.locator(tid('wf-timeline')).waitFor({ timeout: 30_000 })
        assert((await phone.locator(tid('wf-audit')).count()) === 0, 'the running run shows the audit log on the phone')
        const toggle = phone.locator(tid('wf-timeline-progress'))
        await toggle.last().waitFor({ timeout: T })
        await toggle.last().click()
        await waitFor(async () => (await phone.locator(tid('wf-item')).count()) === 3, T, 'three items in the phone list')
      } finally {
        await ctx.close()
      }

      // Beta is released, gamma fails, the run ends failed with 2 done and 1 failed.
      await rm(holdFile)
      const failed = await runUntil(runId, ended, 'the For each run to end', 60_000)
      assert(failed.status === 'failed', `the For each run ended ${failed.status}`)
      const first = itemsOf(failed)
      assert(
        first.map((i) => `${i.n}:${i.status}`).join(',') === '1:done,2:done,3:failed',
        `the items ended ${first.map((i) => `${i.n}:${i.status}`)}`
      )
      assert(
        first.every((i) => i.chatId) && new Set(first.map((i) => i.chatId)).size === 3,
        'the items did not each get a chat of their own'
      )
      await node(page, 'each').click({ timeout: T })
      const countLoc = page.locator(tid('wf-items-count'))
      await waitFor(
        async () => (await countLoc.count()) > 0 && (await text(countLoc)) === '2 done · 1 failed',
        T,
        'the count to read 2 done · 1 failed'
      )
      const itemRow = (n) => page.locator(`${tid('wf-item')}[data-item-n="${n}"]`)
      assert((await itemRow(3).getAttribute('data-status')) === 'failed', 'gamma is not shown failed')
      const metas = await storedChats()
      const archived = (id) => {
        const m = metas.find((c) => c.id === id)
        return Boolean(m) && (m.archivedAt ?? 0) > (m.unarchivedAt ?? 0)
      }
      assert(
        archived(first[0].chatId) && archived(first[1].chatId) && !archived(first[2].chatId),
        `archived: ${first.map((i) => archived(i.chatId))}`
      )
      const link = metas.find((c) => c.id === first[2].chatId)?.workflow
      assert(link?.item?.n === 3 && link.item.total === 3, `gamma's chat link is ${JSON.stringify(link)}`)
      silent.chats.push(...first.map((i) => i.chatId))

      // A phone has no canvas inspector, so the failed run's audit log offers Retry: on the visit and on the failed item.
      // Gamma's Retry from there, with the fail marker still on, runs only gamma again (alpha and beta carried) and fails.
      const eachOf = (r) => visitsOf(r, 'each')
      ctx = await phoneCtx()
      try {
        const phone = await ctx.newPage()
        await phone.goto(runUrl(w.id, runId))
        await phone.locator(`${tid('wf-audit')}[data-state="ready"]`).waitFor({ timeout: 30_000 })
        const entry = phone.locator(`${tid('wf-audit-entry')}[data-step-id="each"]`)
        assert(
          (await entry.count()) === 1 && (await entry.locator(tid('wf-retry')).count()) === 1,
          'the failed For each entry offers no Retry on the phone'
        )
        const itemRetry = entry.locator(`${tid('wf-audit-item')}[data-item-n="3"] ${tid('wf-item-retry')}`)
        assert(
          (await entry.locator(tid('wf-item-retry')).count()) === 1 && (await itemRetry.count()) === 1,
          'Retry is not offered on exactly the failed item'
        )
        await itemRetry.click()
        const again = await runUntil(runId, (r) => ended(r) && eachOf(r).length === 2, 'the phone-retried run to end', 60_000)
        assert(
          again.status === 'failed' &&
            eachOf(again)[1]
              .items.map((i) => `${i.n}:${i.status}:${i.carried ? 'c' : ''}`)
              .join(',') === '1:done:c,2:done:c,3:failed:',
          `after the phone Retry the run is ${again.status}, items ${JSON.stringify(eachOf(again)[1].items)}`
        )
        // The log comes back by itself once the retried run ends again, the new visit last with its two carried items.
        await waitFor(
          async () => (await entry.count()) === 2 && (await entry.last().locator(tid('wf-audit-carried')).count()) === 2,
          T,
          'two For each entries in the phone log, the last with two carried items'
        )
      } finally {
        await ctx.close()
      }

      // Retry only gamma on the wide screen, with the fail marker off: same chat, run done, all three replies in the output.
      await rm(failFile)
      // Only the latest visit's failed item offers Retry, so this is one button though both visits list their items.
      const deskRetry = page.locator(`${tid('wf-item')}[data-item-n="3"] ${tid('wf-item-retry')}`)
      await waitFor(async () => (await deskRetry.count()) === 1, T, 'one item Retry on the wide screen after the phone Retry')
      await deskRetry.click({ timeout: T })
      const done = await runUntil(
        runId,
        (r) => ended(r) && r.visits.some((v) => v.stepId === 'each' && v.items?.[2]?.status === 'done'),
        'the retried run to end',
        60_000
      )
      assert(done.status === 'done', `after Retry the run is ${done.status}: ${done.error}`)
      const last = visitsOf(done, 'each').at(-1)
      assert(last.items[2].chatId === first[2].chatId, 'gamma ran in another chat after Retry')
      for (const head of ['## alpha', '## #HOLD beta', '## #FAIL gamma'])
        assert((last.output ?? '').includes(head), `the output lacks ${head}: ${JSON.stringify(last.output)}`)
      ok(
        'beta held at 2 / 3 on header, sidebar, node and the phone list; gamma failed with the run, alpha and beta chats archived; Retry from the phone log reran only gamma (failed again), Retry on the wide screen reran it in its chat and the output holds all three'
      )

      // Phone width: the finished run is its audit log, one entry per For each visit (the first run and its two Retries),
      // the last with three rows, alpha and beta carried, and no Retry left to offer.
      ctx = await phoneCtx()
      try {
        const phone = await ctx.newPage()
        await phone.goto(runUrl(w.id, runId))
        await phone.locator(`${tid('wf-audit')}[data-state="ready"]`).waitFor({ timeout: 30_000 })
        assert((await phone.locator(tid('wf-timeline')).count()) === 0, 'the finished run shows the visit list on the phone')
        const eachEntries = phone.locator(`${tid('wf-audit-entry')}[data-step-id="each"]`)
        const rows = eachEntries.last().locator(tid('wf-audit-item'))
        assert(
          eachOf(done).length === 3 && last.items.length === 3,
          `the run has ${eachOf(done).length} For each visits, the last ${last.items.length} items`
        )
        await waitFor(
          async () => (await eachEntries.count()) === 3 && (await rows.count()) === 3,
          T,
          `three For each entries and three item rows in the phone audit log (${await eachEntries.count()} entries, ${await rows.count()} rows)`
        )
        assert(
          (await eachEntries.last().locator(tid('wf-audit-carried')).count()) === 2,
          'the last For each entry does not mark alpha and beta as carried'
        )
        assert(
          (await phone.locator(`${tid('wf-retry')}, ${tid('wf-item-retry')}`).count()) === 0,
          'the done run still offers Retry on the phone'
        )
      } finally {
        await ctx.close()
      }
      ok('the phone shows the finished For each run as its audit log: three For each entries, the last with its three items, two carried')
    }
  )

  await runCase(
    20,
    'HTTP request with a vault key, Transform, Sub-workflow and a failure path: the run ends done, the key is sent but never stored, both runs link',
    async () => {
      // A local API: /items answers JSON and records what it was sent; /broken fails with a body.
      const seen = []
      const api = createServer((req, res) => {
        seen.push({ url: req.url, auth: req.headers.authorization ?? null })
        if (req.url?.startsWith('/items')) {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ items: [{ title: 'Alpha' }, { title: 'Beta' }] }))
        } else {
          res.statusCode = 500
          res.end('kaput')
        }
      })
      await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
      const apiOrigin = `http://127.0.0.1:${api.address().port}`
      const SECRET = 'fixture-secret-7731'
      try {
        const key = await rpc('vault:save', {
          name: 'Fixture key',
          agents: [],
          kind: 'apiKey',
          env: 'FIXTURE_KEY',
          value: SECRET,
          description: 'e2e',
          workflows: true
        })
        assert(key.kind === 'apiKey' && key.workflows === true, `the saved key reads ${JSON.stringify(key)}`)
        const child = await save(
          draft(
            'Child flow',
            [
              step('trig', 'trigger', 'Trigger', 0, 0),
              step('shout', 'llm', 'Shout', 260, 0, { prompt: 'Shout {{input}}', model: 'haiku' })
            ],
            [edge('trig', 'out', 'shout')],
            { enabled: false }
          )
        )
        const w = await save(
          draft(
            'API flow',
            [
              step('trig', 'trigger', 'Trigger', 0, 120),
              step('fetch', 'http', 'Fetch items', 260, 0, {
                method: 'GET',
                url: `${apiOrigin}/items?t={{key}}`,
                headers: [{ name: 'Authorization', value: 'Bearer {{key}}' }],
                bodyType: 'json',
                key: key.id
              }),
              step('pick', 'transform', 'Titles', 540, 0, { fields: [{ name: 'titles', path: 'items[].title' }], format: 'lines' }),
              step('sub', 'workflow', 'Run child', 820, 0, { workflow: child.id, input: '{{input}}' }),
              step('bad', 'http', 'Broken', 260, 240, {
                method: 'GET',
                url: `${apiOrigin}/broken`,
                headers: [],
                bodyType: 'json',
                onFailure: 'branch'
              }),
              step('explain', 'llm', 'Explain', 540, 240, { prompt: 'Explain {{input}}', model: 'haiku' })
            ],
            [
              edge('trig', 'out', 'fetch'),
              edge('fetch', 'out', 'pick'),
              edge('pick', 'out', 'sub'),
              edge('trig', 'out', 'bad'),
              edge('bad', 'error', 'explain')
            ]
          )
        )
        const { id: runId } = await rpc('workflows:run', w.id, '')
        const r = await runUntil(runId, ended, 'the API flow to end')
        assert(r.status === 'done', `the run ended ${r.status}: ${r.error ?? ''}`)
        const one = (id) => visitsOf(r, id)[0]
        assert(
          seen.some((x) => x.url === `/items?t=${SECRET}` && x.auth === `Bearer ${SECRET}`),
          `the API saw ${JSON.stringify(seen)}`
        )
        assert(
          one('fetch').http?.url === `${apiOrigin}/items?t=[vault: Fixture key]` && one('fetch').http?.status === 200,
          `the fetch visit kept ${JSON.stringify(one('fetch').http)}`
        )
        assert(one('pick').output === 'Alpha\nBeta', `the transform made ${JSON.stringify(one('pick').output)}`)
        assert(
          one('bad').status === 'failed' && one('bad').port === 'error' && one('bad').error === 'HTTP 500',
          `the broken visit is ${JSON.stringify(one('bad'))}`
        )
        assert(one('explain').input === 'HTTP 500\n\nkaput', `the failure path carried ${JSON.stringify(one('explain').input)}`)
        const childRun = await getRun(one('sub').childRunId)
        assert(
          childRun.via === 'workflow' && childRun.input === 'Alpha\nBeta' && childRun.parent?.runId === runId,
          `the child run is ${JSON.stringify({ via: childRun.via, input: childRun.input, parent: childRun.parent })}`
        )
        assert(
          one('sub').status === 'done' && one('sub').output === visitsOf(childRun, 'shout')[0]?.output,
          `the sub-workflow handed on ${JSON.stringify(one('sub').output)}`
        )
        for (const f of ['workflow-runs.json', 'workflows.json']) {
          assert(!(await readFile(join(h.dataDir, f), 'utf8')).includes(SECRET), `${f} holds the vault key`)
        }
        assert(!h.output.join('').includes(SECRET) && !h.errors.join('').includes(SECRET), 'the server log holds the vault key')
        assert(!pushes().some((p) => p.run?.runId === runId || p.run?.runId === childRun.id), 'a run that ended done pushed')
        ok(
          'the request carried the key, the run kept only its tag, Transform listed the titles, the child ran on them and the failure path got the 500 and its body'
        )

        // The run view: the request line, the handled failure, and links both ways between the runs.
        await page.goto(runUrl(w.id, runId))
        await page.locator(tid('workflow-run-view')).waitFor({ timeout: T })
        await node(page, 'fetch').click()
        await waitFor(
          async () =>
            (
              (await page
                .locator(tid('wf-visit-request'))
                .textContent()
                .catch(() => '')) ?? ''
            ).includes('[vault: Fixture key]'),
          T,
          'the request line with the key tag'
        )
        await node(page, 'bad').click()
        await page.locator(tid('wf-visit-handled')).waitFor({ timeout: T })
        assert((await page.locator(tid('wf-retry')).count()) === 0, 'a handled failure offers Retry')
        await node(page, 'sub').click()
        await page.locator(tid('wf-open-run')).click({ timeout: T })
        await page.waitForURL(runUrl(child.id, childRun.id), { timeout: T })
        await page.locator(tid('wf-run-parent')).click({ timeout: T })
        await page.waitForURL(runUrl(w.id, runId), { timeout: T })
        await page.click(tid('wf-tab-audit'))
        await page.locator(tid('wf-audit-request')).first().waitFor({ timeout: T })
        await page.locator(tid('wf-audit-handled')).waitFor({ timeout: T })
        await page.locator(tid('wf-audit-open-run')).waitFor({ timeout: T })
        ok(
          'the run view shows the request with its key tag, the handled failure without Retry, and Open run and Started by link the two runs; the audit log has them too'
        )

        // The editor: the failure path's port and the inspector's fields.
        await page.goto(`${h.origin}/workflows/${w.id}`)
        await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
        await node(page, 'bad').locator(tid('wf-port-error')).waitFor({ timeout: T })
        assert((await node(page, 'fetch').locator(tid('wf-port-error')).count()) === 0, 'a step without the failure path shows its port')
        await node(page, 'fetch').click()
        await page.locator(tid('wf-http-method')).waitFor({ timeout: T })
        await waitFor(
          async () => (await page.locator(`${tid('wf-http-key')} .search-select-text`).textContent()) === 'Fixture key',
          T,
          'the key picker to name the key'
        )
        assert((await selectValue(page.locator(tid('wf-on-failure')))) === 'stop', 'the fetch step reads as going on along a failure path')
        assert((await page.locator(tid('wf-unsaved')).count()) === 0, 'opening the workflow made it unsaved')
        ok(
          'the editor draws the red Failed port only where the path is on, and the inspector shows the method, the picked key by name and On failure'
        )
      } finally {
        await new Promise((resolve) => api.close(resolve))
      }
    }
  )

  await runCase(
    21,
    'For each Run at once 2 runs two held items side by side; History lists each save and Restore brings back the one-at-a-time version',
    async () => {
      const w = await save(
        draft(
          'Side by side',
          [
            step('trig', 'trigger', 'Trigger', 0, 0),
            step('each', 'foreach', 'Each', 260, 0, { agent: AGENT, prompt: 'Check {{item}}', cwd: folder })
          ],
          [edge('trig', 'out', 'each')]
        )
      )
      const text = async (loc) => ((await loc.first().textContent({ timeout: T })) ?? '').replace(/\s+/g, ' ').trim()

      // The inspector's Run at once: 2, saved from the page.
      await page.goto(`${h.origin}/workflows/${w.id}`)
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      await node(page, 'each').click({ timeout: T })
      const conc = page.locator(tid('wf-foreach-concurrency'))
      assert((await selectValue(conc)) === '1', 'a new For each step does not run one at a time')
      await pickOption(conc, '2')
      await page.locator(tid('wf-foreach-concurrency-hint')).waitFor({ timeout: T })
      await page.locator(tid('wf-unsaved')).waitFor({ timeout: T })
      await page.click(tid('wf-save'))
      await waitFor(async () => (await page.locator(tid('wf-unsaved')).count()) === 0, T, 'the save')
      const stored = (await rpc('workflows:list')).workflows.find((x) => x.id === w.id)
      assert(
        stored.steps.find((x) => x.id === 'each')?.concurrency === 2,
        `the step saved ${JSON.stringify(stored.steps.find((x) => x.id === 'each'))}`
      )

      // Two held items run at once and the third waits for a free slot.
      await writeFile(holdFile, 'hold')
      const { id: runId } = await rpc('workflows:run', w.id, '#HOLD alpha\n#HOLD beta\ngamma')
      const itemsOf = (r) => visitsOf(r, 'each').at(-1)?.items ?? []
      const both = await runUntil(
        runId,
        (r) => itemsOf(r)[0]?.status === 'running' && itemsOf(r)[1]?.status === 'running' && itemsOf(r)[0]?.chatId && itemsOf(r)[1]?.chatId,
        'alpha and beta to run together'
      )
      assert(itemsOf(both)[2].status === 'pending', `gamma is ${itemsOf(both)[2].status} while both slots are taken`)
      assert(itemsOf(both)[0].chatId !== itemsOf(both)[1].chatId, 'the two items share a chat')
      await page.goto(runUrl(w.id, runId))
      await page.locator(tid('workflow-run-view')).waitFor({ timeout: T })
      await waitFor(
        async () =>
          (await page.locator(tid('wf-run-progress')).count()) === 1 &&
          (await text(page.locator(tid('wf-run-progress')))) === '2 / 3 · 2 running',
        T,
        'the run header to read 2 / 3 · 2 running'
      )
      await rm(holdFile)
      const done = await runUntil(runId, ended, 'the side by side run to end', 60_000)
      assert(done.status === 'done', `the side by side run ended ${done.status}: ${done.error}`)
      const out = visitsOf(done, 'each').at(-1).output ?? ''
      assert(
        out.indexOf('## #HOLD alpha') < out.indexOf('## #HOLD beta') && out.indexOf('## #HOLD beta') < out.indexOf('## gamma'),
        `the output is not in list order: ${JSON.stringify(out)}`
      )
      ok(
        'Run at once 2 saved from the inspector; alpha and beta held at once in two chats while gamma waited, the header read 2 / 3 · 2 running, and the output kept list order'
      )

      // History: the RPC save and the page's save, newest first; Restore puts the first back as an unsaved edit.
      await page.goto(`${h.origin}/workflows/${w.id}`)
      await page.locator(tid('workflow-editor')).waitFor({ timeout: T })
      await page.click(tid('wf-more'))
      await page.click(tid('wf-history'))
      const rows = page.locator(tid('history-row'))
      await waitFor(async () => (await rows.count()) === 2, T, 'two versions in History')
      assert((await rows.first().getAttribute('data-current')) === 'true', 'the newest version is not marked current')
      assert(
        (await text(rows.first().locator(tid('history-changes')))) === 'Step “Each” changed',
        `the newest version's changes read ${await text(rows.first().locator(tid('history-changes')))}`
      )
      assert((await rows.first().locator(tid('history-restore')).count()) === 0, 'the current version offers Restore')
      await rows.last().locator(tid('history-restore')).click()
      await page.locator(tid('history-dialog')).waitFor({ state: 'detached', timeout: T })
      await page.locator(tid('wf-unsaved')).waitFor({ timeout: T })
      await waitFor(async () => /^Restored the version from /.test(await text(page.locator(tid('wf-notice')))), T, 'the restore notice')
      await node(page, 'each').click({ timeout: T })
      assert((await selectValue(page.locator(tid('wf-foreach-concurrency')))) === '1', 'the restored step does not run one at a time')
      assert(
        (await rpc('workflows:list')).workflows.find((x) => x.id === w.id).steps.find((x) => x.id === 'each').concurrency === 2,
        'Restore wrote before Save'
      )
      await page.click(tid('wf-save'))
      await waitFor(async () => (await page.locator(tid('wf-unsaved')).count()) === 0, T, 'the save of the restored version')
      assert(
        !('concurrency' in (await rpc('workflows:list')).workflows.find((x) => x.id === w.id).steps.find((x) => x.id === 'each')),
        'the restored save kept Run at once 2'
      )
      const list = await rpc('workflows:history', w.id)
      assert(
        list.length === 3 && list[0].source === 'restore' && list[0].current && list[0].restoredFrom === list[2].savedAt,
        `History after the restore is ${JSON.stringify(list.map((v) => [v.source, v.current, v.restoredFrom]))}`
      )
      await page.click(tid('wf-more'))
      await page.click(tid('wf-history'))
      await waitFor(async () => (await rows.count()) === 3, T, 'three versions in History')
      assert(/^Restored from /.test(await text(rows.first().locator('.history-who'))), 'the newest version does not say it was restored')
      await page.click(tid('history-close'))
      ok(
        'History listed both saves with the newest current; Restore loaded the first as an unsaved edit, and its Save kept a "Restored from" version that is current'
      )
    }
  )

  // ---------- routine parity (cases 22-26): the Chat step, Keep, Room from agents, step commands and the usage-limit skip ----------
  const metaOf = async (id) => (await storedChats()).find((c) => c.id === id)
  const isArchived = (m) => Boolean(m) && (m.archivedAt ?? 0) > (m.unarchivedAt ?? 0)
  const itemsOf = (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])
  const agentRuns = async () =>
    (await readFile(invocations, 'utf8').catch(() => ''))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l).args)
  const resumed = (args) => args.includes('--resume')

  await runCase(
    22,
    'a Chat step posts into an existing chat: Continue resumes its session, Start fresh does not, and the chat shows the workflow sender',
    async () => {
      const chatId = (await rpc('chats:create', AGENT, folder)).id
      await rpc('chats:send', chatId, 'plain hello')
      const sent = await readFile(invocations, 'utf8').then((t) => t.split('\n').filter(Boolean).length)
      const chatStep = (extra) => step('post', 'chat', 'Post', 260, 0, { chat: chatId, prompt: 'Digest {{input}}', ...extra })
      const keep = await save(
        draft('Into my chat', [step('trig', 'trigger', 'Trigger', 0, 0), chatStep({})], [edge('trig', 'out', 'post')])
      )
      const fresh = await save(
        draft(
          'Into my chat fresh',
          [step('trig', 'trigger', 'Trigger', 0, 0), chatStep({ session: 'fresh' })],
          [edge('trig', 'out', 'post')]
        )
      )
      const go = async (w, input) => {
        const { id } = await rpc('workflows:run', w.id, input)
        const r = await runUntil(id, ended, `the ${w.name} run to end`)
        assert(r.status === 'done', `${w.name} ended ${r.status}: ${r.error}`)
        return visitsOf(r, 'post')[0]
      }
      const v1 = await go(keep, 'one')
      assert(
        v1.chatId === chatId && (v1.output ?? '') !== '',
        `the Continue visit ran in ${v1.chatId}, output ${JSON.stringify(v1.output)}`
      )
      const v2 = await go(fresh, 'two')
      const v3 = await go(fresh, 'three')
      assert(v2.chatId === chatId && v3.chatId === chatId, 'a Start fresh visit ran in another chat')
      const runs = (await agentRuns()).slice(sent)
      assert(runs.length === 3, `the chat was run ${runs.length} times after the first message`)
      assert(resumed(runs[0]), "Continue did not resume the chat's session")
      assert(!resumed(runs[1]) && !resumed(runs[2]), `Start fresh resumed the session: ${JSON.stringify(runs.slice(1))}`)
      // The user's chat is left as it was: no workflow link on it, the sender kept on each message the workflow sent.
      const meta = await metaOf(chatId)
      assert(
        !meta.workflow && !meta.workflowTest && !isArchived(meta),
        `the chat was marked: ${JSON.stringify({ workflow: meta.workflow, archivedAt: meta.archivedAt })}`
      )
      const sentItems = (await itemsOf(chatId)).filter((i) => i.type === 'user' && i.workflowSent)
      assert(
        sentItems.length === 3 && sentItems.every((i) => i.workflowSent.stepId === 'post'),
        `the chat holds ${sentItems.length} workflow messages`
      )
      await page.goto(`${h.origin}/chat/${chatId}`)
      await waitFor(async () => (await page.locator(tid('wf-from')).count()) === 3, T, 'three workflow sender lines in the chat')
      const from = (await page.locator(tid('wf-from')).allTextContents()).join(' | ')
      assert(from.includes('Into my chat') && from.includes('Post'), `the sender lines read ${JSON.stringify(from)}`)
      assert((await page.locator(tid('wf-chat-bar')).count()) === 0, 'the chat shows a workflow bar')
      ok(
        'Continue resumed the chat; both Start fresh runs started a new session (no --resume); the chat has no workflow link and three "from workflow" lines'
      )
    }
  )

  await runCase(23, 'a kept Agent step leaves its chat in the sidebar under its title; a plain one is archived', async () => {
    const w = await save(
      draft(
        'Keep one',
        [
          step('trig', 'trigger', 'Trigger', 0, 0),
          step('kept', 'agent', 'Kept', 260, 0, { agent: AGENT, prompt: 'Say hello', cwd: folder, keep: true, title: 'Kept digest' }),
          step('plain', 'agent', 'Plain', 260, 120, { agent: AGENT, prompt: 'Say hello', cwd: folder })
        ],
        [edge('trig', 'out', 'kept'), edge('trig', 'out', 'plain')]
      )
    )
    const { id: runId } = await rpc('workflows:run', w.id, '')
    const r = await runUntil(runId, ended, 'the run to end')
    assert(r.status === 'done', `the run ended ${r.status}: ${r.error}`)
    const kept = visitsOf(r, 'kept')[0].chatId
    const plain = visitsOf(r, 'plain')[0].chatId
    // The plain step's archive is the positive control: once it landed, the kept chat's would have too.
    await waitFor(async () => isArchived(await metaOf(plain)), T, 'the plain step chat to be archived')
    const meta = await metaOf(kept)
    assert(!isArchived(meta), 'the kept chat was archived')
    assert(
      meta.title === 'Kept digest' && meta.workflow?.keep === true && meta.workflow.stepId === 'kept',
      `the kept chat is ${JSON.stringify({ title: meta.title, workflow: meta.workflow })}`
    )
    await page.goto(h.origin)
    const toggle = page
      .locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`)
      .locator('xpath=..')
      .locator(tid('agent-toggle'))
    await toggle.waitFor({ timeout: T })
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    const row = page.locator(`${tid('chat-row')}[data-chat-id="${kept}"]`)
    await row.waitFor({ timeout: T })
    assert(((await row.textContent()) ?? '').includes('Kept digest'), `the sidebar row reads ${JSON.stringify(await row.textContent())}`)
    assert((await page.locator(`${tid('chat-row')}[data-chat-id="${plain}"]`).count()) === 0, 'the archived step chat is in the sidebar')
    ok(
      'the kept chat is unarchived, titled "Kept digest", linked as kept and listed in the sidebar; the plain step chat was archived and is not'
    )
  })

  await runCase(24, 'a Room step from two agents makes its room: both answer and the run ends done', async () => {
    const w = await save(
      draft(
        'Room from agents',
        [
          step('trig', 'trigger', 'Trigger', 0, 0),
          step('room', 'room', 'Room', 260, 0, {
            room: '',
            members: [AGENT, AGENT2],
            role: 'Make cards',
            cwd: folder,
            prompt: `@${AGENT} @${AGENT2} {{input}}`
          })
        ],
        [edge('trig', 'out', 'room')]
      )
    )
    const { id: runId } = await rpc('workflows:run', w.id, 'card one')
    const r = await runUntil(runId, ended, 'the room run to end')
    assert(r.status === 'done', `the run ended ${r.status}: ${r.error}`)
    const v = visitsOf(r, 'room')[0]
    assert(v.status === 'done' && v.chatId, `the room visit is ${JSON.stringify(v)}`)
    const meta = await metaOf(v.chatId)
    assert(
      meta.group && JSON.stringify([...meta.group.members].sort()) === JSON.stringify([AGENT, AGENT2].sort()),
      `the room's members are ${JSON.stringify(meta.group?.members)}`
    )
    assert(
      meta.group.role === 'Make cards' && meta.workflow?.runId === runId && meta.workflow.stepId === 'room',
      `the room is ${JSON.stringify({ role: meta.group?.role, workflow: meta.workflow })}`
    )
    const items = await itemsOf(v.chatId)
    const speakers = new Set(items.filter((i) => i.type === 'assistant' && i.text).map((i) => i.agent))
    assert(speakers.has(AGENT) && speakers.has(AGENT2), `the room's speakers are ${JSON.stringify([...speakers])}`)
    assert(
      v.output && items.some((i) => i.type === 'assistant' && i.text === v.output),
      `the output ${JSON.stringify(v.output)} is not a reply of the room`
    )
    await waitFor(async () => isArchived(await metaOf(v.chatId)), T, 'the room to be archived')
    ok(
      "the run made a two-member room with the step's role, both agents answered, the output is a reply of the room and the room was archived"
    )
  })

  await runCase(25, "a /command step sends the command's filled prompt; a filled value never becomes one", async () => {
    const w = await save(
      draft(
        'Digest step',
        [
          step('trig', 'trigger', 'Trigger', 0, 0),
          step('ask', 'agent', 'Ask', 260, 0, {
            agent: AGENT2,
            prompt: '/digest {{input}}',
            cwd: folder,
            command: { agent: AGENT2, name: 'digest' }
          })
        ],
        [edge('trig', 'out', 'ask')]
      )
    )
    const { id: runId } = await rpc('workflows:run', w.id, 'weekly numbers')
    const r = await runUntil(runId, ended, 'the command run to end')
    assert(r.status === 'done', `the run ended ${r.status}: ${r.error}`)
    const chatId = visitsOf(r, 'ask')[0].chatId
    const user = (await itemsOf(chatId)).find((i) => i.type === 'user')
    assert(user?.command?.agent === AGENT2 && user.command.name === 'digest', `the message's command is ${JSON.stringify(user?.command)}`)
    assert(
      user.command.prompt.startsWith('Make a digest of: ') && user.command.prompt.includes('weekly numbers'),
      `the command's prompt is ${JSON.stringify(user.command.prompt)}`
    )
    // The fake keeps the stdin of the run that ended last, written as it exits.
    await waitFor(
      async () => (await readFile(stdinOut, 'utf8').catch(() => '')).includes('Make a digest of: '),
      T,
      "the fake's stdin to hold the filled prompt"
    )
    const stdin = await readFile(stdinOut, 'utf8')
    assert(stdin.includes('weekly numbers') && !stdin.includes('$ARGUMENTS'), `the agent read ${JSON.stringify(stdin.slice(0, 400))}`)

    // The same text arriving as the run's input is a plain message: only the saved prompt can name a command.
    const plain = await save(
      draft(
        'Digest by input',
        [
          step('trig', 'trigger', 'Trigger', 0, 0),
          step('ask', 'agent', 'Ask', 260, 0, { agent: AGENT2, prompt: '{{input}}', cwd: folder })
        ],
        [edge('trig', 'out', 'ask')]
      )
    )
    const { id: plainRun } = await rpc('workflows:run', plain.id, '/digest sneaky')
    const p = await runUntil(plainRun, ended, 'the plain run to end')
    assert(p.status === 'done', `the plain run ended ${p.status}: ${p.error}`)
    const sneaky = (await itemsOf(visitsOf(p, 'ask')[0].chatId)).find((i) => i.type === 'user')
    assert(sneaky && !sneaky.command, `a value from the input became a command: ${JSON.stringify(sneaky?.command)}`)
    ok(
      'the saved /digest prompt ran as the command (its filled prompt reached the agent, no $ARGUMENTS left); "/digest" arriving as input stayed text'
    )
  })

  await runCase(26, 'At the usage limit: Skip ends the run skipped with its text, no failure push', async () => {
    const original = await readFile(h.script, 'utf8')
    const lines = original.split('\n').filter(Boolean)
    const result = JSON.parse(lines.at(-1))
    // As the CLI answers a 429 (e2e:routines): a rejected rate_limit_event, a synthetic reply, an error result.
    const limited =
      [
        lines[0],
        JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' },
          uuid: 'e2e-wf-limit',
          session_id: result.session_id
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'e2e-wf-limit-msg',
            model: '<synthetic>',
            role: 'assistant',
            content: [{ type: 'text', text: "You've hit your session limit" }]
          },
          error: 'rate_limit',
          session_id: result.session_id
        }),
        JSON.stringify({ ...result, is_error: true, result: "You've hit your session limit" })
      ].join('\n') + '\n'
    await writeFile(h.script, limited)
    try {
      const w = await save(
        draft(
          'Skip at the limit',
          [
            step('trig', 'trigger', 'Trigger', 0, 0),
            step('ask', 'agent', 'Ask', 260, 0, { agent: AGENT, prompt: 'Say hello', cwd: folder }),
            step('after', 'notify', 'After', 540, 0, { title: 'Never sent', body: '{{input}}' })
          ],
          [edge('trig', 'out', 'ask'), edge('ask', 'out', 'after')],
          { limitPolicy: 'skip' }
        )
      )
      assert(w.limitPolicy === 'skip', `the workflow saved limitPolicy ${w.limitPolicy}`)
      const { id: runId } = await rpc('workflows:run', w.id, '')
      const r = await runUntil(runId, ended, 'the run to be skipped')
      assert(r.status === 'skipped' && r.error === LIMIT_SKIP_TEXT, `the run is ${r.status}: ${JSON.stringify(r.error)}`)
      assert(visitsOf(r, 'after').length === 0, 'a step after the limit ran')
      assert(
        visitsOf(r, 'ask').every((v) => v.status !== 'running' && v.status !== 'waiting'),
        `a visit is still open: ${JSON.stringify(visitsOf(r, 'ask').map((v) => v.status))}`
      )
      await page.goto(runUrl(w.id, runId))
      await page.locator(`${tid('wf-run-status')}[data-status="skipped"]`).waitFor({ timeout: T })
      await waitFor(
        async () => ((await page.locator(tid('workflow-run-view')).textContent()) ?? '').includes(LIMIT_SKIP_TEXT),
        T,
        'the run view to read the skip text'
      )
      await sleep(500)
      assert(
        !pushes().some((p) => p.run?.runId === runId),
        `the skipped run pushed: ${JSON.stringify(pushes().filter((p) => p.run?.runId === runId))}`
      )
      ok(
        'the limit stopped the Agent step, the run ended skipped with "Skipped at the usage limit" (view and stored), the next step never ran and nothing was pushed'
      )
    } finally {
      await writeFile(h.script, original)
    }
  })

  const loud = pushes().filter((p) => silent.runs.includes(p.run?.runId) || silent.chats.includes(p.chatId))
  assert(loud.length === 0, `a stopped run or a step chat's reply pushed: ${JSON.stringify(loud)}`)
  ok('no push for the stopped run or the Agent step chat, even late')

  const bad = unexpectedErrors(h.errors, [
    // The restart in case 8 may refuse a tab's reconnect until the new server listens (as in e2e:pause).
    /WebSocket connection to '[^']*\/ws' failed: .*net::ERR_CONNECTION_REFUSED/
  ])
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
console.log(failed ? 'e2e:workflows FAILED' : 'e2e:workflows passed')
process.exit(failed ? 1 : 0)
