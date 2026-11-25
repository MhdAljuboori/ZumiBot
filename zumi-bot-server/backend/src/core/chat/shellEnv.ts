import { spawn, type ChildProcess } from 'node:child_process'

const MARKER = '__CB__'
const SHELL_TIMEOUT_MS = 5000
const SHELL_MAX_BYTES = 64 * 1024

export interface CaptureOptions {
  timeoutMs: number
  maxBytes: number
}

export interface ShellEnvDeps {
  capture(file: string, args: string[], o: CaptureOptions): Promise<string>
  fallback: string
}

// Off Windows the command gets a session of its own (`detached`: setsid), so it has no controlling terminal. An interactive
// shell (`-ilc`) takes over the terminal it starts from, so a server run from a terminal, or a test that starts one, was
// left in the background and stopped by the terminal. On Windows `detached` opens a console window instead.
export const OWN_SESSION = process.platform !== 'win32'

/** Ends the command and, in its own session, everything it started (a profile's background job). */
export function killCapture(child: ChildProcess): void {
  try {
    if (OWN_SESSION && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

/** Runs a command with stdin closed and returns its stdout; rejects on failure, timeout or oversize output. */
export function spawnCapture(file: string, args: string[], o: CaptureOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: OWN_SESSION })
    let out = ''
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    const timer = setTimeout(() => {
      killCapture(child)
      finish(() => reject(new Error('timed out')))
    }, o.timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (c: string) => {
      out += c
      if (out.length > o.maxBytes) {
        killCapture(child)
        finish(() => reject(new Error('output too large')))
      }
    })
    child.on('error', (e) => finish(() => reject(e)))
    child.on('close', (code) => finish(() => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)))))
  })
}

function parsePath(out: string): string | null {
  const at = out.lastIndexOf(MARKER)
  if (at < 0) return null
  const value = (out.slice(at + MARKER.length).split('\n')[0] ?? '').trim()
  return value && value.split(':').every((p) => p.startsWith('/')) ? value : null
}

/**
 * The shell whose startup files hold the user's PATH. On a Mac that is zsh (the default since 10.15; Homebrew and nvm
 * write to .zprofile and .zshrc), unless the user's own shell is bash; an app opened from Finder gets only
 * /usr/bin:/bin:/usr/sbin:/sbin, so asking bash there found neither claude nor anything an agent runs. Elsewhere bash.
 * fish and others are not asked: their `$PATH` is not one colon-separated string.
 */
export function loginShell(platform: NodeJS.Platform = process.platform, userShell: string = process.env.SHELL ?? ''): string {
  if (platform !== 'darwin') return 'bash'
  return /\/bash$/.test(userShell) ? 'bash' : 'zsh'
}

/** The PATH an interactive login shell would have (nvm and friends live in .bashrc / .zshrc), or the fallback. */
export async function resolveRunPath(d: ShellEnvDeps & { platform?: NodeJS.Platform; userShell?: string }): Promise<string> {
  const platform = d.platform ?? process.platform
  // Windows has no login shell to ask: a `bash` there is WSL's or Git Bash's, whose PATH would be Linux or /c/ paths.
  if (platform === 'win32') return d.fallback
  try {
    const out = await d.capture(loginShell(platform, d.userShell), ['-ilc', `printf "\\n${MARKER}%s" "$PATH"`], {
      timeoutMs: SHELL_TIMEOUT_MS,
      maxBytes: SHELL_MAX_BYTES
    })
    return parsePath(out) ?? d.fallback
  } catch {
    return d.fallback
  }
}

/** Resolves the interactive PATH once, on the first ready(); env() is synchronous and safe before that. */
// Never handed to a run: the secret would reach every command an agent starts (and the transcript through `env`), and
// ELECTRON_RUN_AS_NODE would make any Electron program an agent starts run as plain Node. NODE_ENV=production is the
// server's own (packaged shell, systemd): inherited, it would make an agent's `npm install` skip devDependencies.
// Only PATH is taken from the login shell, so a NODE_ENV the user's shell sets never reaches this env anyway.
const SERVER_ONLY_ENV = ['ZUMIBOT_LOCAL_SECRET', 'ELECTRON_RUN_AS_NODE', 'NODE_ENV']

function foldPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = Object.keys(env).filter((k) => k !== 'PATH' && k.toUpperCase() === 'PATH')
  if (!keys.length) return env
  const out = { ...env }
  for (const k of keys) {
    out.PATH ??= out[k]
    delete out[k]
  }
  return out
}

export function createRunEnv(d: { capture?: ShellEnvDeps['capture']; base?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) {
  // A copy of the Windows environment keeps its `Path` key: fold every spelling into one `PATH`, so a run never gets two.
  const base = foldPath(d.base ?? process.env)
  let path: string | null = null
  let pending: Promise<void> | null = null
  return {
    ready(): Promise<void> {
      pending ??= resolveRunPath({ capture: d.capture ?? spawnCapture, fallback: base.PATH ?? '', platform: d.platform }).then((p) => {
        path = p
      })
      return pending
    },
    env(): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = path === null ? { ...base } : { ...base, PATH: path }
      for (const k of SERVER_ONLY_ENV) delete env[k]
      return env
    }
  }
}
