import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadDesktopConfig } from '../../../src/core/desktop/config'
import { createProcessAdapter, desktopRunRoot, recoverDesktops } from '../../../src/core/desktop/desktopProcess'
import type { DesktopRuntime } from '../../../src/core/desktop/desktopRuntime'
import { DesktopLaunchCleanupError, DesktopUnavailableError, type DesktopInstance } from '../../../src/core/desktop/types'
import { xauthEntry } from '../../../src/core/desktop/xauth'

// Run folder ids queued here are used before random ones, to force a collision.
const forcedIds = vi.hoisted(() => [] as string[])
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  const randomBytes = (size: number) => (size === 4 && forcedIds.length ? Buffer.from(forcedIds.shift()!, 'hex') : actual.randomBytes(size))
  return { ...actual, default: { ...actual, randomBytes }, randomBytes }
})

const fixtures = fileURLToPath(new URL('../../fixtures/', import.meta.url))
const config = loadDesktopConfig({})
const never = () => new AbortController().signal
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Sets env vars for one call and puts back exactly what was there before. */
async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]))
  Object.assign(process.env, vars)
  try {
    return await fn()
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

let tmp: string, instances: DesktopInstance[], lines: string[]
let x11Dir: string, lockDir: string, runBase: string, root: string, dir: string, logs: Record<'xvnc' | 'dbus' | 'session' | 'cua', string>

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'cb-desk-'))
  instances = []
  lines = []
  x11Dir = join(tmp, 'x11')
  lockDir = join(tmp, 'lock')
  runBase = join(tmp, 'rt')
  root = join(tmp, 'data', 'desktops')
  dir = join(root, '00000000-0000-4000-8000-000000000001')
  for (const d of [x11Dir, lockDir, runBase, join(tmp, 'bin'), join(tmp, 'logs')]) await mkdir(d, { recursive: true })
  logs = {
    xvnc: join(tmp, 'logs', 'xvnc'),
    dbus: join(tmp, 'logs', 'dbus'),
    session: join(tmp, 'logs', 'session'),
    cua: join(tmp, 'logs', 'cua')
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  forcedIds.length = 0
  for (const d of instances) await d.close().catch(() => {})
  await killStrays()
  await rm(tmp, { recursive: true, force: true })
})

/** Every process whose command line or environment names this test's temp dir. */
async function strays(): Promise<number[]> {
  const found: number[] = []
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8')
      if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) continue
      const text = (await readFile(`/proc/${name}/cmdline`, 'utf8')) + (await readFile(`/proc/${name}/environ`, 'utf8'))
      if (text.includes(tmp)) found.push(Number(name))
    } catch {
      /* gone or not ours */
    }
  }
  return found
}
async function killStrays(): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const pids = await strays()
    if (!pids.length) return
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* gone */
      }
    }
    await sleep(50)
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')
  } catch {
    return false
  }
}
async function waitFor(check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await sleep(25)
  }
}

