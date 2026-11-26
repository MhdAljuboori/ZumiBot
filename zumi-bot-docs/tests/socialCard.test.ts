import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OG_IMAGE, socialHead } from '../src/lib/socialCard.ts'

const SITE = 'https://docs.zumibot.run'
const meta = (key: string) => socialHead(SITE).find((t) => t.attrs.property === key || t.attrs.name === key)?.attrs.content

// Starlight writes og:title, og:description, og:url and twitter:card (summary_large_image) itself, but no image.
describe('social card', () => {
  it('adds an absolute og:image and twitter:image, with size, type and alt text', () => {
    expect(meta('og:image')).toBe(`${SITE}/${OG_IMAGE}`)
    expect(meta('twitter:image')).toBe(`${SITE}/${OG_IMAGE}`)
    expect(meta('og:image:type')).toBe('image/png')
    expect(meta('og:image:width')).toBe('1200')
    expect(meta('og:image:height')).toBe('630')
    expect(meta('og:image:alt')).toBeTruthy()
  })

  it('only adds meta tags, never twitter:card or a title Starlight already writes', () => {
    for (const t of socialHead(SITE)) expect(t.tag).toBe('meta')
    for (const key of ['twitter:card', 'og:title', 'og:description', 'og:url']) expect(meta(key)).toBeUndefined()
  })

  it('ships the image as a 1200x630 PNG small enough for every unfurler', () => {
    const file = join(import.meta.dirname, '..', 'public', OG_IMAGE)
    const png = readFileSync(file)
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG')
    expect(png.readUInt32BE(16)).toBe(1200)
    expect(png.readUInt32BE(20)).toBe(630)
    // X refuses cards over 5 MB; stay far under it.
    expect(statSync(file).size).toBeLessThan(1024 * 1024)
  })
})
