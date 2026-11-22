import { useLayoutEffect, useRef, useState } from 'react'
import { nextCompact } from './state/pickerRow'

// The row's chips, not the menus they open (fixed popups rendered beside their buttons): opening one changes neither
// the text nor the width that decides the layout, or a menu would flip the row and unmount itself.
const CHIPS = ':scope > :not(.menu, .pickers-end), :scope > .pickers-end > :not(.menu)'

const chipText = (row: HTMLElement): string => Array.from(row.querySelectorAll(CHIPS), (el) => el.textContent ?? '').join('\u0000')

/** The width the row's chips take side by side at their own size (`fit-measure` stops them shrinking). */
function naturalWidth(row: HTMLElement): number {
  row.classList.add('fit-measure')
  let left = Infinity
  let right = -Infinity
  for (const el of Array.from(row.children)) {
    if (el.classList.contains('menu')) continue
    const r = el.getBoundingClientRect()
    if (r.width === 0) continue
    left = Math.min(left, r.left)
    right = Math.max(right, r.right)
  }
  row.classList.remove('fit-measure')
  return right > left ? right - left : 0
}

function contentWidth(row: HTMLElement): number {
  const s = getComputedStyle(row)
  return row.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
}

/**
 * Whether the picker row under the message box should show its compact layout: true while its full layout would not
 * fit the row's own width (a small window, the sidebar or side panel open), not just on a phone. The full row is
 * measured in a layout effect, so a switch never paints the layout it leaves. `ref` goes on the row.
 */
export function useFitRow(enabled: boolean): { ref: (row: HTMLDivElement | null) => void; compact: boolean } {
  const [row, setRow] = useState<HTMLDivElement | null>(null)
  const [compact, setCompact] = useState(false)
  const [width, setWidth] = useState(0)
  // The full row's width when last measured, and the room and text it was measured at.
  const need = useRef<number | null>(null)
  const measuredAt = useRef<string | null>(null)
  // The compact row's own text, apart from the full row's: switching layouts must not read as a content change.
  const compactText = useRef<string | null>(null)

  useLayoutEffect(() => {
    if (!enabled || row === null) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(row)
    return () => observer.disconnect()
  }, [enabled, row])

  // Every render: the chips' labels change with the chat (a picked model, a new branch, the cost).
  useLayoutEffect(() => {
    if (!enabled || row === null) {
      need.current = null
      measuredAt.current = null
      compactText.current = null
      if (compact) setCompact(false)
      return
    }
    const available = width || Math.round(contentWidth(row))
    const text = chipText(row)
    if (compact) {
      // What the compact row shows changed: the full row may fit now, so it is tried (and measured) again.
      if (compactText.current !== null && compactText.current !== text) need.current = null
      compactText.current = text
      if (!nextCompact(need.current, available)) {
        measuredAt.current = null
        setCompact(false)
      }
      return
    }
    compactText.current = null
    const at = `${available}\u0000${text}`
    if (measuredAt.current !== at) {
      need.current = naturalWidth(row)
      measuredAt.current = at
    }
    if (nextCompact(need.current, available)) setCompact(true)
  })

  return { ref: setRow, compact }
}
