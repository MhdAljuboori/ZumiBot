// sitemap.xml is written at build time from the site's pages (every root *.html, see vite.config.ts), so a new page
// reaches Google Search Console with no hand edit. Pure, so tests/sitemap.test.ts can check it.
import { SITE } from './serverInstall.ts'

const OG_URL = /<meta property="og:url" content="([^"]*)"/
const CANONICAL = /<link rel="canonical" href="([^"]*)"/

/**
 * A page's public URL: its og:url, which its canonical link must repeat so Google indexes the URL the sitemap lists.
 * Throws, failing the build, when a page has no og:url, one off this site, or a canonical that differs.
 */
export function pageUrl(file: string, html: string): string {
  const url = OG_URL.exec(html)?.[1]
  if (!url) throw new Error(`${file}: no og:url meta, so the sitemap cannot list it`)
  if (!url.startsWith(`${SITE}/`)) throw new Error(`${file}: og:url ${url} is not on ${SITE}`)
  const canonical = CANONICAL.exec(html)?.[1]
  if (canonical !== url) throw new Error(`${file}: canonical link ${canonical ?? '(none)'} differs from og:url ${url}`)
  return url
}

const escapeXml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c)

/** The sitemap of these URLs, sorted. Two pages with one URL means a copied og:url, so that throws too. */
export function sitemapXml(urls: readonly string[]): string {
  const sorted = [...urls].sort()
  const dup = sorted.find((u, i) => sorted[i + 1] === u)
  if (dup) throw new Error(`two pages share the og:url ${dup}`)
  const entries = sorted.map((u) => `  <url>\n    <loc>${escapeXml(u)}</loc>\n  </url>\n`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}</urlset>\n`
}
