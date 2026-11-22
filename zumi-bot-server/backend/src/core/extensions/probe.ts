import { spawn, type ChildProcess } from 'node:child_process'
import { EXT_TEXT, type LoadoutSection } from '@zumibot/shared/extensions'
import { LineSplitter } from '../chat/streamParser'
import { codexVersion } from '../codex/codexHookTrust'
import { CodexRpc, RpcError } from '../codex/codexRpc'
import { signalChildGroup } from '../procKill'

// Starts the CLI model-free, asks what it has loaded and ends it. The control requests are not a documented API, so every
// answer is kept raw here and read defensively by `toLoadout` (sanitize.ts), which drops everything that may hold a secret.

/** What each request answered, raw (Claude: the `response` object; Codex: the JSON-RPC `result`), or the fixed sentence why not. */
export interface ProbeAnswers {
  version: string | null
  mcp: unknown
  skills: unknown
  hooks: unknown
  errors: Partial<Record<'mcp' | 'skills' | 'hooks', string>>
}

interface ProbeOptions {
  bin: string
  folder: string
  env: NodeJS.ProcessEnv
  /** The whole probe, 30 s by default; sections still missing then carry `EXT_TEXT.timeout`. */
  deadlineMs?: number
  /** How long `mcp_status` is asked again while a server is still connecting, 15 s by default. */
  pendingMs?: number
  /** The pause between those asks, 500 ms by default. */
  pollMs?: number
  /** From SIGTERM to SIGKILL, 3 s by default. */
  killGraceMs?: number
  /** Ends the probe early, as its deadline does (the server stopping). */
  signal?: AbortSignal
}

export interface ClaudeProbeOptions extends ProbeOptions {
  agent: string | null
  /** The agent's own args (`buildAgentRunConfig`), after the probe's fixed ones. */
  args: string[]
}

type Section = 'mcp' | 'skills' | 'hooks'
const SECTIONS: Section[] = ['mcp', 'skills', 'hooks']
const LOADOUT_SECTION: Record<Section, LoadoutSection> = { mcp: 'servers', skills: 'skills', hooks: 'hooks' }

const DEADLINE_MS = 30_000
const PENDING_MS = 15_000
const POLL_MS = 500
const KILL_GRACE_MS = 3000
// After SIGKILL nothing may refuse to go; this only bounds a kernel that is slow to reap.
const KILL_WAIT_MS = 2000

type Outcome<T> = { ok: true; value: T } | { ok: false; why: 'error' | 'timeout' | 'exit' }

const obj = (v: unknown): Record<string, any> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null

/** What a protocol needs from a probe: ask, and learn that the process ended or the deadline passed. */
interface Dialect {
  onLine(line: string): void
  /** Starts the session; the value is the CLI version. */
  hello(): Promise<Outcome<string | null>>
  ask(section: Section): Promise<Outcome<unknown>>
  /** Whether to ask this section again: `previous` is its earlier answer in this probe, null for the first ask. */
  again(section: Section, value: unknown, previous: unknown): boolean
  /** One section after another, MCP first, instead of all at once. */
  readonly sequential: boolean
  /** Settles every open and later request with this reason. */
  end(why: 'timeout' | 'exit'): void
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

// ---- the process ----

class ProbeProc {
  private readonly child: ChildProcess
  readonly spawnFailed: boolean

  constructor(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, onLine: (line: string) => void, onEnd: () => void) {
    // Its own process group, so the whole tree (the CLI starts MCP servers) can be ended; stderr is never read.
    this.child = spawn(bin, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
    this.spawnFailed = this.child.pid === undefined
    const split = new LineSplitter()
    this.child.stdout?.setEncoding('utf8')
    this.child.stdout?.on('data', (c: string) => split.push(c).forEach(onLine))
    // EPIPE when the CLI dies early.
    this.child.stdin?.on('error', () => {})
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      split.flush().forEach(onLine)
      onEnd()
    }
    this.child.on('error', end)
    this.child.on('exit', end)
  }

  write(line: string): boolean {
    const stdin = this.child.stdin
    if (!stdin || stdin.destroyed || stdin.writableEnded) return false
    try {
      stdin.write(line)
    } catch {
      return false
    }
    return true
  }

