import { app, session, shell } from 'electron'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { attachmentTarget, openDecision } from './attachmentPolicy'
import { safeFileName } from './navigation'

const DOWNLOAD_START_MS = 15_000

interface Pending {
  href: string
  claim(item: Electron.DownloadItem): void
}
// Calls for the same URL are served in order: each DownloadItem is claimed by exactly one call.
const pending: Pending[] = []
let listening = false
const tempDirs: string[] = []

function listen(): void {
  if (listening) return
  listening = true
  session.defaultSession.on('will-download', (_e, item) => {
    const i = pending.findIndex((p) => p.href === item.getURL())
    if (i >= 0) pending.splice(i, 1)[0]!.claim(item)
  })
}

/**
 * Downloads an attachment of the connected server (attachment routes only) into a fresh temp folder with the session's
 * cookies. Images, pdf and plain text open in the default app; anything else is only revealed in the file manager, so a
 * hostile server can never make the desktop run a file. False when the file is missing (HTTP 404) or cannot be shown.
 */
export function openAttachment(url: string, name: string, origin: string): Promise<boolean> {
  const target = attachmentTarget(url, origin)
  if (!target) return Promise.resolve(false)
  const dir = mkdtempSync(join(app.getPath('temp'), 'zumibot-'))
  tempDirs.push(dir)
  const file = join(dir, safeFileName(name))
  listen()
  return new Promise<boolean>((resolve) => {
    const entry: Pending = {
      href: target.href,
      claim(item) {
        clearTimeout(timer)
        item.setSavePath(file)
        const mime = item.getMimeType()
        item.once('done', (_ev, state) => {
          if (state !== 'completed') return resolve(false) // a 404 ends interrupted
          if (openDecision(mime, file) === 'open') void shell.openPath(file).then((err) => resolve(err === ''))
          else {
            shell.showItemInFolder(file)
            resolve(true)
          }
        })
      }
    }
    // A download that never starts must not hang the caller.
    const timer = setTimeout(() => {
      const i = pending.indexOf(entry)
      if (i >= 0) pending.splice(i, 1)
      resolve(false)
    }, DOWNLOAD_START_MS)
    timer.unref()
    pending.push(entry)
    session.defaultSession.downloadURL(target.href)
  })
}

/** Best effort, on quit: the downloaded copies are not kept. */
export function cleanupAttachmentDirs(): void {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // still open in a viewer, or already gone
    }
  }
}
