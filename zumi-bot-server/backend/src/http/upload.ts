import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AttachmentStore } from '../core/attachments/attachmentStore'
import { ATTACH_MAX_BYTES, stageErrors } from '@zumibot/shared/attachments'
import { readBody } from './body'
import { sendJson } from './headers'

function fileName(req: IncomingMessage): string | null {
  const raw = req.headers['x-file-name']
  if (typeof raw !== 'string' || !raw) return null
  try {
    return decodeURIComponent(raw) || null
  } catch {
    return null
  }
}

export async function handleStage(req: IncomingMessage, res: ServerResponse, store: AttachmentStore): Promise<void> {
  const name = fileName(req)
  if (!name) return sendJson(res, 400, { error: 'X-File-Name header is required' })
  const tooBig = (extra: Record<string, string> = {}): void =>
    sendJson(res, 413, { ok: false, name, error: stageErrors.tooBig(name) }, extra)

  // Connection: close, so the body is never read; the socket goes down after the answer.
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > ATTACH_MAX_BYTES) return tooBig({ Connection: 'close' })

  const body = await readBody(req, ATTACH_MAX_BYTES)
  if (body === null) return tooBig()
  sendJson(res, 200, await store.stageBytes(name, body))
}
