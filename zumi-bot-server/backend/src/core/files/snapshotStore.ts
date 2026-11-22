import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { ID_RE } from '../attachments/attachmentStore'
import { writeFileAtomic } from '../fsutil'

export const SNAPSHOT_MAX_BYTES = 1024 * 1024
/** A copy's id is the sha256 of its bytes, so the id alone can never be a path. */
export const SNAPSHOT_ID_RE = /^[0-9a-f]{64}$/

export type Kept = { id: string } | { miss: 'too-big' | 'binary' }

/** Whole-file copies kept outside the chat JSON, one folder per chat: <root>/<chatId>/<sha256>. Same text, one file. */
export class SnapshotStore {
  constructor(private readonly root: string) {}

  async put(chatId: string, text: string): Promise<Kept> {
    if (!ID_RE.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`)
    if (text.includes('\u0000')) return { miss: 'binary' }
    const bytes = Buffer.from(text, 'utf8')
    if (bytes.length > SNAPSHOT_MAX_BYTES) return { miss: 'too-big' }
    const id = createHash('sha256').update(bytes).digest('hex')
    const file = join(this.root, chatId, id)
    if (await isFile(file)) return { id }
    await this.ensureDir(chatId)
    await writeFileAtomic(file, text, 0o600)
    return { id }
  }

  async read(chatId: string, id: string): Promise<string | null> {
    const file = this.pathOf(chatId, id)
    if (!file) return null
    try {
      return await fs.readFile(file, 'utf8')
    } catch {
      return null
    }
  }

  /** Where a copy lives, or null for an id that is not one. The file may not exist. */
  pathOf(chatId: string, id: string): string | null {
    if (!ID_RE.test(chatId) || !SNAPSHOT_ID_RE.test(id)) return null
    return join(this.root, chatId, id)
  }

  /** Copies files into another chat, so removing either chat never breaks the other's. A file already gone is skipped. */
  async copy(fromChat: string, toChat: string, ids: Iterable<string>): Promise<void> {
    if (!ID_RE.test(fromChat) || !ID_RE.test(toChat)) throw new Error(`Invalid chat id: ${fromChat}`)
    let made = false
    for (const id of ids) {
      const from = this.pathOf(fromChat, id)
      if (!from || !(await isFile(from))) continue
      if (!made) {
        await this.ensureDir(toChat)
        made = true
      }
      const to = join(this.root, toChat, id)
      await fs.copyFile(from, to, fs.constants.COPYFILE_FICLONE)
      await fs.chmod(to, 0o600)
    }
  }

  async removeChat(chatId: string): Promise<void> {
    if (!ID_RE.test(chatId)) return
    await fs.rm(join(this.root, chatId), { recursive: true, force: true })
  }

  private async ensureDir(chatId: string): Promise<void> {
    const dir = join(this.root, chatId)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    // mkdir's mode is masked by the umask, and an older folder may be looser.
    await fs.chmod(dir, 0o700)
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}
