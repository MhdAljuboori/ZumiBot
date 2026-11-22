import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseAuditFilter, type AuditFilter, type AuditRecord } from '@zumibot/shared/audit'
import { readBody } from './body'

// Settings › Audit log's Export: the filtered range as JSON Lines, oldest first. The filter rides in the body, never the URL.

export const AUDIT_EXPORT_ROUTE = '/api/audit/export'
const BODY_MAX = 8 * 1024

export interface AuditExportSource {
  each(filter: AuditFilter): AsyncIterable<AuditRecord>
}

const fileStamp = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export async function handleAuditExport(req: IncomingMessage, res: ServerResponse, src: AuditExportSource, now: number): Promise<void> {
  const send = (status: number, error: string) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ error }))
  }
  if (req.method !== 'POST') return send(405, 'Method not allowed')
  const body = await readBody(req, BODY_MAX)
  if (body === null) return send(413, 'Filter too large')
  let filter: AuditFilter
  try {
    filter = parseAuditFilter(body.length === 0 ? {} : JSON.parse(body.toString('utf8')))
  } catch (e) {
    return send(400, e instanceof TypeError ? e.message : 'The filter is not valid JSON')
  }
  const name = `audit-${fileStamp(filter.from ?? 0)}-${fileStamp(filter.to ?? now)}.jsonl`
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store'
  })
  let closed = false
  res.on('close', () => {
    closed = true
  })
  for await (const r of src.each(filter)) {
    if (closed) break
    // Back-pressure: a slow download never piles the whole log up in memory.
    if (!res.write(JSON.stringify(r) + '\n')) await new Promise<void>((resolve) => res.once('drain', resolve))
  }
  res.end()
}
