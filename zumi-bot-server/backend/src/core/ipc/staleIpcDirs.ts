import { connect } from 'node:net'
import { lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The IPC bridges' private folders, `mkdtemp('/tmp/cb-<letter>-')` holding one socket `s`: browser, desktop, todos,
 * processes, vault, asks, automations and recall (`h`).
 */
export const IPC_DIR_NAME = /^cb-[abdhprtv]-[A-Za-z0-9]{6}$/
/** A contained turn's run folder (`ContainerRunner.open`): its auth and network proxies' sockets, mounted into the container. */
export const RUN_DIR_NAME = /^cb-c-[A-Za-z0-9]{6}$/
export const RUN_SOCKETS: readonly string[] = ['api.sock', 'net.sock']

interface Kind {
  name: RegExp
  /** The only entries the folder may hold, all sockets; any other entry keeps it. */
  sockets: readonly string[]
  mode?: number
}
const KINDS: readonly Kind[] = [
  // A bridge chmods its socket 0600 only after listen(), so one still being set up is not 0600.
  { name: IPC_DIR_NAME, sockets: ['s'], mode: 0o600 },
  // Never chmodded. Mounted read-write into the container, so an agent's file in it keeps the folder.
  { name: RUN_DIR_NAME, sockets: RUN_SOCKETS }
]

// A server between bind() and listen() refuses too (for microseconds: Node does both in one call); a second refusal this
// much later means nothing will listen.
const SETTLE_MS = 200
const PROBE_MS = 1000

/**
 * Removes the socket folders a server left in /tmp when it was SIGKILLed or crashed (close() and a turn's dispose() remove
 * them on a clean exit). Only a folder of this uid, 0700, holding nothing but its kind's sockets, each of this uid and each
 * refusing a connection twice: a live server answers, and other servers on the machine (the user's own, other test runs)
 * own those. Never throws; returns the count.
 */
export async function sweepStaleIpcDirs(options: { root?: string; uid?: number; settle?: () => Promise<void> } = {}): Promise<number> {
  const uid = options.uid ?? process.getuid?.()
  if (uid === undefined) return 0
  const root = options.root ?? '/tmp'
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return 0
  }
  // One at a time: a /tmp full of leftovers must not open hundreds of sockets at once.
  const refused: { dir: string; kind: Kind }[] = []
  for (const name of names) {
    const kind = KINDS.find((k) => k.name.test(name))
    if (!kind) continue
    const dir = join(root, name)
    if (await deadSockets(dir, kind, uid).catch(() => null)) refused.push({ dir, kind })
  }
  if (!refused.length) return 0
  await (options.settle ?? (() => new Promise<void>((resolve) => setTimeout(resolve, SETTLE_MS))))()
  let removed = 0
  for (const { dir, kind } of refused) {
    try {
      const sockets = await deadSockets(dir, kind, uid)
      if (!sockets) continue
      // rmdir, not rm -r: anything that appeared since the checks keeps the folder.
      for (const socket of sockets) await unlink(socket)
      await rmdir(dir)
      removed++
    } catch {
      // Gone already (a closing server removes its own), changed, or not ours: leave it.
    }
  }
  return removed
}

/** The folder's socket paths when every check passes and every one refuses a connection, else null. */
async function deadSockets(dir: string, kind: Kind, uid: number): Promise<string[] | null> {
  const folder = await lstat(dir)
  if (!folder.isDirectory() || folder.uid !== uid || (folder.mode & 0o777) !== 0o700) return null
  const entries = await readdir(dir)
  if (!entries.length || entries.some((e) => !kind.sockets.includes(e))) return null
  const paths = entries.map((e) => join(dir, e))
  for (const path of paths) {
    const socket = await lstat(path)
    if (!socket.isSocket() || socket.uid !== uid) return null
    if (kind.mode !== undefined && (socket.mode & 0o777) !== kind.mode) return null
  }
  // Only a refusal means nothing listens; a full backlog (EAGAIN), a timeout or any other error keeps the folder.
  for (const path of paths) if ((await probe(path)) !== 'ECONNREFUSED') return null
  return paths
}

function probe(path: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(path)
    const done = (result: string) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => done('timeout'), PROBE_MS)
    socket.once('connect', () => done('connect'))
    socket.once('error', (err: NodeJS.ErrnoException) => done(err.code ?? 'error'))
  })
}
