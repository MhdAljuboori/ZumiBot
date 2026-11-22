import { constants, promises as fs } from 'node:fs'
import { join } from 'node:path'

// chats.json is also the "already migrated" marker, so it goes last: a copy cut short leaves no marker and a rerun finishes it.
// Only what the server keeps; the desktop's window state and Electron's own files stay behind.
const ENTRIES = ['chats', 'settings.json', 'usage.json', 'attachments', 'chats.json']

interface Ops {
  copyFile(from: string, to: string, mode?: number): Promise<void>
  link(existing: string, to: string): Promise<void>
}

// Filesystems without hard links (FAT, some FUSE/SMB) refuse link() with one of these.
const NO_LINKS = new Set(['EPERM', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EOPNOTSUPP'])
const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  )

// Merges file by file; a file already in the target is left alone. Returns whether anything was copied.
async function merge(from: string, to: string, ops: Ops): Promise<boolean> {
  const st = await fs.lstat(from) // not followed: a dangling symlink, socket or fifo is skipped, never fatal
  if (!st.isDirectory() && !st.isFile()) return false
  if (st.isDirectory()) {
    await fs.mkdir(to, { recursive: true, mode: 0o700 })
    let any = false
    for (const name of await fs.readdir(from)) any = (await merge(join(from, name), join(to, name), ops)) || any
    return any
  }
  try {
    await ops.copyFile(from, to, constants.COPYFILE_EXCL)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

// Copied under a temp name and linked into place only when whole, so a kill mid-copy never leaves a truncated marker.
async function copyMarker(from: string, to: string, ops: Ops): Promise<boolean> {
  const tmp = `${to}.tmp-${process.pid}`
  try {
    await ops.copyFile(from, tmp)
    try {
      await ops.link(tmp, to) // fails when a chats.json appeared meanwhile: never replaced
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return false
      if (!code || !NO_LINKS.has(code)) throw err
      // No hard links here. The data lock is held, so checking then renaming (atomic) is safe.
      if (await exists(to)) return false
      await fs.rename(tmp, to)
    }
    return true
  } finally {
    await fs.rm(tmp, { force: true })
  }
}

/** One-time copy of the desktop app's data. Never touches `from`, never replaces anything already in `to`. */
export async function migrateFromDesktop(from: string, to: string, ops: Partial<Ops> = {}): Promise<string[]> {
  for (const n of await fs.readdir(to).catch(() => [] as string[])) {
    if (n.startsWith('chats.json.tmp-')) await fs.rm(join(to, n), { force: true }) // a cut-short earlier attempt
  }
  if (await exists(join(to, 'chats.json'))) return []
  const io: Ops = {
    copyFile: ops.copyFile ?? ((a, b, m) => fs.copyFile(a, b, m)),
    link: ops.link ?? ((a, b) => fs.link(a, b))
  }
  const copied: string[] = []
  for (const name of ENTRIES) {
    if (!(await exists(join(from, name)))) continue
    await fs.mkdir(to, { recursive: true, mode: 0o700 })
    const done =
      name === 'chats.json' ? await copyMarker(join(from, name), join(to, name), io) : await merge(join(from, name), join(to, name), io)
    if (done) copied.push(name)
  }
  return copied
}
