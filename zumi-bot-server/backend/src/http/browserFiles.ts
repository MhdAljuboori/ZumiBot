import type { IncomingMessage, ServerResponse } from 'node:http'
import { ATTACH_MAX_BYTES } from '@zumibot/shared/attachments'
import { BrowserFileLimitError, type BrowserFiles } from '../core/browser/browserFiles'
import { asciiName, encode5987 } from './attachments'
import type { BrowserHub } from './browserSocket'
import { sendJson, streamFile } from './headers'

const FILE_RE = /^\/api\/browser\/files\/([A-Za-z0-9-]{1,128})$/
const NAME_MAX = 1024

/** Called only after the ordinary cookie and write-origin gate. No viewer subscription is created here. */
export async function serveBrowserFile(
  req: IncomingMessage,
  res: ServerResponse,
  files: BrowserFiles,
  hub: BrowserHub | undefined,
  sessionKey: string,
  pathname: string
): Promise<void> {
  if (pathname === '/api/browser/files/stage') return stageUpload(req, res, hub, sessionKey)
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' })
  const id = FILE_RE.exec(pathname)?.[1]
  const file = id ? await files.download(id) : null
  if (!file) return sendJson(res, 404, { error: 'Browser file unavailable' })
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': file.size,
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${asciiName(file.name)}"; filename*=UTF-8''${encode5987(file.name)}`
  })
  if (req.method === 'HEAD') res.end()
  else streamFile(res, file.path)
}

async function stageUpload(req: IncomingMessage, res: ServerResponse, hub: BrowserHub | undefined, sessionKey: string): Promise<void> {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })
  const header = (name: string): string => {
    const v = req.headers[name]
    return typeof v === 'string' ? v : ''
  }
  let name: string
  try {
    name = decodeURIComponent(header('x-file-name'))
  } catch {
    return sendJson(res, 400, { error: 'Invalid file name' })
  }
  if (!name || name.length > NAME_MAX) return sendJson(res, 400, { error: 'Invalid file name' })
  // Connection: close, so an oversized body is never read; the socket goes down after the answer.
  if (Number(req.headers['content-length']) > ATTACH_MAX_BYTES) {
    return sendJson(res, 413, { error: 'Browser file limit reached' }, { Connection: 'close' })
  }
  try {
    if (!hub) throw new Error('Unavailable')
    const location = { generation: header('x-browser-generation'), tabId: header('x-browser-tab') }
    const file = await hub.stageUpload(sessionKey, header('x-browser-upload'), location, req, name)
    return sendJson(res, 200, file)
  } catch (error) {
    // One answer for every refusal, so a caller learns nothing about whose upload or tab it named.
    req.resume()
    const status = error instanceof BrowserFileLimitError ? 413 : 403
    return sendJson(res, status, { error: 'Browser upload denied or file limit reached' }, { Connection: 'close' })
  }
}
