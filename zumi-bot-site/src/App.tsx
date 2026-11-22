import { useEffect, useState } from 'react'
import { AgentBot, Bot } from './Bot.tsx'
import { downloadsFor, pickFor, type PublishedInstaller } from './downloads.ts'
import { GitHubMark } from './Glyph.tsx'
import type { ReleaseInfo } from './releaseInfo.ts'
import { AGENTS, CAST, castState, formatDate, type SceneId } from './showcase.ts'
import { useScenes } from './useScenes.ts'
import { AutomationScene } from './scenes/Automation.tsx'
import { BuiltOnBand } from './scenes/BuiltOn.tsx'
import { ChatScene } from './scenes/Chat.tsx'
import { ControlScene } from './scenes/Control.tsx'
import { DownloadScene } from './scenes/Download.tsx'
import { EverywhereScene } from './scenes/Everywhere.tsx'
import { Hero } from './scenes/Hero.tsx'
import { MachineScene } from './scenes/Machine.tsx'
import { ReleaseScene } from './scenes/Release.tsx'
import { RoomScene } from './scenes/Room.tsx'
import { ServerScene } from './scenes/Server.tsx'
import { StudioScene } from './scenes/Studio.tsx'
import { VoiceScene } from './scenes/Voice.tsx'
import { WorkScene } from './scenes/Work.tsx'
import { useVisitor } from './useVisitor.ts'

// release.json is written by scripts/fetchRelease.mjs before each build; a fresh checkout has none, hence the glob.
// `downloads` is missing from a release.json older than the installers.
type SiteRelease = ReleaseInfo & { downloads?: PublishedInstaller[] }
const found = import.meta.glob<SiteRelease | null>('./release.json', { eager: true, import: 'default' })
const releaseInfo: SiteRelease | null = Object.values(found)[0] ?? null
const release = releaseInfo && { version: releaseInfo.version, date: formatDate(releaseInfo.publishedAt), notes: releaseInfo.notes }
const downloads = releaseInfo ? downloadsFor(releaseInfo.version, releaseInfo.downloads) : []

const NAV = [
  { href: '#studio', label: 'Agents' },
  { href: '#room', label: 'Rooms' },
  { href: '#control', label: 'Control' },
  { href: '#automation', label: 'Automation' },
  { href: '#work', label: 'Work' },
  { href: '#release', label: 'Release' },
  { href: '#download', label: 'Download' }
]

// The user docs, a separate site (zumi-bot-docs).
const DOCS_URL = 'https://docs.zumibot.run'
// Its home page only: the page never links into the source or the releases. The docs site's header carries both too.
const GITHUB_URL = 'https://github.com/MhdAljuboori/ZumiBot'
const CONTACT_EMAIL = 'contact@zumibot.run'

const darkQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null

/** The page follows the system until the theme button is pressed; the choice lasts for the visit. */
function useTheme(): { dark: boolean; toggle: () => void } {
  const [forced, setForced] = useState<'light' | 'dark' | null>(null)
  const [systemDark, setSystemDark] = useState(() => darkQuery()?.matches ?? false)
  useEffect(() => {
    const mq = darkQuery()
    if (!mq) return
    const on = () => setSystemDark(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  useEffect(() => {
    if (forced) document.documentElement.dataset.theme = forced
    else delete document.documentElement.dataset.theme
  }, [forced])
  const dark = forced ? forced === 'dark' : systemDark
  return { dark, toggle: () => setForced(dark ? 'light' : 'dark') }
}

function Cast({ active }: { active: SceneId }) {
  const cast = castState(active)
  return (
    <>
      <span className="castlabel">{cast.label}</span>
      <div className="cast" aria-hidden="true">
        {CAST.map((id) => (
          <span key={id} title={AGENTS[id].name}>
            <AgentBot id={id} size={24} working={cast.working === id} look={cast.look[id]} />
          </span>
        ))}
      </div>
    </>
  )
}

export function App() {
  const { visible, active } = useScenes()
  const theme = useTheme()
  const { visitor, arch } = useVisitor()
  const pick = pickFor(downloads, visitor, arch)
  const cls = (id: SceneId): string => (visible.has(id) ? 'in' : '')
  const themeLabel = theme.dark ? 'Switch to light theme' : 'Switch to dark theme'

  return (
    <div className="root">
      <header className="top">
        <div className="wrap top-in">
          <a className="brand" href="#top">
            <Bot zumi size={30} />
            <span>ZumiBot</span>
          </a>
          <nav className="navlinks" aria-label="Sections">
            {NAV.map((n) => (
              <a key={n.href} href={n.href}>
                {n.label}
              </a>
            ))}
            <a href={DOCS_URL}>Docs</a>
          </nav>
          <div className="top-end">
            <Cast active={active} />
            <button type="button" className="icon-btn" onClick={theme.toggle} aria-label={themeLabel} title={themeLabel}>
              <Bot zumi size={26} asleep={theme.dark} />
            </button>
            <a className="icon-btn gh-btn" href={GITHUB_URL} rel="noopener noreferrer" aria-label="ZumiBot on GitHub" title="ZumiBot on GitHub">
              <GitHubMark size={20} />
            </a>
          </div>
        </div>
      </header>

      <main id="top">
        <Hero cls={cls('hero')} release={release} />
        <BuiltOnBand />
        <ChatScene cls={cls('chat')} />
        <StudioScene cls={cls('studio')} />
        <RoomScene cls={cls('room')} />
        <ControlScene cls={cls('control')} />
        <AutomationScene cls={cls('auto')} />
        <MachineScene cls={cls('machine')} />
        <WorkScene cls={cls('work')} />
        <VoiceScene cls={cls('voice')} />
        <EverywhereScene cls={cls('everywhere')} />
        <ReleaseScene cls={cls('release')} release={release} />
        <DownloadScene cls={cls('download')} version={release?.version ?? null} downloads={downloads} pick={pick} visitor={visitor} />
        <ServerScene cls={cls('server')} ready={release !== null} />
      </main>

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
            <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </nav>
        </div>
      </footer>
    </div>
  )
}
