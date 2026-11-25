import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  PROCESSES_PER_CHAT,
  PROCESSES_TOTAL,
  PROCESS_ENDED_KEPT,
  PROCESS_LIFETIME_DEFAULT_MIN,
  PROCESS_LIFETIME_MAX_MIN,
  PROCESS_LOGS_TOTAL_BYTES,
  PROCESS_LOG_FILE_BYTES,
  PROCESS_READ_MAX,
  PROCESS_REFUSALS,
  PROCESS_RING_BYTES,
  PROCESS_TAIL_DEFAULT,
  PROCESS_TAIL_MAX,
  PROCESS_TOOL_TEXT_MAX,
  PROCESS_WAIT_DEFAULT_S,
  PROCESS_WAIT_MAX_S,
  WAKE_TAIL_BYTES,
  WAKE_TAIL_LINES,
  cleanOutput,
  commandError,
  cutLines,
  deriveName,
  exitFires,
  isProcessName,
  lineMatches,
  parseNotify,
  sameNameRunning,
  spanText,
  stateText,
  tailLines,
  type NotifyRule,
  type ProcessInfo,
  type ProcessLogRead,
  type ProcessRun,
  type ProcessStoppedBy,
  type ProcessWake,
  type WakeEvent
} from '@zumibot/shared/processes'
import { RUN_OUTPUT_MAX, type RunEnd } from '@zumibot/shared/runBlocks'
import { writeFileAtomic } from '../fsutil'
import { scrubText } from '../vault/scrub'
import { ProcessOutput, type LogFiles } from './processOutput'
import {
  bootId,
  endTree,
  groupAlive,
  killTagged,
  procIdentity,
  PROCESS_TAG_ENV,
  taggedAlive,
  TERM_GRACE_MS,
  KILL_WAIT_MS
} from './processTree'
import { defaultBash } from '../procKill'

/** What the index keeps beside the wire form: never sent to a client or an agent. */
interface StoredProcess extends ProcessInfo {
  pid: number | null
  bootId: string | null
  startTicks: string | null
  /** The cursor of the oldest byte still on disk (moves when the log rotates). */
  logBase: number
  lifetimeMs: number
}
interface IndexFile {
  v: 1
  items: StoredProcess[]
}

export type ProcessEvent = { kind: 'changed'; chatId: string; running: number } | { kind: 'output'; chatId: string; id: string; to: number }

/** The end of a user's Run (Task 4 sends the block's author the result, Task 5 audits it). One per run, however it ended. */
export interface RunEndEvent {
  chatId: string
  id: string
  messageId: string
  command: string
  cwd: string
  /** The block's author (`startedBy`). */
  agent: string
  startedAt: number
  endedAt: number
  /** null: send no message (the run was interrupted by something other than the user's Stop, or never ran). */
  end: RunEnd | null
  outcome: 'ok' | 'error' | 'interrupted'
  /** For the audit record. */
  error: string | null
  /** The scrubbed tail of this run's output; '' when `end` is null. */
  output: string
  /** Whether older output of the run was left out. */
  cut: boolean
}

export interface ProcessChat {
  cwd: string
  archived: boolean
}

export interface ProcessServiceDeps {
  dataDir: string
  /** The base env of a run (`runEnv.env()` once ready): the process env is made from it, never from the server's own. */
  env(): Promise<NodeJS.ProcessEnv>
  /** The chat's folder and whether it is archived; null once it is gone. */
  chat(chatId: string): Promise<ProcessChat | null>
  push(e: ProcessEvent): void
  /** The vault values granted to an agent: output and commands are scrubbed with the starting agent's before they leave. */
  scrubOf?(agent: string): ReadonlyMap<string, string>
  /** A notify rule raised an event (Phase 3): the wake service decides whether and when the agent hears of it. */
  onWake?(e: WakeEvent): void
  /** A user's Run ended (any way): the block's author hears of it, and the audit log records it. */
  onRunEnd?(e: RunEndEvent): void
  now?(): number
  shell?: string
  limits?: Partial<Limits>
}
interface Limits {
  perChat: number
  total: number
  ringBytes: number
  fileBytes: number
  logsTotal: number
  endedKept: number
  graceMs: number
  killWaitMs: number
  outputEventMs: number
}

export interface StartRequest {
  command: string
  name?: string
  cwd?: string
  timeoutMinutes?: number
  notify?: NotifyRule
}

interface WaitLine {
  line: string
  to: number
}
interface Live {
  rec: StoredProcess
  child: ChildProcess
  output: ProcessOutput
  /** Set when someone ends it: the exit then reads `stopped`, by them. */
  stopping: ProcessStoppedBy | null
  /** Set by Restart before it ends the old run: that end is the user's own doing, not a Stop. */
  restarting?: true
  /** The cursor where this run's output starts (a Restart appends to the same stream). */
  from: number
  exited: Promise<void>
  partial: string
  partialTo: number
  lineListeners: Set<(l: WaitLine) => void>
  exitListeners: Set<() => void>
  lifetime: NodeJS.Timeout | null
  outputTimer: NodeJS.Timeout | null
  decoder: TextDecoder
}

const INDEX = 'index.json'
// Every name a ZumiBot run or the CLI itself sets: a process gets none of them (capabilities, dev hooks, the data dir, the CLI's
// own switches such as CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).
const DROPPED_ENV = /^(ZUMIBOT_|CLAUDE_CODE_)|^CLAUDECODE$/

/** The env of a process: the run's base env less every ZumiBot and Claude Code name. No capability, temp folder, pause flag or key. */
export function processEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !DROPPED_ENV.test(k)) env[k] = v
  return env
}

const errCode = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? code : 'error'
}
const newId = () => `p_${randomBytes(5).toString('hex')}`
const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)

