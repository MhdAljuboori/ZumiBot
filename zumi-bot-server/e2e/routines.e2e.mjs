// End-to-end check of Routines in the built server + web UI (local mode) against the FAKE claude: no real CLI turn is
// ever sent, so no login or quota is used. Usage: npm run e2e:routines   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// The permission steps use the fake claude's script file: a can_use_tool control_request, then #WAIT_RESPONSE.
// Steps assert structure (rows, statuses, chips, stored files), never reply wording.
//
// DOM hooks relied on (data-testid): mode-tab-routines, mode-waiting, new-routine, routine-name, trigger-kind, target-agent,
//   target-folder, routine-prompt-input (+ field-chip, data-path), field-menu, field-option (+ data-path), routine-save,
//   routine-run-now, routine-row, run-row (+ data-status), run-via, run-open-chat, webhook-url, webhook-secret-show,
//   webhook-secret, webhook-check, webhook-field (+ data-path, .rt-insert), message-list, approval-card (+ data-status),
//   approval-allow-agent, question-card (+ data-status, data-request-id), question-tab (+ data-done),
//   question-option (+ data-label), question-other, question-other-input, question-back, question-next,
//   question-send, question-skip, plan-card (+ data-status), plan-body, plan-approve, plan-keep, plan-feedback-input,
//   plan-send, plan-feedback, limit-policy, missed-policy, run-policy, limit-notice (+ data-state), limit-continue, limit-cancel, error-bubble,
//   routine-more, routine-duplicate, routine-discard, routine-enabled, target-kind-group, target-members,
//   target-member-option (+ data-agent-name), target-title, target-section, user-section, group-row (+ data-chat-id),
//   routine-history, history-dialog, history-row (+ data-current), history-restore, history-close, routine-restore-note.
// The usage-limit steps script a rejected rate_limit_event whose reset is 55 s past, so the wait lasts about 5 s.
// Stored state read: <dataDir>/routines.json, <dataDir>/routine-runs.json, <dataDir>/chats.json, <dataDir>/chats/<id>.json,
// <dataDir>/sidebar.json.

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors, pickOption, selectValue } from './harness.mjs'

const BASIC = fileURLToPath(new URL('../backend/tests/fixtures/stream/basic.jsonl', import.meta.url))
const AGENT = 'e2e-routine-agent'
const HELPER = 'e2e-routine-helper' // a room's second member
const PREFIX = 'zumibot-e2e-routines-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 15_000

let h = null
let pickDir = null
const made = [] // every mkdtemp dir made here
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const readJson = (name) => readFile(join(h.dataDir, name), 'utf8').then(JSON.parse)

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

// ---------- UI helpers ----------
const newRoutine = async (page) => {
  await page.click(tid('mode-tab-routines'))
  await page.click(tid('new-routine'))
  await page.locator(tid('routine-name')).waitFor({ timeout: T })
}
async function pickAgentAndFolder(page) {
  await pickOption(page.locator(tid('target-agent')), AGENT)
  await page.click(tid('target-folder'))
  await waitFor(async () => (await page.locator(tid('target-folder')).getAttribute('data-tip')) === pickDir, T, 'the folder to be set')
}
const save = async (page) => {
  await page.click(tid('routine-save'))
  await page.locator(tid('routine-row')).first().waitFor({ timeout: T })
  await waitFor(
    async () => (await page.locator(tid('routine-save')).isDisabled()) || (await page.locator(tid('routine-run-now')).isEnabled()),
    T,
    'the save to land'
  )
}
const runs = (page) => page.locator(tid('run-row'))
const firstRunStatus = (page) => runs(page).first().getAttribute('data-status')
const waitRunStatus = (page, status, what) =>
  waitFor(async () => (await runs(page).count()) > 0 && (await firstRunStatus(page)) === status, 30_000, what)
const userBubbles = async (page) => (await page.locator('.bubble.user').allTextContents()).map((s) => s.trim())
const userItems = async (chatId) => (await readJson(`chats/${chatId}.json`)).filter((i) => i.type === 'user').map((i) => i.text)
const chatMeta = async (chatId) => (await readJson('chats.json')).chats.find((c) => c.id === chatId)

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

async function openRunChat(page, nth = 0) {
  const btn = runs(page).nth(nth).locator(tid('run-open-chat'))
  await waitFor(async () => (await btn.count()) === 1 && (await btn.isEnabled()), T, 'the run chat to be openable')
  await btn.click()
  await page.locator(tid('message-list')).waitFor({ timeout: T })
}
const backToRoutines = async (page, name) => {
  await page.click(tid('mode-tab-routines'))
  await page.locator(tid('routine-row'), { hasText: name }).first().click()
  await page.locator(tid('routine-editor')).waitFor({ timeout: T })
}

