import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SHOTS } from '../shots/list.mjs'

const ROOT = join(import.meta.dirname, '..')
const DOCS = join(ROOT, 'src/content/docs')
const IMAGES = join(ROOT, 'src/assets/shots')

const pageFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? pageFiles(join(dir, e.name)) : /\.mdx?$/.test(e.name) ? [join(dir, e.name)] : []
  )
// Names used by `<Shot name="x" ...>` in any page; the name attribute comes first in every use.
const usedNames = () => pageFiles(DOCS).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/<Shot\s+name="([^"]+)"/g)].map((m) => m[1]))

describe('screenshots', () => {
  it('every Shot used in a page is listed and made', () => {
    const listed = new Set(SHOTS.map((s) => s.name))
    for (const name of usedNames()) {
      expect(listed.has(name), `${name} is not in SHOTS`).toBe(true)
      for (const theme of ['light', 'dark'])
        expect(existsSync(join(IMAGES, `${name}-${theme}.png`)), `${name}-${theme}.png is missing`).toBe(true)
    }
  })

  it('every listed shot is used', () => {
    const used = new Set(usedNames())
    for (const { name } of SHOTS) expect(used.has(name), `${name} is in SHOTS but no page uses it`).toBe(true)
  })

  it('shot names are unique and kebab-case', () => {
    const names = SHOTS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)+$/)
  })

  it('the Shot component throws on an unknown name', () => {
    // A page naming a missing image must fail the build, so the component has to check its glob.
    const src = readFileSync(join(ROOT, 'src/components/Shot.astro'), 'utf8')
    expect(src).toMatch(/throw new Error/)
  })
})
