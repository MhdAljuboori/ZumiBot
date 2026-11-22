import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { ChatMeta, ChatWorktree } from '@zumibot/shared/types'
import { GitChangesService, GIT_TEXT_MAX, NO_BASE_CHANGE, NO_CHANGE } from '../../../src/core/git/changes'
import { makeGit } from '../../../src/core/git/git'
import { symlinksWork } from '../../support/platform'

// A folder link as ZumiBot makes one: a junction on Windows, where a symlink needs a privilege.
const DIR_LINK = process.platform === 'win32' ? 'junction' : undefined

// The user's own git config must never leak into these repos.
const env = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' })

const tmps: string[] = []
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function tmpDir(): Promise<string> {
  const d = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-changes-')))
  tmps.push(d)
  return d
}

async function write(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(join(root, rel, '..'), { recursive: true })
    await fs.writeFile(join(root, rel), body)
  }
}

async function makeRepo(files: Record<string, string | Buffer> = {}, commit = true): Promise<string> {
  const repo = join(await tmpDir(), 'repo')
  await fs.mkdir(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@example.com')
  sh(repo, 'config', 'user.name', 'T')
  await write(repo, files)
  if (commit) {
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'init')
  }
  return repo
}

const service = (): GitChangesService => new GitChangesService(makeGit(env))
// The service reads only cwd and worktree, so a partial meta is enough.
const meta = (m: { cwd: string; worktree?: Partial<ChatWorktree> }): ChatMeta => m as unknown as ChatMeta

describe('GitChangesService.list', () => {
  it('is null outside a repo, in a missing folder and once the worktree folder was removed', async () => {
    const plain = await tmpDir()
    expect(await service().list(meta({ cwd: plain }))).toBeNull()
    expect(await service().list(meta({ cwd: join(plain, 'gone') }))).toBeNull()
    const repo = await makeRepo({ 'a.txt': 'a\n' })
    expect(await service().list(meta({ cwd: repo, worktree: { removed: true, links: [] } }))).toBeNull()
  })

  it('lists nothing in a clean repo, with the branch and short sha', async () => {
    const repo = await makeRepo({ 'a.txt': 'a\n' })
    const got = await service().list(meta({ cwd: repo }))
    expect(got).toEqual({ top: repo, branch: 'main', head: sh(repo, 'rev-parse', '--short=7', 'HEAD').trim(), files: [], more: 0 })
  })

  it('lists every kind of change with line counts, each untracked file on its own, from a subfolder too', async () => {
    const repo = await makeRepo({
      'src/app.ts': 'a\nb\nc\n',
      'gone.ts': 'x\ny\n',
      'old.ts': 'same\n',
      'logo.png': Buffer.from([0x89, 0x50, 0, 1])
    })
    await write(repo, {
      'src/app.ts': 'a\nB\nc\nd\n',
      'new dir/one.md': 'one\n',
      'new dir/two.md': 'two\nlines',
      'logo.png': Buffer.from([0x89, 0x50, 0, 2])
    })
    await fs.rm(join(repo, 'gone.ts'))
    sh(repo, 'mv', 'old.ts', 'renamed.ts')
    for (const cwd of [repo, join(repo, 'src')]) {
      const got = (await service().list(meta({ cwd })))!
      expect(got.top).toBe(repo)
      expect(got.files).toEqual([
        { path: 'gone.ts', kind: 'deleted', staged: false, added: 0, removed: 2 },
        { path: 'logo.png', kind: 'modified', staged: false, added: null, removed: null },
        { path: 'new dir/one.md', kind: 'untracked', staged: false, added: 1, removed: 0 },
        { path: 'new dir/two.md', kind: 'untracked', staged: false, added: 2, removed: 0 },
        { path: 'renamed.ts', from: 'old.ts', kind: 'renamed', staged: true, added: 0, removed: 0 },
        { path: 'src/app.ts', kind: 'modified', staged: false, added: 2, removed: 1 }
      ])
    }
  })

  it("leaves out the chat's node_modules links, as the chip does", async () => {
    const repo = await makeRepo({ 'a.txt': 'a\n' })
    await fs.symlink(await tmpDir(), join(repo, 'node_modules'), DIR_LINK)
    await write(repo, { 'b.txt': 'b\n' })
    const got = (await service().list(meta({ cwd: repo, worktree: { links: ['node_modules'] } })))!
    expect(got.files.map((f) => f.path)).toEqual(['b.txt'])
  })

  it('lists a repo with no commit yet, without counts for staged files', async () => {
    const repo = await makeRepo({ 'a.txt': 'a\n', 'b.txt': 'b\nb\n' }, false)
    sh(repo, 'add', 'a.txt')
    const got = (await service().list(meta({ cwd: repo })))!
    expect(got.files).toEqual([
      { path: 'a.txt', kind: 'added', staged: true, added: null, removed: null },
      { path: 'b.txt', kind: 'untracked', staged: false, added: 2, removed: 0 }
    ])
  })
})