// Opens the webhook URL with the secret as the header; the secret is never logged.
const call = (url, secret, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(secret ? { 'X-ZumiBot-Secret': secret } : {}), ...headers },
    body: JSON.stringify(body)
  })

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  pickDir = await mk('folder')
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  const responsesFile = join(await mk('responses'), 'responses.jsonl')
  const invocations = join(await mk('invocations'), 'invocations.jsonl')
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Routine e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  await writeFile(
    join(agentsDir, `${HELPER}.md`),
    `---\nname: ${HELPER}\ndescription: Routine e2e room member.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  h = await start({
    fake: true,
    dataDir,
    agentsDir,
    env: {
      ZUMIBOT_TEST_PICK_FOLDER: pickDir,
      ZUMIBOT_PERMISSION_MODE: 'manual',
      FAKE_RESPONSES_FILE: responsesFile,
      FAKE_INVOCATIONS_OUT: invocations
    }
  })
  const page = h.page
  await page.locator(tid('mode-tab-routines')).waitFor({ timeout: T })

  // 1-3. a manual routine, run now, its chat
  await newRoutine(page)
  await page.fill(tid('routine-name'), 'Daily digest')
  await pickOption(page.locator(tid('trigger-kind')), 'manual')
  await pickAgentAndFolder(page)
  await page.locator(tid('routine-prompt-input')).click()
  await page.keyboard.type('Summarise the news')
  await save(page)
  ok('a manual routine is saved')

  // Routines has its own address: a saved routine survives a reload, an unknown one falls back to /routines, Back
  // from Agents returns to the routine.
  const path = () => decodeURIComponent(new URL(page.url()).pathname)
  const digestId = (await readJson('routines.json')).find((r) => r.name === 'Daily digest').id
  await waitFor(async () => path() === `/routines/${digestId}`, T, 'the address to name the saved routine')
  await page.reload()
  await page.locator(tid('routine-editor')).waitFor({ timeout: T })
  assert((await page.locator(tid('routine-name')).inputValue()) === 'Daily digest', 'a reload did not reopen the routine')
  assert(path() === `/routines/${digestId}`, 'a reload changed the routine address')
  await page.goto(`${h.origin}/routines/no-such-routine`)
  await page.locator(tid('routine-placeholder')).waitFor({ timeout: T })
  await waitFor(async () => path() === '/routines', T, 'an unknown routine to fall back to /routines')
  await page.locator(tid('routine-row'), { hasText: 'Daily digest' }).first().click()
  await page.locator(tid('routine-editor')).waitFor({ timeout: T })
  await waitFor(async () => path() === `/routines/${digestId}`, T, 'opening a routine to set its address')
  await page.click(tid('mode-tab-agents'))
  await waitFor(async () => path() === '/', T, 'Agents to leave the routine address')
  await page.goBack()
  await page.locator(tid('routine-editor')).waitFor({ timeout: T })
  assert((await page.locator(tid('routine-name')).inputValue()) === 'Daily digest', 'Back did not return to the routine')
  ok('a routine has its own address: reload, an unknown id and Back all land right')

  await page.click(tid('routine-run-now'))
  await waitRunStatus(page, 'done', 'the manual run to be done')
  assert((await runs(page).first().locator(tid('run-via')).textContent())?.trim() === 'manual', 'the Run now row has no manual tag')
  await openRunChat(page)
  const { chats: list } = await readJson('chats.json')
  assert(
    list.some((c) => /^Daily digest · [A-Z][a-z]{2} \d{1,2}$/.test(c.title ?? '')),
    'no chat titled "<name> · <Mon D>"'
  )
  assert(
    (await userBubbles(page)).some((t) => t.includes('Summarise the news')),
    'the run chat lacks the prompt as the user message'
  )
  ok('Run now makes a done run whose new chat holds the prompt and the dated title')

  // 4. a webhook routine: URL, secret, test call, field chips
  await newRoutine(page)
  await page.fill(tid('routine-name'), 'Hook routine')
  await pickOption(page.locator(tid('trigger-kind')), 'webhook')
  await pickAgentAndFolder(page)
  const url = (await page.locator(tid('webhook-url')).textContent()).trim()
  assert(/\/hooks\/[^/\s]+$/.test(url) && url.startsWith(h.origin), 'the webhook URL is not <origin>/hooks/<id>')
  await page.click(tid('webhook-secret-show'))
  const secret = (await page.locator(tid('webhook-secret')).textContent()).trim()
  assert(secret.length >= 16 && !secret.includes('•'), 'the secret was not shown')
  const first = await call(url, secret, { topic: 'ai' })
  assert(first.ok, `the test call was refused (${first.status})`)
  await page.click(tid('webhook-check'))
  await page.locator(tid('webhook-field') + '[data-path="body.topic"]').waitFor({ timeout: T })
  ok('a test call shows the field body.topic')

  const input = page.locator(tid('routine-prompt-input'))
  await input.click()
  await page.keyboard.type('Look at ')
  await page.keyboard.type('{{')
  await page.locator(tid('field-menu')).waitFor({ timeout: T })
  await page.locator(tid('field-option') + '[data-path="body.topic"]').click()
  assert((await page.locator(tid('field-chip')).count()) === 1, 'the {{ menu did not make one chip')
  await page.keyboard.type(' and ')
  await page.locator(`${tid('webhook-field')}[data-path="body.topic"] .rt-insert`).click()
  assert((await page.locator(tid('field-chip')).count()) === 2, 'Insert did not add a second chip')
  await page.waitForFunction(() => document.activeElement?.classList.contains('rt-prompt-input'), undefined, { timeout: 3_000 }) // Insert hands the caret back to the prompt
  await page.keyboard.press('Backspace') // the chip before the caret is one atom
  await waitFor(async () => (await page.locator(tid('field-chip')).count()) === 1, 3_000, 'Backspace to delete a chip')
  await save(page)
  const saved = (await readJson('routines.json')).find((r) => r.name === 'Hook routine')
  assert(saved, 'the webhook routine is not in routines.json')
  assert(saved.prompt.split('{{body.topic}}').length === 2, `the saved prompt should hold the field once: ${saved.prompt}`)
  ok('the {{ menu, Insert and chip deletion save the prompt with one {{body.topic}}')

  const second = await call(url, secret, { topic: 'space' })
  assert(second.ok, `the real call was refused (${second.status})`)
  await waitRunStatus(page, 'done', 'the webhook run to be done')
  assert((await runs(page).first().locator(tid('run-via')).count()) === 0, 'a webhook run row has a manual tag')
  await openRunChat(page)
  assert(
    (await userBubbles(page)).some((t) => t.includes('space')),
    'the webhook run chat lacks the posted value'
  )
  ok('a webhook call runs the routine with the posted value in the prompt')

  // 5. auth of the hook
  const wrong = await call(url, `${secret}x`, { topic: 'x' })
  assert(wrong.status === 401, `wrong secret gave ${wrong.status}`)
  const none = await call(url, null, { topic: 'x' })
  assert(none.status === 401, `no secret gave ${none.status} (a login redirect would be 302)`)
  ok('a wrong or missing secret gives 401, not a login redirect')

  // 6. a tool request: waiting, then Allow always, then no card for the next run
  await writeFile(
    h.script,
    [
      ...(await readFile(BASIC, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .flatMap((line) =>
          JSON.parse(line).type === 'stream_event' && JSON.parse(line).event?.delta?.type === 'text_delta'
            ? [
                JSON.stringify({
                  type: 'control_request',
                  request_id: 'req-e2e-routine',
                  request: {
                    subtype: 'can_use_tool',
                    tool_name: 'Bash',
                    input: { command: 'ls' },
                    description: 'List files',
                    decision_reason: 'needs approval',
                    tool_use_id: 'toolu_e2e'
                  }
                }),
                '#WAIT_RESPONSE req-e2e-routine',
                line
              ]
            : [line]
        )
    ].join('\n') + '\n'
  )
  await backToRoutines(page, 'Daily digest')
  const before = await runs(page).count()
  await page.click(tid('routine-run-now'))
  await waitFor(
    async () => (await runs(page).count()) === before + 1 && (await firstRunStatus(page)) === 'waiting',
    30_000,
    'the run to wait for approval'
  )
  assert(await page.locator(tid('mode-waiting')).isVisible(), 'the Routines tab waiting dot is not visible')
  await openRunChat(page)
  await page.locator(tid('approval-card')).last().locator(tid('approval-allow-agent')).click()
  await waitFor(
    async () => (await page.locator(tid('approval-card')).last().getAttribute('data-status')) === 'allowed-agent',
    T,
    'the card to read allowed for the agent'
  )
  await backToRoutines(page, 'Daily digest')
  await waitRunStatus(page, 'done', 'the approved run to finish')
  ok('a tool request makes the run wait (Routines tab dot), and Allow always answers it')

  const count = await runs(page).count()
  await page.click(tid('routine-run-now'))
  await waitFor(
    async () => (await runs(page).count()) === count + 1 && (await firstRunStatus(page)) === 'done',
    30_000,
    'the next run to finish without waiting'
  )
  await openRunChat(page)
  const cards = page.locator(tid('approval-card'))
  assert(
    (await cards.count()) >= 1 && (await cards.last().getAttribute('data-status')) === 'auto-allowed-agent',
    'the next run did not show an auto-allowed card'
  )
  assert(!(await page.locator(tid('approval-allow-agent')).count()), 'the next run still asked for approval')
  ok('the next Run completes with an auto-allowed card')

  // 7. a question card: answer flow (Blue + S/M), then Skip
  const questionInput = {
    questions: [
      {
        question: 'Which color?',
        header: 'Color',
        options: [
          { label: 'Red', description: '' },
          { label: 'Blue', description: '' }
        ],
        multiSelect: false
      },
      {
        question: 'Which sizes?',
        header: 'Sizes',
        options: [
          { label: 'S', description: '' },
          { label: 'M', description: '' }
        ],
        multiSelect: true
      }
    ]
  }
  await writeFile(
    h.script,
    [
      ...(await readFile(BASIC, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .flatMap((line) =>
          JSON.parse(line).type === 'stream_event' && JSON.parse(line).event?.delta?.type === 'text_delta'
            ? [
                JSON.stringify({
                  type: 'control_request',
                  request_id: 'req-e2e-question',
                  request: {
                    subtype: 'can_use_tool',
                    tool_name: 'AskUserQuestion',
                    input: questionInput,
                    description: 'Ask',
                    tool_use_id: 'toolu_q'
                  }
                }),
                '#WAIT_RESPONSE req-e2e-question',
                line
              ]
            : [line]
        )
    ].join('\n') + '\n'
  )
  const lastResponse = async () => JSON.parse((await readFile(responsesFile, 'utf8')).split('\n').filter(Boolean).at(-1))

  await backToRoutines(page, 'Daily digest')
  const beforeQ1 = await runs(page).count()
  await page.click(tid('routine-run-now'))
  await waitFor(
    async () => (await runs(page).count()) === beforeQ1 + 1 && (await firstRunStatus(page)) === 'waiting',
    30_000,
    'the question run to wait'
  )
  assert(await page.locator(tid('mode-waiting')).isVisible(), 'the Routines tab waiting dot is not visible for a question')
  await openRunChat(page)
  const blueOption = `${tid('question-option')}[data-label="Blue"]`
  const sOption = `${tid('question-option')}[data-label="S"]`
  const mOption = `${tid('question-option')}[data-label="M"]`
  // Clicks an option's native input via script and reads its own checked state in the same round trip: a single-select
  // click also advances the step (unmounting the option), so a later, separate query could not find it to check any
  // more. This is exactly the state fix 1 restored: with the old preventDefault(), the browser's canceled activation
  // step reverts this back to false right after React commits it to true, so the dot/tick never showed on click.
  const clickAndChecked = (selector) =>
    page.locator(selector).evaluate((label) => {
      const input = label.querySelector('input')
      input.click()
      return input.checked
    })
  await page.locator(blueOption).waitFor({ timeout: T })
  assert(await clickAndChecked(blueOption), 'the Blue radio does not read checked right after the click') // single-select: auto-advances to "Which sizes?"
  assert(await clickAndChecked(sOption), 'the S checkbox does not read checked right after the click')
  assert(await clickAndChecked(mOption), 'the M checkbox does not read checked right after the click')
  await page.click(tid('question-send'))
  await waitFor(
    async () => (await page.locator(tid('question-card')).getAttribute('data-status')) === 'answered',
    T,
    'the question card to read answered'
  )
  await backToRoutines(page, 'Daily digest')
  await waitRunStatus(page, 'done', 'the answered run to finish')
  const answered = await lastResponse()
  assert(answered.response.response.behavior === 'allow', `the answer response was not allow: ${JSON.stringify(answered)}`)
  assert(
    JSON.stringify(answered.response.response.updatedInput.answers) ===
      JSON.stringify({ 'Which color?': 'Blue', 'Which sizes?': ['S', 'M'] }),
    `the answers sent to the CLI did not match: ${JSON.stringify(answered.response.response.updatedInput.answers)}`
  )
  await openRunChat(page)
  assert((await page.locator(tid('question-card')).getAttribute('data-status')) === 'answered', 'the read-only card does not read answered')
  assert((await page.locator(tid('question-option')).count()) === 4, "the read-only card does not show both questions' options")
  ok('a question card answered Blue + S/M sends behavior allow with the answers object')

  // Run again: Other text on both questions, Shift+Enter is a new line, Enter moves to the next one, then sends
  await backToRoutines(page, 'Daily digest')
  const beforeQEnter = await runs(page).count()
  await page.click(tid('routine-run-now'))
  await waitFor(
    async () => (await runs(page).count()) === beforeQEnter + 1 && (await firstRunStatus(page)) === 'waiting',
    30_000,
    'the Enter question run to wait'
  )
  await openRunChat(page)
  const otherInput = page.locator(tid('question-other-input'))
  await page.locator(tid('question-other')).waitFor({ timeout: T })
  await page.click(tid('question-other'))
  await otherInput.fill('Green')
  await otherInput.press('Shift+Enter')
  await otherInput.pressSequentially('Teal')
  assert((await page.locator(sOption).count()) === 0, 'Shift+Enter left the color question')
  assert(
    (await otherInput.inputValue()) === 'Green\nTeal',
    `Shift+Enter did not add a new line: ${JSON.stringify(await otherInput.inputValue())}`
  )
  await otherInput.press('Enter')
  await waitFor(async () => (await page.locator(sOption).count()) === 1, T, 'Enter to move to the sizes question')
  await page.click(tid('question-other'))
  await otherInput.fill('XL')
  await otherInput.press('Enter')
  await waitFor(
    async () => (await page.locator(tid('question-card')).getAttribute('data-status')) === 'answered',
    T,
    'Enter to send the answers'
  )
  await backToRoutines(page, 'Daily digest')
  await waitRunStatus(page, 'done', 'the Enter-answered run to finish')
  const entered = await lastResponse()
  assert(
    JSON.stringify(entered.response.response.updatedInput.answers) ===
      JSON.stringify({ 'Which color?': 'Green\nTeal', 'Which sizes?': ['XL'] }),
    `the answers sent by Enter did not match: ${JSON.stringify(entered.response.response.updatedInput.answers)}`
  )
  ok('Shift+Enter in the Other box adds a line; Enter moves to the next question, then sends the answers')

  // Run again: Skip
  await backToRoutines(page, 'Daily digest')
  const beforeQ2 = await runs(page).count()
  await page.click(tid('routine-run-now'))
  await waitFor(
    async () => (await runs(page).count()) === beforeQ2 + 1 && (await firstRunStatus(page)) === 'waiting',
    30_000,
    'the second question run to wait'
  )
  await openRunChat(page)
  await page.locator(tid('question-skip')).waitFor({ timeout: T })
  await page.click(tid('question-skip'))
  await waitFor(
    async () => (await page.locator(tid('question-card')).getAttribute('data-status')) === 'skipped',
    T,
    'the question card to read skipped'
  )
  await backToRoutines(page, 'Daily digest')
  await waitRunStatus(page, 'done', 'the skipped run to finish')
  const skipped = await lastResponse()
  assert(skipped.response.response.behavior === 'deny', `the skip response was not deny: ${JSON.stringify(skipped)}`)
  assert(
    skipped.response.response.message === 'The user chose not to answer these questions.',
    `the skip message did not match: ${skipped.response.response.message}`
  )
  ok('Skip on a question card sends behavior deny with the skip message')

  // 8. a plan card: Approve, then Keep planning with feedback
  const planInput = { plan: '# Plan\n\n- add hello.txt', planFilePath: '/tmp/e2e-plan.md' }
  await writeFile(
    h.script,
    [
      ...(await readFile(BASIC, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .flatMap((line) =>
          JSON.parse(line).type === 'stream_event' && JSON.parse(line).event?.delta?.type === 'text_delta'
            ? [
                JSON.stringify({
                  type: 'control_request',
                  request_id: 'req-e2e-plan',
                  request: {
                    subtype: 'can_use_tool',
                    tool_name: 'ExitPlanMode',
                    input: planInput,
                    description: 'Plan',
                    tool_use_id: 'toolu_p'
                  }
                }),
                '#WAIT_RESPONSE req-e2e-plan',
                line
              ]
            : [line]
        )
    ].join('\n') + '\n'
  )
  await backToRoutines(page, 'Daily digest')
  const beforeP1 = await runs(page).count()
  await page.click(tid('routine-run-now'))
  await waitFor(
    async () => (await runs(page).count()) === beforeP1 + 1 && (await firstRunStatus(page)) === 'waiting',
    30_000,
    'the plan run to wait'
  )
  assert(await page.locator(tid('mode-waiting')).isVisible(), 'the Routines tab waiting dot is not visible for a plan')
  await openRunChat(page)
  await page.locator(tid('plan-body')).waitFor({ timeout: T })
  assert((await page.locator(tid('plan-body')).innerText()).includes('add hello.txt'), 'the plan card does not show the plan text')
  await page.click(tid('plan-approve'))
  await waitFor(
    async () => (await page.locator(tid('plan-card')).getAttribute('data-status')) === 'approved',
    T,
    'the plan card to read approved'
  )
  await backToRoutines(page, 'Daily digest')
  await waitRunStatus(page, 'done', 'the approved plan run to finish')
  const approved = await lastResponse()
  assert(approved.response.response.behavior === 'allow', `the plan approval was not allow: ${JSON.stringify(approved)}`)
  assert(approved.response.response.updatedInput.plan === planInput.plan, 'the plan approval did not send the input back unchanged')
  await openRunChat(page)
  assert(!(await page.locator(tid('plan-approve')).count()), 'the approved plan card still shows its buttons')
  assert((await page.locator(tid('plan-card')).innerText()).includes('Approved'), 'the approved plan card has no Approved line')
  ok('Approve on a plan card sends behavior allow with the input unchanged')

  await backToRoutines(page, 'Daily digest')
  const beforeP2 = await runs(page).count()
  await page.click(tid('routine-run-now'))
  await waitFor(
    async () => (await runs(page).count()) === beforeP2 + 1 && (await firstRunStatus(page)) === 'waiting',
    30_000,
    'the second plan run to wait'
  )
  await openRunChat(page)
  await page.locator(tid('plan-keep')).waitFor({ timeout: T })
  await page.click(tid('plan-keep'))
  await page.fill(tid('plan-feedback-input'), 'also add bye.txt')
  await page.click(tid('plan-send'))
  await waitFor(
    async () => (await page.locator(tid('plan-card')).getAttribute('data-status')) === 'sent-back',
    T,
    'the plan card to read sent back'
  )
  await backToRoutines(page, 'Daily digest')
  await waitRunStatus(page, 'done', 'the sent-back plan run to finish')
  const sentBack = await lastResponse()
  assert(sentBack.response.response.behavior === 'deny', `the sent-back plan was not deny: ${JSON.stringify(sentBack)}`)
  assert(
    sentBack.response.response.message.includes('Feedback: also add bye.txt'),
    `the deny message lacks the feedback: ${sentBack.response.response.message}`
  )
  await openRunChat(page)
  const doneCard = await page.locator(tid('plan-card')).innerText()
  assert(
    doneCard.includes('Sent back') && (await page.locator(tid('plan-feedback')).innerText()).includes('also add bye.txt'),
    'the sent-back card does not show its status and feedback'
  )
  ok('Keep planning with feedback sends behavior deny and the card reads Sent back')

  // 9. the usage limit: wait for the reset and continue in the same chat, or skip the run
  const basicLines = (await readFile(BASIC, 'utf8')).split('\n').filter(Boolean)
  // As CLI 2.1.299 answers a 429: a rejected rate_limit_event, a synthetic reply, an error result. A reset 55 s ago
  // puts the resume 5 s out (the runner waits 60 s past a reset).
  const limitScript = (resetIn = -55) => {
    const result = JSON.parse(basicLines.at(-1))
    return (
      [
        basicLines[0],
        JSON.stringify({
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + resetIn, rateLimitType: 'five_hour' },
          uuid: 'e2e-limit',
          session_id: result.session_id
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'e2e-limit-msg',
            model: '<synthetic>',
            role: 'assistant',
            content: [{ type: 'text', text: "You've hit your session limit" }]
          },
          error: 'rate_limit',
          session_id: result.session_id
        }),
        JSON.stringify({ ...result, is_error: true, result: "You've hit your session limit" })
      ].join('\n') + '\n'
    )
  }
  await writeFile(h.script, limitScript())
  await backToRoutines(page, 'Daily digest')
  assert(!(await page.locator(tid('missed-policy')).count()), 'the missed-run setting shows for a manual routine')
  assert((await selectValue(page.locator(tid('limit-policy')))) === 'wait', 'the limit policy does not default to wait')
  const beforeL1 = await runs(page).count()
  await page.click(tid('routine-run-now'))
  await waitFor(
    async () => (await runs(page).count()) === beforeL1 + 1 && (await firstRunStatus(page)) === 'limited',
    30_000,
    'the run to wait for the limit'
  )
  assert(
    (await page.locator(tid('run-policy')).first().innerText()).startsWith('Usage limit reached · continues today at'),
    'the waiting run does not say when it continues'
  )
  assert(!(await page.locator(tid('mode-waiting')).isVisible()), 'a limit wait lights the approval dot')
  await copyFile(BASIC, h.script) // the reset came: the next turn is answered
  await waitRunStatus(page, 'done', 'the continued run to finish')
  assert(
    (await page.locator(tid('run-policy')).first().innerText()) === 'Continued after a usage limit reset',
    'the finished run does not say it continued after a reset'
  )
  await openRunChat(page)
  const bubbles = await userBubbles(page)
  assert(bubbles.length === 2 && bubbles[1] === 'continue', `the run did not continue in the same chat: ${JSON.stringify(bubbles)}`)
  ok('a run stopped by the usage limit waits for the reset and continues in the same chat')

  await writeFile(h.script, limitScript())
  await backToRoutines(page, 'Daily digest')
  await pickOption(page.locator(tid('limit-policy')), 'skip')
  await page.click(tid('routine-save'))
  await waitFor(
    async () => (await readJson('routines.json')).some((r) => r.name === 'Daily digest' && r.limitPolicy === 'skip'),
    T,
    'the skip policy to be stored'
  )
  const beforeL2 = await runs(page).count()
  await page.click(tid('routine-run-now'))
  await waitFor(
    async () => (await runs(page).count()) === beforeL2 + 1 && (await firstRunStatus(page)) === 'skipped',
    30_000,
    'the limited run to be skipped'
  )
  assert(
    (await page.locator(tid('run-policy')).first().innerText()) === 'Skipped: the usage limit was reached',
    'the skipped run does not say why'
  )
  await copyFile(BASIC, h.script)
  // The chat's own wait leaves a routine's turn to the routine: a skipped run is never continued past the 5 s resume.
  const skippedChat = Object.values(await readJson('routine-runs.json'))
    .flat()
    .sort((a, b) => b.startedAt - a.startedAt)[0]
  assert(skippedChat?.status === 'skipped' && skippedChat.chatId, `the newest run is not the skipped one: ${JSON.stringify(skippedChat)}`)
  await sleep(7_000)
  assert(!(await chatMeta(skippedChat.chatId)).resume, "the skipped run's chat holds a usage limit wait")
  assert(
    (await userItems(skippedChat.chatId)).length === 1,
    `the skipped run's chat continued by itself: ${JSON.stringify(await userItems(skippedChat.chatId))}`
  )
  ok('with Skip the run stopped by the usage limit is skipped, and its chat does not continue by itself')

  // 9b. a chat the user started: the limit shows when it continues, it continues by itself, and Don't continue stops it
  const plain = (await rpc(page, 'chats:create', AGENT, pickDir)).id
  await page.goto(`${h.origin}/chat/${encodeURIComponent(plain)}`)
  await page.locator(tid('message-list')).waitFor({ timeout: T })
  await writeFile(h.script, limitScript())
  await rpc(page, 'chats:send', plain, 'Check the whole design', [])
  const notice = page.locator(tid('limit-notice')).last()
  await waitFor(
    async () => (await notice.count()) === 1 && (await notice.getAttribute('data-state')) === 'waiting',
    T,
    'the limit notice to say the chat continues'
  )
  assert(
    (await notice.innerText()).startsWith('Usage limit reached · continues today at'),
    `the notice does not say when it continues: ${await notice.innerText()}`
  )
  assert(!(await page.locator(tid('error-bubble')).count()), 'the limit still shows as a red error')
  assert((await chatMeta(plain)).resume?.waits === 1, 'the wait is not stored on the chat')
  await copyFile(BASIC, h.script) // the reset came: the continue is answered
  await waitFor(
    async () => JSON.stringify(await userBubbles(page)) === JSON.stringify(['Check the whole design', 'continue']),
    30_000,
    'the chat to continue by itself'
  )
  await waitFor(
    async () => !(await chatMeta(plain)).inFlight && (await notice.getAttribute('data-state')) === 'stopped',
    T,
    'the continued reply to end and the notice to stop waiting'
  )
  assert(!(await chatMeta(plain)).resume, 'the wait stays stored after the continue')
  ok('a chat the usage limit stopped says when it continues, and continues by itself at the reset')

  await writeFile(h.script, limitScript(120)) // a reset 2 minutes out: nothing continues while this step looks
  await rpc(page, 'chats:send', plain, 'And the dark theme', [])
  const secondNotice = page.locator(tid('limit-notice')).last()
  await waitFor(
    async () => (await page.locator(tid('limit-notice')).count()) === 2 && (await secondNotice.getAttribute('data-state')) === 'waiting',
    T,
    'the second limit notice to wait'
  )
  await page.locator(tid('limit-cancel')).click()
  await waitFor(async () => (await secondNotice.getAttribute('data-state')) === 'stopped', T, "Don't continue to end the wait")
  assert(
    (await secondNotice.innerText()).startsWith('Usage limit reached · resets'),
    `the stopped notice does not say when the limit resets: ${await secondNotice.innerText()}`
  )
  assert(!(await chatMeta(plain)).resume, "Don't continue left the wait stored")
  await copyFile(BASIC, h.script)
  ok("Don't continue ends the wait, and the notice then says when the limit resets")

  // 9c. messages queued behind a turn the limit stops wait for its continue; Continue now sends it ahead of them
  await writeFile(h.script, `#SLEEP 2500\n${limitScript(120)}`) // still limited when the queued ones could go
  const slow = rpc(page, 'chats:send', plain, 'Slow work', [])
  await waitFor(async () => (await chatMeta(plain))?.inFlight === true, T, 'the slow reply to start')
  for (const text of ['Task one', 'Task two']) {
    const got = await rpc(page, 'chats:send', plain, text, [])
    assert(got === 'queued', `a message sent while the reply runs did not queue: ${got}`)
  }
  await slow
  const thirdNotice = page.locator(tid('limit-notice')).last()
  await waitFor(
    async () => (await page.locator(tid('limit-notice')).count()) === 3 && (await thirdNotice.getAttribute('data-state')) === 'waiting',
    T,
    'the third limit notice to wait'
  )
  await sleep(1_500) // a pump that sends the next task would have done so by now
  const held = await chatMeta(plain)
  assert(
    held.resume && !held.inFlight && !held.held && held.tasks?.map((t) => t.text).join('|') === 'Task one|Task two',
    `the queued messages did not wait for the limit: ${JSON.stringify(held)}`
  )
  assert(
    (await userItems(plain)).at(-1) === 'Slow work',
    `a queued message went in past the limit: ${JSON.stringify(await userItems(plain))}`
  )
  assert((await page.locator(tid('limit-continue')).count()) === 1, 'Continue now does not show on the waiting notice alone')
  await copyFile(BASIC, h.script) // the limit is over: the continue and the queued messages are answered
  await page.locator(tid('limit-continue')).click()
  const order = JSON.stringify(['Slow work', 'continue', 'Task one', 'Task two'])
  await waitFor(
    async () => {
      const meta = await chatMeta(plain)
      return JSON.stringify((await userItems(plain)).slice(-4)) === order && !meta.inFlight && !meta.tasks?.length
    },
    30_000,
    'the continue to go first, then the queued messages'
  )
  assert(!(await chatMeta(plain)).resume, 'Continue now left the wait stored')
  ok('queued messages wait while the usage limit holds the chat; Continue now sends the continue ahead of them, then they go')
  await backToRoutines(page, 'Daily digest')

  await pickOption(page.locator(tid('trigger-kind')), 'schedule')
  assert((await selectValue(page.locator(tid('missed-policy')))) === 'run-once', 'the missed-run setting does not default to run once')
  ok('the missed-run setting shows for a schedule trigger')

  // 10. an existing chat: continue resumes the agent's session, Start fresh each run seeds a new one and says so
  const lastArgs = async () => JSON.parse((await readFile(invocations, 'utf8')).trim().split('\n').at(-1)).args
  const target = (await readJson('chats.json')).chats.find((c) => c.title?.startsWith('Daily digest · ') && c.sessionId)
  assert(target, 'no Daily digest chat with a session to target')
  // Step 9 left Daily digest switched to a schedule, unsaved: leave it as saved.
  await page.click(tid('mode-tab-routines'))
  await page.click(tid('new-routine'))
  await page.getByRole('button', { name: 'Discard', exact: true }).click()
  await page.locator(tid('routine-name')).waitFor({ timeout: T })
  await page.fill(tid('routine-name'), 'Same chat check')
  await pickOption(page.locator(tid('trigger-kind')), 'manual')
  await pickOption(page.locator(tid('target-agent')), AGENT)
  assert(!(await page.locator(tid('session-policy')).count()), 'the session setting shows for a new chat every run')
  await pickOption(page.locator(tid('target-chat')), target.id)
  assert((await selectValue(page.locator(tid('session-policy')))) === 'continue', 'the session setting does not default to continue')
  await page.locator(tid('routine-prompt-input')).click()
  await page.keyboard.type('Check again')
  await save(page)
  await page.click(tid('routine-run-now'))
  await waitRunStatus(page, 'done', 'the continuing run to be done')
  let args = await lastArgs()
  assert(
    args[args.indexOf('--resume') + 1] === target.sessionId,
    `a continuing run did not resume the chat's session: ${JSON.stringify(args)}`
  )
  await pickOption(page.locator(tid('session-policy')), 'fresh')
  await page.click(tid('routine-save'))
  await waitFor(
    async () => (await readJson('routines.json')).some((r) => r.name === 'Same chat check' && r.sessionPolicy === 'fresh'),
    T,
    'the fresh policy to be stored'
  )
  const beforeF = await runs(page).count()
  await page.click(tid('routine-run-now'))
  await waitFor(
    async () => (await runs(page).count()) === beforeF + 1 && (await firstRunStatus(page)) === 'done',
    30_000,
    'the fresh run to be done'
  )
  args = await lastArgs()
  assert(!args.includes('--resume'), `a fresh run resumed a session: ${JSON.stringify(args)}`)
  await openRunChat(page)
  await waitFor(
    async () => (await page.getByText('This routine starts fresh each run', { exact: false }).count()) === 1,
    T,
    'the fresh-start divider'
  )
  ok('an existing-chat routine resumes the session by default, and Start fresh each run seeds a new one with its own divider')

  // 11. the ⋯ menu, as the workflow editor's: Discard changes puts the saved routine back; Save and duplicate saves the
  // edit, then opens an off "(2)" copy with the same settings and no runs; Duplicate of a clean routine takes the next number.
  await page.click(tid('mode-tab-routines'))
  await page.locator(tid('routine-row'), { hasText: 'Same chat check' }).first().click()
  await page.locator(tid('routine-editor')).waitFor({ timeout: T })
  const sourceId = (await readJson('routines.json')).find((r) => r.name === 'Same chat check').id
  await waitFor(async () => path() === `/routines/${sourceId}`, T, 'the routine to open')
  await page.click(tid('routine-more'))
  assert(await page.locator(tid('routine-discard')).isDisabled(), 'Discard changes is on with nothing to discard')
  assert((await page.locator(tid('routine-duplicate')).textContent()) === 'Duplicate', 'a clean routine offers "Save and duplicate"')
  await page.click(tid('routine-more'))
  await page.fill(tid('routine-name'), 'Scratch name')
  await page.click(tid('routine-more'))
  await page.click(tid('routine-discard'))
  assert((await page.locator(tid('routine-name')).inputValue()) === 'Same chat check', 'Discard changes did not put the saved name back')
  await page.fill(tid('routine-name'), 'Copied check')
  await page.click(tid('routine-more'))
  assert(
    (await page.locator(tid('routine-duplicate')).textContent()) === 'Save and duplicate',
    'Duplicate does not say it saves the edits first'
  )
  await page.click(tid('routine-duplicate'))
  await waitFor(async () => /^\/routines\/[^/]+$/.test(path()) && path() !== `/routines/${sourceId}`, T, "the copy's address")
  const copyId = path().split('/').pop()
  await waitFor(async () => (await page.locator(tid('routine-name')).inputValue()) === 'Copied check (2)', T, "the copy's editor")
  assert((await page.locator(tid('routine-placeholder')).count()) === 0, 'the copy reads as missing')
  assert((await page.locator(tid('routine-enabled')).getAttribute('aria-checked')) === 'false', 'the copy opened on')
  await page.locator(tid('routine-row'), { hasText: 'Copied check (2)' }).first().waitFor({ timeout: T })
  const stored = await readJson('routines.json')
  const src = stored.find((r) => r.id === sourceId)
  const dup = stored.find((r) => r.id === copyId)
  assert(src.name === 'Copied check', `the source is named ${JSON.stringify(src.name)}`)
  assert(
    dup &&
      !dup.enabled &&
      dup.nextRunAt === null &&
      dup.prompt === src.prompt &&
      dup.sessionPolicy === 'fresh' &&
      JSON.stringify(dup.target) === JSON.stringify(src.target) &&
      JSON.stringify(dup.trigger) === JSON.stringify(src.trigger),
    "the copy is not an off copy of the source's settings"
  )
  const storedRuns = await readJson('routine-runs.json')
  assert((storedRuns[sourceId] ?? []).length > 0 && (storedRuns[copyId] ?? []).length === 0, 'the runs were copied or lost')
  await page.click(tid('routine-more'))
  assert((await page.locator(tid('routine-duplicate')).textContent()) === 'Duplicate', 'a clean copy offers "Save and duplicate"')
  await page.click(tid('routine-duplicate'))
  await waitFor(async () => (await page.locator(tid('routine-name')).inputValue()) === 'Copied check (3)', T, 'the copy of the copy')
  assert(path() !== `/routines/${copyId}`, 'the copy of the copy did not open')
  ok(
    'Discard changes put the saved routine back; Save and duplicate saved the edit and opened an off "(2)" copy with no runs; Duplicate of it made "(3)"'
  )

  // 12. a new room's own title and sidebar section: a single chat has no section to pick, a room lists the user's
  // sections, and each run's room carries the title and lands first in that section, on the page too.
  await rpc(page, 'sidebar:save', { sections: [{ id: 'sec-e2e', name: 'Reports', collapsed: false, items: [] }], unassigned: [] })
  await newRoutine(page)
  await page.fill(tid('routine-name'), 'Standup room')
  await pickOption(page.locator(tid('trigger-kind')), 'manual')
  await page.locator(tid('target-title')).waitFor({ timeout: T })
  assert((await page.locator(tid('target-section')).count()) === 0, 'a new single chat offers a section')
  await page.click(tid('target-kind-group'))
  await page.click(tid('target-members'))
  const member = (n) => page.locator(`${tid('target-member-option')}[data-agent-name="${n}"]`)
  await member(AGENT).click()
  await member(HELPER).click()
  await page.click(tid('routine-name')) // a mousedown outside closes the members menu
  await page.click(tid('target-folder'))
  await waitFor(async () => (await page.locator(tid('target-folder')).getAttribute('data-tip')) === pickDir, T, 'the room folder to be set')
  await page.locator(tid('target-section')).click()
  const sectionOptions = await page
    .locator('.search-select-menu [data-testid="select-option"]')
    .evaluateAll((els) => els.map((e) => `${e.dataset.value}=${e.textContent}`))
  await page.keyboard.press('Escape')
  assert(sectionOptions.join(',') === '=Outside sections,sec-e2e=Reports', `the section options are ${sectionOptions.join(',')}`)
  assert((await selectValue(page.locator(tid('target-section')))) === '', 'a new room does not start outside the sections')
  await page.fill(tid('target-title'), '  Morning standup ')
  await pickOption(page.locator(tid('target-section')), 'sec-e2e')
  await page.locator(tid('routine-prompt-input')).click()
  await page.keyboard.type(`@${AGENT} Summarise the standup`)
  await save(page)
  const standup = (await readJson('routines.json')).find((r) => r.name === 'Standup room')
  assert(
    standup?.target.title === 'Morning standup' && standup.target.section === 'sec-e2e',
    `the room target saved as ${JSON.stringify(standup?.target)}`
  )
  await page.click(tid('routine-run-now'))
  let roomId = null
  await waitFor(
    async () => (roomId = (await readJson('routine-runs.json'))[standup.id]?.[0]?.chatId ?? null) !== null,
    30_000,
    'the room run to make its room'
  )
  await waitFor(async () => (await chatMeta(roomId))?.title === 'Morning standup', T, "the room to carry the routine's title")
  await waitFor(
    async () => (await readJson('sidebar.json')).sections[0]?.items[0] === `group:${roomId}`,
    T,
    'the room to land first in Reports'
  )
  await page.click(tid('mode-tab-agents'))
  const reports = page.locator(tid('user-section')).filter({ hasText: 'Reports' })
  await reports.locator(`${tid('group-row')}[data-chat-id="${roomId}"]`).waitFor({ timeout: T })
  assert(
    (await reports.locator(`${tid('group-row')}[data-chat-id="${roomId}"]`).textContent())?.includes('Morning standup'),
    'the room row lacks its title'
  )
  ok('a room routine names its room and places it first in the chosen section; a single chat offers no section')

  // 13. History: each save that changed the routine is kept; Restore over unsaved edits asks first, fills the form, and
  // its Save is kept as a restored version.
  await page.click(tid('mode-tab-routines'))
  await page.locator(tid('routine-row'), { hasText: 'Standup room' }).first().click()
  await page.locator(tid('routine-editor')).waitFor({ timeout: T })
  await waitFor(async () => path() === `/routines/${standup.id}`, T, 'the room routine to open')
  assert(await page.locator(tid('routine-save')).isDisabled(), 'Save is on for a saved routine with no edits')
  await page.fill(tid('routine-name'), 'Standup room v2')
  assert(await page.locator(tid('routine-save')).isEnabled(), 'Save stayed off after an edit')
  await page.click(tid('routine-save'))
  await waitFor(
    async () => (await readJson('routines.json')).find((r) => r.id === standup.id)?.name === 'Standup room v2',
    T,
    'the rename to be saved'
  )
  // The save's answer resets the form, so the next edit waits for it (the button reads Save again).
  await waitFor(async () => (await page.locator(tid('routine-save')).textContent()) === 'Save', T, 'the save to finish')
  await page.fill(tid('routine-name'), 'Scratch')
  await page.click(tid('routine-more'))
  await page.click(tid('routine-history'))
  const hrows = page.locator(tid('history-row'))
  await waitFor(async () => (await hrows.count()) === 2, T, 'two versions in History')
  assert((await hrows.first().getAttribute('data-current')) === 'true', 'the newest routine version is not current')
  await hrows.last().locator(tid('history-restore')).click()
  await page.getByRole('dialog', { name: 'Replace your unsaved changes?' }).waitFor({ timeout: T })
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await waitFor(async () => (await page.locator(tid('routine-name')).inputValue()) === 'Standup room', T, 'the restored name in the form')
  await page.locator(tid('routine-restore-note')).waitFor({ timeout: T })
  assert((await readJson('routines.json')).find((r) => r.id === standup.id).name === 'Standup room v2', 'Restore wrote before Save')
  await page.click(tid('routine-save'))
  await waitFor(
    async () => (await readJson('routines.json')).find((r) => r.id === standup.id)?.name === 'Standup room',
    T,
    'the restored version to be saved'
  )
  const kept = await rpc(page, 'routines:history', standup.id)
  assert(
    kept.length === 3 && kept[0].source === 'restore' && kept[0].current && kept[0].restoredFrom === kept[2].savedAt,
    `routine History is ${JSON.stringify(kept.map((v) => [v.source, v.current]))}`
  )
  assert((await page.locator(tid('routine-restore-note')).count()) === 0, 'the restore note stayed after the save')
  ok(
    'routine History kept both saves; Restore over unsaved edits asked first and filled the form, and its Save was kept as a restored, current version'
  )

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
console.log(failed ? 'e2e:routines FAILED' : 'e2e:routines passed')
process.exit(failed ? 1 : 0)
