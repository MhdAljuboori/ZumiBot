import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { SHOTS_PER_CHAT_MAX, SHOT_BYTES_MAX, SHOT_NAME_RE } from '@zumibot/shared/browser'
import { ID_RE } from '../attachments/attachmentStore'
import { writeFileAtomic } from '../fsutil'

/** Fixed sentences: `save` throws an Error holding exactly one of them, so a caller can pass it on without leaking a path. */
export const SHOT_REFUSALS = {
  name: 'invalid_shot_name',
  chat: 'invalid_chat',
  many: 'too_many_shots',
  big: 'image_too_large',
  unsafe: 'unsafe_path'
} as const

/** Screenshots an agent asked to keep, one folder per chat: <root>/<chatId>/<name>.png. Never synced; removed with the chat. */
export class BrowserShots {
  constructor(private readonly root: string) {}

  async save(chatId: string, name: string, png: Uint8Array): Promise<{ path: string; bytes: number }> {
    // The path is built here from two checked parts, so no argument can ever name another place.
    if (typeof chatId !== 'string' || !ID_RE.test(chatId)) throw new Error(SHOT_REFUSALS.chat)
    if (typeof name !== 'string' || !SHOT_NAME_RE.test(name)) throw new Error(SHOT_REFUSALS.name)
    if (png.byteLength > SHOT_BYTES_MAX) throw new Error(SHOT_REFUSALS.big)
    const dir = join(this.root, chatId)
    const file = join(dir, `${name}.png`)
    return this.serial(chatId, async () => {
      // A link in either place would make chmod or the rename land outside the chat's folder.
      if ((await isLink(dir)) || (await isLink(file))) throw new Error(SHOT_REFUSALS.unsafe)
      // Overwriting keeps the count, so the cap only applies to a name the chat does not have yet.
      if (!(await isFile(file)) && (await countPngs(dir)) >= SHOTS_PER_CHAT_MAX) throw new Error(SHOT_REFUSALS.many)
      await fs.mkdir(dir, { recursive: true, mode: 0o700 })
      // mkdir's mode is masked by the umask, and an older folder may be looser.
      await fs.chmod(dir, 0o700)
      await writeFileAtomic(file, png, 0o600)
      return { path: file, bytes: png.byteLength }
    })
  }

  // The count and the write are separate awaits, so parallel saves of new names would both pass the cap.
  // One chain per chat: another chat never waits, and an entry leaves the map once its chain settles.
  private readonly chains = new Map<string, Promise<unknown>>()
  private serial<T>(chatId: string, job: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(chatId) ?? Promise.resolve()).then(job, job)
    const tail = run.catch(() => {})
    this.chains.set(chatId, tail)
    void tail.then(() => {
      if (this.chains.get(chatId) === tail) this.chains.delete(chatId)
    })
    return run
  }

  async removeChat(chatId: string): Promise<void> {
    if (!ID_RE.test(chatId)) return
    await fs.rm(join(this.root, chatId), { recursive: true, force: true })
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isFile()
  } catch {
    return false
  }
}

async function isLink(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isSymbolicLink()
  } catch {
    return false
  }
}

/** Regular files only: a folder or a link named x.png is not a kept screenshot. */
async function countPngs(dir: string): Promise<number> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.png')).length
  } catch {
    return 0
  }
}
