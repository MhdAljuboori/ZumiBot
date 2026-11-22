import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

type Header = { key: string; value: string }
type Rule = { source: string; headers: Header[] }
const config = JSON.parse(readFileSync(join(import.meta.dirname, '../vercel.json'), 'utf8')) as {
  installCommand: string
  buildCommand: string
  outputDirectory: string
  headers: Rule[]
}

const headerValue = (source: string, key: string) =>
  config.headers.find((r) => r.source === source)?.headers.find((h) => h.key === key)?.value

describe('vercel.json', () => {
  it('builds from the repo root like the site', () => {
    expect(config.installCommand).toBe('cd .. && npm ci --ignore-scripts -w @zumibot/docs')
    expect(config.buildCommand).toBe('cd .. && npm run build -w @zumibot/docs')
    expect(config.outputDirectory).toBe('dist')
  })

  it('header CSP allows no third-party origin', () => {
    const csp = headerValue('/(.*)', 'Content-Security-Policy') ?? ''
    expect(csp).not.toContain('http')
    for (const part of ["frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'", "object-src 'none'"]) {
      expect(csp).toContain(part)
    }
  })

  it("keeps the site's other headers", () => {
    expect(headerValue('/(.*)', 'X-Content-Type-Options')).toBe('nosniff')
    expect(headerValue('/(.*)', 'Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(headerValue('/(.*)', 'X-Frame-Options')).toBe('DENY')
    expect(headerValue('/_astro/(.*)', 'Cache-Control')).toBe('public, max-age=31536000, immutable')
  })
})
