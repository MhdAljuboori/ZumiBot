import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { ChatMeta, ChatWorktree } from '@zumibot/shared/types'
import { worktreePath, worktreeSlug } from '@zumibot/shared/worktree'
import { ChatStore } from '../../../src/core/store/chatStore'
import { GitError, makeGit, type Git } from '../../../src/core/git/git'
import { WorktreeService, type WorktreeDeps } from '../../../src/core/git/worktrees'
import { isolatedGitEnv } from '../../support/gitEnv'

// The user's own git config must never leak into these repos.
const env = isolatedGitEnv
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' })

const tmps: string[] = []
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

// The repo sits one level inside its own tmp dir, so the sibling worktree lands inside it too.
async function makeRepo(name = 'repo', files: Record<string, string> = {}): Promise<{ tmp: string; repo: string }> {
  const tmp = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-wt-')))
  tmps.push(tmp)
  const repo = join(tmp, name)
  await fs.mkdir(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@example.com')
  sh(repo, 'config', 'user.name', 'T')
  await fs.writeFile(join(repo, 'README.md'), 'hi\n')
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(join(repo, rel, '..'), { recursive: true })
    await fs.writeFile(join(repo, rel), body)
  }
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', 'init')
  return { tmp, repo }
}

function service(over: Partial<WorktreeDeps> = {}, hexes?: string[]): WorktreeService {
  let i = 0
  return new WorktreeService({
    git: makeGit(env),
    store: { list: async () => [], patchInPlace: async () => null },
    push: () => {},
    hex: () => (hexes ? hexes[Math.min(i++, hexes.length - 1)] : Math.random().toString(16).slice(2, 8).padEnd(6, '0')),
    log: () => {},
    ...over
  })
}

// Status reads only cwd and worktree, so a partial meta is enough.
const meta = (m: { cwd: string; worktree?: ChatWorktree }): ChatMeta => m as unknown as ChatMeta
const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  )

