import { useSyncExternalStore } from 'react'

/**
 * Below this width the sidebar is a drawer over the main area (the stylesheets in src/styles use the same width). The desktop app's
 * window is never this narrow (its minimum is 800px), so only phones and small tablets get the drawer.
 */
export const NARROW_QUERY = '(max-width: 799px)'

/** A touch screen is the main pointer: no hover, no right-click, and a keyboard that slides over the page. */
export const coarsePointer = (): boolean => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true

/**
 * A message box's button's onMouseDown: focus stays where it is, so an open phone keyboard stays open (the way chat apps
 * keep it up after Send), a closed one stays closed, and the caret stays in the box. The click still comes.
 */
export const keepFocus = (e: { preventDefault(): void }): void => e.preventDefault()

const narrowNow = (): boolean => window.matchMedia(NARROW_QUERY).matches
const onNarrowChange = (changed: () => void): (() => void) => {
  const query = window.matchMedia(NARROW_QUERY)
  query.addEventListener('change', changed)
  return () => query.removeEventListener('change', changed)
}

/** Whether the screen is below NARROW_QUERY, following the window as it is resized. */
export const useNarrow = (): boolean => useSyncExternalStore(onNarrowChange, narrowNow)
