import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SHOTS_PER_CHAT_MAX, SHOT_BYTES_MAX } from '@zumibot/shared/browser'
import { BrowserShots, SHOT_REFUSALS } from '../../src/core/browser/browserShots'
import { symlinksWork } from '../support/platform'

const exists = (p: string): Promise<boolean> =>
  fs.access(p).then(
    () => true,
    () => false
  )
const mode = async (p: string) => (await fs.stat(p)).mode & 0o777
const png = (n = 8) => new Uint8Array(n).fill(7)

let tmp: string
let root: string
let shots: BrowserShots

beforeEach(async () => {
  tmp = await fs.mkdtemp(join(tmpdir(), 'shots-'))
  root = join(tmp, 'browser-shots')
  shots = new BrowserShots(root)
})
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true })
})

const fill = async (chat: string, n: number) => {
  const dir = join(root, chat)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  for (let i = 0; i < n; i++) await fs.writeFile(join(dir, `s${i}.png`), 'x')
}

describe('BrowserShots', () => {
  it('saves <root>/<chatId>/<name>.png with private modes and returns the path and size', async () => {
    const out = await shots.save('chat-1', 'home', png(12))
    expect(out).toEqual({ path: join(root, 'chat-1', 'home.png'), bytes: 12 })
    expect((await fs.readFile(out.path)).length).toBe(12)
    if (process.platform !== 'win32') expect(await mode(join(root, 'chat-1'))).toBe(0o700)
    if (process.platform !== 'win32') expect(await mode(out.path)).toBe(0o600)
  })

  it('overwrites a name without growing the count', async () => {
    await shots.save('chat-1', 'a', png(3))
    const out = await shots.save('chat-1', 'a', png(5))
    expect(out.bytes).toBe(5)
    expect(await fs.readdir(join(root, 'chat-1'))).toEqual(['a.png'])
  })

  it.each(['../x', 'a/b', 'A', '', '.png', 'a'.repeat(65)])('refuses the name %j', async (name) => {
    await expect(shots.save('chat-1', name, png())).rejects.toThrow(SHOT_REFUSALS.name)
    expect(await exists(root)).toBe(false)
  })

  it('refuses a chat id that is not an id', async () => {
    await expect(shots.save('../x', 'a', png())).rejects.toThrow(SHOT_REFUSALS.chat)
    expect(await exists(join(tmp, 'x'))).toBe(false)
  })

  it('refuses an image past 5 MiB and writes nothing', async () => {
    await expect(shots.save('chat-1', 'big', png(SHOT_BYTES_MAX + 1))).rejects.toThrow(SHOT_REFUSALS.big)
    expect(await exists(join(root, 'chat-1', 'big.png'))).toBe(false)
    expect((await shots.save('chat-1', 'edge', png(SHOT_BYTES_MAX))).bytes).toBe(SHOT_BYTES_MAX)
  })

  it('refuses the 201st distinct name but still overwrites an old one', async () => {
    const one = png(1)
    for (let i = 0; i < SHOTS_PER_CHAT_MAX; i++) await shots.save('chat-1', `s${i}`, one)
    await expect(shots.save('chat-1', 'extra', one)).rejects.toThrow(SHOT_REFUSALS.many)
    await expect(shots.save('chat-1', 's0', png(2))).resolves.toMatchObject({ bytes: 2 })
    await expect(shots.save('chat-2', 'extra', one)).resolves.toBeTruthy()
  }, 30_000)

  it('removeChat deletes the folder, only that chat, and is a no-op when absent', async () => {
    await shots.save('chat-1', 'a', png())
    await shots.save('chat-2', 'a', png())
    await shots.removeChat('chat-1')
    expect(await exists(join(root, 'chat-1'))).toBe(false)
    expect(await exists(join(root, 'chat-2', 'a.png'))).toBe(true)
    await expect(shots.removeChat('chat-1')).resolves.toBeUndefined()
    await expect(shots.removeChat('../x')).resolves.toBeUndefined()
  })

  it('two parallel saves of new names at 199 files leave exactly 200, one refused', async () => {
    await fill('chat-1', SHOTS_PER_CHAT_MAX - 1)
    const out = await Promise.allSettled([shots.save('chat-1', 'p', png(1)), shots.save('chat-1', 'q', png(1))])
    expect(out.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const bad = out.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect((bad.reason as Error).message).toBe(SHOT_REFUSALS.many)
    expect((await fs.readdir(join(root, 'chat-1'))).filter((n) => n.endsWith('.png'))).toHaveLength(SHOTS_PER_CHAT_MAX)
  })

  it('two parallel saves of the same name both succeed and leave one file', async () => {
    await Promise.all([shots.save('chat-1', 'same', png(2)), shots.save('chat-1', 'same', png(3))])
    expect(await fs.readdir(join(root, 'chat-1'))).toEqual(['same.png'])
  })

  it('saves into different chats side by side', async () => {
    const [a, b] = await Promise.allSettled([shots.save('chat-1', 'a', png()), shots.save('chat-2', 'a', png())])
    expect(a.status).toBe('fulfilled')
    expect(b.status).toBe('fulfilled')
  })

  it('refuses a chat folder that is a symlink and writes nothing through it', async () => {
    const elsewhere = join(tmp, 'elsewhere')
    await fs.mkdir(elsewhere)
    await fs.mkdir(root)
    await fs.symlink(elsewhere, join(root, 'chat-1'), 'junction') // a junction needs no privilege on Windows; POSIX ignores the type
    await expect(shots.save('chat-1', 'a', png())).rejects.toThrow(SHOT_REFUSALS.unsafe)
    expect(await fs.readdir(elsewhere)).toEqual([])
  })

  it.skipIf(!symlinksWork)('refuses a target file that is a symlink and leaves what it points at untouched', async () => {
    const target = join(tmp, 'target.txt')
    await fs.writeFile(target, 'keep')
    await fs.mkdir(join(root, 'chat-1'), { recursive: true })
    await fs.symlink(target, join(root, 'chat-1', 'x.png'))
    await expect(shots.save('chat-1', 'x', png())).rejects.toThrow(SHOT_REFUSALS.unsafe)
    expect(await fs.readFile(target, 'utf8')).toBe('keep')
  })

  it('counts only regular .png files toward the cap', async () => {
    await fill('chat-1', SHOTS_PER_CHAT_MAX - 1)
    await fs.mkdir(join(root, 'chat-1', 'y.png'))
    await fs.writeFile(join(root, 'chat-1', 'notes.txt'), 'x')
    await fs.symlink(join(tmp, 'nowhere'), join(root, 'chat-1', 'z.png'), 'junction')
    await expect(shots.save('chat-1', 'last', png())).resolves.toBeTruthy()
    await expect(shots.save('chat-1', 'over', png())).rejects.toThrow(SHOT_REFUSALS.many)
  })

  it('a failed write leaves no .png and no .tmp behind', async () => {
    await fs.mkdir(join(root, 'chat-1', 'bad.png'), { recursive: true })
    await expect(shots.save('chat-1', 'bad', png())).rejects.toThrow()
    expect((await fs.readdir(join(root, 'chat-1'))).sort()).toEqual(['bad.png'])
    expect((await fs.stat(join(root, 'chat-1', 'bad.png'))).isDirectory()).toBe(true)
  })

  it('tightens a looser existing folder and file on save', async () => {
    const dir = join(root, 'chat-1')
    await fs.mkdir(dir, { recursive: true })
    await fs.chmod(dir, 0o755)
    await fs.writeFile(join(dir, 'a.png'), 'old', { mode: 0o644 })
    await fs.chmod(join(dir, 'a.png'), 0o644)
    await shots.save('chat-1', 'a', png())
    if (process.platform !== 'win32') expect(await mode(dir)).toBe(0o700)
    if (process.platform !== 'win32') expect(await mode(join(dir, 'a.png'))).toBe(0o600)
  })
})
