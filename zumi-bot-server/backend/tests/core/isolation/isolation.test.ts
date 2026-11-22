import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isolationRefusal } from '@zumibot/shared/engine'
import { execFileSync, spawnSync } from 'node:child_process'
import { PassThrough, Writable } from 'node:stream'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ISOLATION_OFF, sandboxBlocks, sandboxFileBlocked, type AgentIsolation } from '@zumibot/shared/isolation'
import {
  decodeRoots,
  encodeRoots,
  FILE_TOOLS_MATCHER,
  fileGuardCommand,
  fileGuardVerdict,
  runFileGuard
} from '../../../src/core/isolation/fileGuard'
import { addDirsOf, CODEX_SANDBOX_REFUSED, ISOLATION_UNREADABLE, IsolationService } from '../../../src/core/isolation/isolationService'
import { settingsFilesOf, wideningKeys, wideningRefusal } from '../../../src/core/isolation/projectWiden'
import { gitDirsOf, sandboxSettings, toolchainReads } from '../../../src/core/isolation/sandboxSettings'
import { checkSandbox, type SupportDeps } from '../../../src/core/isolation/sandboxSupport'

let dir: string
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-iso-')))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const SANDBOX: AgentIsolation = { ...ISOLATION_OFF, level: 'sandbox', network: ['registry.npmjs.org'] }
const priv = { home: '/home/u', dataDir: '/home/u/.local/share/zumibot', keyDir: '/home/u/.config/zumibot-vault' }
const HOOK = { node: '/opt/node', entry: '/opt/dist/sandboxFileHook.mjs', electronNode: false }
type Settings = {
  sandbox: Record<string, any>
  permissions: Record<string, any>
  hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] }
}

describe('sandboxSettings', () => {
  const place = {
    cwd: '/home/u/proj',
    tmpDir: '/home/u/.local/share/zumibot/claude-tmp/abc',
    gitDirs: ['/home/u/proj/.git'],
    readDirs: ['/home/u/.local/share/zumibot/attachments/c1'],
    memoryDir: '/home/u/.claude/agent-memory/a'
  }
  const s = sandboxSettings(SANDBOX, place, priv, ['/home/u/.nvm/versions/node/v22'], HOOK) as Settings

  it('fails closed, never retries outside, and does not loosen approvals', () => {
    expect(s.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false,
      excludedCommands: []
    })
    expect((sandboxSettings({ ...SANDBOX, autoBash: true }, place, priv, [], HOOK) as Settings).sandbox.autoAllowBashIfSandboxed).toBe(true)
  })
  it("hides home, the data dir and the vault key folder from Bash, re-opening only the run's own folders", () => {
    expect(s.sandbox.filesystem.denyRead).toEqual(['~/', priv.dataDir, priv.keyDir])
    expect(s.sandbox.filesystem.allowRead).toEqual(
      expect.arrayContaining([place.cwd, place.tmpDir, '/home/u/.nvm/versions/node/v22', place.readDirs[0]])
    )
    expect(s.sandbox.filesystem.allowRead).not.toContain(priv.dataDir)
    expect(s.sandbox.filesystem.allowWrite).toEqual([place.cwd, place.tmpDir, '/home/u/proj/.git'])
  })
  it("keeps the folder's Claude settings and git hooks and config unwritable", () => {
    expect(s.sandbox.filesystem.denyWrite).toEqual(
      expect.arrayContaining([
        '/home/u/proj/.claude/settings.json',
        '/home/u/proj/.claude/settings.local.json',
        '/home/u/proj/.mcp.json',
        '/home/u/proj/.git/hooks',
        '/home/u/proj/.git/config'
      ])
    )
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining(['Edit(//home/u/proj/.claude/settings.json)', 'Write(//home/u/proj/.git/**)'])
    )
  })
  it('allows only the network list, strictly, and sends every fetch to ZumiBot', () => {
    expect(s.sandbox.network).toEqual({
      allowedDomains: ['registry.npmjs.org'],
      strictAllowlist: true,
      allowLocalBinding: false,
      allowAllUnixSockets: false
    })
    expect(s.permissions.ask).toEqual(['WebFetch'])
    expect(s.permissions.deny).toContain('WebSearch')
    expect((sandboxSettings({ ...SANDBOX, webSearch: true }, place, priv, [], HOOK) as Settings).permissions.deny).not.toContain(
      'WebSearch'
    )
  })
  it("holds the file tools to the run's folders with ZumiBot's own hook, not the CLI's block keys (they also catch Bash's /dev/null)", () => {
    expect(s.permissions).not.toHaveProperty('blockReadsOutsideWorkingDirectories')
    expect(s.permissions).not.toHaveProperty('additionalDirectories')
    const hook = s.hooks.PreToolUse[0]
    expect(hook.matcher).toBe(FILE_TOOLS_MATCHER)
    const cmd = hook.hooks[0].command
    expect(cmd.startsWith("'/opt/node' '/opt/dist/sandboxFileHook.mjs' ")).toBe(true)
    expect(cmd.endsWith('; [ $? -eq 0 ] && exit 0; exit 2')).toBe(true)
    expect(decodeRoots(cmd.split(' ')[2].replace(/;$/, ''))).toEqual({
      read: [place.cwd, place.tmpDir, place.memoryDir, place.readDirs[0]],
      write: [place.cwd, place.tmpDir, place.memoryDir],
      deny: [
        '/home/u/proj/.claude/settings.json',
        '/home/u/proj/.claude/settings.local.json',
        '/home/u/proj/.mcp.json',
        '/home/u/proj/.git/hooks',
        '/home/u/proj/.git/config',
        '/home/u/proj/.git'
      ]
    })
  })
})