async function wrapper(name: string, body: string): Promise<string> {
  const path = join(tmp, 'bin', name)
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return path
}
type Fakes = { busy?: number[]; cua?: Record<string, string>; xvnc?: Record<string, string> }
async function fakeRuntime(o: Fakes = {}): Promise<DesktopRuntime> {
  const exports = (vars: Record<string, string>) =>
    Object.entries(vars)
      .map(([k, v]) => `export ${k}=${q(v)}`)
      .join('\n')
  const node = (fixture: string) => `exec ${q(process.execPath)} ${q(join(fixtures, fixture))} "$@"`
  return {
    xvnc: await wrapper(
      'Xvnc',
      `${exports({ FAKE_XVNC_LOG: logs.xvnc, FAKE_XVNC_LOCK_DIR: lockDir, FAKE_XVNC_X11_DIR: x11Dir, FAKE_XVNC_BUSY: (o.busy ?? []).join(','), ...o.xvnc })}\n${node('fake-xvnc.mjs')}`
    ),
    dbusDaemon: await wrapper('dbus-daemon', `${exports({ FAKE_DBUS_LOG: logs.dbus })}\n${node('fake-dbus-daemon.mjs')}`),
    session: [await wrapper('session', `env > ${q(logs.session)}\nexec sleep 600`)],
    cuaDriver: await wrapper('cua-driver', `${exports({ FAKE_CUA_LOG: logs.cua, ...o.cua })}\n${node('fake-cua-driver.mjs')}`),
    node: process.execPath,
    bridgeEntry: join(tmp, 'desktopBridge.mjs'),
    electronNode: false,
    missing: []
  }
}
async function adapterFor(o: Fakes & { runBase?: string } = {}) {
  return createProcessAdapter(await fakeRuntime(o), { x11Dir, lockDir, runBase: o.runBase ?? runBase, log: (l) => lines.push(l) })
}
async function launch(o: Fakes = {}): Promise<DesktopInstance> {
  const d = await (await adapterFor(o)).launch(dir, config, never())
  instances.push(d)
  return d
}
const jsonLines = async (path: string) =>
  (await readFile(path, 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
const cuaEnv = async () => (await jsonLines(logs.cua)).find((e) => e.type === 'env')
const envFile = async (path: string) =>
  Object.fromEntries(
    (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  )
const runOf = (d: DesktopInstance) => dirname(d.vncSocket)
const pidsOf = async (d: DesktopInstance): Promise<Record<string, number>> => {
  const state = JSON.parse(await readFile(join(runOf(d), 'desktop.json'), 'utf8')) as { processes: Record<string, { pid: number }> }
  return Object.fromEntries(Object.entries(state.processes).map(([k, v]) => [k, v.pid]))
}
function greeting(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = createConnection(path)
    s.once('data', (d) => {
      s.destroy()
      resolve(d.toString('latin1'))
    })
    s.once('error', reject)
  })
}

it('starts the four processes and answers cua calls with the real result shapes', async () => {
  const d = await launch()
  expect(d.display).toBe(90)
  expect(d.generation).toMatch(/^[a-zA-Z0-9_-]{8,128}$/)
  const shot = await d.call('get_desktop_state', {}, never())
  expect(shot.isError).toBe(false)
  expect(shot.content.map((c) => c.type)).toEqual(['image', 'text'])
  expect(shot.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
  expect(shot.structuredContent).toMatchObject({ screenshot_width: 1280, screenshot_height: 800, frame_scale: 1 })
  const bad = await d.call('press_key', { key: 'a' }, never())
  expect(bad).toMatchObject({ isError: true, structuredContent: { code: 'background_unavailable' } })
  expect(await greeting(d.vncSocket)).toBe('RFB 003.008\n')
  expect((await jsonLines(logs.cua)).filter((e) => e.tool).map((e) => e.tool)).toEqual(['get_desktop_state', 'press_key'])
})

it('runs Xvnc and the bus with the spike command lines', async () => {
  const d = await launch()
  const run = runOf(d)
  const [xvnc] = await jsonLines(logs.xvnc)
  expect(xvnc.args).toEqual([
    ':90',
    '-geometry',
    '1280x800',
    '-depth',
    '24',
    '-rfbport',
    '-1',
    '-rfbunixpath',
    join(run, 'vnc.sock'),
    '-rfbunixmode',
    '0600',
    '-SecurityTypes',
    'None',
    '-nolisten',
    'tcp',
    '-nolisten',
    'local',
    '-auth',
    join(run, 'Xauthority'),
    '-AlwaysShared',
    '-AcceptSetDesktopSize=0',
    '-desktop',
    'ZumiBot'
  ])
  const [bus] = await jsonLines(logs.dbus)
  expect(bus.args).toEqual(['--session', '--nofork', '--nopidfile', '--nosyslog', `--address=unix:path=${join(run, 'xdg', 'bus')}`])
  const sized = await (
    await adapterFor()
  ).launch(join(root, '00000000-0000-4000-8000-000000000002'), { ...config, width: 1920, height: 1080 }, never())
  instances.push(sized)
  expect((await jsonLines(logs.xvnc)).at(-1).args.slice(0, 3)).toEqual([`:${sized.display}`, '-geometry', '1920x1080'])
  expect(sized.display).toBe(91)
})

it('skips taken display numbers', async () => {
  await writeFile(join(x11Dir, 'X90'), '')
  await writeFile(join(lockDir, '.X91-lock'), '      4242\n')
  const d = await launch()
  expect(d.display).toBe(92)
  expect((await jsonLines(logs.xvnc)).map((e) => e.display)).toEqual([92])
})

it('retries when Xvnc says the display is busy', async () => {
  const d = await launch({ busy: [90, 91] })
  expect(d.display).toBe(92)
  expect((await jsonLines(logs.xvnc)).map((e) => e.display)).toEqual([90, 91, 92])
  const auth = await readFile(join(runOf(d), 'Xauthority'))
  expect([...auth.subarray(4, 8)]).toEqual([0, 2, 0x39, 0x32])
})

it('gives up after five busy displays and leaves nothing running', async () => {
  const adapter = await adapterFor({ busy: [90, 91, 92, 93, 94, 95] })
  await expect(adapter.launch(dir, config, never())).rejects.toThrow(/display/i)
  expect((await jsonLines(logs.xvnc)).map((e) => e.display)).toEqual([90, 91, 92, 93, 94])
  expect(await strays()).toEqual([])
  expect(await readdir(desktopRunRoot(root, runBase))).toEqual([])
})

it('keeps the X cookie in a 0600 Xauthority inside 0700 folders', async () => {
  const old = process.umask(0)
  let d: DesktopInstance
  try {
    d = await launch()
  } finally {
    process.umask(old)
  }
  const run = runOf(d)
  const mode = async (p: string) => (await stat(p)).mode & 0o777
  expect(await mode(run)).toBe(0o700)
  expect(await mode(dirname(run))).toBe(0o700)
  expect(await mode(dirname(dirname(run)))).toBe(0o700)
  expect(await mode(join(run, 'xdg'))).toBe(0o700)
  expect(await mode(join(run, 'Xauthority'))).toBe(0o600)
  expect(await mode(join(run, 'desktop.json'))).toBe(0o600)
  expect(await mode(join(dir, 'home'))).toBe(0o700)
  const auth = await readFile(join(run, 'Xauthority'))
  expect(auth.length).toBe(46)
  expect([...auth.subarray(0, 30)]).toEqual([...xauthEntry(90, new Uint8Array(16)).subarray(0, 30)])
  expect(auth.subarray(30).equals(Buffer.alloc(16))).toBe(false)
  // The run folder is short: unix socket paths stop at 108 bytes.
  expect(run.startsWith(join(runBase, `zumibot-${process.getuid!()}`))).toBe(true)
  expect(Buffer.byteLength(d.vncSocket)).toBeLessThanOrEqual(100)
})

it('server ZUMIBOT_ vars do not reach the children', async () => {
  await withEnv(
    {
      ZUMIBOT_LOCAL_SECRET: 'local-secret-value-1234567890abcdef',
      ZUMIBOT_DATA_DIR: join(tmp, 'data'),
      ZUMIBOT_BROWSER_IPC: 'ipc-path-value'
    },
    launch
  )
  expect(process.env.ZUMIBOT_LOCAL_SECRET).toBeUndefined()
  const keys = [
    (await jsonLines(logs.xvnc))[0].env,
    (await jsonLines(logs.dbus))[0].env,
    Object.keys(await envFile(logs.session)),
    (await cuaEnv()).keys
  ]
  for (const k of keys) {
    expect(k.length).toBeGreaterThan(3)
    expect(k.filter((key: string) => key.startsWith('ZUMIBOT_'))).toEqual([])
  }
  for (const file of Object.values(logs)) expect(await readFile(file, 'utf8')).not.toContain('local-secret-value')
})

it('cua env disables telemetry and unrestricted mode', async () => {
  const d = await withEnv({ CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS: '1', CUA_DRIVER_PERMISSION_MODE: 'unrestricted' }, launch)
  const run = runOf(d)
  const env = await cuaEnv()
  expect(env.values).toMatchObject({
    DO_NOT_TRACK: '1',
    CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
    CUA_TELEMETRY_ENABLED: '0',
    CUA_DRIVER_RS_UPDATE_CHECK: '0',
    CUA_DRIVER_PERMISSION_MODE: 'standard',
    CUA_DRIVER_DISABLE_RUN_SCRIPT: '1',
    CUA_DRIVER_DISABLE_UNRESTRICTED: '1',
    DISPLAY: ':90',
    XAUTHORITY: join(run, 'Xauthority'),
    HOME: join(dir, 'home'),
    XDG_CONFIG_HOME: join(dir, 'home', '.config'),
    XDG_DATA_HOME: join(dir, 'home', '.local', 'share'),
    XDG_CACHE_HOME: join(dir, 'home', '.cache'),
    XDG_RUNTIME_DIR: join(run, 'xdg'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(run, 'xdg', 'bus')}`,
    GIO_USE_VFS: 'local',
    GIO_USE_VOLUME_MONITOR: 'unix',
    GVFS_DISABLE_FUSE: '1'
  })
  expect(env.keys).not.toContain('CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS')
  // The cua-only vars go to cua-driver only.
  const session = await envFile(logs.session)
  expect(Object.keys(session).filter((k) => k.startsWith('CUA_') || k === 'DO_NOT_TRACK')).toEqual([])
  expect(session).toMatchObject({
    DISPLAY: ':90',
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(run, 'xdg', 'bus')}`,
    HOME: join(dir, 'home')
  })
  expect((await jsonLines(logs.dbus))[0].env.filter((k: string) => k.startsWith('CUA_'))).toEqual([])
})

it('close kills every process group and removes the sockets, lock and run folder', async () => {
  const d = await launch()
  const app = await d.call('launch_app', { name: 'Mousepad' }, never())
  const appPid = (app.structuredContent as { pid: number }).pid
  const pids = await pidsOf(d)
  expect(Object.keys(pids).sort()).toEqual(['bus', 'cua', 'session', 'xvnc'])
  const run = runOf(d)
  let exits = 0
  d.onExit(() => {
    exits++
  })
  await d.close()
  for (const pid of [...Object.values(pids), appPid]) expect(alive(pid)).toBe(false)
  expect(d.isClosed()).toBe(true)
  expect(existsSync(d.vncSocket)).toBe(false)
  expect(existsSync(run)).toBe(false)
  expect(existsSync(join(lockDir, '.X90-lock'))).toBe(false)
  expect(existsSync(join(x11Dir, 'X90'))).toBe(false)
  await expect(d.call('list_windows', {}, never())).rejects.toThrow()
  await d.close()
  expect(exits).toBe(0)
  expect(await strays()).toEqual([])
})

it('Xvnc exit is fatal: the rest is stopped and its lock and X socket are cleaned', async () => {
  const d = await launch()
  const pids = await pidsOf(d)
  const run = runOf(d)
  let exits = 0
  const exited = new Promise<void>((resolve) =>
    d.onExit(() => {
      exits++
      resolve()
    })
  )
  process.kill(pids.xvnc, 'SIGKILL')
  await exited
  expect(d.isClosed()).toBe(true)
  for (const pid of Object.values(pids)) expect(alive(pid)).toBe(false)
  // A killed Xvnc leaves its lock and socket; ours are removed so the number is not lost.
  expect(existsSync(join(lockDir, '.X90-lock'))).toBe(false)
  expect(existsSync(join(x11Dir, 'X90'))).toBe(false)
  expect(existsSync(run)).toBe(false)
  await expect(d.call('list_windows', {}, never())).rejects.toThrow()
  await d.close()
  expect(exits).toBe(1)
  expect(lines.join('\n')).toMatch(/display server/i)
})

it('child exit fires onExit', async () => {
  const d = await launch()
  const pids = await pidsOf(d)
  let removed = 0
  const off = d.onExit(() => {
    removed++
  })
  off()
  const exited = new Promise<void>((resolve) => d.onExit(resolve))
  process.kill(pids.cua, 'SIGKILL')
  await exited
  expect(removed).toBe(0)
  expect(d.isClosed()).toBe(true)
  for (const pid of Object.values(pids)) expect(alive(pid)).toBe(false)
  expect(existsSync(join(lockDir, '.X90-lock'))).toBe(false)
})

it('a child that dies during start fails the launch and leaves nothing running', async () => {
  const adapter = await adapterFor({ cua: { FAKE_CUA_EXIT: '3' } })
  await expect(adapter.launch(dir, config, never())).rejects.toThrow()
  expect(await strays()).toEqual([])
  expect(await readdir(desktopRunRoot(root, runBase))).toEqual([])
  expect(existsSync(join(lockDir, '.X90-lock'))).toBe(false)
})

it('abort during start stops everything', async () => {
  const adapter = await adapterFor({ cua: { FAKE_CUA_SILENT: '1' } })
  const ctrl = new AbortController()
  const started = adapter.launch(dir, config, ctrl.signal)
  await waitFor(async () => existsSync(logs.cua) && Boolean(await cuaEnv()))
  ctrl.abort()
  await expect(started).rejects.toThrow()
  expect(await strays()).toEqual([])
  expect(await readdir(desktopRunRoot(root, runBase))).toEqual([])
  const aborted = new AbortController()
  aborted.abort()
  await expect(adapter.launch(dir, config, aborted.signal)).rejects.toThrow()
})

it('skips lines from cua-driver that are not JSON-RPC, without logging their text', async () => {
  const d = await launch({ cua: { FAKE_CUA_NOISE: '1' } })
  const r = await d.call('list_windows', {}, never())
  expect((r.structuredContent as { windows: unknown[] }).windows).toHaveLength(2)
  expect(lines.some((l) => /skipped/i.test(l))).toBe(true)
  expect(lines.join('\n')).not.toMatch(/SpiRegistry|json-rpc/)
})

it('launch throws DesktopUnavailableError listing missing programs', async () => {
  const runtime: DesktopRuntime = { ...(await fakeRuntime()), xvnc: null, cuaDriver: null, missing: ['TigerVNC (Xvnc)', 'cua-driver'] }
  const error = await createProcessAdapter(runtime, { x11Dir, lockDir, runBase })
    .launch(dir, config, never())
    .catch((e) => e)
  expect(error).toBeInstanceOf(DesktopUnavailableError)
  expect(error.missing).toEqual(['TigerVNC (Xvnc)', 'cua-driver'])
  expect(existsSync(logs.xvnc)).toBe(false)
})

it('fails clearly when the runtime folder would make socket paths too long', async () => {
  const adapter = await adapterFor({ runBase: join(tmp, 'x'.repeat(100)) })
  await expect(adapter.launch(dir, config, never())).rejects.toThrow(/too long/)
  expect(existsSync(logs.xvnc)).toBe(false)
})

function detached(args: string[], env: NodeJS.ProcessEnv): number {
  const child = spawn(args[0], args.slice(1), { detached: true, stdio: 'ignore', env: { CB_TEST_TMP: tmp, ...env } })
  child.unref()
  return child.pid!
}
async function identity(pid: number): Promise<{ pid: number; start: string }> {
  const s = await readFile(`/proc/${pid}/stat`, 'utf8')
  return { pid, start: s.slice(s.lastIndexOf(')') + 2).split(' ')[19] }
}
/** The identity of a process that has exited and been reaped. */
async function deadIdentity(): Promise<{ pid: number; start: string }> {
  const child = spawn('sleep', ['600'], { stdio: 'ignore' })
  const id = await identity(child.pid!)
  const gone = new Promise((r) => child.once('exit', r))
  child.kill('SIGKILL')
  await gone
  return id
}
async function stuckDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true })
  await writeFile(join(path, 'file'), '')
  await chmod(path, 0o500)
  return path
}