export class ProcessService {
  private readonly items = new Map<string, StoredProcess>()
  private readonly live = new Map<string, Live>()
  private readonly locks = new Map<string, Promise<unknown>>()
  private writeQueue: Promise<void> = Promise.resolve()
  private down = false
  // Chats being deleted: between ending their processes and the store forgetting them, a start must not slip in.
  private readonly removed = new Set<string>()
  private loaded = false
  private readonly lim: Limits
  private readonly root: string

  constructor(private readonly d: ProcessServiceDeps) {
    this.root = join(d.dataDir, 'processes')
    this.lim = {
      perChat: PROCESSES_PER_CHAT,
      total: PROCESSES_TOTAL,
      ringBytes: PROCESS_RING_BYTES,
      fileBytes: PROCESS_LOG_FILE_BYTES,
      logsTotal: PROCESS_LOGS_TOTAL_BYTES,
      endedKept: PROCESS_ENDED_KEPT,
      graceMs: TERM_GRACE_MS,
      killWaitMs: KILL_WAIT_MS,
      outputEventMs: 250,
      ...d.limits
    }
  }

  private now(): number {
    return this.d.now?.() ?? Date.now()
  }

  /**
   * Reads the index at start. Anything recorded as running is lost: never adopted, read or shown as running again. A tree a crash
   * left behind is ended only when it is provably the same one (this boot, the same start time, still its group's leader).
   */
  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    let file: IndexFile | null = null
    try {
      file = parseIndex(JSON.parse(await readFile(join(this.root, INDEX), 'utf8')))
    } catch (err) {
      if (errCode(err) !== 'ENOENT') console.error('process index unreadable, starting empty:', errCode(err))
    }
    const boot = await bootId()
    let changed = false
    const lostRuns: StoredProcess[] = []
    for (const rec of file?.items ?? []) {
      if (rec.state === 'running') {
        changed = true
        if (rec.run) lostRuns.push(rec)
        const out = await ProcessOutput.open(this.filesOf(rec), rec.logBase, { onRotate: () => {}, onError: () => {} })
        Object.assign(rec, { state: 'lost', endedAt: this.now(), out: out.end, note: null })
        if (rec.pid !== null && boot !== null && rec.bootId === boot && rec.startTicks !== null) {
          const id = await procIdentity(rec.pid)
          if (id && id.startTicks === rec.startTicks && id.pgid === rec.pid) {
            await endTree(rec.pid, { graceMs: this.lim.graceMs, killWaitMs: this.lim.killWaitMs, tag: rec.id })
            rec.note = 'ended at start'
          }
        } else if (process.platform === 'win32' && (await taggedAlive(rec.id))) {
          // No /proc to prove a pid is still ours, but the id in each process's env is: it names nothing else.
          await killTagged(rec.id)
          rec.note = 'ended at start'
        }
        rec.pid = null
      }
      this.items.set(rec.id, rec)
    }
    this.loaded = true
    if (changed) await this.save()
    // After the save, so a listener that reads the records finds them written.
    for (const rec of lostRuns) this.raiseRunEnd(rec, { end: null, outcome: 'interrupted', error: 'lost at restart' }, '', false)
  }

  // ---- reads ----

  list(chatId: string): ProcessInfo[] {
    return [...this.items.values()]
      .filter((r) => r.chatId === chatId)
      .sort(
        (a, b) => Number(b.state === 'running') - Number(a.state === 'running') || (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)
      )
      .map((r) => this.wire(r))
  }

  counts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const r of this.items.values()) if (r.state === 'running') out[r.chatId] = (out[r.chatId] ?? 0) + 1
    return out
  }

  runningCount(): number {
    return this.live.size
  }

  private running(chatId: string): number {
    let n = 0
    for (const l of this.live.values()) if (l.rec.chatId === chatId) n++
    return n
  }

  private scrubFor(r: StoredProcess): ReadonlyMap<string, string> {
    try {
      return this.d.scrubOf?.(r.startedBy) ?? new Map()
    } catch {
      return new Map()
    }
  }

  private wire(r: StoredProcess): ProcessInfo {
    const live = this.live.get(r.id)
    const scrub = this.scrubFor(r)
    return {
      id: r.id,
      chatId: r.chatId,
      name: r.name,
      command: scrubText(r.command, scrub),
      cwd: r.cwd,
      startedBy: r.startedBy,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      state: r.state,
      exitCode: r.exitCode,
      signal: r.signal,
      stoppedBy: r.stoppedBy,
      note: r.note,
      restarts: r.restarts,
      until: r.until,
      out: live ? live.output.end : r.out,
      wake: r.wake === null ? null : { ...r.wake, patterns: r.wake.patterns.map((x) => scrubText(x, scrub)) },
      run: r.run
    }
  }

  private own(chatId: string, id: string): StoredProcess {
    const r = this.items.get(id)
    if (!r || r.chatId !== chatId) throw new Error(PROCESS_REFUSALS.notFound)
    return r
  }

  /** A client's read: cleaned and scrubbed, at most PROCESS_READ_MAX bytes from `from` (the newest that many when absent). */
  async read(chatId: string, id: string, from?: number): Promise<ProcessLogRead> {
    const r = this.own(chatId, id)
    const out = await this.outputOf(r)
    try {
      const got = from === undefined ? await out.tail(PROCESS_READ_MAX) : await out.read(from, PROCESS_READ_MAX)
      return {
        text: scrubText(cutLines(cleanOutput(got.bytes.toString('utf8'))), this.scrubFor(r)),
        from: got.from,
        to: got.to,
        dropped: got.dropped,
        state: r.state
      }
    } finally {
      if (!this.live.has(r.id)) await out.close()
    }
  }

  private outputOf(r: StoredProcess): Promise<ProcessOutput> {
    const live = this.live.get(r.id)
    return live ? Promise.resolve(live.output) : ProcessOutput.open(this.filesOf(r), r.logBase, { onRotate: () => {}, onError: () => {} })
  }

  /** A chat's log folder; a chat id is a plain name, so it can never point outside processes/. */
  private chatDir(chatId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(chatId)) throw new Error(PROCESS_REFUSALS.closed)
    return join(this.root, chatId)
  }

  private filesOf(r: Pick<StoredProcess, 'chatId' | 'id'>): LogFiles {
    const dir = this.chatDir(r.chatId)
    return { current: join(dir, `${r.id}.log`), previous: join(dir, `${r.id}.log.1`) }
  }

  // ---- starting ----

  /** Starts a command the agent asked for, after its card was answered. Refusals are plain sentences. */
  start(chatId: string, agent: string, req: StartRequest, opts?: { run?: ProcessRun }): Promise<ProcessInfo> {
    return this.serial(chatId, async () => {
      const chat = await this.openChat(chatId)
      const bad = commandError(req.command)
      if (bad) throw new Error(bad)
      if (req.name !== undefined && !isProcessName(req.name)) throw new Error(PROCESS_REFUSALS.name)
      let wake: ProcessWake | null = null
      // A user's Run has its own end event: a notify rule would wake the agent twice.
      if (req.notify !== undefined && !opts?.run) {
        const parsed = parseNotify(req.notify)
        if ('error' in parsed) throw new Error(parsed.error)
        wake = parsed.rule
      }
      const minutes = req.timeoutMinutes ?? PROCESS_LIFETIME_DEFAULT_MIN
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > PROCESS_LIFETIME_MAX_MIN)
        throw new Error(`timeoutMinutes must be a whole number from 1 to ${PROCESS_LIFETIME_MAX_MIN}.`)
      const cwd = await this.resolveCwd(chat.cwd, req.cwd)
      const mine = [...this.live.values()].filter((l) => l.rec.chatId === chatId)
      if (mine.length >= this.lim.perChat) throw new Error(PROCESS_REFUSALS.perChat)
      if (this.live.size >= this.lim.total) throw new Error(PROCESS_REFUSALS.total)
      const taken = new Set(mine.map((l) => l.rec.name))
      if (req.name !== undefined && taken.has(req.name))
        throw new Error(sameNameRunning(req.name, mine.find((l) => l.rec.name === req.name)!.rec.id))
      const now = this.now()
      const rec: StoredProcess = {
        id: newId(),
        chatId,
        name: req.name ?? deriveName(req.command, taken),
        command: req.command,
        cwd,
        startedBy: agent,
        startedAt: now,
        endedAt: null,
        state: 'running',
        exitCode: null,
        signal: null,
        stoppedBy: null,
        note: null,
        restarts: 0,
        until: now + minutes * 60_000,
        out: 0,
        wake,
        run: opts?.run ?? null,
        pid: null,
        bootId: null,
        startTicks: null,
        logBase: 0,
        lifetimeMs: minutes * 60_000
      }
      this.items.set(rec.id, rec)
      await this.launch(rec)
      await this.prune(chatId)
      return this.wire(rec)
    })
  }

  /** The user's Run of a block: a process of the block's author, with the message it came from. Every limit applies as to a start. */
  run(chatId: string, agent: string, messageId: string, command: string): Promise<ProcessInfo> {
    return this.start(chatId, agent, { command }, { run: { messageId } })
  }

  /** The user's Restart: the stored command in the stored folder, under the same id, with a fresh lifetime. */
  restart(chatId: string, id: string): Promise<ProcessInfo> {
    return this.serial(chatId, async () => {
      const rec = this.own(chatId, id)
      const chat = await this.openChat(chatId)
      // The folder may have gone (a removed worktree): checked as a start's would be.
      await this.resolveCwd(chat.cwd, rec.cwd)
      const old = this.live.get(id)
      if (old) {
        old.restarting = true
        await this.end(old, 'user')
      }
      const others = [...this.live.values()].filter((l) => l.rec.chatId === chatId)
      if (others.length >= this.lim.perChat) throw new Error(PROCESS_REFUSALS.perChat)
      if (this.live.size >= this.lim.total) throw new Error(PROCESS_REFUSALS.total)
      if (others.some((l) => l.rec.name === rec.name))
        throw new Error(sameNameRunning(rec.name, others.find((l) => l.rec.name === rec.name)!.rec.id))
      const now = this.now()
      Object.assign(rec, {
        startedAt: now,
        endedAt: null,
        state: 'running',
        exitCode: null,
        signal: null,
        stoppedBy: null,
        note: null,
        restarts: rec.restarts + 1,
        until: now + rec.lifetimeMs
      })
      // The user's restart is deliberate: the rule may fire again as many times as it first could.
      if (rec.wake) rec.wake = { ...rec.wake, fired: 0, note: null }
      await this.launch(rec, `\n--- restarted by the user ---\n`)
      return this.wire(rec)
    })
  }

  private async openChat(chatId: string): Promise<ProcessChat> {
    if (this.down) throw new Error(PROCESS_REFUSALS.down)
    if (!this.loaded) throw new Error(PROCESS_REFUSALS.down)
    if (this.removed.has(chatId)) throw new Error(PROCESS_REFUSALS.closed)
    const chat = await this.d.chat(chatId)
    if (!chat || chat.archived) throw new Error(PROCESS_REFUSALS.closed)
    return chat
  }

  /** The chat's folder, or `want` resolved against it; both through realpath, so neither `..` nor a link leaves it. */
  private async resolveCwd(chatCwd: string, want?: string): Promise<string> {
    let root: string
    try {
      root = await realpath(chatCwd)
    } catch {
      throw new Error(PROCESS_REFUSALS.cwd)
    }
    if (want === undefined || want === '' || want === '.') return root
    if (want.length > 4096 || want.includes('\0')) throw new Error(PROCESS_REFUSALS.cwd)
    let full: string
    try {
      full = await realpath(isAbsolute(want) ? want : resolve(root, want))
    } catch {
      throw new Error(PROCESS_REFUSALS.cwd)
    }
    if (!inside(root, full)) throw new Error(PROCESS_REFUSALS.cwd)
    try {
      if (!(await stat(full)).isDirectory()) throw new Error()
    } catch {
      throw new Error(PROCESS_REFUSALS.cwd)
    }
    return full
  }

  private async launch(rec: StoredProcess, marker?: string): Promise<void> {
    await mkdir(this.chatDir(rec.chatId), { recursive: true, mode: 0o700 })
    const output = await ProcessOutput.open(this.filesOf(rec), rec.logBase, {
      ringBytes: this.lim.ringBytes,
      fileBytes: this.lim.fileBytes,
      onRotate: (base) => {
        rec.logBase = base
        void this.save()
      },
      onError: (code) => console.error('process log not written:', rec.id, code)
    })
    if (marker && output.end > 0) output.push(Buffer.from(marker))
    const env = processEnv(await this.d.env())
    // Windows: what the command starts carries its id, so Stop finds the `&` jobs taskkill /T cannot (processTree.ts).
    if (process.platform === 'win32') env[PROCESS_TAG_ENV] = rec.id
    let child: ChildProcess
    try {
      // The agent's command is the only shell text: bash -c runs it as given, in a group of its own so the whole tree can be ended.
      child = spawn(this.d.shell ?? defaultBash(env), ['-c', rec.command], {
        cwd: rec.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      await output.close()
      Object.assign(rec, { state: 'failed', endedAt: this.now(), note: errCode(err), out: output.end })
      console.error('process spawn failed:', rec.id, errCode(err))
      await this.save()
      this.changed(rec.chatId)
      this.raiseRunEnd(rec, { end: null, outcome: 'error', error: errCode(err) }, '', false)
      return
    }
    let resolveExit!: () => void
    const live: Live = {
      rec,
      child,
      output,
      stopping: null,
      exited: new Promise<void>((r) => {
        resolveExit = r
      }),
      partial: '',
      partialTo: output.end,
      lineListeners: new Set(),
      exitListeners: new Set(),
      lifetime: null,
      outputTimer: null,
      decoder: new TextDecoder(),
      from: output.end
    }
    this.live.set(rec.id, live)
    const onData = (chunk: Buffer) => this.onData(live, chunk)
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
    let settled = false
    const ended = (code: number | null, signal: NodeJS.Signals | null, failCode?: string) => {
      if (settled) return
      settled = true
      void this.onExit(live, code, signal, failCode).finally(resolveExit)
    }
    child.on('error', (err) => ended(null, null, errCode(err)))
    child.on('exit', (code, signal) => ended(code, signal))
    if (child.pid !== undefined) {
      rec.pid = child.pid
      rec.bootId = await bootId()
      rec.startTicks = (await procIdentity(child.pid))?.startTicks ?? null
    }
    const left = rec.until - this.now()
    live.lifetime = setTimeout(
      () => {
        void this.stopLive(rec.id, 'lifetime')
      },
      Math.max(0, left)
    )
    live.lifetime.unref()
    await this.save()
    this.changed(rec.chatId)
  }

  private onData(live: Live, chunk: Buffer): void {
    live.output.push(chunk)
    // Lines for wait (and Phase 3's notify): cleaned text, each with the cursor just after it.
    const text = live.decoder.decode(chunk, { stream: true })
    const parts = cleanOutput(live.partial + text).split('\n')
    live.partial = parts.pop() ?? ''
    if (live.partial.length > 64 * 1024) live.partial = live.partial.slice(-64 * 1024)
    if (parts.length > 0 && live.lineListeners.size > 0)
      for (const line of parts) for (const l of [...live.lineListeners]) l({ line, to: live.output.end })
    // Read per line: raise() replaces the rule with its count moved on, so a burst of matches in one chunk stops at `times`.
    if (live.rec.wake?.on === 'match')
      for (const line of parts) {
        const w = live.rec.wake
        if (w && w.fired < w.times && lineMatches(line, w.patterns)) this.raise(live.rec, 'match', cutLines(line))
      }
    if (!live.outputTimer) {
      live.outputTimer = setTimeout(() => {
        live.outputTimer = null
        this.d.push({ kind: 'output', chatId: live.rec.chatId, id: live.rec.id, to: live.output.end })
      }, this.lim.outputEventMs)
      live.outputTimer.unref()
    }
  }

  private async onExit(live: Live, code: number | null, signal: NodeJS.Signals | null, failCode?: string): Promise<void> {
    const { rec } = live
    if (live.lifetime) clearTimeout(live.lifetime)
    // What the leader left in its group goes too, so nothing the panel cannot show stays behind.
    if (rec.pid !== null) await endTree(rec.pid, { graceMs: this.lim.graceMs, killWaitMs: this.lim.killWaitMs, tag: rec.id })
    // 'exit' can come before the pipes are read to their end (on Windows nearly always, where endTree returns at once):
    // let them drain first, or the last of the output is lost. Not for long: a grandchild that left the group may still
    // hold them, so after that they are dropped, not waited for.
    await drained([live.child.stdout, live.child.stderr], PIPE_DRAIN_MS)
    live.child.stdout?.destroy()
    live.child.stderr?.destroy()
    const tail = live.decoder.decode()
    if (live.partial + tail !== '')
      for (const l of [...live.lineListeners]) l({ line: cleanOutput(live.partial + tail), to: live.output.end })
    live.partial = ''
    if (live.outputTimer) {
      clearTimeout(live.outputTimer)
      live.outputTimer = null
    }
    await live.output.close()
    this.live.delete(rec.id)
    const stopped = live.stopping
    Object.assign(rec, {
      state: failCode ? 'failed' : stopped ? 'stopped' : 'exited',
      endedAt: this.now(),
      exitCode: stopped || failCode ? null : code,
      signal: stopped || failCode ? null : signal,
      stoppedBy: stopped,
      note: failCode ?? null,
      out: live.output.end,
      pid: null
    })
    if (failCode) console.error('process spawn failed:', rec.id, failCode)
    // Read before any await: a Restart landing during the save below resets these fields and appends to the stream.
    const runEnd = rec.run
      ? {
          ending: runEnding(rec, stopped, live.restarting === true, failCode),
          span: { startedAt: rec.startedAt, endedAt: rec.endedAt ?? this.now() },
          from: live.from,
          to: live.output.end
        }
      : null
    // Only a natural end raises an exit event: anyone's stop never does, nor a spawn that failed.
    if (!stopped && !failCode && rec.wake && rec.wake.fired < rec.wake.times && exitFires(rec.wake.on, rec.exitCode, rec.signal))
      this.raise(rec, 'exit', null)
    for (const l of [...live.exitListeners]) l()
    this.d.push({ kind: 'output', chatId: rec.chatId, id: rec.id, to: live.output.end })
    await this.save()
    this.changed(rec.chatId)
    if (runEnd) {
      const tail = runEnd.ending.end ? await this.runTailOf(rec, runEnd.from, runEnd.to) : { text: '', cut: false }
      this.raiseRunEnd(rec, runEnd.ending, tail.text, tail.cut, runEnd.span)
    }
  }

  /**
   * Hands a run's end on. A listener that throws never breaks the end of the process, and the log holds a code and an id
   * only. `span`: the run's times as its end recorded them, which a Restart since may have reset on the record.
   */
  private raiseRunEnd(
    rec: StoredProcess,
    ending: { end: RunEnd | null; outcome: RunEndEvent['outcome']; error: string | null },
    output: string,
    cut: boolean,
    span: { startedAt: number; endedAt: number } = { startedAt: rec.startedAt, endedAt: rec.endedAt ?? this.now() }
  ): void {
    if (!rec.run || !this.d.onRunEnd) return
    try {
      this.d.onRunEnd({
        chatId: rec.chatId,
        id: rec.id,
        messageId: rec.run.messageId,
        command: scrubText(rec.command, this.scrubFor(rec)),
        cwd: rec.cwd,
        agent: rec.startedBy,
        ...span,
        ...ending,
        output,
        cut
      })
    } catch {
      console.error('process run end not raised:', rec.id)
    }
  }

  /**
   * The tail of one run's output, bytes [runFrom, runTo), for its result: cleaned, scrubbed, cut, at most RUN_OUTPUT_MAX
   * bytes from a line start.
   */
  private async runTailOf(rec: StoredProcess, runFrom: number, runTo: number): Promise<{ text: string; cut: boolean }> {
    let out: ProcessOutput | null = null
    try {
      out = await this.outputOf(rec)
      // Only this run's bytes: a Restart appends to the same stream, also while this one's end is still being saved.
      const start = Math.max(runFrom, runTo - RUN_OUTPUT_MAX * 4)
      const got = await out.read(start, Math.max(0, runTo - start))
      // Scrubbed before the long lines are cut: a secret across the cut would leave its prefix.
      let text = cutLines(scrubText(cleanOutput(got.bytes.toString('utf8')), this.scrubFor(rec)), 2000)
      // The window (or a rotated log) may start inside a line: that first line is partial and goes.
      let cut = got.from > runFrom
      if (cut) text = text.replace(/^[^\n]*\n/, '')
      if (Buffer.byteLength(text) > RUN_OUTPUT_MAX) {
        text = Buffer.from(text)
          .subarray(-RUN_OUTPUT_MAX)
          .toString('utf8')
          .replace(/^[^\n]*\n/, '')
        cut = true
      }
      return { text, cut }
    } catch {
      console.error('process run output not read:', rec.id)
      return { text: '', cut: false }
    } finally {
      if (out && !this.live.has(rec.id)) await out.close()
    }
  }

  // ---- wake-ups ----

  /** Counts the event against the rule at once (so a burst of matching lines cannot pass `times`), then hands it on with its tail. */
  private raise(rec: StoredProcess, kind: 'exit' | 'match', line: string | null): void {
    if (!rec.wake || !this.d.onWake) return
    rec.wake = { ...rec.wake, fired: rec.wake.fired + 1 }
    void this.save()
    const at = this.now()
    void this.tailOf(rec)
      .then((tail) => {
        const scrub = this.scrubFor(rec)
        this.d.onWake?.({
          chatId: rec.chatId,
          id: rec.id,
          name: rec.name,
          startedBy: rec.startedBy,
          kind,
          exitCode: kind === 'exit' ? rec.exitCode : null,
          signal: kind === 'exit' ? rec.signal : null,
          line: line === null ? null : scrubText(line, scrub),
          tail,
          at
        })
      })
      .catch(() => console.error('process wake not raised:', rec.id))
  }

  /** The last lines of the output for a wake message: cleaned, cut, scrubbed with the starter's vault values. */
  private async tailOf(rec: StoredProcess): Promise<string> {
    const out = await this.outputOf(rec)
    try {
      const got = await out.tail(WAKE_TAIL_BYTES * 4)
      let text = tailLines(cutLines(cleanOutput(got.bytes.toString('utf8')), 300), WAKE_TAIL_LINES)
      if (Buffer.byteLength(text) > WAKE_TAIL_BYTES)
        text = Buffer.from(text)
          .subarray(-WAKE_TAIL_BYTES)
          .toString('utf8')
          .replace(/^[^\n]*\n/, '')
      return scrubText(text, this.scrubFor(rec))
    } finally {
      if (!this.live.has(rec.id)) await out.close()
    }
  }

  /** Why a raised event woke nobody (a cap, a closed chat): shown on the process's row. */
  async noteWake(id: string, note: string): Promise<void> {
    const rec = this.items.get(id)
    if (!rec?.wake) return
    rec.wake = { ...rec.wake, note }
    await this.save()
    this.changed(rec.chatId)
  }

  /** The rule's note cleared once a wake-up went out for it. */
  async wakeSent(id: string): Promise<void> {
    const rec = this.items.get(id)
    if (!rec?.wake || rec.wake.note === null) return
    rec.wake = { ...rec.wake, note: null }
    await this.save()
    this.changed(rec.chatId)
  }

  // ---- ending ----

  private async end(live: Live, by: ProcessStoppedBy): Promise<void> {
    live.stopping ??= by
    if (live.rec.pid !== null) await endTree(live.rec.pid, { graceMs: this.lim.graceMs, killWaitMs: this.lim.killWaitMs, tag: live.rec.id })
    else live.child.kill('SIGKILL')
    await live.exited
  }

  private async stopLive(id: string, by: ProcessStoppedBy): Promise<void> {
    const live = this.live.get(id)
    if (live) await this.end(live, by)
  }

  /** Ends one process of the chat (the agent's stop or the user's). */
  stop(chatId: string, id: string, by: 'agent' | 'user'): Promise<ProcessInfo> {
    return this.serial(chatId, async () => {
      const rec = this.own(chatId, id)
      const live = this.live.get(id)
      if (!live) {
        if (by === 'agent') throw new Error(PROCESS_REFUSALS.notRunning)
        return this.wire(rec)
      }
      await this.end(live, by)
      return this.wire(rec)
    })
  }

  /** Ends every process of a chat (archive, delete). Under the chat's lock, so a start racing it is either ended here or refused after. */
  endChat(chatId: string, by: 'archive' | 'remove'): Promise<number> {
    return this.serial(chatId, async () => {
      const mine = [...this.live.values()].filter((l) => l.rec.chatId === chatId)
      await Promise.all(mine.map((l) => this.end(l, by)))
      return mine.length
    })
  }

  /** A deleted chat: its processes end, then its records and logs go. */
  async removeChat(chatId: string): Promise<void> {
    // For good: chat ids are never reused, and a late bridge call for a deleted chat must be refused.
    this.removed.add(chatId)
    await this.endChat(chatId, 'remove')
    await this.serial(chatId, async () => {
      const had = [...this.items.values()].some((r) => r.chatId === chatId)
      for (const [id, r] of this.items) if (r.chatId === chatId) this.items.delete(id)
      await rm(this.chatDir(chatId), { recursive: true, force: true })
      if (!had) return
      await this.save()
      this.changed(chatId)
    })
  }

  /** Removes an ended record and its log. */
  forget(chatId: string, id: string): Promise<void> {
    return this.serial(chatId, async () => {
      const rec = this.own(chatId, id)
      if (this.live.has(id)) throw new Error('Stop the process before forgetting it.')
      this.items.delete(id)
      await ProcessOutput.remove(this.filesOf(rec))
      await this.save()
      this.changed(chatId)
    })
  }

  /** Server stop: no new start, every tree ended, each record written `stopped` before the server exits. */
  async shutdown(): Promise<void> {
    this.down = true
    await Promise.allSettled([...this.live.values()].map((l) => this.end(l, 'shutdown')))
    await this.save()
    await this.writeQueue
  }

  async renameAgent(from: string, to: string): Promise<void> {
    const chats = new Set<string>()
    for (const r of this.items.values())
      if (r.startedBy === from) {
        r.startedBy = to
        chats.add(r.chatId)
      }
    if (chats.size === 0) return
    await this.save()
    for (const chatId of chats) this.changed(chatId)
  }

  // ---- the agent's tools ----

  async agentStart(chatId: string, agent: string, req: StartRequest): Promise<string> {
    const p = await this.start(chatId, agent, req)
    if (p.state === 'failed') return `"${p.name}" (${p.id}) failed to start${p.note ? ` (${p.note})` : ''}.`
    const chat = await this.d.chat(chatId)
    const where = chat ? this.relCwd(chat.cwd, p.cwd) : p.cwd
    const w = p.wake
    const wake =
      w === null
        ? ''
        : `\nYou will get a message in this chat ${w.on === 'match' ? 'when a line holds one of its patterns' : w.on === 'fail' ? 'if it fails' : 'when it exits'} (at most ${w.times === 1 ? 'once' : `${w.times} times`}); a stop by anyone never sends one.`
    return `Started "${p.name}" (${p.id}) in ${where}: ${p.command}\nIt runs until it ends, is stopped, or ${spanText(p.until - p.startedAt)} pass. Call wait with patterns for its ready line, or logs to read its output.${wake}`
  }

  private relCwd(root: string, cwd: string): string {
    const r = relative(root, cwd)
    return r === '' ? 'the chat folder' : r.startsWith('..') ? cwd : `./${r}`
  }

  agentList(chatId: string): string {
    const all = this.list(chatId)
    if (all.length === 0) return 'No processes in this chat.'
    const now = this.now()
    return all
      .map((p) => {
        const cmd = p.command.length > 200 ? `${p.command.slice(0, 200)}…` : p.command
        const time = p.state === 'running' ? `up ${spanText(now - p.startedAt)}` : p.endedAt ? `${spanText(now - p.endedAt)} ago` : ''
        return `${p.id} "${p.name}": ${stateText(p)}${time ? `, ${time}` : ''}; started by ${p.startedBy}${p.run ? ' (run by the user from a block)' : ''}; ${cmd}`
      })
      .join('\n')
  }

  async agentLogs(chatId: string, args: { id: string; tail?: number; from?: number; grep?: string }): Promise<string> {
    const r = this.own(chatId, args.id)
    const out = await this.outputOf(r)
    try {
      const scrub = this.scrubFor(r)
      if (args.from !== undefined) {
        const got = await out.read(args.from, PROCESS_TOOL_TEXT_MAX)
        let text = cutLines(cleanOutput(got.bytes.toString('utf8')))
        if (args.grep)
          text = text
            .split('\n')
            .filter((l) => l.includes(args.grep!))
            .join('\n')
        const more = out.end - got.to
        return [
          got.dropped > 0 ? `[${got.dropped} bytes before this are no longer kept]` : '',
          scrubText(text, scrub) || '(no output in this range)',
          `[${stateText(r)}; next cursor ${got.to}${more > 0 ? `; ${more} more bytes after it` : ''}]`
        ]
          .filter(Boolean)
          .join('\n')
      }
      const n = Math.min(Math.max(1, args.tail ?? PROCESS_TAIL_DEFAULT), PROCESS_TAIL_MAX)
      // Twice the answer's size, so a grep still has lines to find; the answer itself is cut below.
      const got = await out.tail(PROCESS_TOOL_TEXT_MAX * (args.grep ? 4 : 2))
      let lines = cutLines(cleanOutput(got.bytes.toString('utf8')))
      if (args.grep)
        lines = lines
          .split('\n')
          .filter((l) => l.includes(args.grep!))
          .join('\n')
      let text = tailLines(lines, n)
      if (Buffer.byteLength(text) > PROCESS_TOOL_TEXT_MAX) text = Buffer.from(text).subarray(-PROCESS_TOOL_TEXT_MAX).toString('utf8')
      return `${scrubText(text, scrub) || '(no output yet)'}\n[${stateText(r)}; next cursor ${out.end}]`
    } finally {
      if (!this.live.has(r.id)) await out.close()
    }
  }

  /**
   * Blocks until a line after `from` holds one of `patterns`, the process ends, the timeout passes, or `signal` aborts (the bridge
   * went away). Without patterns it waits for the exit only.
   */
  async agentWait(
    chatId: string,
    args: { id: string; patterns?: string[]; timeoutSeconds?: number; from?: number },
    signal?: AbortSignal
  ): Promise<string> {
    const r = this.own(chatId, args.id)
    const patterns = args.patterns ?? []
    const seconds = Math.min(Math.max(1, args.timeoutSeconds ?? PROCESS_WAIT_DEFAULT_S), PROCESS_WAIT_MAX_S)
    const scrub = this.scrubFor(r)
    const tail = async () =>
      scrubText(tailLines(cutLines(cleanOutput((await (await this.outputOf(r)).tail(8192)).bytes.toString('utf8'))), 20), scrub)
    const live = this.live.get(r.id)
    const found = (line: string, to: number) => `Matched: ${scrubText(line, scrub)}\n[${stateText(r)}; cursor after the line ${to}]`
    if (!live) return `Not running: ${stateText(r)}.\nLast lines:\n${(await tail()) || '(no output)'}`
    let outcome: { kind: 'line'; line: WaitLine } | { kind: 'exit' } | { kind: 'timeout' } | { kind: 'abort' } | null = null
    const buffered: WaitLine[] = []
    let wake!: () => void
    const woken = new Promise<void>((res) => {
      wake = res
    })
    const onLine = (l: WaitLine) => {
      if (outcome) return
      if (patterns.length > 0 && lineMatches(l.line, patterns)) {
        outcome = { kind: 'line', line: l }
        wake()
      } else buffered.push(l)
      if (buffered.length > 1000) buffered.shift()
    }
    const onExit = () => {
      if (!outcome) {
        outcome = { kind: 'exit' }
        wake()
      }
    }
    const onAbort = () => {
      if (!outcome) {
        outcome = { kind: 'abort' }
        wake()
      }
    }
    live.lineListeners.add(onLine)
    live.exitListeners.add(onExit)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      if (!outcome) {
        outcome = { kind: 'timeout' }
        wake()
      }
    }, seconds * 1000)
    try {
      // Lines already out (a ready line printed before the call) count too: read what is kept after `from`.
      if (patterns.length > 0) {
        const from = Math.max(0, args.from ?? 0)
        const got = await live.output.read(from, 4 * 1024 * 1024)
        const lines = cleanOutput(got.bytes.toString('utf8')).split('\n')
        lines.pop() // unfinished: it arrives through onLine once whole
        const hit = lines.find((l) => lineMatches(l, patterns))
        if (hit !== undefined && !outcome) {
          outcome = { kind: 'line', line: { line: hit, to: got.to } }
          wake()
        }
      }
      if (signal?.aborted) onAbort()
      await woken
    } finally {
      clearTimeout(timer)
      live.lineListeners.delete(onLine)
      live.exitListeners.delete(onExit)
      signal?.removeEventListener('abort', onAbort)
    }
    const o = outcome as NonNullable<typeof outcome>
    if (o.kind === 'line') return found(cutLines(o.line.line), o.line.to)
    if (o.kind === 'abort') return 'Wait ended.'
    const last = await tail()
    if (o.kind === 'exit') return `It ended: ${stateText(r)}.\nLast lines:\n${last || '(no output)'}`
    return `Still ${stateText(r)} after ${seconds}s${patterns.length ? ' with no matching line' : ''}.\nLast lines:\n${last || '(no output yet)'}`
  }

  async agentStop(chatId: string, id: string): Promise<string> {
    const p = await this.stop(chatId, id, 'agent')
    return `"${p.name}" (${p.id}) ${stateText(p)}.`
  }

  // ---- bookkeeping ----

  private changed(chatId: string): void {
    this.d.push({ kind: 'changed', chatId, running: this.running(chatId) })
  }

  /** Keeps every running record and the newest endedKept ended ones per chat, and the logs of all within logsTotal. */
  private async prune(chatId: string): Promise<void> {
    const ended = [...this.items.values()]
      .filter((r) => r.chatId === chatId && !this.live.has(r.id))
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    const gone = ended.slice(this.lim.endedKept)
    // Over the total, the oldest ended records of any chat go first.
    const all = [...this.items.values()]
      .filter((r) => !this.live.has(r.id) && !gone.includes(r))
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    let total = 0
    const sizes = new Map<string, number>()
    for (const r of this.items.values()) {
      const f = this.filesOf(r)
      const s =
        (await stat(f.current).then(
          (x) => x.size,
          () => 0
        )) +
        (await stat(f.previous).then(
          (x) => x.size,
          () => 0
        ))
      sizes.set(r.id, s)
      total += s
    }
    for (const r of all) {
      if (total <= this.lim.logsTotal) break
      gone.push(r)
      total -= sizes.get(r.id) ?? 0
    }
    if (gone.length === 0) return
    for (const r of gone) {
      this.items.delete(r.id)
      await ProcessOutput.remove(this.filesOf(r))
    }
    await this.save()
  }

  private save(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      for (const l of this.live.values()) l.rec.out = l.output.end
      const file: IndexFile = { v: 1, items: [...this.items.values()] }
      try {
        await writeFileAtomic(join(this.root, INDEX), JSON.stringify(file), 0o600)
      } catch (err) {
        console.error('process index not written:', errCode(err))
      }
    })
    return this.writeQueue
  }

  private serial<T>(chatId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(chatId) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.catch(() => {})
    this.locks.set(chatId, tail)
    void tail.then(() => {
      if (this.locks.get(chatId) === tail) this.locks.delete(chatId)
    })
    return next
  }

  /** For tests: whether the group of a running process is still alive. */
  async aliveForTest(id: string): Promise<boolean> {
    const pid = this.live.get(id)?.rec.pid ?? this.items.get(id)?.pid
    return typeof pid === 'number' && (await groupAlive(pid, id))
  }
}

