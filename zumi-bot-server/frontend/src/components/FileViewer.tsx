import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { formatSize } from '@zumibot/shared/attachments'
import { api } from '../api'
import { nextTrapIndex } from '../net/folderPicker'
import { islandBridge } from '../net/island'
import { looksBinary } from '../state/filesPanel'
import { viewer, viewerKey, type ViewerItem, type ViewerState } from '../state/viewer'
import { cachedText, useLoadedTexts } from '../useSnapshotText'

const FOCUSABLE = 'a[href], button:not(:disabled), [tabindex="0"]'
// The shell opens a sent file in its default app; a browser can only give it a tab.
const NATIVE = islandBridge !== null || 'zumibotDesktop' in window
const OPEN_LABEL = NATIVE ? 'Open in default app' : 'Open in new tab'

const FileIcon = () => (
  <svg className="viewer-file-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M4 1.75h5l3 3v9.5H4z M9 1.75v3h3" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
  </svg>
)

const Chevron = ({ back }: { back: boolean }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d={back ? 'M10 3L5 8l5 5' : 'M6 3l5 5-5 5'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

/** Fitted to the stage; a click on one larger than the stage shows it at full size around the clicked point, and back. */
function ImageView({ item, stage }: { item: ViewerItem; stage: RefObject<HTMLDivElement | null> }) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'broken'>('loading')
  const [big, setBig] = useState(false)
  const [zoom, setZoom] = useState(false)
  const at = useRef<{ x: number; y: number } | null>(null)
  const img = useRef<HTMLImageElement>(null)

  // After the full-size layout lands: scroll so the clicked point sits where the click was.
  useLayoutEffect(() => {
    const s = stage.current
    const i = img.current
    const p = at.current
    at.current = null
    if (!zoom || !s || !i || !p) return
    s.scrollLeft = p.x * i.naturalWidth - s.clientWidth / 2
    s.scrollTop = p.y * i.naturalHeight - s.clientHeight / 2
  }, [zoom, stage])

  const click = (e: MouseEvent<HTMLImageElement>): void => {
    const i = e.currentTarget
    // Measured again here: the window may have been resized since the image loaded.
    if (!zoom && !(i.naturalWidth > i.clientWidth + 1 || i.naturalHeight > i.clientHeight + 1)) return
    const r = i.getBoundingClientRect()
    at.current = zoom ? null : { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
    setZoom((z) => !z)
  }

  if (status === 'broken')
    return (
      <div className="viewer-note" role="alert">
        File missing
      </div>
    )
  return (
    <>
      {status === 'loading' && (
        <div className="viewer-note viewer-loading" role="status">
          <span className="spinner" aria-hidden="true" /> Loading…
        </div>
      )}
      <img
        ref={img}
        className={`viewer-img${zoom ? ' zoomed' : ''}${big ? ' big' : ''}`}
        data-testid="viewer-image"
        data-state={status}
        src={item.url}
        alt={item.name}
        draggable={false}
        onLoad={(e) => {
          const i = e.currentTarget
          setBig(i.naturalWidth > i.clientWidth + 1 || i.naturalHeight > i.clientHeight + 1)
          setStatus('ready')
        }}
        onError={() => setStatus('broken')}
        onClick={click}
        data-tip={big ? (zoom ? 'Fit to screen' : 'Show full size') : undefined}
      />
    </>
  )
}

function TextView({ item, onOpen }: { item: ViewerItem; onOpen: (() => void) | null }) {
  const { ready, failed } = useLoadedTexts([item.url])
  const text = ready ? (cachedText(item.url) ?? '') : null
  if (text !== null && looksBinary(text)) return <FileCard item={item} onOpen={onOpen} />
  // Always a text node: an html or svg file shows its source, never runs as a page.
  if (text !== null)
    return (
      <pre className="viewer-text" data-testid="viewer-text" tabIndex={0}>
        {text}
      </pre>
    )
  if (failed)
    return (
      <div className="viewer-note" role="alert">
        Couldn't load this file
      </div>
    )
  return (
    <div className="viewer-note" role="status">
      <span className="spinner" aria-hidden="true" /> Loading…
    </div>
  )
}

function FileCard({ item, onOpen }: { item: ViewerItem; onOpen: (() => void) | null }) {
  return (
    <div className="viewer-card" data-testid="viewer-file">
      <FileIcon />
      <div className="viewer-card-name">{item.name}</div>
      {item.size !== undefined && <div className="viewer-card-size">{formatSize(item.size)}</div>}
      <p className="viewer-card-note">No preview for this type of file.</p>
      <div className="viewer-card-actions">
        {onOpen && (
          <button type="button" className="btn primary" onClick={onOpen}>
            {OPEN_LABEL}
          </button>
        )}
        {item.download && (
          <a className="btn" href={item.download} download={item.name}>
            Download
          </a>
        )}
      </div>
    </div>
  )
}

function Viewer({ state, contained }: { state: ViewerState; contained: boolean }) {
  const { items, index } = state
  const item = items[index]
  const many = items.length > 1
  const box = useRef<HTMLDivElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  // Files the default-app open found gone, by key, for this viewer's life.
  const [missing, setMissing] = useState<Set<string>>(new Set())
  const count = useRef(items.length)
  count.current = items.length

  // Focus starts on Close and goes back where it was, so Esc returns the reader to the thumbnail they opened.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    close.current?.focus()
    return () => {
      if (before && before.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  // Capture, on the window: the viewer is over everything, so Esc and the arrows are its own before any page handler sees them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const k = viewerKey(e)
      if (k === null) {
        if (e.key !== 'Tab') return
        const all = Array.from(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
        const to = nextTrapIndex(all.length, all.indexOf(document.activeElement as HTMLElement), e.shiftKey)
        if (to !== null) {
          e.preventDefault()
          all[to].focus()
        }
        return
      }
      // A lone file leaves the arrows to what has focus, such as a long line of text.
      if (k !== 'close' && count.current < 2) return
      e.preventDefault()
      e.stopPropagation()
      if (k === 'close') viewer.close()
      else viewer.move(k === 'next' ? 1 : -1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const external = item.external
  const open = external
    ? (): void => {
        void api.attachments.open(external.chatId, external.id, item.name).then((ok) => {
          if (!ok) setMissing((prev) => new Set(prev).add(item.key))
        })
      }
    : null
  const gone = missing.has(item.key)

  return (
    <div
      ref={box}
      className={`modal-backdrop viewer-backdrop${contained ? ' contained' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`Preview of ${item.name}`}
      data-testid="file-viewer"
      data-kind={item.kind}
    >
      <header className="viewer-bar">
        <div className="viewer-title">
          <span className="viewer-name" data-testid="viewer-name" data-tip={item.name}>
            {item.name}
          </span>
          <span className="viewer-meta">
            {item.size !== undefined && <span>{formatSize(item.size)}</span>}
            {many && (
              <span data-testid="viewer-count">
                {index + 1} / {items.length}
              </span>
            )}
            {gone && (
              <span className="viewer-gone" role="alert">
                File missing
              </span>
            )}
          </span>
        </div>
        <div className="viewer-actions">
          {open && item.kind !== 'file' && (
            <button type="button" className="btn small" data-testid="viewer-open" onClick={open}>
              {OPEN_LABEL}
            </button>
          )}
          {item.download && (
            <a className="btn small" data-testid="viewer-download" href={item.download} download={item.name}>
              Download
            </a>
          )}
          <button
            ref={close}
            type="button"
            className="icon-btn viewer-close"
            data-testid="viewer-close"
            aria-label="Close preview"
            data-tip="Close (Esc)"
            onClick={() => viewer.close()}
          >
            ✕
          </button>
        </div>
      </header>
      <div
        ref={stage}
        className="viewer-stage"
        data-kind={item.kind}
        // A press on the empty stage around the file closes, as a dialog's backdrop does.
        onMouseDown={(e) => e.target === e.currentTarget && viewer.close()}
      >
        {item.kind === 'image' ? (
          <ImageView key={item.key} item={item} stage={stage} />
        ) : item.kind === 'text' ? (
          <TextView key={item.key} item={item} onOpen={open} />
        ) : (
          <FileCard key={item.key} item={item} onOpen={open} />
        )}
      </div>
      {many && (
        <>
          <button
            type="button"
            className="viewer-step prev"
            data-testid="viewer-prev"
            aria-label="Previous file"
            data-tip="Previous (←)"
            onClick={() => viewer.move(-1)}
          >
            <Chevron back />
          </button>
          <button
            type="button"
            className="viewer-step next"
            data-testid="viewer-next"
            aria-label="Next file"
            data-tip="Next (→)"
            onClick={() => viewer.move(1)}
          >
            <Chevron back={false} />
          </button>
        </>
      )}
    </div>
  )
}

/**
 * Draws the page's one file viewer while something has opened it. `contained` keeps it inside its parent (the island's
 * popup, whose window shows nothing outside it) instead of over the whole page.
 */
export function ViewerHost({ contained = false }: { contained?: boolean }) {
  const state = useSyncExternalStore(viewer.subscribe, viewer.get)
  // A host that leaves (the island's popup closing) takes its viewer with it, so it never reopens by itself.
  useEffect(() => () => viewer.close(), [])
  if (state === null) return null
  const view = <Viewer state={state} contained={contained} />
  return contained ? view : createPortal(view, document.body)
}
