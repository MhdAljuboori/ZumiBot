import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '../../src/core/store/settingsStore'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(join(os.tmpdir(), 'zumibot-settings-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('SettingsStore', () => {
  it('defaults on empty dir', async () => {
    expect(await new SettingsStore(dir).get()).toEqual({
      claudePath: null,
      lastFolderByAgent: {},
      theme: 'system',
      accent: 'blue',
      lastGroupFolder: null,
      houseStyle: true,
      keepWarm: { roomHours: 12, chatHours: 2 },
      worktreeFolders: []
    })
  })
  // A passing read error used to read as defaults, and the next write then wiped the user's real settings.
  // chmod 0 only clears the read-only flag on Windows: the file stays readable.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'a read error other than a missing file fails, and set leaves the file alone',
    async () => {
      const s = new SettingsStore(dir)
      await s.set({ claudePath: '/bin/claude' })
      const file = join(dir, 'settings.json')
      await fs.chmod(file, 0o000)
      try {
        await expect(s.get()).rejects.toMatchObject({ code: 'EACCES' })
        await expect(s.set({ theme: 'dark' })).rejects.toMatchObject({ code: 'EACCES' })
      } finally {
        await fs.chmod(file, 0o600)
      }
      expect((await s.get()).claudePath).toBe('/bin/claude')
    }
  )
  it('a corrupt or non-object file reads as defaults', async () => {
    for (const text of ['{', 'null', '[1]']) {
      await fs.writeFile(join(dir, 'settings.json'), text)
      expect((await new SettingsStore(dir).get()).claudePath).toBeNull()
    }
  })
  it('setLastFolder persists and set patches', async () => {
    const s = new SettingsStore(dir)
    await s.setLastFolder('a', '/x')
    await s.set({ claudePath: '/bin/claude' })
    expect(await new SettingsStore(dir).get()).toEqual({
      claudePath: '/bin/claude',
      lastFolderByAgent: { a: '/x' },
      theme: 'system',
      accent: 'blue',
      lastGroupFolder: null,
      houseStyle: true,
      keepWarm: { roomHours: 12, chatHours: 2 },
      worktreeFolders: []
    })
  })
  it('renameAgent moves the key', async () => {
    const s = new SettingsStore(dir)
    await s.setLastFolder('a', '/x')
    await s.renameAgent('a', 'b')
    expect((await s.get()).lastFolderByAgent).toEqual({ b: '/x' })
  })
  it('corrupt file falls back to defaults', async () => {
    await fs.writeFile(join(dir, 'settings.json'), '{oops')
    expect(await new SettingsStore(dir).get()).toEqual({
      claudePath: null,
      lastFolderByAgent: {},
      theme: 'system',
      accent: 'blue',
      lastGroupFolder: null,
      houseStyle: true,
      keepWarm: { roomHours: 12, chatHours: 2 },
      worktreeFolders: []
    })
  })
  it('set theme persists and keeps other keys', async () => {
    const s = new SettingsStore(dir)
    await s.setLastFolder('a', '/x')
    await s.set({ theme: 'dark' })
    expect(await new SettingsStore(dir).get()).toEqual({
      claudePath: null,
      lastFolderByAgent: { a: '/x' },
      theme: 'dark',
      accent: 'blue',
      lastGroupFolder: null,
      houseStyle: true,
      keepWarm: { roomHours: 12, chatHours: 2 },
      worktreeFolders: []
    })
  })
  it('keep warm defaults to 12 h for rooms and 2 h for chats, and keeps only offered hours', async () => {
    const s = new SettingsStore(dir)
    expect((await s.get()).keepWarm).toEqual({ roomHours: 12, chatHours: 2 })
    await s.set({ keepWarm: { roomHours: 4, chatHours: 0 } })
    expect((await new SettingsStore(dir).get()).keepWarm).toEqual({ roomHours: 4, chatHours: 0 })
    await fs.writeFile(join(dir, 'settings.json'), '{"keepWarm":{"roomHours":7}}')
    expect((await new SettingsStore(dir).get()).keepWarm).toEqual({ roomHours: 12, chatHours: 2 })
  })
  it('house style is on by default, persists off, and anything but false reads as on', async () => {
    const s = new SettingsStore(dir)
    await s.set({ houseStyle: false })
    expect((await new SettingsStore(dir).get()).houseStyle).toBe(false)
    await fs.writeFile(join(dir, 'settings.json'), '{"claudePath":"/c"}')
    expect((await new SettingsStore(dir).get()).houseStyle).toBe(true)
    await fs.writeFile(join(dir, 'settings.json'), '{"houseStyle":"no"}')
    expect((await new SettingsStore(dir).get()).houseStyle).toBe(true)
  })

  it('accent is blue by default, persists a pick, and an unknown one reads as blue', async () => {
    const s = new SettingsStore(dir)
    expect((await s.get()).accent).toBe('blue')
    await s.set({ accent: 'teal' })
    expect((await new SettingsStore(dir).get()).accent).toBe('teal')
    for (const bad of ['"purple"', '"TEAL"', '3']) {
      await fs.writeFile(join(dir, 'settings.json'), `{"accent":${bad}}`)
      expect((await new SettingsStore(dir).get()).accent).toBe('blue')
    }
  })

  it('invalid theme falls back to system', async () => {
    for (const bad of ['"DARK"', '5']) {
      await fs.writeFile(join(dir, 'settings.json'), `{"claudePath":"/c","theme":${bad}}`)
      expect(await new SettingsStore(dir).get()).toEqual({
        claudePath: '/c',
        lastFolderByAgent: {},
        theme: 'system',
        accent: 'blue',
        lastGroupFolder: null,
        houseStyle: true,
        keepWarm: { roomHours: 12, chatHours: 2 },
        worktreeFolders: []
      })
    }
  })
  it('remembers the last group folder', async () => {
    const s = new SettingsStore(dir)
    await s.setLastGroupFolder('/g')
    expect((await new SettingsStore(dir).get()).lastGroupFolder).toBe('/g')
  })
  it('stored lastGroupFolder string round-trips and non-string falls back to null', async () => {
    await fs.writeFile(join(dir, 'settings.json'), '{"lastGroupFolder":"/g"}')
    expect((await new SettingsStore(dir).get()).lastGroupFolder).toBe('/g')
    for (const bad of ['5', '{}', 'null']) {
      await fs.writeFile(join(dir, 'settings.json'), `{"lastGroupFolder":${bad}}`)
      expect((await new SettingsStore(dir).get()).lastGroupFolder).toBeNull()
    }
  })
  it("keeps the user's time zone, ignores a bad, long or unchanged one, and has none by default", async () => {
    const s = new SettingsStore(dir)
    expect(await s.timeZone()).toBeNull()
    await s.setTimeZone('Europe/Istanbul')
    expect(await new SettingsStore(dir).timeZone()).toBe('Europe/Istanbul')
    await s.setTimeZone('Not/AZone')
    await s.setTimeZone('Europe/' + 'x'.repeat(64))
    await s.setTimeZone('')
    expect(await s.timeZone()).toBe('Europe/Istanbul')
    const before = await fs.stat(join(dir, 'settings.json'))
    await new Promise((r) => setTimeout(r, 20))
    await s.setTimeZone('Europe/Istanbul')
    expect((await fs.stat(join(dir, 'settings.json'))).mtimeMs).toBe(before.mtimeMs)
    await s.setTimeZone('Asia/Baghdad')
    expect((await s.get()).timeZone).toBe('Asia/Baghdad')
  })
  it('worktreeFolders round-trips and ignores junk', async () => {
    const s = new SettingsStore(dir)
    expect(await s.worktreeOn('/r')).toBe(false)
    await s.setWorktreeFolder('/r', true)
    await s.setWorktreeFolder('/r', true) // once only
    await s.setWorktreeFolder('/q', true)
    expect((await s.get()).worktreeFolders).toEqual(['/r', '/q'])
    expect(await s.worktreeOn('/r')).toBe(true)
    await s.setWorktreeFolder('/r', false)
    expect(await s.worktreeOn('/r')).toBe(false)
    expect((await new SettingsStore(dir).get()).worktreeFolders).toEqual(['/q'])
    await fs.writeFile(join(dir, 'settings.json'), '{"worktreeFolders":[1,"x"]}')
    expect((await new SettingsStore(dir).get()).worktreeFolders).toEqual(['x'])
    await fs.writeFile(join(dir, 'settings.json'), '{"worktreeFolders":"x"}')
    expect((await new SettingsStore(dir).get()).worktreeFolders).toEqual([])
  })
})
