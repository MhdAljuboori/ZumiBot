import { describe, expect, it } from 'vitest'
import { exportFileName, exportUrl, parseExportQuery } from '../src/chatExport'

describe('exportUrl and parseExportQuery', () => {
  it('round-trips every option', () => {
    const o = { format: 'html' as const, steps: true, item: 'toolu_01:x', timeZone: 'America/Argentina/Buenos_Aires' }
    const url = exportUrl('chat-1', o)
    expect(url.startsWith('/api/export/chat-1?')).toBe(true)
    expect(parseExportQuery(new URL(url, 'http://x').searchParams)).toEqual(o)
    expect(parseExportQuery(new URLSearchParams())).toEqual({ format: 'md', steps: false, item: null, timeZone: null })
  })
  it('refuses a bad format, steps or item, and ignores an odd zone', () => {
    expect(parseExportQuery(new URLSearchParams('format=pdf'))).toBeNull()
    expect(parseExportQuery(new URLSearchParams('steps=yes'))).toBeNull()
    expect(parseExportQuery(new URLSearchParams('item='))).toBeNull()
    expect(parseExportQuery(new URLSearchParams(`item=${'a'.repeat(201)}`))).toBeNull()
    expect(parseExportQuery(new URLSearchParams('tz=../../etc'))?.timeZone).toBeNull()
    expect(parseExportQuery(new URLSearchParams('tz=a b'))?.timeZone).toBeNull()
  })
})

describe('exportFileName', () => {
  it('keeps the title readable and safe', () => {
    expect(exportFileName('Fix: the/build?', 'md')).toBe('Fix the build.md')
    expect(exportFileName('..hidden', 'html')).toBe('hidden.html')
    expect(exportFileName('   ', 'md')).toBe('Chat.md')
    expect(exportFileName('تقرير المبيعات', 'html', true)).toBe('تقرير المبيعات (reply).html')
    expect(exportFileName('x'.repeat(200), 'md')).toBe(`${'x'.repeat(80)}.md`)
  })
})