  // Stdin closing ends a real session; the signals are for a CLI that is stuck or ignores that.
  async stop(graceMs: number): Promise<void> {
    const child = this.child
    try {
      child.stdin?.end()
    } catch {
      /* already closed */
    }
    if (child.pid === undefined) return
    const signal = (sig: NodeJS.Signals) => {
      try {
        signalChildGroup(child, sig)
      } catch {
        /* the group is gone */
      }
    }
    const alive = () => {
      try {
        signalChildGroup(child, 0)
        return true
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'EPERM'
      }
    }
    const goneWithin = async (ms: number) => {
      const until = Date.now() + ms
      while (alive()) {
        if (Date.now() >= until) return false
        await new Promise((r) => setTimeout(r, 20))
      }
      return true
    }
    signal('SIGTERM')
    if (await goneWithin(graceMs)) return
    signal('SIGKILL')
    await goneWithin(KILL_WAIT_MS)
  }
}

/** The fixed sentences of one CLI: a Codex probe's name Codex, never Claude Code. */
interface Texts {
  missing: string
  timeout: string
  unsupported: (section: LoadoutSection) => string
}
const CLAUDE_TEXTS: Texts = { missing: EXT_TEXT.cliMissing, timeout: EXT_TEXT.timeout, unsupported: EXT_TEXT.unsupported }
const CODEX_TEXTS: Texts = { missing: EXT_TEXT.codexMissing, timeout: EXT_TEXT.codexTimeout, unsupported: EXT_TEXT.codexUnsupported }

async function runProbe(
  o: ProbeOptions,
  args: string[],
  makeDialect: (write: (line: string) => boolean) => Dialect,
  texts: Texts
): Promise<ProbeAnswers> {
  const out: ProbeAnswers = { version: null, mcp: null, skills: null, hooks: null, errors: {} }
  let proc: ProbeProc | null = null
  const dialect = makeDialect((line) => proc?.write(line) ?? false)
  proc = new ProbeProc(
    o.bin,
    args,
    o.folder,
    o.env,
    (line) => dialect.onLine(line),
    () => dialect.end('exit')
  )
  if (proc.spawnFailed) {
    for (const s of SECTIONS) out.errors[s] = texts.missing
    return out
  }
  const over = new AbortController()
  const finish = (why: 'timeout' | 'exit') => {
    dialect.end(why)
    over.abort()
  }
  const deadline = setTimeout(() => finish('timeout'), o.deadlineMs ?? DEADLINE_MS)
  const abort = () => finish('timeout')
  if (o.signal?.aborted) abort()
  else o.signal?.addEventListener('abort', abort, { once: true })
  try {
    const hello = await dialect.hello()
    if (hello.ok) out.version = hello.value
    const collect = async (s: Section) => {
      const r = await settle(dialect, s, o.pendingMs ?? PENDING_MS, o.pollMs ?? POLL_MS, over.signal)
      if (r.ok) out[s] = r.value
      // A CLI that answers with an error, or ends without answering, does not report this section.
      else out.errors[s] = r.why === 'timeout' ? texts.timeout : texts.unsupported(LOADOUT_SECTION[s])
    }
    if (dialect.sequential) for (const s of SECTIONS) await collect(s)
    else await Promise.all(SECTIONS.map(collect))
  } finally {
    clearTimeout(deadline)
    o.signal?.removeEventListener('abort', abort)
    over.abort()
    await proc.stop(o.killGraceMs ?? KILL_GRACE_MS)
  }
  return out
}

// Servers connect in the background: ask at once, then again while the dialect says the answer is still settling (a server
// `pending`); the last answer is the one kept, also when a later ask fails or time runs out.
async function settle(d: Dialect, section: Section, pendingMs: number, pollMs: number, signal: AbortSignal): Promise<Outcome<unknown>> {
  const until = Date.now() + pendingMs
  let last: Outcome<unknown> | null = null
  for (;;) {
    const r = await d.ask(section)
    if (!r.ok) return last ?? r
    const previous = last?.ok ? last.value : null
    last = r
    if (!d.again(section, r.value, previous) || Date.now() >= until) return r
    await sleep(Math.min(pollMs, Math.max(0, until - Date.now())), signal)
  }
}

// ---- Claude: stream-json control requests ----

const CLAUDE_SUBTYPE: Record<Section, string> = { mcp: 'mcp_status', skills: 'get_skills_dialog', hooks: 'get_hooks_listing' }

function claudeDialect(write: (line: string) => boolean): Dialect {
  let next = 1
  let over: 'timeout' | 'exit' | null = null
  const open = new Map<string, (o: Outcome<unknown>) => void>()
  const request = (subtype: string): Promise<Outcome<unknown>> => {
    if (over) return Promise.resolve({ ok: false, why: over })
    const id = `r${next++}`
    return new Promise((resolve) => {
      open.set(id, resolve)
      if (!write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } }) + '\n')) {
        open.delete(id)
        resolve({ ok: false, why: 'exit' })
      }
    })
  }
  return {
    // Everything else the CLI prints (hook and command lines, many `system` events) is not ours.
    onLine(line) {
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg?.type !== 'control_response') return
      const r = obj(msg.response)
      const settle = typeof r?.request_id === 'string' ? open.get(r.request_id) : undefined
      if (!r || !settle) return
      open.delete(r.request_id)
      settle(r.subtype === 'success' ? { ok: true, value: r.response ?? null } : { ok: false, why: 'error' })
    },
    async hello() {
      const r = await request('initialize')
      if (!r.ok) return r
      const v = obj(r.value)?.claude_code_version
      return { ok: true, value: typeof v === 'string' && v ? v.slice(0, 40) : null }
    },
    ask: (section) => request(CLAUDE_SUBTYPE[section]),
    again: (section, value) =>
      section === 'mcp' &&
      Array.isArray(obj(value)?.mcpServers) &&
      obj(value)!.mcpServers.some((s: unknown) => obj(s)?.status === 'pending'),
    sequential: false,
    end(why) {
      over ??= why
      const all = [...open.values()]
      open.clear()
      for (const settle of all) settle({ ok: false, why })
    }
  }
}

