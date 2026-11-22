// Pure helpers for a card's comment box (TodoCommentBox.tsx).

/** Where the box's `@` or `/` list floats, in viewport pixels: under the box, or over it when there is more room there. */
export interface PopPlace {
  left: number
  width: number
  top?: number
  bottom?: number
  maxHeight: number
}

interface Rect {
  left: number
  top: number
  bottom: number
  width: number
}

/**
 * The list floats over the drawer instead of pushing the comments down: under the box while the menu fits there (or
 * there is more room below than above), else over it. Its height never passes the room it has.
 */
export function popPlace(box: Rect, viewHeight: number, menuHeight = 260, gap = 4, edge = 8): PopPlace {
  const below = viewHeight - box.bottom - gap - edge
  const above = box.top - gap - edge
  const base = { left: box.left, width: box.width }
  if (below >= menuHeight || below >= above) return { ...base, top: box.bottom + gap, maxHeight: Math.max(0, Math.min(menuHeight, below)) }
  return { ...base, bottom: viewHeight - box.top + gap, maxHeight: Math.max(0, Math.min(menuHeight, above)) }
}
