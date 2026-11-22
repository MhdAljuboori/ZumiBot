import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatTmp } from '../../src/core/chat/chatTmp'

let root: string
let tmp: ChatTmp
const hash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 16)

beforeEach(async () => {
  root = join(await fs.mkdtemp(join(os.tmpdir(), 'zumibot-tmp-')), 'claude-tmp')
  tmp = new ChatTmp(root)
})
afterEach(async () => {
  await fs.rm(join(root, '..'), { recursive: true, force: true })
})

describe('ChatTmp', () => {
  it("names a chat's folder by the first 16 hex chars of its id hash", () => {
    expect(tmp.dirOf('a')).toBe(join(root, hash('a')))
    expect(tmp.dirOf('a')).toBe(tmp.dirOf('a'))
    expect(tmp.dirOf('a')).not.toBe(tmp.dirOf('b'))
  })

  it('ensure makes the folder 0700 and returns it', async () => {
    expect(await tmp.ensure('a')).toBe(tmp.dirOf('a'))
    if (process.platform !== 'win32') expect((await fs.stat(tmp.dirOf('a'))).mode & 0o777).toBe(0o700)
    if (process.platform !== 'win32') expect((await fs.stat(root)).mode & 0o777).toBe(0o700)
    expect(await tmp.ensure('a')).toBe(tmp.dirOf('a')) // again is fine
  })

  it('remove deletes the folder with its files, and a missing one is fine', async () => {
    await tmp.ensure('a')
    await fs.writeFile(join(tmp.dirOf('a'), 'work.txt'), 'x')
    await tmp.remove('a')
    await expect(fs.access(tmp.dirOf('a'))).rejects.toThrow()
    await expect(tmp.remove('never')).resolves.toBeUndefined()
  })

  it('sweep removes folders no live chat hashes to, keeps live ones and leaves stray files', async () => {
    await tmp.ensure('a')
    await tmp.ensure('b')
    await fs.writeFile(join(root, 'stray.txt'), 'x')
    expect(await tmp.sweep(['a'])).toBe(1)
    await expect(fs.access(tmp.dirOf('b'))).rejects.toThrow()
    await expect(fs.access(tmp.dirOf('a'))).resolves.toBeUndefined()
    expect(await fs.readFile(join(root, 'stray.txt'), 'utf8')).toBe('x')
  })

  // An agent can leave a folder it cannot be removed from (a read-only one): the other orphans still go.
  // Windows has no mode bits, so chmod cannot make a folder unremovable there.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'sweep goes on past an orphan it cannot remove, and counts only what it removed',
    async () => {
      await tmp.ensure('live')
      for (const id of ['stuck', 'gone']) await tmp.ensure(id)
      const locked = join(tmp.dirOf('stuck'), 'locked')
      await fs.mkdir(locked)
      await fs.writeFile(join(locked, 'kept.txt'), 'x')
      await fs.chmod(locked, 0o500)
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        expect(await tmp.sweep(['live'])).toBe(1)
        // Only the code: the path names the data folder.
        expect(log.mock.calls).toEqual([['chat temp folder not swept:', 'EACCES']])
        await expect(fs.access(tmp.dirOf('gone'))).rejects.toThrow()
        await expect(fs.access(join(locked, 'kept.txt'))).resolves.toBeUndefined()
        await expect(fs.access(tmp.dirOf('live'))).resolves.toBeUndefined()
      } finally {
        log.mockRestore()
        await fs.chmod(locked, 0o700)
      }
    }
  )

  it('sweep with no live ids removes nothing, since an unreadable chat index looks the same', async () => {
    await tmp.ensure('a')
    await tmp.ensure('b')
    expect(await tmp.sweep([])).toBe(0)
    await expect(fs.access(tmp.dirOf('a'))).resolves.toBeUndefined()
    await expect(fs.access(tmp.dirOf('b'))).resolves.toBeUndefined()
  })

  it('sweep with no root yet removes nothing', async () => {
    expect(await tmp.sweep([])).toBe(0)
  })

  // The agent can write its temp folder, so a flag there could be a symlink the server's write follows, or simply deleted.
  it('pauseFlagOf lives in a pause folder of its own, never inside the agent-writable temp folder', () => {
    const flag = tmp.pauseFlagOf('a')
    expect(flag).toBe(join(root, '..', 'pause-flags', hash('a'), 'paused'))
    expect(flag.startsWith(tmp.dirOf('a'))).toBe(false)
    expect(tmp.pauseDirOf('a')).toBe(join(root, '..', 'pause-flags', hash('a')))
  })

  it('ensure also makes the pause folder 0700, and remove deletes it', async () => {
    await tmp.ensure('a')
    if (process.platform !== 'win32') expect((await fs.stat(tmp.pauseDirOf('a'))).mode & 0o777).toBe(0o700)
    await fs.writeFile(tmp.pauseFlagOf('a'), '')
    await tmp.remove('a')
    await expect(fs.access(tmp.pauseDirOf('a'))).rejects.toThrow()
  })

  it('sweep removes orphan pause folders too, without counting them', async () => {
    await tmp.ensure('a')
    await tmp.ensure('b')
    expect(await tmp.sweep(['a'])).toBe(1)
    await expect(fs.access(tmp.pauseDirOf('b'))).rejects.toThrow()
    await expect(fs.access(tmp.pauseDirOf('a'))).resolves.toBeUndefined()
  })
})
