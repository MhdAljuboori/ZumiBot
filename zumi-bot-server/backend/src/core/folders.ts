import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { DirListing } from '@zumibot/shared/types'

/** The folders inside `path` (null = home), hidden ones included, for the folder browser. */
export async function listDirs(path: string | null, home: string): Promise<DirListing> {
  const abs = resolve(path ?? home)
  const isDir = await fs.stat(abs).then(
    (s) => s.isDirectory(),
    () => false
  )
  if (!isDir) throw new Error(`Not a folder: ${abs}`)
  const entries = await fs.readdir(abs, { withFileTypes: true })
  const checked = await Promise.all(
    entries.map(async (e) => {
      if (e.isDirectory()) return e.name
      if (!e.isSymbolicLink()) return null
      // A link to a folder counts; a dangling one is skipped.
      return (await fs.stat(join(abs, e.name)).then(
        (s) => s.isDirectory(),
        () => false
      ))
        ? e.name
        : null
    })
  )
  const dirs = checked.filter((n): n is string => n !== null).sort()
  const parent = dirname(abs)
  return { path: abs, parent: parent === abs ? null : parent, dirs }
}

export async function makeDir(parent: string, name: string): Promise<string> {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new Error(`Invalid folder name: ${name}`)
  }
  if (!isAbsolute(parent)) throw new Error(`Parent must be an absolute path: ${parent}`)
  const path = join(resolve(parent), name)
  await fs.mkdir(path)
  return path
}
