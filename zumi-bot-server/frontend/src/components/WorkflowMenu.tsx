import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useDismiss } from '../useDismiss'
import { keyLabel, type MenuAction, type MenuItem } from '../state/workflowMenu'

const EDGE = 8 // the gap kept to the canvas's edge

/** True on a Mac, where the menu's keys read ⌘ for Ctrl. Read here, never in the pure menu rules. */
export const isMac = (): boolean => typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

/**
 * The right-click menu of the canvas: placed at `at` (pixels from the canvas wrapper's corner) and moved back inside the
 * wrapper once its size is known, so a click near the right or bottom edge still shows every row. It closes on Esc, a
 * pick or a click outside; a row that cannot run shows its reason as a tooltip and does nothing.
 */
export function CanvasContextMenu(p: {
  at: { left: number; top: number }
  items: MenuItem[]
  onPick: (a: MenuAction) => void
  onClose: () => void
  mac?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(p.at)
  useDismiss(true, p.onClose)
  // Esc closes the menu and nothing else: the editor's own Esc (clear the selection) listens on the window too, and this
  // runs first, in the capture phase.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      p.onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [p.onClose])
  useLayoutEffect(() => {
    const el = ref.current
    const box = el?.offsetParent
    if (!el || !(box instanceof HTMLElement)) return setPos(p.at)
    setPos({
      left: Math.max(EDGE, Math.min(p.at.left, box.clientWidth - el.offsetWidth - EDGE)),
      top: Math.max(EDGE, Math.min(p.at.top, box.clientHeight - el.offsetHeight - EDGE))
    })
  }, [p.at, p.items.length])
  const mac = p.mac ?? isMac()
  return (
    <div
      ref={ref}
      className="menu wf-ctx-menu"
      role="menu"
      aria-label="Workflow actions"
      data-testid="wf-ctx-menu"
      style={{ left: pos.left, top: pos.top }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {p.items.map((it) => (
        <button
          key={it.action}
          type="button"
          role="menuitem"
          className={it.action === 'delete' || it.action === 'deleteGroup' || it.action === 'removeEdge' ? 'danger' : undefined}
          data-testid={`wf-ctx-${it.action}`}
          aria-disabled={it.disabled !== undefined || undefined}
          data-tip={it.disabled}
          onClick={() => {
            if (it.disabled !== undefined) return
            p.onPick(it.action)
          }}
        >
          <span className="wf-ctx-label">{it.label}</span>
          {it.keys && <span className="wf-ctx-keys">{keyLabel(it.keys, mac)}</span>}
        </button>
      ))}
    </div>
  )
}