it('recoverDesktops kills a leftover whose cmdline names its run dir and leaves an unrelated pid alone', async () => {
  const runRoot = desktopRunRoot(root, runBase)
  const run = join(runRoot, 'abcdef01')
  await mkdir(join(run, 'xdg'), { recursive: true, mode: 0o700 })
  // A leftover Xvnc named by its command line, a stray named by its environment, and an unrelated
  // process whose pid sits in the state file (as after pid reuse).
  const xvnc = detached([process.execPath, join(fixtures, 'fake-xvnc.mjs'), ':95', '-rfbunixpath', join(run, 'vnc.sock')], {
    PATH: process.env.PATH,
    FAKE_XVNC_LOCK_DIR: lockDir,
    FAKE_XVNC_X11_DIR: x11Dir,
    CB_TEST_TMP: tmp
  })
  const stray = detached(['sleep', '600'], { PATH: process.env.PATH, XDG_RUNTIME_DIR: join(run, 'xdg'), CB_TEST_TMP: tmp })
  const unrelated = detached(['sleep', '600'], { PATH: process.env.PATH, CB_TEST_TMP: tmp })
  await waitFor(() => existsSync(join(lockDir, '.X95-lock')) && existsSync(join(x11Dir, 'X95')))
  await writeFile(join(lockDir, '.X96-lock'), `${String(unrelated).padStart(10)}\n`)
  await writeFile(
    join(run, 'desktop.json'),
    JSON.stringify({ version: 1, display: 95, processes: { xvnc: await identity(xvnc), cua: await identity(unrelated) } }),
    { mode: 0o600 }
  )
  try {
    // Another data dir's recovery never touches this one.
    await recoverDesktops(join(tmp, 'other', 'desktops'), { runBase, x11Dir, lockDir })
    expect(alive(xvnc) && alive(stray)).toBe(true)
    await recoverDesktops(root, { runBase, x11Dir, lockDir })
    expect(alive(xvnc)).toBe(false)
    expect(alive(stray)).toBe(false)
    expect(alive(unrelated)).toBe(true)
    expect(existsSync(join(lockDir, '.X95-lock'))).toBe(false)
    expect(existsSync(join(x11Dir, 'X95'))).toBe(false)
    expect(existsSync(join(lockDir, '.X96-lock'))).toBe(true)
    expect(existsSync(run)).toBe(false)
  } finally {
    process.kill(unrelated, 'SIGKILL')
  }
})

