// End-to-end check of the Dispatched agents panel in the built server + web UI (local mode), against the FAKE claude: no
// real CLI turn is sent, so no login or quota is used. Usage: npm run e2e:dispatch   (builds first)
//
// The fake claude replays fixtures/dispatch-script.jsonl: two parallel Agent dispatches (a code review and a structure
// review), the first dispatching a nested Explore agent, with the CLI's task_started/progress/updated lines. A #SLEEP
// after the first progress line holds the run, so the panel is checked while both run. The nested agent hands its report
// back with a SubagentHandback call, as newer CLIs do, and its dispatch result only points at that call.
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dir created here (plus the harness's own temp root) is deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), new-chat, new-chat-folder, new-chat-choose-folder,
//   composer-input, send-button, agent-message, side-panel-toggle, side-menu, side-open-dispatch, side-dispatch-count,
//   side-back, dispatch-panel, dispatch-row (+ data-id, data-status, data-depth), dispatch-now, dispatch-usage,
//   dispatch-detail (+ data-id), dispatch-prompt, dispatch-step (+ data-kind), dispatch-steps-toggle, dispatch-working,
//   dispatch-report, dispatch-close, tool-run, tool-row (+ data-tool-id), dispatch-watch.

import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const AGENT = 'e2e-dispatch-agent'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 20_000
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'fixtures', 'dispatch-script.jsonl')

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

const rowSel = (id) => `${tid('dispatch-row')}[data-id="${id}"]`
/** Every row as [id, status, depth]. */
const rows = (page) =>
  page.locator(tid('dispatch-row')).evaluateAll((els) => els.map((e) => [e.dataset.id, e.dataset.status, Number(e.dataset.depth)]))
const steps = (page) =>
  page
    .locator(`${tid('dispatch-detail')} ${tid('dispatch-step')}`)
    .evaluateAll((els) => els.map((e) => [e.dataset.kind, e.textContent.trim()]))

/** Opens the chat's tool run (folded after a reply) so its rows show. */
async function openToolRun(page) {
  const run = page.locator(tid('tool-run')).first()
  await run.waitFor({ timeout: T })
  if ((await run.locator('.tool-run-head').getAttribute('aria-expanded')) !== 'true') await run.locator('.tool-run-head').click()
  await page.locator(`${tid('tool-row')}[data-tool-id="toolu_A"]`).waitFor({ timeout: T })
}

async function openPanelList(page) {
  if (await page.locator(tid('dispatch-panel')).count()) return
  if (!(await page.locator(tid('side-menu')).count())) await page.locator(tid('side-panel-toggle')).click()
  await page.locator(tid('side-open-dispatch')).click()
  await page.locator(tid('dispatch-panel')).waitFor({ timeout: T })
}

