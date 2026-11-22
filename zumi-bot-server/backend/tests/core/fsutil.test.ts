import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { isInside, writeFileAtomic } from '../../src/core/fsutil'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-fsutil-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

// POSIX file modes and symlinks: Windows has neither (every mode reads 0o666; a symlink needs admin rights).
const posixIt = it.skipIf(process.platform === 'win32')

describe('writeFileAtomic', () => {
  it('creates and overwrites a file without leaving temp files', async () => {
    const p = join(dir, 'a.md')
    await writeFileAtomic(p, 'one')
    await writeFileAtomic(p, 'two')
    expect(await fs.readFile(p, 'utf8')).toBe('two')
    expect(await fs.readdir(dir)).toEqual(['a.md'])
  })

  posixIt('keeps a symlink a symlink and updates the real file', async () => {
    const real = join(dir, 'dotfiles', 'real.md')
    const link = join(dir, 'link.md')
    await fs.mkdir(join(dir, 'dotfiles'))
    await fs.writeFile(real, 'old')
    await fs.symlink(real, link)
    await writeFileAtomic(link, 'new')
    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(real, 'utf8')).toBe('new')
    expect(await fs.readdir(join(dir, 'dotfiles'))).toEqual(['real.md'])
  })

  posixIt('preserves the existing file mode', async () => {
    const p = join(dir, 'm.md')
    await fs.writeFile(p, 'x')
    await fs.chmod(p, 0o600)
    await writeFileAtomic(p, 'y')
    if (process.platform !== 'win32') expect((await fs.stat(p)).mode & 0o777).toBe(0o600)
  })
})

describe('writeFileAtomic newFileMode', () => {
  posixIt('creates a new file with that mode', async () => {
    const p = join(dir, 'new.json')
    await writeFileAtomic(p, 'x', 0o600)
    if (process.platform !== 'win32') expect((await fs.stat(p)).mode & 0o777).toBe(0o600)
  })

  posixIt('tightens an existing looser file instead of inheriting its mode', async () => {
    const p = join(dir, 'old.json')
    await fs.writeFile(p, 'x', { mode: 0o644 })
    await fs.chmod(p, 0o644)
    await writeFileAtomic(p, 'y', 0o600)
    if (process.platform !== 'win32') expect((await fs.stat(p)).mode & 0o777).toBe(0o600)
    expect(await fs.readFile(p, 'utf8')).toBe('y')
  })
})

describe('writeFileAtomic bytes', () => {
  it('writes a Uint8Array byte for byte, as a PNG needs', async () => {
    const p = join(dir, 'b.png')
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x80])
    await writeFileAtomic(p, bytes, 0o600)
    expect([...(await fs.readFile(p))]).toEqual([...bytes])
    if (process.platform !== 'win32') expect((await fs.stat(p)).mode & 0o777).toBe(0o600)
  })
})

describe('isInside', () => {
  const root = join(os.tmpdir(), 'zb-inside')
  it('accepts the dir itself and anything below, and nothing beside it', () => {
    expect(isInside(root, root)).toBe(true)
    expect(isInside(root, root, true)).toBe(false)
    expect(isInside(root, join(root, 'a', 'b'))).toBe(true)
    expect(isInside(root, root + '-sibling')).toBe(false)
    expect(isInside(root, join(root, '..', 'x'))).toBe(false)
  })
  it.runIf(process.platform === 'win32')('ignores letter case on Windows, as NTFS does', () => {
    expect(isInside(root.toUpperCase(), join(root.toLowerCase(), 'a'))).toBe(true)
  })
})
