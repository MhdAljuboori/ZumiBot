import type { Ref } from 'react'

/** A tray's header: its name and count, toggling its rows. The count stays when collapsed, so nothing hides unseen. */
export function TrayHead({
  label,
  count,
  open,
  onToggle,
  testId,
  controls,
  headRef
}: {
  label: string
  count: number
  open: boolean
  onToggle: () => void
  testId: string
  /** The id of the rows it shows and hides. */
  controls: string
  headRef?: Ref<HTMLButtonElement>
}) {
  return (
    <div className="tray-label">
      <button
        ref={headRef}
        type="button"
        className="tray-head"
        data-testid={testId}
        aria-expanded={open}
        aria-controls={controls}
        onClick={onToggle}
      >
        <span>{count > 0 ? `${label} · ${count}` : label}</span>
        <span className={open ? 'tray-caret open' : 'tray-caret'} aria-hidden="true">
          ▾
        </span>
      </button>
    </div>
  )
}
