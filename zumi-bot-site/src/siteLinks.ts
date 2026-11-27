// Links every page of the site shares: the header and footer render them on the home page and on /sponsor.

/** The user docs, a separate site (zumi-bot-docs). */
export const DOCS_URL = 'https://docs.zumibot.run'
/** Its home page only: the site never links into the source or the releases. The docs site's header carries both too. */
export const GITHUB_URL = 'https://github.com/MhdAljuboori/ZumiBot'
export const CONTACT_EMAIL = 'contact@zumibot.run'
/** This site's own page (sponsor.html; vercel.json's cleanUrls serves it without the extension). */
export const SPONSOR_PATH = '/sponsor'

export interface SiteLink {
  href: string
  label: string
}

export const NAV: readonly SiteLink[] = [
  { href: '#studio', label: 'Agents' },
  { href: '#room', label: 'Rooms' },
  { href: '#control', label: 'Control' },
  { href: '#automation', label: 'Automation' },
  { href: '#work', label: 'Work' },
  { href: '#release', label: 'Release' },
  { href: '#download', label: 'Download' }
]

/** The section links are anchors on the home page; from any other page they go through `/`. */
export function linkFor(href: string, onHome: boolean): string {
  return !onHome && href.startsWith('#') ? `/${href}` : href
}
