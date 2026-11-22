import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'

/** A failed git call. The message is one line of git's stderr (its fatal or error line, else the first), never the env. */
export class GitError extends Error {}

export interface GitResult {
  stdout: string
  code: number
}
export type Git = (args: string[], cwd: string, o?: { timeoutMs?: number; allowExit?: number[] }) => Promise<GitResult>

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_BUFFER = 16 * 1024 * 1024

/** `execFile` with no shell: every argument stays one argument, whatever it holds. */
export function makeGit(env: () => NodeJS.ProcessEnv): Git {
  return (args, cwd, o = {}) =>
    new Promise<GitResult>((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd, env: env(), timeout: o.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (!err) return resolve({ stdout, code: 0 })
          const e = err as NodeJS.ErrnoException & { killed?: boolean }
          if (e.code === 'ENOENT') {
            // A missing cwd raises the same ENOENT as a missing binary.
            return void stat(cwd).then(
              () => reject(new GitError('git not found')),
              () => reject(new GitError('Folder not found'))
            )
          }
          if (typeof e.code === 'number') {
            if (o.allowExit?.includes(e.code)) return resolve({ stdout, code: e.code })
            // git often opens with progress lines ("Preparing worktree ..."): the reason is the fatal or error line.
            const lines = stderr
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
            const first = lines.find((l) => /^(fatal|error):/.test(l)) ?? lines[0]
            return reject(new GitError(first ?? `git exited with code ${e.code}`))
          }
          if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new GitError('git output too large'))
          if (e.killed) return reject(new GitError('git timed out'))
          reject(new GitError('git failed'))
        }
      )
    })
}
