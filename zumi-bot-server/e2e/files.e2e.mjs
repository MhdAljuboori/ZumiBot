// End-to-end check of the Files panel in the built server + web UI (local mode), against the FAKE claude: no real CLI
// turn is sent, so no login or quota is used. Usage: npm run e2e:files   (builds first)
//
// The fake claude replays fixtures/files-script.jsonl: an own Edit of post.md, an own Write of notes.txt and a subagent's
// Edit of config.json (its file is written by a #WRITE_FILE line before the result, as the server reads it from disk).
// Only config.json is really written, so post.md on disk is still the old text: Restore must refuse it until the test
// writes what the edit left.
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dir created here (plus the harness's own temp root) is deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
//
// DOM hooks relied on (data-testid): new-agent, agent-row (+ data-agent-name), new-chat, new-chat-folder,
//   new-chat-choose-folder, composer-input, send-button, attach-button, draft-attachment (+ data-status), agent-message,
//   fork-button, chat-row, side-panel-toggle, side-menu, side-open-files, side-files-count, side-back, files-panel, files-close, file-row (+ data-path), attached-row, file-view-diff|old|new,
//   file-step, file-copy, file-download, file-show, file-image, file-rows, diff-row (+ data-kind, data-row), selection-menu,
//   selection-quote, tool-row (+ data-tool-id), file-restore, file-restore-note.

import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors, optionLabels } from './harness.mjs'
import { redPng } from './redPng.mjs'

const AGENT = 'e2e-files-agent'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 20_000
const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, 'fixtures', 'files-script.jsonl')

const POST_OLD = '# Post\nalpha\nbeta\ngamma\n\ndelta\n'
const POST_NEW = '# Post\nalpha\nBETA\ngamma\n\ndelta\n'
const CONFIG_OLD = '{\n  "mode": "dev",\n  "retries": 1\n}\n'
const CONFIG_NEW = '{\n  "mode": "dev",\n  "retries": 3\n}\n'

let h = null
let work = null
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const chatIdOf = (page) => new URL(page.url()).pathname.replace(/^\/chat\//, '')

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

const row = (page, name) => page.locator(`${tid('file-row')}[data-path$="/${name}"]`)
const panel = (page) => page.locator(tid('files-panel'))

/** The panel's lines as {kind, ln: [..numbers], code}. */
const readRows = (page) =>
  page.locator(`${tid('file-rows')} > [data-row]`).evaluateAll((els) =>
    els.map((e) => ({
      kind: e.dataset.kind ?? e.dataset.testid,
      ln: [...e.querySelectorAll('.ln')].map((n) => n.textContent),
      code: e.querySelector('.code')?.textContent ?? e.textContent
    }))
  )

/** A real mouse drag from the start of one line's text to the end of another's. */
async function dragLines(page, a, b) {
  const from = await page.locator(`${tid('file-rows')} [data-row="${a}"] .code`).boundingBox()
  const to = await page.locator(`${tid('file-rows')} [data-row="${b}"] .code`).boundingBox()
  await page.mouse.move(from.x + 1, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 })
  await page.mouse.move(to.x + to.width - 1, to.y + to.height / 2, { steps: 4 })
  await page.mouse.up()
  await page.locator(tid('selection-menu')).waitFor({ timeout: 5_000 })
}

// The composer turns the quote into rich text: an inline code span with the place, then a code block with the lines.
async function clearComposer(page) {
  const input = page.locator(tid('composer-input'))
  await input.click()
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.waitForFunction(() => (document.querySelector('[data-testid="composer-input"]')?.textContent ?? '').trim() === '', null, {
    timeout: 5_000
  })
}

/** Restore with the confirm dialog answered: Restore, or Cancel. */
async function restore(page, answer = 'Restore') {
  await page.locator(tid('file-restore')).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 5_000 })
  await dialog.getByRole('button', { name: answer, exact: true }).click()
  await dialog.waitFor({ state: 'detached', timeout: 5_000 })
}

const restoreNote = (page, text) =>
  page.waitForFunction(([sel, t]) => document.querySelector(sel)?.textContent === t, [tid('file-restore-note'), text], { timeout: T })