describe('WorktreeService.create', () => {
  it('makes a sibling worktree on a new branch from HEAD', async () => {
    const { repo } = await makeRepo()
    const created = await service({}, ['a1b2c3']).create(repo, 'frontend-dev')
    const slug = worktreeSlug('frontend-dev', 'a1b2c3')
    expect(created.worktree.root).toBe(worktreePath(repo, slug))
    expect(await exists(created.worktree.root)).toBe(true)
    expect(sh(repo, 'branch', '--list', 'zumibot/*')).toContain(`zumibot/${slug}`)
    expect(sh(created.worktree.root, 'rev-parse', 'HEAD')).toBe(sh(repo, 'rev-parse', 'HEAD'))
    expect(created.cwd).toBe(created.worktree.root)
    expect(created.worktree).toMatchObject({ branch: `zumibot/${slug}`, source: repo, folder: repo, links: [] })
  })

  it('records the commit it started from, so the panel can diff since start', async () => {
    const { repo } = await makeRepo()
    const created = await service().create(repo, 'dev')
    expect(created.worktree.base).toBe(sh(repo, 'rev-parse', 'HEAD').trim())
  })

  it('records no base in a repo with no commit yet, rather than failing the create', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-wt-')))
    tmps.push(tmp)
    const repo = join(tmp, 'empty')
    await fs.mkdir(repo)
    sh(repo, 'init', '-q', '-b', 'main')
    sh(repo, 'config', 'user.email', 't@example.com')
    sh(repo, 'config', 'user.name', 'T')
    // `worktree add` from an unborn HEAD fails in git's own words; the point is that reading the base did not throw first.
    await expect(service().create(repo, 'dev')).rejects.toThrow(GitError)
  })

  it('starts the chat in the same subfolder', async () => {
    const { repo } = await makeRepo('repo', { 'angular/a.txt': 'a\n' })
    const created = await service().create(join(repo, 'angular'), 'dev')
    expect(created.cwd).toBe(join(created.worktree.root, 'angular'))
    expect(created.worktree.folder).toBe(join(repo, 'angular'))
    expect(created.worktree.source).toBe(repo)
  })

  it('falls back to the root when the picked subfolder is not in the new worktree', async () => {
    const { repo } = await makeRepo('repo', { '.gitignore': 'scratch/\n' })
    await fs.mkdir(join(repo, 'scratch'))
    const created = await service().create(join(repo, 'scratch'), 'dev')
    expect(created.cwd).toBe(created.worktree.root)
    expect(created.worktree.folder).toBe(join(repo, 'scratch'))
  })

  it('does not treat a folder named like ..x as outside the repo', async () => {
    const { repo } = await makeRepo('repo', { '..odd/a.txt': 'a\n' })
    const created = await service().create(join(repo, '..odd'), 'dev')
    expect(created.cwd).toBe(join(created.worktree.root, '..odd'))
  })

  it('links an ignored node_modules and skips the rest', async () => {
    const { repo } = await makeRepo('repo', {
      'angular/.gitignore': '/node_modules\n',
      '.gitignore': 'node_modules/\n',
      'pkg/package.json': '{"workspaces":[]}',
      // Ignored here too, so only the `workspaces` rule can keep pkg/node_modules from being linked.
      'pkg/.gitignore': '/node_modules\n'
    })
    for (const rel of ['angular/node_modules', 'node_modules', 'pkg/node_modules']) {
      await fs.mkdir(join(repo, rel), { recursive: true })
      await fs.writeFile(join(repo, rel, 'x'), 'x')
    }
    const { worktree } = await service().create(repo, 'dev')
    // Windows links with a junction, which git sees as a folder, so `node_modules/` ignores the top one too and it is kept.
    const top = process.platform === 'win32'
    expect(worktree.links).toEqual(top ? ['angular/node_modules', 'node_modules'] : ['angular/node_modules'])
    const link = join(worktree.root, 'angular/node_modules')
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await fs.readlink(link)).toBe(join(repo, 'angular/node_modules'))
    expect(await exists(join(worktree.root, 'node_modules'))).toBe(top)
    expect(await exists(join(worktree.root, 'pkg/node_modules'))).toBe(false)
    // The link must not show up as a change in git.
    expect(sh(worktree.root, 'status', '--porcelain')).toBe('')
  })

  it('refuses a non-repo', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-wt-')))
    tmps.push(tmp)
    const plain = join(tmp, 'plain')
    await fs.mkdir(plain)
    await expect(service().create(plain, 'dev')).rejects.toThrow('Not a git repository: plain')
  })

  it('redraws on a name collision', async () => {
    const { repo } = await makeRepo()
    const svc = service({}, ['aaaaaa', 'aaaaaa', 'bbbbbb'])
    const first = await svc.create(repo, 'dev')
    const second = await svc.create(repo, 'dev')
    expect(first.worktree.branch).toBe('zumibot/dev-aaaaaa')
    expect(second.worktree.branch).toBe('zumibot/dev-bbbbbb')
    const stuck = service({}, ['aaaaaa'])
    await expect(stuck.create(repo, 'dev')).rejects.toThrow('Could not find a free worktree name')
  })

  it('skips a slug whose branch already exists without a folder', async () => {
    const { repo } = await makeRepo()
    sh(repo, 'branch', 'zumibot/dev-aaaaaa')
    const created = await service({}, ['aaaaaa', 'cccccc']).create(repo, 'dev')
    expect(created.worktree.branch).toBe('zumibot/dev-cccccc')
  })

  it('removes the half-made folder and rethrows when git fails', async () => {
    const { repo } = await makeRepo()
    const real = makeGit(env)
    const git: Git = async (args, cwd, o) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        await fs.mkdir(args[4]) // what a failed add can leave behind
        throw new GitError('fatal: boom')
      }
      return real(args, cwd, o)
    }
    const root = worktreePath(repo, worktreeSlug('dev', 'dddddd'))
    await expect(service({ git }, ['dddddd']).create(repo, 'dev')).rejects.toThrow('fatal: boom')
    expect(await exists(root)).toBe(false)
  })

  it('prunes after a failed add, gives it a long timeout, and never deletes a branch', async () => {
    const { repo } = await makeRepo()
    const real = makeGit(env)
    const calls: { args: string[]; timeoutMs?: number }[] = []
    const git: Git = async (args, cwd, o) => {
      calls.push({ args, timeoutMs: o?.timeoutMs })
      if (args[0] === 'worktree' && args[1] === 'add') throw new GitError('fatal: boom')
      return real(args, cwd, o)
    }
    await expect(service({ git }, ['eeeeee']).create(repo, 'dev')).rejects.toThrow('fatal: boom')
    const add = calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'add')
    expect(add?.timeoutMs).toBe(120_000)
    expect(calls.some((c) => c.args.join(' ') === 'worktree prune')).toBe(true)
    expect(calls.some((c) => c.args[0] === 'branch')).toBe(false)
  })

  it('works in a repo path with spaces', async () => {
    const { repo } = await makeRepo('my repo')
    const svc = service()
    const created = await svc.create(repo, 'dev')
    expect(created.worktree.root.startsWith(`${repo}-dev-`)).toBe(true)
    const status = await svc.status(meta({ cwd: created.cwd, worktree: created.worktree }))
    expect(status).toMatchObject({ branch: created.worktree.branch, changed: 0 })
  })
})

describe('WorktreeService.topOf', () => {
  it('is null for a non-repo and a missing folder', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-wt-')))
    tmps.push(tmp)
    expect(await service().topOf(tmp)).toBeNull()
    expect(await service().topOf(join(tmp, 'missing'))).toBeNull()
  })

  it('rethrows any other git failure instead of calling the folder a non-repo', async () => {
    for (const message of ['git timed out', 'git not found', 'fatal: detected dubious ownership in repository at /x']) {
      const git: Git = async () => {
        throw new GitError(message)
      }
      await expect(service({ git }).topOf('/anywhere')).rejects.toThrow(message)
    }
  })

  it("names git's line, not the not-a-repo line, when ensure cannot reach the source", async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const git: Git = async () => {
      throw new GitError('git timed out')
    }
    const wt = { ...worktree, removed: true as const }
    await expect(service({ git }).ensure(meta({ cwd: wt.root, worktree: wt }))).rejects.toThrow('git timed out')
  })
})

