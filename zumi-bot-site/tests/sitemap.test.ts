import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE } from '../src/serverInstall.ts'

// public/sitemap.xml is written by hand, so a new page that is left out of it would never reach Google Search Console.
const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (file: string): string => readFileSync(join(site, file), 'utf8')

const pages = readdirSync(site)
  .filter((f) => f.endsWith('.html'))
  .map((f) => {
    const html = read(f)
    return {
      file: f,
      url: html.match(/<meta property="og:url" content="([^"]*)"/)?.[1],
      canonical: html.match(/<link rel="canonical" href="([^"]*)"/)?.[1]
    }
  })
const pageUrls = pages.map((p) => p.url)
const locs = [...read('public/sitemap.xml').matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1])

describe('sitemap', () => {
  it('lists every page by its og:url, and nothing else', () => {
    expect(pageUrls).not.toContain(undefined)
    expect([...locs].sort()).toEqual([...pageUrls].sort())
  })

  it("gives every page a canonical link equal to its og:url, so Google indexes the sitemap's URL", () => {
    for (const p of pages) expect(p.canonical, p.file).toBe(p.url)
  })

  it('lists only absolute URLs on this site', () => {
    for (const loc of locs) expect(loc.startsWith(`${SITE}/`)).toBe(true)
  })

  it('is named in robots.txt, which blocks nothing', () => {
    const robots = read('public/robots.txt')
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`)
    expect(robots).not.toMatch(/^Disallow:\s*\S/m)
  })
})
