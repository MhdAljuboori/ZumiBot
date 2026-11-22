import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'
import qrcode from 'qrcode'
import { AuthStore } from './auth/authStore'
import { hashPassword, PASSWORD_MIN } from './auth/password'
import { newRecoveryCodes } from './auth/recovery'
import { newTotpSecret, otpauthUri, verifyTotp } from './auth/totp'
import { startServer } from './app'
import { startSetupServer, type SetupServer } from './setupServer'
import { loadConfig, resolveDataDir } from './config'
import { LOCAL_RESTART_EXIT } from '@zumibot/shared/update'
import { controlPath, queryBusy, serveStdinControl, STDIN_CONTROL_ENV } from './control'
import { ensureDataDir } from './dataDir'
import { migrateLegacyName } from './legacyName'
import { checkBrowserRuntime, installBrowserRuntime } from './core/browser/browserRuntime'
import { CUA_ENV } from './core/desktop/desktopProcess'
import { DESKTOP_PROGRAMS, resolveDesktopRuntime } from './core/desktop/desktopRuntime'
import { signalChildGroup } from './core/procKill'

export interface CliDeps {
  env: NodeJS.ProcessEnv
  out(line: string): void
  err(line: string): void
  /** Resolves null when input has ended. hidden = do not echo what is typed. */
  prompt(question: string, hidden: boolean): Promise<string | null>
  now(): number
  /** Test hook: how long `cua-driver --version` may take. */
  cuaVersionMs?: number
}

const USAGE =
  'Usage: zumibot-server [serve] | busy | processes | set-password [--generate] | setup-2fa | browser-check | browser-install | desktop-check | --help'
const SHUTDOWN_MS = 10_000

export function qrText(uri: string): Promise<string> {
  return qrcode.toString(uri, { type: 'terminal', small: true })
}

export function formatRecoveryCodes(codes: string[]): string[] {
  return ['Store these somewhere safe. Each works once.', ...codes.map((c) => `  ${c}`)]
}

async function openAuth(deps: CliDeps): Promise<AuthStore> {
  const dir = resolveDataDir(deps.env)
  await ensureDataDir(dir)
  return new AuthStore(dir, deps.now)
}

async function setPassword(args: string[], deps: CliDeps): Promise<number> {
  let password: string
  if (args.includes('--generate')) {
    password = randomBytes(18).toString('base64url') // 24 chars
  } else {
    const first = await deps.prompt('New password: ', true)
    if (first === null) return fail(deps, 'No password given.')
    if (first.normalize('NFKC').length < PASSWORD_MIN) return fail(deps, `Use at least ${PASSWORD_MIN} characters.`)
    const second = await deps.prompt('Repeat password: ', true)
    if (second === null) return fail(deps, 'No password given.')
    if (second !== first) return fail(deps, 'The two passwords do not match.')
    password = first
  }
  const auth = await openAuth(deps)
  await auth.setPassword(await hashPassword(password))
  if (args.includes('--generate')) {
    deps.out('Your new password (shown once, store it now):')
    deps.out(password)
  }
  deps.out('Password saved. Every signed-in session was signed out.')
  return 0
}

async function setup2fa(deps: CliDeps): Promise<number> {
  const auth = await openAuth(deps)
  const secret = newTotpSecret()
  const uri = otpauthUri(secret)
  deps.out('Scan this with your authenticator app:')
  deps.out(await qrText(uri))
  deps.out('Or add it by hand:')
  deps.out(uri)
  let step: number
  for (;;) {
    const answer = await deps.prompt('Enter the 6-digit code to confirm: ', false)
    if (answer === null) return fail(deps, 'Cancelled. Nothing was saved.')
    const matched = verifyTotp(secret, answer.replace(/\s/g, ''), deps.now(), 0)
    if (matched !== null) {
      step = matched
      break
    }
    deps.err('That code is not valid. Try the next one.')
  }
  const { codes, hashes } = newRecoveryCodes()
  // Saved before the codes are shown, so every code printed is already usable.
  await auth.setTotp(secret, hashes, step)
  deps.out('Two-factor sign-in is on. Every signed-in session was signed out.')
  for (const line of formatRecoveryCodes(codes)) deps.out(line)
  return 0
}

const CUA_VERSION_MS = 5000
const VERSION_OUTPUT_MAX = 64 * 1024

