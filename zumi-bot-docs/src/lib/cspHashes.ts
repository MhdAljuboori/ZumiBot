import { createHash } from 'node:crypto'

// Astro's `security.csp` hashes the scripts and styles it bundles, but not Starlight's `is:inline` scripts (theme
// init, sidebar state) or the `style="..."` attributes its components write. This adds those hashes to each page's
// CSP meta after the build, so the meta can stay hash-only (no 'unsafe-inline').

const META = /(<meta\b[^>]*http-equiv="content-security-policy"[^>]*\scontent=")([^"]*)(")/i
const SCRIPT = /<script\b(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi
const STYLE_TAG = /<style\b[^>]*>([\s\S]*?)<\/style>/gi
const STYLE_ATTR = /\sstyle="([^"]*)"/gi

const sha = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`
// The browser hashes the attribute's value, not its source text.
const unescapeAttr = (s: string) =>
  s.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

const all = (re: RegExp, html: string) => [...html.matchAll(re)].map((m) => m[1] ?? '')

/** The inline code on a page, as the hashes a browser would compute. */
function inline(html: string) {
  return {
    scripts: all(SCRIPT, html).filter((s) => s.trim() !== ''),
    styles: all(STYLE_TAG, html).filter((s) => s.trim() !== ''),
    attrs: all(STYLE_ATTR, html).map(unescapeAttr)
  }
}

const directive = (policy: string, name: string) => new RegExp(`(^|;)\\s*${name}\\s([^;]*)`).exec(policy)?.[2] ?? ''

/** Inline scripts, styles and style attributes whose hash the page's CSP meta does not carry. */
export function unhashedInline(html: string): string[] {
  const policy = META.exec(html)?.[2] ?? ''
  const script = directive(policy, 'script-src')
  const style = directive(policy, 'style-src')
  const { scripts, styles, attrs } = inline(html)
  const missing = (list: string[], src: string, kind: string) =>
    list.filter((s) => !src.includes(sha(s))).map((s) => `${kind}: ${s.trim().slice(0, 60)}`)
  return [...missing(scripts, script, 'script'), ...missing(styles, style, 'style'), ...missing(attrs, style, 'style attribute')]
}

/** `html` with every inline script, style and style attribute hashed into its CSP meta. No meta, no change. */
export function addInlineHashes(html: string): string {
  const found = META.exec(html)
  if (!found) return html
  const { scripts, styles, attrs } = inline(html)
  const extend = (policy: string, name: string, hashes: string[], extra = '') => {
    const current = directive(policy, name)
    const add = [...new Set(hashes)].filter((h) => !current.includes(h))
    if (add.length === 0 && (!extra || current.includes(extra))) return policy
    const next = [current.trim(), extra && !current.includes(extra) ? extra : '', ...add].filter(Boolean).join(' ')
    return current || policy.includes(`${name} `)
      ? policy.replace(new RegExp(`(^|;)(\\s*)${name}\\s[^;]*`), (_, lead, space) => `${lead}${space}${name} ${next}`)
      : `${policy.trimEnd().replace(/;?$/, ';')} ${name} ${next};`
  }
  let policy = found[2]!
  policy = extend(policy, 'script-src', scripts.map(sha))
  // 'unsafe-hashes' is what lets a hash allow a `style="..."` attribute.
  policy = extend(policy, 'style-src', [...styles, ...attrs].map(sha), attrs.length > 0 ? "'unsafe-hashes'" : '')
  return html.replace(META, (_, open, __, close) => `${open}${policy}${close}`)
}
