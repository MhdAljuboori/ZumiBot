import { spawn, type ChildProcess, type ChildProcessByStdio } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { writeFileAtomic } from '../fsutil'
import { isRunning, pause, processInfo, type ProcessIdentity } from '../browser/browserProcess'
import { CuaTransport } from './cuaTransport'
import { DESKTOP_PROGRAMS, type DesktopRuntime } from './desktopRuntime'
import {
  DesktopLaunchCleanupError,
  DesktopUnavailableError,
  type CuaContent,
  type CuaResult,
  type DesktopAdapter,
  type DesktopConfig,
  type DesktopInstance
} from './types'
import { xauthEntry } from './xauth'

/** cua-driver only. Telemetry is on by default and stored per HOME, so a fresh desktop home would re-enable it. */
export const CUA_ENV: Readonly<Record<string, string>> = {
  DO_NOT_TRACK: '1',
  CUA_DRIVER_RS_TELEMETRY_ENABLED: '0',
  CUA_TELEMETRY_ENABLED: '0',
  CUA_DRIVER_RS_UPDATE_CHECK: '0',
  CUA_DRIVER_PERMISSION_MODE: 'standard',
  CUA_DRIVER_DISABLE_RUN_SCRIPT: '1',
  CUA_DRIVER_DISABLE_UNRESTRICTED: '1'
}
// Hides the host's volumes and Trash from the desktop's file views.
const GIO_ENV = { GIO_USE_VFS: 'local', GIO_USE_VOLUME_MONITOR: 'unix', GVFS_DISABLE_FUSE: '1' }
const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin'
// sun_path holds 108 bytes; keep a margin.
const SOCKET_PATH_MAX = 100
const START_MS = 10000
const CUA_START_MS = 20000
const GRACE_MS = 3000
const BUSY_TRIES = 5

type Proc = 'xvnc' | 'bus' | 'session' | 'cua'
const LABEL: Record<Proc, string> = { xvnc: 'display server', bus: 'session bus', session: 'desktop session', cua: 'cua-driver' }
type RunState = { version: 1; display: number | null; processes: Partial<Record<Proc, ProcessIdentity>> }
type Started = { name: Proc; pid: number | null; done: boolean; exited: Promise<void>; drained: Promise<void> }

export interface ProcessAdapterOptions {
  displays?: [number, number]
  x11Dir?: string
  /** Where X servers keep `.X<N>-lock`. */
  lockDir?: string
  /** Parent of the short runtime folders; default XDG_RUNTIME_DIR, else the temp dir. */
  runBase?: string
  log?: (line: string) => void
}
export type RecoverOptions = Pick<ProcessAdapterOptions, 'x11Dir' | 'lockDir' | 'runBase' | 'log'>
type Options = Required<ProcessAdapterOptions>

const uid = () => process.getuid?.() ?? -1
const code = (error: unknown) => (error as NodeJS.ErrnoException).code
const cancelled = () => new Error('Desktop start was cancelled')
const fill = (o: ProcessAdapterOptions): Options => ({
  displays: o.displays ?? [90, 199],
  x11Dir: o.x11Dir ?? '/tmp/.X11-unix',
  lockDir: o.lockDir ?? '/tmp',
  runBase: o.runBase ?? defaultRunBase(),
  log: o.log ?? ((line) => console.error(line))
})
function defaultRunBase(): string {
  const dir = process.env.XDG_RUNTIME_DIR
  return dir && isAbsolute(dir) ? dir : tmpdir()
}

// Run folders of desktops this server runs; recovery never touches them.
const active = new Set<string>()

/**
 * Short runtime root for one data dir's desktops: `<base>/zumibot-<uid>/<8 hex of the desktops folder>`.
 * The data dir is too deep for unix sockets, and keying by it keeps another server's desktops (e2e
 * runs beside the real app) out of this one's recovery.
 */
export function desktopRunRoot(desktopsRoot: string, runBase: string = defaultRunBase()): string {
  const key = createHash('sha256').update(resolve(desktopsRoot)).digest('hex').slice(0, 8)
  return join(runBase, `zumibot-${uid()}`, key)
}

/** 0700 and ours: in /tmp another user could have made the folder first. */
async function privateDir(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if (code(error) !== 'EEXIST') throw error
  }
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid()) throw new Error('Unsafe desktop runtime folder')
  await chmod(path, 0o700)
}