it('recovers this data dir before the first launch', async () => {
  const runRoot = desktopRunRoot(root, runBase)
  const run = join(runRoot, '0badc0de')
  await mkdir(join(run, 'xdg'), { recursive: true, mode: 0o700 })
  const leftover = spawn('sleep', ['600'], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: join(run, 'xdg'), CB_TEST_TMP: tmp }
  })
  leftover.unref()
  await waitFor(() => existsSync(`/proc/${leftover.pid}`))
  const d = await launch()
  expect(alive(leftover.pid!)).toBe(false)
  expect(existsSync(run)).toBe(false)
  expect(existsSync(runOf(d))).toBe(true)
})

it('leaves an X lock alone unless it is a regular file naming our Xvnc and that pid is gone', async () => {
  const runRoot = desktopRunRoot(root, runBase)
  const unrelated = detached(['sleep', '600'], { PATH: process.env.PATH })
  const dead = await deadIdentity()
  const stale = async (name: string, display: number, xvnc: { pid: number; start: string }) => {
    await mkdir(join(runRoot, name), { recursive: true })
    await writeFile(join(runRoot, name, 'desktop.json'), JSON.stringify({ version: 1, display, processes: { xvnc } }))
    await writeFile(join(x11Dir, `X${display}`), '')
  }
  const lockOf = (n: number) => join(lockDir, `.X${n}-lock`)
  const pidLine = (pid: number) => `${String(pid).padStart(10)}\n`
  // The lock names another live process.
  await stale('a0000001', 94, dead)
  await writeFile(lockOf(94), pidLine(unrelated))
  // Our pid was reused by a live process (same pid, other start time).
  await stale('a0000002', 93, { pid: unrelated, start: '1' })
  await writeFile(lockOf(93), pidLine(unrelated))
  // A FIFO would block a read forever; a symlink could point anywhere.
  await stale('a0000003', 97, dead)
  execFileSync('mkfifo', [lockOf(97)])
  await stale('a0000004', 98, dead)
  await writeFile(join(tmp, 'target'), pidLine(dead.pid))
  await symlink(join(tmp, 'target'), lockOf(98))
  // The one that is cleared: a regular file naming our dead Xvnc.
  await stale('a0000005', 99, dead)
  await writeFile(lockOf(99), pidLine(dead.pid))
  try {
    await recoverDesktops(root, { runBase, x11Dir, lockDir })
    for (const n of [94, 93, 97, 98]) {
      expect(existsSync(lockOf(n))).toBe(true)
      expect(existsSync(join(x11Dir, `X${n}`))).toBe(true)
    }
    expect(await readFile(join(tmp, 'target'), 'utf8')).toBe(pidLine(dead.pid))
    expect(existsSync(lockOf(99))).toBe(false)
    expect(existsSync(join(x11Dir, 'X99'))).toBe(false)
    expect(alive(unrelated)).toBe(true)
    expect(await readdir(runRoot)).toEqual([])
  } finally {
    process.kill(unrelated, 'SIGKILL')
  }
})

