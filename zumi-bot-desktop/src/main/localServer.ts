import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { resolveDataDir } from '@zumibot/backend/config'
import { controlPath, queryBusy } from '@zumibot/backend/control'
import { killTree } from '@zumibot/backend/procKill'
import { createStdioControl, wslLaunch, wslStartError } from './wslLaunch'

export interface LocalServer {
  origin: string
  secret: string
  stop(): Promise<void>
  busy(): Promise<number>
  /** Running background processes (an older server has no such line: rejects, read as none). */
  processes(): Promise<number>
}

export interface LocalServerOptions {
  node: string
  entry: string
  env: NodeJS.ProcessEnv
  timeoutMs?: number
  killAfterMs?: number
  onStderr?(line: string): void
  /** The server died on its own (not through stop()). */
  onExit?(code: number | null, signal: NodeJS.Signals | null): void
  /** Windows: run `entry` inside WSL2 with its Node (wslLaunch.ts); `node` is unused. Asked and stopped over stdio. */
  wsl?: boolean
  platform?: NodeJS.Platform
}

/** The server's stderr says its port is taken. */
export function portInUse(stderrTail: string): boolean {
  return stderrTail.includes('EADDRINUSE')
}

const START_TIMEOUT_MS = 15_000
// A cold WSL VM boots first, and bash -i reads the user's ~/.bashrc.
const WSL_START_TIMEOUT_MS = 60_000
const KILL_AFTER_MS = 10_000
const STDERR_TAIL = 20

export function startLocalServer(o: LocalServerOptions): Promise<LocalServer> {
  // The secret reaches the child through env only: argv and the URL are visible to other processes and logs.
  const secret = randomBytes(32).toString('hex')
  const env: NodeJS.ProcessEnv = { ...o.env, ELECTRON_RUN_AS_NODE: '1', ZUMIBOT_MODE: 'local', ZUMIBOT_LOCAL_SECRET: secret }
  const windows = (o.platform ?? process.platform) === 'win32'
  // Windows has no SIGTERM (child.kill is TerminateProcess, so the server could never close cleanly), and WSL's server cannot
  // be reached through a socket file: there stdin carries both the questions and the stop (serveStdinControl).
  const stdio = !!o.wsl || windows
  if (stdio) env['ZUMIBOT_STDIN_CONTROL'] = '1'
  const wsl = o.wsl ? wslLaunch(o.entry, env) : null
  const child = wsl
    ? spawn(wsl.command, wsl.args, { env: wsl.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    : spawn(o.node, [o.entry], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stdin.on('error', () => {})
  if (!stdio) child.stdin.end() // nothing reads it: the server listens for stdin only with ZUMIBOT_STDIN_CONTROL
  const control = stdio ? createStdioControl((l) => child.stdin!.write(l)) : null

  const tail: string[] = []
  let stderrBuf = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    stderrBuf += d
    const lines = stderrBuf.split('\n')
    stderrBuf = lines.pop() ?? ''
    for (const l of lines) {
      tail.push(l)
      if (tail.length > STDERR_TAIL) tail.shift()
      o.onStderr?.(l.split(secret).join('[redacted]'))
    }
  })
  const flushTail = (): string => {
    if (stderrBuf) {
      tail.push(stderrBuf)
      stderrBuf = ''
    }
    // Never let an echoed secret reach an error message.
    return tail.slice(-STDERR_TAIL).join('\n').split(secret).join('[redacted]')
  }

  let exited = false
  let stopping = false
  // Windows: the server's whole tree, or its claude runs would outlive it.
  const hardKill = (): void => {
    if (windows && !wsl) killTree(child.pid)
    else child.kill('SIGKILL')
  }
  const exitPromise = new Promise<void>((resolve) =>
    child.once('exit', () => {
      exited = true
      control?.close()
      resolve()
    })
  )

  return new Promise<LocalServer>((resolve, reject) => {
    let ready = false
    let out = ''
    const startMs = o.timeoutMs ?? (wsl ? WSL_START_TIMEOUT_MS : START_TIMEOUT_MS)
    const timer = setTimeout(() => {
      if (ready) return
      hardKill()
      fail(`The local server did not start within ${Math.round(startMs / 1000)}s`)
    }, startMs)

    const fail = (msg: string, code?: number | null, err?: NodeJS.ErrnoException): void => {
      if (wsl && (code !== undefined || err)) msg = wslStartError(code ?? null, err)
      clearTimeout(timer)
      const t = flushTail()
      reject(new Error(t ? `${msg}\n${t}` : msg))
    }

    child.once('error', (err) => fail(`The local server could not be started: ${err.message}`, null, err))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      out += d
      if (ready) {
        // After LISTENING only control replies matter; whole lines only, so a reply split across chunks is not lost.
        const lines = out.split('\n')
        out = lines.pop() ?? ''
        for (const l of lines) control?.onLine(l.replace(/\r$/, ''))
        return
      }
      const m = /^LISTENING (\d+)\s*$/m.exec(out)
      if (!m) return
      ready = true
      out = out.slice(m.index + m[0].length).replace(/^\r?\n/, '')
      clearTimeout(timer)
      const origin = `http://127.0.0.1:${m[1]}`
      const sock = controlPath(resolveDataDir(env))
      resolve({
        origin,
        secret,
        busy: () => (control ? control.ask('busy') : queryBusy(sock)),
        processes: () => (control ? control.ask('processes') : queryBusy(sock, 2000, 'processes')),
        async stop() {
          if (exited) return
          stopping = true
          if (stdio)
            child.stdin!.end() // the server stops as on SIGTERM; a kill is only the fallback
          else child.kill('SIGTERM')
          const k = setTimeout(hardKill, o.killAfterMs ?? KILL_AFTER_MS)
          await exitPromise
          clearTimeout(k)
        }
      })
    })
    // 'close' (not 'exit'): the stderr that explains the exit has been read by then.
    child.once('close', (code, signal) => {
      if (!ready) fail(`The local server exited (code ${code ?? 'signal'}) before it was ready`, code)
      else if (!stopping) o.onExit?.(code, signal)
    })
  })
}
