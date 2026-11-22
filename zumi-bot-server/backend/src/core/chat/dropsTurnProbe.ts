import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'

export const DROPS_TURN_FLAG = '--resume-drops-turn'
// Any uuid: the probe never gets as far as using it.
const PROBE_UUID = '00000000-0000-4000-8000-000000000000'

export interface DropsTurnProbeDeps {
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
        // A non-zero exit is expected (the flag is given on its own); only a run that never ended, or never started, tells nothing.
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

/** Whether this output says the CLI does not know the flag. Pure, so the predicate itself is unit tested. */
export function saysUnknownOption(out: string): boolean {
  return /unknown option/i.test(out)
}

/**
 * Whether this claude takes `--resume-drops-turn`, which makes it validate a cut against the turn the cut means to discard
 * (see docs/architecture/edit-resend-fork.md). The flag is hidden, and an older CLI refuses an unknown option, which would fail
 * every rewind, so each binary is asked once: given the flag on its own, a CLI that has it answers
 * `--resume-drops-turn requires --resume-session-at`, and one that does not answers `unknown option`. Anything the probe cannot
 * run, or cannot read, counts as no: the cut then goes unvalidated, exactly as every cut did before this.
 */
export function createDropsTurnProbe(d: DropsTurnProbeDeps): (bin: string) => Promise<boolean> {
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
      answer = run(bin, ['-p', DROPS_TURN_FLAG, PROBE_UUID], d.env()).then(
        (out) => out !== null && !saysUnknownOption(out),
        () => false
      )
      known.set(key, answer)
    }
    return answer
  }
}
