import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { encodeUserMessage, type UserContent } from './controlProtocol'
import { LineSplitter, parseLine, type RunEvent } from './streamParser'
import { THINKING_DISPLAY_ARGS } from './thinkingDisplay'
import { claudeRunEnv } from './runEnv'
import type { Effort, RunMode, ServerMode } from '@zumibot/shared/chatRun'
import type { RunHandle, RunOutcome } from '../engines/engine'
import { killTree } from '../procKill'

/** The server-wide mode (Codex's two policies too); a single chat may start its process in its own (`RunMode`). */
export type PermissionMode = ServerMode

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const isObject = (v: Json | undefined): v is { [key: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v)
// Lists add up (allow/ask/deny rules, hooks per event), objects merge, and a later scalar wins.
function mergeJson(a: Json | undefined, b: Json): Json {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b.filter((x) => !a.some((y) => JSON.stringify(y) === JSON.stringify(x)))]
  if (isObject(a) && isObject(b)) {
    const out = { ...a }
    for (const [k, v] of Object.entries(b)) out[k] = mergeJson(out[k], v)
    return out
  }
  return b
}

/**
 * Several inline-JSON values of one repeated flag as one value. A lone value is returned exactly as it was, so a `@file` path
 * is never parsed; two or more must each be inline JSON objects. Also used by the SDK adapter, which can pass a flag only once.
 */
export function mergeInlineJson(values: readonly string[], flag: string): string {
  if (values.length === 1) return values[0]
  let merged: Json = {}
  for (const value of values) {
    let parsed: Json
    try {
      parsed = JSON.parse(value) as Json
    } catch {
      parsed = null
    }
    if (!isObject(parsed)) throw new Error(`Only inline JSON ${flag} can be combined`)
    merged = mergeJson(merged, parsed)
  }
  return JSON.stringify(merged)
}

/**
 * The CLI keeps only the last --settings, so a second one would silently drop the first (the desktop's forced ask
 * rules, or a side run's tool guard). Several are merged into one at the first one's place; a lone one is kept as is.
 */
function oneSettings(args: readonly string[]): string[] {
  const at = args.flatMap((a, i) => (a === '--settings' ? [i] : []))
  if (at.length < 2) return [...args]
  const merged = mergeInlineJson(
    at.map((i) => args[i + 1]),
    '--settings'
  )
  const drop = new Set(at.slice(1).flatMap((i) => [i, i + 1]))
  return args.flatMap((a, i) => (drop.has(i) ? [] : i === at[0] + 1 ? [merged] : [a]))
}

export function buildArgs(o: {
  agentName: string
  model?: string // overrides the agent file's model (a command's model, kept by the chat)
  effort?: Effort // the chat's (Medium unless it has its own); absent (rooms, Codex) = the agent's or the CLI's
  resumeSessionId: string | null
  resumeAt?: string // cut the resumed session after this entry, into a fresh session id
  // The prompt uuid of the turn the cut discards (--resume-drops-turn): the CLI then refuses a cut that would discard anything
  // else. Only with resumeAt, and only on a binary that takes the flag (dropsTurnProbe.ts).
  resumeDrops?: string
  permissionMode: RunMode
  disallowedTools?: string[]
  extraArgs?: string[]
  appendSystemPrompt?: string
  thinking?: boolean // the CLI takes --thinking-display (see thinkingDisplay.ts)
}): string[] {
  return [
    '-p',
    '--agent',
    o.agentName,
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : []),
    ...(o.resumeSessionId
      ? [
          '--resume',
          o.resumeSessionId,
          ...(o.resumeAt
            ? ['--resume-session-at', o.resumeAt, '--fork-session', ...(o.resumeDrops ? ['--resume-drops-turn', o.resumeDrops] : [])]
            : [])
        ]
      : []),
    '--permission-mode',
    o.permissionMode,
    '--permission-prompt-tool',
    'stdio',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    // The thinking summaries the chat shows. Every run on a session passes it alike (side runs and keep-warm pings copy these
    // args), since a change in the request's thinking settings may cost the session its prompt cache.
    ...(o.thinking ? THINKING_DISPLAY_ARGS : []),
    // Snapshot off: the CLI otherwise replays the first turn's prompt on every resume, so a changed briefing or
    // house style would never reach a session that already has turns.
    ...(o.appendSystemPrompt ? ['--append-system-prompt', o.appendSystemPrompt, '--system-prompt-snapshot', 'off'] : []),
    ...oneSettings(o.extraArgs ?? []),
    // Variadic: everything after it is read as a tool rule, so it must come last.
    ...(o.disallowedTools?.length ? ['--disallowedTools', ...o.disallowedTools] : [])
  ]
}

export interface RunOptions {
  bin: string
  args: string[]
  cwd: string
  stdin: UserContent
  /** The id the CLI writes the prompt's own session entry under, so a later cut can declare the turn it discards. */
  stdinUuid?: string
  env?: NodeJS.ProcessEnv
  /** A contained run (core/isolation/containerRunner.ts): the spawn as podman runs it, given the final env. */
  wrap?(s: { bin: string; args: string[]; env: NodeJS.ProcessEnv }): { bin: string; args: string[]; env: NodeJS.ProcessEnv }
  killGraceMs?: number
  killForceMs?: number
  onEvent(e: RunEvent): void
}
// Both engines' result shape; it lives with the engine interface (core/engines/engine.ts) and is re-exported here, where every
// caller already imports it from.
export type { RunHandle, RunOutcome }

