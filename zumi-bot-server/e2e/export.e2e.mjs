// End-to-end check of chat export (Markdown and HTML), in the built server + web UI (local mode), against the FAKE
// claude: no real CLI turn is sent, so no login or quota is used. Usage: npm run e2e:export   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dir created here (plus the harness's own temp root) is deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// The saved page is opened from disk with its own CSP, so anything it tried to load or run shows as a console error.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), new-chat, new-chat-folder, new-chat-choose-folder,
//   composer-input, send-button, agent-message, export-button, export-dialog, export-scope-reply, export-scope-chat,
//   export-format-md, export-format-html, export-steps, export-download, export-copy, chat-row (+ data-chat-id),
//   chat-menu-export.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const AGENT = 'e2e-export-agent'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 20_000
const BASIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'tests', 'fixtures', 'stream', 'basic.jsonl')
const ASK = 'Sum up Q3'

const REPLY = [
  '## Q3 summary',
  '',
  '| Region | Growth |',
  '|:--|--:|',
  '| EU | 9% |',
  '',
  'Raw <script>alert(1)</script> stays text, and [this](javascript:alert(2)) is no link.',
  '',
  '```js',
  'total(q3)'
].join('\n') // the fence is left open on purpose: the export closes it

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

async function writeScript(path) {
  const out = []
  for (const line of (await readFile(BASIC, 'utf8')).split('\n').filter(Boolean)) {
    const m = JSON.parse(line)
    if (m.type === 'stream_event' && m.event?.delta?.type === 'text_delta')
      out.push(JSON.stringify({ ...m, event: { ...m.event, delta: { ...m.event.delta, text: REPLY } } }))
    else if (m.type === 'assistant') {
      m.message.content = [{ type: 'text', text: REPLY }]
      out.push(JSON.stringify(m))
    } else if (m.type === 'result') out.push(JSON.stringify({ ...m, result: REPLY }))
    else out.push(line)
  }
  await writeFile(path, out.join('\n') + '\n')
}

/** Clicks Download and returns the saved file's name and text. */
async function download(page, saveAs) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: T }), page.locator(tid('export-download')).click()])
  await dl.saveAs(saveAs)
  return { name: dl.suggestedFilename(), text: await readFile(saveAs, 'utf8') }
}

