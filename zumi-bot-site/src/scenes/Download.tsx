import { Bot } from '../Bot.tsx'
import { Glyph } from '../Glyph.tsx'
import { INSTALLER_SUMS, PLATFORM_NAME, buildLabel, byPlatform, firstOpen, formatSize, isPreview, type Download, type Pick, type Visitor } from '../downloads.ts'

function PreviewTag({ platform }: { platform: Download['platform'] }) {
  return isPreview(platform) ? <span className="pill dl-preview">Preview</span> : null
}

function FirstOpen({ d }: { d: Download }) {
  return <Note note={firstOpen(d)} />
}

function Note({ note }: { note: { text: string; code?: string } }) {
  return (
    <p className="dl-note">
      {note.text}
      {note.code && (
        <>
          {' '}
          <code className="code">{note.code}</code>
        </>
      )}
    </p>
  )
}

/** The question and the link for a second build of the featured system. */
function altLine(d: Download): [string, string] {
  if (d.kind === 'dmg') return d.arch === 'x64' ? ['On an Intel Mac?', 'Download the Intel build'] : ['On an Apple silicon Mac?', 'Download the Apple silicon build']
  if (d.kind === 'AppImage') return ['Not on Debian or Ubuntu?', 'Download the AppImage']
  if (d.kind === 'deb') return ['On Debian or Ubuntu?', 'Download the .deb']
  return ['Another build:', `Download ${buildLabel(d)}`]
}

/** The visitor's own build: the app's icon, one prominent button, the same system's other builds as plain links. */
function Featured({ pick, version }: { pick: Pick; version: string }) {
  const { main, alts } = pick
  return (
    <div className="win dl-card" data-testid="dl-featured">
      <div className="dl-card-head">
        <span className="dl-icon">
          <Bot zumi size={40} />
        </span>
        <div className="col-4">
          <p className="dl-card-title">
            ZumiBot for {PLATFORM_NAME[main.platform]} <PreviewTag platform={main.platform} />
          </p>
          <p className="muted small-13">
            v{version} · {buildLabel(main)}
          </p>
        </div>
      </div>
      <a className="btn pri big dl-main" href={main.href} download>
        <Glyph name="download" size={18} weight={2.2} />
        Download for {PLATFORM_NAME[main.platform]}
        <span className="dl-meta">
          .{main.kind} · {formatSize(main.size)}
        </span>
      </a>
      {alts.map((a) => {
        const [ask, link] = altLine(a)
        return (
          <p key={a.file} className="small-14 muted">
            {ask}{' '}
            <a href={a.href} download>
              {link}
            </a>{' '}
            <span className="mono small-13">
              (.{a.kind} · {formatSize(a.size)})
            </span>
          </p>
        )
      })}
      <FirstOpen d={main} />
    </div>
  )
}

/** One system: its name, a row per build, and its first-open notes once each (two Mac builds share one). */
function OtherGroup({ builds }: { builds: Download[] }) {
  const notes = builds.map(firstOpen).filter((n, i, all) => all.findIndex((m) => m.text === n.text && m.code === n.code) === i)
  return (
    <li>
      <p className="dl-group-name">
        {PLATFORM_NAME[builds[0].platform]} <PreviewTag platform={builds[0].platform} />
      </p>
      {builds.map((d) => (
        <a key={d.file} className="dl-row" href={d.href} download aria-label={`Download for ${PLATFORM_NAME[d.platform]}${isPreview(d.platform) ? ' (preview)' : ''}, ${buildLabel(d)}, .${d.kind}, ${formatSize(d.size)}`}>
          <span className="dl-row-name">{buildLabel(d)}</span>
          <span className="dl-row-meta mono">
            .{d.kind} · {formatSize(d.size)}
          </span>
          <Glyph name="download" size={16} weight={2} />
        </a>
      ))}
      {notes.map((n) => (
        <Note key={n.text} note={n} />
      ))}
    </li>
  )
}

function Lead({ visitor }: { visitor: Visitor }) {
  if (visitor === 'mobile')
    return (
      <p className="muted" data-testid="dl-mobile">
        There is no phone app: on a phone, ZumiBot is a server you open in the browser and add to the home screen.{' '}
        <a href="#server">Install it on a server</a>.
      </p>
    )
  return <p className="muted">Pick the build for your computer.</p>
}

export function DownloadScene({
  cls,
  version,
  downloads,
  pick,
  visitor
}: {
  cls: string
  version: string | null
  downloads: Download[]
  pick: Pick | null
  visitor: Visitor
}) {
  const others = pick ? pick.others : downloads
  return (
    <section id="download" data-scene="download" className={`scene band ${cls}`} aria-labelledby="download-h">
      <div className="wrap split">
        <div className="txt">
          <p className="lbl">12 · Download</p>
          <h2 className="h2" id="download-h">
            Take it home.
          </h2>
          <p className="lede">
            The desktop app runs its own server on your Mac, Linux or Windows PC, or connects to one you run elsewhere. Same app, same agents.
          </p>
          <ul className="facts">
            <li>Running it on this computer needs the Claude Code CLI, installed and signed in.</li>
            <li>On Windows it also needs Git for Windows; computer use and the agent browser need Linux.</li>
            <li>Not signed yet: macOS and Windows ask once before the first open.</li>
          </ul>
        </div>
        <div className="mock col-14">
          {version === null ? (
            <div className="win pad-26">
              <p className="muted" data-testid="dl-soon">
                Downloads coming soon.
              </p>
            </div>
          ) : downloads.length === 0 ? (
            <div className="win pad-26 col-14">
              <p data-testid="dl-pending">The desktop builds of v{version} are still on their way.</p>
              <p className="muted">
                The server is ready now: <a href="#server">install it on a server</a>.
              </p>
            </div>
          ) : (
            <>
              {pick ? <Featured pick={pick} version={version} /> : <Lead visitor={visitor} />}
              {others.length > 0 && (
                <div className="col-10">
                  {pick && <p className="lbl">Other systems</p>}
                  <ul className="win dl-list">
                    {byPlatform(others).map((g) => (
                      <OtherGroup key={g.platform} builds={g.builds} />
                    ))}
                  </ul>
                </div>
              )}
              <p className="small-13 muted">
                <a href={`/releases/${version}/${INSTALLER_SUMS}`}>SHA-256 checksums</a> for every v{version} build.
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  )
}