it('one leftover that cannot be cleaned does not block the others or later launches', async () => {
  const runRoot = desktopRunRoot(root, runBase)
  const bad = join(runRoot, 'aaaaaaa1'),
    good = join(runRoot, 'bbbbbbb2')
  const stuck = await stuckDir(join(bad, 'stuck'))
  await mkdir(join(good, 'xdg'), { recursive: true })
  const leftover = detached(['sleep', '600'], { PATH: process.env.PATH, XDG_RUNTIME_DIR: join(good, 'xdg') })
  try {
    const d = await launch()
    expect(d.display).toBe(90)
    expect(alive(leftover)).toBe(false)
    expect(existsSync(good)).toBe(false)
    expect(existsSync(bad)).toBe(true)
    expect(lines).toContain('Desktop: a leftover desktop could not be cleaned up')
    expect(lines.join('\n')).not.toContain(runRoot)
    await expect(recoverDesktops(root, { runBase, x11Dir, lockDir, log: () => {} })).resolves.toBeUndefined()
  } finally {
    await chmod(stuck, 0o700)
  }
})

it('a failed start whose cleanup fails throws DesktopLaunchCleanupError, keeps its display, and can be closed again', async () => {
  const adapter = await adapterFor({ cua: { FAKE_CUA_STUCK_ONCE: join(tmp, 'stuck-flag') } })
  const error = await adapter.launch(dir, config, never()).catch((e) => e)
  expect(error).toBeInstanceOf(DesktopLaunchCleanupError)
  const failed: DesktopInstance = error.instance
  const run = runOf(failed),
    stuck = join(run, 'xdg', 'stuck')
  try {
    expect(failed.isClosed()).toBe(true)
    // The processes are gone even though the folder is not.
    expect(await strays()).toEqual([])
    // Its display stays reserved until the cleanup is confirmed.
    const next = await adapter.launch(join(root, '00000000-0000-4000-8000-000000000002'), config, never())
    instances.push(next)
    expect(next.display).toBe(91)
    await expect(failed.close()).rejects.toThrow()
    await chmod(stuck, 0o700)
    await failed.close()
    expect(existsSync(run)).toBe(false)
    const third = await adapter.launch(join(root, '00000000-0000-4000-8000-000000000003'), config, never())
    instances.push(third)
    expect(third.display).toBe(90)
  } finally {
    await chmod(stuck, 0o700).catch(() => {})
  }
})

