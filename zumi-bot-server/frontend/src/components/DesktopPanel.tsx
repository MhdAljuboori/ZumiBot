import { useEffect, useRef, useState } from 'react'
import type RFB from '@novnc/novnc'
import { displayName } from '@zumibot/shared/frontmatter'
import { desktopStatusLine, markerPosition, PASTE_MAX, pasteText, takeControlEnabled } from '../state/desktopView'
import { useDesktop } from '../useAgentDesktop'
import { SideBackButton } from './SidePanelMenu'

// noVNC (with its WebCodecs probe) loads when a desktop is first shown, so it never weighs on the main bundle.
let loading: Promise<typeof RFB> | null = null
const loadRfb = (): Promise<typeof RFB> =>
  (loading ??= import('@novnc/novnc').then(
    (m) => m.default,
    (error) => {
      loading = null
      throw error
    }
  ))

/**
 * The agent's desktop, live. `onBack` (the side panel over a chat) adds a way back to the panel's list; `approvalPending`
 * says a desktop action of this agent waits on a card in the chat on screen.
 */
export function DesktopPanel({
  inline = false,
  onBack,
  approvalPending = false
}: {
  inline?: boolean
  onBack?: () => void
  approvalPending?: boolean
}) {
  const desktop = useDesktop()
  const surfaceRef = useRef<HTMLDivElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFB | null>(null)
  const [box, setBox] = useState<{ width: number; height: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const state = desktop?.state,
    status = state?.status
  const open = !!state?.open
  const shown = open && !!state?.visible
  const control = !!state?.control && status?.control === 'you'
  const controlRef = useRef(control)
  controlRef.current = control
  const attach = desktop?.attach
  // The stream runs only while a panel shows it: one hidden behind Files or a closed card stops it.
  useEffect(() => (open && attach ? attach() : undefined), [open, attach])
  const leg = desktop?.leg ?? null
  useEffect(() => {
    const el = screenRef.current
    if (!el || !leg || !shown || !desktop) return
    let rfb: RFB | null = null,
      gone = false,
      ended = false
    void loadRfb().then(
      (Rfb) => {
        if (gone || leg.channel.readyState !== WebSocket.OPEN) return
        try {
          rfb = new Rfb(el, leg.channel, { shared: true })
        } catch {
          desktop.failed(leg.seq)
          return
        }
        // The picture fits the panel; the desktop keeps its own size, so the agent's coordinates stay valid.
        rfb.scaleViewport = true
        rfb.resizeSession = false
        rfb.clipViewport = false
        rfb.showDotCursor = true
        rfb.background = 'transparent'
        rfb.viewOnly = !controlRef.current
        rfb.addEventListener('disconnect', (e) => {
          ended = true
          if (!gone && !(e as CustomEvent<{ clean: boolean }>).detail.clean) desktop.failed(leg.seq)
        })
        rfbRef.current = rfb
      },
      () => {
        if (!gone) desktop.failed(leg.seq, 'The desktop viewer could not be loaded.')
      }
    )
    return () => {
      gone = true
      if (rfbRef.current === rfb) rfbRef.current = null
      if (rfb && !ended) rfb.disconnect()
    }
    // A new leg is a new RFB; `desktop` is a fresh object every render, its methods read refs.
  }, [leg, shown])
  // Watching never sends input; the server drops it anyway unless this window holds control.
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = !control
  }, [control])
  // A paste while in control becomes the desktop's clipboard (a sign-in needs it); Ctrl+V itself goes through noVNC as
  // keys. The event's own data only: the shell allows no clipboard reads. The text is never logged or kept.
  useEffect(() => {
    const el = screenRef.current
    if (!el || !control) return
    const paste = (e: ClipboardEvent): void => {
      const got = pasteText(e.clipboardData, PASTE_MAX)
      if (!got) return
      e.preventDefault()
      if ('error' in got) {
        setNotice(got.error)
        return
      }
      setNotice(null)
      rfbRef.current?.clipboardPasteFrom(got.text)
    }
    el.addEventListener('paste', paste)
    return () => el.removeEventListener('paste', paste)
  }, [control, shown])
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])
  useEffect(() => {
    const el = surfaceRef.current
    if (!el || !shown) return
    const report = (): void => {
      const r = el.getBoundingClientRect()
      setBox(r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : null)
    }
    const observer = new ResizeObserver(report)
    observer.observe(el)
    report()
    return () => observer.disconnect()
  }, [shown])
  if (!desktop || !state?.open) return null
  const agent = displayName(state.target?.agent ?? '')
  const line = desktopStatusLine(state, approvalPending)
  const ready = status?.state === 'ready'
  // Off and unavailable have nothing to draw; the body says why instead.
  const blocked = status?.state === 'off' || status?.state === 'unavailable'
  const stopped = status?.state === 'stopped'
  const marker = state.marker && status && box ? markerPosition(state.marker, status, box) : null
  const empty = blocked
    ? line
    : stopped
      ? 'The desktop is not running.'
      : !leg
        ? status?.state === 'queued'
          ? 'Waiting for a desktop…'
          : 'Connecting to the desktop…'
        : null
  return (
    <section className={`desktop-panel${inline ? ' inline' : ''}`} aria-label={`${agent} desktop`} data-testid="desktop-panel">
      <header className="browser-header">
        <span className="side-head-title">
          {onBack && <SideBackButton onBack={onBack} />}
          <span className="browser-title">
            Desktop <span>· {agent}</span>
          </span>
        </span>
        <div className="browser-header-actions">
          <button className="icon-btn" type="button" aria-label="Close desktop" onClick={desktop.close}>
            ✕
          </button>
        </div>
      </header>
      <div className="browser-control">
        <label className="browser-switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Take control"
            checked={control || state.controlPending}
            disabled={!takeControlEnabled(state)}
            onChange={(e) => void desktop.takeControl(e.target.checked)}
          />
          <span>Take control</span>
        </label>
        <span role="status" className={control ? 'browser-owner active' : 'browser-owner'} data-testid="desktop-status">
          {line}
        </span>
      </div>
      {state.error && !blocked ? (
        <div className="browser-error" role="alert">
          {state.error}{' '}
          <button type="button" className="btn small" onClick={desktop.retry}>
            Retry
          </button>
        </div>
      ) : (
        notice && (
          <div className="browser-error" role="alert" data-testid="desktop-paste-notice">
            {notice}
          </div>
        )
      )}
      <div className="desktop-surface" ref={surfaceRef} data-testid="desktop-surface">
        {/* noVNC draws into this box; it stays mounted so a leg can attach whenever one opens. */}
        <div className="desktop-screen" ref={screenRef} role="img" aria-label="Live desktop" hidden={blocked || stopped} />
        {marker && (
          <span className="desktop-marker" data-testid="desktop-marker" style={{ left: marker.left, top: marker.top }} aria-hidden="true" />
        )}
        {empty && (
          <div className="desktop-empty">
            <span>{empty}</span>
            {stopped && !state.error && (
              <button type="button" className="btn small" onClick={desktop.retry}>
                Start desktop
              </button>
            )}
          </div>
        )}
      </div>
      <footer className="browser-footer">
        <span className={`browser-dot${ready && leg ? ' live' : ''}`} />
        {ready && leg ? 'Live desktop' : 'Not live'}
        <span>
          {control
            ? 'Your keys and clicks go to the desktop'
            : state.marker
              ? 'The mark shows where the agent wants to act'
              : 'Take control to use the desktop'}
        </span>
      </footer>
    </section>
  )
}
