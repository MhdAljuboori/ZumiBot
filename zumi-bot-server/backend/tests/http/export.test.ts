import { afterEach, describe, expect, it } from 'vitest'
import type { ChatItem, ChatMeta } from '@zumibot/shared/types'
import { parseExportPath, type ExportSource } from '../../src/http/export'
import { allowGate, startRig, type Rig } from './helpers'

const meta: ChatMeta = {
  id: 'c1',
  agentName: 'x-expert',
  sessionId: null,
  cwd: '/w',
  title: 'Q3 report: final',
  createdAt: 1,
  updatedAt: 2,
  inFlight: false
}
const items: ChatItem[] = [
  { type: 'user', id: 'u1', text: 'Sum it up', ts: Date.UTC(2026, 0, 1, 9, 0) },
  { type: 'assistant', id: 'a1', text: 'Revenue **up** <b>9%</b>', ts: Date.UTC(2026, 0, 1, 9, 1) }
]
const source = (zone: string | null = null): ExportSource => ({
  get: async (id) => (id === 'c1' ? meta : null),
  loadItems: async () => items,
  timeZone: async () => zone
})

let rig: Rig | null = null
afterEach(async () => {
  await rig?.close()
  rig = null
})

describe('parseExportPath', () => {
  it('reads a plain chat id only', () => {
    expect(parseExportPath('/api/export/c1')).toBe('c1')
    for (const p of ['/api/export/', '/api/export/c1/x', '/api/export/..', '/api/export/c%2F1', '/api/exports/c1'])
      expect(parseExportPath(p), p).toBeNull()
  })
})

describe('GET /api/export', () => {
  it('sends Markdown as a nosniff text download named after the chat', async () => {
    rig = await startRig({ exports: source() })
    const res = await fetch(`${rig.base}/api/export/c1?format=md&tz=Asia/Dubai`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="Q3 report final.md"; filename*=UTF-8''Q3%20report%20final.md`
    )
    const text = await res.text()
    expect(text.startsWith('# Q3 report: final\n')).toBe(true)
    expect(text).toContain('**You** · 2026-01-01 13:00')
    expect(text).toContain('Revenue **up** <b>9%</b>')
  })

  it('sends the HTML page as text too, so it never runs from the server', async () => {
    rig = await startRig({ exports: source('UTC') })
    const res = await fetch(`${rig.base}/api/export/c1?format=html`)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('content-disposition')).toContain('Q3 report final.html')
    const page = await res.text()
    expect(page).toContain('<strong>up</strong> &lt;b&gt;9%&lt;/b&gt;')
    expect(page).toContain('09:01')
  })

  it('exports one reply, and 404s a reply or chat it does not know', async () => {
    rig = await startRig({ exports: source('UTC') })
    const one = await fetch(`${rig.base}/api/export/c1?item=a1`)
    expect(one.headers.get('content-disposition')).toContain('Q3 report final (reply).md')
    expect(await one.text()).not.toContain('Sum it up')
    expect((await fetch(`${rig.base}/api/export/c1?item=u1`)).status).toBe(404)
    expect((await fetch(`${rig.base}/api/export/nope`)).status).toBe(404)
    expect((await fetch(`${rig.base}/api/export/c1?format=pdf`)).status).toBe(400)
  })

  it('answers nothing without a session', async () => {
    rig = await startRig({ gate: allowGate(false), exports: source() })
    expect((await fetch(`${rig.base}/api/export/c1`)).status).toBe(401)
  })

  it('is a plain 404 when the server has no exports', async () => {
    rig = await startRig()
    expect((await fetch(`${rig.base}/api/export/c1`)).status).toBe(404)
  })
})