it('close() runs again after a failed close', async () => {
  const d = await launch()
  const run = runOf(d)
  const stuck = await stuckDir(join(run, 'stuck'))
  let exits = 0
  d.onExit(() => {
    exits++
  })
  try {
    await expect(d.close()).rejects.toThrow()
    expect(await strays()).toEqual([])
    await chmod(stuck, 0o700)
    await d.close()
    expect(existsSync(run)).toBe(false)
    expect(exits).toBe(0)
  } finally {
    await chmod(stuck, 0o700).catch(() => {})
  }
})

it('a crash whose cleanup fails fires onExit once, and close() then finishes the cleanup', async () => {
  const d = await launch()
  const run = runOf(d)
  const stuck = await stuckDir(join(run, 'stuck'))
  let exits = 0
  const first = new Promise<void>((resolve) =>
    d.onExit(() => {
      exits++
      resolve()
    })
  )
  try {
    process.kill((await pidsOf(d)).cua, 'SIGKILL')
    await first
    expect(d.isClosed()).toBe(true)
    expect(existsSync(run)).toBe(true)
    await chmod(stuck, 0o700)
    await d.close()
    expect(existsSync(run)).toBe(false)
    await sleep(50)
    expect(exits).toBe(1)
  } finally {
    await chmod(stuck, 0o700).catch(() => {})
  }
})

