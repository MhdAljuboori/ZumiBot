import type { ReactNode } from 'react'
import { Bot } from './Bot.tsx'
import { GitHubMark } from './Glyph.tsx'
import { CONTACT_EMAIL, DOCS_URL, GITHUB_URL, NAV, SPONSOR_PATH, linkFor } from './siteLinks.ts'
import { useTheme } from './useTheme.ts'

/** A filled heart in the link's color; the link around it carries the name. */
export function Heart({ size = 16 }: { size?: number }) {
  return (
    <svg className="heart" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 21c-.3 0-.6-.1-.8-.3C7.4 17.6 3 14 3 9.4 3 6.4 5.3 4 8.2 4c1.6 0 3 .8 3.8 2 .8-1.2 2.2-2 3.8-2C18.7 4 21 6.4 21 9.4c0 4.6-4.4 8.2-8.2 11.3-.2.2-.5.3-.8.3z" />
    </svg>
  )
}

/** The header every page shares. `onHome` keeps the section links as in-page anchors; `cast` is the home page's. */
export function SiteHeader({ onHome, cast }: { onHome: boolean; cast?: ReactNode }) {
  const theme = useTheme()
  const themeLabel = theme.dark ? 'Switch to light theme' : 'Switch to dark theme'
  return (
    <header className="top">
      <div className="wrap top-in">
        <a className="brand" href={onHome ? '#top' : '/'}>
          <Bot zumi size={30} />
          <span>ZumiBot</span>
        </a>
        <nav className="navlinks" aria-label="Sections">
          {NAV.map((n) => (
            <a key={n.href} href={linkFor(n.href, onHome)}>
              {n.label}
            </a>
          ))}
          <a href={DOCS_URL}>Docs</a>
        </nav>
        <div className="top-end">
          {cast}
          <a className="icon-btn sponsor-btn" href={SPONSOR_PATH} aria-current={onHome ? undefined : 'page'} aria-label="Sponsor ZumiBot" title="Sponsor ZumiBot">
            <Heart size={19} />
          </a>
          <button type="button" className="icon-btn" onClick={theme.toggle} aria-label={themeLabel} title={themeLabel}>
            <Bot zumi size={26} asleep={theme.dark} />
          </button>
          <a className="icon-btn gh-btn" href={GITHUB_URL} rel="noopener noreferrer" aria-label="ZumiBot on GitHub" title="ZumiBot on GitHub">
            <GitHubMark size={20} />
          </a>
        </div>
      </div>
    </header>
  )
}

export function SiteFooter() {
  return (
    <footer className="foot">
      <div className="wrap foot-in">
        <Bot zumi size={26} working tilt="a" />
        <p className="muted">
          A personal tool, built and used every day by{' '}
          <a href="https://mhdaljuboori.me/" rel="noopener noreferrer">
            Mohammed Al-Juboori
          </a>
          .
        </p>
        <nav className="foot-links" aria-label="Links">
          <a href={DOCS_URL}>Docs</a>
          <a href={SPONSOR_PATH}>Sponsor</a>
          <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
        </nav>
      </div>
    </footer>
  )
}