async function main() {
  work = await mkdtemp(join(tmpdir(), 'zumibot-e2e-dispatch-'))
  h = await start({ mode: 'local', fake: true, env: { ZUMIBOT_TEST_PICK_FOLDER: work } })
  await writeFile(
    join(h.agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Dispatched agents e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  await copyFile(SCRIPT, h.script)
  const page = h.page
  await page.reload()
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })

  // 1. a chat whose reply dispatches two agents; the list row says both run
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  await page.locator(tid('composer-input')).fill('review ENH-6916')
  await page.locator(tid('send-button')).click()
  await page.locator(tid('side-panel-toggle')).click()
  await page.locator(tid('side-menu')).waitFor({ timeout: T })
  await page.waitForFunction(() => document.querySelector('[data-testid="side-dispatch-count"]')?.textContent === '2 running', null, {
    timeout: T
  })
  assert((await page.locator(`${tid('side-dispatch-count')}.live`).count()) === 1, 'the running badge is marked live')
  ok('the side panel list shows Open Dispatched agents · 2 running')

  // 2. the list while they run: both rows running, the first with what it does now
  await page.locator(tid('side-open-dispatch')).click()
  await page.locator(tid('dispatch-panel')).waitFor({ timeout: T })
  await page.locator(rowSel('toolu_B')).waitFor({ timeout: T })
  let r = await rows(page)
  assert(
    JSON.stringify(r) ===
      JSON.stringify([
        ['toolu_A', 'running', 0],
        ['toolu_B', 'running', 0]
      ]),
    `two running rows (${JSON.stringify(r)})`
  )
  const now = await page.locator(`${rowSel('toolu_A')} ${tid('dispatch-now')}`).textContent()
  assert(now === 'Running git diff…', `A's now line (${now})`)
  const usage = await page.locator(`${rowSel('toolu_A')} ${tid('dispatch-usage')}`).textContent()
  assert(/^1 tool use · 41k tokens · \d+s$/.test(usage), `A's usage line (${usage})`)
  assert((await page.locator(rowSel('toolu_A')).textContent()).includes('general-purpose'), 'A shows its type chip')
  ok(`the list shows both agents running, A "${now}" (${usage})`)

  // 3. A's conversation while it runs: prompt, its text, its failed Bash, working
  await page.locator(rowSel('toolu_A')).click()
  await page
    .locator(`${tid('dispatch-detail')}[data-id="toolu_A"] ${tid('dispatch-step')}`)
    .first()
    .waitFor({ timeout: T })
  const prompt = await page.locator(tid('dispatch-prompt')).textContent()
  assert(prompt.includes('Prompt from main agent') && prompt.includes('Senior Code Reviewer'), `A's prompt (${prompt})`)
  let s = await steps(page)
  assert(
    s.length === 2 && s[0][0] === 'text' && s[0][1] === 'Looking at the diff.' && s[1][0] === 'tool' && s[1][1].includes('git diff'),
    `A's steps so far (${JSON.stringify(s)})`
  )
  const bashHead = page.locator(`${tid('dispatch-detail')} ${tid('tool-row')}[data-tool-id="toolu_A1"]`)
  assert((await bashHead.locator('.tool-head-title').textContent()) === '▸ Show the branch diff', 'the Bash step reads as its description')
  assert((await bashHead.locator('.tool-head-detail').textContent()) === 'git diff origin/master...HEAD', 'with its command under it')
  assert((await page.locator(`${tid('dispatch-detail')} .tool.failed`).count()) === 1, 'the failed Bash is drawn as failed')
  await page.locator(tid('dispatch-working')).waitFor({ timeout: T })
  ok("A's conversation shows its prompt, text, the failed Bash (as its description over the command) and a working line")

  // 4. the chat's Agent rows say Watch while running
  await openToolRun(page)
  const watch = page.locator(`${tid('tool-row')}[data-tool-id="toolu_B"] ${tid('dispatch-watch')}`)
  assert((await watch.textContent()) === 'Watch ›', `B's chat row offers Watch (${await watch.textContent()})`)
  ok("the chat's Agent rows offer Watch › while their agents run")

  // 5. after the reply: A done, B failed, the nested agent under A; A's conversation grew live
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="agent-message"]')].some((e) => e.textContent.includes('Both reviews ran.')),
    null,
    { timeout: 30_000 }
  )
  await page.waitForFunction(() => document.querySelector('[data-testid="dispatch-detail"] [data-testid="dispatch-report"]'), null, {
    timeout: T
  })
  s = await steps(page)
  assert(JSON.stringify(s.map((x) => x[0])) === JSON.stringify(['text', 'tool', 'agent', 'text']), `A's steps after (${JSON.stringify(s)})`)
  assert((await page.locator(tid('dispatch-report')).textContent()).includes('Review done: no Critical.'), "A's report")
  assert((await page.locator(tid('dispatch-working')).count()) === 0, 'no working line once done')
  const reportFirst = await page.evaluate(() => {
    const report = document.querySelector('[data-testid="dispatch-report"]')
    const prompt = document.querySelector('[data-testid="dispatch-prompt"]')
    return !!report && !!prompt && !!(report.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING)
  })
  assert(reportFirst, 'once done, the report leads, above the prompt')
  ok("A's open conversation filled in live and kept its steps open: nested agent, closing text, its report on top")

  // 6. the nested agent opens from A's step, and Back returns to A
  await page.locator(`${tid('dispatch-detail')} ${tid('dispatch-step')}[data-kind="agent"]`).click()
  await page.locator(`${tid('dispatch-detail')}[data-id="toolu_N"] ${tid('dispatch-report')}`).waitFor({ timeout: T })
  assert(
    (await page.locator(tid('dispatch-prompt')).textContent()).includes('Prompt from Code review ENH-6916 diff'),
    "N's prompt names its agent"
  )
  const nReport = await page.locator(tid('dispatch-report')).textContent()
  assert(
    nReport.includes('Found one caller in a.ts.') && !nReport.includes('delivered'),
    `N's report is its SubagentHandback message (${nReport})`
  )
  assert((await steps(page)).length === 0, 'a finished agent opens with its steps folded')
  const toggle = page.locator(tid('dispatch-steps-toggle'))
  assert(
    (await toggle.textContent()).includes('2 steps') && (await toggle.getAttribute('aria-expanded')) === 'false',
    `N's steps toggle (${await toggle.textContent()})`
  )
  await toggle.click()
  s = await steps(page)
  assert(
    JSON.stringify(s.map((x) => x[0])) === JSON.stringify(['text', 'tool']) && !s.some((x) => x[1].includes('SubagentHandback')),
    `N's steps, no handback row (${JSON.stringify(s)})`
  )
  await page.locator(`${tid('dispatch-panel')} ${tid('side-back')}`).click()
  await page.locator(`${tid('dispatch-detail')}[data-id="toolu_A"]`).waitFor({ timeout: T })
  await page.locator(`${tid('dispatch-panel')} ${tid('side-back')}`).click()
  await page.locator(rowSel('toolu_N')).waitFor({ timeout: T })
  r = await rows(page)
  assert(
    JSON.stringify(r) ===
      JSON.stringify([
        ['toolu_A', 'done', 0],
        ['toolu_N', 'done', 1],
        ['toolu_B', 'failed', 0]
      ]),
    `rows after (${JSON.stringify(r)})`
  )
  assert(
    (await page.locator(`${rowSel('toolu_A')} ${tid('dispatch-usage')}`).textContent()) === 'Done · 7 tool uses · 41k tokens · 1m 12s',
    "A's final usage"
  )
  ok(
    'the nested agent opens from its step on its handed-back report, steps folded, Back walks up, and the list shows A done, N nested, B failed'
  )

  // 7. View on B's chat row opens B
  await page.locator(tid('dispatch-close')).click()
  await openToolRun(page)
  assert((await watch.textContent()) === 'View ›', "B's chat row offers View once ended")
  await watch.click()
  await page
    .locator(`${tid('dispatch-detail')}[data-id="toolu_B"] ${tid('dispatch-step')}`)
    .first()
    .waitFor({ timeout: T })
  s = await steps(page)
  assert(JSON.stringify(s.map((x) => x[0])) === JSON.stringify(['tool', 'text']), `B's steps (${JSON.stringify(s)})`)
  ok("View › on the chat's Agent row opens that agent")

  // 8. a reload keeps everything
  await page.reload()
  await page.locator(tid('agent-message')).first().waitFor({ timeout: T })
  await openPanelList(page)
  await page.locator(rowSel('toolu_N')).waitFor({ timeout: T })
  r = await rows(page)
  assert(
    JSON.stringify(r) ===
      JSON.stringify([
        ['toolu_A', 'done', 0],
        ['toolu_N', 'done', 1],
        ['toolu_B', 'failed', 0]
      ]),
    `rows after reload (${JSON.stringify(r)})`
  )
  await page.locator(tid('side-back')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="side-dispatch-count"]')?.textContent === '3', null, { timeout: T })
  ok('after a reload the list is the same and the badge counts 3')

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
  console.log('DISPATCH E2E PASSED')
} catch (err) {
  code = 1
  console.error(err instanceof Error ? err.message : err)
} finally {
  await stop()
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
}
process.exit(code)
