import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { listDirs, makeDir } from '../../src/core/folders'

let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-folders-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

describe('listDirs', () => {
  it('lists only directories, sorted, hidden ones included', async () => {
    for (const d of ['b', 'a', '.git']) await fs.mkdir(join(root, d))
    await fs.writeFile(join(root, 'file.txt'), 'x')
    const r = await listDirs(root, '/home/x')
    expect(r.dirs).toEqual(['.git', 'a', 'b'])
    expect(r.path).toBe(root)
  })

  it('parent of / is null', async () => {
    const r = await listDirs('/', '/home/x')
    expect(r.parent).toBeNull()
    expect((await listDirs(root, '/home/x')).parent).toBe(os.tmpdir())
  })

  it('null path means home', async () => {
    const r = await listDirs(null, root)
    expect(r.path).toBe(root)
  })

  it('skips unreadable children', async () => {
    await fs.mkdir(join(root, 'ok'))
    // stat fails on a dangling link; a junction (the type only Windows reads) needs no privilege there
    await fs.symlink(join(root, 'missing'), join(root, 'broken'), 'junction')
    const r = await listDirs(root, '/home/x')
    expect(r.dirs).toEqual(['ok'])
  })

  it('rejects a path that is not a directory', async () => {
    const f = join(root, 'f.txt')
    await fs.writeFile(f, 'x')
    await expect(listDirs(f, '/home/x')).rejects.toThrow(`Not a folder: ${f}`)
    await expect(listDirs(join(root, 'nope'), '/home/x')).rejects.toThrow(/Not a folder/)
  })
})

describe('makeDir', () => {
  it('rejects names with / or that are . or ..', async () => {
    for (const n of ['a/b', '.', '..', '']) await expect(makeDir(root, n)).rejects.toThrow(/Invalid folder name/)
  })

  it('rejects a relative parent', async () => {
    await expect(makeDir('rel/dir', 'x')).rejects.toThrow(/absolute/)
  })

  it('returns the new absolute path', async () => {
    const p = await makeDir(root, 'new')
    expect(p).toBe(join(root, 'new'))
    expect((await fs.stat(p)).isDirectory()).toBe(true)
  })
})
