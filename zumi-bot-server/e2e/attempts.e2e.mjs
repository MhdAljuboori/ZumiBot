// End-to-end check of parallel attempts in the built server + web UI against the FAKE claude: no real CLI turn is ever
// sent, so no login or quota is used. Usage: npm run e2e:attempts   (builds first)
//
// The flow: a temp git repo whose "Isolate in worktree" toggle is on; a card made in a chat there; Run attempts… with
// two agents; one chat and one worktree per attempt, both branched from the same commit and both sent the card with
// "attempt n of 2"; each row shows its state, its files since base and its cost; Compare puts the two diffs side by
// side; Keep this one gives the card to the winner, moves it to In review and archives the other, whose clean worktree
// is then released.
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs made here are deleted, in `finally`: the repo sits one level inside its own mkdtemp dir, so
//    every sibling `<repo>-<slug>` worktree lands inside that dir too;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 4 min.
//
// DOM hooks relied on (data-testid): todo-board, board-card (+ data-todo-id), board-card-open, board-drawer, todo-card,
//   todo-run-attempts, attempts-dialog, attempt-pick-agent, attempt-pick-add, attempt-pick-drop, attempt-cost,
//   attempt-folder, attempts-run, todo-attempts, attempt-row (+ data-state, data-agent), attempt-pick, attempt-state,
//   attempt-changes, attempt-keep, attempt-kept, attempts-compare, attempt-compare, compare-side, compare-row,
//   attempts-cancel, todo-card-status-select.
// Stored state read: <dataDir>/chats.json, <dataDir>/todos.json.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { start, unexpectedErrors, pickOption } from './harness.mjs'

const run = promisify(execFile)
const BASIC = fileURLToPath(new URL('../backend/tests/fixtures/stream/basic.jsonl', import.meta.url))
const ONE = 'e2e-attempt-one'
const TWO = 'e2e-attempt-two'
const PREFIX = 'zumibot-e2e-attempts-'
const OVERALL_TIMEOUT = 4 * 60_000
const T = 20_000

let h = null
const made = []
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const chatsOf = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats
const metaOf = async (chatId) => (await chatsOf()).find((c) => c.id === chatId)
const boardOf = async () => readFile(join(h.dataDir, 'todos.json'), 'utf8').then(JSON.parse)
const cardOf = async (id) => (await boardOf()).items.find((i) => i.id === id)
const git = (cwd, ...args) => run('git', args, { cwd }).then((r) => r.stdout.trim())

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

