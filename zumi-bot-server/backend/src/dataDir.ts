import { chmod, mkdir, stat } from 'node:fs/promises'

/** The folder holds auth.json and every chat, so nobody else on the machine gets in. */
export async function ensureDataDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // mkdir leaves an existing folder alone, so tighten one that was made looser earlier (only if it is ours to change).
  try {
    const st = await stat(dir)
    if (st.uid === process.getuid?.() && (st.mode & 0o077) !== 0) await chmod(dir, 0o700)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err
  }
}
