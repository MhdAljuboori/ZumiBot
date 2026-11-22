import { spawn } from 'node:child_process'
import { EXT_TEXT, isServerName, type McpScope, type McpServerDef } from '@zumibot/shared/extensions'
import { signalChildGroup } from '../procKill'

// The CLI's own writes: `~/.claude.json` (MCP servers in user and local scope) and the plugin switches are rewritten by the CLI all
// the time, so a second writer would lose its changes. Nothing the CLI prints is passed on: errors are EXT_TEXT sentences, and the
// log gets the subcommand and the exit code only. argv is never logged: `mcp add-json` carries the server's env and header values
// there for as long as the command runs (the CLI takes no stdin for it; a documented limit).

interface CliBase {
  bin: string
  env: NodeJS.ProcessEnv
  /** One line per failure: the subcommand and the exit code, nothing else. */
  log?: (line: string) => void
  timeoutMs?: number
  /** From SIGTERM to SIGKILL after the timeout or an abort, 2 s by default (tests shorten it). */
  killGraceMs?: number
  /** Ends the run early, as its timeout does (the server stopping). */
  signal?: AbortSignal
}

const TIMEOUT_MS = 60_000
const KILL_GRACE_MS = 2000
// A plugin list is a few KiB; this only bounds a CLI that prints without end.
const OUT_MAX = 4 * 1024 * 1024

type Ran = { ok: true; out: string } | { ok: false; why: 'missing' | 'timeout' | 'exit'; code: number | null }

function run(
  bin: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; keepOut?: boolean; killGraceMs?: number; signal?: AbortSignal }
): Promise<Ran> {
  return new Promise((resolve) => {
    if (o.signal?.aborted) return resolve({ ok: false, why: 'timeout', code: null })
    // Its own process group, so a stuck CLI is ended with whatever it started; stderr is never read.
    const child = spawn(bin, args, { cwd: o.cwd, env: o.env, detached: true, stdio: ['ignore', o.keepOut ? 'pipe' : 'ignore', 'ignore'] })
    const chunks: Buffer[] = []
    let size = 0
    child.stdout?.on('data', (c: Buffer) => {
      if (size >= OUT_MAX) return
      size += c.length
      chunks.push(c)
    })
    let done = false
    let timedOut = false
    const grace = o.killGraceMs ?? KILL_GRACE_MS
    const kill = (sig: NodeJS.Signals) => {
      try {
        signalChildGroup(child, sig)
      } catch {
        /* the group is gone */
      }
    }
    const end = () => {
      if (timedOut || done) return
      timedOut = true
      kill('SIGTERM')
      setTimeout(() => {
        kill('SIGKILL')
        // `close` waits for every holder of stdout: a grandchild that left the group could hold it for good and pin the caller (a
        // probe slot, a write queue). The run is over once its own group is killed, so it ends here whatever still holds the pipe.
        setTimeout(() => {
          child.stdout?.destroy()
          finish({ ok: false, why: 'timeout', code: null })
        }, grace).unref()
      }, grace).unref()
    }
    const timer = setTimeout(end, o.timeoutMs ?? TIMEOUT_MS)
    o.signal?.addEventListener('abort', end, { once: true })
    const finish = (r: Ran) => {
      if (done) return
      done = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', end)
      resolve(r)
    }
    child.on('error', () => finish({ ok: false, why: 'missing', code: null }))
    child.on('close', (code) => {
      if (timedOut) finish({ ok: false, why: 'timeout', code })
      else if (code === 0) finish({ ok: true, out: Buffer.concat(chunks).toString('utf8') })
      else finish({ ok: false, why: 'exit', code })
    })
  })
}

const runOpts = (o: CliBase) => ({ env: o.env, timeoutMs: o.timeoutMs, killGraceMs: o.killGraceMs, signal: o.signal })