const quoted = (page) =>
  page.locator(tid('composer-input')).evaluate((e) => ({
    place: e.querySelector('p code')?.textContent ?? null,
    block: e.querySelector('pre')?.textContent ?? null,
    blocks: e.querySelectorAll('pre').length
  }))

async function main() {
  work = await mkdtemp(join(tmpdir(), 'zumibot-e2e-files-'))
  h = await start({ mode: 'local', fake: true, env: { ZUMIBOT_TEST_PICK_FOLDER: work } })
  await writeFile(
    join(h.agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Files panel e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  await copyFile(SCRIPT, h.script)
  await writeFile(join(work, 'post.md'), POST_OLD)
  await writeFile(join(work, 'config.json'), CONFIG_OLD)
  const page = h.page
  await h.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: h.origin })
  // What "Show in chat" does to the Agent row: the elements scrolled to and animated.
  await page.addInitScript(() => {
    window.__seen = { animated: [], scrolled: [] }
    const id = (el) => el.closest?.('[data-tool-id]')?.dataset.toolId ?? el.dataset?.toolId ?? ''
    const animate = Element.prototype.animate
    Element.prototype.animate = function (...a) {
      window.__seen.animated.push(id(this))
      return animate.apply(this, a)
    }
    const scroll = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (...a) {
      window.__seen.scrolled.push(id(this))
      return scroll.apply(this, a)
    }
  })
  await page.reload()
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })

  // 1. a new chat in the work folder, one image attached, the script run
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(tid('attach-button')).click()])
  await chooser.setFiles({ name: 'red.png', mimeType: 'image/png', buffer: redPng() })
  await page.locator(`${tid('draft-attachment')}[data-status="ready"]`).waitFor({ timeout: 15_000 })
  await page.locator(tid('composer-input')).fill('change the files')
  await page.locator(tid('send-button')).click()
  const toggle = page.locator(tid('side-panel-toggle'))
  const menu = page.locator(tid('side-menu'))
  const openFiles = page.locator(tid('side-open-files'))
  await toggle.click()
  await menu.waitFor({ timeout: T })
  await page.waitForFunction(() => document.querySelector('[data-testid="side-files-count"]')?.textContent === '4', null, { timeout: T })
  await page.locator(tid('agent-message')).last().waitFor({ timeout: T })
  const chatId = chatIdOf(page)
  ok('the side panel list shows Open Files 4 after one image and the script run')

  // 2. the panel lists the three changed files and the attachment
  await openFiles.click()
  await panel(page).waitFor({ timeout: T })
  assert((await page.locator(tid('file-row')).count()) === 3, `3 changed files (got ${await page.locator(tid('file-row')).count()})`)
  const post = row(page, 'post.md')
  const notes = row(page, 'notes.txt')
  const config = row(page, 'config.json')
  assert((await post.locator('.file-badge').count()) === 0, 'post.md has no "new" badge')
  assert((await post.locator('.file-count').textContent()) === '1 change', 'post.md has 1 change')
  assert((await notes.locator('.file-badge').textContent()) === 'new', 'notes.txt is new')
  assert((await config.locator('.file-badge').count()) === 0, 'config.json has no "new" badge')
  assert((await page.locator(tid('attached-row')).count()) === 1, 'one attachment')
  assert((await page.locator(tid('attached-row')).textContent()).includes('red.png'), 'the attachment is red.png')
  await config.click()
  const options = await optionLabels(page.locator(tid('file-step')))
  assert(
    options.some((o) => o.includes('› general-purpose')),
    `config.json's step is by the subagent (${JSON.stringify(options)})`
  )
  ok('the panel lists post.md (1 change), notes.txt (new), config.json (› general-purpose) and the attachment')

  // 3. Diff, Old, New of post.md
  await post.click()
  await page
    .locator(`${tid('file-rows')} [data-row]`)
    .first()
    .waitFor({ timeout: T })
  let rows = await readRows(page)
  const del = rows.find((r) => r.kind === 'del')
  const add = rows.find((r) => r.kind === 'add')
  assert(del && add, `a removed and an added row (${JSON.stringify(rows)})`)
  assert(del.code === 'beta' && del.ln.join('|') === '3|', `removed row is "beta" with old line 3 (${JSON.stringify(del)})`)
  assert(add.code === 'BETA' && add.ln.join('|') === '|3', `added row is "BETA" with new line 3 (${JSON.stringify(add)})`)
  assert(rows.filter((r) => r.kind === 'ctx').length === 5, 'five unchanged rows around the edit')
  ok('Diff of post.md: -beta (old line 3) and +BETA (new line 3) with the context around')

  await page.locator(tid('file-view-old')).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-rows"] [data-row]').length === 6)
  rows = await readRows(page)
  assert(
    rows.map((r) => r.code).join('\n') === POST_OLD.trimEnd().split('\n').join('\n'),
    `Old shows the whole old file (${JSON.stringify(rows)})`
  )
  assert(rows.map((r) => r.ln.join('')).join(',') === '1,2,3,4,5,6', `Old has line numbers (${JSON.stringify(rows.map((r) => r.ln))})`)
  await page.locator(tid('file-view-new')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="file-rows"]')?.textContent.includes('BETA'))
  rows = await readRows(page)
  assert(rows.map((r) => r.code).join('\n') === POST_NEW.trimEnd(), `New shows the whole new file (${JSON.stringify(rows)})`)
  ok('Old and New show the whole file, numbered')

  // 4. the step select
  const steps = await optionLabels(page.locator(tid('file-step')))
  assert(steps.length === 2 && /^All changes/.test(steps[0]), `post.md's steps: all, then the edit (${JSON.stringify(steps)})`)
  ok(`the step select lists the steps (${JSON.stringify(steps)})`)

  // 5. Copy puts the New text on the clipboard
  await page.locator(tid('file-copy')).click()
  await page.waitForFunction(() => /Copied/.test(document.querySelector('[data-testid="file-copy"]')?.textContent ?? ''), null, {
    timeout: 5_000
  })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  assert(clip === POST_NEW, `the clipboard holds the New text (${JSON.stringify(clip)})`)
  ok('Copy puts the whole New text on the clipboard')

  // 6. select two New lines and Quote them into the composer
  await dragLines(page, 1, 2) // data-row is 0-based: rows 1 and 2 are lines 2 and 3
  await page.locator(tid('selection-quote')).click()
  let q = await quoted(page)
  assert(q.place === 'post.md:2-3', `the draft names post.md:2-3 (${JSON.stringify(q)})`)
  assert(q.block === 'alpha\nBETA', `the draft fences the two lines (${JSON.stringify(q)})`)
  ok('selecting two New lines and Quote: the draft holds `post.md:2-3` and a fenced alpha / BETA')

  // 6b. a selection across the empty line draws no doubled newline
  await clearComposer(page)
  await dragLines(page, 3, 5)
  await page.locator(tid('selection-quote')).click()
  q = await quoted(page)
  assert(q.place === 'post.md:4-6', `the draft names post.md:4-6 (${JSON.stringify(q)})`)
  assert(q.block === 'gamma\n\ndelta', `the empty line is one empty line, not two (${JSON.stringify(q)})`)
  await clearComposer(page)
  ok('selecting across an empty line: `post.md:4-6`, gamma, one empty line, delta')

  // 7. Esc closes the panel
  await post.focus()
  await page.keyboard.press('Escape')
  await panel(page).waitFor({ state: 'detached', timeout: 5_000 })
  assert((await toggle.getAttribute('aria-pressed')) === 'false', 'the panel icon is released')
  ok('Esc closes the panel')

  // 8. the panel icon opens on the list again; Back from Files returns to it
  await toggle.click()
  await menu.waitFor({ timeout: T })
  await openFiles.click()
  await panel(page).waitFor({ timeout: T })
  await page.locator(tid('side-back')).click()
  await menu.waitFor({ timeout: 5_000 })
  await panel(page).waitFor({ state: 'detached', timeout: 5_000 })
  ok('the panel icon opens the list, and Back from Files returns to it')

  // 9. Show in chat on config.json scrolls to and flashes the Agent tool row
  await openFiles.click()
  await panel(page).waitFor({ timeout: T })
  await row(page, 'config.json').click()
  await page.evaluate(() => {
    window.__seen = { animated: [], scrolled: [] }
  })
  await page.locator(tid('file-show')).click()
  await page.waitForFunction(() => window.__seen.animated.includes('toolu_agent'), null, { timeout: 10_000 })
  const seen = await page.evaluate(() => window.__seen)
  assert(seen.scrolled.includes('toolu_agent'), `the Agent row was scrolled to (${JSON.stringify(seen)})`)
  const agentRow = page.locator(`${tid('tool-row')}[data-tool-id="toolu_agent"]`)
  await agentRow.waitFor({ timeout: 5_000 })
  assert((await agentRow.textContent()).length > 0, 'the Agent tool row is in the chat')
  ok('Show in chat on the subagent change scrolls to and flashes the Agent tool row')

  // 10. the attachment previews as an image
  await page.locator(tid('attached-row')).click()
  const img = page.locator(tid('file-image'))
  await img.waitFor({ timeout: T })
  await page.waitForFunction(
    () => {
      const i = document.querySelector('[data-testid="file-image"]')
      return i && i.complete && i.naturalWidth > 0
    },
    null,
    { timeout: T }
  )
  ok('the attachment previews as an image')

  // 10b. Restore to before a change: refused while the disk differs from what the change left, then written back
  await post.click()
  const restoreBtn = page.locator(tid('file-restore'))
  await restoreBtn.waitFor({ timeout: T })
  assert((await restoreBtn.textContent()) === 'Restore to before this change', `the button's label (${await restoreBtn.textContent()})`)
  assert(await restoreBtn.isEnabled(), 'Restore is enabled for post.md')
  await restore(page, 'Cancel')
  assert((await page.locator(tid('file-restore-note')).count()) === 0, 'Cancel restores nothing and says nothing')
  // The fake never wrote post.md, so the disk still holds the old text: not what the edit left.
  await restore(page)
  await restoreNote(page, 'The file was changed since. Nothing was restored.')
  assert((await readFile(join(work, 'post.md'), 'utf8')) === POST_OLD, 'a refused restore leaves the file as it was')
  await writeFile(join(work, 'post.md'), POST_NEW)
  await restore(page)
  await restoreNote(page, 'Restored.')
  assert((await readFile(join(work, 'post.md'), 'utf8')) === POST_OLD, 'post.md holds the text from before the edit')
  ok('Restore on post.md: refused while the disk differs from the edit, then the old text written back')

  await notes.click()
  await page.locator(tid('file-restore')).waitFor({ timeout: T })
  await writeFile(join(work, 'notes.txt'), 'one\ntwo\n')
  await restore(page)
  await restoreNote(page, 'Moved to the Trash.')
  assert(!existsSync(join(work, 'notes.txt')), 'notes.txt is gone from the folder')
  const trashed = join(h.root, 'home', '.local', 'share', 'Trash', 'files', 'notes.txt')
  assert(existsSync(trashed) && (await readFile(trashed, 'utf8')) === 'one\ntwo\n', 'notes.txt is in the Trash, whole')
  ok('Restore on the created notes.txt moves it to the Trash')

  assert((await readFile(join(work, 'config.json'), 'utf8')) === CONFIG_NEW, 'config.json holds the subagent edit')
  await config.click()
  await page.locator(tid('file-restore')).waitFor({ timeout: T })
  await restore(page)
  await restoreNote(page, 'Restored.')
  assert((await readFile(join(work, 'config.json'), 'utf8')) === CONFIG_OLD, 'config.json holds the text from before the subagent edit')
  // The disk now holds the before copy, not the after one, so a second press is refused.
  await restore(page)
  await restoreNote(page, 'The file was changed since. Nothing was restored.')
  assert((await readFile(join(work, 'config.json'), 'utf8')) === CONFIG_OLD, 'the second restore changed nothing')
  ok("Restore on the subagent's config.json edit puts the old file back, and a second press is refused")

  // While a reply runs the button is greyed out with the reason, since an agent could be writing the same file.
  const lines = (await readFile(SCRIPT, 'utf8')).trim().split('\n')
  const reply = {
    type: 'assistant',
    message: {
      model: 'claude-haiku-5-5',
      id: 'msg_slow',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Still here.' }],
      stop_reason: null,
      usage: { input_tokens: 2, output_tokens: 2 }
    },
    parent_tool_use_id: null,
    session_id: JSON.parse(lines[0]).session_id
  }
  await writeFile(h.script, [lines[0], '#SLEEP 3000', JSON.stringify(reply), lines[lines.length - 1]].join('\n') + '\n')
  await page.locator(tid('composer-input')).fill('anything else?')
  await page.locator(tid('send-button')).click()
  await page.waitForFunction((sel) => document.querySelector(sel)?.disabled === true, tid('file-restore'), { timeout: T })
  const why = await page.locator(tid('file-restore')).getAttribute('data-tip')
  assert(why === 'Wait for the reply to finish, then restore.', `the disabled button says why (${why})`)
  await page.waitForFunction((sel) => document.querySelector(sel)?.disabled === false, tid('file-restore'), { timeout: T })
  assert((await page.locator(tid('agent-message')).last().textContent()).includes('Still here.'), 'the slow reply arrived')
  ok('while a reply runs Restore is greyed out with the reason, and comes back when it ends')

  // 11. snapshots on disk; Fork at the last agent message
  const snaps = join(h.dataDir, 'file-snapshots')
  const kept = (await readdir(join(snaps, chatId))).length
  assert(kept >= 4, `the chat keeps its copies (${kept})`)
  const msg = page.locator(tid('agent-message')).last()
  await msg.hover()
  await msg.locator(tid('fork-button')).click()
  await page.waitForFunction((id) => location.pathname.startsWith('/chat/') && !location.pathname.endsWith(id), chatId, { timeout: T })
  const forkId = chatIdOf(page)
  assert(forkId !== chatId, 'the fork is a new chat')
  if (
    !(await panel(page)
      .isVisible()
      .catch(() => false))
  ) {
    if (!(await menu.isVisible().catch(() => false))) await toggle.click()
    await openFiles.click()
  }
  await panel(page).waitFor({ timeout: T })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length === 3, null, { timeout: T })
  const paths = await page.locator(tid('file-row')).evaluateAll((els) => els.map((e) => e.dataset.path.split('/').pop()).sort())
  assert(paths.join(',') === 'config.json,notes.txt,post.md', `the fork lists the same files (${paths})`)
  assert((await page.locator(tid('attached-row')).count()) === 1, 'the fork lists the attachment too')
  await row(page, 'post.md').click()
  await page.locator(tid('file-view-old')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="file-rows"]')?.textContent.includes('beta'), null, { timeout: T })
  await page.locator(tid('file-view-new')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="file-rows"]')?.textContent.includes('BETA'), null, { timeout: T })
  await row(page, 'config.json').click()
  await page.locator(tid('file-view-new')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="file-rows"]')?.textContent.includes('"retries": 3'), null, {
    timeout: T
  })
  await page.locator(tid('file-view-old')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="file-rows"]')?.textContent.includes('"retries": 1'), null, {
    timeout: T
  })
  assert(existsSync(join(snaps, forkId)), 'the fork has its own copies on disk')
  ok('Fork: the new chat lists the same files, Old and New load from its own copies')

  // 12. deleting the source chat removes its copies (and not the fork's)
  const sourceRow = page.locator(`${tid('chat-row')}[data-chat-id="${chatId}"]`)
  await sourceRow.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click()
  await sourceRow.waitFor({ state: 'detached', timeout: T })
  const deadline = Date.now() + 10_000
  while (existsSync(join(snaps, chatId)) && Date.now() < deadline) await sleep(100)
  assert(!existsSync(join(snaps, chatId)), 'file-snapshots/<id> is gone after the chat is deleted')
  assert(existsSync(join(snaps, forkId)), "the fork's copies are still there")
  ok('deleting the source chat removes its file-snapshots folder, the fork keeps its own')

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
  console.log('FILES E2E PASSED')
} catch (err) {
  code = 1
  console.error(err instanceof Error ? err.message : err)
} finally {
  await stop()
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
}
process.exit(code)
