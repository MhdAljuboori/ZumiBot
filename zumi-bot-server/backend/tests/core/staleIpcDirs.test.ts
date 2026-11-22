import { afterEach, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IPC_DIR_NAME, RUN_DIR_NAME, RUN_SOCKETS, sweepStaleIpcDirs } from '../../src/core/ipc/staleIpcDirs'

// The sweep clears socket-file folders; Windows bridges listen on named pipes, which end with their server.
const socketIt = it.skipIf(process.platform === 'win32')

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'zb-sweep-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  return root
}

// Sockets a SIGKILLed process leaves behind: the file stays, nothing listens. close() would unlink them, so a child dies instead.
async function deadSockets(paths: string[], mode = 0o600): Promise<void> {
  const script = `const net = require('net'), fs = require('fs')
const [mode, ...paths] = process.argv.slice(1)
let left = paths.length
for (const p of paths) net.createServer().listen(p, () => { fs.chmodSync(p, Number(mode)); if (--left === 0) process.stdout.write('ready') })`
  const child = spawn(process.execPath, ['-e', script, String(mode), ...paths], { stdio: ['ignore', 'pipe', 'inherit'] })
  await once(child.stdout, 'data')
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

async function liveSocket(path: string): Promise<Server> {
  const server = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve) => server.listen(path, resolve))
  await chmod(path, 0o600)
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return server
}

const answers = (path: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(path)
    socket.once('connect', () => (socket.destroy(), resolve(true)))
    socket.once('error', () => resolve(false))
  })

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false
  )

socketIt('removes the folders of a dead server and keeps a live one', async () => {
  const root = await tempRoot()
  const dead = await Promise.all(['b', 'd', 't', 'p', 'v', 'a', 'r'].map((l) => mkdtemp(join(root, `cb-${l}-`))))
  await deadSockets(dead.map((d) => join(d, 's')))
  const live = await mkdtemp(join(root, 'cb-b-'))
  await liveSocket(join(live, 's'))

  expect(await sweepStaleIpcDirs({ root })).toBe(7)
  for (const d of dead) expect(await exists(d)).toBe(false)
  expect(await readdir(live)).toEqual(['s'])
  expect(await answers(join(live, 's'))).toBe(true)
})

socketIt('keeps every folder that fails one of the checks', async () => {
  const root = await tempRoot()
  const outside = await mkdtemp(join(root, 'elsewhere-'))
  const fixed = async (name: string, mode = 0o700) => {
    const dir = join(root, name)
    await mkdir(dir)
    await chmod(dir, mode)
    return dir
  }
  const extra = await mkdtemp(join(root, 'cb-b-'))
  await writeFile(join(extra, 'x'), '')
  const empty = await mkdtemp(join(root, 'cb-p-')) // a server between mkdtemp and listen
  const open = await fixed('cb-d-open01', 0o755)
  const regular = await mkdtemp(join(root, 'cb-t-'))
  await writeFile(join(regular, 's'), '', { mode: 0o600 }) // connecting to a plain file is refused too
  const unchmodded = await mkdtemp(join(root, 'cb-a-')) // killed between listen and chmod, or not one of ours
  const linkedSocket = await mkdtemp(join(root, 'cb-r-'))
  await symlink(join(outside, 's'), join(linkedSocket, 's'))
  const target = await mkdtemp(join(outside, 'cb-v-'))
  const linkedDir = join(root, 'cb-v-link01')
  await symlink(target, linkedDir)
  const container = await fixed('cb-c-abc123') // a run folder never holds `s`
  const longName = await fixed('cb-b-abc1234')
  const otherPrefix = await fixed('zb-b-abc123')
  // `outside/s` is the dead socket linkedSocket's `s` points at.
  await deadSockets([extra, open, outside, target, container, longName, otherPrefix].map((d) => join(d, 's')))
  await deadSockets([join(unchmodded, 's')], 0o644)

  expect(await sweepStaleIpcDirs({ root })).toBe(0)
  for (const d of [empty, open, regular, unchmodded, linkedSocket, container, longName, otherPrefix]) expect(await exists(d)).toBe(true)
  expect((await readdir(extra)).sort()).toEqual(['s', 'x'])
  expect((await lstat(linkedDir)).isSymbolicLink()).toBe(true)
  expect(await readdir(target)).toEqual(['s'])
  expect(await exists(join(outside, 's'))).toBe(true)
})