describe('GitChangesService.diff', () => {
  it('reads HEAD and the folder for a modified file', async () => {
    const repo = await makeRepo({ 'src/app.ts': 'a\nb\n' })
    await write(repo, { 'src/app.ts': 'a\nc\n' })
    expect(await service().diff(meta({ cwd: join(repo, 'src') }), 'src/app.ts')).toEqual({
      path: 'src/app.ts',
      before: { text: 'a\nb\n' },
      after: { text: 'a\nc\n' }
    })
  })

  it('has no old side for an untracked or added file and no new side for a deleted one', async () => {
    const repo = await makeRepo({ 'gone.ts': 'x\n' })
    await write(repo, { 'new.ts': 'n\n', 'staged.ts': 's\n' })
    sh(repo, 'add', 'staged.ts')
    await fs.rm(join(repo, 'gone.ts'))
    const s = service()
    expect(await s.diff(meta({ cwd: repo }), 'new.ts')).toEqual({ path: 'new.ts', before: { miss: 'absent' }, after: { text: 'n\n' } })
    expect(await s.diff(meta({ cwd: repo }), 'staged.ts')).toEqual({
      path: 'staged.ts',
      before: { miss: 'absent' },
      after: { text: 's\n' }
    })
    expect(await s.diff(meta({ cwd: repo }), 'gone.ts')).toEqual({ path: 'gone.ts', before: { text: 'x\n' }, after: { miss: 'absent' } })
  })

  it("takes a rename's old side from its old path", async () => {
    const repo = await makeRepo({ 'old.ts': 'one\ntwo\n' })
    sh(repo, 'mv', 'old.ts', 'new.ts')
    await write(repo, { 'new.ts': 'one\ntwo\nthree\n' })
    expect(await service().diff(meta({ cwd: repo }), 'new.ts')).toEqual({
      path: 'new.ts',
      before: { text: 'one\ntwo\n' },
      after: { text: 'one\ntwo\nthree\n' }
    })
  })

  it('says binary or too big instead of sending the bytes', async () => {
    const repo = await makeRepo({ 'logo.png': Buffer.from([1, 0, 2]), 'big.txt': 'small\n' })
    await write(repo, { 'logo.png': Buffer.from([1, 0, 3]), 'big.txt': 'x'.repeat(GIT_TEXT_MAX + 1) })
    const s = service()
    expect(await s.diff(meta({ cwd: repo }), 'logo.png')).toEqual({
      path: 'logo.png',
      before: { miss: 'binary' },
      after: { miss: 'binary' }
    })
    expect(await s.diff(meta({ cwd: repo }), 'big.txt')).toEqual({
      path: 'big.txt',
      before: { text: 'small\n' },
      after: { miss: 'too-big' }
    })
  })

  it.skipIf(!symlinksWork)("shows a symlink's target, as git stores it, and never follows it", async () => {
    const outside = await tmpDir()
    await write(outside, { 'secret.txt': 'secret\n' })
    const repo = await makeRepo({ 'a.txt': 'a\n' })
    await fs.symlink(join(outside, 'secret.txt'), join(repo, 'link'))
    expect(await service().diff(meta({ cwd: repo }), 'link')).toEqual({
      path: 'link',
      before: { miss: 'absent' },
      after: { text: join(outside, 'secret.txt') }
    })
  })

  it('refuses a path git does not list as changed, a made-up one included', async () => {
    const repo = await makeRepo({ 'a.txt': 'a\n', 'clean.txt': 'c\n' })
    await write(repo, { 'a.txt': 'b\n' })
    const s = service()
    await expect(s.diff(meta({ cwd: repo }), 'clean.txt')).rejects.toThrow(NO_CHANGE)
    await expect(s.diff(meta({ cwd: repo }), '../../etc/passwd')).rejects.toThrow(NO_CHANGE)
    await expect(s.diff(meta({ cwd: await tmpDir() }), 'a.txt')).rejects.toThrow('Not in a git repository')
  })

  it("refuses the chat's own node_modules links", async () => {
    const repo = await makeRepo({ 'a.txt': 'a\n' })
    await fs.symlink(await tmpDir(), join(repo, 'node_modules'), DIR_LINK)
    await expect(service().diff(meta({ cwd: repo, worktree: { links: ['node_modules'] } }), 'node_modules')).rejects.toThrow(NO_CHANGE)
  })
})

