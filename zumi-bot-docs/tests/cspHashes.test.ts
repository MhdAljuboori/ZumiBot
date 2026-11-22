import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { addInlineHashes, unhashedInline } from '../src/lib/cspHashes.ts'

const hash = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`
const page = (body: string, meta = "script-src 'self'; style-src 'self';") =>
  `<html><head><meta http-equiv="content-security-policy" content="${meta}"></head><body>${body}</body></html>`

describe('addInlineHashes', () => {
  it('hashes an inline script the meta lacks', () => {
    const out = addInlineHashes(page('<script>\n  go()\n</script>'))
    expect(out).toContain(hash('\n  go()\n'))
    expect(unhashedInline(out)).toEqual([])
  })

  it('hashes inline style tags and style attributes, and allows hashed attributes', () => {
    const out = addInlineHashes(page('<style>a{b:c}</style><p style="--x: 1em; font-family: &quot;A&quot;">hi</p>'))
    expect(out).toContain(hash('a{b:c}'))
    expect(out).toContain(hash('--x: 1em; font-family: "A"'))
    expect(out).toMatch(/style-src 'self' 'unsafe-hashes'/)
    expect(unhashedInline(out)).toEqual([])
  })

  it('leaves external scripts alone and does not add unsafe-hashes without a style attribute', () => {
    const html = page('<script type="module" src="/_astro/a.js"></script><style>a{b:c}</style>')
    const out = addInlineHashes(html)
    expect(out).not.toContain("'unsafe-hashes'")
    expect(out).not.toContain(hash(''))
  })

  it('is idempotent and keeps hashes Astro already wrote', () => {
    const meta = `script-src 'self' ${hash('x()')}; style-src 'self';`
    const once = addInlineHashes(page('<script>x()</script><script>y()</script>', meta))
    expect(addInlineHashes(once)).toBe(once)
    expect(once.split(hash('x()')).length - 1).toBe(1)
  })

  it('returns a page without a CSP meta unchanged, and reports its scripts as unhashed', () => {
    const html = '<html><body><script>x()</script></body></html>'
    expect(addInlineHashes(html)).toBe(html)
    expect(unhashedInline(html)).toHaveLength(1)
  })
})
