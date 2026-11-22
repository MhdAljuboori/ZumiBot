// End-to-end check of pull requests and CI in the built server + web UI against the FAKE claude and a FAKE gh
// (`backend/tests/fixtures/fake-gh.mjs` on the server's PATH, driven by a JSON state file this suite rewrites while the
// server keeps running). No real GitHub and no real remote: `origin` is a bare repo in the same temp dir.
// Usage: npm run e2e:github   (builds first). E2E_SHOT=<path> writes a screenshot of the page when it fails.
//
// The flow: a card given to an agent makes its task chat in a worktree; while gh is signed out the panel says so and
// offers nothing; signed in, Open PR… shows the branch, its commits and a title and body drafted from the card; Create
// pushes the branch to the bare remote and opens the PR, which then shows on the chat's chip and on the card; a failing
// check appears on a Refresh, and Send to agent posts it with the tail of its log as an ordinary user message.
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs made here are deleted, in `finally`; the repo sits one level inside its own mkdtemp dir, so
//    every sibling `<repo>-<slug>` worktree lands inside it too;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 4 min.
//
// DOM hooks relied on (data-testid): chat-git, chat-pr, chat-pr-checks, changes-panel, changes-pr, pr-open, pr-gh-note,
//   pr-dialog, pr-branch, pr-commits, pr-title, pr-body, pr-create, pr-refusal, pr-box, pr-link, pr-state, pr-checks,
//   pr-refresh, pr-failing-row, pr-send-check, todo-card-pr, board-drawer, todo-card-open-chat, user-message.
// Stored state read: <dataDir>/chats.json (pr), <dataDir>/todos.json (the card's mirror).

import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { start, unexpectedErrors } from './harness.mjs'

const run = promisify(execFile)
const FAKE_GH = fileURLToPath(new URL('../backend/tests/fixtures/fake-gh.mjs', import.meta.url))
const BASIC = fileURLToPath(new URL('../backend/tests/fixtures/stream/basic.jsonl', import.meta.url))
const AGENT = 'e2e-pr-agent'
const PREFIX = 'zumibot-e2e-github-'
const OVERALL_TIMEOUT = 4 * 60_000
const T = 20_000