it('concurrent launches on one adapter reserve different displays', async () => {
  // Without lock files from the fake, only the adapter's own reservation keeps them apart.
  const adapter = await adapterFor({ xvnc: { FAKE_XVNC_LOCK_DIR: '', FAKE_XVNC_X11_DIR: '' } })
  const ds = await Promise.all([1, 2, 3].map((i) => adapter.launch(join(root, `00000000-0000-4000-8000-00000000001${i}`), config, never())))
  instances.push(...ds)
  expect(ds.map((d) => d.display).sort()).toEqual([90, 91, 92])
})

it('budgets for the longest socket a desktop makes, the at-spi bus', async () => {
  // A base whose run folder fits vnc.sock (9 bytes more) but not xdg/at-spi/bus_199 (19 more).
  const room = 85 - Buffer.byteLength(join(desktopRunRoot(root, tmp), 'ffffffff')) - 1
  expect(room).toBeGreaterThan(0)
  const base = join(tmp, 'p'.repeat(room))
  await mkdir(base)
  expect(Buffer.byteLength(join(desktopRunRoot(root, base), 'ffffffff', 'vnc.sock'))).toBeLessThanOrEqual(100)
  const adapter = await adapterFor({ runBase: base })
  await expect(adapter.launch(dir, config, never())).rejects.toThrow(/too long/)
  expect(existsSync(logs.xvnc)).toBe(false)
})

