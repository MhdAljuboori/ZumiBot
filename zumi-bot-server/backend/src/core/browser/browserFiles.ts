import type { BrowserDownloadSource } from './types'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ATTACH_MAX_BYTES, ATTACH_MAX_FILES } from '@zumibot/shared/attachments'

export type BrowserFileOwner = { profileId: string; generation: string } & ({ viewerId: string } | { chatId: string; turnId: string })
export type BrowserFile = { id: string; name: string; size: number }
type Entry = BrowserFile & {
  owner: BrowserFileOwner
  path: string
  download: boolean
  expires: number
  complete: boolean
  abort: AbortController
  reservation: number
  sourceId: string | null
  discarded: boolean
  removed: boolean
}
const unavailable = () => new Error('Browser file unavailable')
/** A store limit (file count, file size, total bytes): the upload route answers 413 for it, 403 for anything else. */
export class BrowserFileLimitError extends Error {
  constructor() {
    super('Browser file limit reached')
    this.name = 'BrowserFileLimitError'
  }
}
const cleanName = (name: string) => {
  const raw = Buffer.from(basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '_')).toString('utf8')
  let clean = ''
  for (const character of raw) {
    if (Buffer.byteLength(clean + character) > 180) break
    clean += character
  }
  return !clean || clean === '.' || clean === '..' ? 'file' : clean
}
/** Only this private store resolves opaque IDs into filesystem paths. No disk metadata survives restart. */
export class BrowserFiles {
  private initialized = false
  private entries = new Map<string, Entry>()
  private timer: ReturnType<typeof setInterval>
  private now: () => number
  constructor(
    private root: string,
    private options: {
      now?: () => number
      attached?: (owner: { chatId: string; turnId: string; profileId: string; generation: string }, id: string) => Promise<string | null>
    } = {}
  ) {
    this.now = options.now ?? Date.now
    this.timer = setInterval(() => {
      void this.sweep()
    }, 60000)
    this.timer.unref()
  }
  private metadata(e: Entry): BrowserFile {
    return { id: e.id, name: e.name, size: e.size }
  }
  list(profileId: string): BrowserFile[] {
    return [...this.entries.values()]
      .filter((e) => e.complete && e.download && e.owner.profileId === profileId && e.expires > this.now())
      .map((e) => this.metadata(e))
  }
  stageDownload(owner: BrowserFileOwner, source: BrowserDownloadSource, name: string, signal?: AbortSignal): Promise<BrowserFile> {
    return this.stage(owner, source, name, true, signal)
  }
  stageUpload(owner: BrowserFileOwner, source: AsyncIterable<Uint8Array>, name: string, signal?: AbortSignal): Promise<BrowserFile> {
    return this.stage(owner, source, name, false, signal)
  }
  private async stage(
    owner: BrowserFileOwner,
    source: AsyncIterable<Uint8Array>,
    name: string,
    download: boolean,
    signal?: AbortSignal
  ): Promise<BrowserFile> {
    await this.sweep()
    const retained = download && (source as BrowserDownloadSource).retainsSource === true
    const reservation = download ? ATTACH_MAX_BYTES * (retained ? 2 : 1) : 0
    const current = [...this.entries.values()].filter((e) => e.owner.profileId === owner.profileId)
    if (
      current.length >= ATTACH_MAX_FILES ||
      (download && current.reduce((n, e) => n + Math.max(e.size, e.reservation), 0) + reservation > 100 * 1024 * 1024)
    )
      throw new BrowserFileLimitError()
    const id = randomUUID(),
      safe = cleanName(name),
      path = join(this.root, id, safe)
    const entry: Entry = {
      id,
      name: safe,
      size: 0,
      path,
      owner: { ...owner },
      download,
      expires: this.now() + 3600000,
      complete: false,
      abort: new AbortController(),
      reservation,
      sourceId: retained ? ((source as BrowserDownloadSource).sourceId ?? id) : null,
      discarded: false,
      removed: false
    }
    // Reserve count before any filesystem await so concurrent streams share the same budget.
    this.entries.set(id, entry)
    const iterator = source[Symbol.asyncIterator]()
    const combined = signal ? AbortSignal.any([signal, entry.abort.signal]) : entry.abort.signal
    const next = () =>
      new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
        const abort = () => {
          combined.removeEventListener('abort', abort)
          reject(unavailable())
        }
        if (combined.aborted) return abort()
        combined.addEventListener('abort', abort, { once: true })
        void iterator.next().then(
          (value) => {
            combined.removeEventListener('abort', abort)
            resolve(value)
          },
          (error) => {
            combined.removeEventListener('abort', abort)
            reject(error)
          }
        )
      })
    try {
      await mkdir(join(this.root, id), { recursive: true, mode: 0o700 })
      const handle = await open(path, 'wx', 0o600)
      try {
        while (true) {
          const item = await next()
          if (item.done) break
          const chunk = item.value
          if (entry.abort.signal.aborted || entry.expires <= this.now()) throw unavailable()
          const total = [...this.entries.values()]
            .filter((e) => e.owner.profileId === owner.profileId)
            .reduce((n, e) => n + (e === entry ? e.size : Math.max(e.size, e.reservation)), 0)
          if (entry.size + chunk.byteLength > ATTACH_MAX_BYTES || total + chunk.byteLength > 100 * 1024 * 1024)
            throw new BrowserFileLimitError()
          entry.size += chunk.byteLength
          await handle.writeFile(chunk)
        }
      } finally {
        await handle.close()
      }
      if (entry.abort.signal.aborted || entry.expires <= this.now()) throw unavailable()
      entry.complete = true
      if (!retained) entry.reservation = 0
      return this.metadata(entry)
    } catch (error) {
      void iterator.return?.().catch(() => {})
      await this.discard(id)
      throw error
    }
  }
  sourceClosed(sourceId: string): void {
    const entry = [...this.entries.values()].find((e) => e.sourceId === sourceId)
    if (!entry) return
    entry.sourceId = null
    entry.reservation = 0
    if (entry.discarded && entry.removed) this.entries.delete(entry.id)
  }
  async resolveUpload(owner: BrowserFileOwner, fileIds: string[]): Promise<string[]> {
    await this.sweep()
    if (!fileIds.length || fileIds.length > ATTACH_MAX_FILES || fileIds.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id)))
      throw unavailable()
    return Promise.all(
      fileIds.map(async (id) => {
        if ('turnId' in owner) {
          const path = await this.options.attached?.(owner, id)
          if (!path) throw unavailable()
          return path
        }
        const e = this.entries.get(id)
        if (
          !e ||
          !e.complete ||
          e.download ||
          e.owner.profileId !== owner.profileId ||
          e.owner.generation !== owner.generation ||
          !('viewerId' in e.owner) ||
          e.owner.viewerId !== owner.viewerId
        )
          throw unavailable()
        return e.path
      })
    )
  }
  async download(id: string): Promise<(BrowserFile & { path: string }) | null> {
    await this.sweep()
    const e = this.entries.get(id)
    return e?.complete && e.download ? { ...this.metadata(e), path: e.path } : null
  }
  async discard(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.abort.abort()
    entry.complete = false
    entry.discarded = true
    await rm(join(this.root, id), { recursive: true, force: true })
    entry.size = 0
    entry.removed = true
    // The public file is gone; its physical worker source still reserves capacity.
    if (!entry.sourceId) this.entries.delete(id)
  }
  async discardTurn(turnId: string): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter((e) => 'turnId' in e.owner && e.owner.turnId === turnId && (!e.download || !e.complete))
        .map((e) => this.discard(e.id))
    )
  }
  async discardViewer(viewerId: string): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter((e) => 'viewerId' in e.owner && e.owner.viewerId === viewerId && !e.download)
        .map((e) => this.discard(e.id))
    )
  }
  async discardProfile(profileId: string): Promise<void> {
    await Promise.all([...this.entries.values()].filter((e) => e.owner.profileId === profileId).map((e) => this.discard(e.id)))
  }
  private async sweep() {
    await Promise.all([...this.entries.values()].filter((e) => e.expires <= this.now()).map((e) => this.discard(e.id)))
  }
  async clear() {
    const parent = await lstat(dirname(this.root))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw unavailable()
    await Promise.all([...this.entries.keys()].map((id) => this.discard(id)))
    await rm(this.root, { recursive: true, force: true })
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    this.initialized = true
  }
  async close() {
    clearInterval(this.timer)
    if (this.initialized) await this.clear()
  }
}
