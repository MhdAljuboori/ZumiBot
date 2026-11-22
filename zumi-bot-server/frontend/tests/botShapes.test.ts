import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ICON_OPTIONS, LEGACY_ICONS } from '@zumibot/shared/frontmatter'
import { EYE_SHIFT, SHAPE_PATHS, ZUMI_PATHS, type ShapePaths } from '../src/botShapes'

const SOURCES = join(__dirname, '../../../design/zumibot-icon/zumibot-svg')
const sourceOf = (name: string): string => {
  const svg = readFileSync(join(SOURCES, `${name}.svg`), 'utf8')
  const d = [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1])
  expect(d).toHaveLength(1)
  return d[0]
}
const subPaths = (d: string): string[] => d.split(/(?=M)/).map((s) => s.trim())
// A sub-path's outline as a polygon: line ends as they are, each cubic curve cut into short straight steps (its control
// points are off the outline, so they would not do).
const points = (d: string): [number, number][] => {
  const tokens = d.match(/[MLCZ]|-?[\d.]+/g) ?? []
  const out: [number, number][] = []
  let cmd = ''
  for (let i = 0; i < tokens.length; ) {
    if (/[MLCZ]/.test(tokens[i])) {
      cmd = tokens[i++]
      continue
    }
    const n = (k: number): number => Number(tokens[i + k])
    if (cmd === 'C') {
      const [x0, y0] = out[out.length - 1]
      for (let s = 1; s <= 16; s++) {
        const t = s / 16
        const u = 1 - t
        const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
        out.push([w[0] * x0 + w[1] * n(0) + w[2] * n(2) + w[3] * n(4), w[0] * y0 + w[1] * n(1) + w[2] * n(3) + w[3] * n(5)])
      }
      i += 6
    } else {
      out.push([n(0), n(1)])
      i += 2
    }
  }
  return out
}
const inside = ([x, y]: [number, number], poly: [number, number][]): boolean => {
  let c = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c
  }
  return c
}
const all: [string, ShapePaths][] = [...Object.entries(SHAPE_PATHS), ['zumi-z', ZUMI_PATHS]]

describe('botShapes', () => {
  it('has a path for every shape the picker lists, and no other', () => {
    expect(Object.keys(SHAPE_PATHS).sort()).toEqual([...ICON_OPTIONS].sort())
  })

  it('splits each design source into its body and eyes, losing nothing', () => {
    for (const [name, s] of all) {
      expect([...subPaths(s.body), ...subPaths(s.eyes)].sort(), name).toEqual(subPaths(sourceOf(name)).sort())
      expect(subPaths(s.eyes).length, name).toBe(name === 'infinity' ? 4 : 2)
    }
  })

  it('keeps every eye on its face while it looks left and right', () => {
    for (const [name, s] of all) {
      const body = subPaths(s.body).map(points)
      for (const pt of subPaths(s.eyes).flatMap(points)) {
        const at = body.filter((poly) => inside(pt, poly)).length
        for (const dx of [-EYE_SHIFT, EYE_SHIFT]) {
          // Inside the same body sub-paths as before: never off the edge, into the visor's rim or into another hole.
          expect(body.filter((poly) => inside([pt[0] + dx, pt[1]], poly)).length, `${name} at ${dx}`).toBe(at)
        }
      }
    }
  })

  it('keeps zumi-z for Zumi Bot alone', () => {
    expect(ICON_OPTIONS as readonly string[]).not.toContain('zumi-z')
    expect(Object.values(LEGACY_ICONS)).not.toContain('zumi-z')
  })
})
