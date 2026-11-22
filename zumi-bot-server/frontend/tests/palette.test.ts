import { describe, expect, it } from 'vitest'
import { COLOR_OPTIONS } from '@zumibot/shared/frontmatter'
import { ACCENTS } from '@zumibot/shared/types'
import { styleFile } from './stylesheet'

// WCAG AA for the palette in styles/tokens.css, both themes and every color theme: a token change that drops text below
// 4.5:1 (or a dot or ring below 3:1) fails here instead of in someone's eyes.
const css = styleFile('tokens.css')
const rootBlock = css.slice(0, css.indexOf(':root[data-theme'))

type Pair = [light: string, dark: string]
// Reads plain light-dark() hex tokens (and aliases of ones already read) from a block of declarations.
function readTokens(block: string, base: Map<string, Pair> = new Map()): Map<string, Pair> {
  const tokens = new Map(base)
  for (const m of block.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    const v = m[2]!.trim()
    const ld = /^light-dark\((#[0-9a-f]{6}),\s*(#[0-9a-f]{6})\)$/i.exec(v)
    const alias = /^var\(--([\w-]+)\)$/.exec(v)
    if (ld) tokens.set(m[1]!, [ld[1]!, ld[2]!])
    else if (/^#[0-9a-f]{6}$/i.test(v)) tokens.set(m[1]!, [v, v])
    else if (alias && tokens.has(alias[1]!)) tokens.set(m[1]!, tokens.get(alias[1]!)!)
  }
  return tokens
}
const blue = readTokens(rootBlock)
// Each other color theme restates some tokens over the default's.
const palettes: [name: string, tokens: Map<string, Pair>][] = [['blue', blue]]
for (const m of css.matchAll(/:root\[data-accent='(\w+)'\]\s*\{([^}]*)\}/g)) palettes.push([m[1]!, readTokens(m[2]!, blue)])

const luminance = (hex: string): number => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}
const SURFACES = ['bg', 'bg-sidebar', 'bg-raised', 'bg-hover', 'bg-selected', 'user-bubble', 'reply-bubble']

it('reads every color theme the Color setting offers', () => {
  expect(palettes.map(([name]) => name).sort()).toEqual([...ACCENTS].sort())
})

describe.each(palettes)('palette contrast: %s', (_name, tokens) => {
  const token = (name: string): Pair => {
    const t = tokens.get(name)
    if (!t) throw new Error(`--${name} is not a plain light-dark() hex token`)
    return t
  }
  const expectContrast = (fg: string, bg: string, min: number) => {
    const [f, b] = [token(fg), token(bg)]
    expect(ratio(f[0], b[0]), `--${fg} on --${bg}, light`).toBeGreaterThanOrEqual(min)
    expect(ratio(f[1], b[1]), `--${fg} on --${bg}, dark`).toBeGreaterThanOrEqual(min)
  }

  it('muted text reads on every surface', () => {
    for (const s of SURFACES) expectContrast('fg-muted', s, 4.5)
  })
  it('accent text reads on every surface, and the text on the accent reads on its fill', () => {
    for (const s of SURFACES) expectContrast('accent-text', s, 4.5)
    expectContrast('accent-fg', 'accent', 4.5)
  })
  it('status and link text read on the page and their own fills', () => {
    for (const fg of ['link', 'error', 'success', 'warning']) for (const s of ['bg', 'bg-raised']) expectContrast(fg, s, 4.5)
    expectContrast('error', 'error-bg', 4.5)
    expectContrast('success-fg', 'success', 4.5)
    expectContrast('sel-fg', 'sel-bg', 4.5)
    expectContrast('sel-fg', 'tile-bg', 4.5)
  })
  it('every agent color has an ink that reads as text', () => {
    for (const c of COLOR_OPTIONS) for (const s of ['bg', 'bg-raised', 'bg-hover', 'user-bubble', 'reply-bubble']) expectContrast(`agent-${c}-ink`, s, 4.5)
  })
  it('dots and focus rings stand out at 3:1', () => {
    expectContrast('status-new', 'bg', 3)
    expectContrast('ring', 'bg', 3)
    expectContrast('accent', 'bg', 3)
  })
})
