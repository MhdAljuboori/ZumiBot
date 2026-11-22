// End-to-end check of "Allow a refused call and continue" in the built server + web UI (local mode), against a FAKE claude
// (backend/tests/fixtures/fake-allow-claude.mjs) whose first turn runs a Bash call the auto-mode classifier refuses and whose
// resumed turns record their argv and reply "ok". No real CLI turn is sent, so no login or quota is used.
// Usage: npm run e2e:allow   (builds first). SCREENSHOT_DIR=<dir> also saves the card at desktop and phone width.
//
// Checks: the refusal shows an inline Allow card in the chat flow (the run stays folded); the card's defaults submit; the
// continue message and the reply appear; the resumed run's merged --settings allows the rule; the card then reads allowed.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), new-chat, new-chat-folder, new-chat-choose-folder,
//   composer-input, send-button, agent-message, allow-card (+ data-status), allow-blocked-part (+ data-part),
//   allow-blocked-scope (+ data-scope), allow-blocked-submit, allow-blocked-error, allowed-as.

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const AGENT = 'e2e-allow-agent'
const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE = join(HERE, '..', 'backend', 'tests', 'fixtures', 'fake-allow-claude.mjs')
const RULE = 'Bash(git branch -D:*)'
const CONTINUE = `I allowed \`${RULE}\` for this chat. Continue.`
const T = 20_000

let h = null
let work = null
const t0 = Date.now()
const pass = (m) => console.log(`PASS ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const tid = (id) => `[data-testid="${id}"]`

async function main() {
  work = await mkdtemp(join(tmpdir(), 'zumibot-e2e-allow-'))
  const argvFile = join(work, '.argv.jsonl')
  h = await start({ mode: 'local', fake: FAKE, env: { ZUMIBOT_TEST_PICK_FOLDER: work, FAKE_ARGV_FILE: argvFile } })
  await writeFile(
    join(h.agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Allow a refused call e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  const page = h.page
  await page.reload()
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  await page.locator(tid('composer-input')).fill('delete the old branch')
  await page.locator(tid('send-button')).click()

  // 1. the refused call shows an inline card right after the first reply, with the tool run still folded
  const card = page.locator(`${tid('allow-card')}[data-status="pending"]`)
  await card.waitFor({ timeout: T })
  assert((await page.locator('.tool-run-head[aria-expanded="true"]').count()) === 0, 'the tool run stays folded')
  assert((await page.locator('.attempt-scrim').count()) === 0, 'no popup dialog is open')
  pass('an inline Allow card is pending after the first message, without opening the run')

  // 2. the card lists the command's parts; the defaults are the safe part unticked, the git part ticked, scope This chat
  const parts = card.locator(tid('allow-blocked-part'))
  assert((await parts.count()) === 2, `two parts listed (${await parts.count()})`)
  assert((await parts.nth(0).getAttribute('data-part')) === 'cd /tmp', 'the first part is cd /tmp')
  assert((await parts.nth(1).getAttribute('data-part')) === 'git branch -D old-branch', 'the second part is the git command')
  assert(!(await parts.nth(0).locator('input[type=checkbox]').isChecked()), 'cd /tmp starts unticked')
  assert(await parts.nth(1).locator('input[type=checkbox]').isChecked(), 'the git part starts ticked')
  assert((await parts.nth(1).locator('input.allow-prefix').inputValue()) === 'git branch -D', 'its prefix is git branch -D')
  assert(await card.locator(`${tid('allow-blocked-scope')}[data-scope="chat"]`).isChecked(), 'the default scope is This chat')
  if (process.env.SCREENSHOT_DIR) {
    const dir = process.env.SCREENSHOT_DIR
    await mkdir(dir, { recursive: true })
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(dir, 'allow-card-desktop.png') })
    const size = page.viewportSize()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(400)
    // On a phone the sidebar is a drawer: close it if the width change left it out.
    const drawer = page.locator(tid('nav-backdrop'))
    if ((await drawer.count()) > 0) await drawer.first().click().catch(() => {})
    await card.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(dir, 'allow-card-phone.png') })
    if (size) await page.setViewportSize(size)
  }
  await card.locator(tid('allow-blocked-submit')).click()
  pass('the card has the safe part unticked, the git part ticked and scope This chat; submitted')

  // 3. the continue message is sent as the user's, and the agent's resumed turn replies ok
  // The bubble renders markdown, so the backticks around the rule show as code, not as characters.
  await page.locator('.bubble.user', { hasText: CONTINUE.replaceAll('`', '') }).last().waitFor({ timeout: T })
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="agent-message"]')].some((e) => e.textContent.trim() === 'ok'),
    null,
    { timeout: 30_000 }
  )
  pass('the continue message appears as a user message and the reply ok arrives')

  // 4. the resumed turn's merged --settings allows the rule
  const runs = (await readFile(argvFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert(runs.length === 1, `one resumed run recorded (${runs.length})`)
  const argv = runs[0]
  const allowed = argv.flatMap((a, i) => {
    if (a !== '--settings') return []
    try {
      return JSON.parse(argv[i + 1]).permissions?.allow ?? []
    } catch {
      return [] // a settings piece that is a file path holds no inline rules
    }
  })
  assert(allowed.includes(RULE), `--settings allows ${RULE} (${JSON.stringify(allowed)})`)
  pass('the resumed run got --settings with the allow rule')

  // 5. the card itself says it was allowed (no need to open the run), and the button is gone
  await page.locator(`${tid('allow-card')}[data-status="done"]`).waitFor({ timeout: T })
  assert((await page.locator(tid('allowed-as')).first().textContent()) === 'Allowed for this chat', 'the card says Allowed for this chat')
  assert((await page.locator(tid('allow-blocked-submit')).count()) === 0, 'no Allow button once allowed')
  assert((await page.locator('.tool-run-head[aria-expanded="true"]').count()) === 0, 'the run was never opened')
  pass('the card reads Allowed for this chat without opening the run')

  const bad = unexpectedErrors(h.errors, [])
  assert(bad.length === 0, `unexpected console/server errors: ${bad.join(' | ')}`)
}

const overall = setTimeout(() => {
  console.error('FAIL e2e:allow overall timeout')
  process.exit(1)
}, 3 * 60_000)
overall.unref()
let failed = false
try {
  await main()
} catch (err) {
  failed = true
  console.error(`FAIL ${err instanceof Error ? err.stack : err}`)
  if (process.env.E2E_DEBUG) console.error(await h?.page.locator('body').innerText().catch(() => ''), h?.errors)
} finally {
  await h?.stop().catch(() => {})
  if (work) await rm(work, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
