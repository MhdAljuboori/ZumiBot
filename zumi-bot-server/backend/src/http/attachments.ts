import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname } from 'node:path'
import type { AttachmentStore } from '../core/attachments/attachmentStore'
import { THUMB_TYPES } from '@zumibot/shared/attachments'
import { streamFile } from './headers'

const STAGED_RE = /^\/api\/attachments\/staged\/([A-Za-z0-9-]+)$/
const CHAT_RE = /^\/api\/attachments\/chat\/([A-Za-z0-9-]+)\/([A-Za-z0-9-]+)$/

/** Strict: ids are plain tokens, so nothing here can name a path outside the attachments folder. */
export function parseAttachmentPath(pathname: string): { chatId: string | null; id: string } | null {
  const staged = STAGED_RE.exec(pathname)
  if (staged) return { chatId: null, id: staged[1]! }
  const chat = CHAT_RE.exec(pathname)
  return chat ? { chatId: chat[1]!, id: chat[2]! } : null
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8'
}

// Only these render inline. html, svg, js and anything unknown could run script on our origin, so they download.
const INLINE = new Set([...THUMB_TYPES, 'application/pdf', 'text/plain; charset=utf-8'])

// RFC 5987: encodeURIComponent leaves ' ( ) * alone, which are not attr-chars.
export const encode5987 = (name: string): string =>
  encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

// Plain fallback for clients that ignore filename*: printable ASCII only, no quote or backslash.
export const asciiName = (name: string): string => name.replace(/[^\x20-\x7e]|["\\]/g, '_')

export async function serveAttachment(
  req: IncomingMessage,
  res: ServerResponse,
  store: AttachmentStore,
  parsed: { chatId: string | null; id: string },
  forceDownload: boolean
): Promise<void> {
  const file = parsed.chatId === null ? await store.stagedFile(parsed.id) : await store.chatFile(parsed.chatId, parsed.id)
  const size = file
    ? await stat(file).then(
        (s) => s.size,
        () => -1
      )
    : -1
  if (!file || size < 0) {
    res.writeHead(404, { 'Content-Length': 0 })
    res.end()
    return
  }
  const known = MIME[extname(file).toLowerCase()]
  const inline = known !== undefined && INLINE.has(known) && !forceDownload
  const headers: Record<string, string | number> = {
    'Content-Type': known && INLINE.has(known) ? known : 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': 'private, no-cache'
  }
  if (!inline)
    headers['Content-Disposition'] = `attachment; filename="${asciiName(basename(file))}"; filename*=UTF-8''${encode5987(basename(file))}`
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  streamFile(res, file)
}
