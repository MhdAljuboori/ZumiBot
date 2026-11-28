import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SITE = 'https://docs.zumibot.run'
const read = (...parts: string[]) => readFileSync(join(import.meta.dirname, '..', ...parts), 'utf8')

// Starlight writes sitemap-index.xml itself from `site`; robots.txt only tells crawlers where it is.
describe('robots.txt', () => {
  it('names the sitemap Starlight writes, and blocks nothing', () => {
    const robots = read('public', 'robots.txt')
    expect(robots).toContain(`Sitemap: ${SITE}/sitemap-index.xml`)
    expect(robots).not.toMatch(/^Disallow:\s*\S/m)
  })

  it("matches astro.config's site, without which Starlight writes no sitemap", () => {
    expect(read('astro.config.mjs')).toContain(`const SITE = '${SITE}'`)
  })
})
