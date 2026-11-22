import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// The app draws its own tooltip from `data-tip` (TooltipLayer.tsx); a native `title` would bring back the browser's
// unstyled popup next to it.

const SRC = join(import.meta.dirname, '..', 'src')
/** Components that pass their props straight to a DOM element. */
const DOM_LIKE = new Set(['ControlButton'])

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.tsx?$/.test(e.name) ? [p] : []
  })
}

/** Index just past the brace that closes the one at `open`, skipping strings and template literals. */
function closeBrace(s: string, open: number): number {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === "'" || c === '`') {
      i = s.indexOf(c, i + 1)
      if (i < 0) return s.length
    } else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i + 1
  }
  return s.length
}

/** Offsets of `title` given to a DOM element in one file: as an attribute or inside an attribute spread. */
export function domTitles(s: string): number[] {
  const found: number[] = []
  for (const m of s.matchAll(/<([A-Za-z][\w.]*)/g)) {
    if (!/^[a-z]/.test(m[1]) && !DOM_LIKE.has(m[1])) continue
    // Walk the attributes until the tag's own `>`, jumping over `{...}` expressions.
    let i = m.index + m[0].length
    while (i < s.length && s[i] !== '>' && s[i] !== '<') {
      if (s[i] === '{') {
        const end = closeBrace(s, i)
        const expr = s.slice(i, end)
        if (expr.startsWith('{...') && /['"]?\btitle['"]?\s*:/.test(expr)) found.push(i)
        i = end
      } else if (s[i] === '"' || s[i] === "'") {
        i = s.indexOf(s[i], i + 1) + 1
        if (i === 0) break
      } else {
        if (/\stitle=/.test(s.slice(i - 1, i + 6))) found.push(i)
        i++
      }
    }
  }
  // An SVG title element; a comment's "in <title>" placeholder has no closing tag.
  for (const m of s.matchAll(/<title>[^<]*<\/title>/g)) found.push(m.index)
  for (const m of s.matchAll(/(?<!document)\.title\s*=(?!=)|setAttribute\(\s*['"]title['"]/g)) found.push(m.index)
  return found
}

const lineOf = (s: string, at: number): number => s.slice(0, at).split('\n').length

describe('no native title', () => {
  it('finds a title in every shape it takes', () => {
    expect(domTitles('<span className="x" title="Hi">a</span>')).toHaveLength(1)
    expect(domTitles('<button\n  onClick={() => go(a > b)}\n  title={t}\n>')).toHaveLength(1)
    expect(domTitles("<div {...(on ? { title: 'Busy' } : {})} />")).toHaveLength(1)
    expect(domTitles('<ControlButton title="Zoom" />')).toHaveLength(1)
    expect(domTitles('<svg><title>{x}</title></svg>')).toHaveLength(1)
    expect(domTitles('el.title = name')).toHaveLength(1)
  })

  it('leaves component props, tips and the page title alone', () => {
    expect(domTitles('<Dialog title="Run attempts" onClose={close}>')).toEqual([])
    expect(domTitles('<span data-tip="Hi" aria-label="Hi">a</span>')).toEqual([])
    expect(domTitles('<CardHead title={`a ${b}`} subtitle="s" />')).toEqual([])
    expect(domTitles('document.title = badgeTitle(BASE_TITLE, n)')).toEqual([])
    expect(domTitles('const t = { title: "x" }; <div className={t.title}>')).toEqual([])
  })

  it('is used nowhere in the app', () => {
    const hits = sources(SRC).flatMap((file) => {
      const s = readFileSync(file, 'utf8')
      return domTitles(s).map((at) => `${relative(SRC, file)}:${lineOf(s, at)}`)
    })
    expect(hits, 'use data-tip (TooltipLayer.tsx) instead of a native title').toEqual([])
  })
})
