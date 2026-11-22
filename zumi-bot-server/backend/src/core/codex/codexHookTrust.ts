import { spawn, type ChildProcess } from 'node:child_process'
import { LineSplitter } from '../chat/streamParser'
import { hookConfig, type CodexHook } from './codexParams'
import { CodexRpc } from './codexRpc'

// Probe check 11: a `-c` hook runs only once `-c hooks.state` trusts it by the hash codex itself reports, which is not a plain
// sha256 of anything obvious. So the hash is read from `hooks/list` of a process started with the same hook arguments; that
// process starts no thread or model, so it costs no quota.

/** How long a hook listing may take, the pre-flight's and a run's own; past it the hooks count as untrusted. */
export const HOOKS_TIMEOUT_MS = 15_000
// Only names the client; codex echoes it in its userAgent.
const CLIENT_INFO = { name: 'zumibot', title: null, version: '1.0.0' }

type Obj = Record<string, any>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)

/** A hook set's trust table (key to `currentHash`) and the codex version that reported it. */
export interface HookTrust {
  version: string | null
  trust: ReadonlyMap<string, string>
}

// 'zumibot/0.164.0 (Ubuntu 24.4.0; x86_64) ...' -> '0.164.0': the text after the first '/', up to a space.
export function codexVersion(userAgent: unknown): string | null {
  if (typeof userAgent !== 'string') return null
  const i = userAgent.indexOf('/')
  return i < 0 ? null : userAgent.slice(i + 1).split(/\s/)[0] || null
}

/**
 * The `hooks/list` entries that are these hooks: `sessionFlags` (the `-c` source, which only ZumiBot's arguments fill) and
 * a `preToolUse` command equal to one of them, each entry used once, so two hooks with one command need two entries. Null
 * when one is missing. User and project hooks are never read.
 */
function entriesOf(listed: unknown, hooks: CodexHook[]): Obj[] | null {
  const data = obj(listed)?.data
  const first = Array.isArray(data) ? obj(data[0]) : null
  const pool = (Array.isArray(first?.hooks) ? first.hooks : [])
    .map(obj)
    .filter((h: Obj | null): h is Obj => h?.source === 'sessionFlags' && h.eventName === 'preToolUse' && typeof h.command === 'string')
  const found: Obj[] = []
  for (const hook of hooks) {
    const i = pool.findIndex((h: Obj) => h.command === hook.command)
    if (i < 0) return null
    found.push(pool.splice(i, 1)[0])
  }
  return found
}

/** The trust table a `hooks/list` answer gives for these hooks, or null when one of them is missing from it. */
export function trustTable(listed: unknown, hooks: CodexHook[]): Map<string, string> | null {
  const found = entriesOf(listed, hooks)
  if (!found?.length) return null
  const table = new Map<string, string>()
  for (const h of found) {
    if (typeof h.key !== 'string' || typeof h.currentHash !== 'string' || !h.key || !h.currentHash) return null
    table.set(h.key, h.currentHash)
  }
  return table
}

/**
 * Whether every one of these hooks is listed, enabled and `trusted`: an untrusted one is skipped silently, so this fails
 * closed, and no hooks at all is never "all trusted".
 */
export function hooksTrusted(listed: unknown, hooks: CodexHook[]): boolean {
  const found = entriesOf(listed, hooks)
  return (
    hooks.length > 0 && !!found && found.length === hooks.length && found.every((h) => h.trustStatus === 'trusted' && h.enabled !== false)
  )
}

// Per exact hook arguments; the version a run reads at initialize must match, or the entry is dropped (see runCodex).
const cache = new Map<string, HookTrust>()
const inflight = new Map<string, Promise<HookTrust | null>>()
const keyOf = (bin: string, args: string[]) => JSON.stringify([bin, args])

/** Forgets a hook set's trust, so the next run asks codex again. */
export function dropHookTrust(bin: string, hooks: CodexHook[]): void {
  cache.delete(keyOf(bin, hookConfig(hooks)))
}

/**
 * The trust of a hook set: cached, else from a model-free app-server started with the same `-c hooks.PreToolUse` arguments
 * (`initialize`, then `hooks/list`). Calls made together share one process, which keeps its own deadline (`timeoutMs`, default
 * HOOKS_TIMEOUT_MS) and is killed at the end whoever still waits; `fresh` drops the cached entry first. Null on any failure
 * (hooks that cannot be encoded, no codex, no `hooks/list`, a hook missing from the list, the deadline), which is not kept.
 */
export async function hookTrustFor(o: {
  bin: string
  env?: NodeJS.ProcessEnv
  cwd: string
  hooks: CodexHook[]
  fresh?: boolean
  timeoutMs?: number
}): Promise<HookTrust | null> {
  const args = hookConfig(o.hooks)
  if (!args.length) return null
  const key = keyOf(o.bin, args)
  if (o.fresh) cache.delete(key)
  const hit = cache.get(key)
  if (hit) return hit
  let run = inflight.get(key)
  if (!run) {
    run = listTrust({ ...o, args })
      .then((t) => {
        if (t) cache.set(key, t)
        return t
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, run)
  }
  return run
}

/** `hookTrustFor`'s table alone: hook key to the `currentHash` codex reports for it, or null. */
export async function codexHookTrust(o: {
  bin: string
  env?: NodeJS.ProcessEnv
  cwd: string
  hooks: CodexHook[]
  fresh?: boolean
  timeoutMs?: number
}): Promise<Map<string, string> | null> {
  const t = await hookTrustFor(o)
  return t ? new Map(t.trust) : null
}

function listTrust(o: {
  bin: string
  env?: NodeJS.ProcessEnv
  cwd: string
  hooks: CodexHook[]
  args: string[]
  timeoutMs?: number
}): Promise<HookTrust | null> {
  return new Promise((resolve) => {
    let child: ChildProcess | null = null
    let done = false
    const rpc = new CodexRpc((line) => {
      const inp = child?.stdin
      if (!inp || inp.destroyed || inp.writableEnded) return false
      inp.write(line)
      return true
    })
    const finish = (t: HookTrust | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      rpc.close(new Error('Codex hook listing ended'))
      try {
        child?.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve(t)
    }
    const timer = setTimeout(() => finish(null), o.timeoutMs ?? HOOKS_TIMEOUT_MS)
    try {
      // The same hook arguments as the run, so the keys and hashes are the run's. multi_agent stays off even for a run with
      // subagents: this process starts no thread, and a hook's hash follows only its event, matcher, command and timeout (probe
      // check 11). The run's own hooks/list check still catches a table that does not hold.
      child = spawn(o.bin, ['app-server', '--listen', 'stdio://', '--disable', 'multi_agent', ...o.args], {
        cwd: o.cwd,
        env: o.env ?? process.env,
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch {
      return finish(null)
    }
    child.on('error', () => finish(null))
    child.on('exit', () => finish(null))
    child.stdin!.on('error', () => {
      /* EPIPE when it dies early */
    })
    const split = new LineSplitter()
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (c: string) => {
      for (const l of split.push(c)) rpc.receive(l)
    })
    void (async () => {
      const init = await rpc.request<{ userAgent?: unknown } | null>('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
      rpc.notify('initialized')
      const listed = await rpc.request('hooks/list', { cwds: [o.cwd] })
      const trust = trustTable(listed, o.hooks)
      finish(trust ? { version: codexVersion(init?.userAgent), trust } : null)
    })().catch(() => finish(null))
  })
}
