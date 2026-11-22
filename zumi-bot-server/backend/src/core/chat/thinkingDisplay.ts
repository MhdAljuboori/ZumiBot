import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'

export const THINKING_DISPLAY_ARGS = ['--thinking-display', 'summarized'] as const

export interface ThinkingProbeDeps {
  env(): NodeJS.ProcessEnv
  /** The CLI's whole output (stdout and stderr) for these args with stdin closed; null when it could not be run to an end. */
  run?(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null>
  /** Changes when the binary does (an update), so a new version is asked again. */
  version?(bin: string): Promise<string>
}

const PROBE_MS = 15_000

function runToEnd(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(bin, args, { env, timeout: PROBE_MS, maxBuffer: 256 * 1024 }, (err, stdout, stderr) => {
        // A non-zero exit is expected (no prompt was given); only a run that never ended, or never started, tells nothing.
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null
        resolve(e && (e.killed || typeof e.code === 'string') ? null : `${stdout}\n${stderr}`)
      })
      // No prompt: the CLI stops at once instead of waiting for stdin.
      child.stdin?.end()
    } catch {
      resolve(null)
    }
  })
}

/**
 * Whether this claude takes `--thinking-display`. The flag is hidden (not in --help), and without it a `-p` run streams every
 * thinking block empty. An older CLI refuses an unknown option, which would fail every turn, so each binary is asked once:
 * given no prompt the CLI stops before any request, and its error names the flag only when it does not take it.
 */
export function createThinkingProbe(d: ThinkingProbeDeps): (bin: string) => Promise<boolean> {
  const run = d.run ?? runToEnd
  const version =
    d.version ??
    (async (bin: string) => {
      const s = await stat(bin)
      return `${s.mtimeMs}:${s.size}`
    })
  const known = new Map<string, Promise<boolean>>()
  return async (bin) => {
    const key = `${bin}\n${await version(bin).catch(() => '')}`
    let answer = known.get(key)
    if (!answer) {
      answer = run(bin, ['-p', ...THINKING_DISPLAY_ARGS], d.env()).then(
        (out) => out !== null && !out.includes('--thinking-display'),
        () => false
      )
      known.set(key, answer)
    }
    return answer
  }
}
