import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACP_TEXT, type AcpAuthHint, type AcpTestInfo } from '@zumibot/shared/acp'
import { ACP_CLIENT_CAPABILITIES, ACP_CLIENT_INFO, ACP_MAX_LINE_BYTES, advertised, BoundedLines } from './acpRunner'
import { ACP_ERROR, AcpRpc, AcpRpcError } from './acpRpc'
import { ProcTree } from './procTree'
import { signalChildGroup } from '../procKill'

// Agent Studio's Test (agents:testAcp): the run's spawn and its `initialize`, and nothing after it. Never session/new or
// authenticate, so no model runs and nothing lands in the agent's own session store. See docs/architecture/protocol-engines.md.

export interface AcpProbeOptions {
  /** The launch's command as the file names it, for a terminal sign-in method's hint and the not-started sentence. */
  command: string
  /** The path to spawn (acpLocate's answer). */
  bin: string
  /** The launch's arguments. Never logged or put in an error. */
  args?: string[]
  /** The run env with the agent's sign-in keys. Every `ZUMIBOT_*` name is stripped here, as the runner does. */
  env: NodeJS.ProcessEnv
  /** The whole test's deadline (default 20 s). */
  timeoutMs?: number
  /** From SIGTERM to SIGKILL of the agent's tree (default 2 s). */
  killForceMs?: number
}

export type AcpProbeInfo = Omit<AcpTestInfo, 'caps' | 'hidden'>
export type AcpProbeResult = AcpProbeInfo | { error: string }

const TIMEOUT_MS = 20_000
const KILL_FORCE_MS = 2000
// An agent that exited may still have lines in its pipe; a child holding the pipe open must not hold the answer up.
const DRAIN_MS = 1000
const MALFORMED_MAX = 1000
const NAME_MAX = 80
const METHODS_MAX = 8
const HINT_ARGS_MAX = 16
const HINT_MAX = 300

type Obj = Record<string, any>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const cut = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, max) : null)

// Names, and for a terminal method the agent's own command with that method's arguments (the launch's are never shown).
function authHints(v: unknown, command: string): AcpAuthHint[] {
  const out: AcpAuthHint[] = []
  for (const m of Array.isArray(v) ? v : []) {
    const o = obj(m)
    const name = cut(o?.name, NAME_MAX) ?? cut(o?.id, NAME_MAX)
    if (o === null || name === null) continue
    const args = Array.isArray(o.args) ? o.args.filter((a: unknown): a is string => typeof a === 'string').slice(0, HINT_ARGS_MAX) : []
    out.push({ name, terminal: o.type === 'terminal' ? [command, ...args].join(' ').slice(0, HINT_MAX) : null })
  }
  return out.slice(0, METHODS_MAX)
}

// Read as the runner reads it, so the Test says what a run will do.
function infoOf(init: Obj, command: string): AcpProbeResult {
  if (init.protocolVersion !== 1) return { error: ACP_TEXT.protocol }
  const agent = obj(init.agentCapabilities) ?? {}
  const session = obj(agent.sessionCapabilities) ?? {}
  const info = obj(init.agentInfo)
  const name = cut(info?.name, NAME_MAX)
  return {
    agentInfo: name === null ? null : { name, title: cut(info?.title, NAME_MAX), version: cut(info?.version, 100) },
    protocolVersion: 1,
    loadSession: agent.loadSession === true,
    resume: advertised(session.resume),
    systemPrompt: advertised(session.systemPrompt),
    image: obj(agent.promptCapabilities)?.image === true,
    authMethods: authHints(init.authMethods, command)
  }
}

/** Starts the launch in a new empty folder, asks `initialize` and ends the agent's process tree; a fixed sentence on failure. */
export async function probeAcp(o: AcpProbeOptions): Promise<AcpProbeResult> {
  let cwd: string
  try {
    cwd = await mkdtemp(join(tmpdir(), 'zumibot-acp-test-'))
  } catch {
    return { error: ACP_TEXT.notStarted(o.command) }
  }
  try {
    return await initialize(o, cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {})
  }
}