const STDERR_MAX = 64 * 1024
const DRAIN_MS = 2000

export function runClaude(o: RunOptions): RunHandle {
  const outcome: RunOutcome = { exitCode: null, signal: null, stderr: '', spawnError: null, result: null, stopped: false }
  let stopFn: () => void = () => {}
  let earlyStop = false
  let finished = false
  let sendFn: (message: object) => boolean = () => false

  const done = (async (): Promise<RunOutcome> => {
    try {
      const st = await stat(o.cwd).catch(() => null)
      if (!st || !st.isDirectory()) {
        outcome.spawnError = `Folder not found: ${o.cwd}`
        finished = true
        return outcome
      }
      if (earlyStop) {
        outcome.stopped = true
        finished = true
        return outcome
      }
      return await new Promise<RunOutcome>((resolve) => {
        let exited = false
        let settled = false
        let timer: NodeJS.Timeout | null = null
        let drainTimer: NodeJS.Timeout | null = null
        const finish = () => {
          if (settled) return
          settled = true
          finished = true
          if (timer) clearTimeout(timer)
          if (drainTimer) clearTimeout(drainTimer)
          resolve(outcome)
        }
        const env = claudeRunEnv(o.env ?? process.env)
        const run = o.wrap ? o.wrap({ bin: o.bin, args: o.args, env }) : { bin: o.bin, args: o.args, env }
        let child: ReturnType<typeof spawn>
        try {
          child = spawn(run.bin, run.args, { cwd: o.cwd, env: run.env, stdio: ['pipe', 'pipe', 'pipe'] })
        } catch (e) {
          outcome.spawnError = e instanceof Error ? e.message : String(e)
          return finish()
        }
        const out = child.stdout!,
          err = child.stderr!,
          inp = child.stdin!
        out.setEncoding('utf8')
        err.setEncoding('utf8')
        const split = new LineSplitter()
        const endStdin = () => {
          try {
            if (!inp.destroyed && !inp.writableEnded) inp.end()
          } catch {
            /* already closed */
          }
        }
        const handle = (lines: string[]) => {
          for (const l of lines)
            for (const e of parseLine(l)) {
              if (e.kind === 'result') outcome.result = e
              // This runs in stream listeners, where a throw is an uncaught exception that takes the whole server down, or
              // skips the finish() after a flush and leaves the turn running forever. One bad event costs only itself.
              try {
                o.onEvent(e)
              } catch (err) {
                console.error('run event failed:', err instanceof Error ? err.message : String(err))
              }
              // The CLI stays alive while stdin is open; the result is its last word.
              if (e.kind === 'result') endStdin()
            }
        }
        out.on('data', (c: string) => handle(split.push(c)))
        err.on('data', (c: string) => {
          outcome.stderr += c
          if (outcome.stderr.length > STDERR_MAX) outcome.stderr = outcome.stderr.slice(-STDERR_MAX)
        })
        inp.on('error', () => {
          /* EPIPE when child dies early */
        })

        child.on('error', (e) => {
          if (settled) return
          outcome.spawnError = e.message
          finish()
        })
        // 'exit' fires when the process dies; 'close' only after stdio drains, which
        // may never happen if a grandchild inherited the pipes.
        child.on('exit', (code, signal) => {
          if (settled) return
          exited = true
          if (timer) {
            clearTimeout(timer)
            timer = null
          }
          outcome.exitCode = code
          outcome.signal = signal
          endStdin()
          drainTimer = setTimeout(() => {
            out.destroy()
            err.destroy()
            handle(split.flush())
            finish()
          }, DRAIN_MS)
        })
        child.on('close', () => {
          if (settled || !exited) return
          handle(split.flush())
          finish()
        })

        stopFn = () => {
          if (exited || settled || timer) return
          outcome.stopped = true
          // Windows: SIGINT would be TerminateProcess on claude alone, orphaning its tools' processes; end the tree.
          if (process.platform === 'win32') killTree(child.pid)
          else child.kill('SIGINT')
          timer = setTimeout(() => {
            if (exited) return
            child.kill('SIGTERM')
            timer = setTimeout(() => {
              if (!exited) child.kill('SIGKILL')
            }, o.killForceMs ?? 5000)
          }, o.killGraceMs ?? 3000)
        }
        sendFn = (message) => {
          if (exited || settled || outcome.stopped || inp.destroyed || inp.writableEnded) return false
          try {
            inp.write(JSON.stringify(message) + '\n')
            return true
          } catch {
            return false
          }
        }
        inp.write(encodeUserMessage(o.stdin, o.stdinUuid))
      })
    } catch (e) {
      outcome.spawnError = e instanceof Error ? e.message : String(e)
      finished = true
      return outcome
    }
  })()

  return {
    done,
    send: (message) => !finished && !earlyStop && sendFn(message),
    stop: () => {
      if (finished) return
      earlyStop = true
      stopFn()
    }
  }
}
