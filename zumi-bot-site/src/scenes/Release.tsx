import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// A release body is the author's own text, but it is still rendered without links or images: nothing on the page leads out.
function Notes({ notes }: { notes: string }) {
  return (
    <div className="notes">
      <Markdown
        remarkPlugins={[remarkGfm]}
        // Headings shift down (h1/h2 to h3, h3 to h4) so the page keeps its own h1 and h2.
        components={{ a: ({ children }) => <span>{children}</span>, img: () => null, h1: 'h3', h2: 'h3', h3: 'h4' }}
        skipHtml
      >
        {notes}
      </Markdown>
    </div>
  )
}

export function ReleaseScene({ cls, release }: { cls: string; release: { version: string; date: string; notes: string } | null }) {
  return (
    <section id="release" data-scene="release" className={`scene ${cls}`} aria-labelledby="release-h">
      <div className="wrap split">
        <div className="txt">
          <p className="lbl">11 · Latest release</p>
          <h2 className="h2" id="release-h">
            What changed.
          </h2>
          <p className="lede">
            It updates itself from Settings › About and shows these notes. If a release misbehaves, one click rolls it back.
          </p>
        </div>
        <div className="mock">
          <div className="win pad-26 col-14">
            {release ? (
              <>
                <p className="release-head" data-testid="release-head">
                  <span className="release-version">v{release.version}</span>
                  {release.date !== '' && <span className="mono muted small-13">{release.date}</span>}
                </p>
                {release.notes.trim() !== '' ? <Notes notes={release.notes} /> : <p className="muted">No notes for this release.</p>}
              </>
            ) : (
              <p className="muted" data-testid="release-soon">
                Release notes coming soon.
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
