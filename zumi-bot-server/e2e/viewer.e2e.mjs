// End-to-end check of the in-app file viewer, in the built server + web UI (local mode), against the FAKE claude: no
// real CLI turn is sent, so no login or quota is used. Usage: npm run e2e:viewer   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dir created here (plus the harness's own temp root) is deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// The page runs under the server's real CSP. VIEWER_SHOTS=<dir> saves screenshots of the viewer there.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), new-chat, new-chat-folder, new-chat-choose-folder,
//   composer-input, send-button, agent-message, attach-button, draft-attachment (+ data-status), sent-thumb, sent-chip,
//   file-viewer (+ data-kind), viewer-name, viewer-count, viewer-image (+ data-state), viewer-text, viewer-file,
//   viewer-close, viewer-prev, viewer-next, viewer-open, viewer-download.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'
import { start, unexpectedErrors } from './harness.mjs'

const AGENT = 'e2e-viewer-agent'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 20_000
const BASIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'tests', 'fixtures', 'stream', 'basic.jsonl')
const SHOTS = process.env.VIEWER_SHOTS ?? null

// Two of the app's own public images: react-markdown keeps only same-origin and http(s) sources, and the CSP only ours.
const REPLY = ['Here are two pictures.', '', '![App icon](/icon-192.png)', '', 'And the badge:', '', '![Badge](/badge-96.png)'].join('\n')

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

