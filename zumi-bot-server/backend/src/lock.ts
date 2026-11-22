import { execFile } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'

export type Release = (() => Promise<void>) & { sync(): void }

// Dirs this process holds: our own pid in a lock file only means "stale" when we do not hold it ourselves.
const held = new Set<string>()

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM' // exists, just not ours
  }
}

/**
 * Start time of a process (/proc/<pid>/stat field 22; on a Mac, which has no /proc, `ps -o lstart=` with its spaces
 * made `_`, since the lock file splits on whitespace), or null where neither answers. A reused pid has another one.
 */
export async function processStart(pid: number): Promise<string | null> {
  if (process.platform === 'darwin') {
    return new Promise((resolve) =>
      execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000 }, (err, out) => {
        const t = err ? '' : out.trim().replace(/\s+/g, '_')
        resolve(t || null)
      })
    )
  }
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    // The name (field 2) may hold spaces and parentheses, so count from the last ")": field 3 is next.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null
  } catch {
    return null
  }
}

/** One server per data folder: a second one would recover (and mark interrupted) the first one's live chats. */
export async function acquireDataLock(dataDir: string): Promise<Release> {
  const file = join(dataDir, 'server.lock')
  const busy = (): Error => new Error(`Another ZumiBot server is using ${dataDir}`)
  if (held.has(dataDir)) throw busy()
  const start = await processStart(process.pid)
  const mine = start ? `${process.pid} ${start}\n` : `${process.pid}\n`
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await fs.writeFile(file, mine, { flag: 'wx', mode: 0o600 })
      held.add(dataDir)
      const sync = (): void => {
        held.delete(dataDir)
        // Only our own file: it may have been taken over after we were thought dead.
        try {
          if (readFileSync(file, 'utf8') === mine) rmSync(file, { force: true })
        } catch {
          /* already gone */
        }
      }
      return Object.assign(async () => sync(), { sync })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const [pidText = '', recorded] = (await fs.readFile(file, 'utf8').catch(() => '')).trim().split(/\s+/)
    const pid = Number.parseInt(pidText, 10)
    const live = Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)
    const current = live ? await processStart(pid) : null
    // Dead pid, our own pid from an earlier run, or a pid since reused by another process: stale.
    if (live && !(recorded && current && recorded !== current)) throw busy()
    await fs.rm(file, { force: true })
  }
  throw busy()
}
