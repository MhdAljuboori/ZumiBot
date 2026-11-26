// End-to-end check of mid-turn messages in the built server + web UI (local mode), against the FAKE claude: no real CLI turn is
// sent, so no login or quota is used. Usage: npm run e2e:steer   (builds first)
//
// While a reply runs, Enter sends the message into that reply: it waits in the tray ("Waiting for the agent's next step") until
// the CLI echoes it back (--replay-user-messages), then shows as the user's bubble inside the reply, with no Edit, Resend or
// Fork. Ctrl+Enter, or holding Send, queues instead: a task row, sent as its own turn once the reply ends. See
// docs/architecture/mid-turn-messages.md.
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// STEER_E2E_SHOTS=<dir> also saves PNGs there; a screenshot that fails never fails the suite.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), new-chat, new-chat-folder, new-chat-choose-folder,
//   composer-input, send-button, user-message, agent-message, steer-row, task-row, edit-button, resend-button, fork-button.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const AGENT = 'e2e-steer-agent'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 20_000
const BASIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'tests', 'fixtures', 'stream', 'basic.jsonl')
const SHOTS = process.env.STEER_E2E_SHOTS || null
const STEER = 'also cover the edge cases'
const QUEUED = 'then write the summary'
const HELD = 'and update the changelog'
const REPLY_1 = 'Done, edge cases included.'
const REPLY_2 = 'Summary written.'

let h = null
const made = []
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const line = (o) => JSON.stringify(o)

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
async function writeReply(path, text) {
  const out = []
  for (const l of (await readFile(BASIC, 'utf8')).split('\n').filter(Boolean)) {
    const m = JSON.parse(l)
    if (m.type === 'stream_event' && m.event?.delta?.type === 'text_delta') m.event.delta.text = text
    else if (m.type === 'assistant') m.message.content = [{ type: 'text', text }]
    else if (m.type === 'result') m.result = text
    out.push(JSON.stringify(m))
  }
  await writeFile(path, out.join('\n') + '\n')
}

/**
 * A turn that runs a tool, takes a steer in after it, then waits again for a Ctrl+Enter to land as a task. Each wait is on a
 * file the test writes once it has checked the state before it, so no step depends on timing.
 */
async function writeSteeredTurn(path, seenWaiting, seenQueued) {
  const sid = '5e3c2a10-0000-4000-8000-00000000a001'
  await writeFile(
    path,
    [
      line({ type: 'system', subtype: 'init', session_id: sid }),
      line({
        type: 'assistant',
        session_id: sid,
        message: {
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 1' } }]
        }
      }),
      '#WAIT_STEER',
      `#WAIT_FILE ${seenWaiting}`,
      line({
        type: 'user',
        session_id: sid,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] }
      }),
      '#STEER_REPLAY',
      `#WAIT_FILE ${seenQueued}`,
      line({ type: 'assistant', session_id: sid, message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: REPLY_1 }] } }),
      line({ type: 'result', subtype: 'success', is_error: false, result: REPLY_1, session_id: sid })
    ].join('\n') + '\n'
  )
}

async function until(fn, ms, msg) {
  const end = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > end) throw new Error(`ASSERT FAILED: ${msg}`)
    await sleep(100)
  }
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

