import { readdir, readFile, readlink } from 'node:fs/promises'

/** Claim only matching warnings within one completed step, checking its exact expected count. */
export function claimExpectedErrors(errors, start, end, pattern, count) {
  const found = []
  for (let i = start; i < end; i++) if (pattern.test(errors[i])) found.push(i)
  if (found.length !== count) throw new Error(`expected ${count} warnings matching ${pattern}, got ${found.length}`)
  return found
}

/** Use the ChildProcess handle, which knows whether its original process exited; never signal a saved PID. */
export function killOwnedChild(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

/**
 * The private IPC folders (`/tmp/cb-?-*`) whose socket `s` the live process `pid` holds, read from /proc (Linux), so a
 * suite that SIGKILLs a server can check the next server removed exactly those, whatever other servers run on the machine.
 */
export async function ipcDirsOf(pid) {
  const inodes = new Set()
  for (const fd of await readdir(`/proc/${pid}/fd`)) {
    const socket = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''))
    if (socket) inodes.add(socket[1])
  }
  const dirs = new Set()
  // Num RefCount Protocol Flags Type St Inode Path
  for (const line of (await readFile('/proc/net/unix', 'utf8')).split('\n').slice(1)) {
    const [, , , , , , inode, path] = line.trim().split(/\s+/)
    const dir = path && /^(\/tmp\/cb-[a-z]-[A-Za-z0-9]{6})\/s$/.exec(path)
    if (dir && inodes.has(inode)) dirs.add(dir[1])
  }
  return [...dirs].sort()
}