const replyWith = async (word) => writeFile(h.script, (await readFile(BASIC, 'utf8')).replaceAll('pong', word))

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  const base = await mk('base')
  for (const name of [ONE, TWO]) {
    await writeFile(
      join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: Attempts e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
    )
  }

  // 1. a temp repo with one commit
  const repo = join(base, 'repo')
  await mkdir(repo, { recursive: true })
  await writeFile(join(repo, 'app.ts'), 'export const sum = 1 + 1\n')
  await git(repo, 'init', '-b', 'main')
  await git(repo, 'add', '.')
  await git(repo, '-c', 'user.email=e2e@example.test', '-c', 'user.name=e2e', 'commit', '-m', 'first')
  const head = await git(repo, 'rev-parse', 'HEAD')
  ok(`1 temp repo ${repo} at ${head.slice(0, 7)}`)

  h = await start({ fake: true, dataDir, agentsDir })
  await replyWith('attempt-reply')
  const page = h.page
  await page.locator(`${tid('agent-row')}[data-agent-name="${ONE}"]`).waitFor({ timeout: 30_000 })

  // 2. the toggle on, and a card made in a chat there (so the card's folder is the repo)
  await rpc(page, 'app:setWorktreeFolder', repo, true)
  const home = await rpc(page, 'chats:create', ONE, repo)
  assert(home.worktree, 'the chat in the repo got no worktree')
  await rpc(page, 'todos:add', 'Make the sum right', home.id)
  const cardId = (await boardOf()).items.at(-1).id
  ok('2 the toggle is on and a card was made in a chat in the repo')

  // 3. Run attempts…: two agents, the cost line, and the folder line
  await page.goto(`${h.origin}/todos/${cardId}`)
  await page.locator(tid('board-drawer')).waitFor({ timeout: T })
  await page.locator(tid('todo-run-attempts')).click()
  const dialog = page.locator(tid('attempts-dialog'))
  await dialog.waitFor({ timeout: T })
  const picks = dialog.locator(tid('attempt-pick-agent'))
  await waitFor(async () => (await picks.count()) === 2, T, 'two picks to start with')
  await pickOption(picks.nth(0), ONE)
  await pickOption(picks.nth(1), TWO)
  const cost = await dialog.locator(tid('attempt-cost')).textContent()
  assert(cost.includes('2× the cost of one'), `the cost line reads ${JSON.stringify(cost)}`)
  const folderLine = await dialog.locator(tid('attempt-folder')).textContent()
  assert(folderLine.includes(repo) && folderLine.includes('commit it is on now'), `the folder line reads ${JSON.stringify(folderLine)}`)
  // Five at most, two at least.
  await dialog.locator(tid('attempt-pick-add')).click()
  await waitFor(async () => (await picks.count()) === 3, T, 'a third pick')
  await dialog.locator(tid('attempt-pick-drop')).last().click()
  await waitFor(async () => (await picks.count()) === 2, T, 'back to two picks')
  await dialog.locator(tid('attempts-run')).click()
  await dialog.waitFor({ state: 'detached', timeout: T })
  ok('3 the dialog took two agents, said 2× the cost and named the folder')

  // 4. one chat and one worktree per attempt, both from the same commit, both sent the card
  await waitFor(async () => (await cardOf(cardId))?.attempts?.attempts?.length === 2, T, 'two attempts on the card')
  const set = (await cardOf(cardId)).attempts
  assert(set.base === head, `the set's base is ${set.base}, not ${head}`)
  assert(set.folder === repo, `the set's folder is ${set.folder}`)
  const metas = await Promise.all(set.attempts.map((a) => metaOf(a.chatId)))
  const roots = metas.map((m) => m.worktree.root)
  assert(new Set(roots).size === 2, `the attempts share a worktree: ${JSON.stringify(roots)}`)
  for (const m of metas) {
    assert(existsSync(m.worktree.root), `${m.worktree.root} was not made`)
    assert(m.worktree.base === head, `${m.worktree.branch} starts at ${m.worktree.base}`)
    assert((await git(m.worktree.root, 'rev-parse', 'HEAD')) === head, `${m.worktree.branch} is not at the base`)
    assert(!m.task, "an attempt chat was linked as the card's task chat")
  }
  assert((await cardOf(cardId)).status === 'progress', 'the card is not In progress while its attempts run')
  // Each was told which of how many it is.
  const first = await rpc(page, 'chats:items', set.attempts[0].chatId)
  const sent = (first.items ?? first).filter((i) => i.type === 'user').at(-1)
  assert(sent.text.includes('attempt 1 of 2'), `attempt 1 was told ${JSON.stringify(sent.text.slice(0, 120))}`)
  assert(sent.text.includes('Make the sum right'), 'the card was not sent to the attempt')
  ok(`4 two chats, two worktrees, both branched from ${head.slice(0, 7)}, each told its place`)

  // 5. the rows: state, and the files each attempt changed since its base
  await page.goto(`${h.origin}/todos/${cardId}`)
  const rows = page.locator(tid('attempt-row'))
  await waitFor(async () => (await rows.count()) === 2, T, 'two attempt rows')
  // One attempt commits, the other leaves its work uncommitted: both count since base.
  await writeFile(join(metas[0].worktree.root, 'app.ts'), 'export const sum = 2 + 2\n')
  await git(metas[0].worktree.root, '-c', 'user.email=e2e@example.test', '-c', 'user.name=e2e', 'commit', '-qam', 'fix')
  await writeFile(join(metas[1].worktree.root, 'app.ts'), 'export const sum = 3 + 3\nexport const extra = true\n')
  await page.reload()
  await waitFor(async () => (await rows.count()) === 2, T, 'the rows after a reload')
  await waitFor(
    async () => {
      const texts = await page.locator(tid('attempt-changes')).allTextContents()
      return texts.every((t) => t.includes('file'))
    },
    T,
    'both rows to count their files since base'
  )
  const counts = await page.locator(tid('attempt-changes')).allTextContents()
  assert(counts[0].startsWith('1 file'), `attempt 1 counts ${JSON.stringify(counts[0])} (a committed change must still count)`)
  assert(counts[1].startsWith('1 file'), `attempt 2 counts ${JSON.stringify(counts[1])}`)
  ok(`5 the rows count what each attempt changed since the base: ${JSON.stringify(counts)}`)

  // 6. Compare: both diffs side by side
  const ticks = page.locator(tid('attempt-pick'))
  await ticks.nth(0).check()
  await ticks.nth(1).check()
  await page.locator(tid('attempts-compare')).click()
  const compare = page.locator(tid('attempt-compare'))
  await compare.waitFor({ timeout: T })
  await waitFor(async () => (await compare.locator(tid('compare-side')).count()) === 2, T, 'two sides')
  await waitFor(async () => (await compare.locator(`${tid('compare-row')}[data-path="app.ts"]`).count()) === 2, T, 'app.ts on both sides')
  await compare
    .locator(`${tid('compare-row')}[data-path="app.ts"]`)
    .first()
    .click()
  await compare
    .locator(`${tid('diff-row')}[data-kind="add"]`)
    .first()
    .waitFor({ timeout: T })
  await page.keyboard.press('Escape')
  await compare.waitFor({ state: 'detached', timeout: T })
  ok("6 Compare showed both attempts' diffs of app.ts side by side")

  // 7. Keep this one: the card goes to the winner, the other chat is archived and its clean worktree released
  await writeFile(join(metas[1].worktree.root, 'app.ts'), 'export const sum = 1 + 1\n') // clean again, so its release can remove it
  await page.locator(`${tid('attempt-row')}[data-agent="${ONE}"] ${tid('attempt-keep')}`).click()
  await waitFor(async () => (await cardOf(cardId))?.attempts?.winner === set.attempts[0].chatId, T, 'the winner on the card')
  const card = await cardOf(cardId)
  assert(card.assignee === ONE, `the card went to ${card.assignee}`)
  assert(card.task?.chatId === set.attempts[0].chatId, "the winner is not the card's task chat")
  assert(card.status === 'review', `the card is ${card.status}, not In review`)
  await waitFor(async () => (await metaOf(set.attempts[1].chatId))?.archivedAt !== undefined, T, 'the other attempt archived')
  assert((await metaOf(set.attempts[0].chatId)).archivedAt === undefined, 'the winner was archived')
  await waitFor(
    async () => (await metaOf(set.attempts[1].chatId))?.worktree?.removed === true,
    30_000,
    "the loser's clean worktree released"
  )
  assert(existsSync(metas[0].worktree.root), "the winner's worktree was removed")
  assert(
    (await git(repo, 'branch', '--list', metas[1].worktree.branch)).includes(metas[1].worktree.branch),
    "the loser's branch was deleted"
  )
  await page.locator(tid('attempt-kept')).waitFor({ timeout: T })
  ok('7 Keep this one gave the card to the winner, archived the other and released its folder, keeping the branch')

  // 8. nothing unexpected
  const bad = unexpectedErrors(h.errors, [])
  assert(bad.length === 0, `unexpected console/server errors:\n${bad.join('\n')}`)
  ok('no unexpected console or server errors')
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
  if (process.env.E2E_SHOT && h?.page) await h.page.screenshot({ path: process.env.E2E_SHOT }).catch(() => {})
} finally {
  await stop()
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
console.log(failed ? 'e2e:attempts FAILED' : 'e2e:attempts passed')
process.exit(failed ? 1 : 0)
