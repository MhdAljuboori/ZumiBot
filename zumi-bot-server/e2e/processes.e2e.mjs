// End-to-end check of background processes in the built server + web UI (local mode), against a FAKE claude that runs the
// REAL injected zumibot_processes bridge (backend/tests/fixtures/fake-process-claude.mjs): no real CLI turn is sent, so no
// login or quota is used. Usage: npm run e2e:processes   (builds first)
//
// One turn starts a process behind its approval card (the whole command shown) and waits for its ready line; the next turn
// reads its log through the tool. Then, in the side panel: the badge, the row, the live log growing, Stop ending the whole
// tree, the header mark coming and going (and the sidebar never showing the chat as running), Restart, Forget.
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dir created here (plus the harness's own temp root) is deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`, and so is any process tree the run left; overall timeout 3 min.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), new-chat, new-chat-folder, new-chat-choose-folder,
//   composer-input, send-button, agent-message, approval-card, approval-process, approval-allow-once, approval-allow-chat,
//   side-panel-toggle, side-menu, side-open-processes, side-processes-count, side-back, processes-panel, processes-empty,
//   process-row (+ data-id, data-state), process-state, process-log-panel, process-log, process-log-state,
//   process-log-command, process-stop, process-restart, process-forget, process-mark, processes-close.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const AGENT = 'e2e-process-agent'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 20_000
const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, '..', 'backend', 'tests', 'fixtures', 'fake-process-claude.mjs')
const COMMAND = 'echo pid=$$; echo ready-now; i=0; while true; do i=$((i+1)); echo tick-$i; sleep 0.3; done'

