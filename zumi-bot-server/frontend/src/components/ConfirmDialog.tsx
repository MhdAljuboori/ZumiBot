import { useEffect } from 'react'

export interface ConfirmButton {
  label: string
  value: string
  danger?: boolean
}

interface Props {
  title: string
  message: string
  /** Exact text shown whole under the message, in monospace (a command with its hidden characters spelled out). */
  detail?: string
  buttons: ConfirmButton[]
  /** Value of the button to focus first; defaults to the first non-danger button. */
  initialFocus?: string
  /** Called with the chosen button's value, or null when dismissed with Escape or a click outside. */
  onResolve: (value: string | null) => void
}

export function ConfirmDialog({ title, message, detail, buttons, initialFocus, onResolve }: Props) {
  useEffect(() => {
    // Captured and marked handled, so an Esc that closes the dialog does not also close what it sits on (a card drawer).
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onResolve(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onResolve])

  const focused = initialFocus !== undefined ? buttons.findIndex((b) => b.value === initialFocus) : buttons.findIndex((b) => !b.danger)

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onResolve(null)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title" className="modal-title">
          {title}
        </h2>
        <p className="modal-message">{message}</p>
        {detail !== undefined && <pre className="confirm-detail">{detail}</pre>}
        <div className="modal-buttons">
          {buttons.map((b, i) => (
            <button
              key={b.value}
              type="button"
              className={b.danger ? 'btn danger' : 'btn'}
              autoFocus={i === focused}
              onClick={() => onResolve(b.value)}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
