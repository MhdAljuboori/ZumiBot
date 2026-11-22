// End-to-end check of agent memory in the built server + web UI (local mode) against the FAKE claude: no real CLI turn
// is ever sent, so no login or quota is used. Usage: npm run e2e:memory   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME (memory lives in HOME/.claude/agent-memory),
//    agents dir and data dir, and CLAUDE_CONFIG_DIR is unset so a developer's own value cannot leak in;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// The agent's memory write is scripted: a Write tool_use, a #WRITE_FILE directive (the fake claude writes the file there) and
// the tool_result.
//
// DOM hooks relied on (data-testid): agent-row (+ data-agent-name), new-chat-folder, new-chat-choose-folder, composer-input,
//   send-button, memory-line, memory-view, memory-section, memory-limit, memory-count, memory-new, memory-search, memory-row,
//   memory-editor, memory-save, memory-delete.

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start, unexpectedErrors, pickOption } from './harness.mjs'

const PREFIX = 'zumibot-e2e-memory-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 15_000
const AGENT = 'mem'

let h = null
const made = []
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`

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

const agentFile = (name, extra = '') =>
  `---\nname: ${name}\ndescription: Memory test agent.\nmodel: haiku\n${extra}---\nYou are a test agent.\n`
const memFile = (name, description, type, body) =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n---\n${body}\n`
const read = (f) => readFile(f, 'utf8').catch(() => null)
const files = async (dir) => (await readdir(dir).catch(() => [])).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md').sort()