function sanitizedPath(): string {
  // Relative entries would let a child pick programs from its working folder.
  const dirs = (process.env.PATH ?? '').split(':').filter((d) => d && isAbsolute(d))
  return dirs.length ? dirs.join(':') : DEFAULT_PATH
}

/** Built from scratch: the server's env (ZUMIBOT_* secrets included) never reaches the desktop. */
function desktopEnv(display: number, run: string, home: string): NodeJS.ProcessEnv {
  const xdg = join(run, 'xdg')
  return {
    PATH: sanitizedPath(),
    LANG: process.env.LANG || 'C.UTF-8',
    DISPLAY: `:${display}`,
    XAUTHORITY: join(run, 'Xauthority'),
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    // Also the ownership marker recovery looks for. Without a bus address, libdbus would autolaunch one outside our groups.
    XDG_RUNTIME_DIR: xdg,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(xdg, 'bus')}`,
    ...GIO_ENV
  }
}
const marker = (run: string) => `XDG_RUNTIME_DIR=${join(run, 'xdg')}`

function canConnect(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolve(false)
    })
  })
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    return code(error) !== 'ENOENT'
  }
}
// browserProcess's identity helpers, with errors that name the desktop.
async function running(p: ProcessIdentity): Promise<boolean> {
  try {
    return await isRunning(p)
  } catch {
    throw new Error('Desktop process identity unavailable')
  }
}
async function procInfo(pid: number): ReturnType<typeof processInfo> {
  try {
    return await processInfo(pid)
  } catch {
    throw new Error('Desktop process identity unavailable')
  }
}
/** EPERM counts as gone: a group member we may not signal cannot be waited for either. */
function groupLives(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}
function sendSignal(pid: number, group: boolean, sig: NodeJS.Signals): void {
  // A pid of 0 or 1 would turn a group kill into "every process we may signal".
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return
  try {
    process.kill(group ? -pid : pid, sig)
  } catch {
    /* already gone */
  }
}

/** Every live process carrying this desktop's marker, wherever it moved (setsid, nohup, a terminal's shell). */
async function markedPids(run: string): Promise<number[]> {
  const entry = marker(run)
  const pids = (await readdir('/proc'))
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => pid !== process.pid)
  const found = await Promise.all(
    pids.map(async (pid) => {
      try {
        return (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0').includes(entry) ? pid : null
      } catch {
        return null
      }
    })
  )
  return found.filter((pid): pid is number => pid !== null)
}

/** A recorded pid counts only with its birth time and a command line or env naming the run folder (pid reuse). */
async function ownRecorded(p: ProcessIdentity, run: string): Promise<boolean> {
  if (!(await running(p))) return false
  try {
    if ((await readFile(`/proc/${p.pid}/cmdline`, 'utf8')).includes(`${run}/`)) return true
    return (await readFile(`/proc/${p.pid}/environ`, 'utf8')).split('\0').includes(marker(run))
  } catch {
    return false
  }
}

async function killLeftovers(run: string, recorded: ProcessIdentity[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const owned = (await Promise.all(recorded.map(async (p) => ((await ownRecorded(p, run)) ? p.pid : null)))).filter(
      (pid): pid is number => pid !== null
    )
    const marked = await markedPids(run)
    if (!owned.length && !marked.length) return
    if (attempt >= 40) throw new Error('Desktop cleanup could not be confirmed')
    // Recorded leaders were spawned detached, so their pid is their group; the pid itself too, in case it left it.
    for (const pid of owned) {
      sendSignal(pid, true, 'SIGKILL')
      sendSignal(pid, false, 'SIGKILL')
    }
    for (const pid of marked) sendSignal(pid, false, 'SIGKILL')
    await pause(50)
  }
}

/** The pid in an X lock, read only from a regular file of ours: a FIFO would block, a symlink could point anywhere. */
async function lockOwner(lock: string): Promise<number | null> {
  let file
  try {
    file = await open(lock, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch {
    return null
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.uid !== uid()) return null
    const buffer = Buffer.alloc(32)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('latin1').trim()
    return /^\d+$/.test(text) ? Number(text) : null
  } catch {
    return null
  } finally {
    await file.close()
  }
}

/**
 * A crashed Xvnc leaves its lock and socket; without this, every crash would use up a display number.
 * Only when the lock names our Xvnc and no process holds that pid now (or only its zombie): a reused
 * pid may be another X server that took the number.
 */
async function clearXLock(display: number, xvnc: ProcessIdentity, o: Options): Promise<void> {
  const lock = join(o.lockDir, `.X${display}-lock`)
  if ((await lockOwner(lock)) !== xvnc.pid) return
  const info = await procInfo(xvnc.pid)
  if (info && !(info.state === 'Z' && info.start === xvnc.start)) return
  for (const path of [lock, join(o.x11Dir, `X${display}`)]) {
    try {
      await unlink(path)
    } catch {
      /* gone */
    }
  }
}

async function readState(run: string): Promise<RunState | null> {
  try {
    const value = JSON.parse(await readFile(join(run, 'desktop.json'), 'utf8')) as RunState
    const valid = (p: unknown) => {
      const id = p as ProcessIdentity
      return id && Number.isSafeInteger(id.pid) && id.pid > 1 && /^\d+$/.test(id.start)
    }
    if (value.version !== 1 || !value.processes || typeof value.processes !== 'object' || !Object.values(value.processes).every(valid))
      return null
    if (value.display !== null && !(Number.isSafeInteger(value.display) && value.display >= 0)) return null
    return value
  } catch {
    return null
  }
}

async function recoverRun(run: string, o: Options): Promise<void> {
  const state = await readState(run)
  await killLeftovers(run, Object.values(state?.processes ?? {}))
  if (state?.display != null && state.processes.xvnc) await clearXLock(state.display, state.processes.xvnc, o)
  await rm(run, { recursive: true, force: true })
}

async function recoverRunRoot(runRoot: string, o: Options): Promise<void> {
  let entries
  try {
    const stat = await lstat(runRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid()) throw new Error('Unsafe desktop runtime folder')
    entries = await readdir(runRoot, { withFileTypes: true })
  } catch (error) {
    if (code(error) === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const run = join(runRoot, entry.name)
    if (!entry.isDirectory() || !/^[0-9a-f]{8}$/.test(entry.name) || active.has(run)) continue
    // One stuck leftover must not block the others or every later launch. Its lock, if any,
    // still keeps the allocator off its display number.
    try {
      await recoverRun(run, o)
    } catch {
      o.log('Desktop: a leftover desktop could not be cleaned up')
    }
  }
}

/**
 * Kills what a previous run of this server left of this data dir's desktops (by pid files and the
 * env marker) and frees their X display numbers. Other data dirs and other X servers are never touched.
 * `root` must be the same `join(dataDir, 'desktops')` the profile dirs given to `launch` live in:
 * the runtime root is keyed by `dirname(resolve(dir))`.
 */
export async function recoverDesktops(root: string, o: RecoverOptions = {}): Promise<void> {
  if (process.platform !== 'linux') return
  const options = fill(o)
  await recoverRunRoot(desktopRunRoot(root, options.runBase), options)
}

export function createProcessAdapter(runtime: DesktopRuntime, o: ProcessAdapterOptions = {}): DesktopAdapter {
  const options = fill(o)
  const reserved = new Set<number>()
  const recovered = new Map<string, Promise<void>>()
  let warned = false
  return {
    async launch(dir, config, signal) {
      const keys = Object.keys(DESKTOP_PROGRAMS) as (keyof typeof DESKTOP_PROGRAMS)[]
      const missing = runtime.missing.length ? runtime.missing : keys.filter((k) => !runtime[k]).map((k) => DESKTOP_PROGRAMS[k])
      if (missing.length) throw new DesktopUnavailableError(missing)
      if (process.platform !== 'linux') throw new DesktopUnavailableError(['Linux'])
      if (signal.aborted) throw cancelled()
      const root = dirname(resolve(dir))
      const runRoot = desktopRunRoot(root, options.runBase)
      // The longest socket a desktop makes is at-spi's bus, named after the display.
      const sockets = ['vnc.sock', join('xdg', 'bus'), join('xdg', 'at-spi', `bus_${options.displays[1]}`)]
      if (Math.max(...sockets.map((s) => Buffer.byteLength(join(runRoot, 'ffffffff', s)))) > SOCKET_PATH_MAX) {
        throw new Error('Desktop runtime folder path is too long for unix sockets; set XDG_RUNTIME_DIR or TMPDIR to a shorter folder')
      }
      let recovery = recovered.get(runRoot)
      if (!recovery) {
        recovery = recoverRunRoot(runRoot, options)
        recovered.set(runRoot, recovery)
        recovery.catch(() => recovered.delete(runRoot))
      }
      await recovery
      if (!warned && basename(runtime.session![0]) === 'startxfce4') {
        warned = true
        options.log("Desktop: ZUMIBOT_DESKTOP_SESSION runs startxfce4, so the host's XFCE autostart entries run in every desktop")
      }
      const home = join(dir, 'home')
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await privateDir(home)
      for (const sub of [['.config'], ['.local', 'share'], ['.cache']]) await mkdir(join(home, ...sub), { recursive: true, mode: 0o700 })
      await privateDir(dirname(runRoot))
      await privateDir(runRoot)
      const desktop = new ProcessDesktop(await createRun(runRoot), runtime, options, reserved, config)
      try {
        await desktop.start(home, signal)
      } catch (error) {
        // Unconfirmed cleanup keeps its display and maybe processes: the caller must keep counting it.
        try {
          await desktop.close()
        } catch {
          throw new DesktopLaunchCleanupError(desktop)
        }
        throw signal.aborted ? cancelled() : error
      }
      return desktop
    }
  }
}

async function createRun(runRoot: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const run = join(runRoot, randomBytes(4).toString('hex'))
    // A live desktop's id: its entry is not ours to add or remove.
    if (active.has(run)) continue
    // Marked before it exists, so a concurrent recovery cannot remove it.
    active.add(run)
    let made = false
    try {
      await mkdir(run, { mode: 0o700 })
      made = true
      await chmod(run, 0o700)
      return run
    } catch (error) {
      active.delete(run)
      if (made) await rmdir(run).catch(() => {})
      if (code(error) !== 'EEXIST') throw error
    }
  }
  throw new Error('Desktop runtime folder could not be created')
}

class ProcessDesktop implements DesktopInstance {
  readonly generation = randomUUID()
  readonly vncSocket: string
  display = -1
  private readonly procs: Started[] = []
  private readonly identities: RunState['processes'] = {}
  private readonly listeners = new Set<() => void>()
  private readonly cookie = randomBytes(16)
  private client: Client | null = null
  private started = false
  private closed = false
  private exitFired = false
  // Once every group is confirmed gone its id may be reused, so a retried close never signals it again.
  private groupsStopped = false
  private ending: Promise<void> | null = null
  private xvncTail = ''

  constructor(
    private readonly run: string,
    private readonly runtime: DesktopRuntime,
    private readonly o: Options,
    private readonly reserved: Set<number>,
    private readonly config: DesktopConfig
  ) {
    this.vncSocket = join(run, 'vnc.sock')
  }

  async start(home: string, signal: AbortSignal): Promise<void> {
    const xdg = join(this.run, 'xdg')
    await mkdir(xdg, { mode: 0o700 })
    await chmod(xdg, 0o700)
    await this.startXvnc(home, signal)
    const env = desktopEnv(this.display, this.run, home)
    this.spawn(
      'bus',
      this.runtime.dbusDaemon!,
      ['--session', '--nofork', '--nopidfile', '--nosyslog', `--address=unix:path=${join(xdg, 'bus')}`],
      env,
      home
    )
    await this.saveState()
    const bus = await this.waitSocket(join(xdg, 'bus'), signal)
    if (bus !== 'ready') throw new Error(`Desktop session bus ${bus === 'timeout' ? 'did not start in time' : 'exited during start'}`)
    const [command, ...args] = this.runtime.session!
    this.spawn('session', command, args, env, home)
    await this.saveState()
    await this.startCua(env, home, signal)
    this.started = true
    if (this.procs.some((p) => p.done)) throw new Error('Desktop stopped during start')
  }

  private async startXvnc(home: string, signal: AbortSignal): Promise<void> {
    const { width, height } = this.config
    const [first, last] = this.o.displays
    let tries = 0
    for (let n = first; n <= last && tries < BUSY_TRIES; n++) {
      if (this.reserved.has(n)) continue
      // Reserved before any await, so concurrent launches never pick the same number.
      this.reserved.add(n)
      if ((await exists(join(this.o.x11Dir, `X${n}`))) || (await exists(join(this.o.lockDir, `.X${n}-lock`))) || signal.aborted) {
        this.reserved.delete(n)
        if (signal.aborted) throw cancelled()
        continue
      }
      this.display = n
      tries++
      // The entry names the display number, so it is rewritten for each attempt.
      const auth = join(this.run, 'Xauthority')
      await writeFile(auth, xauthEntry(n, this.cookie), { mode: 0o600 })
      await chmod(auth, 0o600)
      this.xvncTail = ''
      const xvnc = this.spawn(
        'xvnc',
        this.runtime.xvnc!,
        [
          `:${n}`,
          '-geometry',
          `${width}x${height}`,
          '-depth',
          '24',
          '-rfbport',
          '-1',
          '-rfbunixpath',
          this.vncSocket,
          '-rfbunixmode',
          '0600',
          '-SecurityTypes',
          'None',
          '-nolisten',
          'tcp',
          '-nolisten',
          'local',
          '-auth',
          auth,
          '-AlwaysShared',
          '-AcceptSetDesktopSize=0',
          '-desktop',
          'ZumiBot'
        ],
        {
          PATH: sanitizedPath(),
          LANG: process.env.LANG || 'C.UTF-8',
          HOME: home,
          XDG_RUNTIME_DIR: join(this.run, 'xdg'),
          DBUS_SESSION_BUS_ADDRESS: 'disabled:'
        },
        home
      )
      await this.saveState()
      const result = await this.waitSocket(this.vncSocket, signal)
      if (result === 'ready') return
      // 'exit' can come before the last stderr bytes; read the tail once the pipe is drained.
      if (result === 'exited') await Promise.race([xvnc.drained, pause(1000)])
      if (result === 'exited' && /already active/i.test(this.xvncTail)) {
        // Another X server won the number between our check and its start: not ours to clean.
        this.procs.splice(this.procs.indexOf(xvnc), 1)
        delete this.identities.xvnc
        this.reserved.delete(n)
        this.display = -1
        continue
      }
      throw new Error(`Desktop display server ${result === 'timeout' ? 'did not start in time' : 'exited during start'}`)
    }
    throw new Error('No free X display for the desktop')
  }

  private async startCua(env: NodeJS.ProcessEnv, home: string, signal: AbortSignal): Promise<void> {
    const child = spawn(this.runtime.cuaDriver!, ['mcp'], {
      env: { ...env, ...CUA_ENV },
      cwd: home,
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore']
    }) as ChildProcessByStdio<Writable, Readable, null>
    this.track('cua', child)
    await this.saveState()
    const client = new Client({ name: 'zumibot', version: '1.0.0' })
    // Errors may quote cua-driver output; the calls report failures themselves.
    client.onerror = () => {}
    this.client = client
    await this.guard(client.connect(new CuaTransport(child, this.o.log), { signal, timeout: CUA_START_MS }), signal)
    // Health check; a plain request also skips compiling cua's 65 output schemas.
    await this.guard(client.request({ method: 'tools/list' }, ListToolsResultSchema, { signal, timeout: CUA_START_MS }), signal)
  }

  /** Fails a start step as soon as any process of the desktop exits or the launch is aborted. */
  private guard<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    work.catch(() => {})
    const died = Promise.race(this.procs.map((p) => p.exited)).then(() => {
      throw new Error('Desktop stopped during start')
    })
    died.catch(() => {})
    let onAbort!: () => void
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(cancelled())
      signal.addEventListener('abort', onAbort, { once: true })
    })
    aborted.catch(() => {})
    if (signal.aborted) onAbort()
    return Promise.race([work, died, aborted]).finally(() => signal.removeEventListener('abort', onAbort))
  }

  private async waitSocket(path: string, signal: AbortSignal): Promise<'ready' | 'exited' | 'timeout'> {
    const end = Date.now() + START_MS
    for (;;) {
      if (signal.aborted) throw cancelled()
      if (this.procs.some((p) => p.done)) return 'exited'
      if (await canConnect(path)) return 'ready'
      if (Date.now() > end) return 'timeout'
      await pause(25)
    }
  }

  private spawn(name: Proc, file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Started {
    // Detached: each process leads its own group, so a group kill also reaches what it started.
    const child = spawn(file, args, { env, cwd, detached: true, stdio: ['ignore', 'ignore', name === 'xvnc' ? 'pipe' : 'ignore'] })
    // Xvnc's stderr is drained (a full pipe would block it) and only its tail kept, to spot "already active".
    child.stderr?.on('data', (chunk: Buffer) => {
      this.xvncTail = (this.xvncTail + chunk.toString('latin1')).slice(-4096)
    })
    child.stderr?.on('error', () => {})
    return this.track(name, child)
  }

  private track(name: Proc, child: ChildProcess): Started {
    let resolveExit!: () => void, resolveDrained!: () => void
    const p: Started = {
      name,
      pid: child.pid ?? null,
      done: false,
      exited: new Promise<void>((r) => {
        resolveExit = r
      }),
      drained: new Promise<void>((r) => {
        resolveDrained = r
      })
    }
    const finish = (status: number | null, sig: NodeJS.Signals | null) => {
      if (p.done) return
      p.done = true
      resolveExit()
      if (!this.started || this.closed) return
      this.o.log(`Desktop :${this.display}: ${LABEL[name]} exited (${sig ?? `code ${status}`}); stopping the desktop`)
      void this.end(true).catch(() => this.o.log(`Desktop :${this.display}: cleanup could not be confirmed`))
    }
    child.once('exit', finish)
    child.once('error', () => finish(null, null))
    // 'close' comes after the exit once every stdio stream has ended: only then is the stderr tail complete.
    child.once('close', () => resolveDrained())
    this.procs.push(p)
    return p
  }

  private async saveState(): Promise<void> {
    for (const p of this.procs) {
      if (p.pid === null || this.identities[p.name]?.pid === p.pid) continue
      const info = await procInfo(p.pid)
      if (info) this.identities[p.name] = { pid: p.pid, start: info.start }
    }
    const state: RunState = { version: 1, display: this.display >= 0 ? this.display : null, processes: this.identities }
    await writeFileAtomic(join(this.run, 'desktop.json'), JSON.stringify(state), 0o600)
  }

  async call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CuaResult> {
    const client = this.client
    if (this.closed || !client) throw new Error('Desktop unavailable')
    let result
    try {
      result = await client.request({ method: 'tools/call', params: { name: tool, arguments: args } }, CallToolResultSchema, {
        signal,
        timeout: this.config.commandMs + 5000
      })
    } catch {
      // The SDK's message may quote cua-driver; callers get a fixed text.
      throw new Error(this.closed ? 'Desktop unavailable' : 'Desktop command did not complete')
    }
    const content: CuaContent[] = []
    for (const block of result.content) {
      if (block.type === 'text') content.push({ type: 'text', text: block.text })
      else if (block.type === 'image') content.push({ type: 'image', mimeType: block.mimeType, data: block.data })
    }
    const structured = result.structuredContent
    return {
      content,
      isError: result.isError === true,
      structuredContent: structured && typeof structured === 'object' && !Array.isArray(structured) ? structured : null
    }
  }

  isClosed(): boolean {
    return this.closed
  }

  onExit(cb: () => void): () => void {
    if (this.exitFired) {
      queueMicrotask(cb)
      return () => {}
    }
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  close(): Promise<void> {
    return this.end(false)
  }

  /** Ends cua-driver's stdin, SIGTERMs every group, SIGKILLs after 3 s, then clears the X lock and run folder. */
  private end(crashed: boolean): Promise<void> {
    if (this.ending) return this.ending
    this.closed = true
    const work = (async () => {
      try {
        await this.client?.close().catch(() => {})
        const cua = this.procs.find((p) => p.name === 'cua')
        // cua-driver exits by itself on stdin EOF, which lets it finish cleanly.
        if (cua) await Promise.race([cua.exited, pause(1000)])
        if (!this.groupsStopped) {
          await this.stopGroups()
          this.groupsStopped = true
        }
        await killLeftovers(this.run, [])
        const xvnc = this.identities.xvnc
        if (this.display >= 0 && xvnc) await clearXLock(this.display, xvnc, this.o)
        await rm(this.run, { recursive: true, force: true })
        active.delete(this.run)
        if (this.display >= 0) this.reserved.delete(this.display)
      } finally {
        if (crashed && !this.exitFired) {
          this.exitFired = true
          for (const cb of [...this.listeners]) {
            try {
              cb()
            } catch {
              /* a listener's failure is its own */
            }
          }
          this.listeners.clear()
        }
      }
    })()
    this.ending = work
    // Unconfirmed cleanup can be retried: the next close() runs every step again (each is idempotent).
    void work.catch(() => {
      if (this.ending === work) this.ending = null
    })
    return work
  }

  private async stopGroups(): Promise<void> {
    const groups = this.procs.map((p) => p.pid).filter((pid): pid is number => pid !== null)
    const live = () => groups.filter(groupLives)
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      for (const pid of live()) sendSignal(pid, true, sig)
      const end = Date.now() + GRACE_MS
      while (live().length && Date.now() < end) await pause(25)
      if (!live().length) return
    }
    throw new Error('Desktop processes did not exit')
  }
}
