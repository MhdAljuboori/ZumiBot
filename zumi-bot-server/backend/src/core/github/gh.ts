import { execFile } from 'node:child_process'
import { toolLine } from '@zumibot/shared/pullRequest'
import type { GhState } from '@zumibot/shared/types'
import { defaultLocateDeps, locateBin } from '../chat/claudeLocator'

/** A failed `gh` call. The message is one line of gh's own stderr, scrubbed, never the env and never a token. */
export class GhError extends Error {}

export interface GhResult {
  stdout: string
  code: number
}
export type Gh = (args: string[], cwd: string, o?: { timeoutMs?: number; allowExit?: number[] }) => Promise<GhResult>

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_BUFFER = 16 * 1024 * 1024
/** How long a "gh is signed in" answer is trusted before it is asked again. */
const AUTH_TTL_MS = 60_000

const AUTH_MISS = /not logged|no accounts|authentication|gh auth login|requires authentication|bad credentials/i

/** Whether a gh failure means "not signed in", so the cached answer is dropped and the UI says so. */
export const isAuthError = (message: string): boolean => AUTH_MISS.test(message)

/**
 * `execFile` with no shell, like `makeGit`: every argument stays one argument. `env` is the server's own, so gh reads
 * the user's own credentials; ZumiBot never passes or stores a token.
 */
export function makeGh(bin: () => Promise<string | null>, env: () => NodeJS.ProcessEnv): Gh {
  return async (args, cwd, o = {}) => {
    const path = await bin()
    if (path === null) throw new GhError('gh not found')
    return new Promise<GhResult>((resolve, reject) => {
      execFile(
        path,
        args,
        { cwd, env: env(), timeout: o.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) return resolve({ stdout, code: 0 })
          const e = err as NodeJS.ErrnoException & { killed?: boolean }
          if (e.code === 'ENOENT') return reject(new GhError('gh not found'))
          if (typeof e.code === 'number') {
            if (o.allowExit?.includes(e.code)) return resolve({ stdout, code: e.code })
            return reject(new GhError(toolLine(stderr, `gh exited with code ${e.code}`)))
          }
          if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new GhError('gh output too large'))
          if (e.killed) return reject(new GhError('gh timed out'))
          reject(new GhError('gh failed'))
        }
      )
    })
  }
}

/**
 * Finds `gh` and remembers whether it is signed in. A miss is never cached, so installing gh or signing in later just
 * works; a signed-in answer is kept for a minute and dropped the moment a call fails on authentication.
 */
export function createGhLocator(run?: Gh): { locate(): Promise<string | null>; state(): Promise<GhState>; forgetAuth(): void; gh: Gh } {
  let bin: Promise<string | null> | null = null
  const locate = (): Promise<string | null> => {
    if (!bin) {
      const p = locateBin('gh', defaultLocateDeps(null, 'gh'))
      bin = p
      void p.then(
        (r) => {
          if (r === null && bin === p) bin = null
        },
        () => {
          if (bin === p) bin = null
        }
      )
    }
    return bin
  }
  const gh = run ?? makeGh(locate, () => process.env)
  let authedUntil = 0
  return {
    locate,
    gh,
    forgetAuth: () => {
      authedUntil = 0
    },
    async state(): Promise<GhState> {
      if (Date.now() < authedUntil) return 'ready'
      if ((await locate()) === null) return 'missing'
      // `gh auth status` exits non-zero when no account is signed in; its output names hosts, never a token.
      const r = await gh(['auth', 'status'], process.cwd(), { timeoutMs: 15_000, allowExit: [1] }).catch((e: unknown) => {
        if (e instanceof GhError && e.message === 'gh not found') return null
        throw e
      })
      if (r === null) return 'missing'
      if (r.code !== 0) return 'logged-out'
      authedUntil = Date.now() + AUTH_TTL_MS
      return 'ready'
    }
  }
}
