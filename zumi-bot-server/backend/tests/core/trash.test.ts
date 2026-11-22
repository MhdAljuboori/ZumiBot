import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { trashPath } from '../../src/core/trash'

let home: string
let src: string
const now = () => new Date(2026, 9, 25, 9, 5, 7)
const trash = () => join(home, '.local/share/Trash')

beforeEach(async () => {
  home = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-trash-'))
  src = join(home, 'work')
  await fs.mkdir(src)
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

describe('trashPath', () => {
  it('moves the file to <home>/.local/share/Trash/files/<name>', async () => {
    const f = join(src, 'a.md')
    await fs.writeFile(f, 'hi')
    await trashPath(f, home, now)
    expect(await fs.readFile(join(trash(), 'files/a.md'), 'utf8')).toBe('hi')
    await expect(fs.stat(f)).rejects.toThrow()
  })

  it('writes Trash/info/<name>.trashinfo with Path and DeletionDate', async () => {
    const f = join(src, 'my agent.md')
    await fs.writeFile(f, 'hi')
    await trashPath(f, home, now)
    const info = await fs.readFile(join(trash(), 'info/my agent.md.trashinfo'), 'utf8')
    expect(info).toBe(`[Trash Info]\nPath=${f.split('/').map(encodeURIComponent).join('/')}\nDeletionDate=2026-10-25T09:05:07\n`)
    expect(info).toContain('my%20agent.md')
  })

  it('a second file with the same name gets <stem>.2<ext>', async () => {
    const f = join(src, 'a.md')
    await fs.writeFile(f, 'one')
    await trashPath(f, home, now)
    await fs.writeFile(f, 'two')
    await trashPath(f, home, now)
    expect(await fs.readFile(join(trash(), 'files/a.2.md'), 'utf8')).toBe('two')
    expect(await fs.readFile(join(trash(), 'info/a.2.md.trashinfo'), 'utf8')).toContain('Path=')
  })

  it('moves a folder too', async () => {
    const d = join(src, 'agent')
    await fs.mkdir(d)
    await fs.writeFile(join(d, 'x.md'), 'x')
    await trashPath(d, home, now)
    expect(await fs.readFile(join(trash(), 'files/agent/x.md'), 'utf8')).toBe('x')
  })
})