const PIPE_DRAIN_MS = 1000

/** Resolves once every stream has ended (or was never there), or after `ms`, whichever is first. */
function drained(
  streams: ((NodeJS.ReadableStream & { readableEnded?: boolean; destroyed?: boolean }) | null)[],
  ms: number
): Promise<void> {
  const open = streams.filter((s): s is NonNullable<typeof s> => !!s && !s.readableEnded && !s.destroyed)
  if (open.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    let left = open.length
    const timer = setTimeout(resolve, ms)
    timer.unref()
    for (const s of open)
      s.once('close', () => {
        if (--left === 0) {
          clearTimeout(timer)
          resolve()
        }
      })
  })
}

const STATES = new Set(['running', 'exited', 'stopped', 'lost', 'failed'])
const STOPPED = new Set(['agent', 'user', 'archive', 'remove', 'lifetime', 'shutdown'])
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const numOrNull = (v: unknown): v is number | null => v === null || num(v)

/** A lenient read: a record that does not parse is dropped, never the whole file. */
function parseIndex(v: unknown): IndexFile {
  const items: StoredProcess[] = []
  const list = (v as { items?: unknown } | null)?.items
  if (Array.isArray(list))
    for (const r of list as Record<string, unknown>[]) {
      if (!r || typeof r !== 'object') continue
      if (
        !str(r.id) ||
        !/^p_[0-9a-f]{10}$/.test(r.id) ||
        !str(r.chatId) ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(r.chatId) ||
        !str(r.name) ||
        !str(r.command) ||
        !str(r.cwd)
      )
        continue
      if (!str(r.startedBy) || !num(r.startedAt) || !numOrNull(r.endedAt) || !str(r.state) || !STATES.has(r.state)) continue
      items.push({
        id: r.id,
        chatId: r.chatId,
        name: r.name,
        command: r.command,
        cwd: r.cwd,
        startedBy: r.startedBy,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        state: r.state as StoredProcess['state'],
        exitCode: numOrNull(r.exitCode) ? r.exitCode : null,
        signal: str(r.signal) ? r.signal : null,
        stoppedBy: str(r.stoppedBy) && STOPPED.has(r.stoppedBy) ? (r.stoppedBy as ProcessStoppedBy) : null,
        note: str(r.note) ? r.note : null,
        restarts: num(r.restarts) ? r.restarts : 0,
        until: num(r.until) ? r.until : r.startedAt,
        out: num(r.out) ? r.out : 0,
        pid: num(r.pid) ? r.pid : null,
        bootId: str(r.bootId) ? r.bootId : null,
        startTicks: str(r.startTicks) ? r.startTicks : null,
        logBase: num(r.logBase) ? r.logBase : 0,
        lifetimeMs: num(r.lifetimeMs) ? r.lifetimeMs : PROCESS_LIFETIME_DEFAULT_MIN * 60_000,
        wake: parseWake(r.wake),
        run: parseRun(r.run)
      })
    }
  return { v: 1, items }
}

