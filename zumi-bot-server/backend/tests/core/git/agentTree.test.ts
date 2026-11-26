import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import type { ChatItem, ChatMeta, ChatWorktree } from '@zumibot/shared/types'
import { agentTreeOf, branchStart, parseWorktreeList, toolPlaces, treeOf } from '../../../src/core/git/agentTree'
import { GitChangesService } from '../../../src/core/git/changes'
import { makeGit } from '../../../src/core/git/git'
import { WorktreeService } from '../../../src/core/git/worktrees'
import { isolatedGitEnv } from '../../support/gitEnv'

// The user's own git config must never leak into these repos.
const env = isolatedGitEnv
const git = makeGit(env)
const sh = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' })
const posix = process.platform !== 'win32'

const tmps: string[] = []
afterEach(async () => {
  await Promise.all(tmps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

/** A repo with one commit and, beside it, a worktree of it on its own branch (as an agent makes one with Bash). */
async function makeRepo(): Promise<{ tmp: string; repo: string; wt: string }> {
  const tmp = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-agenttree-')))
  tmps.push(tmp)
  const repo = join(tmp, 'repo')
  await fs.mkdir(join(repo, 'app'), { recursive: true })
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 't@example.com')
  sh(repo, 'config', 'user.name', 'T')
  await fs.writeFile(join(repo, 'app', 'a.ts'), 'a\n')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', 'init')
  const wt = join(tmp, 'wt-feature')
  sh(repo, 'worktree', 'add', '-q', '-b', 'feature', wt)
  return { tmp, repo, wt }
}

let n = 0
const tool = (name: string, input: unknown): ChatItem => ({
  type: 'tool',
  id: `t${++n}`,
  name,
  input,
  result: '',
  isError: false,
  blocked: false,
  ts: n
})
const bash = (command: string): ChatItem => tool('Bash', { command })
const said = (text: string): ChatItem => ({ type: 'assistant', id: `a${++n}`, text, ts: n })
const items =
  (...list: ChatItem[]) =>
  async () =>
    list
// Reads only cwd and worktree, so a partial meta is enough.
const meta = (m: { cwd: string; worktree?: Partial<ChatWorktree> }): ChatMeta => m as unknown as ChatMeta
// The followed worktree's folder, or null.
const pathOf = async (...args: Parameters<typeof agentTreeOf>): Promise<string | null> => (await agentTreeOf(...args))?.path ?? null

// POSIX paths: on Windows `/w` resolves onto the current drive.
describe.runIf(posix)('toolPlaces', () => {
  const home = '/home/me'

  it("gives a file tool's folder", () => {
    expect(toolPlaces(tool('Edit', { file_path: '/w/src/a.ts' }), home)).toEqual(['/w/src'])
    expect(toolPlaces(tool('Write', { file_path: '/w/b.ts' }), home)).toEqual(['/w'])
    expect(toolPlaces(tool('MultiEdit', { file_path: '/w/c.ts' }), home)).toEqual(['/w'])
    expect(toolPlaces(tool('NotebookEdit', { notebook_path: '/w/n.ipynb' }), home)).toEqual(['/w'])
  })

  it('gives where a shell line ran, the last cd first', () => {
    expect(toolPlaces(bash('cd /a && ls; cd "/b c" && git status'), home)).toEqual(['/b c', '/a'])
    expect(toolPlaces(bash("cd '/q' && x"), home)).toEqual(['/q'])
    expect(toolPlaces(bash('git -C /w diff --stat'), home)).toEqual(['/w'])
    expect(toolPlaces(bash('ls\ncd /x\nmake'), home)).toEqual(['/x'])
    expect(toolPlaces(bash('(cd /sub && make)'), home)).toEqual(['/sub'])
    expect(toolPlaces(bash('cd ~/work && ls'), home)).toEqual(['/home/me/work'])
    expect(toolPlaces(bash('cd $HOME/work && ls'), home)).toEqual(['/home/me/work'])
  })

  it('skips a relative place, whose shell folder the item does not record', () => {
    expect(toolPlaces(bash('cd angular && ls'), home)).toEqual([])
    expect(toolPlaces(tool('Edit', { file_path: 'src/a.ts' }), home)).toEqual([])
    // Not a cd: a word that only ends in "cd".
    expect(toolPlaces(bash('abcd /x'), home)).toEqual([])
  })

  it('reads any tool with a shell command and a cwd, such as a background process', () => {
    expect(toolPlaces(tool('mcp__zumibot_processes__start', { command: 'cd /x && ng serve', cwd: '/y' }), home)).toEqual(['/x', '/y'])
  })

  it('gives nothing for a read, an unknown input or a message', () => {
    expect(toolPlaces(tool('Read', { file_path: '/w/a.ts' }), home)).toEqual([])
    expect(toolPlaces(tool('Bash', null), home)).toEqual([])
    expect(toolPlaces(tool('Edit', { file_path: 5 }), home)).toEqual([])
    expect(toolPlaces(said('cd /x'), home)).toEqual([])
  })
})

describe.runIf(posix)('treeOf', () => {
  it('picks the deepest worktree holding the path, and only a real parent', () => {
    const trees = ['/r', '/r/.claude/worktrees/x', '/r-wt']
    expect(treeOf('/r/src', trees)).toBe('/r')
    expect(treeOf('/r', trees)).toBe('/r')
    expect(treeOf('/r/.claude/worktrees/x/src', trees)).toBe('/r/.claude/worktrees/x')
    expect(treeOf('/r-wt/src', trees)).toBe('/r-wt')
    expect(treeOf('/other', trees)).toBeNull()
  })
})

describe('parseWorktreeList', () => {
  it('lists the folders there are to read: not bare, not prunable', () => {
    const text = [
      'worktree /r',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /r-wt',
      'HEAD def',
      'detached',
      '',
      'worktree /gone',
      'HEAD 123',
      'branch refs/heads/x',
      'prunable gitdir file points to non-existent location',
      '',
      'worktree /bare.git',
      'bare',
      ''
    ].join('\n')
    expect(parseWorktreeList(text)).toEqual([
      { path: '/r', branch: 'main', main: true },
      { path: '/r-wt', branch: null, main: false }
    ])
    // A bare repo's own entry comes first and is left out, but it is still the main one: no linked worktree takes its place.
    expect(parseWorktreeList('worktree /b.git\nbare\n\nworktree /b-wt\nHEAD 1\nbranch refs/heads/feature/x\n')).toEqual([
      { path: '/b-wt', branch: 'feature/x', main: false }
    ])
  })
})

describe('agentTreeOf', () => {
  it('follows the other worktree of the repo the agent last worked in', async () => {
    const { repo, wt } = await makeRepo()
    const got = await pathOf(git, meta({ cwd: repo }), items(bash(`cd ${wt}/app && ls`), said('done')))
    expect(got).toBe(wt)
    // A file tool counts as much as a shell line.
    expect(await pathOf(git, meta({ cwd: repo }), items(tool('Edit', { file_path: join(wt, 'app', 'a.ts') })))).toBe(wt)
  })

  it("is null while the agent's last place is the chat's own folder, or nothing it did names one", async () => {
    const { repo, wt } = await makeRepo()
    expect(await pathOf(git, meta({ cwd: repo }), items(bash(`cd ${wt} && ls`), bash(`cd ${repo}/app && ls`)))).toBeNull()
    expect(await pathOf(git, meta({ cwd: join(repo, 'app') }), items(bash('ls'), said('hi')))).toBeNull()
    expect(await pathOf(git, meta({ cwd: repo }), items())).toBeNull()
  })

  it('looks past places outside the repo, such as scratch files in /tmp', async () => {
    const { tmp, repo, wt } = await makeRepo()
    const list = items(bash(`cd ${wt} && git commit -qm x`), tool('Write', { file_path: join(tmp, 'notes', 'pr.md') }), bash('cd / && ls'))
    expect(await pathOf(git, meta({ cwd: repo }), list)).toBe(wt)
  })

  it('follows a worktree only while it is still there', async () => {
    const { repo, wt } = await makeRepo()
    sh(repo, 'worktree', 'remove', wt)
    expect(await pathOf(git, meta({ cwd: repo }), items(bash(`cd ${wt} && ls`)))).toBeNull()
  })

  it('does not load the items when the repo has no other worktree', async () => {
    const { repo, wt } = await makeRepo()
    sh(repo, 'worktree', 'remove', wt)
    let loaded = false
    const got = await agentTreeOf(git, meta({ cwd: repo }), async () => {
      loaded = true
      return []
    })
    expect(got).toBeNull()
    expect(loaded).toBe(false)
  })

  it('picks a worktree nested inside the main checkout, and the main checkout from a nested one', async () => {
    const { repo } = await makeRepo()
    const nested = join(repo, '.claude', 'worktrees', 'x')
    sh(repo, 'worktree', 'add', '-q', '-b', 'nested', nested)
    expect(await pathOf(git, meta({ cwd: repo }), items(tool('Edit', { file_path: join(nested, 'app', 'a.ts') })))).toBe(nested)
    expect(await pathOf(git, meta({ cwd: nested }), items(bash(`cd ${repo} && ls`)))).toBe(repo)
  })

  it.runIf(posix)('matches a place reached through a symlink, as /tmp is on macOS', async () => {
    const { tmp, repo, wt } = await makeRepo()
    const alias = join(tmp, 'alias')
    await fs.symlink(wt, alias)
    expect(await pathOf(git, meta({ cwd: repo }), items(bash(`cd ${alias}/app && ls`)))).toBe(wt)
  })

  it('is null outside a repo and for a removed chat worktree', async () => {
    const { tmp, repo, wt } = await makeRepo()
    const plain = join(tmp, 'plain')
    await fs.mkdir(plain)
    expect(await pathOf(git, meta({ cwd: plain }), items(bash(`cd ${wt} && ls`)))).toBeNull()
    expect(await pathOf(git, meta({ cwd: repo, worktree: { removed: true } }), items(bash(`cd ${wt} && ls`)))).toBeNull()
  })
})

describe("the chip and the Changes panel read the agent's worktree", () => {
  const worktrees = (): WorktreeService =>
    new WorktreeService({
      git,
      store: { list: async () => [], patchInPlace: async () => null },
      push: () => {},
      hex: () => 'aaaaaa',
      log: () => {}
    })

  it("counts and lists the agent's worktree, not the chat's folder, and says which", async () => {
    const { repo, wt } = await makeRepo()
    // The user's own edit in the chat's folder, and the agent's in its worktree.
    await fs.writeFile(join(repo, 'app', 'a.ts'), 'mine\n')
    await fs.writeFile(join(wt, 'app', 'b.ts'), 'agent\n')
    await fs.writeFile(join(wt, 'app', 'c.ts'), 'agent\n')
    const m = meta({ cwd: repo })
    const list = items(bash(`cd ${wt}/app && ls`))

    expect(await worktrees().status(m, list)).toMatchObject({ branch: 'feature', changed: 2, agentTree: wt })
    expect(await worktrees().status(m)).toMatchObject({ branch: 'main', changed: 1 })
    expect(await worktrees().status(m)).not.toHaveProperty('agentTree')

    const changes = new GitChangesService(git)
    const got = await changes.list(m, 'uncommitted', list)
    expect(got).toMatchObject({ top: wt, branch: 'feature', agentTree: wt })
    expect(got?.files.map((f) => f.path)).toEqual(['app/b.ts', 'app/c.ts'])
    expect((await changes.diff(m, 'app/b.ts', 'uncommitted', list)).after).toEqual({ text: 'agent\n' })
    // The chat's own folder, read without the items, is unchanged.
    const own = await changes.list(m, 'uncommitted')
    expect(own?.files.map((f) => f.path)).toEqual(['app/a.ts'])
    expect(own).not.toHaveProperty('agentTree')
  })

  it("measures Since start in the agent's worktree from where its branch was created", async () => {
    const { repo, wt } = await makeRepo()
    const start = sh(wt, 'rev-parse', 'HEAD').trim()
    // The agent's work, committed and not; and the user's own edit in the chat's folder, which must not show.
    await fs.writeFile(join(wt, 'app', 'b.ts'), 'agent\n')
    sh(wt, 'add', '-A')
    sh(wt, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'agent work')
    await fs.writeFile(join(wt, 'app', 'c.ts'), 'agent, not committed\n')
    await fs.writeFile(join(repo, 'app', 'a.ts'), 'mine\n')
    // A chat worktree's own base is not the agent's start.
    const m = meta({ cwd: repo, worktree: { base: 'f'.repeat(40) } })
    const list = items(bash(`cd ${wt} && git commit`))
    const changes = new GitChangesService(git)

    const uncommitted = await changes.list(m, 'uncommitted', list)
    expect(uncommitted?.files.map((f) => f.path)).toEqual(['app/c.ts'])
    expect(uncommitted).toMatchObject({ agentTree: wt, base: start })
    const since = await changes.list(m, 'base', list)
    expect(since?.files.map((f) => `${f.kind} ${f.path}`)).toEqual(['added app/b.ts', 'untracked app/c.ts'])
    expect(since).toMatchObject({ agentTree: wt, base: start })
    expect(await changes.diff(m, 'app/b.ts', 'base', list)).toEqual({
      path: 'app/b.ts',
      before: { miss: 'absent' },
      after: { text: 'agent\n' }
    })
  })

  it('has no Since start for an agent working in the main checkout or on a detached HEAD', async () => {
    const { repo, wt } = await makeRepo()
    const changes = new GitChangesService(git)
    // The chat sits in the linked worktree and the agent works in the main checkout, whose branch reaches back to the clone.
    const inMain = await changes.list(meta({ cwd: wt }), 'uncommitted', items(bash(`cd ${repo} && ls`)))
    expect(inMain).toMatchObject({ agentTree: repo })
    expect(inMain).not.toHaveProperty('base')
    expect(await changes.list(meta({ cwd: wt }), 'base', items(bash(`cd ${repo} && ls`)))).toBeNull()
    sh(wt, 'switch', '-q', '--detach')
    const detached = await changes.list(meta({ cwd: repo }), 'uncommitted', items(bash(`cd ${wt} && ls`)))
    expect(detached).toMatchObject({ agentTree: wt })
    expect(detached).not.toHaveProperty('base')
  })

  it("keeps the chat worktree's own base when the agent works there", async () => {
    const { repo } = await makeRepo()
    const base = sh(repo, 'rev-parse', 'HEAD').trim()
    await fs.writeFile(join(repo, 'app', 'a.ts'), 'mine\n')
    const got = await new GitChangesService(git).list(meta({ cwd: repo, worktree: { base } }), 'base', items(bash(`cd ${repo} && ls`)))
    expect(got?.files.map((f) => f.path)).toEqual(['app/a.ts'])
    expect(got).toMatchObject({ base })
    expect(got).not.toHaveProperty('agentTree')
  })
})

describe('branchStart', () => {
  it('is the commit the branch was created at, however far it moved since, and null without one', async () => {
    const { repo, wt } = await makeRepo()
    const start = sh(wt, 'rev-parse', 'HEAD').trim()
    sh(wt, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'one')
    sh(wt, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'two')
    expect(await branchStart(git, { path: wt, branch: 'feature', main: false })).toBe(start)
    expect(await branchStart(git, { path: repo, branch: 'main', main: true })).toBeNull()
    expect(await branchStart(git, { path: wt, branch: null, main: false })).toBeNull()
    expect(await branchStart(git, { path: wt, branch: 'no-such-branch', main: false })).toBeNull()
  })
})