let h = null
let ghState = null
const made = []
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const git = (cwd, ...args) => run('git', args, { cwd }).then((r) => r.stdout.trim())
const chatsOf = async () => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats
const metaOf = async (id) => (await chatsOf()).find((c) => c.id === id)
const cardOf = async (id) => (await readFile(join(h.dataDir, 'todos.json'), 'utf8').then(JSON.parse)).items.find((i) => i.id === id)
const setGh = (patch) => writeFile(ghState, JSON.stringify(patch))

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

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  const base = await mk('base')
  const binDir = await mk('bin')
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: PR e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )

  // 1. a temp repo pushed to a bare "origin" in the same temp dir: no real remote is ever touched
  const remote = join(base, 'remote.git')
  await git(base, 'init', '--bare', '-b', 'main', remote)
  const repo = join(base, 'repo')
  await mkdir(repo, { recursive: true })
  await writeFile(join(repo, 'app.ts'), 'export const sum = 1 + 1\n')
  await git(repo, 'init', '-b', 'main')
  await git(repo, 'remote', 'add', 'origin', remote)
  await git(repo, 'add', '.')
  await git(repo, '-c', 'user.email=e2e@example.test', '-c', 'user.name=e2e', 'commit', '-m', 'first')
  await git(repo, 'push', '-u', 'origin', 'main')

  // The fake gh goes on the server's PATH, with a state file this suite rewrites as it goes.
  ghState = join(binDir, 'gh-state.json')
  await setGh({ auth: 'out' })
  await writeFile(join(binDir, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_GH}" "$@"\n`)
  await chmod(join(binDir, 'gh'), 0o755)
  ok(`1 temp repo ${repo} with a bare origin, and a fake gh on PATH`)

  h = await start({
    fake: true,
    dataDir,
    agentsDir,
    env: { PATH: `${binDir}:${process.env.PATH}`, FAKE_GH_STATE: ghState, FAKE_GH_CALLS: join(binDir, 'calls.jsonl') }
  })
  await writeFile(h.script, (await readFile(BASIC, 'utf8')).replaceAll('pong', 'on it'))
  const page = h.page
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })

  // 2. a card given to the agent: its task chat runs in a worktree of the repo
  await rpc(page, 'app:setWorktreeFolder', repo, true)
  await rpc(page, 'todos:add', 'Make the sum right', null)
  const cardId = (await readFile(join(h.dataDir, 'todos.json'), 'utf8').then(JSON.parse)).items.at(-1).id
  await rpc(page, 'todos:assign', cardId, AGENT, repo)
  await rpc(page, 'todos:move', cardId, 'todo')
  await waitFor(async () => (await cardOf(cardId)).task?.chatId !== undefined, T, 'the task chat')
  const chatId = (await cardOf(cardId)).task.chatId
  await waitFor(async () => (await metaOf(chatId))?.worktree?.root !== undefined, T, 'its worktree')
  const wt = (await metaOf(chatId)).worktree
  ok(`2 the card's task chat runs on ${wt.branch}`)

  // 3. the agent's work, committed on the branch
  await waitFor(async () => (await metaOf(chatId))?.inFlight === false, 30_000, 'the first turn to end')
  await writeFile(join(wt.root, 'app.ts'), 'export const sum = 2 + 2\n')
  await git(wt.root, '-c', 'user.email=e2e@example.test', '-c', 'user.name=e2e', 'commit', '-qam', 'make the sum right')

  // 4. signed out: the panel says so and offers nothing else — and never asks for a token
  await page.goto(`${h.origin}/chat/${chatId}`)
  await page.locator(tid('chat-git')).click()
  await page.locator(tid('changes-panel')).waitFor({ timeout: T })
  const note = page.locator(tid('pr-gh-note'))
  await note.waitFor({ timeout: T })
  const noteText = await note.textContent()
  assert(/not signed in/i.test(noteText), `the note reads ${JSON.stringify(noteText)}`)
  assert(!/token/i.test(noteText), 'the note asks about a token')
  assert((await page.locator(tid('pr-open')).count()) === 0, 'Open PR shows while gh is signed out')
  ok('4 signed out: "gh is installed but not signed in", and nothing else is offered')

  // 5. signed in: the dialog shows the branch, its commits and a title and body drafted from the card
  await setGh({ auth: 'in' })
  await page.reload()
  await page.locator(tid('chat-git')).click()
  await page.locator(tid('pr-open')).waitFor({ timeout: T })
  await page.locator(tid('pr-open')).click()
  const dialog = page.locator(tid('pr-dialog'))
  await dialog.waitFor({ timeout: T })
  await waitFor(async () => (await dialog.locator(tid('pr-commits')).count()) === 1, T, 'the commits')
  const branchLine = await dialog.locator(tid('pr-branch')).textContent()
  assert(branchLine.includes(wt.branch), `the branch line reads ${JSON.stringify(branchLine)}`)
  const commits = await dialog.locator(tid('pr-commits')).textContent()
  assert(commits.includes('make the sum right'), `the commits read ${JSON.stringify(commits)}`)
  assert((await dialog.locator(tid('pr-title')).inputValue()) === 'Make the sum right', 'the title is not drafted from the card')
  assert((await dialog.locator(tid('pr-refusal')).count()) === 0, 'the dialog refuses a clean branch')
  ok('5 the dialog shows the branch, its commit and a title drafted from the card')

  // 6. Create: the branch really reaches the bare remote and the PR shows on the chat and the card
  await dialog.locator(tid('pr-create')).click()
  await dialog.waitFor({ state: 'detached', timeout: T })
  await waitFor(async () => (await metaOf(chatId))?.pr?.number === 7, T, 'the PR on the chat')
  assert((await git(remote, 'rev-parse', wt.branch)) === (await git(wt.root, 'rev-parse', 'HEAD')), 'the branch did not reach the remote')
  await waitFor(async () => (await cardOf(cardId))?.pr?.number === 7, T, 'the PR mirrored on the card')
  const chip = page.locator(tid('chat-pr'))
  await chip.waitFor({ timeout: T })
  assert((await chip.textContent()).includes('#7'), `the chip reads ${JSON.stringify(await chip.textContent())}`)
  // Nothing was forced, and the default branch was never pushed to.
  const calls = (await readFile(join(binDir, 'calls.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).args)
  assert(
    calls.some((a) => a[0] === 'pr' && a[1] === 'create'),
    'gh pr create was never called'
  )
  assert(!calls.flat().includes('--force'), 'gh was called with --force')
  assert((await git(remote, 'rev-parse', 'main')) !== (await git(wt.root, 'rev-parse', 'HEAD')), 'main was pushed to')
  ok('6 the branch was pushed to the bare origin and PR #7 shows on the chat and the card')

  // 7. a failing check: Refresh shows it, and Send to agent posts it with the tail of its log
  await setGh({
    auth: 'in',
    pr: {
      number: 7,
      url: 'https://github.com/acme/app/pull/7',
      state: 'OPEN',
      isDraft: false,
      statusCheckRollup: [
        { name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/acme/app/actions/runs/1/job/22' },
        { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' }
      ]
    },
    log: 'FAIL src/sum.test.ts\n  expected 2, got 4'
  })
  await page.locator(tid('pr-refresh')).click()
  const row = page.locator(`${tid('pr-failing-row')}[data-name="unit"]`)
  await row.waitFor({ timeout: T })
  const checks = await page.locator(tid('pr-checks')).first().textContent()
  assert(checks === '1 of 2 checks failing', `the checks line reads ${JSON.stringify(checks)}`)
  await waitFor(async () => (await metaOf(chatId))?.pr?.checks?.status === 'failing', T, 'the failing checks on the chat')
  await row.locator(tid('pr-send-check')).click()
  await waitFor(
    async () => {
      const items = await readFile(join(h.dataDir, 'chats', `${chatId}.json`), 'utf8').then(JSON.parse, () => [])
      return items.some((i) => i.type === 'user' && i.text.includes('The check **unit** is failing'))
    },
    30_000,
    'the check as a user message in the chat'
  )
  const items = await readFile(join(h.dataDir, 'chats', `${chatId}.json`), 'utf8').then(JSON.parse)
  const sent = items.filter((i) => i.type === 'user').at(-1)
  assert(sent.text.includes('expected 2, got 4'), `the message does not carry the log: ${JSON.stringify(sent.text.slice(0, 200))}`)
  assert(sent.text.includes('https://github.com/acme/app/actions/runs/1/job/22'), 'the message does not link the check')
  ok('7 a failing check showed on Refresh and Send to agent posted it with the tail of its log')

  // 8. the card shows the same pull request
  await page.goto(`${h.origin}/todos/${cardId}`)
  await page.locator(tid('board-drawer')).waitFor({ timeout: T })
  const box = page.locator(`${tid('todo-card-pr')} ${tid('pr-box')}`)
  await box.waitFor({ timeout: T })
  assert((await box.locator(tid('pr-link')).textContent()) === '#7', 'the card does not show the PR')
  assert((await box.locator(tid('pr-state')).textContent()) === 'open', 'the card does not show the state')
  ok('8 the card shows the same pull request and its state')

  // 9. nothing unexpected
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
console.log(failed ? 'e2e:github FAILED' : 'e2e:github passed')
process.exit(failed ? 1 : 0)
