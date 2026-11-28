import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE } from '../src/serverInstall.ts'
import { pageUrl, sitemapXml } from '../src/sitemap.ts'

const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file: string): string => readFileSync(join(site, file), 'utf8')
const page = (ogUrl?: string, canonical?: string): string =>
  [
    ogUrl === undefined ? '' : `<meta property="og:url" content="${ogUrl}" />`,
    canonical === undefined ? '' : `<link rel="canonical" href="${canonical}" />`
  ].join('\n')
const locs = (xml: string): string[] => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1])

describe('pageUrl', () => {
  it("returns a page's og:url when its canonical repeats it", () => {
    expect(pageUrl('x.html', page(`${SITE}/x`, `${SITE}/x`))).toBe(`${SITE}/x`)
  })

  it('fails a page with no og:url, one off this site, or a canonical that differs', () => {
    expect(() => pageUrl('x.html', page(undefined, `${SITE}/x`))).toThrow('x.html: no og:url')
    expect(() => pageUrl('x.html', page('https://example.com/x', 'https://example.com/x'))).toThrow('not on')
    expect(() => pageUrl('x.html', page(`${SITE}/x`))).toThrow('canonical link (none) differs')
    expect(() => pageUrl('x.html', page(`${SITE}/x`, `${SITE}/y`))).toThrow('differs from og:url')
  })
})

describe('sitemapXml', () => {
  it('lists the URLs sorted, escaped, in the sitemaps.org namespace', () => {
    const xml = sitemapXml([`${SITE}/b`, `${SITE}/a?x=1&y=2`])
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')).toBe(true)
    expect(locs(xml)).toEqual([`${SITE}/a?x=1&amp;y=2`, `${SITE}/b`])
  })

  it('fails when two pages share a URL', () => {
    expect(() => sitemapXml([`${SITE}/`, `${SITE}/`])).toThrow('two pages share')
  })
})

// vite.config.ts builds every root *.html and lists it, so these are the pages the live sitemap holds.
describe("the site's pages", () => {
  const files = readdirSync(site).filter((f) => f.endsWith('.html'))

  it('all pass pageUrl, so the build does not fail on them', () => {
    const urls = files.map((f) => pageUrl(f, read(f)))
    expect(locs(sitemapXml(urls))).toEqual(expect.arrayContaining([`${SITE}/`, `${SITE}/sponsor`]))
  })

  it('are listed in robots.txt by the sitemap, which blocks nothing', () => {
    const robots = read('public/robots.txt')
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`)
    expect(robots).not.toMatch(/^Disallow:\s*\S/m)
  })
})
