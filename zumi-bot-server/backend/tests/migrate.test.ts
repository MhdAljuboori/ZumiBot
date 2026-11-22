import { createHash } from 'node:crypto'
import { copyFile, symlink, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateFromDesktop } from '../src/migrate'
import { symlinksWork } from './support/platform'

let root: string
let from: string
let to: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cb-mig-'))
  from = join(root, 'from')
  to = join(root, 'to')
  await mkdir(from)
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function hashTree(dir: string): Promise<string> {
  const h = createHash('sha256')
  const walk = async (d: string): Promise<void> => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, e.name)
      const st = await stat(p)
      h.update(`${p}:${st.mode}:${st.mtimeMs}\n`)
      if (e.isDirectory()) await walk(p)
      else h.update(await readFile(p))
    }
  }
  await walk(dir)
  return h.digest('hex')
}

async function seed(): Promise<void> {
  await writeFile(join(from, 'chats.json'), '[{"id":"a"}]')
  await mkdir(join(from, 'chats'))
  await writeFile(join(from, 'chats', 'a.json'), '[]')
  await writeFile(join(from, 'settings.json'), '{"theme":"dark"}')
  await mkdir(join(from, 'attachments', 'a', 'x'), { recursive: true })
  await writeFile(join(from, 'attachments', 'a', 'x', 'f.png'), Buffer.from([1, 2, 3]))
  await writeFile(join(from, 'window-state.json'), '{}') // desktop-only: never copied
  await writeFile(join(from, 'Cookies'), 'electron junk')
}