describe('the base scope', () => {
  // A worktree chat: `base` is the commit it started from, so "Since start" sees committed work too.
  const since = async (files: Record<string, string>): Promise<{ repo: string; base: string }> => {
    const repo = await makeRepo(files)
    return { repo, base: sh(repo, 'rev-parse', 'HEAD').trim() }
  }

  it('lists a change the agent already committed, which the uncommitted scope does not', async () => {
    const { repo, base } = await since({ 'a.txt': 'a\nb\n' })
    await write(repo, { 'a.txt': 'a\nB\nc\n' })
    sh(repo, 'commit', '-qam', 'work')
    const m = meta({ cwd: repo, worktree: { base, links: [] } })
    expect((await service().list(m))?.files).toEqual([])
    const base_ = await service().list(m, 'base')
    expect(base_?.files).toEqual([{ path: 'a.txt', kind: 'modified', staged: false, added: 2, removed: 1 }])
    // The header still shows where the worktree is now, not the base.
    expect(base_?.branch).toBe('main')
  })

  it('counts committed and uncommitted work together, and lists an untracked file as well', async () => {
    const { repo, base } = await since({ 'a.txt': 'a\n', 'b.txt': 'b\n' })
    await write(repo, { 'a.txt': 'a\nmore\n' })
    sh(repo, 'commit', '-qam', 'step one')
    await write(repo, { 'b.txt': 'b\nalso\n', 'fresh.ts': 'new\nfile\n' })
    const got = await service().list(meta({ cwd: repo, worktree: { base, links: [] } }), 'base')
    expect(got?.files).toEqual([
      { path: 'a.txt', kind: 'modified', staged: false, added: 1, removed: 0 },
      { path: 'b.txt', kind: 'modified', staged: false, added: 1, removed: 0 },
      { path: 'fresh.ts', kind: 'untracked', staged: false, added: 2, removed: 0 }
    ])
  })

  it('reads the before side from the base commit, not from HEAD', async () => {
    const { repo, base } = await since({ 'a.txt': 'first\n' })
    await write(repo, { 'a.txt': 'second\n' })
    sh(repo, 'commit', '-qam', 'middle')
    await write(repo, { 'a.txt': 'third\n' })
    const m = meta({ cwd: repo, worktree: { base, links: [] } })
    expect(await service().diff(m, 'a.txt', 'base')).toEqual({ path: 'a.txt', before: { text: 'first\n' }, after: { text: 'third\n' } })
    expect(await service().diff(m, 'a.txt')).toEqual({ path: 'a.txt', before: { text: 'second\n' }, after: { text: 'third\n' } })
  })

  it('follows a rename and reads its old path at the base', async () => {
    const { repo, base } = await since({ 'old.ts': 'body\n' })
    sh(repo, 'mv', 'old.ts', 'new.ts')
    sh(repo, 'commit', '-qam', 'rename')
    const m = meta({ cwd: repo, worktree: { base, links: [] } })
    expect((await service().list(m, 'base'))?.files).toEqual([
      { path: 'new.ts', from: 'old.ts', kind: 'renamed', staged: false, added: 0, removed: 0 }
    ])
    expect(await service().diff(m, 'new.ts', 'base')).toEqual({ path: 'new.ts', before: { text: 'body\n' }, after: { text: 'body\n' } })
  })

  it('is null without a base commit, and refuses a diff there, so a chat made before base diffs just has none', async () => {
    const repo = await makeRepo({ 'a.txt': 'a\n' })
    await write(repo, { 'a.txt': 'b\n' })
    const plain = meta({ cwd: repo })
    expect(await service().list(plain, 'base')).toBeNull()
    await expect(service().diff(plain, 'a.txt', 'base')).rejects.toThrow('no base commit')
    const noBase = meta({ cwd: repo, worktree: { links: [] } })
    expect(await service().list(noBase, 'base')).toBeNull()
  })

  it('lists nothing once the work is back to the base, and refuses a path it does not list', async () => {
    const { repo, base } = await since({ 'a.txt': 'a\n' })
    const m = meta({ cwd: repo, worktree: { base, links: [] } })
    expect((await service().list(m, 'base'))?.files).toEqual([])
    await expect(service().diff(m, 'a.txt', 'base')).rejects.toThrow(NO_BASE_CHANGE)
  })

  it("leaves out ZumiBot's links", async () => {
    const { repo, base } = await since({ 'a.txt': 'a\n', '.gitignore': 'node_modules\n' })
    await fs.symlink(await tmpDir(), join(repo, 'node_modules'), DIR_LINK)
    await write(repo, { 'a.txt': 'b\n' })
    const got = await service().list(meta({ cwd: repo, worktree: { base, links: ['node_modules'] } }), 'base')
    expect(got?.files.map((f) => f.path)).toEqual(['a.txt'])
  })

  it('shows the base error from git when the commit is no longer in the repo', async () => {
    const { repo } = await since({ 'a.txt': 'a\n' })
    const gone = '0'.repeat(40)
    await expect(service().list(meta({ cwd: repo, worktree: { base: gone, links: [] } }), 'base')).rejects.toThrow(
      /fatal|bad object|unknown revision/i
    )
  })
})
