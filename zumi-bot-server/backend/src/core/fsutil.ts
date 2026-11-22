import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

// Windows refuses a rename over a file another process has open (the search indexer, antivirus, an agent reading it) with
// EPERM, EBUSY or EACCES for a moment: retry briefly before giving up. Elsewhere the first error is final.
export async function renameRetrying(from: string, to: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (platform !== 'win32' || attempt >= 8 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw err
      await new Promise((r) => setTimeout(r, 15 * 2 ** attempt))
    }
  }
}

/**
 * Writes to a temp file next to the target, then renames over it. A symlinked target is followed (the link stays,
 * the real file is replaced) and an existing file keeps its mode. newFileMode is for secrets: the temp file is created
 * with it, so the content is never readable by others, not even briefly.
 */
export async function writeFileAtomic(path: string, data: string | Uint8Array, newFileMode?: number): Promise<void> {
  let target = path
  let mode: number | undefined
  try {
    target = await fs.realpath(path)
    mode = (await fs.stat(target)).mode & 0o7777
  } catch {
    /* new file */
  }
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    // Bytes (an image) are written as they are; only text gets an encoding.
    await fs.writeFile(tmp, data, typeof data === 'string' ? { encoding: 'utf8', mode: newFileMode } : { mode: newFileMode })
    // With newFileMode the result is never looser than it, even when the old file was.
    const finalMode = newFileMode ?? mode
    if (finalMode !== undefined) await fs.chmod(tmp, finalMode)
    await renameRetrying(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

/**
 * Whether p is dir or inside it. Through path.relative, which on Windows ignores letter case and takes either slash, as the
 * file system does: a prefix test on the strings would let `C:\Data` past a guard on `c:\data`.
 */
export function isInside(dir: string, p: string, strictly = false): boolean {
  const rel = relative(resolve(dir), resolve(p))
  if (rel === '') return !strictly
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

/** Returns the resolved path, or throws when it is not strictly inside dir. */
export function assertInside(dir: string, p: string): string {
  const root = resolve(dir)
  const full = resolve(p)
  if (!isInside(root, full, true)) throw new Error(`Path outside ${root}`)
  return full
}
