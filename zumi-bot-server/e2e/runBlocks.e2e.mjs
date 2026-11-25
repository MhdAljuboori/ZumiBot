// End-to-end check of the Run button on a shell block in a reply, in the built server + web UI (local mode), against the
// FAKE claude: no real CLI turn is sent, so no login or quota is used. Usage: npm run e2e:run-blocks   (builds first)
//
// The agent's reply holds one single-line bash block, longer than the reply is wide: it wraps, so the whole command is on
// screen before the click. Run starts it as a background process in the chat folder, with no approval card; when it
// ends, the result goes to the agent as a hidden message (`<bash-input>`, and the output with its exit line in
// `<bash-stdout>`, read on the fake's stdin), the agent replies, and the chat shows no extra "you" bubble for it. The
// status under the button opens the process's log in the side panel.
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// RUN_E2E_SHOTS=<dir> also saves four PNGs there (desktop before and after, phone after, the log panel); a screenshot
// that fails never fails the suite.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), new-chat, new-chat-folder, new-chat-choose-folder,
//   composer-input, send-button, user-message, agent-message, code-run, code-run-status, code-run-error, chat-row (+ data-chat-id),
//   side-panel-toggle, side-menu, process-log-panel, process-log, process-log-command.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const AGENT = 'e2e-run-agent'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 20_000
// Wider than the reply column, even on a desktop. No character that runResultText escapes (&, <, >).
const CMD =
  'echo run-e2e-ok; : this tail of words makes the one line wider than the reply column, so it has to wrap on screen instead of scrolling out of view'
const OK = 'run-e2e-ok'
// As the fake's stdin holds them: the message text inside the stream-json line, so its newline is JSON-escaped.
const inJson = (text) => JSON.stringify(text).slice(1, -1)
const STDIN_INPUT = inJson(`<bash-input>${CMD}</bash-input>`)
const STDIN_OUTPUT = inJson(`<bash-stdout>${OK}\n[exit code 0]</bash-stdout>`)
const BASIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'tests', 'fixtures', 'stream', 'basic.jsonl')
const REPLY_1 = `Run this:\n\n\`\`\`bash\n${CMD}\n\`\`\`\n`
const REPLY_2 = 'Saw it.'
const SHOTS = process.env.RUN_E2E_SHOTS || null

let h = null
const made = []
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

/** basic.jsonl with its "pong" reply swapped for `text` (the fake re-reads the script on every run). */
async function writeScript(path, text) {
  const out = []
  for (const line of (await readFile(BASIC, 'utf8')).split('\n').filter(Boolean)) {
    const m = JSON.parse(line)
    if (m.type === 'stream_event' && m.event?.delta?.type === 'text_delta') m.event.delta.text = text
    else if (m.type === 'assistant') m.message.content = [{ type: 'text', text }]
    else if (m.type === 'result') m.result = text
    out.push(JSON.stringify(m))
  }
  await writeFile(path, out.join('\n') + '\n')
}

/** Never throws: a screenshot is for the reviewer's eyes, not a check. */
async function shot(page, name) {
  if (!SHOTS) return
  try {
    await mkdir(SHOTS, { recursive: true })
    await page.screenshot({ path: join(SHOTS, name) })
    console.log(`shot ${name}`)
  } catch (e) {
    console.log(`shot ${name} failed: ${e instanceof Error ? e.message : e}`)
  }
}

