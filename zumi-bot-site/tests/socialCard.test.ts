import { describe, expect, it } from 'vitest'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SITE } from '../src/serverInstall.ts'

// Link previews (Slack, X, iMessage, LinkedIn) read index.html as served, before any script runs.
const site = join(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(join(site, 'index.html'), 'utf8')

function meta(attr: 'name' | 'property', key: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/g) ?? []) {
    if (!new RegExp(`\\b${attr}="${key}"`).test(tag)) continue
    return tag.match(/\bcontent="([^"]*)"/)?.[1]
  }
  return undefined
}

describe('social card', () => {
  it('names an absolute og:image on this site, with its size and alt text', () => {
    expect(meta('property', 'og:image')).toBe(`${SITE}/og-image.png`)
    expect(meta('property', 'og:image:width')).toBe('1200')
    expect(meta('property', 'og:image:height')).toBe('630')
    expect(meta('property', 'og:image:alt')).toBeTruthy()
    expect(meta('name', 'twitter:card')).toBe('summary_large_image')
    expect(meta('name', 'twitter:image')).toBe(`${SITE}/og-image.png`)
  })

  it('has a title, url and description, the description the same as the page one', () => {
    expect(meta('property', 'og:title')).toBe('ZumiBot')
    expect(meta('property', 'og:site_name')).toBe('ZumiBot')
    expect(meta('property', 'og:type')).toBe('website')
    expect(meta('property', 'og:url')).toBe(`${SITE}/`)
    expect(meta('name', 'description')).toBeTruthy()
    expect(meta('property', 'og:description')).toBe(meta('name', 'description'))
  })

  it('ships the image as a 1200x630 PNG small enough for every unfurler', () => {
    const file = join(site, 'public', 'og-image.png')
    const png = readFileSync(file)
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(630)
    // X refuses cards over 5 MB; stay far under it.
    expect(statSync(file).size).toBeLessThan(1024 * 1024)
  })
})
