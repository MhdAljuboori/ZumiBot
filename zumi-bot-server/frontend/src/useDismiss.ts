import { useEffect } from 'react'

/**
 * Closes an open popup menu on any mousedown, window blur or Escape. The menu and its toggle
 * stop mousedown propagation so their own clicks still land.
 */
export function useDismiss(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])
}
