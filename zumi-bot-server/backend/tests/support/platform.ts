import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Platform facts tests gate on. Windows has no mode bits, no /proc, no signals beyond a hard kill, and creates symlinks
// only with Developer Mode or as an administrator (a directory junction needs neither).

export const isWindows = process.platform === 'win32'
export const isLinux = process.platform === 'linux'

/** Whether this process may create a file symlink: always on POSIX, on Windows only with the privilege. */
export const symlinksWork: boolean = (() => {
  if (!isWindows) return true
  const dir = mkdtempSync(join(tmpdir(), 'zb-symlink-probe-'))
  try {
    writeFileSync(join(dir, 'f'), '')
    symlinkSync(join(dir, 'f'), join(dir, 'l'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})()

/**
 * Removes a test's temp folder. On Windows a fake CLI's exe in it can stay locked for seconds after its process ends (the
 * kill is asynchronous, and Defender scans every new exe), so it retries for up to 8 s (under the 10 s hook timeout) and then only warns: a leftover
 * temp folder says nothing about the code under test. Elsewhere the first error is thrown, as rmSync would.
 */
export function removeDir(dir: string): void {
  if (!isWindows) return rmSync(dir, { recursive: true, force: true })
  const until = Date.now() + 8_000
  for (;;) {
    try {
      return rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if ((code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') || Date.now() > until) {
        if (code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY') return console.warn(`temp folder left behind: ${dir} (${code})`)
        throw err
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
    }
  }
}