describe('WorktreeService.status', () => {
  it('counts changes without links and reports the branch', async () => {
    const { repo } = await makeRepo()
    const svc = service()
    const { cwd, worktree } = await svc.create(repo, 'dev')
    await fs.writeFile(join(cwd, 'notes.md'), 'n\n')
    const status = await svc.status(meta({ cwd, worktree }))
    expect(status).toEqual({ branch: worktree.branch, head: expect.stringMatching(/^[0-9a-f]{7}$/), changed: 1 })
  })

  it("takes no optional locks, so it cannot collide with the agent's own git add or commit", async () => {
    const real = makeGit(env)
    const calls: string[][] = []
    const git: Git = (args, cwd, o) => {
      calls.push(args)
      return real(args, cwd, o)
    }
    const { repo } = await makeRepo()
    const svc = service({ git })
    const { cwd, worktree } = await svc.create(repo, 'dev')
    await svc.status(meta({ cwd, worktree }))
    const status = calls.filter((c) => c.includes('status'))
    expect(status).toHaveLength(1)
    expect(status[0].indexOf('--no-optional-locks')).toBeGreaterThanOrEqual(0)
    expect(status[0].indexOf('--no-optional-locks')).toBeLessThan(status[0].indexOf('status'))
  })

  it('reports a removed worktree from the meta without running git', async () => {
    const git: Git = async () => {
      throw new Error('git must not run')
    }
    const worktree = { root: '/gone', branch: 'zumibot/x-111111', source: '/src', folder: '/src', links: [], removed: true as const }
    expect(await service({ git }).status(meta({ cwd: '/gone', worktree }))).toEqual({
      branch: 'zumibot/x-111111',
      head: '',
      changed: 0,
      removed: true
    })
  })

  it('returns null outside git and when git is missing', async () => {
    const tmp = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-wt-')))
    tmps.push(tmp)
    expect(await service().status(meta({ cwd: tmp }))).toBeNull()
    expect(await service().status(meta({ cwd: join(tmp, 'missing') }))).toBeNull()
    const git: Git = async () => {
      throw new GitError('git not found')
    }
    expect(await service({ git }).status(meta({ cwd: tmp }))).toBeNull()
  })
})

describe('makeGit', () => {
  it('rejects with the first stderr line, and allows listed exit codes', async () => {
    const { tmp, repo } = await makeRepo()
    const git = makeGit(env)
    await expect(git(['rev-parse', '--show-toplevel'], tmp)).rejects.toThrow(/^fatal: not a git repository/)
    expect(await git(['check-ignore', '-q', 'README.md'], repo, { allowExit: [0, 1] })).toEqual({ stdout: '', code: 1 })
  })

  it('prefers the fatal line over git progress lines', async () => {
    const { tmp, repo } = await makeRepo()
    await expect(makeGit(env)(['worktree', 'add', '-b', 'main', join(tmp, 'x'), 'HEAD'], repo)).rejects.toThrow(
      /^fatal: a branch named 'main' already exists/
    )
  })

  it('rejects with GitError Folder not found when the cwd is missing', async () => {
    const { tmp } = await makeRepo()
    const err = await makeGit(env)(['status'], join(tmp, 'missing')).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitError)
    expect((err as Error).message).toBe('Folder not found')
  })

  it('says git was not found when the binary is missing', async () => {
    const { repo } = await makeRepo()
    const git = makeGit(() => ({ PATH: '/nonexistent' }))
    await expect(git(['status'], repo)).rejects.toThrow('git not found')
  })
})

// ---- ensure and release ----

const KEEP_FILES = { '.gitignore': 'dist/\ndocs/plans/\n', 'angular/.gitignore': '/node_modules\n' }

/** A repo, a real ChatStore and a service wired to them; `calls` records every git call. */
async function setup(files: Record<string, string> = KEEP_FILES, hexes?: string[]) {
  const { tmp, repo } = await makeRepo('repo', files)
  const dataDir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-wt-data-'))
  tmps.push(dataDir)
  const store = new ChatStore(dataDir)
  const pushed: ChatMeta[] = []
  const logs: string[] = []
  const calls: string[][] = []
  const real = makeGit(env)
  const git: Git = (args, cwd, o) => {
    calls.push(args)
    return real(args, cwd, o)
  }
  const svc = service({ git, store, push: (m) => pushed.push(m), log: (m) => logs.push(m) }, hexes)
  // Archived by default: release only runs for a chat that is still archived (pass archivedAt: undefined for a live one).
  const addChat = async (worktree: ChatWorktree, patch: Partial<ChatMeta> = {}): Promise<ChatMeta> => {
    const c = await store.create('agent', worktree.root)
    return store.update(c.id, { worktree, archivedAt: 10, ...patch })
  }
  const fresh = async (id: string): Promise<ChatMeta> => (await store.get(id))!
  return { tmp, repo, store, svc, pushed, logs, calls, addChat, fresh }
}

async function withModules(repo: string): Promise<string> {
  const target = join(repo, 'angular/node_modules')
  await fs.mkdir(target, { recursive: true })
  await fs.writeFile(join(target, 'pkg.js'), 'x')
  return target
}

const branches = (repo: string): string => sh(repo, 'branch', '--list', '--format=%(refname:short)')

