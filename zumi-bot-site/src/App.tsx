import { AgentBot } from './Bot.tsx'
import { SiteFooter, SiteHeader } from './Chrome.tsx'
import { downloadsFor, pickFor, type PublishedInstaller } from './downloads.ts'
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
import { SponsorBand } from './scenes/SponsorBand.tsx'
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
  const { visitor, arch } = useVisitor()
  const pick = pickFor(downloads, visitor, arch)
  const cls = (id: SceneId): string => (visible.has(id) ? 'in' : '')

  return (
    <div className="root">
      <SiteHeader onHome cast={<Cast active={active} />} />

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
        <SponsorBand />
      </main>

      <SiteFooter />
    </div>
  )
}