describe('file guard', () => {
  const roots = { read: ['/w', '/ro'], write: ['/w'], deny: ['/w/.git', '/w/.claude/settings.json'] }
  const call = (tool: string, input: object, cwd = '/w') => JSON.stringify({ tool_name: tool, tool_input: input, cwd })
  const id = (p: string) => p // no symlinks in this fake tree
  const v = (tool: string, input: object, cwd?: string) => fileGuardVerdict(call(tool, input, cwd), roots, id)

  it('lets reads and writes inside the folders run', () => {
    expect(v('Read', { file_path: '/w/a.txt' })).toBeNull()
    expect(v('Read', { file_path: '/ro/b.txt' })).toBeNull()
    expect(v('Write', { file_path: 'sub/c.txt' })).toBeNull()
    expect(v('Grep', { pattern: 'x' })).toBeNull()
    expect(v('Glob', { pattern: '**/*.ts' })).toBeNull()
    expect(v('Bash', { command: 'cat /etc/passwd' })).toBeNull()
  })
  it('blocks anything outside, a write to a read-only or protected place, and a path climbing out', () => {
    expect(v('Read', { file_path: '/home/u/.ssh/id_ed25519' })).toBe('/home/u/.ssh/id_ed25519')
    expect(v('Write', { file_path: '/ro/b.txt' })).toBe('/ro/b.txt')
    expect(v('Edit', { file_path: '/w/.git/hooks/pre-commit' })).toBe('/w/.git/hooks/pre-commit')
    expect(v('Edit', { file_path: '/w/.claude/settings.json' })).toBe('/w/.claude/settings.json')
    expect(v('Read', { file_path: '/w/../etc/passwd' })).toBe('/etc/passwd')
    expect(v('Grep', { pattern: 'x', path: '/etc' })).toBe('/etc')
    expect(v('Glob', { pattern: '/etc/*' })).toBe('/etc')
    expect(v('Glob', { pattern: '../../**' })).toBe('../../**')
    expect(v('NotebookEdit', { notebook_path: '/tmp/x.ipynb' })).toBe('/tmp/x.ipynb')
  })
  it('fails closed on unreadable input or a missing path', () => {
    expect(fileGuardVerdict('not json', roots, id)).not.toBeNull()
    expect(v('Read', {})).toBe('(no path)')
  })
  it('follows symlinks, so a link inside the folder cannot reach out', async () => {
    const w = join(dir, 'w')
    await fs.mkdir(w)
    await fs.symlink('/etc', join(w, 'etc-link'))
    expect(fileGuardVerdict(call('Read', { file_path: join(w, 'etc-link', 'passwd') }, w), { read: [w], write: [w], deny: [] })).toBe(
      join(w, 'etc-link', 'passwd')
    )
    expect(fileGuardVerdict(call('Write', { file_path: join(w, 'new', 'file.txt') }, w), { read: [w], write: [w], deny: [] })).toBeNull()
  })
  it('the hook process writes the block line and exits 2, or exits 0', async () => {
    const run = (input: string, r: typeof roots | null) =>
      new Promise<{ code: number; err: string }>((done) => {
        const stdin = new PassThrough()
        let err = ''
        const stderr = new Writable({
          write(c, _e, cb) {
            err += String(c)
            cb()
          }
        })
        runFileGuard({ stdin, stderr, exit: (code) => done({ code, err }), roots: r })
        stdin.end(input)
      })
    expect(await run(call('Read', { file_path: '/w/a' }), roots)).toEqual({ code: 0, err: '' })
    const blocked = await run(call('Read', { file_path: '/etc/shadow' }), roots)
    expect(blocked.code).toBe(2)
    expect(blocked.err).toBe(sandboxFileBlocked('/etc/shadow') + '\n')
    expect(sandboxBlocks(blocked.err)).toEqual([{ kind: 'file', target: '/etc/shadow' }])
    expect((await run(call('Read', { file_path: '/w/a' }), null)).code).toBe(2)
  })
  it('the command turns a crash into a block', () => {
    const cmd = fileGuardCommand({ node: '/no/such/node', entry: '/x.mjs', electronNode: false }, roots)
    const r = spawnSync('sh', ['-c', cmd], { input: call('Read', { file_path: '/w/a' }), encoding: 'utf8' })
    expect(r.status).toBe(2)
    expect(encodeRoots(roots)).toMatch(/^[A-Za-z0-9_-]+$/)
  })
})