function initialize(o: AcpProbeOptions, cwd: string): Promise<AcpProbeResult> {
  return new Promise<AcpProbeResult>((resolve) => {
    let child: ChildProcess | null = null
    // As the runner does: what runs below the agent, outside its group too, snapshotted before each signal.
    let tree: ProcTree | null = null
    let answer: AcpProbeResult | null = null
    let exited = false
    let resolved = false
    let force: NodeJS.Timeout | null = null
    let drain: NodeJS.Timeout | null = null
    // When the tree's SIGTERM went out: its SIGKILL comes the force grace after it.
    let termAt: number | null = null
    const forceMs = o.killForceMs ?? KILL_FORCE_MS
    const lines = new BoundedLines(ACP_MAX_LINE_BYTES)
    const rpc = new AcpRpc((line) => {
      const inp = child?.stdin
      if (!inp || inp.destroyed || inp.writableEnded) return false
      inp.write(line)
      return true
    })

    const snap = () => {
      try {
        tree?.snap()
      } catch {
        /* the group kill still runs */
      }
    }
    // As the runner does: each process of the tree once, then the agent's group unless reached already; once the agent is gone,
    // its group only through a member the tree verified.
    const group = (sig: NodeJS.Signals) => {
      const c = child
      const pid = c?.pid
      if (!c || pid === undefined) return
      let reached: ReadonlySet<number> = new Set()
      try {
        if (tree) reached = tree.signal(sig)
      } catch {
        /* the group kill still runs */
      }
      if (reached.has(pid) || (exited && tree?.sees)) return
      try {
        signalChildGroup(c, sig)
      } catch {
        /* ESRCH: the group is gone */
      }
    }
    const sigterm = () => {
      termAt = Date.now()
      group('SIGTERM')
    }
    // Resolves once the agent has exited (or never started, or was just killed), so its folder can go. What it left in its tree
    // gets the force grace after its SIGTERM to clean up, then SIGKILL, from a one-shot timer left ref'd (the answer does not
    // wait for it).
    const finish = () => {
      if (resolved) return
      resolved = true
      clearTimeout(deadline)
      if (force) clearTimeout(force)
      if (drain) clearTimeout(drain)
      snap()
      if (child?.pid !== undefined) {
        setTimeout(
          () => {
            snap()
            group('SIGKILL')
          },
          termAt === null ? 0 : Math.max(0, termAt + forceMs - Date.now())
        )
      }
      resolve(answer ?? { error: ACP_TEXT.testTimeout })
    }
    // The first answer wins; the agent's tree is then ended: a snapshot while the agent still runs (a child it leaves is
    // reparented once it exits), stdin closed, SIGTERM, SIGKILL after the grace.
    const end = (r: AcpProbeResult) => {
      if (answer !== null) return
      answer = r
      clearTimeout(deadline)
      rpc.close(new Error('The test ended'))
      if (!exited) snap()
      try {
        child?.stdin?.end()
      } catch {
        /* already closed */
      }
      if (exited || child?.pid === undefined) return finish()
      sigterm()
      force = setTimeout(() => {
        snap()
        group('SIGKILL')
        finish()
      }, forceMs)
    }
    const deadline = setTimeout(() => end({ error: ACP_TEXT.testTimeout }), o.timeoutMs ?? TIMEOUT_MS)

    try {
      const env = Object.fromEntries(Object.entries(o.env).filter(([k]) => !k.startsWith('ZUMIBOT_')))
      child = spawn(o.bin, o.args ?? [], { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      return end({ error: ACP_TEXT.notStarted(o.command) })
    }
    if (child.pid !== undefined) tree = new ProcTree(child.pid)
    const proc = child
    proc.on('error', () => end({ error: ACP_TEXT.notStarted(o.command) }))
    proc.stdin!.on('error', () => {
      /* EPIPE when the agent dies early */
    })
    proc.stdout!.setEncoding('utf8')
    const handle = (batch: string[]) => {
      for (const l of batch) {
        const m = rpc.receive(l)
        // Nothing past initialize is served: the agent gets its answer at once rather than waiting on one.
        if (m?.kind === 'request') rpc.respondError(m.id, ACP_ERROR.methodNotFound, 'Method not found')
      }
      if (lines.over || rpc.malformed > MALFORMED_MAX) end({ error: ACP_TEXT.unreadable })
    }
    proc.stdout!.on('data', (c: string) => {
      if (answer === null) handle(lines.push(c))
    })
    const stopped = (code: number | null, signal: NodeJS.Signals | null) => () => {
      if (answer === null) handle(lines.flush())
      // A reply read in that last flush settles a microtask later.
      setImmediate(() => end({ error: ACP_TEXT.stopped(code ?? signal) }))
    }
    proc.on('exit', (code, signal) => {
      exited = true
      if (answer !== null) return finish()
      // The agent is gone: what it left in its tree goes too, which lets the pipe close and its last lines arrive.
      snap()
      sigterm()
      const last = stopped(code, signal)
      proc.on('close', last)
      drain = setTimeout(last, DRAIN_MS)
    })

    rpc.request('initialize', { protocolVersion: 1, clientCapabilities: ACP_CLIENT_CAPABILITIES, clientInfo: ACP_CLIENT_INFO }).then(
      (res) => {
        const init = obj(res)
        end(init ? infoOf(init, o.command) : { error: ACP_TEXT.unreadable })
      },
      (e) => {
        // A closed pipe is explained by the exit (or the deadline); only the agent's own error answer is read, by code only.
        if (e instanceof AcpRpcError) end({ error: e.code === ACP_ERROR.authRequired ? ACP_TEXT.notSignedIn([]) : ACP_TEXT.testRefused })
      }
    )
  })
}