/** The fixed sentence for a failed run, after logging its exit code. */
function failed(r: Extract<Ran, { ok: false }>, what: string, log?: (line: string) => void): Error {
  if (r.why === 'missing') return new Error(EXT_TEXT.cliMissing)
  log?.(`claude ${what} ${r.why === 'timeout' ? 'timed out' : `exited ${r.code ?? 'by a signal'}`}`)
  return new Error(r.why === 'timeout' ? EXT_TEXT.timeout : EXT_TEXT.cliFailed)
}

// A positional starting with `-` would be read as a flag; the handlers refuse it first, this is the belt.
function serverName(name: string): string {
  if (!isServerName(name)) throw new Error(EXT_TEXT.badName)
  return name
}

// Plugins are the user's, so any folder will do; a project folder also shows the plugins installed for that project.
const cwdOf = (o: { cwd?: string; env: NodeJS.ProcessEnv }): string => o.cwd ?? o.env['HOME'] ?? process.cwd()

const PLUGIN_ID = /^[A-Za-z0-9_.:@+/-]{1,200}$/
function pluginId(id: string): string {
  if (!PLUGIN_ID.test(id) || id.startsWith('-')) throw new Error(EXT_TEXT.notFound)
  return id
}

/** `claude mcp add-json <name> <json> -s <scope>`, run in the folder (local scope is that folder's). */
export async function mcpAdd(
  o: CliBase & { folder: string; scope: Exclude<McpScope, 'project'>; name: string; def: McpServerDef }
): Promise<void> {
  const r = await run(o.bin, ['mcp', 'add-json', serverName(o.name), JSON.stringify(o.def), '-s', o.scope], {
    cwd: o.folder,
    ...runOpts(o)
  })
  if (!r.ok) throw failed(r, 'mcp add-json', o.log)
}

/** `claude mcp remove <name> -s <scope>`, run in the folder. */
export async function mcpRemove(o: CliBase & { folder: string; scope: Exclude<McpScope, 'project'>; name: string }): Promise<void> {
  const r = await run(o.bin, ['mcp', 'remove', serverName(o.name), '-s', o.scope], { cwd: o.folder, ...runOpts(o) })
  if (!r.ok) throw failed(r, 'mcp remove', o.log)
}

/** `claude plugin enable|disable <id>` (user scope). */
export async function pluginSet(o: CliBase & { id: string; enabled: boolean; cwd?: string }): Promise<void> {
  const verb = o.enabled ? 'enable' : 'disable'
  const r = await run(o.bin, ['plugin', verb, pluginId(o.id)], { cwd: cwdOf(o), ...runOpts(o) })
  if (!r.ok) throw failed(r, `plugin ${verb}`, o.log)
}

/**
 * `claude plugin list --json`, cut down to each plugin's id and switch: the real answer also carries the plugin's server configs,
 * which may hold env values. One id listed twice (user and project install) is on when either is. A shape it does not know is
 * `EXT_TEXT.unsupported('plugins')`.
 */
export async function pluginList(o: CliBase & { cwd?: string }): Promise<Array<{ id: string; enabled: boolean }>> {
  const r = await run(o.bin, ['plugin', 'list', '--json'], { cwd: cwdOf(o), ...runOpts(o), keepOut: true })
  if (!r.ok) throw failed(r, 'plugin list', o.log)
  let list: unknown
  try {
    list = JSON.parse(r.out)
  } catch {
    throw new Error(EXT_TEXT.unsupported('plugins'))
  }
  if (!Array.isArray(list)) throw new Error(EXT_TEXT.unsupported('plugins'))
  const out = new Map<string, boolean>()
  for (const e of list) {
    const id = e && typeof e === 'object' ? (e as Record<string, unknown>).id : undefined
    const enabled = e && typeof e === 'object' ? (e as Record<string, unknown>).enabled : undefined
    if (typeof id !== 'string' || !id || typeof enabled !== 'boolean') throw new Error(EXT_TEXT.unsupported('plugins'))
    out.set(id, (out.get(id) ?? false) || enabled)
  }
  return [...out].map(([id, enabled]) => ({ id, enabled }))
}