/**
 * Only the version token leaves this function, so a misbehaving binary can print nothing else.
 * The child gets a minimal env (not the server's, which holds secrets) and its own process group:
 * on timeout the whole group is killed and the call settles even if a grandchild holds the pipe.
 */
function cuaVersion(cua: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const childEnv: NodeJS.ProcessEnv = { ...CUA_ENV }
    for (const key of ['PATH', 'HOME', 'LANG']) if (env[key] !== undefined) childEnv[key] = env[key]
    let out = ''
    let done = false
    const child = spawn(cua, ['--version'], { env: childEnv, stdio: ['ignore', 'pipe', 'ignore'], detached: true })
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        signalChildGroup(child, 'SIGKILL')
      } catch {
        /* already gone */
      }
      child.stdout.destroy()
      resolve((ok ? /\d+\.\d+\.\d+[\w.+-]*/.exec(out)?.[0] : null) ?? 'version unknown')
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      if (out.length < VERSION_OUTPUT_MAX) out += chunk.toString('utf8')
    })
    child.on('error', () => finish(false))
    child.on('close', (code) => finish(code === 0))
  })
}

/** Read-only preflight of the desktop stack: installs nothing and needs no sudo. */
async function desktopCheck(deps: CliDeps): Promise<number> {
  const rt = resolveDesktopRuntime(deps.env)
  // The default session is /bin/sh -c <script> <parts...>; show the parts, not the wrapper.
  const sessionPaths = rt.session && (rt.session[1] === '-c' ? rt.session.slice(3) : rt.session)
  const lines: [string | null, string][] = [
    [rt.xvnc, DESKTOP_PROGRAMS.xvnc],
    [rt.dbusDaemon, DESKTOP_PROGRAMS.dbusDaemon],
    [sessionPaths ? sessionPaths.join(' ') : null, DESKTOP_PROGRAMS.session],
    [rt.cuaDriver, DESKTOP_PROGRAMS.cuaDriver]
  ]
  for (const [path, name] of lines) deps.out(path ? `found ${path}` : `missing ${name}`)
  if (rt.cuaDriver) deps.out(`cua-driver ${await cuaVersion(rt.cuaDriver, deps.env, deps.cuaVersionMs ?? CUA_VERSION_MS)}`)
  return rt.missing.length ? 1 : 0
}

function fail(deps: CliDeps, message: string): number {
  deps.err(message)
  return 1
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [cmd, ...args] = argv
  try {
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
      deps.out(USAGE)
      return 0
    }
    if (cmd === 'browser-check' || cmd === 'browser-install') {
      if (args.length) return fail(deps, USAGE)
      if (cmd === 'browser-install') await installBrowserRuntime(deps.env, deps.out)
      else {
        await checkBrowserRuntime(deps.env)
        deps.out('Browser check passed: runtime assets, executable, sandboxed ephemeral launch and cleanup.')
      }
      return 0
    }
    if (cmd === 'desktop-check') {
      if (args.length) return fail(deps, USAGE)
      return await desktopCheck(deps)
    }
    if (cmd === 'set-password') return await setPassword(args, deps)
    if (cmd === 'setup-2fa') return await setup2fa(deps)
    if (cmd === undefined || cmd === 'serve') return await serve(deps)
    if (cmd === 'busy') return await busy(deps)
    if (cmd === 'processes') return await busy(deps, 'processes')
  } catch (err) {
    // Message only: it must never carry a password or secret.
    return fail(deps, `Failed: ${err instanceof Error ? err.message : 'unknown error'}`)
  }
  return fail(deps, USAGE)
}

/** Piped (non-tty) input: one line per prompt, null at the end. */
export function createLinePrompter(input: Readable, output: Writable): (question: string, hidden: boolean) => Promise<string | null> {
  const lines = createInterface({ input })[Symbol.asyncIterator]()
  return async (question) => {
    output.write(question)
    const next = await lines.next()
    return next.done ? null : next.value
  }
}

function readHidden(question: string): Promise<string | null> {
  const { stdin, stdout } = process
  return new Promise((resolve) => {
    let buf = ''
    stdout.write(question)
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    const finish = (v: string | null): void => {
      stdin.removeListener('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stdout.write('\n')
      resolve(v)
    }
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(buf)
        if (ch === '\u0003') {
          finish(null)
          process.exit(130)
        }
        if (ch === '\u0004') return finish(buf.length ? buf : null)
        if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1)
        else if (ch >= ' ') buf += ch
      }
    }
    stdin.on('data', onData)
  })
}

