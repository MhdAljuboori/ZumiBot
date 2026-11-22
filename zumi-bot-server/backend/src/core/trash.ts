import { promises as fs } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'

const pad = (n: number): string => String(n).padStart(2, '0')

function stamp(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** Moves across devices, where rename fails with EXDEV. */
async function move(from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false })
    await fs.rm(from, { recursive: true, force: true })
  }
}

/** Freedesktop trash: files/ holds the item, info/<name>.trashinfo says where it came from. */
export async function trashPath(path: string, home: string, now: () => Date): Promise<void> {
  const abs = resolve(path)
  const trash = join(home, '.local', 'share', 'Trash')
  const files = join(trash, 'files')
  const info = join(trash, 'info')
  await fs.mkdir(files, { recursive: true })
  await fs.mkdir(info, { recursive: true })

  const ext = extname(abs)
  const stem = basename(abs, ext)
  for (let i = 1; ; i++) {
    const name = i === 1 ? basename(abs) : `${stem}.${i}${ext}`
    const infoFile = join(info, `${name}.trashinfo`)
    try {
      // 'wx' claims the name atomically, so two trashes never pick the same one.
      await fs.writeFile(
        infoFile,
        `[Trash Info]\nPath=${abs.split('/').map(encodeURIComponent).join('/')}\nDeletionDate=${stamp(now())}\n`,
        { flag: 'wx' }
      )
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw err
    }
    const dest = join(files, name)
    if (
      await fs.lstat(dest).then(
        () => true,
        () => false
      )
    ) {
      await fs.rm(infoFile, { force: true })
      continue
    }
    try {
      await move(abs, dest)
    } catch (err) {
      await fs.rm(infoFile, { force: true })
      throw err
    }
    return
  }
}