/** An RGB PNG of w x h with a pattern, so a full-size view has something to scroll over. */
function png(w, ht, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * ht)
  for (let y = 0; y < ht; y++) {
    const o = y * (w * 3 + 1)
    for (let x = 0; x < w; x++) {
      const p = o + 1 + x * 3
      raw[p] = r ^ (x & 0x3f)
      raw[p + 1] = g ^ (y & 0x3f)
      raw[p + 2] = b
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const head = Buffer.alloc(13)
  head.writeUInt32BE(w, 0)
  head.writeUInt32BE(ht, 4)
  head[8] = 8 // bit depth
  head[9] = 2 // truecolor
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', head),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

async function writeScript(path) {
  const out = []
  for (const line of (await readFile(BASIC, 'utf8')).split('\n').filter(Boolean)) {
    const m = JSON.parse(line)
    if (m.type === 'stream_event' && m.event?.delta?.type === 'text_delta') {
      out.push(JSON.stringify({ ...m, event: { ...m.event, delta: { ...m.event.delta, text: REPLY } } }))
    } else if (m.type === 'assistant') {
      m.message.content = [{ type: 'text', text: REPLY }]
      out.push(JSON.stringify(m))
    } else if (m.type === 'result') {
      out.push(JSON.stringify({ ...m, result: REPLY }))
    } else out.push(line)
  }
  await writeFile(path, out.join('\n') + '\n')
}

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

async function main() {
  work = await mkdtemp(join(tmpdir(), 'zumibot-e2e-viewer-'))
  h = await start({ mode: 'local', fake: true, env: { ZUMIBOT_TEST_PICK_FOLDER: work } })
  await writeFile(
    join(h.agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Viewer e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  await writeScript(h.script)
  const page = h.page
  await page.setViewportSize({ width: 1280, height: 800 })
  const viewer = page.locator(tid('file-viewer'))
  const name = () => viewer.locator(tid('viewer-name')).textContent()

  // 1. start a chat; the reply's two images load
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  await page.locator(tid('composer-input')).fill('hi')
  await page.locator(tid('send-button')).click()
  const reply = page.locator(tid('agent-message')).last()
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="agent-message"] img.markdown-img[data-ready]').length === 2,
    null,
    { timeout: T }
  )
  ok('a reply with two same-origin images renders them')

  // 2. a reply image opens in the viewer with the other one a step away
  await reply.locator('img.markdown-img').nth(1).click()
  await viewer.waitFor({ timeout: 5_000 })
  assert((await name()) === 'Badge', `named by its alt text, got ${await name()}`)
  assert((await viewer.locator(tid('viewer-count')).textContent()) === '2 / 2', 'second of two')
  await viewer.locator(`${tid('viewer-image')}[data-state="ready"]`).waitFor({ timeout: T })
  assert((await viewer.locator(tid('viewer-open')).count()) === 0, 'a reply image has no default-app open')
  assert((await viewer.locator(tid('viewer-download')).getAttribute('href')).endsWith('/badge-96.png'), 'a same-origin image can be saved')
  await page.keyboard.press('ArrowRight')
  assert((await name()) === 'App icon', `ArrowRight goes round to the first, got ${await name()}`)
  await page.keyboard.press('Escape')
  await viewer.waitFor({ state: 'detached', timeout: 5_000 })
  ok('a reply image opens in the viewer, steps round with the arrows and closes on Esc')

  // 3. composer files: thumbnails and ready chips open the viewer, in the draft's order
  const big = png(2400, 1600, [40, 120, 200])
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator(tid('attach-button')).click()])
  await chooser.setFiles([
    { name: 'big.png', mimeType: 'image/png', buffer: big },
    { name: 'small.png', mimeType: 'image/png', buffer: png(80, 60, [200, 60, 60]) },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('first line\nsecond line\n<b>not bold</b>\n') },
    { name: 'data.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\u0003\u0004 not really a zip') }
  ])
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="draft-attachment"][data-status="ready"]').length === 4, null, {
    timeout: T
  })
  const drafts = page.locator(tid('draft-attachment'))
  await drafts.nth(0).locator('button.attach-thumb').click()
  await viewer.waitFor({ timeout: 5_000 })
  assert((await name()) === 'big.png' && (await viewer.locator(tid('viewer-count')).textContent()) === '1 / 4', 'opens on big.png, 1 / 4')
  const focus = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))
  assert(focus === 'viewer-close', `focus starts on Close, got ${focus}`)
  await viewer.locator(`${tid('viewer-image')}[data-state="ready"]`).waitFor({ timeout: T })
  assert((await viewer.locator(tid('viewer-open')).count()) === 0, 'a staged file has no default-app open')
  assert(
    /\/api\/attachments\/staged\/[^/]+\?download=1$/.test(await viewer.locator(tid('viewer-download')).getAttribute('href')),
    'staged download link'
  )
  await shot(page, 'viewer-image-fit')

  // full size around the click, then fit again
  const img = viewer.locator(tid('viewer-image'))
  await img.click()
  await page.waitForFunction(() => document.querySelector('[data-testid="viewer-image"]')?.classList.contains('zoomed'), null, {
    timeout: 5_000
  })
  const scroll = await page.evaluate(() => {
    const s = document.querySelector('.viewer-stage')
    return { w: s.scrollWidth > s.clientWidth, x: s.scrollLeft, y: s.scrollTop }
  })
  assert(scroll.w && scroll.x > 0 && scroll.y > 0, `full size scrolls to the clicked point: ${JSON.stringify(scroll)}`)
  await shot(page, 'viewer-image-full')
  await img.click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="viewer-image"]')?.classList.contains('zoomed'), null, {
    timeout: 5_000
  })
  ok('a large draft image opens fitted, a click shows it full size around the click, another fits it again')

  await viewer.locator(tid('viewer-next')).click()
  assert((await name()) === 'small.png', 'Next is small.png')
  await page.keyboard.press('ArrowRight')
  await viewer.locator(tid('viewer-text')).waitFor({ timeout: T })
  const text = await viewer.locator(tid('viewer-text')).textContent()
  assert(text.includes('second line') && text.includes('<b>not bold</b>'), `text shown as text: ${JSON.stringify(text)}`)
  await shot(page, 'viewer-text')
  await page.keyboard.press('ArrowRight')
  await viewer.locator(tid('viewer-file')).waitFor({ timeout: T })
  assert((await viewer.locator(tid('viewer-file')).textContent()).includes('No preview for this type of file.'), 'zip gets the file card')
  await shot(page, 'viewer-file')
  await viewer.locator(tid('viewer-prev')).click()
  assert((await viewer.getAttribute('data-kind')) === 'text', 'Prev goes back to the text')
  await page.keyboard.press('Escape')
  await viewer.waitFor({ state: 'detached', timeout: 5_000 })
  const back = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))
  assert(back === 'Open big.png', `focus goes back to the thumbnail, got ${back}`)
  ok('draft files step image → image → text → file card; Esc closes and focus returns to the thumbnail')

  await drafts.nth(2).locator('.attach-open').click()
  await viewer.waitFor({ timeout: 5_000 })
  assert((await name()) === 'notes.txt', 'a draft chip opens its own file')
  // A press on the empty stage closes, as a dialog's backdrop does.
  await page.mouse.click(30, 150)
  await viewer.waitFor({ state: 'detached', timeout: 5_000 })
  ok('a ready draft chip opens the viewer; a click beside the file closes it')

  // 4. sent files: a thumbnail or chip opens the viewer, which offers the default app and Download
  await page.locator(tid('composer-input')).fill('look')
  await page.locator(tid('send-button')).click()
  await page.locator(tid('sent-thumb')).nth(1).waitFor({ timeout: T })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="agent-message"]').length >= 2, null, { timeout: T })
  const pages = h.context.pages().length
  await page.locator(tid('sent-thumb')).nth(0).locator('button').click()
  await viewer.waitFor({ timeout: 5_000 })
  assert((await name()) === 'big.png' && (await viewer.locator(tid('viewer-count')).textContent()) === '1 / 4', 'sent big.png, 1 / 4')
  await viewer.locator(`${tid('viewer-image')}[data-state="ready"]`).waitFor({ timeout: T })
  assert((await viewer.locator(tid('viewer-open')).textContent()) === 'Open in new tab', 'a browser offers a new tab')
  assert(
    /\/api\/attachments\/chat\/[^/]+\/[^/]+\?download=1$/.test(await viewer.locator(tid('viewer-download')).getAttribute('href')),
    'sent download link'
  )
  assert(h.context.pages().length === pages, 'opening a sent file opens no tab')
  await page.keyboard.press('Escape')
  await viewer.waitFor({ state: 'detached', timeout: 5_000 })
  await page.locator(tid('sent-chip')).last().locator('.attach-open').click()
  await viewer.waitFor({ timeout: 5_000 })
  assert((await name()) === 'data.zip', 'the last chip is data.zip')
  const popup = page.waitForEvent('popup', { timeout: 10_000 })
  await viewer.locator(tid('viewer-file')).getByRole('button', { name: 'Open in new tab' }).click()
  await (await popup).close()
  assert((await viewer.count()) === 1, 'the viewer stays open after Open')
  await viewer.locator(tid('viewer-close')).click()
  await viewer.waitFor({ state: 'detached', timeout: 5_000 })
  ok('sent files open in the viewer, not a tab; its Open still hands the file to a new tab')

  // 5. a phone: the viewer fills the screen and the steps sit at the bottom
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator(tid('sent-thumb')).nth(0).locator('button').click()
  await viewer.locator(`${tid('viewer-image')}[data-state="ready"]`).waitFor({ timeout: T })
  const fit = await page.evaluate(() => {
    const i = document.querySelector('[data-testid="viewer-image"]').getBoundingClientRect()
    return i.right <= innerWidth && i.left >= 0 && document.documentElement.scrollWidth <= innerWidth
  })
  assert(fit, 'on a phone the image fits and the page does not scroll sideways')
  await shot(page, 'viewer-phone')
  await page.keyboard.press('Escape')
  await viewer.waitFor({ state: 'detached', timeout: 5_000 })
  ok('a phone-width viewer fits the image')

  // 6. nothing unexpected (a CSP block would show here as a console error)
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
  console.log('VIEWER E2E PASSED')
} catch (err) {
  code = 1
  console.error(err instanceof Error ? err.message : err)
} finally {
  await stop()
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
}
process.exit(code)
