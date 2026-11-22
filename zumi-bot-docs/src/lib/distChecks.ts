// Checks `scripts/checkDist.mjs` runs on every built page. Pure, so tests/distChecks.test.ts can feed them strings.

/** `html` with the text inside script and style tags removed, so code strings are not read as markup. The tags stay. */
const withoutCode = (html: string): string => html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?(<\/\2>)/gi, '$1$3')

const TAG = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
const ATTR = /\s((?:xlink:)?href|src|srcset|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi
const REMOTE = /^\s*(https?:)?\/\//i
// A link of these kinds only names this site or another page. It loads nothing.
const HARMLESS_REL = new Set(['canonical', 'alternate', 'sitemap'])

const unescapeAttr = (s: string): string =>
  s.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

/** Every HTML comment in a page's markup. Astro and Starlight write none, so one is a leftover from a page's source. */
export function htmlComments(html: string): string[] {
  return [...withoutCode(html).matchAll(/<!--[\s\S]*?-->/g)].map((m) => m[0].slice(0, 80))
}

/**
 * Tags that load something from another host: any `src`, `href`, `srcset` or `poster` that points to `http:`, `https:` or `//`, on every tag
 * except `<a>` (a click, not a load) and a `<link>` whose rel is only canonical, alternate or sitemap. Also `@import` and `url(...)` with a
 * host in a style block or a style attribute.
 */
export function remoteLoads(html: string): string[] {
  const problems: string[] = []
  const markup = withoutCode(html)
  for (const m of markup.matchAll(TAG)) {
    const [tag, name, attrs] = [m[0], m[1]!.toLowerCase(), m[2]!]
    if (name === 'a') continue
    if (name === 'link') {
      const rel = /\srel\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/i.exec(attrs)
      const tokens = (rel?.[1] ?? rel?.[2] ?? rel?.[3] ?? '').toLowerCase().split(/\s+/).filter(Boolean)
      if (tokens.length > 0 && tokens.every((t) => HARMLESS_REL.has(t))) continue
    }
    for (const a of attrs.matchAll(ATTR)) {
      const value = unescapeAttr(a[2] ?? a[3] ?? a[4] ?? '')
      // A srcset lists several URLs, each followed by a size.
      const urls = a[1]!.toLowerCase() === 'srcset' ? value.split(',') : [value]
      if (urls.some((u) => REMOTE.test(u))) problems.push(`${name} ${a[1]} points to another host (${tag.slice(0, 120)})`)
    }
  }
  const css: string[] = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]!)
  for (const m of markup.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) css.push(unescapeAttr(m[1] ?? m[2] ?? ''))
  for (const text of css) {
    if (/@import\s+(url\(\s*)?["']?\s*(https?:)?\/\//i.test(text) || /url\(\s*["']?\s*(https?:)?\/\//i.test(text)) {
      problems.push(`style loads from another host (${text.trim().slice(0, 80)})`)
    }
  }
  return problems
}