/** `msg` may be a function, read at the failure, so it can say what the page shows by then. */
async function until(fn, ms, msg) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) throw new Error(`ASSERT FAILED: ${typeof msg === 'function' ? await msg() : msg}`)
    await sleep(100)
  }
}

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'zumibot-e2e-run-'))
  made.push(work)
  const stdinFile = join(await mkdtemp(join(tmpdir(), 'zumibot-e2e-run-stdin-')), 'stdin.txt')
  made.push(dirname(stdinFile))
  h = await start({ mode: 'local', fake: true, env: { ZUMIBOT_TEST_PICK_FOLDER: work, FAKE_STDIN_OUT: stdinFile } })
  await writeFile(
    join(h.agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Run button e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  await writeScript(h.script, REPLY_1)
  const page = h.page
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })

  // 1. a reply with one single-line shell block gets a Run button
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  await page.locator(tid('composer-input')).fill('give me a command')
  await page.locator(tid('send-button')).click()
  const msg = page.locator(tid('agent-message')).last()
  const run = msg.locator(tid('code-run'))
  await run.waitFor({ timeout: 30_000 })
  assert((await msg.locator(tid('code-run')).count()) === 1, 'one Run button for the one block')
  assert((await msg.locator('pre').first().textContent()).includes(CMD), 'the block holds the command')
  assert((await msg.locator(tid('code-run-status')).count()) === 0, 'no status before a run')
  const fits = await msg
    .locator('pre')
    .first()
    .evaluate((el) => el.scrollWidth <= el.clientWidth)
  assert(fits, 'the long command wraps in its block instead of scrolling sideways')
  // Run shows on hover on a desktop; only the screenshot needs it.
  if (SHOTS)
    await msg
      .locator('pre')
      .first()
      .hover()
      .catch(() => {})
  await shot(page, 'desktop-before.png')
  const bubbles = await page.locator(tid('user-message')).count()
  assert(bubbles === 1, `one user bubble before the run (got ${bubbles})`)
  ok('the single-line bash block has a Run button and no status, and its long line wraps')

  // 2. Run: no approval card, the process runs and ends, the status says so; the agent's next turn will say "Saw it."
  await writeScript(h.script, REPLY_2)
  await run.click()
  const status = page.locator(tid('code-run-status')) // the later reply is the last message, so not through `msg`
  await status.waitFor({ timeout: T })
  await until(
    async () => (await status.textContent()).includes('Exited (code 0)'),
    T,
    async () => `the status reads Exited (code 0), not ${await status.textContent()}`
  )
  assert((await page.locator(tid('approval-card')).count()) === 0, 'a Run by the user asks for no approval')
  assert((await msg.locator(tid('code-run-error')).count()) === 0, 'no refusal')
  ok('Run starts the command with no approval card; the status reads Exited (code 0)')

  // 3. the result went to the agent: the next run's stdin holds the command and its output
  await page.locator(tid('agent-message')).filter({ hasText: REPLY_2 }).first().waitFor({ timeout: 30_000 })
  const stdin = await until(
    async () => (await readFile(stdinFile, 'utf8').catch(() => '')).includes('<bash-input>') && (await readFile(stdinFile, 'utf8')),
    T,
    'the hidden message reached the agent'
  )
  assert(stdin.includes(STDIN_INPUT), `stdin lacks ${STDIN_INPUT}:\n${stdin}`)
  // The command holds OK too, so only its place in <bash-stdout>, before the exit line, shows the output arrived.
  assert(stdin.includes(STDIN_OUTPUT), `stdin lacks ${STDIN_OUTPUT}:\n${stdin}`)
  ok('the agent got <bash-input> and the output with its exit line on its next turn, and replied')

  // 4. no extra "you" bubble for the hidden message
  await sleep(500)
  assert((await page.locator(tid('user-message')).count()) === bubbles, 'the hidden message drew no user bubble')
  assert((await page.locator(`${tid('user-message')}:has-text("bash-input")`).count()) === 0, 'no bubble shows the markup')
  ok('the user-message count is unchanged after the reply')
  await shot(page, 'desktop-after.png')

  // 5. the same view on a phone
  await phoneShot(page.url())

  // 6. the status opens the process's log in the side panel
  await status.click()
  const panel = page.locator(tid('process-log-panel'))
  await panel.waitFor({ timeout: T })
  assert((await page.locator(tid('process-log-command')).textContent()) === CMD, 'the log view shows the command')
  await until(async () => (await page.locator(tid('process-log')).textContent()).includes(OK), T, 'the log shows the output')
  await shot(page, 'panel.png')
  ok('the status opens the Processes panel on its log, which shows the output')

  // 7. nothing unexpected
  const bad = unexpectedErrors(h.errors, [])
  assert(bad.length === 0, `unexpected console/server errors:\n${bad.join('\n')}`)
  ok('no unexpected console or server errors')
}

/** A phone context opens the same chat from the sidebar; only for the screenshot, so any failure here is logged and skipped. */
async function phoneShot(chatUrl) {
  if (!SHOTS) return
  let ctx = null
  try {
    ctx = await h.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true })
    const p = await ctx.newPage()
    await p.goto(chatUrl) // a phone has the sidebar closed, so open the chat by its address
    await p.locator(tid('code-run-status')).waitFor({ timeout: 15_000 })
    await sleep(400)
    await shot(p, 'phone-after.png')
  } catch (e) {
    console.log(`shot phone-after.png failed: ${e instanceof Error ? e.message : e}`)
  } finally {
    await ctx?.close().catch(() => {})
  }
}

const timer = setTimeout(() => {
  console.error(`FAIL: overall timeout ${OVERALL_TIMEOUT / 1000} s`)
  void stop().finally(() => process.exit(1))
}, OVERALL_TIMEOUT)
timer.unref()

let code = 0
try {
  await main()
  console.log('RUN BLOCKS E2E PASSED')
} catch (err) {
  code = 1
  console.error(err instanceof Error ? err.message : err)
} finally {
  await stop()
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
process.exit(code)