socketIt('removes dead container run folders and keeps a live one, a partly live one and one holding anything else', async () => {
  const root = await tempRoot()
  const run = () => mkdtemp(join(root, 'cb-c-'))
  const [dead, apiOnly, live, liveApi, liveNet, agentFile] = await Promise.all([run(), run(), run(), run(), run(), run()])
  const bridgeName = await mkdtemp(join(root, 'cb-b-'))
  await writeFile(join(agentFile, 'notes.txt'), '') // the folder is mounted read-write into the container
  for (const path of [join(live, 'api.sock'), join(live, 'net.sock'), join(liveApi, 'api.sock'), join(liveNet, 'net.sock')])
    await liveSocket(path)
  // Never chmodded: a run folder's sockets keep the mode bind() gave them.
  const dead755 = [join(dead, 'api.sock'), join(dead, 'net.sock'), join(apiOnly, 'api.sock'), join(liveApi, 'net.sock')]
  dead755.push(join(liveNet, 'api.sock'), join(agentFile, 'api.sock'), join(agentFile, 'net.sock'), join(bridgeName, 'api.sock'))
  await deadSockets(dead755, 0o755)

  // `apiOnly`: killed between its two listen() calls.
  expect(await sweepStaleIpcDirs({ root })).toBe(2)
  expect(await exists(dead)).toBe(false)
  expect(await exists(apiOnly)).toBe(false)
  // Both orders of a live and a dead socket, whichever readdir lists first.
  for (const d of [live, liveApi, liveNet]) expect((await readdir(d)).sort()).toEqual(['api.sock', 'net.sock'])
  expect((await readdir(agentFile)).sort()).toEqual(['api.sock', 'net.sock', 'notes.txt'])
  expect(await readdir(bridgeName)).toEqual(['api.sock'])
})

socketIt('keeps a socket that answers on the second probe, and another uid’s folders', async () => {
  const root = await tempRoot()
  const dir = await mkdtemp(join(root, 'cb-b-'))
  const path = join(dir, 's')
  await deadSockets([path])
  expect(await sweepStaleIpcDirs({ root, uid: process.getuid!() + 1 })).toBe(0)
  // Refused at first, listening a moment later: a server that was between bind() and listen().
  const settle = async () => {
    await rm(path)
    await liveSocket(path)
  }
  expect(await sweepStaleIpcDirs({ root, settle })).toBe(0)
  expect(await answers(path)).toBe(true)
})

// Not on macOS: there a full backlog is refused (ECONNREFUSED) like a dead socket, so the two cannot be told apart
// (docs/architecture/install.md, Phase 0).
it.skipIf(process.platform === 'win32' || process.platform === 'darwin')('keeps a stopped server whose backlog is full (EAGAIN, not a refusal)', async () => {
  const root = await tempRoot()
  const dir = await mkdtemp(join(root, 'cb-b-'))
  const path = join(dir, 's')
  const listen = `const p = process.argv[1]
require('net').createServer().listen({ path: p, backlog: 1 }, () => { require('fs').chmodSync(p, 0o600); process.stdout.write('ready') })`
  const child = spawn(process.execPath, ['-e', listen, path], { stdio: ['ignore', 'pipe', 'inherit'] })
  cleanups.push(async () => {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  })
  await once(child.stdout, 'data')
  child.kill('SIGSTOP') // nothing accepts: the kernel queues connections until the backlog is full
  const held: Socket[] = []
  cleanups.push(async () => held.forEach((s) => s.destroy()))
  for (let full = false; !full;) {
    const socket = connect(path)
    held.push(socket)
    full = await new Promise<boolean>((resolve) => {
      socket.once('connect', () => resolve(false))
      socket.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EAGAIN'))
    })
  }
  expect(await sweepStaleIpcDirs({ root })).toBe(0)
  expect(await readdir(dir)).toEqual(['s'])
})

it('returns 0 for a missing root', async () => {
  expect(await sweepStaleIpcDirs({ root: join(await tempRoot(), 'missing') })).toBe(0)
})

it('matches the folder of every IPC bridge and container run in src, with the run folder sockets', async () => {
  const src = join(__dirname, '..', '..', 'src')
  const files = (await readdir(src, { recursive: true })).filter((f) => f.endsWith('.ts'))
  const letters = new Set<string>()
  for (const f of files)
    for (const m of (await readFile(join(src, f), 'utf8')).matchAll(/(?:mkdtemp\('\/tmp\/cb-|ipcEndpoint\(')([a-z])(?:-'\)|')/g))
      letters.add(m[1]!)
  expect(letters.size).toBeGreaterThanOrEqual(8)
  // The bridges pass their letter to ipcEndpoint, which makes the folder.
  expect(await readFile(join(src, 'core', 'ipc', 'ipcEndpoint.ts'), 'utf8')).toContain('mkdtemp(`/tmp/cb-${letter}-`)')
  for (const l of letters) expect(IPC_DIR_NAME.test(`cb-${l}-aB3dE9`) || RUN_DIR_NAME.test(`cb-${l}-aB3dE9`)).toBe(true)
  expect(RUN_DIR_NAME.test('cb-c-aB3dE9') && !IPC_DIR_NAME.test('cb-c-aB3dE9')).toBe(true)
  const runner = await readFile(join(src, 'core', 'isolation', 'containerRunner.ts'), 'utf8')
  const sockets = [...runner.matchAll(/listen\(\w+, join\(runDir, '([^']+)'\)\)/g)].map((m) => m[1])
  expect(sockets).toEqual(RUN_SOCKETS)
})
