import { randomUUID } from 'node:crypto'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BrowserContext, CDPSession } from 'playwright-core'
import { ATTACH_MAX_BYTES } from '@zumibot/shared/attachments'
import { BrowserFileLimitError } from './browserFiles'
import type { BrowserFileHooks } from './types'
import { clearBrowserDownloadScratch } from './browserProcess'

type Transfer = { guid: string; received: number; state: string; wake?: () => void; abort: AbortController; task?: Promise<void> }
/** Browser-domain events include blob/data and anchor downloads without URL refetching. */
export class BrowserDownloads {
  private session: CDPSession | null = null
  private root = ''
  private transfers = new Map<string, Transfer>()
  async start(context: BrowserContext, profile: string, files: BrowserFileHooks | undefined, generation: string): Promise<void> {
    // Only this worker's private scratch directory is disposable, including after restart.
    await clearBrowserDownloadScratch(profile)
    this.root = join(profile, `.downloads-${randomUUID()}`)
    await mkdir(this.root, { mode: 0o700 })
    const session = (this.session = await context.browser()!.newBrowserCDPSession())
    session.on('Browser.downloadWillBegin', (event) => {
      if (!/^[0-9a-f-]{1,128}$/.test(event.guid) || this.transfers.size >= 4 || !files) {
        void session.send('Browser.cancelDownload', { guid: event.guid }).catch(() => {})
        return
      }
      const transfer: Transfer = { guid: event.guid, received: 0, state: 'inProgress', abort: new AbortController() }
      this.transfers.set(event.guid, transfer)
      transfer.task = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const source = Object.assign(this.source(transfer), { retainsSource: true as const, sourceId: event.guid })
        const work = files.download(source, event.suggestedFilename.slice(0, 512), generation, transfer.abort.signal)
        try {
          timer = setTimeout(() => this.cancel(transfer), 3600000)
          timer.unref()
          const aborted = new Promise<never>((_, reject) =>
            transfer.abort.signal.addEventListener('abort', () => reject(new Error('Browser download cancelled')), { once: true })
          )
          await Promise.race([work, aborted])
        } catch {
          this.cancel(transfer)
        } finally {
          clearTimeout(timer)
          await work.catch(() => {})
          await source.return(undefined)
          await this.remove(event.guid)
          try {
            await files.sourceClosed?.(event.guid)
          } catch {
            /* Missing confirmation retains parent capacity until verified teardown. */
          }
          this.transfers.delete(event.guid)
        }
      })()
    })
    session.on('Browser.downloadProgress', (event) => {
      const transfer = this.transfers.get(event.guid)
      if (!transfer) return
      transfer.received = event.receivedBytes
      transfer.state = event.state
      // Independent of a stalled sink/IPC acknowledgement: stop the network transfer now.
      if (!Number.isSafeInteger(event.receivedBytes) || event.receivedBytes > ATTACH_MAX_BYTES || event.state === 'canceled')
        this.cancel(transfer)
      transfer.wake?.()
      transfer.wake = undefined
    })
    await session.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.root, eventsEnabled: true })
  }
  private cancel(t: Transfer) {
    t.abort.abort()
    t.wake?.()
    t.wake = undefined
    void this.session?.send('Browser.cancelDownload', { guid: t.guid }).catch(() => {})
  }
  private async remove(guid: string) {
    await Promise.all([rm(join(this.root, guid), { force: true }), rm(join(this.root, guid + '.crdownload'), { force: true })])
  }
  private async *source(t: Transfer): AsyncGenerator<Uint8Array> {
    let position = 0
    try {
      while (!t.abort.signal.aborted) {
        const marker = t.received,
          state = t.state
        let handle
        try {
          handle = await open(join(this.root, t.guid), 'r')
        } catch {
          try {
            handle = await open(join(this.root, t.guid + '.crdownload'), 'r')
          } catch {
            /* First progress may precede file creation. */
          }
        }
        let read = 0
        if (handle) {
          try {
            const bytes = Buffer.alloc(65536)
            read = (await handle.read(bytes, 0, Math.min(bytes.length, ATTACH_MAX_BYTES - position + 1), position)).bytesRead
            if (read) {
              if (position + read > ATTACH_MAX_BYTES) throw new BrowserFileLimitError()
              position += read
              yield bytes.subarray(0, read)
            }
          } finally {
            await handle.close()
          }
        }
        if (read) continue
        if (state === 'completed' && marker === t.received) return
        await new Promise<void>((resolve) => {
          t.wake = resolve
          if (t.abort.signal.aborted || marker !== t.received || state !== t.state) {
            t.wake = undefined
            resolve()
          }
        })
      }
      throw new Error('Browser download cancelled')
    } finally {
      if (t.state !== 'completed' || t.abort.signal.aborted) this.cancel(t)
    }
  }
  async close() {
    const tasks = [...this.transfers.values()].map((t) => {
      this.cancel(t)
      return t.task
    })
    await Promise.allSettled(tasks)
    await this.session?.detach().catch(() => {})
    this.session = null
    if (this.root) await rm(this.root, { recursive: true, force: true })
  }
}