describe('toolchainReads', () => {
  it('grants a version folder for a nested bin, but only the bin under home or ~/.local', () => {
    const path = '/home/u/.nvm/versions/node/v22/bin:/home/u/.local/bin:/home/u/.cargo/bin:/usr/bin:/home/u:relative/bin'
    expect(toolchainReads(path, '/home/u')).toEqual([
      '/home/u/.nvm/versions/node/v22',
      '/home/u/.local/bin',
      '/home/u/.cargo/bin',
      '/home/u/.gitconfig',
      '/home/u/.config/git'
    ])
  })
})

describe('gitDirsOf', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' })
  it("finds a repo's .git from a subfolder, a worktree's own and common git dirs, and nothing outside a repo", async () => {
    const repo = join(dir, 'repo')
    await fs.mkdir(join(repo, 'sub'), { recursive: true })
    git(repo, 'init', '-q')
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'x')
    expect(await gitDirsOf(join(repo, 'sub'))).toEqual([join(repo, '.git')])
    git(repo, 'worktree', 'add', '-q', join(dir, 'wt'))
    expect(await gitDirsOf(join(dir, 'wt'))).toEqual([join(repo, '.git')])
    const plain = join(dir, 'plain')
    await fs.mkdir(plain)
    // The temp root has no repo above it on this machine; a real home might, so only "no crash" is asserted there.
    expect(Array.isArray(await gitDirsOf(plain))).toBe(true)
  })
})

describe('project settings that widen', () => {
  it('names every list key that adds folders or hosts', () => {
    expect(
      wideningKeys({
        sandbox: { filesystem: { allowWrite: ['/x'] }, network: { allowedDomains: ['a.com'] } },
        permissions: { additionalDirectories: ['/y'] }
      })
    ).toEqual(['sandbox.filesystem.allowWrite', 'sandbox.network.allowedDomains', 'permissions.additionalDirectories'])
    expect(wideningKeys({ sandbox: { filesystem: { allowWrite: [] } }, permissions: { allow: ['WebFetch(domain:a.com)'] } })).toEqual([])
  })
  it("reads the folder's and its parents' .claude settings and the user's", () => {
    expect(settingsFilesOf('/home/u/a/b', '/home/u')).toEqual([
      '/home/u/a/b/.claude/settings.json',
      '/home/u/a/b/.claude/settings.local.json',
      '/home/u/a/.claude/settings.json',
      '/home/u/a/.claude/settings.local.json',
      '/home/.claude/settings.json',
      '/home/.claude/settings.local.json',
      '/.claude/settings.json',
      '/.claude/settings.local.json',
      '/home/u/.claude/settings.json',
      '/home/u/.claude/settings.local.json',
      '/etc/claude-code/managed-settings.json'
    ])
  })
  it('refuses a run whose folder settings widen, naming the file and keys', async () => {
    const cwd = join(dir, 'proj')
    await fs.mkdir(join(cwd, '.claude'), { recursive: true })
    expect(await wideningRefusal(cwd, join(dir, 'home'))).toBeNull()
    await fs.writeFile(
      join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ sandbox: { network: { allowedDomains: ['evil.com'] } } })
    )
    const refusal = await wideningRefusal(cwd, join(dir, 'home'))
    expect(refusal).toContain(join(cwd, '.claude', 'settings.local.json'))
    expect(refusal).toContain('sandbox.network.allowedDomains')
  })
})

describe('checkSandbox', () => {
  const deps = (o: Partial<SupportDeps> & { files?: string[]; code?: number | null } = {}): SupportDeps => ({
    platform: 'linux',
    path: '/usr/bin',
    exists: (p) => (o.files ?? ['/usr/bin/bwrap', '/usr/bin/socat']).includes(p),
    run: async () => o.code ?? 0,
    ...o
  })
  it('is available on Linux with bwrap and socat that can make a namespace', async () => {
    expect(await checkSandbox(deps())).toEqual({ available: true })
  })
  it('says why when it is not', async () => {
    expect(await checkSandbox(deps({ files: ['/usr/bin/socat'] }))).toMatchObject({
      available: false,
      reason: expect.stringContaining('bubblewrap')
    })
    expect(await checkSandbox(deps({ files: ['/usr/bin/bwrap'] }))).toMatchObject({
      available: false,
      reason: expect.stringContaining('socat')
    })
    expect(await checkSandbox(deps({ code: 1 }))).toMatchObject({ available: false, reason: expect.stringContaining('user namespaces') })
    expect(await checkSandbox(deps({ files: ['/usr/bin/bwrap', '/usr/bin/socat', '/.dockerenv'] }))).toMatchObject({
      available: false,
      reason: expect.stringContaining('container')
    })
    expect(await checkSandbox(deps({ platform: 'win32' }))).toMatchObject({ available: false })
    expect(await checkSandbox(deps({ platform: 'darwin', files: [] }))).toEqual({ available: true })
  })
})

