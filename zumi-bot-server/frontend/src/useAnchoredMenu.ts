import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'
import { inView, placeMenu, visibleView, type MenuPlace } from './state/menuPlace'

const MARGIN = 8

/**
 * A dropdown portalled to `<body>` under (or over) its button, so a drawer's `overflow` cannot clip it and nothing
 * beside it paints over it. `place` is null while closed; set it as the menu's `left`/`top`/`bottom`/`minWidth`/
 * `maxHeight`. The menu follows its button when the page under it scrolls or resizes, and closes on Esc (heard first,
 * so a panel or dialog under it stays open), a click outside the button and the menu, a scroll taking the button out
 * of what is shown, or the window blurring. `close(true)` gives the focus back to the button.
 */
export function useAnchoredMenu(
  button: RefObject<HTMLElement | null>,
  menu: RefObject<HTMLElement | null>
): { place: MenuPlace | null; open: () => void; close: (refocus?: boolean) => void } {
  const [place, setPlace] = useState<MenuPlace | null>(null)
  const close = useCallback(
    (refocus = false) => {
      setPlace(null)
      if (refocus) button.current?.focus({ preventScroll: true })
    },
    [button]
  )

  // Where the menu goes for the button's spot now, inside what is on screen (a phone keyboard may cover the rest).
  const measure = useCallback((): MenuPlace | null => {
    const r = button.current?.getBoundingClientRect()
    return r ? placeMenu(r, visibleView(window)) : null
  }, [button])

  const isOpen = place !== null
  useEffect(() => {
    if (!isOpen) return
    const outside = (e: Event): void => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !button.current?.contains(t)) close()
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // Ours first: a panel or dialog under the menu must not close too.
      e.stopPropagation()
      e.preventDefault()
      close(true)
    }
    // It follows its button when the page under it scrolls (a drawer scrolling a form into view), and closes once the
    // button has left what is on screen.
    const moved = (e: Event): void => {
      if (menu.current?.contains(e.target as Node)) return
      const r = button.current?.getBoundingClientRect()
      if (!r || !inView(r, visibleView(window))) close()
      else setPlace(measure())
    }
    // A resize, or a phone keyboard opening, panning or closing, only moves it: the keyboard comes up for a tap in its
    // own search box, and closing then would drop the list under the typing finger.
    const resized = (): void => setPlace(measure())
    const dismiss = (): void => close()
    const vv = window.visualViewport
    document.addEventListener('mousedown', outside, true)
    document.addEventListener('keydown', esc, true)
    window.addEventListener('scroll', moved, true)
    window.addEventListener('resize', resized)
    vv?.addEventListener('resize', resized)
    vv?.addEventListener('scroll', resized)
    window.addEventListener('blur', dismiss)
    return () => {
      document.removeEventListener('mousedown', outside, true)
      document.removeEventListener('keydown', esc, true)
      window.removeEventListener('scroll', moved, true)
      window.removeEventListener('resize', resized)
      vv?.removeEventListener('resize', resized)
      vv?.removeEventListener('scroll', resized)
      window.removeEventListener('blur', dismiss)
    }
  }, [isOpen, close, measure, button, menu])

  // Nudged back inside the window when the button sits near an edge.
  useLayoutEffect(() => {
    const el = menu.current
    if (!el) return
    el.style.translate = ''
    const r = el.getBoundingClientRect()
    const dx = Math.max(MARGIN - r.left, Math.min(0, window.innerWidth - MARGIN - r.right))
    if (dx !== 0) el.style.translate = `${dx}px 0`
  }, [place, menu])

  const open = useCallback((): void => setPlace(measure()), [measure])
  return { place, open, close }
}