export function createTerminalPrompter(): CliDeps['prompt'] {
  if (!process.stdin.isTTY) return createLinePrompter(process.stdin, process.stdout)
  const echoed = createLinePrompter(process.stdin, process.stdout)
  return (q, hidden) => (hidden ? readHidden(q) : echoed(q, false))
}

export function terminalDeps(env: NodeJS.ProcessEnv = process.env): CliDeps {
  return {
    env,
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    prompt: createTerminalPrompter(),
    now: Date.now
  }
}

/** Past the deadline something is stuck: leave, but not as a clean stop, and free the lock first so the next start is not refused. */
export function armWatchdog(server: { releaseLock(): void }, ms: number, exit: (code: number) => void): void {
  setTimeout(() => {
    server.releaseLock()
    exit(1)
  }, ms).unref()
}

/** The config holds the secret once loaded; children (agent runs, their tools) must not inherit it from the environment. */
export function scrubServerSecrets(env: NodeJS.ProcessEnv): void {
  delete env['ZUMIBOT_LOCAL_SECRET']
  delete env['ELECTRON_RUN_AS_NODE']
  delete env[STDIN_CONTROL_ENV] // an agent's own server must not read its stdin as this one's control channel
}

/**
 * True once the browser wizard has finished, false when the process was asked to stop first. The setup server is
 * closed either way, so the port and the data lock are free before the real server takes them.
 */
export async function waitForSetup(setup: SetupServer): Promise<boolean> {
  let onSignal!: () => void
  const stopped = new Promise<false>((resolve) => {
    onSignal = () => resolve(false)
  })
  process.once('SIGTERM', onSignal)
  process.once('SIGINT', onSignal)
  try {
    return await Promise.race([setup.finished.then(() => true), stopped])
  } finally {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    await setup.close()
  }
}

// Runs until SIGTERM/SIGINT, then stops every reply, closes the sockets and exits within SHUTDOWN_MS.
async function serve(deps: CliDeps): Promise<number> {
  const config = loadConfig(deps.env)
  const stdinControl = config.mode === 'local' && deps.env[STDIN_CONTROL_ENV] === '1'
  if (deps.env === process.env) scrubServerSecrets(process.env)
  // A vps server with no password or TOTP serves the setup wizard first, on the same port.
  const setup = await startSetupServer(config, { out: deps.out })
  if (setup && !(await waitForSetup(setup))) return 0
  // Local mode's update ends this process the same way a signal does, with an exit code that asks the shell to start it again.
  let stopWith: ((code: number) => void) | null = null
  const server = await startServer(config, {
    out: deps.out,
    restart: config.mode === 'local' ? () => stopWith?.(LOCAL_RESTART_EXIT) : undefined
  })
  return new Promise((resolve) => {
    let stopping = false
    const stop = (code = 0): void => {
      if (stopping) return
      stopping = true
      // A stuck restart still leaves with the restart code: the new build is in place, and the shell should start it.
      armWatchdog(server, SHUTDOWN_MS, (c) => process.exit(code !== 0 ? code : c))
      server.close().then(
        () => resolve(code),
        () => resolve(code === 0 ? 1 : code)
      )
    }
    stopWith = stop
    process.on('SIGTERM', () => stop())
    process.on('SIGINT', () => stop())
    // Local mode only: the Windows shell's WSL2 server is asked and stopped through stdin, not the socket file.
    if (stdinControl) {
      const sock = controlPath(resolveDataDir(deps.env))
      serveStdinControl(process.stdin, { query: (what) => queryBusy(sock, 2000, what), out: deps.out, stop: () => stop() })
    }
  })
}

/** `busy`: running replies. `processes`: running background processes, which deploy and sync only warn about. */
async function busy(deps: CliDeps, what: 'busy' | 'processes' = 'busy'): Promise<number> {
  try {
    deps.out(String(await queryBusy(controlPath(resolveDataDir(deps.env)), 2000, what)))
    return 0
  } catch {
    return fail(deps, 'No ZumiBot server is running.')
  }
}

/** The bundle's entry point (main.ts). */
export function main(): void {
  // Like the desktop app: one stray rejection is logged (message only, never the object) and the server keeps running.
  process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err instanceof Error ? err.message : String(err)))
  migrateLegacyName(process.env, (line) => console.error(line))
  runCli(process.argv.slice(2), terminalDeps()).then((code) => process.exit(code))
}
