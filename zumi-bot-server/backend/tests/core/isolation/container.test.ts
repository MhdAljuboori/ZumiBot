import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isolationRefusal } from '@zumibot/shared/engine'
import http from 'node:http'
import net from 'node:net'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ISOLATION_OFF, parseIsolation, sandboxBlocks, type AgentIsolation } from '@zumibot/shared/isolation'
import { createAuthProxy, pathAllowed, serverCredential, upstreamHeaders, type Credential } from '../../../src/core/isolation/authProxy'
import { createNetProxy } from '../../../src/core/isolation/netProxy'
import {
  ContainerRunner,
  IN_CLAUDE,
  pruneHomes,
  IN_NODE,
  innerArgs,
  linkTargets,
  mountRefusal,
  podmanRunArgs,
  projectDirName,
  sweepOwned,
  withNetBlocks,
  type PodmanRun
} from '../../../src/core/isolation/containerRunner'
import { AGENT_IMAGE, checkContainer, type ContainerSupportDeps } from '../../../src/core/isolation/containerSupport'
import { CODEX_CONTAINER_REFUSED, CONTAINER_DESKTOP_REFUSED, IsolationService } from '../../../src/core/isolation/isolationService'
// @ts-expect-error a plain .mjs script without types
import { TAG } from '../../../../container/build.mjs'

let dir: string
beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-ctr-')))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

const CONTAINER: AgentIsolation = { ...ISOLATION_OFF, level: 'container', network: ['registry.npmjs.org'] }

const listen = (s: http.Server, at: string | number) => new Promise<void>((ok) => s.listen(at as number, '127.0.0.1', () => ok()))
const listenSock = (s: http.Server, path: string) => new Promise<void>((ok) => s.listen(path, () => ok()))
const closeServer = (s: http.Server | net.Server) =>
  new Promise<void>((ok) => {
    s.close(() => ok())
    ;(s as http.Server).closeAllConnections?.()
  })

describe('the setting', () => {
  it('container is a level of its own', () => {
    expect(parseIsolation({ level: 'container', network: ['*.example.com'] })).toMatchObject({
      level: 'container',
      network: ['*.example.com']
    })
    expect(() => parseIsolation({ level: 'vm' })).toThrow('level must be off, sandbox or container')
  })
  it('the image tag is the one the build script makes', () => {
    expect(TAG).toBe(AGENT_IMAGE)
  })
})

describe('podmanRunArgs', () => {
  const run: PodmanRun = {
    name: 'zumibot-o-1',
    labels: { 'io.zumibot.owner': 'o' },
    image: AGENT_IMAGE,
    home: '/home/u',
    homeDir: '/home/u/.local/state/zumibot-containers/c1/home',
    cwd: '/home/u/proj',
    mounts: [
      { src: '/home/u/proj', dst: '/home/u/proj', ro: false },
      { src: '/opt/dist', dst: '/opt/dist', ro: true }
    ],
    envNames: ['ZUMIBOT_TODOS_IPC', 'ANTHROPIC_API_KEY'],
    fixedEnv: { HOME: '/home/u' },
    claudeBin: '/home/u/.local/share/claude/versions/2',
    entry: '/opt/dist/containerEntry.mjs',
    runDir: '/tmp/cb-c-x'
  }
  const args = podmanRunArgs(run, ['-p', '--agent', 'a'])

  it('rootless, no root, no privileges, no network, read-only root', () => {
    expect(args).toEqual(expect.arrayContaining(['--rm', '--userns=keep-id', '--cap-drop=ALL', 'no-new-privileges', '--read-only']))
    expect(args.slice(args.indexOf('--network'), args.indexOf('--network') + 2)).toEqual(['--network', 'none'])
    const flat = args.join(' ')
    expect(flat).not.toMatch(/--privileged|podman\.sock|docker\.sock|--network host|--pid[= ]host|--ipc[= ]host|--userns[= ]host/)
  })
  it('the fake home is mounted at HOME, never the real home', () => {
    const mounts = args.filter((_, i) => args[i - 1] === '--mount')
    expect(mounts).toContain(`type=bind,source=${run.homeDir},destination=/home/u`)
    expect(mounts.some((m) => m.startsWith('type=bind,source=/home/u,'))).toBe(false)
    expect(mounts).toContain(`type=bind,source=${run.claudeBin},destination=${IN_CLAUDE},ro=true`)
  })
  it('env crosses by name only, so no value is in argv', () => {
    expect(args).toEqual(expect.arrayContaining(['--env', 'ZUMIBOT_TODOS_IPC', '--env', 'ANTHROPIC_API_KEY']))
    expect(args.join(' ')).not.toContain('ANTHROPIC_API_KEY=')
  })
  it('the CLI runs under the entry, with the given args last', () => {
    expect(args.slice(-7)).toEqual([AGENT_IMAGE, IN_NODE, '/cb/entry.mjs', IN_CLAUDE, '-p', '--agent', 'a'])
  })
  it("the server's node becomes the image's in bridges and hooks", () => {
    expect(
      innerArgs(
        ['--mcp-config', '{"command":"/opt/n/bin/node","args":["/opt/dist/todoBridge.mjs"]}', "'/opt/n/bin/node' x"],
        '/opt/n/bin/node'
      )
    ).toEqual(['--mcp-config', `{"command":"${IN_NODE}","args":["/opt/dist/todoBridge.mjs"]}`, `'${IN_NODE}' x`])
  })
})

