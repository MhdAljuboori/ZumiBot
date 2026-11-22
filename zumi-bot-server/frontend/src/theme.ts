import { isAccent, type Accent, type ThemePref } from '@zumibot/shared/types'

const CACHE_KEY = 'zumibot-theme'
const ACCENT_KEY = 'zumibot-accent'

const parsePref = (v: unknown): ThemePref | null => (v === 'light' || v === 'dark' || v === 'system' ? v : null)

/** A theme the main window cached, read from a `storage` event of the island page (same origin, other window); anything else is null. */
export function themeFromStorage(key: string | null, value: string | null): ThemePref | null {
  return key === CACHE_KEY ? parsePref(value) : null
}

/** The same for the color theme. */
export function accentFromStorage(key: string | null, value: string | null): Accent | null {
  return key === ACCENT_KEY && isAccent(value) ? value : null
}

/** Each color theme's page background, styles/tokens.css's `--bg` (the default's on :root, the others' under data-accent):
 *  an installed app's status bar is painted in theme-color. */
export const ACCENT_BG: Readonly<Record<Accent, { light: string; dark: string }>> = {
  blue: { light: '#ffffff', dark: '#13161c' },
  teal: { light: '#ffffff', dark: '#141819' },
  coral: { light: '#ffffff', dark: '#1a1615' },
  graphite: { light: '#ffffff', dark: '#161618' }
}
/** The default color theme's, which index.html's tags start in. */
export const THEME_BG = ACCENT_BG.blue

/** The color for a theme-color tag: index.html has one per OS scheme (its `media`), so 'system' gives each tag its
 *  own scheme's background and lets the browser pick by the OS, while a forced theme gives both the same one. */
export function themeColor(pref: ThemePref, media: string, accent: Accent = 'blue'): string {
  const dark = pref === 'system' ? /prefers-color-scheme:\s*dark/.test(media) : pref === 'dark'
  return dark ? ACCENT_BG[accent].dark : ACCENT_BG[accent].light
}

const shownAccent = (root: HTMLElement): Accent => (isAccent(root.dataset.accent) ? root.dataset.accent : 'blue')

// The system bars follow theme-color, not the page: a dark theme forced on a light phone showed them white. Both the
// theme and the color theme change it, so each reads the other from the root.
function paintBars(root: HTMLElement): void {
  const pref = parsePref(root.dataset.theme) ?? 'system'
  for (const tag of root.ownerDocument?.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]') ?? []) {
    tag.content = themeColor(pref, tag.media, shownAccent(root))
  }
}

/** 'system' leaves data-theme off so the OS preference decides; light and dark force it. */
export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  if (pref === 'system') delete root.dataset.theme
  else root.dataset.theme = pref
  paintBars(root)
}

/** Blue, the default, is tokens.css's :root and leaves data-accent off; the others set it. */
export function applyAccent(accent: Accent, root: HTMLElement = document.documentElement): void {
  if (accent === 'blue') delete root.dataset.accent
  else root.dataset.accent = accent
  paintBars(root)
}

/** The theme showing now: a forced one, else the OS preference. */
export function isDark(root: HTMLElement, prefersDark: boolean): boolean {
  return root.dataset.theme === undefined ? prefersDark : root.dataset.theme === 'dark'
}

function readCache<T>(key: string, parse: (v: unknown) => T | null): T | null {
  try {
    return parse(localStorage.getItem(key))
  } catch {
    return null // storage blocked: it resolves once the server answers
  }
}

function writeCache(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage blocked: only the early paint is lost
  }
}

/** The last theme applied, kept locally so the next load paints in it before the server answers. */
export const cachedTheme = (): ThemePref | null => readCache(CACHE_KEY, parsePref)
export const cacheTheme = (pref: ThemePref): void => writeCache(CACHE_KEY, pref)

/** The same for the color theme, so a non-blue choice does not flash blue on load. */
export const cachedAccent = (): Accent | null => readCache(ACCENT_KEY, (v) => (isAccent(v) ? v : null))
export const cacheAccent = (accent: Accent): void => writeCache(ACCENT_KEY, accent)
