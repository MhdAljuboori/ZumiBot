// End-to-end check of "git worktree per chat" in the built server + web UI against the FAKE claude: no real CLI turn
// is ever sent, so no login or quota is used. Usage: npm run e2e:worktrees   (builds first)
//
// Hard rules enforced here:
//  - nothing in ~/.claude is touched: the harness gives the server a throwaway HOME, agents dir and data dir;
//  - only the mkdtemp dirs created here (plus the harness's own temp root) are ever deleted, in `finally`: the temp repo lives one
//    level inside its own mkdtemp dir, so the sibling `<repo>-<slug>` worktree lands inside that dir too;
//  - the server and Chrome started here are stopped in `finally`; overall timeout 3 min.
// The repo's own `git commit` needs a local identity (the server's HOME is empty); the server's `worktree add` needs none.
// Chats are made over a raw /ws RPC; the new-chat screen is driven through the UI.
//
// DOM hooks relied on (data-testid): chat-git, chat-git-dirty, archived-note, archived-worktree, new-chat, new-chat-agent,
//   new-chat-agent-option (+ data-agent-name), new-chat-folder, new-chat-folder-option (+ data-cwd), new-chat-worktree,
//   new-chat-folder-worktree, changes-panel, change-row (+ data-path, data-kind), changes-count, changes-scope-uncommitted,
//   changes-scope-base, diff-row (+ data-kind, data-row), selection-menu, selection-comment, review-form-text, review-add,
//   review-bar, review-toggle, review-row, review-edit, review-delete, review-send, review-dot, changes-agent-tree.
// Stored state read: <dataDir>/chats.json (worktree: root, kept, removed), <dataDir>/chats/<id>.json (items).

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { start, unexpectedErrors } from './harness.mjs'

const run = promisify(execFile)
const BASIC = fileURLToPath(new URL('../backend/tests/fixtures/stream/basic.jsonl', import.meta.url))
const AGENT = 'e2e-worktrees-agent'
const PREFIX = 'zumibot-e2e-worktrees-'
const OVERALL_TIMEOUT = 3 * 60_000
const T = 15_000