let h = null
let work = null
const pids = new Set()
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
// A zombie (an orphan a non-reaping PID 1 holds) is dead.
const alive = (pid) => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    return !/\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return true
  }
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
  // The server ends every tree on stop; a crash must not leave this run's loop behind either.
  for (const p of pids) {
    try {
      process.kill(-p, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
}

const scenario = (log, steps) => `PROCESS_SCENARIO:${Buffer.from(JSON.stringify({ log, steps })).toString('base64')}`
const logged = async (log) =>
  (await readFile(log, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

async function send(page, text, replies) {
  await page.locator(tid('composer-input')).fill(text)
  await page.locator(tid('send-button')).click()
  return replies
}
const replyCount = (page) => page.locator(tid('agent-message')).filter({ hasText: 'Process fixture complete.' }).count()
async function waitReplies(page, n) {
  await page.waitForFunction(
    (want) =>
      [...document.querySelectorAll('[data-testid="agent-message"]')].filter((e) => e.textContent.includes('Process fixture complete.'))
        .length >= want,
    n,
    { timeout: 30_000 }
  )
}

async function main() {
  work = await mkdtemp(join(tmpdir(), 'zumibot-e2e-processes-'))
  const log = join(work, '.fixture-log.jsonl')
  h = await start({ mode: 'local', fake: FAKE, env: { ZUMIBOT_TEST_PICK_FOLDER: work } })
  await writeFile(
    join(h.agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Background processes e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  const page = h.page
  await page.reload()
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })

  // 1. turn 1: a start behind its card, which shows the whole command, then a wait for its ready line
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  await send(
    page,
    scenario(log, [
      { tool: 'start', args: { command: COMMAND, name: 'web' }, save: 'web' },
      { tool: 'wait', args: { id: { $id: 'web' }, patterns: ['ready-now'], timeoutSeconds: 10 }, save: 'waited' }
    ])
  )
  const card = page.locator(`${tid('approval-card')}[data-status="pending"]`)
  await card.waitFor({ timeout: T })
  const shown = await card.locator(tid('approval-process')).textContent()
  assert(
    shown.includes(COMMAND) && shown.includes('named web') && shown.includes('keeps running after this reply'),
    `the card shows the whole command (${shown})`
  )
  assert(
    (await card.locator(tid('approval-allow-chat')).textContent()).includes('this exact command in this folder'),
    'Allow for this chat says what it covers'
  )
  ok('the start card shows the whole command, its folder and name, and what a remembered answer covers')
  await card.locator(tid('approval-allow-once')).click()
  await waitReplies(page, 1)
  const entries = await logged(log)
  assert(
    entries.find((e) => e.name === 'waited')?.text?.startsWith('Matched: ready-now'),
    `the agent's wait saw the ready line (${JSON.stringify(entries)})`
  )
  const webId = entries.find((e) => e.name === 'web')?.id
  assert(/^p_[0-9a-f]{10}$/.test(webId ?? ''), 'start answered with an id')
  ok('the agent started it and waited for its ready line')

  // 2. the reply is over, the process is not: the header marks it, nothing says the chat is running
  await page.locator(tid('process-mark')).waitFor({ timeout: T })
  assert((await page.locator(tid('process-mark')).getAttribute('data-tip')) === '1 process running', 'the mark says one runs')
  assert((await page.locator(`${tid('send-button')}.stop`).count()) === 0, 'the composer offers Send, not Stop')
  assert(
    (await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"] .bot-working`).count()) === 0,
    'the sidebar does not show the agent working'
  )
  ok('the chat header shows the process mark while the sidebar and composer show no running reply')

  // 3. turn 2: the process outlived turn 1, and this turn reads its log
  await send(page, scenario(log, [{ tool: 'logs', args: { id: { $id: 'web' }, tail: 5 }, save: 'read' }]))
  await waitReplies(page, 2)
  const read = (await logged(log)).find((e) => e.name === 'read')
  assert(read && !read.isError && /tick-\d+/.test(read.text), `the next turn read its log (${JSON.stringify(read)})`)
  ok("the next turn read the running process's log through the tool")

  // 4. the side panel: badge, row, live log
  await page.locator(tid('side-panel-toggle')).click()
  await page.locator(tid('side-menu')).waitFor({ timeout: T })
  await page.waitForFunction(() => document.querySelector('[data-testid="side-processes-count"]')?.textContent === '1 running', null, {
    timeout: T
  })
  assert((await page.locator(`${tid('side-processes-count')}.live`).count()) === 1, 'the running badge is marked live')
  await page.locator(tid('side-open-processes')).click()
  await page.locator(tid('processes-panel')).waitFor({ timeout: T })
  const row = page.locator(`${tid('process-row')}[data-id="${webId}"]`)
  await row.waitFor({ timeout: T })
  assert(
    (await row.getAttribute('data-state')) === 'running' && (await row.locator(tid('process-state')).textContent()) === 'Running',
    'the row reads Running'
  )
  assert(
    (await row.textContent()).includes('E2e Process Agent') || (await row.textContent()).includes(AGENT),
    'the row names who started it'
  )
  await row.click()
  await page.locator(tid('process-log-panel')).waitFor({ timeout: T })
  assert((await page.locator(tid('process-log-command')).textContent()) === COMMAND, 'the log view shows the whole command')
  await page.waitForFunction(() => document.querySelector('[data-testid="process-log"]')?.textContent.includes('ready-now'), null, {
    timeout: T
  })
  const pid = Number(/pid=(\d+)/.exec(await page.locator(tid('process-log')).textContent())?.[1])
  pids.add(pid)
  assert(alive(pid), 'its shell is alive')
  const ticks = async () =>
    Math.max(0, ...[...(await page.locator(tid('process-log')).textContent()).matchAll(/tick-(\d+)/g)].map((m) => Number(m[1])))
  const before = await ticks()
  await page.waitForFunction(
    (n) =>
      [...document.querySelector('[data-testid="process-log"]').textContent.matchAll(/tick-(\d+)/g)].some((m) => Number(m[1]) >= n + 3),
    before,
    { timeout: T }
  )
  ok(`Open Processes · 1 running; the row opens a live log that keeps growing (tick ${before} → ${await ticks()})`)

  // 5. Stop ends the whole tree; the mark goes, the badge counts it as ended
  await page.locator(tid('process-stop')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="process-log-state"]')?.textContent === 'Stopped by you', null, {
    timeout: T
  })
  assert(!alive(pid), 'Stop ended its shell')
  await page.locator(tid('process-mark')).waitFor({ state: 'detached', timeout: T })
  assert(
    (await page.locator(tid('process-forget')).count()) === 1 && (await page.locator(tid('process-stop')).count()) === 0,
    'an ended process offers Forget, not Stop'
  )
  ok('Stop ended the tree, the log view reads "Stopped by you", and the header mark went away')

  // 6. Restart runs it again under the same id, after a marker line
  await page.locator(tid('process-restart')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="process-log-state"]')?.textContent === 'Running', null, {
    timeout: T
  })
  await page.waitForFunction(
    () => document.querySelector('[data-testid="process-log"]')?.textContent.includes('restarted by the user'),
    null,
    { timeout: T }
  )
  await page.locator(tid('process-mark')).waitFor({ timeout: T })
  await page.waitForFunction(
    () => /pid=\d+[\s\S]*pid=\d+/.test(document.querySelector('[data-testid="process-log"]')?.textContent ?? ''),
    null,
    { timeout: T }
  )
  const pid2 = Number([...(await page.locator(tid('process-log')).textContent()).matchAll(/pid=(\d+)/g)].pop()[1])
  pids.add(pid2)
  assert(pid2 !== pid && alive(pid2), 'Restart started a new shell')
  ok('Restart ran the same command again under the same row, after a "restarted by the user" line')

  // 7. Stop again, then Forget: the list is empty
  await page.locator(tid('process-stop')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="process-log-state"]')?.textContent === 'Stopped by you', null, {
    timeout: T
  })
  assert(!alive(pid2), 'the restarted shell ended')
  await page.locator(tid('process-forget')).click()
  await page.locator(tid('processes-empty')).waitFor({ timeout: T })
  await page.locator(`${tid('processes-panel')} ${tid('side-back')}`).click()
  assert((await page.locator(tid('side-processes-count')).count()) === 0, 'no badge once the list is empty')
  ok('Forget removed the ended process; the list is empty and the badge gone')

  // 8. a notify rule: the process ends after the reply, and its wake-up is a turn of its own the agent answers
  const before8 = await replyCount(page)
  await send(
    page,
    scenario(log, [
      { tool: 'start', args: { command: 'sleep 1; echo built-it; exit 3', name: 'build', notify: { on: 'fail' } }, save: 'build' }
    ])
  )
  const card8 = page.locator(`${tid('approval-card')}[data-status="pending"]`)
  await card8.waitFor({ timeout: T })
  await card8.locator(tid('approval-allow-once')).click()
  await waitReplies(page, before8 + 1)
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid="user-message"], .message.user, .bubble.user')].some((e) =>
        e.textContent.includes('Background process update')
      ) || document.body.textContent.includes('Background process update'),
    null,
    { timeout: 30_000 }
  )
  assert(
    (await page.locator('body').textContent()).includes('"build"') &&
      (await page.locator('body').textContent()).includes('exited with code 3.'),
    'the wake message names the process and how it ended'
  )
  // The agent ran on it: the fixture answers a message with no scenario.
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="agent-message"]')].some((e) => e.textContent.includes('No scenario.')),
    null,
    { timeout: 30_000 }
  )
  if (!(await page.locator(tid('processes-panel')).count())) {
    if (!(await page.locator(tid('side-menu')).count())) await page.locator(tid('side-panel-toggle')).click()
    await page.locator(tid('side-open-processes')).click()
  }
  await page.locator(tid('processes-panel')).waitFor({ timeout: T })
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('[data-testid="process-wake"]')].some((e) => e.textContent === 'Wakes the agent if it fails · used'),
    null,
    { timeout: T }
  )
  ok(
    'a notify rule woke the agent after its reply: the wake message names the process, the agent answered, the row reads "Wakes the agent if it fails · used"'
  )

  // 9. a reload keeps it all
  await page.reload()
  await page.locator(tid('agent-message')).first().waitFor({ timeout: T })
  assert((await page.locator(tid('process-mark')).count()) === 0, 'no mark after a reload')
  ok('after a reload there is no mark, since nothing runs')

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
  console.log('PROCESSES E2E PASSED')
} catch (err) {
  code = 1
  console.error(err instanceof Error ? err.message : err)
  if (h?.page) await h.page.screenshot({ path: join(tmpdir(), 'processes-e2e-failure.png') }).catch(() => {})
} finally {
  await stop()
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
}
process.exit(code)
