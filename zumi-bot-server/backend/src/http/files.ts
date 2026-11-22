import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SnapshotStore } from '../core/files/snapshotStore'
import { asciiName, encode5987 } from './attachments'
import { sendJson, streamFile } from './headers'

// Both ids are plain tokens (a copy's id is a sha256), so nothing here can name a path outside the chat's folder.
const FILE_RE = /^\/api\/files\/([A-Za-z0-9-]+)\/([0-9a-f]{64})$/

export function parseFilePath(pathname: string): { chatId: string; id: string } | null {
  const m = FILE_RE.exec(pathname)
  return m ? { chatId: m[1]!, id: m[2]! } : null
}

/** `download` only names the saved file in a header; it never takes part in finding the copy. */
export async function serveSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  snapshots: Pick<SnapshotStore, 'pathOf'>,
  p: { chatId: string; id: string },
  download: string | null
): Promise<void> {
  const file = snapshots.pathOf(p.chatId, p.id)
  const size = file
    ? await stat(file).then(
        (s) => (s.isFile() ? s.size : -1),
        () => -1
      )
    : -1
  if (!file || size < 0) return sendJson(res, 404, { error: 'Not found' })
  // The id is the hash of the bytes, so a URL's answer never changes; text/plain + nosniff keeps any file inert.
  const headers: Record<string, string | number> = {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': size,
    'Cache-Control': 'private, max-age=31536000, immutable'
  }
  if (download !== null)
    headers['Content-Disposition'] = `attachment; filename="${asciiName(download)}"; filename*=UTF-8''${encode5987(download)}`
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  streamFile(res, file)
}
