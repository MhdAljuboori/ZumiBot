import { useLayoutEffect, type RefObject } from 'react'

const MARGIN = 8

/**
 * Nudges a fixed popup back inside the window when the spot it is anchored to would leave part of it off screen
 * (a phone's narrow window, a menu opened near an edge). `when` is the popup's state: each new one is measured again.
 */
export function useFitInViewport(ref: RefObject<HTMLElement | null>, when: unknown): void {
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.translate = ''
    const r = el.getBoundingClientRect()
    // The left and top edges win when the popup is bigger than the window.
    const dx = Math.max(MARGIN - r.left, Math.min(0, window.innerWidth - MARGIN - r.right))
    const dy = Math.max(MARGIN - r.top, Math.min(0, window.innerHeight - MARGIN - r.bottom))
    if (dx !== 0 || dy !== 0) el.style.translate = `${dx}px ${dy}px`
  }, [ref, when])
}