describe('mountRefusal', () => {
  const p = {
    home: '/home/u',
    dataDir: '/home/u/.local/share/zumibot',
    keyDir: '/home/u/.config/zumibot-vault',
    claudeHome: '/home/u/.claude'
  }
  it('never home, a folder holding it, the data dir, the vault key or ~/.claude', () => {
    expect(mountRefusal('/home/u', p)).toContain('home folder')
    expect(mountRefusal('/home', p)).toContain('home folder')
    expect(mountRefusal('/', p)).toContain('home folder')
    expect(mountRefusal('/home/u/.local/share/zumibot', p)).toContain('data folder')
    expect(mountRefusal('/home/u/.config/zumibot-vault', p)).toContain('vault key')
    expect(mountRefusal('/home/u/.claude/agents', p)).toContain('~/.claude')
    expect(mountRefusal('/home/u/a,b', p)).toContain('comma')
  })
  it("a project folder is fine, and the run's own pieces of the data dir are passed as such", () => {
    expect(mountRefusal('/home/u/proj', p)).toBeNull()
    expect(mountRefusal('/home/u/.local/share/zumibot/claude-tmp/x', p)).toContain('data folder')
    expect(mountRefusal('/home/u/.local/share/zumibot/claude-tmp/x', p, true)).toBeNull()
  })
})