function parseRun(v: unknown): ProcessRun | null {
  const m = (v as { messageId?: unknown } | null)?.messageId
  return typeof v === 'object' && str(m) && m !== '' ? { messageId: m } : null
}

const STOP_ERROR: Record<ProcessStoppedBy, string> = {
  agent: 'stopped by the agent',
  user: 'stopped by the user',
  archive: 'stopped at archive',
  remove: 'stopped at remove',
  lifetime: 'stopped at its time limit',
  shutdown: 'stopped with the server'
}

/** How a run ended, as its event reports it. Only a natural end, the user's Stop and the time limit send the agent a message. */
function runEnding(
  rec: StoredProcess,
  stopped: ProcessStoppedBy | null,
  restarting: boolean,
  failCode?: string
): { end: RunEnd | null; outcome: RunEndEvent['outcome']; error: string | null } {
  if (failCode) return { end: null, outcome: 'error', error: failCode }
  if (stopped === 'user' && restarting) return { end: null, outcome: 'interrupted', error: 'restarted' }
  if (stopped === 'user' || stopped === 'lifetime')
    return { end: { kind: 'stopped', by: stopped }, outcome: 'interrupted', error: STOP_ERROR[stopped] }
  if (stopped) return { end: null, outcome: 'interrupted', error: STOP_ERROR[stopped] }
  if (rec.signal !== null) return { end: { kind: 'signal', signal: rec.signal }, outcome: 'error', error: rec.signal }
  const code = rec.exitCode ?? 0
  return { end: { kind: 'exit', code }, outcome: code === 0 ? 'ok' : 'error', error: code === 0 ? null : `exit code ${code}` }
}

function parseWake(v: unknown): ProcessWake | null {
  const w = v as Partial<ProcessWake> | null
  if (!w || typeof w !== 'object' || (w.on !== 'exit' && w.on !== 'fail' && w.on !== 'match')) return null
  if (!num(w.times) || !num(w.fired) || !Array.isArray(w.patterns) || !w.patterns.every(str)) return null
  return { on: w.on, patterns: w.patterns, times: w.times, fired: w.fired, note: str(w.note) ? w.note : null }
}
