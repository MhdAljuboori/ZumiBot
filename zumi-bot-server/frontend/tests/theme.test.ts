import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ACCENTS } from '@zumibot/shared/types'
import { ACCENT_BG, accentFromStorage, applyAccent, applyTheme, isDark, THEME_BG, themeColor, themeFromStorage } from '../src/theme'
import { styleFile, stylesheet } from './stylesheet'

const root = (): HTMLElement => ({ dataset: {} }) as unknown as HTMLElement

describe('applyTheme', () => {
  it('dark sets data-theme=dark', () => {
    const r = root()
    applyTheme('dark', r)
    expect(r.dataset.theme).toBe('dark')
  })

  it('light sets data-theme=light', () => {
    const r = root()
    applyTheme('light', r)
    expect(r.dataset.theme).toBe('light')
  })

  it('system removes data-theme', () => {
    const r = root()
    applyTheme('dark', r)
    applyTheme('system', r)
    expect('theme' in r.dataset).toBe(false)
  })

  it('points the theme-color tags at the theme', () => {
    const light = { media: '(prefers-color-scheme: light)', content: '' }
    const dark = { media: '(prefers-color-scheme: dark)', content: '' }
    const r = { dataset: {}, ownerDocument: { querySelectorAll: () => [light, dark] } } as unknown as HTMLElement
    applyTheme('dark', r)
    expect([light.content, dark.content]).toEqual([THEME_BG.dark, THEME_BG.dark])
    applyTheme('system', r)
    expect([light.content, dark.content]).toEqual([THEME_BG.light, THEME_BG.dark])
    applyTheme('light', r)
    expect([light.content, dark.content]).toEqual([THEME_BG.light, THEME_BG.light])
  })
})

describe('applyAccent', () => {
  const tags = () => {
    const light = { media: '(prefers-color-scheme: light)', content: '' }
    const dark = { media: '(prefers-color-scheme: dark)', content: '' }
    const r = { dataset: {}, ownerDocument: { querySelectorAll: () => [light, dark] } } as unknown as HTMLElement
    return { r, light, dark }
  }

  it('sets data-accent, and blue (the default, tokens.css :root) removes it', () => {
    const r = root()
    applyAccent('coral', r)
    expect(r.dataset.accent).toBe('coral')
    applyAccent('blue', r)
    expect('accent' in r.dataset).toBe(false)
  })

  it("points the theme-color tags at the color theme's background, with the theme still deciding light or dark", () => {
    const { r, light, dark } = tags()
    applyAccent('teal', r)
    expect([light.content, dark.content]).toEqual([ACCENT_BG.teal.light, ACCENT_BG.teal.dark])
    applyTheme('dark', r)
    expect([light.content, dark.content]).toEqual([ACCENT_BG.teal.dark, ACCENT_BG.teal.dark])
    applyAccent('graphite', r)
    expect([light.content, dark.content]).toEqual([ACCENT_BG.graphite.dark, ACCENT_BG.graphite.dark])
  })

  it("keeps each color theme's background equal to its tokens.css --bg", () => {
    const css = styleFile('tokens.css')
    for (const a of ACCENTS) {
      const block =
        a === 'blue'
          ? css.slice(0, css.indexOf(':root[data-theme'))
          : new RegExp(`:root\\[data-accent='${a}'\\]\\s*\\{([^}]*)\\}`).exec(css)?.[1]
      expect(block, a).toContain(`--bg: light-dark(${ACCENT_BG[a].light}, ${ACCENT_BG[a].dark});`)
    }
  })

  it('reads only a known color theme from the cached key', () => {
    expect(accentFromStorage('zumibot-accent', 'teal')).toBe('teal')
    expect(accentFromStorage('zumibot-accent', 'purple')).toBeNull()
    expect(accentFromStorage('zumibot-theme', 'teal')).toBeNull()
  })
})

describe('themeColor', () => {
  it('a forced theme wins over the tag', () => {
    expect(themeColor('dark', '(prefers-color-scheme: light)')).toBe(THEME_BG.dark)
    expect(themeColor('light', '(prefers-color-scheme: dark)')).toBe(THEME_BG.light)
  })
  it('system follows the tag, light for one without a media', () => {
    expect(themeColor('system', '(prefers-color-scheme: dark)')).toBe(THEME_BG.dark)
    expect(themeColor('system', '(prefers-color-scheme: light)')).toBe(THEME_BG.light)
    expect(themeColor('system', '')).toBe(THEME_BG.light)
  })
})

