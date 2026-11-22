import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scrubToken } from '@zumibot/shared/pullRequest'
import type { ChatMeta, ChatPush } from '@zumibot/shared/types'
import type { TodoItem, TodoPr } from '@zumibot/shared/todos'
import { ChatStore } from '../../../src/core/store/chatStore'
import { makeGit } from '../../../src/core/git/git'
import { createGhLocator, makeGh } from '../../../src/core/github/gh'
import { DEFAULT_BRANCH, NO_COMMITS, NO_PR, NO_WORKTREE, PullRequests, WORKTREE_GONE } from '../../../src/core/github/pullRequests'
import { writeFakeBin } from '../../support/fakeBin'

const FAKE_GH = fileURLToPath(new URL('../../fixtures/fake-gh.mjs', import.meta.url))

// The user's own git config must never leak into these repos, and no test touches a real remote: `origin` is a bare
// repo in the same temp dir.
const gitEnv = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' })

let dir: string
let source: string
let remote: string
let root: string
let store: ChatStore
let prs: PullRequests
let chat: ChatMeta
let pushes: ChatPush[]
let submitted: { chatId: string; text: string }[]
let mirrored: (TodoPr | null)[]
let card: TodoItem | null
let ghEnv: Record<string, string>
let calls: string
const savedPath = process.env.PATH

const ghBin = async (): Promise<string> => writeFakeBin(dir, 'gh', FAKE_GH)

const callsMade = async (): Promise<string[][]> =>
  (await fs.readFile(calls, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { args: string[] }).args)

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-pr-')))
  calls = join(dir, 'calls.jsonl')
  ghEnv = { FAKE_GH_CALLS: calls }
  pushes = []
  submitted = []
  mirrored = []
  card = null

  remote = join(dir, 'remote.git')
  sh(dir, 'init', '--bare', '-b', 'main', remote)
  source = join(dir, 'repo')
  await fs.mkdir(source)
  sh(source, 'init', '-q', '-b', 'main')
  sh(source, 'config', 'user.email', 't@example.com')
  sh(source, 'config', 'user.name', 'T')
  sh(source, 'remote', 'add', 'origin', remote)
  await fs.writeFile(join(source, 'a.txt'), 'a\n')
  sh(source, 'add', '-A')
  sh(source, 'commit', '-q', '-m', 'init')
  sh(source, 'push', '-q', '-u', 'origin', 'main')
  const base = sh(source, 'rev-parse', 'HEAD').trim()

  root = join(dir, 'repo-work')
  sh(source, 'worktree', 'add', '-q', '-b', 'zumibot/coder-a1', root, 'HEAD')
  sh(root, 'config', 'user.email', 't@example.com')
  sh(root, 'config', 'user.name', 'T')

  store = new ChatStore(join(dir, 'data'))
  chat = await store.create('coder', root, { worktree: { root, branch: 'zumibot/coder-a1', source, folder: source, links: [], base } })

  const bin = await ghBin()
  // The locator's state first looks gh up on PATH: the fake's folder goes first, so no real gh needs to be installed.
  process.env.PATH = [dir, savedPath ?? ''].join(delimiter)
  const gh = makeGh(
    async () => bin,
    () => ({ ...process.env, ...ghEnv })
  )
  const locator = createGhLocator(gh)
  prs = new PullRequests({
    git: makeGit(gitEnv),
    gh,
    ghState: () => locator.state(),
    forgetAuth: () => locator.forgetAuth(),
    store,
    card: async () => card,
    mirror: async (_todoId, pr) => void mirrored.push(pr),
    submit: async (chatId, text) => void submitted.push({ chatId, text }),
    push: (p) => pushes.push(p),
    now: () => 1_700_000_000_000
  })
})