/**
 * Runs `claude -p` in `folder` (as `agent` when set), asks the version and the MCP, skills and hooks listings, and ends it.
 * No user message is ever sent, so the model is never called. A section that fails carries a fixed sentence in `errors`;
 * a CLI that cannot be started gives `cliMissing` for all three.
 */
export function probeClaude(o: ClaudeProbeOptions): Promise<ProbeAnswers> {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-prompt-tool',
    'stdio',
    ...(o.agent ? ['--agent', o.agent] : []),
    // No session log for a session that never takes a turn.
    '--no-session-persistence',
    ...o.args
  ]
  return runProbe(o, args, claudeDialect, CLAUDE_TEXTS)
}

// ---- Codex: JSON-RPC over `app-server` ----

const CODEX_CLIENT = { name: 'zumibot', title: null, version: '1.0.0' }
// A server list this long is not a list a person reads; it only bounds a server that never ends its pages.
const CODEX_MCP_PAGES = 10

const skillCount = (answer: unknown): number =>
  (Array.isArray(obj(answer)?.data) ? (obj(answer)!.data as unknown[]) : []).reduce<number>(
    (n, f) => n + (Array.isArray(obj(f)?.skills) ? obj(f)!.skills.length : 0),
    0
  )

function codexDialect(folder: string) {
  return (write: (line: string) => boolean): Dialect => {
    const rpc = new CodexRpc(write)
    let over: 'timeout' | 'exit' | null = null
    const call = async (method: string, params: unknown): Promise<Outcome<unknown>> => {
      if (over) return { ok: false, why: over }
      try {
        return { ok: true, value: await rpc.request<unknown>(method, params) }
      } catch (e) {
        // An error answer is the server's; a closed channel is this probe ending it.
        return { ok: false, why: e instanceof RpcError ? 'error' : (over ?? 'exit') }
      }
    }
    return {
      // Notifications and requests the server sends are not ours to answer: a model-free app-server sends none we need.
      onLine: (line) => void rpc.receive(line),
      async hello() {
        const r = await call('initialize', { clientInfo: CODEX_CLIENT })
        if (!r.ok) return r
        rpc.notify('initialized')
        return { ok: true, value: codexVersion(obj(r.value)?.userAgent) }
      },
      async ask(section) {
        if (section === 'skills') return call('skills/list', { cwds: [folder] })
        if (section === 'hooks') return call('hooks/list', { cwds: [folder] })
        // The server list comes in pages; the first page's answer is kept with every page's rows.
        const data: unknown[] = []
        let cursor: string | null = null
        for (let page = 0; page < CODEX_MCP_PAGES; page++) {
          const r = await call('mcpServerStatus/list', cursor ? { cursor } : {})
          if (!r.ok) return page === 0 ? r : { ok: true, value: { data, nextCursor: cursor } }
          const rows = obj(r.value)?.data
          if (!Array.isArray(rows)) return page === 0 ? r : { ok: true, value: { data, nextCursor: cursor } }
          data.push(...rows)
          const more = obj(r.value)?.nextCursor
          if (typeof more !== 'string' || !more) return { ok: true, value: { data, nextCursor: null } }
          cursor = more
        }
        return { ok: true, value: { data, nextCursor: cursor } }
      },
      again(section, value, previous) {
        // `notStarted` is not waited for: a server started lazily would keep every probe waiting.
        if (section === 'mcp')
          return Array.isArray(obj(value)?.data) && obj(value)!.data.some((s: unknown) => obj(s)?.runtimeStatus === 'starting')
        // Right after `initialize` (codex 0.164.0) `skills/list` holds only the built-in skills; the plugins' come a moment later,
        // so it is asked until two answers in a row have as many skills.
        if (section === 'skills') return previous === null || skillCount(value) !== skillCount(previous)
        return false
      },
      // The server list is slow and the plugin skills are there once it answered, so it goes first (see `again`).
      sequential: true,
      end(why) {
        over ??= why
        rpc.close(new Error(why))
      }
    }
  }
}

/**
 * Starts `codex app-server --listen stdio://` in `folder` (no thread, no model), asks `mcpServerStatus/list`, `skills/list`
 * and `hooks/list`, and ends it. Same contract as `probeClaude`.
 */
export function probeCodex(o: ProbeOptions): Promise<ProbeAnswers> {
  return runProbe(o, ['app-server', '--listen', 'stdio://'], codexDialect(o.folder), CODEX_TEXTS)
}
