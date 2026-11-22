/** Where the message editor's `/` and `@` lists float, in viewport pixels (they are `position: fixed`). */
export interface EditMenuPlace {
  left: number
  top?: number
  bottom?: number
  maxHeight: number
}

/**
 * Above the edit box, as the composer's lists open; below it when the box sits too near the top of the window (the
 * first message of a chat) and there is more room under it. The list never runs off either edge.
 */
export function editMenuPlace(
  box: { top: number; bottom: number; left: number },
  view: { width: number; height: number },
  menu = { width: 240, height: 260 },
  gap = 6,
  edge = 8
): EditMenuPlace {
  const left = Math.max(edge, Math.min(box.left, view.width - menu.width - edge))
  const above = box.top - gap - edge
  const below = view.height - box.bottom - gap - edge
  if (above >= menu.height || above >= below)
    return { left, bottom: view.height - box.top + gap, maxHeight: Math.max(0, Math.min(menu.height, above)) }
  return { left, top: box.bottom + gap, maxHeight: Math.max(0, Math.min(menu.height, below)) }
}