async function main() {
  const work = await mkdtemp(join(tmpdir(), 'zumibot-e2e-steer-'))
  made.push(work)
  h = await start({ mode: 'local', fake: true, env: { ZUMIBOT_TEST_PICK_FOLDER: work } })
  await writeFile(
    join(h.agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Mid-turn e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  const seenWaiting = join(work, '.seen-waiting')
  const seenQueued = join(work, '.seen-queued')
  await writeSteeredTurn(h.script, seenWaiting, seenQueued)
  const page = h.page
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })

  // 1. a reply starts and runs a tool
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  const box = page.locator(tid('composer-input'))
  await box.fill('do the task')
  await page.locator(tid('send-button')).click()
  await page.locator(tid('user-message')).first().waitFor({ timeout: T })
  await page.waitForFunction(() => document.querySelector('[data-testid="send-button"]')?.getAttribute('aria-label') === 'Stop', null, {
    timeout: T
  })
  ok('the reply runs')

  // 2. Enter while it runs: the message waits in the tray, then lands as a bubble inside the reply
  await box.fill(STEER)
  await box.press('Enter')
  const steerRow = page.locator(tid('steer-row'))
  await steerRow.waitFor({ timeout: T })
  assert((await steerRow.textContent()).includes(STEER), 'the waiting row shows the message')
  assert((await steerRow.textContent()).includes("Waiting for the agent's next step"), 'the waiting row says why it waits')
  assert((await page.locator(tid('task-row')).count()) === 0, 'Enter queued no task')
  await shot(page, 'steer-waiting.png')
  ok('Enter put the message into the running reply; it waits for the next step')
  await writeFile(seenWaiting, '')

  const steered = page.locator(tid('user-message')).filter({ hasText: STEER })
  await steered.waitFor({ timeout: T })
  await steerRow.waitFor({ state: 'detached', timeout: T })
  assert((await page.locator(tid('send-button')).getAttribute('aria-label')) !== null, 'still a composer')
  await steered.hover()
  for (const action of ['edit-button', 'resend-button', 'fork-button'])
    assert((await steered.locator(tid(action)).count()) === 0, `a mid-turn message has no ${action}`)
  await shot(page, 'steer-landed.png')
  ok('the agent read it at its next step: a bubble in the reply, with no Edit, Resend or Fork')

  // 3. Ctrl+Enter while it still runs queues a task, sent as its own turn after the reply
  await writeReply(h.script, REPLY_2)
  await box.fill(QUEUED)
  await box.press('Control+Enter')
  const taskRow = page.locator(tid('task-row')).filter({ hasText: QUEUED })
  await taskRow.waitFor({ timeout: T })
  assert((await page.locator(tid('steer-row')).count()) === 0, 'Ctrl+Enter wrote nothing into the reply')
  ok('Ctrl+Enter queued the message as a task')

  // A long press on Send queues too, and the click that ends the press sends nothing more.
  await box.fill(HELD)
  const send = page.locator(tid('send-button'))
  assert((await send.getAttribute('data-tip')).includes('Ctrl+Enter to queue'), 'Send says how to queue while a reply runs')
  await send.hover()
  await page.mouse.down()
  await sleep(800)
  await page.mouse.up()
  await page.locator(tid('task-row')).filter({ hasText: HELD }).waitFor({ timeout: T })
  await sleep(300)
  assert((await page.locator(tid('task-row')).count()) === 2, 'the press queued one task, and its click sent nothing else')
  assert((await page.locator(tid('steer-row')).count()) === 0, 'holding Send wrote nothing into the reply')
  await shot(page, 'queued.png')
  ok('holding Send queued the message as a task')
  await writeFile(seenQueued, '')

  await page.locator(tid('agent-message')).filter({ hasText: REPLY_1 }).waitFor({ timeout: 30_000 })
  await page.locator(tid('agent-message')).filter({ hasText: REPLY_2 }).waitFor({ timeout: 30_000 })
  await taskRow.waitFor({ state: 'detached', timeout: T })
  await page.locator(tid('user-message')).filter({ hasText: HELD }).waitFor({ timeout: 30_000 })
  await page.locator(tid('task-row')).waitFor({ state: 'detached', timeout: 30_000 })
  await until(
    async () => (await page.locator(tid('agent-message')).filter({ hasText: REPLY_2 }).count()) === 2,
    30_000,
    'both queued turns replied'
  )
  const users = await page.locator(tid('user-message')).allTextContents()
  assert(users.length === 4, `four user bubbles, got ${users.length}`)
  assert(users[1].includes(STEER) && users[2].includes(QUEUED) && users[3].includes(HELD), `bubbles in order: ${JSON.stringify(users)}`)
  await shot(page, 'after.png')
  ok('the reply finished with the steer read, then the queued task ran as its own turn')

  const bad = unexpectedErrors(h.errors, [])
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
  console.log('STEER E2E PASSED')
} catch (err) {
  code = 1
  console.error(err instanceof Error ? err.message : err)
} finally {
  await stop()
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
process.exit(code)