async function main() {
  const pickDir = (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}folder-`))), made.at(-1))
  const dataDir = (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}data-`))), made.at(-1))
  const agentsDir = (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}agents-`))), made.at(-1))
  await writeFile(join(agentsDir, `${AGENT}.md`), agentFile(AGENT, 'memory: user\n'))
  h = await start({ fake: true, dataDir, agentsDir, env: { CLAUDE_CONFIG_DIR: undefined, ZUMIBOT_TEST_PICK_FOLDER: pickDir } })
  const page = h.page
  const memDir = join(h.root, 'home', '.claude', 'agent-memory', AGENT)
  const movedDir = join(h.root, 'home', '.claude', 'agent-memory', 'mem2')
  const row = (n) => page.locator(`${tid('agent-row')}[data-agent-name="${n}"]`)
  const rows = page.locator(tid('memory-row'))
  const count = page.locator(tid('memory-count'))
  const countIs = (n, limit) => async () => ((await count.textContent().catch(() => '')) ?? '').trim() === `${n} of ${limit}`

  // 1. a scripted Write of a memory file during a turn: the reply carries "Memory: 1 saved"
  const target = join(memDir, 'user_teal.md')
  const line = (o) => JSON.stringify(o)
  const basic = (await readFile(h.script, 'utf8')).split('\n').filter(Boolean)
  const script = [
    basic[0],
    line({
      type: 'assistant',
      message: {
        id: 'msg_mem1',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_mem1', name: 'Write', input: { file_path: target, content: 'x' } }]
      }
    }),
    `#WRITE_FILE ${JSON.stringify({ path: target, content: memFile('teal', 'Favourite colour', 'user', 'The user likes teal.') })}`,
    line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_mem1', content: 'File created' }] }
    }),
    ...basic.slice(1)
  ]
  await writeFile(h.script, script.join('\n') + '\n')
  await row(AGENT).waitFor({ timeout: 30_000 })
  await row(AGENT).click()
  await page.click(tid('new-chat-folder'))
  await page.click(tid('new-chat-choose-folder'))
  await waitFor(async () => (await page.locator(tid('new-chat-folder')).getAttribute('data-tip')) === pickDir, T, 'the folder to be set')
  await page.locator(tid('composer-input')).click()
  await page.keyboard.type('remember teal')
  await page.click(tid('send-button'))
  await page.locator(tid('memory-line')).waitFor({ timeout: 30_000 })
  const lineText = (await page.locator(tid('memory-line')).textContent()).trim()
  assert(lineText.includes('Memory: 1 saved'), `the memory line reads ${JSON.stringify(lineText)}`)
  // Agent Studio's loadout probe runs the fake claude too, which plays the script for any first line: left in, its #WRITE_FILE
  // would write user_teal.md into this folder again, also after the rename in step 8 has moved it away.
  await writeFile(h.script, basic.join('\n') + '\n')
  ok('1 a scripted memory Write shows "Memory: 1 saved" under the reply')

  // 2. View opens Agent Studio on Memory, listing the file the agent wrote (no reload)
  await page.click(tid('memory-view'))
  await page.locator(tid('memory-section')).waitFor({ timeout: T })
  await waitFor(async () => (await rows.count()) === 1, T, 'the agent-written memory to be listed')
  assert((await rows.first().textContent()).includes('teal'), 'the listed memory lacks its title')
  await waitFor(countIs(1, 100), T, 'the count to read 1 of 100')
  await waitFor(
    async () => ((await read(join(memDir, 'MEMORY.md'))) ?? '').includes('user_teal.md'),
    T,
    'MEMORY.md to be repaired with user_teal.md'
  )
  // The section scrolls with the form, below the fold, so View must scroll to it.
  const memoryInView = () =>
    page.locator(tid('memory-section')).evaluate((e) => {
      const r = e.getBoundingClientRect()
      return r.top >= 0 && r.top < innerHeight
    })
  await waitFor(memoryInView, T, 'View to scroll Agent Studio to the Memory section')
  ok('2 View opens Agent Studio scrolled to the Memory section with the file listed; MEMORY.md repaired')

  // 3. add by hand
  await page.click(tid('memory-new'))
  const ed = page.locator(tid('memory-editor'))
  await ed.waitFor({ timeout: T })
  await ed.locator('label:has-text("Title") input').fill('Prefers short answers')
  await ed.locator('label:has-text("Description") input').fill('Reply style')
  await pickOption(ed.locator('label:has-text("Type") .search-select'), 'feedback')
  await ed.locator('textarea').fill('Keep replies short.')
  await page.click(tid('memory-save'))
  await waitFor(countIs(2, 100), T, 'the count to read 2 of 100')
  const fs1 = await files(memDir)
  assert(fs1.length === 2 && fs1.includes('feedback_prefers_short_answers.md'), `the files are ${fs1.join(',')}`)
  const created = (await read(join(memDir, 'feedback_prefers_short_answers.md'))) ?? ''
  assert(created.includes('Keep replies short.') && created.includes('type: feedback'), `the new file reads ${JSON.stringify(created)}`)
  assert(((await read(join(memDir, 'MEMORY.md'))) ?? '').includes('feedback_prefers_short_answers.md'), 'MEMORY.md lacks the new memory')
  ok('3 New memory writes the file and a MEMORY.md line')

  // 4. edit
  await rows.filter({ hasText: 'Prefers short answers' }).locator('.memory-open').click()
  await ed.waitFor({ timeout: T })
  await ed.locator('textarea').fill('Keep replies very short.')
  await page.click(tid('memory-save'))
  await waitFor(
    async () => ((await read(join(memDir, 'feedback_prefers_short_answers.md'))) ?? '').includes('very short'),
    T,
    'the edit to reach the file'
  )
  ok('4 editing a memory rewrites its file')

  // 5. search
  await page.fill(tid('memory-search'), 'teal')
  await waitFor(async () => (await rows.count()) === 1, T, 'search to narrow to one row')
  assert((await rows.first().textContent()).includes('teal'), 'the search kept the wrong row')
  await page.fill(tid('memory-search'), 'zzzz')
  await waitFor(async () => (await rows.count()) === 0, T, 'search to find nothing')
  await page.fill(tid('memory-search'), '')
  await waitFor(async () => (await rows.count()) === 2, T, 'search to clear')
  ok('5 search narrows the list and clears')

  // 6. delete (to the Trash)
  await rows.filter({ hasText: 'Prefers short answers' }).locator('.memory-open').click()
  await ed.waitFor({ timeout: T })
  await page.click(tid('memory-delete'))
  await page.getByRole('button', { name: 'Move to Trash', exact: true }).click()
  await waitFor(countIs(1, 100), T, 'the count to fall to 1')
  const fs2 = await files(memDir)
  assert(fs2.join(',') === 'user_teal.md', `the files are ${fs2.join(',')}`)
  assert(
    !((await read(join(memDir, 'MEMORY.md'))) ?? '').includes('feedback_prefers_short_answers.md'),
    'MEMORY.md still lists the deleted memory'
  )
  ok('6 Delete moves the file away and drops its MEMORY.md line')

  // 7. the cap: limit 25 with 25 files hides New memory
  for (let i = 0; i < 24; i++)
    await writeFile(
      join(memDir, `reference_n${String(i).padStart(2, '0')}.md`),
      memFile(`n${i}`, `Note ${i}`, 'reference', `Note body ${i}.`)
    )
  await waitFor(countIs(25, 100), 30_000, 'the watcher to show 25 memories')
  await pickOption(page.locator(tid('memory-limit')), '25')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await waitFor(countIs(25, 25), T, 'the count to read 25 of 25')
  await waitFor(async () => (await page.locator(tid('memory-new')).count()) === 0, T, 'New memory to be hidden at the cap')
  assert((await readFile(join(agentsDir, `${AGENT}.md`), 'utf8')).includes('memoryLimit: 25'), 'the agent file lacks memoryLimit: 25')
  ok('7 limit 25 with 25 memories hides New memory')

  // 8. rename the agent in the editor: the memory folder moves
  await page.locator('#agent-name').fill('mem2')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await waitFor(async () => (await files(movedDir)).length === 25, 30_000, 'the memory folder to move to mem2')
  await waitFor(async () => (await files(memDir)).length === 0, T, 'the old memory folder to be empty')
  await waitFor(countIs(25, 25), T, 'the list to follow the rename')
  ok('8 renaming the agent moves its memory folder')

  // The index repair logs a count line (never memory text) when it adds lines for files written outside the app.
  const bad = unexpectedErrors(h.errors, [/^server stderr: memory: added \d+ missing index line\(s\) for mem$/])
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
console.log(failed ? 'e2e:memory FAILED' : 'e2e:memory passed')
process.exit(failed ? 1 : 0)
