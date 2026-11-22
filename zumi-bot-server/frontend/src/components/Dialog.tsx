import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** A small modal over the card, closed by Esc, the scrim or ✕. */
export function Dialog({ title, onClose, testId, children }: { title: string; onClose: () => void; testId: string; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  // To the body, not the card: the board's drawer is its own containing block, and these float over the whole window.
  return createPortal(
    <div className="attempt-scrim" onMouseDown={onClose}>
      <div className="attempt-dialog" data-testid={testId} role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="attempt-dialog-head">
          <h3>{title}</h3>
          <span className="grow" />
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="attempt-dialog-body">{children}</div>
      </div>
    </div>,
    document.body
  )
}
