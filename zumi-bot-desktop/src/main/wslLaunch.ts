// Local mode on Windows: the server cannot run natively there (Unix sockets, process groups, `sh` hooks), so the shell
// starts the server.mjs it bundles inside WSL2, with the Node.js installed there. The data folder, `claude` and the
// agents folder are the WSL user's. WSL2 forwards Windows' 127.0.0.1 to the server's, so the origin is unchanged.

import { LOCAL_UPDATES_ENV } from '@zumibot/shared/update'

export const WSL_EXE = 'wsl.exe'
export const WSL_SCRIPT_ENV = 'ZUMIBOT_WSL_SCRIPT'
export const WSL_ENTRY_ENV = 'ZUMIBOT_WSL_ENTRY'

// Exit codes of the launch script, so the shell can say what is missing.
export const NO_NODE_EXIT = 120
export const OLD_NODE_EXIT = 121
export const NO_ENTRY_EXIT = 122

/** The only variables WSL hands to the Linux side (`/u`: from Windows only; `/p`: translated to a WSL path). */
const FORWARD = ['ZUMIBOT_MODE', 'ZUMIBOT_LOCAL_SECRET', 'ZUMIBOT_PORT', 'ZUMIBOT_STDIN_CONTROL', 'NODE_ENV', WSL_SCRIPT_ENV]

// bash -i so ~/.bashrc runs: that is where nvm and most Node installs put `node` on PATH.
export const WSL_SCRIPT = [
  `command -v node >/dev/null 2>&1 || exit ${NO_NODE_EXIT}`,
  `node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || exit ${OLD_NODE_EXIT}`,
  `[ -r "$${WSL_ENTRY_ENV}" ] || exit ${NO_ENTRY_EXIT}`,
  `exec node "$${WSL_ENTRY_ENV}"`
].join('\n')

export interface WslLaunch {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

/**
 * The script travels in an env var, not argv: argv is visible to other processes, and Windows' argument quoting would
 * have to survive wsl.exe's own parsing. The one argument left has no quotes in it.
 */
export function wslLaunch(entry: string, env: NodeJS.ProcessEnv): WslLaunch {
  const next: NodeJS.ProcessEnv = { ...env, [WSL_SCRIPT_ENV]: WSL_SCRIPT, [WSL_ENTRY_ENV]: entry, ZUMIBOT_STDIN_CONTROL: '1' }
  const forward = FORWARD.filter((k) => next[k] !== undefined).map((k) => `${k}/u`)
  // Windows paths the server reads or writes: WSL turns them into /mnt/<drive>/... paths.
  for (const k of [WSL_ENTRY_ENV, LOCAL_UPDATES_ENV]) if (next[k] !== undefined) forward.push(`${k}/p`)
  next['WSLENV'] = [env['WSLENV'], ...forward].filter(Boolean).join(':')
  return { command: WSL_EXE, args: ['--exec', 'bash', '-lic', `source <(printenv ${WSL_SCRIPT_ENV})`], env: next }
}

const DOCS = 'See "Run ZumiBot on your computer" in the docs (docs.zumibot.run).'

/** What the user can do about a WSL server that did not come up. */
export function wslStartError(code: number | null, spawnError?: NodeJS.ErrnoException): string {
  if (spawnError?.code === 'ENOENT') return `WSL is not installed. In PowerShell, run "wsl --install", restart Windows, then try again. ${DOCS}`
  if (code === NO_NODE_EXIT) return `Node.js is not installed in WSL. Install Node.js 22 or newer inside your WSL distribution. ${DOCS}`
  if (code === OLD_NODE_EXIT) return `The Node.js in WSL is too old. ZumiBot needs Node.js 22 or newer inside WSL. ${DOCS}`
  if (code === NO_ENTRY_EXIT) return `WSL cannot read ZumiBot's server files from Windows. Check that your Windows drives are mounted in WSL. ${DOCS}`
  return `The local server in WSL exited (code ${code ?? 'signal'}) before it was ready. ${DOCS}`
}

type What = 'busy' | 'processes'

/**
 * The shell's side of the server's stdin control channel (`serveStdinControl`): a `busy` or `processes` line out,
 * a `CONTROL <what> <n>` line back. Answers come in the order asked, per kind.
 */
export function createStdioControl(write: (line: string) => boolean) {
  const waiting: Record<What, { resolve(n: number): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> }[]> = {
    busy: [],
    processes: []
  }
  let closed = false
  return {
    ask(what: What, timeoutMs = 2000): Promise<number> {
      if (closed) return Promise.reject(new Error('the local server is gone'))
      return new Promise<number>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          timer: setTimeout(() => {
            const i = waiting[what].indexOf(entry)
            if (i >= 0) waiting[what].splice(i, 1)
            reject(new Error('control timed out'))
          }, timeoutMs)
        }
        waiting[what].push(entry)
        try {
          write(`${what}\n`)
        } catch {
          /* the timer answers */
        }
      })
    },
    /** True when the line was a control reply. */
    onLine(line: string): boolean {
      const m = /^CONTROL (busy|processes) (\d+|error)\s*$/.exec(line)
      if (!m) return false
      const w = waiting[m[1] as What].shift()
      if (!w) return true
      clearTimeout(w.timer)
      if (m[2] === 'error') w.reject(new Error('bad control reply'))
      else w.resolve(Number(m[2]))
      return true
    },
    close(): void {
      closed = true
      for (const what of ['busy', 'processes'] as const) {
        for (const w of waiting[what].splice(0)) {
          clearTimeout(w.timer)
          w.reject(new Error('the local server is gone'))
        }
      }
    }
  }
}
