// End-to-end check of Settings › Audit log, in the built server + web UI (local mode), against the FAKE claude: no real CLI
// turn is sent, so no login or quota is used. Usage: npm run e2e:audit   (builds the server first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dir created here (plus the harness's own temp root) is deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), new-chat, new-chat-folder, new-chat-choose-folder,
//   composer-input, send-button, agent-message, tool-row (+ data-tool-id), audit-page, audit-row (+ data-tool,
//   data-decision), audit-decision, audit-search, audit-clear, audit-record, audit-why, audit-show-in-chat, audit-export,
//   audit-verify, audit-verify-result, audit-status.

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors, pickOption } from './harness.mjs'

const AGENT = 'e2e-audit-agent'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 20_000
const BASIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'tests', 'fixtures', 'stream', 'basic.jsonl')

let h = null
let work = null
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`

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

// The basic reply with three tool calls before its text: two the mode allows, one a CLI deny rule refuses.
async function writeScript(path) {
  const lines = (await readFile(BASIC, 'utf8')).split('\n').filter(Boolean)
  const session = JSON.parse(lines[0]).session_id
  const use = (id, name, input) =>
    JSON.stringify({
      type: 'assistant',
      session_id: session,
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }
    })
  const res = (id, content, isError = false) =>
    JSON.stringify({
      type: 'user',
      session_id: session,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }
    })
  const tools = [
    use('toolu_ls', 'Bash', { command: 'ls -la audit-e2e-marker' }),
    res('toolu_ls', 'total 0'),
    use('toolu_grep', 'Grep', { pattern: 'needle' }),
    res('toolu_grep', 'no matches'),
    use('toolu_read', 'Read', { file_path: '/etc/shadow' }),
    res('toolu_read', 'Permission to use Read has been denied.', true)
  ]
  const out = []
  for (const line of lines) {
    const m = JSON.parse(line)
    if (m.type === 'assistant') out.push(...tools)
    if (m.type === 'result') out.push(JSON.stringify({ ...m, permission_denials: [{ tool_use_id: 'toolu_read', tool_name: 'Read' }] }))
    else out.push(line)
  }
  await writeFile(path, out.join('\n') + '\n')
}

async function main() {
  work = await mkdtemp(join(tmpdir(), 'zumibot-e2e-audit-'))
  h = await start({ mode: 'local', fake: true, env: { ZUMIBOT_TEST_PICK_FOLDER: work } })
  await writeFile(
    join(h.agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Audit e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  await writeScript(h.script)
  const page = h.page

  // 1. a chat whose reply makes three tool calls
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  await page.locator(tid('composer-input')).fill('look around')
  await page.locator(tid('send-button')).click()
  await page.locator(tid('agent-message')).last().waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => /\/chat\/[A-Za-z0-9-]+$/.test(location.pathname), null, { timeout: T })
  const chatId = new URL(page.url()).pathname.split('/').pop()
  ok('a chat with three tool calls')

  // 2. the log on disk: 0700 folder, 0600 files, one line per call
  const dir = join(h.dataDir, 'audit')
  assert(((await stat(dir)).mode & 0o777) === 0o700, 'audit folder is 0700')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'))
  assert(files.length === 1 && ((await stat(join(dir, files[0]))).mode & 0o777) === 0o600, 'one 0600 audit file')
  ok('the log on disk is private')

  // 3. the page lists them newest first, with their decisions
  await page.goto(`${h.origin}/settings/audit`)
  await page.locator(tid('audit-page')).waitFor({ timeout: T })
  const rows = page.locator(tid('audit-row'))
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="audit-row"]').length === 3, null, { timeout: T })
  const tools = await rows.evaluateAll((els) => els.map((e) => [e.getAttribute('data-tool'), e.getAttribute('data-decision')]))
  assert(
    JSON.stringify(tools) ===
      JSON.stringify([
        ['Read', 'deniedByRule'],
        ['Grep', 'allowedByMode'],
        ['Bash', 'allowedByMode']
      ]),
    `rows newest first with decisions (got ${JSON.stringify(tools)})`
  )
  ok('Settings › Audit log lists the calls, newest first')

  // 4. filters and search narrow the list
  await pickOption(page.locator(tid('audit-decision')), 'deniedByRule')
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="audit-row"]').length === 1, null, { timeout: T })
  await page.locator(tid('audit-clear')).click()
  await page.locator(tid('audit-search')).fill('audit-e2e-marker')
  await page.waitForFunction(
    () => {
      const r = [...document.querySelectorAll('[data-testid="audit-row"]')]
      return r.length === 1 && r[0].getAttribute('data-tool') === 'Bash'
    },
    null,
    { timeout: T }
  )
  ok('a decision filter and a search narrow the list')

  // 5. a row opens the full record, and Show in chat lands on the call's tool row
  await rows.first().click()
  const record = page.locator(tid('audit-record'))
  await record.locator(tid('audit-why')).waitFor({ timeout: T })
  assert((await record.locator(tid('audit-why')).textContent()).includes('No approval reached ZumiBot'), 'the record says why it ran')
  await record.locator(tid('audit-show-in-chat')).click()
  await page.waitForFunction((id) => location.pathname === `/chat/${id}`, chatId, { timeout: T })
  await page.locator(`${tid('tool-row')}[data-tool-id="toolu_ls"]`).waitFor({ timeout: T })
  ok('a row opens its record; Show in chat opens the chat at the call')

  // 6. Export downloads the filtered range as JSON Lines; Verify chain says intact
  await page.goto(`${h.origin}/settings/audit`)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="audit-row"]').length === 3, null, { timeout: T })
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: T }), page.locator(tid('audit-export')).click()])
  const saved = join(work, 'audit.jsonl')
  await dl.saveAs(saved)
  const exported = (await readFile(saved, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  assert(dl.suggestedFilename().endsWith('.jsonl'), `export file name (got ${dl.suggestedFilename()})`)
  assert(
    exported.length === 3 && exported.every((r) => r.chatId === chatId && r.agent === AGENT),
    'the export holds the three records of the chat'
  )
  assert(exported[0].tool === 'Bash', 'export is oldest first')
  await page.locator(tid('audit-verify')).click()
  await page.locator(tid('audit-verify-result')).getByText('Chain intact').waitFor({ timeout: T })
  ok('Export gives JSON Lines; Verify chain says intact')

  // 7. the export route refuses a GET and a bad filter
  const status = await page.evaluate(async () => [
    (await fetch('/api/audit/export')).status,
    (await fetch('/api/audit/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"outcome":"great"}' }))
      .status
  ])
  assert(status[0] === 405 && status[1] === 400, `route statuses (got ${status})`)
  ok('export route: GET 405, bad filter 400')

  const bad = unexpectedErrors(h.errors, [/405 \(Method Not Allowed\)/, /400 \(Bad Request\)/])
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
  console.log('AUDIT E2E PASSED')
} catch (err) {
  code = 1
  console.error(err instanceof Error ? err.message : err)
} finally {
  await stop()
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
}
process.exit(code)
