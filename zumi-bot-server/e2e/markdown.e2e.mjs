// End-to-end check of Mermaid diagrams and KaTeX math in replies, in the built server + web UI (local mode), against the
// FAKE claude: no real CLI turn is sent, so no login or quota is used. Usage: npm run e2e:markdown   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dir created here (plus the harness's own temp root) is deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// The page runs under the server's real CSP, so a Mermaid or KaTeX need for eval or a foreign origin shows as an error.
//
// DOM hooks relied on (data-testid): new-agent, agent-row (+ data-agent-name), new-chat, new-chat-folder,
//   new-chat-choose-folder, composer-input, send-button, streaming-bubble, agent-message, mermaid-block,
//   mermaid-diagram, diagram-toggle, code-copy.

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start, unexpectedErrors } from './harness.mjs'

const AGENT = 'e2e-markdown-agent'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 20_000
const BASIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'backend', 'tests', 'fixtures', 'stream', 'basic.jsonl')

const REPLY = [
  'Area is $\\pi r^2$, and it costs $5 and $10 today.',
  '',
  '$$',
  'E = mc^2',
  '$$',
  '',
  '```mermaid',
  'graph TD',
  '  A[Start] --> B{Ok?}',
  '  B -->|yes| C[Done]',
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A --> ((',
  '```',
  '',
  '```math',
  '\\frac{a}{b}',
  '```'
].join('\n')

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

/** basic.jsonl with REPLY streamed in two halves, slowly, so the live bubble can be checked mid-reply. */
async function writeScript(path) {
  const half = REPLY.indexOf('```mermaid\ngraph TD\n  A[Start]') + 30
  const out = []
  for (const line of (await readFile(BASIC, 'utf8')).split('\n').filter(Boolean)) {
    const m = JSON.parse(line)
    if (m.type === 'stream_event' && m.event?.delta?.type === 'text_delta') {
      for (const t of [REPLY.slice(0, half), REPLY.slice(half)])
        out.push(JSON.stringify({ ...m, event: { ...m.event, delta: { ...m.event.delta, text: t } } }), '#SLEEP 1500')
    } else if (m.type === 'assistant') {
      m.message.content = [{ type: 'text', text: REPLY }]
      out.push(JSON.stringify(m))
    } else if (m.type === 'result') {
      out.push(JSON.stringify({ ...m, result: REPLY }))
    } else out.push(line)
  }
  await writeFile(path, out.join('\n') + '\n')
}

async function main() {
  work = await mkdtemp(join(tmpdir(), 'zumibot-e2e-markdown-'))
  h = await start({ mode: 'local', fake: true, env: { ZUMIBOT_TEST_PICK_FOLDER: work } })
  await writeFile(
    join(h.agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Markdown e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )
  await writeScript(h.script)
  const page = h.page
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })

  // 1. send; mid-stream the half-written diagram is still code
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(tid('new-chat-choose-folder')).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="new-chat-folder"]')?.getAttribute('data-tip'), null, {
    timeout: 5_000
  })
  await page.locator(tid('composer-input')).fill('draw')
  await page.locator(tid('send-button')).click()
  await page.locator(tid('streaming-bubble')).waitFor({ timeout: T })
  const live = page.locator(tid('streaming-bubble'))
  await live.locator('pre code.language-mermaid').first().waitFor({ timeout: T })
  assert((await live.locator(tid('mermaid-block')).count()) === 0, 'a reply still streaming draws no diagram')
  ok('mid-stream: the mermaid block is plain code')

  // 2. the finished reply: math, prices as text, one diagram, one failed diagram
  const msg = page.locator(tid('agent-message')).last()
  await msg.locator(tid('mermaid-diagram')).first().waitFor({ timeout: 30_000 })
  const inline = await msg.locator('p .katex').count()
  assert(inline === 1, `one inline formula (got ${inline})`)
  assert((await msg.locator('.katex-display').count()) === 2, 'the $$ block and the ```math fence are display math')
  assert((await msg.locator('p').first().textContent()).includes('costs $5 and $10 today'), 'two prices stay text')
  assert((await msg.locator('.katex-mathml annotation').first().textContent()) === '\\pi r^2', 'inline math keeps its TeX')
  ok('KaTeX: inline and display math render, "$5 and $10" stays text')

  const blocks = msg.locator(tid('mermaid-block'))
  assert((await blocks.count()) === 2, 'two mermaid blocks')
  const good = blocks.nth(0)
  const bad = blocks.nth(1)
  assert((await good.locator('svg .node').count()) >= 3, 'the diagram has its three nodes')
  assert((await good.textContent()).includes('Start'), 'node labels are drawn')
  await bad.getByText('Diagram failed to render').waitFor({ timeout: T })
  assert((await bad.locator('pre code').textContent()).includes('A --> (('), 'a broken diagram falls back to its source')
  assert((await bad.locator(tid('diagram-toggle')).count()) === 0, 'a broken diagram has no toggle')
  assert((await page.locator('body > div[id^="dmermaid-"]').count()) === 0, 'no Mermaid scratch nodes are left on <body>')
  ok('Mermaid: diagram drawn, a broken one shows its source and a note')

  // 3. toggle to the source and back
  await good.hover()
  await good.locator(tid('diagram-toggle')).click()
  await good.locator('pre code').waitFor({ timeout: T })
  assert((await good.locator('pre code').textContent()).includes('A[Start] --> B{Ok?}'), 'the toggle shows the source')
  await good.locator(tid('diagram-toggle')).click()
  await good.locator(tid('mermaid-diagram')).waitFor({ timeout: T })
  ok('toggle switches between diagram and source')

  // 4. a theme switch redraws the diagram
  const idBefore = await good.locator('svg').first().getAttribute('id')
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await page.waitForFunction(
    (id) => {
      const svg = document.querySelector('[data-testid="mermaid-diagram"] svg')
      return svg && svg.id !== id
    },
    idBefore,
    { timeout: T }
  )
  ok('switching to dark redraws the diagram')

  // 5. nothing unexpected (a CSP block would show here as a console error)
  const bad2 = unexpectedErrors(h.errors, [])
  assert(bad2.length === 0, `unexpected console/server errors:\n${bad2.join('\n')}`)
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
  console.log('MARKDOWN E2E PASSED')
} catch (err) {
  code = 1
  console.error(err instanceof Error ? err.message : err)
} finally {
  await stop()
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
}
process.exit(code)