describe('index.html system bars', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const css = stylesheet()

  it("has a theme-color per OS scheme, in that scheme's --bg", () => {
    const tags = [...html.matchAll(/<meta name="theme-color" media="\(prefers-color-scheme: (\w+)\)" content="([^"]+)"/g)].map((m) => [
      m[1],
      m[2]
    ])
    expect(tags).toEqual([
      ['light', THEME_BG.light],
      ['dark', THEME_BG.dark]
    ])
    expect(html.match(/name="theme-color"/g)).toHaveLength(2)
    expect(css).toContain(`--bg: light-dark(${THEME_BG.light}, ${THEME_BG.dark});`)
  })

  it('draws under the system bars only with the body padded by the safe-area insets', () => {
    expect(html).toMatch(/name="viewport" content="[^"]*viewport-fit=cover/)
    expect(css).toMatch(
      /^body \{[^}]*padding: env\(safe-area-inset-top\) env\(safe-area-inset-right\) env\(safe-area-inset-bottom\) env\(safe-area-inset-left\);/m
    )
  })
})

describe('isDark', () => {
  const themed = (theme?: string): HTMLElement => ({ dataset: theme ? { theme } : {} }) as unknown as HTMLElement

  it('follows a forced theme over the OS', () => {
    expect(isDark(themed('dark'), false)).toBe(true)
    expect(isDark(themed('light'), true)).toBe(false)
  })

  it('follows the OS when the theme is system', () => {
    expect(isDark(themed(), true)).toBe(true)
    expect(isDark(themed(), false)).toBe(false)
  })
})

describe('stylesheet dark rules', () => {
  const css = stylesheet()
  const count = (re: RegExp): number => (css.match(re) ?? []).length

  it('every prefers-color-scheme dark rule has a guard and a matching data-theme=dark rule', () => {
    const media = count(/@media \(prefers-color-scheme: dark\)/g)
    expect(media).toBe(0) // the palette is one light-dark() block, not a twin per theme; the bot icons are one path
    const guarded = count(/:root:not\(\[data-theme='light'\]\)[^{,]*\{/g)
    const forced = count(/:root\[data-theme='dark'\] [^{,\s][^{,]*\{/g) // descendant rules; the bare color-scheme rule is checked below
    expect(guarded).toBeGreaterThanOrEqual(media)
    expect(forced).toBe(guarded)
  })

  it('has no unguarded rule inside a dark media block', () => {
    for (const m of css.matchAll(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/g)) {
      const selectors = m[1].split('\n').filter((l) => /\{\s*$|\{.*\}\s*$/.test(l) && !/^\s+--/.test(l))
      expect(selectors.every((l) => l.includes(":root:not([data-theme='light'])"))).toBe(true)
    }
  })

  it('keeps the palette in one :root block of light-dark() tokens', () => {
    const root = css.match(/^:root \{([\s\S]*?)\n\}/m)?.[1] ?? ''
    for (const t of [
      '--bg',
      '--bg-sidebar',
      '--bg-raised',
      '--bg-hover',
      '--bg-selected',
      '--fg',
      '--fg-muted',
      '--border',
      '--accent',
      '--sel-bg',
      '--sel-border',
      '--ring',
      '--link'
    ]) {
      expect(root).toMatch(new RegExp(`${t}: light-dark\\(`))
    }
  })

  it('color-scheme follows the forced theme', () => {
    expect(css).toMatch(/:root\[data-theme='light'\]\s*\{[^}]*color-scheme: light/)
    expect(css).toMatch(/:root\[data-theme='dark'\]\s*\{[^}]*color-scheme: dark/)
  })
})

describe('themeFromStorage', () => {
  it('takes a valid theme of the cache key only', () => {
    expect(themeFromStorage('zumibot-theme', 'dark')).toBe('dark')
    expect(themeFromStorage('zumibot-theme', 'light')).toBe('light')
    expect(themeFromStorage('zumibot-theme', 'system')).toBe('system')
  })
  it('ignores other keys, junk and a cleared value', () => {
    expect(themeFromStorage('other', 'dark')).toBeNull()
    expect(themeFromStorage('zumibot-theme', 'purple')).toBeNull()
    expect(themeFromStorage('zumibot-theme', null)).toBeNull()
    expect(themeFromStorage(null, 'dark')).toBeNull()
  })
})