describe('WorktreeService.release', () => {
  it('removes a clean worktree and keeps the branch', async () => {
    const t = await setup()
    const target = await withModules(t.repo)
    const { worktree } = await t.svc.create(t.repo, 'dev')
    expect(worktree.links).toEqual(['angular/node_modules'])
    const chat = await t.addChat(worktree)
    await t.svc.release(chat, { deleted: false })
    expect(await exists(worktree.root)).toBe(false)
    expect(branches(t.repo)).toContain(worktree.branch)
    expect((await t.fresh(chat.id)).worktree).toMatchObject({ removed: true })
    expect((await t.fresh(chat.id)).worktree?.kept).toBeUndefined()
    // Only the link goes: its target in the source is untouched.
    expect(await exists(join(target, 'pkg.js'))).toBe(true)
    expect(t.pushed.map((m) => m.id)).toContain(chat.id)
    // No force, no branch deletion, ever.
    expect(t.calls.flat().some((a) => a === '--force' || a === '-f' || a === '-D' || a === '-d')).toBe(false)
    expect(t.calls.some((c) => c[0] === 'branch')).toBe(false)
    const remove = t.calls.find((c) => c[0] === 'worktree' && c[1] === 'remove')
    expect(remove).toEqual(['worktree', 'remove', worktree.root])
  })

  it('takes no optional locks on its status call', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    t.calls.length = 0
    await t.svc.release(chat, { deleted: false })
    const status = t.calls.filter((c) => c.includes('status'))
    expect(status).toHaveLength(1)
    expect(status[0].indexOf('--no-optional-locks')).toBeGreaterThanOrEqual(0)
    expect(status[0].indexOf('--no-optional-locks')).toBeLessThan(status[0].indexOf('status'))
  })

  it('logs one line when a deleted chat leaves its worktree kept', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await fs.writeFile(join(worktree.root, 'a.ts'), 'a\n')
    await t.store.remove(chat.id)
    await t.svc.release(chat, { deleted: true })
    expect(await exists(worktree.root)).toBe(true)
    expect(t.logs).toEqual([`worktree kept after delete: ${worktree.root} (dirty)`])
  })

  it('skips a chat that was unarchived before it ran', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const archivedMeta = await t.addChat(worktree)
    // The user sent a message right after archiving: the store unarchived the chat.
    await t.store.update(archivedMeta.id, { unarchivedAt: 20 })
    t.calls.length = 0
    await t.svc.release(archivedMeta, { deleted: false })
    expect(await exists(worktree.root)).toBe(true)
    const after = (await t.fresh(archivedMeta.id)).worktree
    expect(after?.kept).toBeUndefined()
    expect(after?.removed).toBeUndefined()
    expect(t.calls).toHaveLength(0)
    expect(t.pushed).toHaveLength(0)
  })

  it('keeps a dirty worktree', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await fs.writeFile(join(worktree.root, 'a.ts'), 'a\n')
    await t.svc.release(chat, { deleted: false })
    expect(await exists(worktree.root)).toBe(true)
    expect((await t.fresh(chat.id)).worktree).toMatchObject({ kept: 'dirty' })
    expect((await t.fresh(chat.id)).worktree?.removed).toBeUndefined()
    expect(t.calls.some((c) => c[0] === 'worktree' && c[1] === 'remove')).toBe(false)
  })

  it('keeps a tracked file with changes', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await fs.writeFile(join(worktree.root, 'README.md'), 'changed\n')
    await t.svc.release(chat, { deleted: false })
    expect((await t.fresh(chat.id)).worktree).toMatchObject({ kept: 'dirty' })
  })

  it('keeps ignored work, but removes a folder with only caches and the link', async () => {
    const t = await setup()
    await withModules(t.repo)
    const a = await t.svc.create(t.repo, 'dev')
    const chatA = await t.addChat(a.worktree)
    await fs.mkdir(join(a.worktree.root, 'docs/plans'), { recursive: true })
    await fs.writeFile(join(a.worktree.root, 'docs/plans/p.md'), 'plan\n')
    await t.svc.release(chatA, { deleted: false })
    expect(await exists(a.worktree.root)).toBe(true)
    expect(await exists(join(a.worktree.root, 'docs/plans/p.md'))).toBe(true)
    expect((await t.fresh(chatA.id)).worktree).toMatchObject({ kept: 'ignored' })

    const b = await t.svc.create(t.repo, 'dev')
    const chatB = await t.addChat(b.worktree)
    await fs.mkdir(join(b.worktree.root, 'dist'))
    await fs.writeFile(join(b.worktree.root, 'dist/x.js'), 'x')
    expect(b.worktree.links).toEqual(['angular/node_modules'])
    await t.svc.release(chatB, { deleted: false })
    expect(await exists(b.worktree.root)).toBe(false)
    expect(await exists(join(t.repo, 'angular/node_modules/pkg.js'))).toBe(true)
    expect((await t.fresh(chatB.id)).worktree).toMatchObject({ removed: true })
  })

  it('keeps a detached HEAD', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    sh(worktree.root, 'checkout', '-q', '--detach')
    await t.svc.release(chat, { deleted: false })
    expect(await exists(worktree.root)).toBe(true)
    expect((await t.fresh(chat.id)).worktree).toMatchObject({ kept: 'detached' })
  })

  it('follows a switched branch, and ensure brings that branch back', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    sh(worktree.root, 'switch', '-q', '-c', 'feature/x')
    await fs.writeFile(join(worktree.root, 'f.txt'), 'f\n')
    sh(worktree.root, 'add', '-A')
    sh(worktree.root, 'commit', '-q', '-m', 'work')
    await t.svc.release(chat, { deleted: false })
    expect(await exists(worktree.root)).toBe(false)
    const after = await t.fresh(chat.id)
    expect(after.worktree).toMatchObject({ branch: 'feature/x', removed: true })
    expect(await t.svc.ensure(after)).toBeNull()
    expect(sh(worktree.root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature/x')
    expect(await exists(join(worktree.root, 'f.txt'))).toBe(true)
  })

  it('keeps a worktree another live chat uses, but not an asked or archived one', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const one = await t.addChat(worktree)
    const two = await t.addChat(worktree, { archivedAt: undefined })
    await t.svc.release(one, { deleted: false })
    expect(await exists(worktree.root)).toBe(true)
    expect((await t.fresh(one.id)).worktree).toMatchObject({ kept: 'shared' })
    expect((await t.fresh(two.id)).worktree?.kept).toBeUndefined()

    // The other chat is asked: it does not hold the folder.
    await t.store.update(two.id, { asked: { by: 'x', from: one.id, fromTitle: 't', chain: [] } })
    await t.svc.release(one, { deleted: false })
    expect(await exists(worktree.root)).toBe(false)
    expect((await t.fresh(one.id)).worktree).toMatchObject({ removed: true })
    expect((await t.fresh(two.id)).worktree).toMatchObject({ removed: true })
  })

  it('does not count an archived sharer', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const one = await t.addChat(worktree)
    const two = await t.addChat(worktree, { archivedAt: 5 })
    await t.svc.release(one, { deleted: false })
    expect(await exists(worktree.root)).toBe(false)
    expect((await t.fresh(two.id)).worktree).toMatchObject({ removed: true })
  })

  it('on delete, marks the others and writes nothing for the gone chat', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const gone = await t.addChat(worktree)
    const other = await t.addChat(worktree, { archivedAt: 5 })
    await t.store.remove(gone.id)
    t.pushed.length = 0
    await t.svc.release(gone, { deleted: true })
    expect(await exists(worktree.root)).toBe(false)
    expect((await t.fresh(other.id)).worktree).toMatchObject({ removed: true })
    expect(t.pushed.map((m) => m.id)).toEqual([other.id])
  })

  it('on delete, a kept worktree patches nothing', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const gone = await t.addChat(worktree)
    const other = await t.addChat(worktree, { archivedAt: 5 })
    await fs.writeFile(join(worktree.root, 'a.ts'), 'a\n')
    await t.store.remove(gone.id)
    await t.svc.release(gone, { deleted: true })
    expect(await exists(worktree.root)).toBe(true)
    expect((await t.fresh(other.id)).worktree?.kept).toBeUndefined()
    expect(t.pushed).toHaveLength(0)
  })

  it('does nothing for a plain chat or an already removed worktree', async () => {
    const t = await setup()
    const plain = await t.store.create('agent', t.repo)
    await t.svc.release(plain, { deleted: false })
    const gone = await t.addChat({ root: '/gone', branch: 'zumibot/x-111111', source: t.repo, folder: t.repo, links: [], removed: true })
    await t.svc.release(gone, { deleted: false })
    expect(t.calls).toHaveLength(0)
  })

  it('prunes and marks removed when the folder is already gone', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await fs.rm(worktree.root, { recursive: true })
    await t.svc.release(chat, { deleted: false })
    expect(t.calls.some((c) => c.join(' ') === 'worktree prune')).toBe(true)
    expect(sh(t.repo, 'worktree', 'list', '--porcelain')).not.toContain(worktree.root)
    expect((await t.fresh(chat.id)).worktree).toMatchObject({ removed: true })
    expect(branches(t.repo)).toContain(worktree.branch)
  })

  it('a failed remove keeps the folder and flags it', async () => {
    const t = await setup()
    await withModules(t.repo)
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const real = makeGit(env)
    const removes: { timeoutMs?: number }[] = []
    const git: Git = async (args, cwd, o) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        removes.push({ timeoutMs: o?.timeoutMs })
        throw new GitError('fatal: cannot remove')
      }
      return real(args, cwd, o)
    }
    const logs: string[] = []
    const pushed: ChatMeta[] = []
    const svc = service({ git, store: t.store, push: (m) => pushed.push(m), log: (m) => logs.push(m) })
    const chat = await t.addChat(worktree)
    await expect(svc.release(chat, { deleted: false })).resolves.toBeUndefined()
    expect(removes).toHaveLength(1)
    expect(removes[0].timeoutMs).toBeGreaterThanOrEqual(600_000)
    expect(logs.join('\n')).toContain('fatal: cannot remove')
    expect(await exists(worktree.root)).toBe(true)
    expect((await fs.lstat(join(worktree.root, 'angular/node_modules'))).isSymbolicLink()).toBe(true)
    const wt = (await t.fresh(chat.id)).worktree
    expect(wt).toMatchObject({ kept: 'failed' })
    expect(wt?.removed).toBeUndefined()
    expect(pushed.map((m) => m.id)).toEqual([chat.id])
  })

  it('a failed remove on delete flags nothing, and a failed remove of a gone folder counts as removed', async () => {
    const t = await setup()
    const real = makeGit(env)
    const failing =
      (gone: boolean): Git =>
      async (args, cwd, o) => {
        if (args[0] === 'worktree' && args[1] === 'remove') {
          if (gone) await fs.rm(args[2], { recursive: true, force: true })
          throw new GitError('fatal: timed out')
        }
        return real(args, cwd, o)
      }
    const a = await t.svc.create(t.repo, 'dev')
    const gone = await t.addChat(a.worktree)
    const other = await t.addChat(a.worktree, { archivedAt: 5 })
    await t.store.remove(gone.id)
    t.pushed.length = 0
    await service({ git: failing(false), store: t.store, push: (m) => t.pushed.push(m) }).release(gone, { deleted: true })
    expect(await exists(a.worktree.root)).toBe(true)
    expect((await t.fresh(other.id)).worktree?.kept).toBeUndefined()
    expect(t.pushed).toHaveLength(0)

    const b = await t.svc.create(t.repo, 'dev')
    const chatB = await t.addChat(b.worktree)
    await service({ git: failing(true), store: t.store }).release(chatB, { deleted: false })
    expect((await t.fresh(chatB.id)).worktree).toMatchObject({ removed: true })
  })

  it('never throws when the store fails', async () => {
    const logs: string[] = []
    const svc = service({
      store: {
        list: async () => {
          throw new Error('disk gone')
        },
        patchInPlace: async () => null
      },
      log: (m) => logs.push(m)
    })
    const worktree = { root: '/r', branch: 'zumibot/x-111111', source: '/s', folder: '/s', links: [] }
    await expect(svc.release(meta({ cwd: '/r', worktree }) as ChatMeta, { deleted: false })).resolves.toBeUndefined()
    expect(logs.join('\n')).toContain('disk gone')
  })

  it('unlinks only what lstat says is a symlink', async () => {
    const t = await setup({ ...KEEP_FILES, 'docs/real/a.txt': 'tracked\n' })
    await withModules(t.repo)
    const { worktree } = await t.svc.create(t.repo, 'dev')
    // A listed path that is a real folder must survive the unlink step: git is made to fail right after it.
    const real = makeGit(env)
    const git: Git = async (args, cwd, o) => {
      if (args[0] === 'worktree' && args[1] === 'remove') throw new GitError('fatal: stop here')
      return real(args, cwd, o)
    }
    const svc = service({ git, store: t.store })
    const chat = await t.addChat({ ...worktree, links: ['angular/node_modules', 'docs/real'] })
    await svc.release(chat, { deleted: false })
    expect(await fs.readFile(join(worktree.root, 'docs/real/a.txt'), 'utf8')).toBe('tracked\n')
    // The real link was removed and then put back by the failure path.
    expect((await fs.lstat(join(worktree.root, 'angular/node_modules'))).isSymbolicLink()).toBe(true)
  })

  it('does not unlink a link path that escapes the worktree, even when release goes on', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const victim = join(worktree.root, '..', 'victim-link')
    // A junction on Windows, where a symlink needs a privilege.
    await fs.symlink(t.repo, victim, process.platform === 'win32' ? 'junction' : undefined)
    const chat = await t.addChat({ ...worktree, links: ['../victim-link'] })
    await t.svc.release(chat, { deleted: false })
    expect(await exists(worktree.root)).toBe(false)
    expect((await fs.lstat(victim)).isSymbolicLink()).toBe(true)
  })
})

