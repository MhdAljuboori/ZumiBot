/** Chat export: a chat (or one reply of it) as a Markdown file or a self-contained HTML page, for sharing outside the app. */

export const EXPORT_FORMATS = ['md', 'html'] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]

export const EXPORT_ROUTE = '/api/export/'

export interface ExportOptions {
  format: ExportFormat
  steps: boolean // tool steps and errors too; off = the conversation only
  item: string | null // an agent message's id: only the reply that holds it; null = the whole chat
  timeZone: string | null // the reader's IANA zone for the times shown; null = the server's
}

const ITEM_MAX = 200
const ZONE_RE = /^[A-Za-z0-9_+\-/]{1,64}$/
const TITLE_MAX = 80

export function isExportFormat(v: unknown): v is ExportFormat {
  return typeof v === 'string' && (EXPORT_FORMATS as readonly string[]).includes(v)
}

export function exportUrl(chatId: string, o: ExportOptions): string {
  const q = new URLSearchParams({ format: o.format })
  if (o.steps) q.set('steps', '1')
  if (o.item !== null) q.set('item', o.item)
  if (o.timeZone !== null) q.set('tz', o.timeZone)
  return `${EXPORT_ROUTE}${encodeURIComponent(chatId)}?${q.toString()}`
}

/** The options a query names, or null when one is malformed; a zone that is not IANA-shaped is ignored, not refused. */
export function parseExportQuery(q: URLSearchParams): ExportOptions | null {
  const format = q.get('format') ?? 'md'
  if (!isExportFormat(format)) return null
  const steps = q.get('steps')
  if (steps !== null && steps !== '0' && steps !== '1') return null
  const item = q.get('item')
  if (item !== null && (item === '' || item.length > ITEM_MAX)) return null
  const tz = q.get('tz')
  return { format, steps: steps === '1', item, timeZone: tz !== null && ZONE_RE.test(tz) ? tz : null }
}

/** A file name from the chat's title: no path or control characters, at most 80 characters before the extension. */
export function exportFileName(title: string, format: ExportFormat, reply = false): string {
  const base = title
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, TITLE_MAX)
    .trim()
  return `${base || 'Chat'}${reply ? ' (reply)' : ''}.${format}`
}