async function main() {
  work = await mkdtemp(join(tmpdir(), 'zumibot-e2e-export-'))
  h = await start({ mode: 'local', fake: true, env: { ZUMIBOT_TEST_PICK_FOLDER: work } })
  await writeFile(
    join(h.agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Export e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  await writeScript(h.script)
  const page = h.page

  // 1. a chat with one reply
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  await page.locator(tid('composer-input')).fill(ASK)
  await page.locator(tid('send-button')).click()
  const msg = page.locator(tid('agent-message')).last()
  await msg.locator('table').waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => /\/chat\/[A-Za-z0-9-]+$/.test(location.pathname), null, { timeout: T })
  const chatId = new URL(page.url()).pathname.split('/').pop()
  const row = page.locator(`${tid('chat-row')}[data-chat-id="${chatId}"]`)
  await row.waitFor({ timeout: T })
  ok('a chat with one reply')

  // 2. Export reply → web page: only that reply, safe, and it opens on its own with nothing blocked
  await msg.hover()
  await msg.locator(tid('export-button')).click()
  const dialog = page.locator(tid('export-dialog'))
  await dialog.waitFor({ timeout: T })
  assert((await dialog.locator('h2').textContent()) === 'Export reply', 'opened from a message, it exports a reply')
  assert(await page.locator(tid('export-scope-reply')).isChecked(), 'This reply is picked')
  await page.locator(tid('export-format-html')).click()
  const html = await download(page, join(work, 'reply.html'))
  assert(html.name.endsWith(' (reply).html'), `reply file name (got ${html.name})`)
  await dialog.waitFor({ state: 'detached', timeout: T })
  assert(html.text.startsWith('<!doctype html>'), 'a whole page')
  assert(html.text.includes('<table>') && html.text.includes('<th style="text-align:left">Region</th>'), 'the table is HTML')
  assert(!/<script/i.test(html.text), 'no script element anywhere')
  assert(!html.text.includes('javascript:'), 'the javascript: link is gone')
  assert(!html.text.includes('class="msg user"') && html.text.includes(' · one reply · '), 'a reply export leaves the question out')
  assert(html.text.includes('<code class="language-js">total(q3)\n</code></pre>'), 'the open fence was closed')

  const view = await h.context.newPage()
  const viewErrors = []
  view.on('console', (m) => {
    if (m.type() === 'error') viewErrors.push(m.text())
  })
  view.on('pageerror', (e) => viewErrors.push(e.message))
  await view.goto(pathToFileURL(join(work, 'reply.html')).href)
  assert((await view.locator('table td').first().textContent()) === 'EU', 'the saved page draws the table')
  assert((await view.locator('main').textContent()).includes('Raw <script>alert(1)</script> stays text'), 'raw HTML reads as text')
  assert((await view.locator('script').count()) === 0, 'no script in the DOM')
  await sleep(300)
  assert(viewErrors.length === 0, `the saved page logged errors:\n${viewErrors.join('\n')}`)
  await view.close()
  ok('Export reply → HTML: one reply, no script or unsafe link, opens cleanly from disk')

  // 3. the sidebar row's Export… → Markdown of the whole chat, with steps
  await row.click({ button: 'right' })
  await page.locator(tid('chat-menu-export')).click()
  await dialog.waitFor({ timeout: T })
  assert((await dialog.locator('h2').textContent()) === 'Export chat', 'the row menu exports the chat')
  assert((await page.locator(tid('export-scope-reply')).count()) === 0, 'no reply to pick from the row menu')
  assert((await page.locator(tid('export-format-md')).getAttribute('aria-checked')) === 'true', 'Markdown is the default')
  await page.locator(tid('export-steps')).check()
  const md = await download(page, join(work, 'chat.md'))
  assert(md.name.endsWith('.md') && !md.name.includes('(reply)'), `chat file name (got ${md.name})`)
  assert(md.text.startsWith('# '), 'a title heading')
  assert(md.text.includes(`Chat with E2e Export Agent`), 'says who the chat is with')
  assert(md.text.includes(`**You** · `) && md.text.includes(ASK), 'the question is in')
  assert(md.text.includes('**E2e Export Agent** · ') && md.text.includes('| EU | 9% |'), 'the reply is in, as written')
  assert(md.text.includes('total(q3)\n```'), 'the open fence was closed')
  assert(!md.text.includes(work), "the chat's folder is never written")
  ok('row menu Export… → Markdown of the whole chat')

  // 4. Copy Markdown puts the same text on the clipboard; Esc closes
  await h.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: h.origin })
  await row.click({ button: 'right' })
  await page.locator(tid('chat-menu-export')).click()
  await page.locator(tid('export-copy')).click()
  await page.locator(tid('export-copy')).getByText('Copied').waitFor({ timeout: T })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  assert(clip.includes(ASK) && clip.includes('| EU | 9% |'), 'the clipboard holds the Markdown')
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: T })
  ok('Copy Markdown fills the clipboard; Esc closes')

  // 5. the route answers only a known chat, and refuses odd options
  const status = await page.evaluate(
    async (id) => [(await fetch(`/api/export/nope`)).status, (await fetch(`/api/export/${id}?format=pdf`)).status],
    chatId
  )
  assert(status[0] === 404 && status[1] === 400, `route statuses (got ${status})`)
  ok('unknown chat 404, bad format 400')

  const bad = unexpectedErrors(h.errors, [/404 \(Not Found\)/, /400 \(Bad Request\)/])
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
  console.log('EXPORT E2E PASSED')
} catch (err) {
  code = 1
  console.error(err instanceof Error ? err.message : err)
} finally {
  await stop()
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
}
process.exit(code)
