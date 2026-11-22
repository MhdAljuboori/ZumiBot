import { useEffect, useId, useRef, type ReactNode, type Ref } from 'react'
import { createPortal } from 'react-dom'
import { nextTrapIndex } from '../net/folderPicker'
import { RoutineIcon } from './RoutineIcons'

const FOCUSABLE = 'button:not(:disabled), textarea:not(:disabled), [contenteditable="true"], [tabindex="0"]'

/** The small button beside a field's label that opens it in an ExpandDialog. */
export function ExpandButton({
  label,
  testId,
  onClick,
  ref
}: {
  label: string
  testId: string
  onClick: () => void
  ref?: Ref<HTMLButtonElement>
}) {
  const name = `Expand ${label.toLowerCase()}`
  return (
    <button
      ref={ref}
      type="button"
      className="wf-expand"
      data-testid={testId}
      aria-label={name}
      data-tip={name}
      aria-haspopup="dialog"
      onClick={onClick}
    >
      <RoutineIcon name="expand" />
    </button>
  )
}

interface Props {
  title: string
  testId: string
  onClose: () => void
  children: ReactNode
}

/**
 * One field at a size made for reading: a step's prompt or question, a test input or output. Edits apply as they are
 * typed, so closing loses nothing and there is no Cancel. In a portal, away from the inspector's own field styles.
 */
export function ExpandDialog({ title, testId, onClose, children }: Props) {
  const titleId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing) return
      // Not defaultPrevented: ProseMirror marks every Esc handled. A field menu's own Esc stops it before here.
      if (e.key === 'Escape') {
        e.preventDefault()
        close.current()
      } else if (e.key === 'Tab' && !e.defaultPrevented) {
        // defaultPrevented: Tab picked from a field menu.
        const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
        const to = nextTrapIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey)
        if (to !== null) {
          e.preventDefault()
          items[to].focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close.current()}>
      <div ref={dialog} className="modal wf-expand-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={testId}>
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        <div className="wf-expand-body">{children}</div>
        <div className="modal-buttons">
          <button type="button" className="btn primary" data-testid={`${testId}-done`} onClick={() => close.current()}>
            Done
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
