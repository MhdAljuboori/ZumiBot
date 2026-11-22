import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const html = readFileSync(join(__dirname, '../src/pages/picker.html'), 'utf8')

describe('server picker page', () => {
  it('ships no prefilled server address, so no owner domain reaches users', () => {
    const tag = html.match(/<input[^>]*id="url"[^>]*>/s)?.[0] ?? ''
    expect(tag).not.toBe('')
    expect(tag).not.toMatch(/\svalue=/)
    expect(html).not.toMatch(/mhdaljuboori/i)
  })
})