let h = null
const made = [] // every mkdtemp dir made here
const t0 = Date.now()
const ok = (m) => console.log(`ok ${m}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tid = (id) => `[data-testid="${id}"]`
const metaOf = async (chatId) => (await readFile(join(h.dataDir, 'chats.json'), 'utf8').then(JSON.parse)).chats.find((c) => c.id === chatId)
const itemsOf = async (id) => readFile(join(h.dataDir, 'chats', `${id}.json`), 'utf8').then(JSON.parse, () => [])
const git = (cwd, ...args) => run('git', args, { cwd }).then((r) => r.stdout.trim())
const isLink = (p) =>
  lstat(p).then(
    (s) => s.isSymbolicLink(),
    () => false
  )

/** A real mouse drag from the start of one diff line's text to the end of another's, as the Files e2e does. */
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

// The next turn of the fake claude replies with `word` instead of "pong".
const replyWith = async (word) => writeFile(h.script, (await readFile(BASIC, 'utf8')).replaceAll('pong', word))

async function waitReply(chatId, word) {
  await waitFor(
    async () => {
      const m = await metaOf(chatId)
      return m && !m.inFlight && (await itemsOf(chatId)).some((i) => i.type === 'assistant' && i.text.includes(word))
    },
    30_000,
    `the reply "${word}" in ${chatId}`
  )
}

async function main() {
  const mk = async (n) => (made.push(await mkdtemp(join(tmpdir(), `${PREFIX}${n}-`))), made.at(-1))
  const dataDir = await mk('data')
  const agentsDir = await mk('agents')
  const plain = await realpath(await mk('plain')) // a folder that is not a git repo
  const base = await realpath(await mk('base'))
  await writeFile(
    join(agentsDir, `${AGENT}.md`),
    `---\nname: ${AGENT}\ndescription: Worktrees e2e agent.\nmodel: haiku\n---\nYou are a test agent.\n`
  )

  // 1. a temp repo with one commit, and an ignored angular/node_modules
  const repo = join(base, 'repo')
  await mkdir(join(repo, 'angular', 'node_modules'), { recursive: true })
  await writeFile(join(repo, 'angular', '.gitignore'), '/node_modules\n')
  await writeFile(join(repo, 'angular', 'node_modules', 'x'), 'x\n')
  await writeFile(join(repo, 'README.md'), 'hello\n')
  await git(repo, 'init', '-b', 'main')
  await git(repo, 'add', '.')
  await git(repo, '-c', 'user.email=e2e@example.test', '-c', 'user.name=e2e', 'commit', '-m', 'first')
  assert((await git(repo, 'ls-files', 'angular/node_modules')) === '', 'node_modules got committed')
  ok(`1 temp repo ${repo} with one commit and an ignored angular/node_modules`)

  h = await start({ fake: true, dataDir, agentsDir })
  const page = h.page
  await page.locator(`${tid('agent-row')}[data-agent-name="${AGENT}"]`).waitFor({ timeout: 30_000 })

  // 2. toggle on over RPC, then a chat in repo/angular runs in a sibling worktree
  await rpc(page, 'app:setWorktreeFolder', repo, true)
  const gf = await rpc(page, 'app:gitFolder', join(repo, 'angular'))
  assert(gf.repo === true && gf.worktree === true, `app:gitFolder reads ${JSON.stringify(gf)}`)
  const meta = await rpc(page, 'chats:create', AGENT, join(repo, 'angular'))
  const A = meta.id
  const wt = meta.worktree
  assert(wt && meta.cwd.startsWith(`${repo}-`), `cwd ${meta.cwd} is not under ${repo}-`)
  assert(meta.cwd === join(wt.root, 'angular'), `cwd ${meta.cwd} is not the angular subfolder of ${wt.root}`)
  assert(existsSync(wt.root), 'the worktree folder does not exist')
  assert(wt.folder === join(repo, 'angular'), `worktree.folder is ${wt.folder}`)
  const branches = await git(repo, 'branch', '--list', 'zumibot/*')
  assert(branches.includes(wt.branch), `git branch lists ${JSON.stringify(branches)}, not ${wt.branch}`)
  assert(await isLink(join(wt.root, 'angular', 'node_modules')), 'angular/node_modules is not a symlink')
  ok(`2 chats:create made ${wt.root} on ${wt.branch} with angular/node_modules linked`)

  // 3. the chip shows the branch, and nothing is dirty yet
  await page.goto(`${h.origin}/chat/${A}`)
  const chip = page.locator(tid('chat-git'))
  await chip.waitFor({ timeout: T })
  assert((await chip.textContent()).includes('zumibot/'), `chip reads ${JSON.stringify(await chip.textContent())}`)
  assert((await page.locator(tid('chat-git-dirty')).count()) === 0, 'the dirty dot shows on a clean worktree')
  ok('3 the chip shows zumibot/... with no dirty dot')

  // 4. a file in the worktree, then a turn: the dot appears once the reply ends
  await writeFile(join(wt.root, 'notes.md'), 'scratch\n')
  await replyWith('wt-reply-one')
  await rpc(page, 'chats:send', A, 'hello')
  await waitReply(A, 'wt-reply-one')
  await page.locator(tid('chat-git-dirty')).waitFor({ timeout: T })
  ok('4 notes.md in the worktree and a finished turn: the dirty dot shows')

  // 4b. the chip opens the side panel's Changes: each file, its diff in syntax colours; a second click closes it
  await writeFile(join(wt.root, 'README.md'), 'hello\nworld\n')
  await writeFile(join(wt.root, 'angular', 'app.ts'), 'export const answer = 42\n')
  await page.dispatchEvent('body', 'focus') // nothing else changed here: the list is read when the panel opens
  await chip.click()
  const panel = page.locator(tid('changes-panel'))
  await panel.waitFor({ timeout: T })
  assert((await chip.getAttribute('aria-pressed')) === 'true', 'the chip does not read pressed while Changes shows')
  const rows = panel.locator(tid('change-row'))
  await waitFor(async () => (await rows.count()) === 3, T, 'three changed files')
  const listed = await rows.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-kind')} ${e.getAttribute('data-path')}`))
  // Sorted by path, as git sorts: uppercase first.
  assert(
    JSON.stringify(listed) === JSON.stringify(['modified README.md', 'untracked angular/app.ts', 'untracked notes.md']),
    `rows read ${JSON.stringify(listed)}`
  )
  assert((await panel.locator(tid('changes-count')).textContent()) === '3 files changed', 'the summary does not count 3 files')
  // README.md is first, so it shows without a pick: one added line.
  await panel
    .locator(`${tid('diff-row')}[data-kind="add"]`)
    .filter({ hasText: 'world' })
    .waitFor({ timeout: T })
  await panel.locator(`${tid('change-row')}[data-path="angular/app.ts"]`).click()
  await panel
    .locator(`${tid('diff-row')}[data-kind="add"] .tk-kw`)
    .filter({ hasText: 'export' })
    .waitFor({ timeout: T })
  await panel
    .locator(`${tid('diff-row')}[data-kind="add"] .tk-num`)
    .filter({ hasText: '42' })
    .waitFor({ timeout: T })
  await chip.click()
  await panel.waitFor({ state: 'detached', timeout: T })
  await run('git', ['checkout', '--', 'README.md'], { cwd: wt.root })
  await rm(join(wt.root, 'angular', 'app.ts'))
  ok('4b the chip opens Changes: README.md, angular/app.ts, notes.md listed, app.ts in syntax colours; a second click closes it')

  // 4c. Since start shows work the agent already committed, which Uncommitted does not
  await writeFile(join(wt.root, 'committed.ts'), 'export const one = 1\nexport const two = 2\n')
  await git(wt.root, 'add', 'committed.ts')
  await git(wt.root, '-c', 'user.email=e2e@example.test', '-c', 'user.name=e2e', 'commit', '-m', 'agent work')
  await page.dispatchEvent('body', 'focus')
  await chip.click()
  await panel.waitFor({ timeout: T })
  await waitFor(async () => (await rows.count()) === 1, T, 'only notes.md left uncommitted')
  await panel.locator(tid('changes-scope-base')).click()
  await waitFor(async () => (await rows.count()) === 2, T, 'committed.ts and notes.md since start')
  const since = await rows.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-kind')} ${e.getAttribute('data-path')}`))
  assert(
    JSON.stringify(since) === JSON.stringify(['added committed.ts', 'untracked notes.md']),
    `Since start reads ${JSON.stringify(since)}`
  )
  ok('4c "Since start" lists the committed file as added; "Uncommitted" does not list it at all')

  // 4d. a comment on the committed file's lines: added, edited, deleted, and kept across a reload
  await panel.locator(`${tid('change-row')}[data-path="committed.ts"]`).click()
  await panel
    .locator(`${tid('diff-row')}[data-kind="add"]`)
    .first()
    .waitFor({ timeout: T })
  await dragLines(page, 1, 2) // row 0 is the hunk header: rows 1 and 2 are the file's two lines
  await page.locator(tid('selection-comment')).click()
  await page.locator(tid('review-form-text')).fill('Fold these into one export.')
  await page.locator(tid('review-add')).click()
  const bar = page.locator(tid('review-bar'))
  await bar.waitFor({ timeout: T })
  await waitFor(async () => (await bar.textContent()).includes('1 comment'), T, 'the bar to count one comment')
  const rowWhere = page.locator(tid('review-row')).first().locator('.review-row-where')
  assert((await rowWhere.textContent()) === 'committed.ts:1-2', `the comment sits at ${JSON.stringify(await rowWhere.textContent())}`)
  await waitFor(async () => (await panel.locator(tid('review-dot')).count()) === 1, T, 'the file row to mark its one comment')
  // Edit it, then add a second and delete that one again.
  await page.locator(tid('review-edit')).first().click()
  await page.locator(tid('review-form-text')).fill('Fold these into one export, please.')
  await page.locator(tid('review-add')).click()
  await waitFor(
    async () => (await page.locator(tid('review-row')).first().textContent()).includes('Fold these into one export, please.'),
    T,
    'the edited text'
  )
  await dragLines(page, 1, 1)
  await page.locator(tid('selection-comment')).click()
  await page.locator(tid('review-form-text')).fill('Second thought.')
  await page.locator(tid('review-add')).click()
  await waitFor(async () => (await bar.textContent()).includes('2 comments'), T, 'the bar to count two comments')
  await page.locator(tid('review-row')).filter({ hasText: 'Second thought.' }).locator(tid('review-delete')).click()
  await waitFor(async () => (await bar.textContent()).includes('1 comment'), T, 'the bar back to one comment')
  // A reload keeps the draft: it is this device's, in localStorage.
  await page.reload()
  await chip.waitFor({ timeout: T })
  await chip.click()
  await panel.waitFor({ timeout: T })
  await bar.waitFor({ timeout: T })
  await page.locator(tid('review-toggle')).click()
  await waitFor(async () => (await page.locator(tid('review-row')).count()) === 1, T, 'the kept comment after a reload')
  assert(
    (await page.locator(tid('review-row')).first().textContent()).includes('committed.ts:1-2'),
    'the kept comment is not the edited one'
  )
  ok('4d a comment on committed.ts:1-2 added, edited, a second deleted, and the draft kept across a reload')

  // 4e. Send review posts one ordinary user turn with the range, the quoted lines and the text, and clears the draft
  await replyWith('wt-review-seen')
  await page.locator(tid('review-send')).click()
  await bar.waitFor({ state: 'detached', timeout: T })
  await waitReply(A, 'wt-review-seen')
  const sent = (await itemsOf(A)).filter((i) => i.type === 'user').at(-1)
  assert(sent.text.startsWith('Review of 1 place in the changes.'), `the review message reads ${JSON.stringify(sent.text.slice(0, 80))}`)
  assert(sent.text.includes('`committed.ts:1-2` (since start)'), 'the message does not name the range and the base diff')
  assert(sent.text.includes('export const one = 1'), 'the message does not quote the lines')
  assert(sent.text.includes('Fold these into one export, please.'), 'the message does not carry the comment')
  // Sent and cleared: a reload brings back no draft.
  await page.reload()
  await chip.waitFor({ timeout: T })
  await chip.click()
  await panel.waitFor({ timeout: T })
  assert((await page.locator(tid('review-bar')).count()) === 0, 'the draft came back after it was sent')
  await chip.click()
  await panel.waitFor({ state: 'detached', timeout: T })
  // Back to just notes.md uncommitted, as step 5 expects.
  await git(wt.root, 'reset', '--hard', 'HEAD~1')
  ok('4e Send review posted the comments as one user turn and cleared the draft')

  // 5. archive keeps the dirty folder and says why
  await rpc(page, 'chats:archive', A, true)
  await waitFor(async () => (await metaOf(A)).worktree?.kept === 'dirty', T, 'release to keep the dirty worktree')
  assert(existsSync(wt.root), 'archive removed a dirty worktree')
  await page.goto(`${h.origin}/archived/${A}`)
  const line = page.locator(tid('archived-worktree'))
  await line.waitFor({ timeout: T })
  assert(
    (await line.textContent()) === 'Its worktree was kept: uncommitted changes.',
    `note reads ${JSON.stringify(await line.textContent())}`
  )
  ok('5 archive kept the folder: "Its worktree was kept: uncommitted changes."')

  // 6. clean it, archive again: the folder goes, the branch stays
  await rm(join(wt.root, 'notes.md'))
  await rpc(page, 'chats:archive', A, false)
  await rpc(page, 'chats:archive', A, true)
  await waitFor(async () => (await metaOf(A)).worktree?.removed === true, 30_000, 'release to remove the clean worktree')
  assert(!existsSync(wt.root), 'the clean worktree folder is still there')
  assert((await git(repo, 'branch', '--list', wt.branch)).includes(wt.branch), 'the branch was deleted')
  await page.goto(`${h.origin}/archived/${A}`)
  await line.waitFor({ timeout: T })
  const want = `Its worktree folder was removed. Branch ${wt.branch} is kept.`
  await waitFor(async () => (await line.textContent()) === want, T, `the note "${want}"`)
  ok('6 clean archive removed the folder, kept the branch, and the note says so')

  // 7. a message unarchives and rebuilds the folder before the turn
  await replyWith('wt-reply-two')
  await rpc(page, 'chats:send', A, 'again')
  await waitReply(A, 'wt-reply-two')
  assert(existsSync(meta.cwd), `the folder ${meta.cwd} was not rebuilt`)
  assert((await metaOf(A)).worktree?.removed !== true, 'removed is still set after the turn')
  assert(await isLink(join(wt.root, 'angular', 'node_modules')), 'the rebuilt worktree has no node_modules link')
  ok('7 send unarchived the chat, rebuilt the folder, and the reply arrived')

  // 8. the new-chat screen: repo folder -> toggle on; non-repo folder -> toggle disabled
  const plainChat = (await rpc(page, 'chats:create', AGENT, plain)).id // puts the folder under Recent
  assert((await metaOf(plainChat)).worktree === undefined, 'a chat outside a repo got a worktree')
  await page.goto(h.origin)
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-agent')).click()
  await page.locator(`${tid('new-chat-agent-option')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(`${tid('new-chat-folder-option')}[data-cwd="${join(repo, 'angular')}"]`).click()
  await page.locator(tid('new-chat-folder-worktree')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-folder')).click()
  const toggle = page.locator(tid('new-chat-worktree'))
  await toggle.waitFor({ timeout: T })
  await waitFor(async () => (await toggle.getAttribute('aria-checked')) === 'true', T, 'the toggle to be checked for the repo')
  assert(await toggle.isEnabled(), 'the toggle is disabled inside a repo')
  ok('8a new-chat: the repo folder shows the checked toggle and the branch mark on the folder chip')

  await page.goto(h.origin)
  await page.locator(tid('new-chat')).waitFor({ timeout: T })
  await page.locator(tid('new-chat-agent')).click()
  await page.locator(`${tid('new-chat-agent-option')}[data-agent-name="${AGENT}"]`).click()
  await page.locator(tid('new-chat-folder')).click()
  await page.locator(`${tid('new-chat-folder-option')}[data-cwd="${plain}"]`).click()
  await page.locator(tid('new-chat-folder')).click()
  await toggle.waitFor({ timeout: T })
  await waitFor(async () => await toggle.isDisabled(), T, 'the toggle to be disabled outside a repo')
  assert((await toggle.getAttribute('data-tip')) === 'Not a git repository', `tooltip reads ${await toggle.getAttribute('data-tip')}`)
  assert((await page.locator(tid('new-chat-folder-worktree')).count()) === 0, 'the branch mark shows for a non-repo folder')
  ok('8b new-chat: a non-repo folder disables the toggle ("Not a git repository")')

  // 8c. an agent that makes a worktree of its own: the chip and Changes follow it, not the checkout the chat opened in
  const repo2 = join(base, 'repo2')
  await mkdir(repo2)
  await writeFile(join(repo2, 'README.md'), 'hello\n')
  await git(repo2, 'init', '-b', 'main')
  await git(repo2, 'add', '.')
  await git(repo2, '-c', 'user.email=e2e@example.test', '-c', 'user.name=e2e', 'commit', '-m', 'first')
  const own = join(base, 'repo2-agent-own')
  await git(repo2, 'worktree', 'add', '-b', 'agent-own', own)
  await writeFile(join(repo2, 'mine.txt'), 'the user\n') // the user's own change in the chat's checkout
  await writeFile(join(own, 'agent.ts'), 'export const x = 1\n')
  const C = (await rpc(page, 'chats:create', AGENT, repo2)).id
  assert((await metaOf(C)).worktree === undefined, 'a chat in a repo without the toggle got a worktree')
  // What a turn stores when the agent ran a shell line in its worktree; the chat is not open yet, so it is read from disk.
  const call = { type: 'tool', id: 'toolu_e2e_own', name: 'Bash', input: { command: `cd ${own} && git status` } }
  await writeFile(
    join(dataDir, 'chats', `${C}.json`),
    JSON.stringify([{ ...call, result: '', isError: false, blocked: false, ts: Date.now() }])
  )
  await page.goto(`${h.origin}/chat/${C}`)
  await chip.waitFor({ timeout: T })
  await waitFor(async () => (await chip.textContent()).includes('agent-own'), T, 'the chip to read the agent worktree branch')
  assert(
    (await chip.getAttribute('data-tip')).includes(`In the agent's worktree: ${own}`),
    `chip tip reads ${await chip.getAttribute('data-tip')}`
  )
  await chip.click()
  await panel.waitFor({ timeout: T })
  await waitFor(async () => (await rows.count()) === 1, T, "only the agent's file listed")
  assert((await rows.first().getAttribute('data-path')) === 'agent.ts', `the row is ${await rows.first().getAttribute('data-path')}`)
  assert((await panel.locator(tid('changes-agent-tree')).textContent()).includes(own), 'the panel does not name the agent worktree')
  await chip.click()
  await panel.waitFor({ state: 'detached', timeout: T })
  ok(`8c a plain chat whose agent worked in ${own}: the chip reads agent-own and Changes lists agent.ts, not mine.txt`)

  // 8d. the agent commits: Uncommitted empties, and Since start shows it all from where its branch was made
  await git(own, 'add', 'agent.ts')
  await git(own, '-c', 'user.email=e2e@example.test', '-c', 'user.name=e2e', 'commit', '-m', 'agent work')
  await writeFile(join(own, 'later.ts'), 'export const y = 2\n')
  await page.dispatchEvent('body', 'focus')
  await chip.click()
  await panel.waitFor({ timeout: T })
  await waitFor(async () => (await rows.count()) === 1, T, 'only later.ts left uncommitted')
  await panel.locator(tid('changes-scope-base')).click()
  await waitFor(async () => (await rows.count()) === 2, T, 'agent.ts and later.ts since the branch started')
  const ownSince = await rows.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-kind')} ${e.getAttribute('data-path')}`))
  assert(
    JSON.stringify(ownSince) === JSON.stringify(['added agent.ts', 'untracked later.ts']),
    `Since start reads ${JSON.stringify(ownSince)}`
  )
  await chip.click()
  await panel.waitFor({ state: 'detached', timeout: T })
  ok("8d the agent's commit: Since start in its worktree lists agent.ts as added and later.ts, still not mine.txt")

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
} finally {
  await stop()
  for (const d of made) await rm(d, { recursive: true, force: true }).catch(() => {})
}
console.log(failed ? 'e2e:worktrees FAILED' : 'e2e:worktrees passed')
process.exit(failed ? 1 : 0)
