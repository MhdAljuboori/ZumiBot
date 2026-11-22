import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdtemp, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

/** Windows has no socket files: the bridges and the control channel listen on named pipes there. */
export const usesPipes = (platform: NodeJS.Platform = process.platform): boolean => platform === 'win32'

/** A fresh, unguessable pipe name. The token handshake still guards it, as the 0700 folder guards a socket file. */
export function pipeName(kind: string): string {
  return `\\\\.\\pipe\\zumibot-${kind}-${randomBytes(12).toString('hex')}`
}

export const isPipePath = (path: string): boolean => path.startsWith('\\\\.\\pipe\\') || path.startsWith('\\\\?\\pipe\\')

/**
 * Where an IPC bridge listens: a socket `s` in a fresh private `/tmp/cb-<letter>-XXXXXX` folder (removed with `ownedDir` on
 * close), the given socket path, or on Windows a named pipe. A path whose folder is not this user's private one throws
 * `unavailable()`: never chmod, remove, or reuse an arbitrary existing socket or public directory.
 */
export async function ipcEndpoint(
  letter: string,
  given: string | undefined,
  unavailable: () => Error
): Promise<{ socketPath: string; ownedDir: string | null }> {
  if (usesPipes()) {
    if (given && !isPipePath(given)) throw unavailable()
    return { socketPath: given ?? pipeName(letter), ownedDir: null }
  }
  const ownedDir = given ? null : await mkdtemp(`/tmp/cb-${letter}-`)
  const socketPath = given ?? join(ownedDir!, 's')
  const directory = await lstat(dirname(socketPath))
  if (
    !isAbsolute(socketPath) ||
    Buffer.byteLength(socketPath) > 100 ||
    !directory.isDirectory() ||
    directory.isSymbolicLink() ||
    (directory.mode & 0o777) !== 0o700 ||
    directory.uid !== process.getuid?.()
  ) {
    if (ownedDir) await rm(ownedDir, { recursive: true, force: true })
    throw unavailable()
  }
  return { socketPath, ownedDir }
}

/** After listen(): a socket file becomes owner-only. A pipe has no mode bits; its name and the token handshake guard it. */
export async function secureEndpoint(socketPath: string): Promise<void> {
  if (!isPipePath(socketPath)) await chmod(socketPath, 0o600)
}
