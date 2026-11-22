import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AuditFilter, AuditRecord } from '@zumibot/shared/audit'
import { handleAuditExport } from '../../src/http/auditExport'

let server: http.Server | null = null
afterEach(() => {
  server?.close()
  server = null
})

const records = [
  { id: 'a', tool: 'Bash' },
  { id: 'b', tool: 'Read' }
] as unknown as AuditRecord[]
async function serve(seen: AuditFilter[]): Promise<string> {
  server = http.createServer((req, res) => {
    void handleAuditExport(
      req,
      res,
      {
        async *each(f) {
          seen.push(f)
          for (const r of records) if (!f.tool || r.tool === f.tool) yield r
        }
      },
      Date.UTC(2026, 10, 17)
    )
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/audit/export`
}

describe('audit export route', () => {
  it('streams the filtered records as JSON Lines, the filter taken from the body', async () => {
    const seen: AuditFilter[] = []
    const url = await serve(seen)
    const res = await fetch(url, { method: 'POST', body: JSON.stringify({ tool: 'Read', junk: 1 }) })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="audit-1970-01-01-2026-11-17.jsonl"')
    expect(
      (await res.text())
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l).id)
    ).toEqual(['b'])
    expect(seen).toEqual([{ tool: 'Read' }])
  })

  it('refuses a GET, a bad filter and a body that is not JSON', async () => {
    const url = await serve([])
    expect((await fetch(url)).status).toBe(405)
    expect((await fetch(url, { method: 'POST', body: JSON.stringify({ outcome: 'great' }) })).status).toBe(400)
    expect((await fetch(url, { method: 'POST', body: '{' })).status).toBe(400)
    expect((await fetch(url, { method: 'POST', body: 'x'.repeat(9000) })).status).toBe(413)
  })
})