it('reads Xvnc\'s "already active" even when it arrives after the exit', async () => {
  const runtime = await fakeRuntime()
  // The shell exits at once; a child still holding its stderr writes the message later.
  runtime.xvnc = await wrapper(
    'Xvnc-late',
    `if [ "$1" = ":90" ]; then
  ( sleep 0.3; printf 'Fatal server error:\\n(EE) Server is already active for display 90\\n' >&2 ) &
  exit 1
fi
exec ${q(runtime.xvnc!)} "$@"`
  )
  const d = await createProcessAdapter(runtime, { x11Dir, lockDir, runBase }).launch(dir, config, never())
  instances.push(d)
  expect(d.display).toBe(91)
})

it('a retried close does not signal process groups again', async () => {
  const d = await launch()
  const stuck = await stuckDir(join(runOf(d), 'stuck'))
  try {
    await expect(d.close()).rejects.toThrow()
    const kill = vi.spyOn(process, 'kill')
    await chmod(stuck, 0o700)
    await d.close()
    expect(existsSync(runOf(d))).toBe(false)
    // The groups were confirmed gone; their ids may since belong to someone else.
    expect(kill.mock.calls.filter(([pid]) => (pid as number) < 0)).toEqual([])
  } finally {
    await chmod(stuck, 0o700).catch(() => {})
  }
})

it('a run folder id that collides with a live desktop is skipped, and recovery still leaves that desktop alone', async () => {
  const adapter = await adapterFor()
  forcedIds.push('0a0a0a0a')
  const a = await adapter.launch(dir, config, never())
  instances.push(a)
  expect(basename(runOf(a))).toBe('0a0a0a0a')
  forcedIds.push('0a0a0a0a', '0b0b0b0b')
  const b = await adapter.launch(join(root, '00000000-0000-4000-8000-000000000002'), config, never())
  instances.push(b)
  expect(basename(runOf(b))).toBe('0b0b0b0b')
  await recoverDesktops(root, { runBase, x11Dir, lockDir })
  expect(a.isClosed()).toBe(false)
  expect(existsSync(runOf(a))).toBe(true)
  expect((await a.call('list_windows', {}, never())).isError).toBe(false)
})

it('a busy X socket path that is not a file still counts as taken', async () => {
  const server = createServer().listen(join(x11Dir, 'X90'))
  await new Promise((r) => server.once('listening', r))
  try {
    const d = await launch()
    expect(d.display).toBe(91)
  } finally {
    server.close()
  }
})