describe('auth proxy', () => {
  let upstream: http.Server
  let seen: { path: string; headers: http.IncomingHttpHeaders }[]
  let proxy: http.Server
  let sock: string
  const start = async (cred: Credential | null) => {
    seen = []
    upstream = http.createServer((req, res) => {
      seen.push({ path: req.url ?? '', headers: req.headers })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    await listen(upstream, 0)
    const port = (upstream.address() as net.AddressInfo).port
    proxy = createAuthProxy({
      runKey: 'cb-run-key',
      credential: async () => cred,
      upstream: { request: http.request as never, host: '127.0.0.1', port }
    })
    sock = join(dir, 'api.sock')
    await listenSock(proxy, sock)
  }
  afterEach(async () => {
    await closeServer(proxy)
    await closeServer(upstream)
  })
  const call = (path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: string }>((ok, bad) => {
      const req = http.request({ socketPath: sock, path, method: 'POST', headers }, (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => ok({ status: res.statusCode ?? 0, body: b }))
      })
      req.on('error', bad)
      req.end('{}')
    })

  it('swaps the run key for the real token; the token never goes back to the container', async () => {
    await start({ kind: 'oauth', token: 'REAL-TOKEN' })
    const r = await call('/v1/messages?beta=true', { 'x-api-key': 'cb-run-key', 'anthropic-beta': 'a,b' })
    expect(r.status).toBe(200)
    expect(r.body).not.toContain('REAL-TOKEN')
    expect(seen[0].headers.authorization).toBe('Bearer REAL-TOKEN')
    expect(seen[0].headers['x-api-key']).toBeUndefined()
    expect(seen[0].headers['anthropic-beta']).toBe('a,b,oauth-2025-04-20')
  })
  it('refuses a wrong key, any other endpoint, and a server with no sign-in', async () => {
    await start({ kind: 'apiKey', key: 'sk-real' })
    expect((await call('/v1/messages', { 'x-api-key': 'guess' })).status).toBe(401)
    expect((await call('/api/oauth/profile', { 'x-api-key': 'cb-run-key' })).status).toBe(403)
    expect((await call('/v1/files', { 'x-api-key': 'cb-run-key' })).status).toBe(403)
    expect(seen).toHaveLength(0)
    await call('/v1/messages', { 'x-api-key': 'cb-run-key' })
    expect(seen[0].headers['x-api-key']).toBe('sk-real')
    await closeServer(proxy)
    await closeServer(upstream)
    await fs.rm(sock, { force: true })
    await start(null)
    const none = await call('/v1/messages', { 'x-api-key': 'cb-run-key' })
    expect(none.status).toBe(401)
    expect(none.body).toContain('no Claude sign-in')
  })
  it('the allowed paths and the header swap, alone', () => {
    expect(pathAllowed('/v1/messages')).toBe(true)
    expect(pathAllowed('/v1/messages/count_tokens?beta=true')).toBe(true)
    expect(pathAllowed('/v1/messages/../models')).toBe(false)
    expect(
      upstreamHeaders({ authorization: 'Bearer cb', 'proxy-authorization': 'x', 'content-type': 'a' }, { kind: 'apiKey', key: 'k' })
    ).toEqual({ 'content-type': 'a', 'x-api-key': 'k' })
  })
  it("the server's sign-in: API key, then OAuth env, then the credentials file", async () => {
    const file = join(dir, 'creds.json')
    await fs.writeFile(file, JSON.stringify({ claudeAiOauth: { accessToken: 'from-file' } }))
    const read = (p: string) => fs.readFile(p, 'utf8')
    expect(await serverCredential(() => ({ ANTHROPIC_API_KEY: 'k' }), file, read)()).toEqual({ kind: 'apiKey', key: 'k' })
    expect(await serverCredential(() => ({ CLAUDE_CODE_OAUTH_TOKEN: 't' }), file, read)()).toEqual({ kind: 'oauth', token: 't' })
    expect(await serverCredential(() => ({}), file, read)()).toEqual({ kind: 'oauth', token: 'from-file' })
    expect(await serverCredential(() => ({}), join(dir, 'none'), read)()).toBeNull()
  })
})

describe('network proxy', () => {
  let target: net.Server
  let proxy: http.Server
  let denied: string[]
  let sock: string
  beforeEach(async () => {
    denied = []
    target = net.createServer((c) => c.end('HELLO'))
    await new Promise<void>((ok) => target.listen(0, '127.0.0.1', () => ok()))
    const port = (target.address() as net.AddressInfo).port
    proxy = createNetProxy({
      network: ['*.example.com', 'registry.npmjs.org'],
      denied: (t) => denied.push(t),
      connect: () => net.connect(port, '127.0.0.1'),
      lookup: async () => [{ address: '93.184.216.34', family: 4 }]
    })
    sock = join(dir, 'net.sock')
    await listenSock(proxy, sock)
  })
  afterEach(async () => {
    await closeServer(proxy)
    await closeServer(target)
  })
  const connect = (to: string) =>
    new Promise<string>((ok) => {
      const c = net.connect(sock)
      let b = ''
      c.on('data', (d) => (b += d))
      c.on('close', () => ok(b))
      c.on('error', () => ok(b))
      c.write(`CONNECT ${to} HTTP/1.1\r\nHost: ${to}\r\n\r\n`)
    })
  it('lets a listed host through on 443', async () => {
    const r = await connect('docs.example.com:443')
    expect(r).toContain('200 Connection Established')
    expect(r).toContain('HELLO')
    expect(denied).toEqual([])
  })
  it('refuses and reports an unlisted host, a bare domain under a wildcard, and another port', async () => {
    expect(await connect('evil.test:443')).toContain('403')
    expect(await connect('example.com:443')).toContain('403')
    expect(await connect('registry.npmjs.org:22')).toContain('403')
    expect(denied).toEqual(['evil.test:443', 'example.com:443', 'registry.npmjs.org:22'])
  })
  it("a refusal reads as the sandbox's, so the chat line and the audit pick it up", () => {
    const text = withNetBlocks('curl: (56) CONNECT tunnel failed, response 403', ['evil.test:443'])
    expect(sandboxBlocks(text)).toEqual([{ kind: 'network', target: 'evil.test' }])
    expect(withNetBlocks('x', [])).toBe('x')
  })
})

describe('checkContainer', () => {
  const deps = (o: Partial<ContainerSupportDeps> = {}): ContainerSupportDeps => ({
    platform: 'linux',
    path: '/usr/bin',
    exists: (p) => p === '/usr/bin/podman',
    run: async (_bin, args) => (args[0] === 'info' ? { code: 0, stdout: 'true\n' } : { code: 0, stdout: '' }),
    claudeBin: async () => '/opt/claude',
    isNative: async () => true,
    ...o
  })
  it('available with rootless podman, the image and a native CLI', async () => {
    expect(await checkContainer(deps())).toEqual({ available: true, podman: '/usr/bin/podman', claudeBin: '/opt/claude' })
  })
  it('each missing piece has its own reason', async () => {
    expect(await checkContainer(deps({ platform: 'darwin' }))).toMatchObject({ reason: expect.stringContaining('Linux only') })
    expect(await checkContainer(deps({ exists: (p) => p === '/run/.containerenv' || p === '/usr/bin/podman' }))).toMatchObject({
      reason: expect.stringContaining('inside a container')
    })
    expect(await checkContainer(deps({ exists: () => false }))).toMatchObject({ reason: expect.stringContaining('Install Podman') })
    expect(await checkContainer(deps({ run: async () => ({ code: 0, stdout: 'false' }) }))).toMatchObject({
      reason: expect.stringContaining('rootful')
    })
    expect(
      await checkContainer(deps({ run: async (_b, a) => (a[0] === 'info' ? { code: 0, stdout: 'true' } : { code: 1, stdout: '' }) }))
    ).toMatchObject({ reason: expect.stringContaining('npm run container:image') })
    expect(await checkContainer(deps({ isNative: async () => false }))).toMatchObject({ reason: expect.stringContaining('native') })
  })
})

describe('ContainerRunner', () => {
  const setup = async () => {
    const home = join(dir, 'home')
    const priv = {
      home,
      dataDir: join(home, '.local/share/zumibot'),
      keyDir: join(home, '.config/zumibot-vault'),
      claudeHome: join(home, '.claude')
    }
    const cwd = join(home, 'proj')
    await fs.mkdir(join(cwd, '.git', 'hooks'), { recursive: true })
    await fs.mkdir(join(priv.claudeHome, 'agents'), { recursive: true })
    await fs.writeFile(join(priv.claudeHome, 'agents', 'helper.md'), '---\nname: helper\n---\n')
    const execs: string[][] = []
    const runner = new ContainerRunner({
      podman: '/usr/bin/podman',
      image: AGENT_IMAGE,
      owner: 'own1',
      agentsDir: join(priv.claudeHome, 'agents'),
      stateRoot: join(home, '.local/state/zumibot-containers'),
      priv,
      node: '/opt/n/node',
      entry: '/opt/dist/containerEntry.mjs',
      distDir: '/opt/dist',
      claudeBin: '/opt/claude',
      credential: async () => ({ kind: 'oauth', token: 'REAL' }),
      exec: async (a) => {
        execs.push(a)
        return { code: 0, stdout: a[0] === 'ps' ? 'aaa\nbbb\n' : '' }
      }
    })
    return { runner, priv, cwd, home, execs }
  }
  const place = (cwd: string, iso: AgentIsolation = CONTAINER) => ({
    chatId: 'c1',
    agent: 'helper',
    cwd,
    tmpDir: null,
    addDirs: [],
    gitDirs: [join(cwd, '.git')],
    env: { ZUMIBOT_TODOS_IPC: '/tmp/cb-t-abc/ipc.sock', ANTHROPIC_API_KEY: 'sk-user', MY_KEY: 'v' },
    iso
  })

  it('refuses a chat in the home folder itself', async () => {
    const { runner, home } = await setup()
    const r = await runner.open(place(home))
    expect(r).toMatchObject({ refused: expect.stringContaining('home folder') })
  })
  it('a turn: the project, its git dir (hooks read-only), its session logs, the agent file and memory; the run key, never the real one', async () => {
    const { runner, cwd, home, priv, execs } = await setup()
    const r = await runner.open(place(cwd))
    if ('refused' in r) throw new Error(r.refused)
    const w = r.wrap({
      bin: 'claude',
      args: ['-p', '--settings', '{"hooks":"/opt/n/node x"}'],
      env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-user', MY_KEY: 'v' }
    })
    expect(w.bin).toBe('/usr/bin/podman')
    expect(w.env.ANTHROPIC_API_KEY).toMatch(/^cb-run-[0-9a-f]{48}$/)
    expect(w.env.MY_KEY).toBe('v')
    const mounts = w.args.filter((_, i) => w.args[i - 1] === '--mount')
    expect(mounts).toEqual(
      expect.arrayContaining([
        `type=bind,source=${cwd},destination=${cwd}`,
        `type=bind,source=${join(cwd, '.git')},destination=${join(cwd, '.git')}`,
        `type=bind,source=${join(cwd, '.git', 'hooks')},destination=${join(cwd, '.git', 'hooks')},ro=true`,
        'type=bind,source=/tmp/cb-t-abc,destination=/tmp/cb-t-abc',
        'type=bind,source=/opt/dist,destination=/opt/dist,ro=true',
        `type=bind,source=${join(priv.claudeHome, 'projects', projectDirName(cwd))},destination=${join(home, '.claude', 'projects', projectDirName(cwd))}`,
        `type=bind,source=${join(priv.claudeHome, 'agents', 'helper.md')},destination=${join(home, '.claude', 'agents', 'helper.md')},ro=true`
      ])
    )
    // The user's key never crosses by name: the run's own replaces it.
    const names = w.args.filter((_, i) => w.args[i - 1] === '--env' && !w.args[i].includes('='))
    expect(names.filter((n) => n === 'ANTHROPIC_API_KEY')).toHaveLength(1)
    expect(names).toContain('MY_KEY')
    expect(w.args.join(' ')).not.toContain('sk-user')
    expect(w.args).toContain(`{"hooks":"${IN_NODE} x"}`)
    // Mount points under HOME are made in the fake home by the user, so they never end up owned by a sub-uid.
    const fake = join(home, '.local/state/zumibot-containers/c1/home')
    expect((await fs.stat(join(fake, 'proj'))).isDirectory()).toBe(true)
    expect((await fs.stat(join(fake, '.claude', 'agents', 'helper.md'))).isFile()).toBe(true)
    await r.dispose()
    expect(execs.at(-1)).toEqual(['rm', '-f', '--ignore', '-t', '2', r.name])
  })
  // The agent owns its temp folder; the flag beside it must stay out of its reach, or it could redirect or delete it.
  it('mounts the pause flag folder read-only', async () => {
    const { runner, cwd, priv } = await setup()
    const pauseDir = join(priv.dataDir, 'pause-flags', 'abc')
    await fs.mkdir(pauseDir, { recursive: true })
    const p = place(cwd)
    const r = await runner.open({ ...p, env: { ...p.env, ZUMIBOT_PAUSE_FILE: join(pauseDir, 'paused') } })
    if ('refused' in r) throw new Error(r.refused)
    const w = r.wrap({ bin: 'claude', args: ['-p'], env: { PATH: '/usr/bin' } })
    const mounts = w.args.filter((_, i) => w.args[i - 1] === '--mount')
    expect(mounts).toContain(`type=bind,source=${pauseDir},destination=${pauseDir},ro=true`)
    await r.dispose()
  })
  it('prunes the fake homes of chats that are gone, and only those', async () => {
    const root = join(dir, 'state')
    await fs.mkdir(join(root, 'keep', 'home'), { recursive: true })
    await fs.mkdir(join(root, 'gone', 'home'), { recursive: true })
    expect(await pruneHomes(root, ['keep'], null)).toBe(1)
    expect(await fs.readdir(root)).toEqual(['keep'])
  })
  it('sweeps by owner label', async () => {
    const execs: string[][] = []
    expect(
      await sweepOwned('own1', async (a) => {
        execs.push(a)
        return { code: 0, stdout: a[0] === 'ps' ? 'aaa\n' : '' }
      })
    ).toBe(1)
    expect(execs).toEqual([
      ['ps', '-a', '-q', '--filter', 'label=io.zumibot.owner=own1'],
      ['rm', '-f', '-t', '2', 'aaa']
    ])
  })
  it("a worktree's absolute links outside it are mounted read-only where they point", async () => {
    const target = join(dir, 'main', 'node_modules')
    await fs.mkdir(target, { recursive: true })
    const wt = join(dir, 'wt')
    await fs.mkdir(join(wt, 'pkg'), { recursive: true })
    await fs.symlink(target, join(wt, 'node_modules'))
    await fs.symlink(target, join(wt, 'pkg', 'node_modules'))
    await fs.symlink('../relative', join(wt, 'rel'))
    expect(await linkTargets(wt)).toEqual([target])
  })
})

describe('IsolationService and containers', () => {
  const svc = async (check: 'ok' | 'no') => {
    const s = new IsolationService({
      file: join(dir, 'iso.json'),
      home: '/home/u',
      dataDir: '/d',
      keyDir: '/k',
      pathEnv: async () => '',
      checkSupport: async () => ({ available: true }),
      fileHook: null
    })
    s.useContainers({
      check: async () =>
        check === 'ok' ? { available: true, podman: '/usr/bin/podman', claudeBin: '/c' } : { available: false, reason: 'Install Podman.' },
      runner: () => ({ open: async () => ({ refused: 'x' }) }) as never
    })
    await s.set('a', CONTAINER)
    return s
  }
  it('refuses Codex, computer use and a machine without containers; never runs it Off', async () => {
    const s = await svc('ok')
    expect(await s.runFor('a', { engine: 'codex', cwd: dir, tmpDir: null, addDirs: [], memoryDir: null })).toEqual({
      level: 'container',
      refused: CODEX_CONTAINER_REFUSED
    })
    for (const engine of ['acp', 'ag-ui'] as const) {
      expect(await s.runFor('a', { engine, cwd: dir, tmpDir: null, addDirs: [], memoryDir: null })).toEqual({
        level: 'container',
        refused: isolationRefusal(engine, 'container')
      })
    }
    expect(await s.runFor('a', { engine: 'claude', cwd: dir, tmpDir: null, addDirs: [], memoryDir: null, desktop: true })).toEqual({
      level: 'container',
      refused: CONTAINER_DESKTOP_REFUSED
    })
    const no = await svc('no')
    expect(await no.runFor('a', { engine: 'claude', cwd: dir, tmpDir: null, addDirs: [], memoryDir: null })).toMatchObject({
      level: 'container',
      refused: expect.stringContaining('Install Podman.')
    })
    expect((await no.status()).container).toEqual({ available: false, reason: 'Install Podman.' })
  })
  it("a contained run gets a plan, and its refusal is worded as the run's", async () => {
    const s = await svc('ok')
    const r = await s.runFor('a', { engine: 'claude', cwd: dir, tmpDir: null, addDirs: [], memoryDir: null })
    if (r.level !== 'container' || 'refused' in r) throw new Error('no plan')
    expect(r.network).toEqual(['registry.npmjs.org'])
    expect(await r.plan.open({})).toEqual({ refused: expect.stringContaining('this run cannot: x') })
  })
})
