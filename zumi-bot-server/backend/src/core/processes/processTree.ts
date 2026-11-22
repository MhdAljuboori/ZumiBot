import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { defaultBash, signalGroup } from '../procKill'

/** From SIGTERM to SIGKILL, and from SIGKILL to giving up on a kernel slow to reap. */
export const TERM_GRACE_MS = 5000
export const KILL_WAIT_MS = 2000

/**
 * Windows: the env var naming the background process a Git Bash process belongs to. A command's own `&` job is started by
 * a forked bash that has already exited, so the Windows parent link is gone and taskkill /T never reaches it; every
 * descendant still inherits this variable, which Git Bash shows in `/proc/<pid>/environ`.
 */
export const PROCESS_TAG_ENV = 'ZUMIBOT_PROCESS'

// Lists (or kills) every Git Bash process carrying the tag; taskkill /T on each also ends a native program it started.
// Builtins only (read, [ ]): a fork per process costs tens of milliseconds in Git Bash, so a scan with tr|grep took seconds.
const taggedScript = (tag: string, kill: boolean): string =>
  `for p in /proc/[0-9]*; do hit=; while IFS= read -r -d '' v; do [ "$v" = '${PROCESS_TAG_ENV}=${tag}' ] && { hit=1; break; }; ` +
  `done < "$p/environ" 2>/dev/null; [ -n "$hit" ] || continue; ` +
  (kill
    ? `read -r w < "$p/winpid" 2>/dev/null && taskkill //T //F //PID "$w" >/dev/null 2>&1; kill -KILL "\${p#/proc/}" 2>/dev/null; `
    : 'echo "${p#/proc/}"; ') +
  'done; true'

function runTagged(tag: string, kill: boolean): Promise<string> {
  // Only ids this server made (`p_<hex>`) reach the shell text.
  if (!/^[\w-]+$/.test(tag)) return Promise.resolve('')
  return new Promise((resolve) => {
    execFile(defaultBash(), ['-c', taggedScript(tag, kill)], { timeout: 10_000, windowsHide: true }, (_err, stdout) =>
      resolve(String(stdout ?? ''))
    )
  })
}

/** Windows: whether a Git Bash process of the background process `tag` is left. */
export const taggedAlive = async (tag: string): Promise<boolean> => (await runTagged(tag, false)).trim() !== ''

/** Windows: ends every Git Bash process of the background process `tag`, and the trees they started. */
export const killTagged = async (tag: string): Promise<void> => void (await runTagged(tag, true))

/**
 * Whether any process of the group is left. EPERM means one is, under another user (it cannot be ours to end). A zombie does not
 * count: an orphan whose parent became a PID 1 that never reaps (a container without an init) stays one for good. On Windows
 * the group is the leader and, with a `tag`, what still carries it.
 */
export async function groupAlive(pgid: number, tag?: string): Promise<boolean> {
  if (process.platform === 'win32') {
    try {
      signalGroup(pgid, 0)
      return true
    } catch {
      return tag !== undefined && (await taggedAlive(tag))
    }
  }
  try {
    signalGroup(pgid, 0)
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
  let entries: string[]
  try {
    entries = await readdir('/proc')
  } catch {
    return true
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8')
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
      if (Number(rest[2]) === pgid && rest[0] !== 'Z') return true
    } catch {
      /* gone meanwhile */
    }
  }
  return false
}

function signalTree(pgid: number, sig: NodeJS.Signals): void {
  try {
    signalGroup(pgid, sig)
  } catch {
    /* the group is gone */
  }
}

async function goneWithin(pgid: number, ms: number, tag?: string): Promise<boolean> {
  const until = Date.now() + ms
  while (await groupAlive(pgid, tag)) {
    if (Date.now() >= until) return false
    await new Promise((r) => setTimeout(r, 50))
  }
  return true
}

/**
 * Ends a whole process group: SIGTERM, then SIGKILL for what is left after the grace. Only ever a group this server made with
 * `detached: true` (its leader's pid is the group id), or one load() proved is still that same group (`procIdentity`).
 * Never pid 1 or the server's own group. On Windows (no signals, so no grace) it is taskkill on the leader's tree, then the
 * Git Bash processes still carrying `tag` (PROCESS_TAG_ENV).
 */
export async function endTree(pgid: number, o: { graceMs?: number; killWaitMs?: number; tag?: string } = {}): Promise<void> {
  if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid === process.pid) return
  if (process.platform === 'win32') {
    signalTree(pgid, 'SIGKILL')
    if (o.tag !== undefined) await killTagged(o.tag)
    await goneWithin(pgid, o.killWaitMs ?? KILL_WAIT_MS, o.tag)
    return
  }
  if (!(await groupAlive(pgid))) return
  signalTree(pgid, 'SIGTERM')
  if (await goneWithin(pgid, o.graceMs ?? TERM_GRACE_MS)) return
  signalTree(pgid, 'SIGKILL')
  await goneWithin(pgid, o.killWaitMs ?? KILL_WAIT_MS)
}

/** This boot's id (Linux), or null elsewhere: a pid from another boot names nothing of ours. */
export async function bootId(): Promise<string | null> {
  try {
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() || null
  } catch {
    return null
  }
}

/**
 * A process's start time in clock ticks since boot and its group id, from `/proc/<pid>/stat` (Linux), or null. The start time
 * tells a reused pid from ours; the command name (field 2) may hold spaces and parentheses, so the fields after its last `)`
 * are counted.
 */
export async function procIdentity(pid: number): Promise<{ startTicks: string; pgid: number } | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    // rest[0] is field 3 (state): pgrp is field 5, starttime field 22.
    const pgid = Number(rest[2]),
      startTicks = rest[19]
    return Number.isSafeInteger(pgid) && startTicks && /^\d+$/.test(startTicks) ? { startTicks, pgid } : null
  } catch {
    return null
  }
}
