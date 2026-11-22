import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { slowHint } from '../state/update'

const SLOW_MS = 90_000

/** Covers the app while the server swaps itself; the reload itself is useUpdate's, once the server answers at a new version. */
export function UpdatingOverlay({ local }: { local: boolean }) {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(t)
  }, [])
  useEffect(() => {
    // The overlay sits in the body, outside #root, so everything else can go inert: the keyboard must not reach Update or the composer.
    const root = document.getElementById('root')
    if (root) root.inert = true
    return () => {
      if (root) root.inert = false
    }
  }, [])
  return createPortal(
    <div className="updating-overlay" role="status" aria-live="polite" data-testid="updating-overlay">
      <div className="spinner" aria-hidden="true" />
      <p className="updating-title">Updating ZumiBot…</p>
      <p className="updating-sub">It will be back in a moment.</p>
      {slow && (
        <p className="updating-sub">
          This is taking longer than expected.{' '}
          <button type="button" className="btn small" autoFocus onClick={() => location.reload()}>
            Reload
          </button>
        </p>
      )}
      {slow && <p className="updating-sub">{slowHint(local)}</p>}
    </div>,
    document.body
  )
}
