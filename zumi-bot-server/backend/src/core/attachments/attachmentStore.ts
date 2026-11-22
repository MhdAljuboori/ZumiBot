import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import type { Attachment, StageResult } from '@zumibot/shared/types'
import {
  ATTACH_MAX_BYTES,
  INLINE_IMAGE_MAX_BYTES,
  INLINE_IMAGE_MAX_SIDE,
  INLINE_IMAGE_TYPES,
  stageErrors
} from '@zumibot/shared/attachments'
import { imageInfo } from './sniff'

export const ID_RE = /^[A-Za-z0-9-]+$/

/**
 * A name NTFS can hold. On Windows `< > : " | ? *` and control characters become `_` (a `:` would even make an alternate
 * data stream), trailing dots and spaces go, and a reserved device name (CON, NUL, COM1...) gets a leading `_`: a browser
 * on another OS may send any of these. Elsewhere the name is kept as it is.
 */
export function storableName(name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return name
  // eslint-disable-next-line no-control-regex
  const out = name.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '')
  return /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(out) ? `_${out}` : out
}

/** What the chat services need to know about where a chat's attachment files live. */
export interface ChatFiles {
  dirOf(chatId: string): string
  pathOf(chatId: string, a: Attachment): string
}

/** Owns every attachment file: staged copies under <root>/.staged, sent ones under <root>/<chatId>. */
export class AttachmentStore implements ChatFiles {
  private readonly staged = new Map<string, Attachment>()
  private readonly stagedDir: string

  constructor(
    private readonly root: string,
    private readonly newId: () => string
  ) {
    this.stagedDir = join(root, '.staged')
  }

  dirOf(chatId: string): string {
    return join(this.root, chatId)
  }

  pathOf(chatId: string, a: Attachment): string {
    return join(this.root, chatId, a.id, a.name)
  }

  async stagePath(path: string): Promise<StageResult> {
    const name = basename(path) || 'file'
    try {
      const st = await fs.stat(path)
      if (st.isDirectory()) return { ok: false, name, error: stageErrors.folder(name) }
      if (!st.isFile()) return { ok: false, name, error: stageErrors.unreadable(name) }
      if (st.size > ATTACH_MAX_BYTES) return { ok: false, name, error: stageErrors.tooBig(name) }
      const id = this.newId()
      const dir = join(this.stagedDir, id)
      const dest = join(dir, name)
      try {
        await fs.mkdir(dir, { recursive: true })
        await fs.copyFile(path, dest)
        const attachment = await this.describe(id, name, dest, st.size)
        this.staged.set(id, attachment)
        return { ok: true, attachment }
      } catch (err) {
        await fs.rm(dir, { recursive: true, force: true })
        throw err
      }
    } catch {
      return { ok: false, name, error: stageErrors.unreadable(name) }
    }
  }

  async stageBytes(name: string, bytes: Uint8Array): Promise<StageResult> {
    const clean = storableName(basename(name.replace(/\\/g, '/'))) || 'file'
    if (bytes.length > ATTACH_MAX_BYTES) return { ok: false, name: clean, error: stageErrors.tooBig(clean) }
    const id = this.newId()
    const dir = join(this.stagedDir, id)
    const dest = join(dir, clean)
    try {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(dest, bytes)
      const attachment = await this.describe(id, clean, dest, bytes.length)
      this.staged.set(id, attachment)
      return { ok: true, attachment }
    } catch {
      await fs.rm(dir, { recursive: true, force: true })
      return { ok: false, name: clean, error: stageErrors.unreadable(clean) }
    }
  }

  private async describe(id: string, name: string, file: string, size: number): Promise<Attachment> {
    const handle = await fs.open(file, 'r')
    let head: Buffer
    try {
      const buf = Buffer.alloc(Math.min(size, INLINE_IMAGE_MAX_BYTES))
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0)
      head = buf.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
    const info = imageInfo(head)
    const inline =
      info !== null &&
      INLINE_IMAGE_TYPES.includes(info.mime) &&
      size <= INLINE_IMAGE_MAX_BYTES &&
      info.width !== null &&
      info.height !== null &&
      info.width <= INLINE_IMAGE_MAX_SIDE &&
      info.height <= INLINE_IMAGE_MAX_SIDE
    return { id, name, mime: info?.mime ?? 'application/octet-stream', size, kind: inline ? 'image' : 'file' }
  }

  async discard(id: string): Promise<void> {
    if (!this.staged.has(id)) return
    this.staged.delete(id)
    await fs.rm(join(this.stagedDir, id), { recursive: true, force: true })
  }

  async commit(chatId: string, ids: string[]): Promise<Attachment[]> {
    if (!ID_RE.test(chatId)) throw new Error(`Invalid chat id: ${chatId}`)
    const items: Attachment[] = []
    for (const id of ids) {
      const a = this.staged.get(id)
      if (!a || !(await this.stagedFile(id))) throw new Error(stageErrors.GONE)
      items.push(a)
    }
    for (const a of items) {
      const dir = join(this.root, chatId, a.id)
      await fs.mkdir(dir, { recursive: true })
      await fs.rename(join(this.stagedDir, a.id, a.name), join(dir, a.name))
      await fs.rm(join(this.stagedDir, a.id), { recursive: true, force: true })
      this.staged.delete(a.id)
    }
    return items
  }

  async stagedFile(id: string): Promise<string | null> {
    const a = ID_RE.test(id) ? this.staged.get(id) : undefined
    if (!a) return null
    const file = join(this.stagedDir, a.id, a.name)
    return (await isFile(file)) ? file : null
  }

  async chatFile(chatId: string, id: string): Promise<string | null> {
    if (!ID_RE.test(chatId) || !ID_RE.test(id)) return null
    const dir = join(this.root, chatId, id)
    try {
      const [name] = await fs.readdir(dir)
      if (!name) return null
      const file = join(dir, name)
      return (await isFile(file)) ? file : null
    } catch {
      return null
    }
  }

  /** Copies sent files into another chat, so removing either chat never breaks the other's. A file already gone is skipped. */
  async copyFiles(fromChat: string, toChat: string, attachments: Attachment[]): Promise<void> {
    if (!ID_RE.test(fromChat) || !ID_RE.test(toChat)) throw new Error(`Invalid chat id: ${fromChat}`)
    for (const a of attachments) {
      if (!ID_RE.test(a.id)) continue
      const name = basename(a.name)
      const from = join(this.root, fromChat, a.id, name)
      if (!(await isFile(from))) continue
      const dir = join(this.root, toChat, a.id)
      await fs.mkdir(dir, { recursive: true })
      await fs.copyFile(from, join(dir, name), fs.constants.COPYFILE_FICLONE)
    }
  }

  async removeChat(chatId: string): Promise<void> {
    if (!ID_RE.test(chatId)) return
    await fs.rm(join(this.root, chatId), { recursive: true, force: true })
  }

  async removeFiles(chatId: string, ids: string[]): Promise<void> {
    if (!ID_RE.test(chatId)) return
    for (const id of ids) {
      if (ID_RE.test(id)) await fs.rm(join(this.root, chatId, id), { recursive: true, force: true })
    }
  }

  async clearStaged(): Promise<void> {
    this.staged.clear()
    await fs.rm(this.stagedDir, { recursive: true, force: true })
  }
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isFile()
  } catch {
    return false
  }
}
