/** Where a dropdown portalled to `<body>` (SearchSelect) opens for its button, inside the part of the page on screen. */

const GAP = 4
const MARGIN = 8
const MAX_HEIGHT = 320
/** Less room than this below the button is cramped: the menu opens above when there is more room there. */
const CRAMPED = 200

/** A button's box, in the layout viewport's coordinates (what `getBoundingClientRect` gives). */
export interface ButtonBox {
  left: number
  top: number
  bottom: number
  width: number
}

/** The part of the page on screen, in the layout viewport's coordinates; `layoutHeight` is `window.innerHeight`. */
export interface View {
  top: number
  bottom: number
  layoutHeight: number
}

export interface MenuPlace {
  left: number
  minWidth: number
  maxHeight: number
  top?: number
  bottom?: number
}

type Win = {
  innerHeight: number
  visualViewport: { offsetTop: number; height: number; scale: number } | null
}

/**
 * What is on screen. A phone keyboard can cover the page's bottom (and pan it) without resizing it, so the layout
 * viewport alone would put a menu under the keyboard. A pinch zoom also shows less than the page; that view is left
 * alone, as keyboardCover leaves it.
 */
export function visibleView(win: Win): View {
  const vv = win.visualViewport
  const layoutHeight = win.innerHeight
  if (!vv || Math.abs(vv.scale - 1) > 0.01) return { top: 0, bottom: layoutHeight, layoutHeight }
  const top = Math.max(0, vv.offsetTop)
  return { top, bottom: Math.min(layoutHeight, top + vv.height), layoutHeight }
}

/** Below the button, or above when there is clearly more room there. */
export function placeMenu(button: ButtonBox, view: View): MenuPlace {
  // A button the keyboard has covered anchors the menu at the keyboard's edge, so the list stays on screen.
  const top = Math.min(Math.max(button.top, view.top), view.bottom)
  const bottom = Math.min(Math.max(button.bottom, view.top), view.bottom)
  const below = view.bottom - bottom - GAP - MARGIN
  const above = top - view.top - GAP - MARGIN
  const up = below < CRAMPED && above > below
  return {
    left: button.left,
    minWidth: button.width,
    maxHeight: Math.min(MAX_HEIGHT, up ? above : below),
    // `bottom` of a fixed element counts from the layout viewport's bottom, not the visible part's.
    ...(up ? { bottom: view.layoutHeight - top + GAP } : { top: bottom + GAP })
  }
}

/** Some of the button is on screen. */
export function inView(button: ButtonBox, view: View): boolean {
  return button.bottom >= view.top && button.top <= view.bottom
}