describe('WorktreeService.link', () => {
  it('ends check-ignore options with --, so a path is never read as an option', async () => {
    const t = await setup()
    await withModules(t.repo)
    t.calls.length = 0
    await t.svc.create(t.repo, 'dev')
    const check = t.calls.find((c) => c[0] === 'check-ignore')
    expect(check).toEqual(['check-ignore', '-q', '--', 'angular/node_modules'])
  })
})

describe('WorktreeService.ensure', () => {
  it('does nothing without a worktree, or when the folder is there', async () => {
    const t = await setup()
    expect(await t.svc.ensure(meta({ cwd: t.repo }))).toBeNull()
    const { worktree, cwd } = await t.svc.create(t.repo, 'dev')
    t.calls.length = 0
    expect(await t.svc.ensure(meta({ cwd, worktree }))).toBeNull()
    expect(t.calls).toHaveLength(0)
  })

  it('re-adds a removed worktree from its branch, with links, and clears removed', async () => {
    const t = await setup()
    await withModules(t.repo)
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    const other = await t.addChat(worktree, { archivedAt: 5 })
    await t.svc.release(chat, { deleted: false })
    expect(await exists(worktree.root)).toBe(false)
    t.pushed.length = 0
    expect(await t.svc.ensure(await t.fresh(chat.id))).toBeNull()
    expect(await exists(worktree.root)).toBe(true)
    expect(sh(worktree.root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(worktree.branch)
    expect((await fs.lstat(join(worktree.root, 'angular/node_modules'))).isSymbolicLink()).toBe(true)
    for (const id of [chat.id, other.id]) {
      const wt = (await t.fresh(id)).worktree!
      expect(wt.removed).toBeUndefined()
      expect(wt.kept).toBeUndefined()
      expect(wt.links).toEqual(['angular/node_modules'])
    }
    expect(t.pushed.map((m) => m.id).sort()).toEqual([chat.id, other.id].sort())
    // The re-added worktree is clean again, links aside.
    expect(await t.svc.status(await t.fresh(chat.id))).toMatchObject({ changed: 0 })
  })

  it('clears a removed flag whose folder is still registered, without a worktree add', async () => {
    const t = await setup()
    await withModules(t.repo)
    const { worktree } = await t.svc.create(t.repo, 'dev')
    // Another machine marked it removed and the flag synced here; the folder is live and has lost its link.
    const chat = await t.addChat({ ...worktree, removed: true, kept: 'dirty' })
    const other = await t.addChat({ ...worktree, removed: true }, { archivedAt: 5 })
    await fs.rm(join(worktree.root, 'angular/node_modules'))
    t.calls.length = 0
    t.pushed.length = 0
    expect(await t.svc.ensure(await t.fresh(chat.id), { forTurn: true })).toBeNull()
    expect(t.calls.some((c) => c[0] === 'worktree' && c[1] === 'add')).toBe(false)
    for (const id of [chat.id, other.id]) {
      const wt = (await t.fresh(id)).worktree!
      expect(wt.removed).toBeUndefined()
      expect(wt.kept).toBeUndefined()
      expect(wt.links).toEqual(['angular/node_modules'])
    }
    expect((await fs.lstat(join(worktree.root, 'angular/node_modules'))).isSymbolicLink()).toBe(true)
    expect(t.pushed.map((m) => m.id).sort()).toEqual([chat.id, other.id].sort())
  })

  it('still lets git say why when the folder exists but git does not know it', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await t.svc.release(chat, { deleted: false })
    await fs.mkdir(worktree.root) // a stray folder where the worktree was (git adds into an empty one, so give it a file)
    await fs.writeFile(join(worktree.root, 'stray.txt'), 's\n')
    await expect(t.svc.ensure(await t.fresh(chat.id))).rejects.toThrow(/already exists/)
    expect((await t.fresh(chat.id)).worktree).toMatchObject({ removed: true })
  })

  it('re-adds after a manual delete', async () => {
    const t = await setup()
    const { worktree, cwd } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await fs.rm(worktree.root, { recursive: true })
    expect(await t.svc.ensure(await t.fresh(chat.id))).toBeNull()
    expect(await exists(cwd)).toBe(true)
    expect(sh(worktree.root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(worktree.branch)
    expect(t.calls.some((c) => c.join(' ') === 'worktree prune')).toBe(true)
  })

  it('remakes a deleted branch with a notice', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await t.svc.release(chat, { deleted: false })
    sh(t.repo, 'branch', '-D', worktree.branch)
    const notice = await t.svc.ensure(await t.fresh(chat.id), { forTurn: true })
    expect(notice).toBe(`Branch ${worktree.branch} was gone, so it was made again from repo's current HEAD.`)
    expect(sh(worktree.root, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe(worktree.branch)
    expect((await t.fresh(chat.id)).worktree?.removed).toBeUndefined()
  })

  it('tracks origin/<branch> when the local branch is gone but the remote has it', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await fs.writeFile(join(worktree.root, 'r.txt'), 'r\n')
    sh(worktree.root, 'add', '-A')
    sh(worktree.root, 'commit', '-q', '-m', 'remote work')
    const remote = join(t.tmp, 'remote.git')
    sh(t.tmp, 'init', '-q', '--bare', remote)
    sh(t.repo, 'remote', 'add', 'origin', remote)
    sh(t.repo, 'push', '-q', 'origin', worktree.branch)
    sh(t.repo, 'fetch', '-q', 'origin')
    await t.svc.release(chat, { deleted: false })
    sh(t.repo, 'branch', '-D', worktree.branch)
    expect(await t.svc.ensure(await t.fresh(chat.id))).toBeNull()
    expect(await exists(join(worktree.root, 'r.txt'))).toBe(true)
    expect(sh(worktree.root, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}').trim()).toBe(`origin/${worktree.branch}`)
  })

  it('refuses when the branch is checked out elsewhere, and deletes nothing', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await t.svc.release(chat, { deleted: false })
    sh(t.repo, 'switch', '-q', worktree.branch)
    await expect(t.svc.ensure(await t.fresh(chat.id))).rejects.toThrow(
      `Branch ${worktree.branch} is checked out in ${t.repo}. Switch that checkout to another branch, then send again.`
    )
    expect(branches(t.repo)).toContain(worktree.branch)
    expect((await t.fresh(chat.id)).worktree).toMatchObject({ removed: true })
    expect(t.calls.some((c) => c[0] === 'branch')).toBe(false)
  })

  it('names the branch in any other failure, and prunes after it', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await t.svc.release(chat, { deleted: false })
    const real = makeGit(env)
    const calls: { args: string[]; timeoutMs?: number }[] = []
    const git: Git = async (args, cwd, o) => {
      calls.push({ args, timeoutMs: o?.timeoutMs })
      if (args[0] === 'worktree' && args[1] === 'add') throw new GitError('fatal: disk full')
      return real(args, cwd, o)
    }
    const svc = service({ git, store: t.store })
    await expect(svc.ensure(await t.fresh(chat.id))).rejects.toThrow(new RegExp(`${worktree.branch}.*fatal: disk full`))
    expect(calls.find((c) => c.args[1] === 'add')?.timeoutMs).toBe(120_000)
    expect(calls.filter((c) => c.args.join(' ') === 'worktree prune').length).toBeGreaterThanOrEqual(2)
    expect(calls.some((c) => c.args[0] === 'branch')).toBe(false)
  })

  it('shares one add between concurrent ensures, and forgets the promise after', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await t.svc.release(chat, { deleted: false })
    const m = await t.fresh(chat.id)
    t.calls.length = 0
    const [a, b] = await Promise.all([t.svc.ensure(m), t.svc.ensure(m)])
    expect([a, b]).toEqual([null, null])
    expect(t.calls.filter((c) => c[0] === 'worktree' && c[1] === 'add')).toHaveLength(1)
    // A stale meta (still `removed`) after the add finished must not add again.
    t.calls.length = 0
    expect(await t.svc.ensure(m)).toBeNull()
    expect(t.calls.filter((c) => c[0] === 'worktree' && c[1] === 'add')).toHaveLength(0)
    // The map is empty again: a later removal rebuilds with a new add.
    await fs.rm(worktree.root, { recursive: true })
    expect(await t.svc.ensure(await t.fresh(chat.id))).toBeNull()
    expect(t.calls.filter((c) => c[0] === 'worktree' && c[1] === 'add')).toHaveLength(1)
  })

  it('waits for a running release', async () => {
    const t = await setup()
    await withModules(t.repo)
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    // The turn's ensure sees the folder (the chat is no longer archived by then) while release is still deciding.
    const gate: { open: () => void } = { open: () => {} }
    const held = new Promise<void>((r) => (gate.open = r))
    const real = makeGit(env)
    const git: Git = async (args, cwd, o) => {
      if (args.includes('status')) await held // release is parked at its status check
      return real(args, cwd, o)
    }
    const svc = service({ git, store: t.store, push: () => {} })
    const releasing = svc.release(chat, { deleted: false })
    const ensuring = svc.ensure(await t.fresh(chat.id))
    await new Promise((r) => setTimeout(r, 50))
    gate.open()
    await releasing
    await expect(ensuring).resolves.toBeNull()
    expect(await exists(worktree.root)).toBe(true)
    const wt = (await t.fresh(chat.id)).worktree!
    expect(wt.removed).toBeUndefined()
    expect((await fs.lstat(join(worktree.root, 'angular/node_modules'))).isSymbolicLink()).toBe(true)
  })

  it('gives the notice to only the first of concurrent ensures', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await t.svc.release(chat, { deleted: false })
    sh(t.repo, 'branch', '-D', worktree.branch)
    const m = await t.fresh(chat.id)
    const out = await Promise.all([
      t.svc.ensure(m, { forTurn: true }),
      t.svc.ensure(m, { forTurn: true }),
      t.svc.ensure(m, { forTurn: true })
    ])
    expect(out.filter((n) => n !== null)).toEqual([`Branch ${worktree.branch} was gone, so it was made again from repo's current HEAD.`])
    expect(t.calls.filter((c) => c[0] === 'worktree' && c[1] === 'add')).toHaveLength(2) // the first create, then one rebuild
  })

  it('a remake notice waits for the first turn', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await t.svc.release(chat, { deleted: false })
    sh(t.repo, 'branch', '-D', worktree.branch)
    expect(await t.svc.ensureChat(chat.id)).toBeNull()
    expect(await exists(worktree.root)).toBe(true)
    expect(await t.svc.ensureChat(chat.id, { forTurn: true })).toBe(
      `Branch ${worktree.branch} was gone, so it was made again from repo's current HEAD.`
    )
    expect(await t.svc.ensureChat(chat.id, { forTurn: true })).toBeNull()
  })

  it('a release drops a notice no turn took', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await t.svc.release(chat, { deleted: false })
    sh(t.repo, 'branch', '-D', worktree.branch)
    await t.svc.ensureChat(chat.id)
    await t.svc.release(await t.fresh(chat.id), { deleted: false })
    expect(await exists(worktree.root)).toBe(false)
    expect(await t.svc.ensureChat(chat.id, { forTurn: true })).toBeNull()
  })

  it('keeps no lock entry after the root goes idle, and a failure does not wedge the queue', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await t.svc.release(chat, { deleted: false })
    sh(t.repo, 'switch', '-q', worktree.branch)
    const m = await t.fresh(chat.id)
    const [bad, bad2] = await Promise.allSettled([t.svc.ensure(m), t.svc.ensure(m)])
    expect(bad.status).toBe('rejected')
    expect(bad2.status).toBe('rejected')
    sh(t.repo, 'switch', '-q', 'main')
    await expect(t.svc.ensure(m)).resolves.toBeNull()
    await new Promise((r) => setTimeout(r, 10))
    expect((t.svc as unknown as { locks: Map<string, unknown> }).locks.size).toBe(0)
  })

  it('forgets the promise after a failure so the next call retries', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await t.svc.release(chat, { deleted: false })
    sh(t.repo, 'switch', '-q', worktree.branch)
    const m = await t.fresh(chat.id)
    await expect(t.svc.ensure(m)).rejects.toThrow('is checked out in')
    sh(t.repo, 'switch', '-q', 'main')
    expect(await t.svc.ensure(m)).toBeNull()
    expect(await exists(worktree.root)).toBe(true)
  })

  it('refuses on a machine without the repo', async () => {
    const t = await setup()
    const plain = join(t.tmp, 'plain')
    await fs.mkdir(plain)
    const worktree: ChatWorktree = {
      root: join(t.tmp, 'repo-dev-aaaaaa'),
      branch: 'zumibot/dev-aaaaaa',
      source: plain,
      folder: plain,
      links: [],
      removed: true
    }
    await expect(t.svc.ensure(meta({ cwd: worktree.root, worktree }))).rejects.toThrow(
      `Can't rebuild the worktree: ${plain} is not a git repository on this machine.`
    )
    const missing = { ...worktree, source: join(t.tmp, 'nowhere') }
    await expect(t.svc.ensure(meta({ cwd: worktree.root, worktree: missing }))).rejects.toThrow(
      `Can't rebuild the worktree: ${missing.source} is not a git repository on this machine.`
    )
  })

  it('ensureChat loads the meta, and is null for a gone chat', async () => {
    const t = await setup()
    const { worktree } = await t.svc.create(t.repo, 'dev')
    const chat = await t.addChat(worktree)
    await t.svc.release(chat, { deleted: false })
    expect(await t.svc.ensureChat(chat.id)).toBeNull()
    expect(await exists(worktree.root)).toBe(true)
    expect(await t.svc.ensureChat('nope')).toBeNull()
    const plain = await t.store.create('agent', t.repo)
    expect(await t.svc.ensureChat(plain.id)).toBeNull()
  })
})