afterEach(async () => {
  process.env.PATH = savedPath
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

const commit = (text = 'work\n', message = 'the work'): void => {
  execFileSync('sh', ['-c', `printf '%s' '${text}' > b.txt`], { cwd: root })
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', message)
}

describe('draftPr', () => {
  it('names the branch, its commits since the base, and drafts from the card', async () => {
    card = { text: 'Make the sum right', description: 'It adds 1 + 1.' } as TodoItem
    await store.patchInPlace(chat.id, () => ({ task: { todoId: 't1' } }))
    commit()
    const d = await prs.draftPr(chat.id)
    expect(d.branch).toBe('zumibot/coder-a1')
    expect(d.commits).toHaveLength(1)
    expect(d.commits[0]).toContain('the work')
    expect(d.title).toBe('Make the sum right')
    expect(d.body).toBe('It adds 1 + 1.\n\n## Commits\n- the work')
    expect(d.dirty).toBe(0)
    expect(d.refusal).toBeUndefined()
  })

  it('refuses while anything is uncommitted, and counts what it found', async () => {
    commit()
    await fs.writeFile(join(root, 'scratch.md'), 'notes\n')
    const d = await prs.draftPr(chat.id)
    expect(d.dirty).toBe(1)
    expect(d.refusal).toBe('Commit or stash the 1 uncommitted change first.')
    await fs.writeFile(join(root, 'more.md'), 'more\n')
    expect((await prs.draftPr(chat.id)).refusal).toBe('Commit or stash the 2 uncommitted changes first.')
  })

  it("leaves out ZumiBot's own node_modules links, as release does", async () => {
    commit()
    await fs.writeFile(join(root, '.gitignore'), 'node_modules\n')
    sh(root, 'add', '-A')
    sh(root, 'commit', '-q', '-m', 'ignore')
    // A junction on Windows, as the app makes there (a symlink needs a privilege).
    await fs.symlink(dir, join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : undefined)
    await store.patchInPlace(chat.id, (cur) => ({ worktree: { ...cur.worktree!, links: ['node_modules'] } }))
    expect((await prs.draftPr(chat.id)).dirty).toBe(0)
  })

  it("refuses the repository's default branch, whatever is committed on it", async () => {
    const plain = await store.create('coder', source, { worktree: { root: source, branch: 'main', source, folder: source, links: [] } })
    expect((await prs.draftPr(plain.id)).refusal).toBe(DEFAULT_BRANCH)
  })

  it('refuses a branch with nothing on it, a chat with no worktree and one whose folder is gone', async () => {
    expect((await prs.draftPr(chat.id)).refusal).toBe(NO_COMMITS)
    const plain = await store.create('coder', source)
    expect((await prs.draftPr(plain.id)).refusal).toBe(NO_WORKTREE)
    await store.patchInPlace(chat.id, (cur) => ({ worktree: { ...cur.worktree!, removed: true } }))
    expect((await prs.draftPr(chat.id)).refusal).toBe(WORKTREE_GONE)
  })
})

describe('createPr', () => {
  it('pushes the branch without forcing, opens the PR through gh and stores it on the chat', async () => {
    commit()
    const pr = await prs.createPr(chat.id, { title: 'Fix the sum', body: 'Why', draft: false })
    expect(pr).toMatchObject({ number: 7, url: 'https://github.com/acme/app/pull/7', state: 'open', branch: 'zumibot/coder-a1' })
    // The branch really reached the bare remote, and nothing was forced.
    expect(sh(remote, 'rev-parse', 'zumibot/coder-a1').trim()).toBe(sh(root, 'rev-parse', 'HEAD').trim())
    const args = await callsMade()
    expect(args.some((a) => a[0] === 'pr' && a[1] === 'create')).toBe(true)
    expect(args.flat()).not.toContain('--force')
    // The body goes through a file, never argv.
    const create = args.find((a) => a[1] === 'create')!
    expect(create).toContain('--body-file')
    expect(create).not.toContain('Why')
    expect((await store.get(chat.id))!.pr).toMatchObject({ number: 7 })
    expect(pushes.some((p) => p.kind === 'meta' && p.meta.pr?.number === 7)).toBe(true)
  })

  it('opens a draft when asked, and mirrors onto the card only for its own task chat', async () => {
    commit()
    await store.patchInPlace(chat.id, () => ({ task: { todoId: 't1' } }))
    ghEnv.FAKE_GH_PR = JSON.stringify({ number: 7, url: 'u', state: 'OPEN', isDraft: true, statusCheckRollup: [] })
    const pr = await prs.createPr(chat.id, { title: 'T', body: '', draft: true })
    expect(pr.draft).toBe(true)
    expect((await callsMade()).find((a) => a[1] === 'create')).toContain('--draft')
    expect(mirrored).toEqual([{ number: 7, url: 'u', state: 'open', chatId: chat.id }])
  })

  it('checks every refusal again, whatever the client sent', async () => {
    await expect(prs.createPr(chat.id, { title: 'T', body: '', draft: false })).rejects.toThrow(NO_COMMITS)
    commit()
    await fs.writeFile(join(root, 'scratch.md'), 'notes\n')
    await expect(prs.createPr(chat.id, { title: 'T', body: '', draft: false })).rejects.toThrow(/uncommitted/)
    await fs.rm(join(root, 'scratch.md'))
    await expect(prs.createPr(chat.id, { title: '   ', body: '', draft: false })).rejects.toThrow(/needs a title/)
    // Nothing was pushed and no pull request was opened; only the read that asks for the default branch ran.
    expect((await callsMade()).some((a) => a[1] === 'create')).toBe(false)
    expect(() => sh(remote, 'rev-parse', 'zumibot/coder-a1')).toThrow()
  })

  it("shows git's own line when the push is rejected, and nothing of the environment", async () => {
    commit()
    // A diverged remote branch: the push is rejected as it would be in life.
    sh(remote, 'update-ref', 'refs/heads/zumibot/coder-a1', sh(source, 'rev-parse', 'HEAD').trim())
    const other = join(dir, 'other')
    sh(dir, 'clone', '-q', remote, other)
    sh(other, 'config', 'user.email', 't@example.com')
    sh(other, 'config', 'user.name', 'T')
    sh(other, 'checkout', '-q', 'zumibot/coder-a1')
    await fs.writeFile(join(other, 'theirs.txt'), 'theirs\n')
    sh(other, 'add', '-A')
    sh(other, 'commit', '-q', '-m', 'theirs')
    sh(other, 'push', '-q', 'origin', 'zumibot/coder-a1')
    await expect(prs.createPr(chat.id, { title: 'T', body: '', draft: false })).rejects.toThrow(/failed to push/i)
    expect((await callsMade()).some((a) => a[1] === 'create')).toBe(false) // no pull request was opened
  })

  it('never shows a credential from the remote URL, whatever git prints', async () => {
    commit()
    sh(root, 'remote', 'set-url', 'origin', 'https://tester:ghp_abcdefghijklmnopqrstuvwxyz0123456789@localhost:1/acme/app.git')
    // This git strips the credentials itself; the scrub is what holds when one does not.
    const line = await prs.createPr(chat.id, { title: 'T', body: '', draft: false }).then(
      () => '',
      (e: Error) => e.message
    )
    expect(line).not.toContain('ghp_')
    expect(line).not.toContain('tester:')
    expect(line).toMatch(/unable to access|failed to push/i)
    expect(
      scrubToken("error: failed to push some refs to 'https://tester:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/app.git'")
    ).toBe("error: failed to push some refs to 'https://***@github.com/acme/app.git'")
  })

  it('refuses when gh is not signed in, before it pushes anything', async () => {
    commit()
    ghEnv.FAKE_GH_AUTH = 'out'
    await expect(prs.createPr(chat.id, { title: 'T', body: '', draft: false })).rejects.toThrow(/not signed in/)
    expect(() => sh(remote, 'rev-parse', 'zumibot/coder-a1')).toThrow()
  })
})

describe('refreshPr', () => {
  const withPr = async (): Promise<void> => {
    commit()
    await prs.createPr(chat.id, { title: 'T', body: '', draft: false })
  }

  it('folds the checks rollup onto the chat', async () => {
    await withPr()
    ghEnv.FAKE_GH_PR = JSON.stringify({
      number: 7,
      url: 'u',
      state: 'OPEN',
      isDraft: false,
      statusCheckRollup: [
        { name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/a/b/actions/runs/1/job/22' },
        { name: 'lint', status: 'IN_PROGRESS', conclusion: null }
      ]
    })
    const pr = await prs.refreshPr(chat.id)
    expect(pr.checks).toEqual({
      status: 'failing',
      total: 2,
      pending: 1,
      failing: [{ name: 'unit', url: 'https://github.com/a/b/actions/runs/1/job/22', jobId: '22' }]
    })
    expect((await store.get(chat.id))!.pr!.checks!.status).toBe('failing')
  })

  it('reads a merged pull request as merged', async () => {
    await withPr()
    ghEnv.FAKE_GH_PR = JSON.stringify({ number: 7, url: 'u', state: 'MERGED', isDraft: false, statusCheckRollup: [] })
    expect((await prs.refreshPr(chat.id)).state).toBe('merged')
  })

  it('keeps the last state and records why when the read fails', async () => {
    await withPr()
    ghEnv.FAKE_GH_PR_FAIL = 'error: could not reach github.com'
    const pr = await prs.refreshPr(chat.id)
    expect(pr.number).toBe(7)
    expect(pr.error).toBe('error: could not reach github.com')
    // The next read that works clears it.
    delete ghEnv.FAKE_GH_PR_FAIL
    expect((await prs.refreshPr(chat.id)).error).toBeUndefined()
  })

  it('refuses a chat that has no pull request', async () => {
    await expect(prs.refreshPr(chat.id)).rejects.toThrow(NO_PR)
  })
})

describe('sendCheck', () => {
  const failing = async (): Promise<void> => {
    commit()
    await prs.createPr(chat.id, { title: 'T', body: '', draft: false })
    ghEnv.FAKE_GH_PR = JSON.stringify({
      number: 7,
      url: 'u',
      state: 'OPEN',
      isDraft: false,
      statusCheckRollup: [
        { name: 'unit', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/a/b/actions/runs/1/job/22' },
        { name: 'legacy', state: 'FAILURE', targetUrl: 'https://ci.example/9' }
      ]
    })
    await prs.refreshPr(chat.id)
  }

  it('posts the check and the tail of its job log as an ordinary user turn', async () => {
    await failing()
    ghEnv.FAKE_GH_LOG = 'step failed\nexpected 2, got 4'
    await prs.sendCheck(chat.id, 'unit')
    await vi.waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].chatId).toBe(chat.id)
    expect(submitted[0].text).toContain('The check **unit** is failing on pull request #7.')
    expect(submitted[0].text).toContain('expected 2, got 4')
    expect((await callsMade()).some((a) => a[0] === 'run' && a.includes('--log-failed'))).toBe(true)
  })

  it('says so for a check that is not an Actions job, rather than pretending it has a log', async () => {
    await failing()
    await prs.sendCheck(chat.id, 'legacy')
    await vi.waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0].text).toContain('not available through the GitHub CLI')
    expect((await callsMade()).some((a) => a[0] === 'run')).toBe(false)
  })

  it('refuses a check this chat does not list as failing, so a made-up name never reaches gh', async () => {
    await failing()
    await expect(prs.sendCheck(chat.id, 'made-up')).rejects.toThrow(/not failing/)
    expect(submitted).toEqual([])
  })
})
