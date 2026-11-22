import type { IncomingMessage, ServerResponse } from 'node:http'
import { EXPORT_ROUTE, exportFileName, parseExportQuery } from '@zumibot/shared/chatExport'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import { buildExport, toMarkdown, validZone } from '../core/export/chatExport'
import { toHtml } from '../core/export/exportHtml'
import { asciiName, encode5987 } from './attachments'
import { sendJson } from './headers'

// The same charset ChatStore accepts for an id, so the id can never name a path.
const PATH_RE = /^\/api\/export\/([A-Za-z0-9-]{1,100})$/

export function parseExportPath(pathname: string): string | null {
  if (!pathname.startsWith(EXPORT_ROUTE)) return null
  return PATH_RE.exec(pathname)?.[1] ?? null
}

export interface ExportSource {
  get(id: string): Promise<ChatMeta | null>
  loadItems(id: string): Promise<ChatItem[]>
  timeZone(): Promise<string | null> // the zone the page last reported, for a request that names none
}

/**
 * A chat as a Markdown or HTML file, read from its stored items (the whole history, not the pages a client loaded).
 * Always sent as nosniff text/plain for download: the page is only ever opened from the saved file, never from here.
 */
export async function serveExport(
  req: IncomingMessage,
  res: ServerResponse,
  src: ExportSource,
  chatId: string,
  now = Date.now()
): Promise<void> {
  const o = parseExportQuery(new URL(req.url ?? '/', 'http://localhost').searchParams)
  if (o === null) return sendJson(res, 400, { error: 'Bad export options' })
  const meta = await src.get(chatId)
  if (meta === null) return sendJson(res, 404, { error: 'Not found' })
  const zone =
    validZone(o.timeZone) ?? validZone(await src.timeZone()) ?? validZone(Intl.DateTimeFormat().resolvedOptions().timeZone) ?? 'UTC'
  const doc = buildExport(meta, await src.loadItems(chatId), { steps: o.steps, item: o.item, now, zone })
  if (doc === null) return sendJson(res, 404, { error: 'Not found' })
  const body = Buffer.from(o.format === 'html' ? toHtml(doc) : toMarkdown(doc), 'utf8')
  const name = exportFileName(meta.title, o.format, doc.reply)
  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${asciiName(name)}"; filename*=UTF-8''${encode5987(name)}`
  })
  res.end(req.method === 'HEAD' ? undefined : body)
}