describe('IsolationService', () => {
  const svc = (o: { available?: boolean } = {}) =>
    new IsolationService({
      file: join(dir, 'audit', 'isolation.json'),
      home: join(dir, 'home'),
      dataDir: join(dir, 'data'),
      keyDir: join(dir, 'key'),
      pathEnv: async () => '/usr/bin',
      fileHook: HOOK,
      checkSupport: async () => (o.available === false ? { available: false, reason: 'No bwrap here.' } : { available: true })
    })
  const place = () => ({ engine: 'claude' as const, cwd: join(dir, 'proj'), tmpDir: null, addDirs: [], memoryDir: null })

  it('an agent never set is Off and its run is untouched', async () => {
    const s = svc()
    await s.start()
    expect(s.get('a')).toEqual(ISOLATION_OFF)
    expect(await s.runFor('a', place())).toEqual({ level: 'off' })
  })
  it('stores settings 0600 in its folder, reads them back, and moves them on a rename', async () => {
    const s = svc()
    await s.start()
    await s.set('a', SANDBOX)
    if (process.platform !== 'win32') expect((await fs.stat(join(dir, 'audit', 'isolation.json'))).mode & 0o777).toBe(0o600)
    const again = svc()
    await again.start()
    expect(again.get('a')).toEqual(SANDBOX)
    await again.rename('a', 'b')
    expect(again.get('a')).toEqual(ISOLATION_OFF)
    expect(again.levelOf('b')).toBe('sandbox')
  })
  it('gives a sandboxed run its settings', async () => {
    const s = svc()
    await s.start()
    await s.set('a', SANDBOX)
    await fs.mkdir(join(dir, 'proj'))
    const run = await s.runFor('a', place())
    expect(run).toMatchObject({ level: 'sandbox', network: ['registry.npmjs.org'] })
    expect(JSON.parse((run as { settings: string }).settings).sandbox.enabled).toBe(true)
  })
  it('refuses, never runs unsandboxed: no sandbox here, a Codex agent, widening settings, an unreadable file', async () => {
    const off = svc({ available: false })
    await off.start()
    await off.set('a', SANDBOX)
    expect(await off.runFor('a', place())).toEqual({ level: 'sandbox', refused: expect.stringContaining('No bwrap here.') })

    const s = svc()
    await s.start()
    await s.set('a', SANDBOX)
    expect(await s.runFor('a', { ...place(), engine: 'codex' })).toEqual({ level: 'sandbox', refused: CODEX_SANDBOX_REFUSED })
    // An ACP or remote agent set to Sandboxed (it was a Claude agent when set) is refused too, never run as Off.
    expect(await s.runFor('a', { ...place(), engine: 'acp' })).toEqual({ level: 'sandbox', refused: isolationRefusal('acp', 'sandbox') })
    expect(await s.runFor('a', { ...place(), engine: 'ag-ui' })).toEqual({
      level: 'sandbox',
      refused: isolationRefusal('ag-ui', 'sandbox')
    })
    await fs.mkdir(join(dir, 'proj', '.claude'), { recursive: true })
    await fs.writeFile(join(dir, 'proj', '.claude', 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: ['/'] } }))
    expect(await s.runFor('a', place())).toEqual({ level: 'sandbox', refused: expect.stringContaining('widens the sandbox') })

    await fs.writeFile(join(dir, 'audit', 'isolation.json'), '{ not json')
    const broken = svc()
    await broken.start()
    expect(await broken.runFor('anyone', place())).toEqual({ level: 'sandbox', refused: ISOLATION_UNREADABLE })
    await fs.writeFile(join(dir, 'audit', 'isolation.json'), JSON.stringify({ v: 1, agents: { a: { level: 'vm' } } }))
    const bad = svc()
    await bad.start()
    expect(await bad.runFor('a', place())).toEqual({ level: 'sandbox', refused: ISOLATION_UNREADABLE })
    expect(await bad.runFor('other', place())).toEqual({ level: 'off' })
  })
  it("reads a run's --add-dir folders", () => {
    expect(addDirsOf(['--add-dir', '/a', '--model', 'x', '--add-dir', '/b'])).toEqual(['/a', '/b'])
  })
})