describe('migrateFromDesktop', () => {
  it('copies existing entries only', async () => {
    await seed() // no usage.json
    await mkdir(to)
    const copied = await migrateFromDesktop(from, to)
    expect(copied.sort()).toEqual(['attachments', 'chats', 'chats.json', 'settings.json'])
    expect((await readdir(to)).sort()).toEqual(['attachments', 'chats', 'chats.json', 'settings.json'])
    expect(await readFile(join(to, 'attachments', 'a', 'x', 'f.png'))).toEqual(Buffer.from([1, 2, 3]))
  })

  it('creates the target when it is missing', async () => {
    await seed()
    await migrateFromDesktop(from, to)
    expect(await readFile(join(to, 'chats.json'), 'utf8')).toBe('[{"id":"a"}]')
  })

  it('source tree unchanged byte-for-byte (hash before/after)', async () => {
    await seed()
    const before = await hashTree(from)
    await migrateFromDesktop(from, to)
    expect(await hashTree(from)).toBe(before)
  })

  it('skips when target chats.json exists', async () => {
    await seed()
    await mkdir(to)
    await writeFile(join(to, 'chats.json'), '[]')
    expect(await migrateFromDesktop(from, to)).toEqual([])
    expect(await readdir(to)).toEqual(['chats.json'])
  })

  it('never overwrites a target file', async () => {
    await seed()
    await mkdir(to)
    await writeFile(join(to, 'settings.json'), '{"theme":"light"}')
    const copied = await migrateFromDesktop(from, to) // the clash is skipped, the rest still comes over
    expect(copied).not.toContain('settings.json')
    expect(await readFile(join(to, 'settings.json'), 'utf8')).toBe('{"theme":"light"}')
  })

  it('a missing source copies nothing', async () => {
    expect(await migrateFromDesktop(join(root, 'nope'), to)).toEqual([])
  })

  it('chats.json is copied last: a failure before it leaves no marker, and a rerun completes', async () => {
    await seed()
    const failing = async (a: string, b: string, mode?: number): Promise<void> => {
      if (b.endsWith('settings.json')) throw new Error('disk full')
      return copyFile(a, b, mode)
    }
    await expect(migrateFromDesktop(from, to, { copyFile: failing })).rejects.toThrow('disk full')
    await expect(stat(join(to, 'chats.json'))).rejects.toThrow()
    const copied = await migrateFromDesktop(from, to)
    expect(copied).toContain('chats.json')
    expect(copied).toContain('settings.json')
    expect(await readFile(join(to, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(await readFile(join(to, 'chats.json'), 'utf8')).toBe('[{"id":"a"}]')
  })

  it('failure leaves the source byte-identical', async () => {
    await seed()
    const before = await hashTree(from)
    await migrateFromDesktop(from, to, {
      copyFile: async () => {
        throw new Error('x')
      }
    }).catch(() => {})
    expect(await hashTree(from)).toBe(before)
  })

  it('a partly existing target merges file by file without clobbering', async () => {
    await seed()
    await mkdir(join(to, 'chats'), { recursive: true })
    await writeFile(join(to, 'chats', 'a.json'), 'KEEP')
    await mkdir(join(from, 'chats'), { recursive: true })
    await writeFile(join(from, 'chats', 'b.json'), '[1]')
    const copied = await migrateFromDesktop(from, to)
    expect(await readFile(join(to, 'chats', 'a.json'), 'utf8')).toBe('KEEP')
    expect(await readFile(join(to, 'chats', 'b.json'), 'utf8')).toBe('[1]')
    expect(copied).toContain('chats')
    expect(copied.at(-1)).toBe('chats.json')
  })

  it('a stray partial chats.json.tmp-* is cleaned and the rerun completes', async () => {
    await seed()
    await mkdir(to)
    await writeFile(join(to, 'chats.json.tmp-123'), '[{"id":"tr')
    const copied = await migrateFromDesktop(from, to)
    expect(copied.at(-1)).toBe('chats.json')
    expect(await readFile(join(to, 'chats.json'), 'utf8')).toBe('[{"id":"a"}]')
    expect((await readdir(to)).filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  it('a failure during the chats.json copy leaves no chats.json, and a rerun completes', async () => {
    await seed()
    const before = await hashTree(from)
    const failing = async (a: string, b: string, mode?: number): Promise<void> => {
      if (b.includes('chats.json')) {
        await writeFile(b, '[{"id":"tr') // a truncated copy, as a kill or ENOSPC would leave
        throw new Error('ENOSPC')
      }
      return copyFile(a, b, mode)
    }
    await expect(migrateFromDesktop(from, to, { copyFile: failing })).rejects.toThrow('ENOSPC')
    await expect(stat(join(to, 'chats.json'))).rejects.toThrow()
    expect(await hashTree(from)).toBe(before)
    await migrateFromDesktop(from, to)
    expect(await readFile(join(to, 'chats.json'), 'utf8')).toBe('[{"id":"a"}]')
    expect((await readdir(to)).filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  it.skipIf(!symlinksWork)('a dangling symlink in the source is skipped, not followed', async () => {
    await seed()
    await symlink(join(root, 'nowhere'), join(from, 'chats', 'dangling.json'))
    const copied = await migrateFromDesktop(from, to)
    expect(copied).toContain('chats.json')
    expect((await readdir(join(to, 'chats'))).sort()).toEqual(['a.json'])
  })

  it('falls back to rename when the filesystem has no hard links', async () => {
    await seed()
    const noLinks = async (): Promise<void> => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    }
    const copied = await migrateFromDesktop(from, to, { link: noLinks })
    expect(copied.at(-1)).toBe('chats.json')
    expect(await readFile(join(to, 'chats.json'), 'utf8')).toBe('[{"id":"a"}]')
    expect((await readdir(to)).filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  it('the no-links fallback never replaces a chats.json that appeared meanwhile', async () => {
    await seed()
    const racing = async (): Promise<void> => {
      await writeFile(join(to, 'chats.json'), 'NEW')
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
    }
    const copied = await migrateFromDesktop(from, to, { link: racing })
    expect(copied).not.toContain('chats.json')
    expect(await readFile(join(to, 'chats.json'), 'utf8')).toBe('NEW')
    expect((await readdir(to)).filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  it('stray chats.json.tmp-* is removed even when chats.json already exists', async () => {
    await seed()
    await mkdir(to)
    await writeFile(join(to, 'chats.json'), '[]')
    await writeFile(join(to, 'chats.json.tmp-9'), 'x')
    expect(await migrateFromDesktop(from, to)).toEqual([])
    expect((await readdir(to)).sort()).toEqual(['chats.json'])
  })
})
