// End-to-end check of "Allow a refused call and continue" in the built server + web UI (local mode), against a FAKE claude
// (backend/tests/fixtures/fake-allow-claude.mjs) whose first turn runs a Bash call the auto-mode classifier refuses and whose
// resumed turns record their argv and reply "ok". No real CLI turn is sent, so no login or quota is used.
// Usage: npm run e2e:allow   (builds first). SCREENSHOT_DIR=<dir> also saves the card at desktop and phone width.
//
// Checks: the refusal shows an inline Allow card in the chat flow (the run stays folded); the card's defaults submit; the
// continue message and the reply appear; the resumed run's merged --settings allows the rule; the card then reads allowed.
// Then the folder case: Agent Studio's Add stores `Bash(gh pr merge:*)` for the agent; a refused `cd <outside folder> && gh pr
// merge …` shows the gh part already allowed and the folder as a ticked folder row (not the dead "still refused" card); its
// Allow sends `Read(//<folder>/**)`, and the resumed run gets both rules. Last, a refused `python3` heredoc followed by the
// held `gh pr merge` names the python part as what no rule can allow, with no Allow button. Then git after a cd: a refused
// `cd <outside folder> && git push origin --delete old` offers the git part as `git -C <folder> push …` with its note, Allow sends
// that rule and tells the agent to use git -C, and the resumed run gets it; the same command refused in a new chat, with the rule
// now held, is the stuck card (`allow-git-again`) whose **Ask to use git -C** sends the advice alone.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), new-chat, new-chat-folder, new-chat-choose-folder,
//   composer-input, send-button, agent-message, allow-card (+ data-status), allow-blocked-part (+ data-part),
//   allow-blocked-scope (+ data-scope), allow-blocked-submit, allow-blocked-error, allowed-as, allow-unallowable,
//   allow-unallowable-part (+ data-part), allow-git-note, allow-git-again, allow-git-retry, agent-menu-button,
//   agent-menu-edit, rule-add-kind (+ data-kind), rule-add-value, rule-add, rule-remove (+ aria-label).

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
let outside = null
const t0 = Date.now()
const pass = (m) => console.log(`PASS ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const tid = (id) => `[data-testid="${id}"]`

async function main() {
  work = await mkdtemp(join(tmpdir(), 'zumibot-e2e-allow-'))
  outside = await mkdtemp(join(tmpdir(), 'zumibot-e2e-outside-'))
  const argvFile = join(work, '.argv.jsonl')
  h = await start({ mode: 'local', fake: FAKE, env: { ZUMIBOT_TEST_PICK_FOLDER: work, FAKE_ARGV_FILE: argvFile, FAKE_OUTSIDE: outside } })
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

  // 6. Agent Studio's Add stores a prefix rule for the agent
  const row = page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`)
  await row.hover()
  await page.locator('nav.agent-list .agent-block').filter({ has: row }).locator(tid('agent-menu-button')).click()
  await page.locator(tid('agent-menu-edit')).click()
  const studio = page.locator('section.remembered')
  await studio.waitFor({ timeout: T })
  await studio.locator(`${tid('rule-add-kind')}[data-kind="folder"]`).check()
  await studio.locator(tid('rule-add-value')).fill('/etc')
  await studio.locator('.field-error', { hasText: 'narrower' }).waitFor({ timeout: T })
  assert(await studio.locator(tid('rule-add')).isDisabled(), 'Add is disabled for a folder that holds too much')
  await studio.locator(`${tid('rule-add-kind')}[data-kind="prefix"]`).check()
  await studio.locator(tid('rule-add-value')).fill('gh pr merge')
  await studio.locator('code', { hasText: 'Bash(gh pr merge:*)' }).waitFor({ timeout: T })
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'studio-add-rule.png') })
  await studio.locator(tid('rule-add')).click()
  await studio.locator('.remembered-label', { hasText: 'Bash: commands starting with gh pr merge' }).waitFor({ timeout: T })
  assert((await studio.locator(tid('rule-add-value')).inputValue()) === '', 'the field empties after Add')
  pass("Agent Studio's Add refuses /etc and stores Bash(gh pr merge:*) for the agent")

  // 7. a refused cd into a folder outside the chat's: the gh part is held, the folder is a ticked folder row
  await row.click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  await page.locator(tid('composer-input')).fill('merge the pr')
  await page.locator(tid('send-button')).click()
  const card2 = page.locator(`${tid('allow-card')}[data-status="pending"]`)
  await card2.waitFor({ timeout: T })
  const parts2 = card2.locator(tid('allow-blocked-part'))
  assert((await parts2.count()) === 2, `two parts listed (${await parts2.count()})`)
  assert((await parts2.nth(0).getAttribute('data-folder')) === outside, `the cd is a folder row for ${outside}`)
  assert(await parts2.nth(0).locator('input[type=checkbox]').isChecked(), 'the folder row starts ticked')
  assert((await parts2.nth(1).locator('.allow-part-held').count()) === 1, 'the gh part reads already allowed')
  const folderRule = `Read(/${outside}/**)`
  await card2.locator('.allow-rules code', { hasText: folderRule }).waitFor({ timeout: T })
  if (process.env.SCREENSHOT_DIR) {
    await card2.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'allow-card-folder.png') })
  }
  await card2.locator(`${tid('allow-blocked-scope')}[data-scope="agent"]`).check()
  await card2.locator(tid('allow-blocked-submit')).click()
  await page.locator('.bubble.user', { hasText: `I allowed ${folderRule} for` }).last().waitFor({ timeout: T })
  await page.locator(`${tid('allow-card')}[data-status="done"]`).last().waitFor({ timeout: T })
  pass('the folder row is offered ticked next to the held gh part, and Allow sends the Read rule')

  // 8. the resumed run gets the agent's prefix rule and the folder rule
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="agent-message"]')].filter((e) => e.textContent.trim() === 'ok').length > 0,
    null,
    { timeout: 30_000 }
  )
  const runs2 = (await readFile(argvFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert(runs2.length === 2, `two resumed runs recorded (${runs2.length})`)
  const argv2 = runs2[1]
  const allowed2 = argv2.flatMap((a, i) => {
    if (a !== '--settings') return []
    try {
      return JSON.parse(argv2[i + 1]).permissions?.allow ?? []
    } catch {
      return []
    }
  })
  assert(allowed2.includes('Bash(gh pr merge:*)') && allowed2.includes(folderRule), `--settings allows both (${JSON.stringify(allowed2)})`)
  pass('the resumed run got the prefix rule and the folder rule')

  // 9. a refused python3 heredoc next to the held gh part: the card names the python part, not the held rule, and has no button
  await row.click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  await page.locator(tid('composer-input')).fill('write the heredoc file')
  await page.locator(tid('send-button')).click()
  const card3 = page.locator(`${tid('allow-card')}[data-status="pending"]`)
  await card3.waitFor({ timeout: T })
  await card3.locator(tid('allow-unallowable')).waitFor({ timeout: T })
  const blockers = card3.locator(tid('allow-unallowable-part'))
  assert((await blockers.count()) === 1, `one part no rule can allow (${await blockers.count()})`)
  assert(
    (await blockers.first().getAttribute('data-part')) === "python3 - <<'EOF' > /tmp/body.json",
    `the python part is named (${await blockers.first().getAttribute('data-part')})`
  )
  await card3.locator('.allow-rules code', { hasText: 'Bash(gh pr merge:*)' }).waitFor({ timeout: T })
  assert((await card3.locator(tid('allow-blocked-submit')).count()) === 0, 'no Allow button: no rule would help')
  if (process.env.SCREENSHOT_DIR) {
    const dir = process.env.SCREENSHOT_DIR
    await card3.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(dir, 'allow-card-unallowable.png') })
    await page.emulateMedia({ colorScheme: 'dark' }) // the app's theme follows the system by default
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(dir, 'allow-card-unallowable-dark.png') })
    await page.emulateMedia({ colorScheme: 'light' })
    const size = page.viewportSize()
    await page.setViewportSize({ width: 390, height: 844 })
    await page.waitForTimeout(400)
    const drawer = page.locator(tid('nav-backdrop'))
    if ((await drawer.count()) > 0) await drawer.first().click().catch(() => {})
    await card3.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(dir, 'allow-card-unallowable-phone.png') })
    if (size) await page.setViewportSize(size)
  }
  pass('a python heredoc next to a held part: the card names the python part as the blocker, with no Allow button')

  // 10. git after a cd into another folder: the card offers the git -C form and tells the agent to use it
  const newChat = async (text) => {
    await row.click()
    await page.locator(tid('new-chat')).waitFor({ timeout: T })
    await page.locator(tid('new-chat-folder')).click()
    await page.locator(tid('new-chat-choose-folder')).click()
    await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
      timeout: 5_000
    })
    await page.locator(tid('composer-input')).fill(text)
    await page.locator(tid('send-button')).click()
  }
  const okReplies = () =>
    page.evaluate(() => [...document.querySelectorAll('[data-testid="agent-message"]')].filter((e) => e.textContent.trim() === 'ok').length)
  const settingsAllow = (argvN) =>
    argvN.flatMap((a, i) => {
      if (a !== '--settings') return []
      try {
        return JSON.parse(argvN[i + 1]).permissions?.allow ?? []
      } catch {
        return []
      }
    })
  const gitCPart = `git -C ${outside} push origin --delete old`
  const gitCRule = `Bash(git -C ${outside} push origin --delete:*)`
  const advice = `Run git there as git -C ${outside} …, not after cd ${outside}`
  await newChat('delete the remote branch there')
  const card4 = page.locator(`${tid('allow-card')}[data-status="pending"]`)
  await card4.waitFor({ timeout: T })
  await card4.locator(tid('allow-git-note')).waitFor({ timeout: T })
  const parts4 = card4.locator(tid('allow-blocked-part'))
  assert((await parts4.count()) === 2, `two parts listed (${await parts4.count()})`)
  assert((await parts4.nth(1).getAttribute('data-part')) === gitCPart, `the git part is in its git -C form (${await parts4.nth(1).getAttribute('data-part')})`)
  assert(
    (await parts4.nth(1).locator('input.allow-prefix').inputValue()) === `git -C ${outside} push origin --delete`,
    'its prefix is the git -C form'
  )
  await card4.locator('.allow-rules code', { hasText: gitCRule }).waitFor({ timeout: T })
  if (process.env.SCREENSHOT_DIR) {
    await card4.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'allow-card-git-c.png') })
  }
  await card4.locator(`${tid('allow-blocked-scope')}[data-scope="agent"]`).check()
  await card4.locator(tid('allow-blocked-submit')).click()
  await page.locator('.bubble.user', { hasText: advice }).last().waitFor({ timeout: T })
  await page.waitForFunction(
    () => [...document.querySelectorAll('[data-testid="agent-message"]')].some((e) => e.textContent.trim() === 'ok'),
    null,
    { timeout: 30_000 }
  )
  const runs4 = (await readFile(argvFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert(runs4.length === 3, `three resumed runs recorded (${runs4.length})`)
  assert(settingsAllow(runs4[2]).includes(gitCRule), `--settings allows ${gitCRule} (${JSON.stringify(settingsAllow(runs4[2]))})`)
  pass('git after a cd: the card offers the git -C rule, Allow tells the agent to use git -C, and the resumed run gets the rule')

  // 11. the same refused again with the git -C rule held: the stuck card asks the agent to use git -C, storing nothing
  await newChat('delete the remote branch there')
  const card5 = page.locator(`${tid('allow-card')}[data-status="pending"]`)
  await card5.waitFor({ timeout: T })
  await card5.locator(tid('allow-git-again')).waitFor({ timeout: T })
  assert((await card5.locator(tid('allow-blocked-submit')).count()) === 0, 'no Allow button: the rules are held')
  await card5.locator('.allow-rules code', { hasText: gitCRule }).waitFor({ timeout: T })
  if (process.env.SCREENSHOT_DIR) {
    await card5.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(process.env.SCREENSHOT_DIR, 'allow-card-git-again.png') })
  }
  const before = await okReplies()
  await card5.locator(tid('allow-git-retry')).click()
  await page.locator('.bubble.user', { hasText: advice }).last().waitFor({ timeout: T })
  await page.waitForFunction((n) => [...document.querySelectorAll('[data-testid="agent-message"]')].filter((e) => e.textContent.trim() === 'ok').length > n, before, {
    timeout: 30_000
  })
  const runs5 = (await readFile(argvFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert(runs5.length === 4, `four resumed runs recorded (${runs5.length})`)
  pass('the same command refused with the git -C rule held: Ask to use git -C sends the advice and the agent continues')

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
  if (outside) await rm(outside, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
