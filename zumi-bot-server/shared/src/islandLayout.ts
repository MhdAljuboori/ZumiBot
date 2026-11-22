// Where the island's strip and popup sit. The shell places them with this and the island page slides them with it while
// the strip is dragged, so both land on the same pixels.
import type { IslandLayout, IslandRect } from './island'

export const STRIP_WIDTH = 58
export const ICON = 38
export const ICON_GAP = 12
export const STRIP_PAD = 12
export const CURVE = 22
export const POPUP_WIDTH = 360
export const POPUP_HEIGHT = 520
export const POPUP_GAP = 12
/** The island window's width: the popup, the gap and the strip. */
export const ISLAND_WIDTH = POPUP_WIDTH + POPUP_GAP + STRIP_WIDTH

/** The strip's height; 0 for no icon (a voice-only island has a popup and no strip). */
export function stripHeight(icons: number): number {
  if (icons < 1) return 0
  return 2 * CURVE + 2 * STRIP_PAD + icons * ICON + (icons - 1) * ICON_GAP
}

/** The strip's top, kept inside the area; null centres it. */
export function clampTop(top: number | null, height: number, area: IslandRect): number {
  const max = area.y + area.height - height
  const want = top === null ? area.y + (area.height - height) / 2 : top
  return Math.max(area.y, Math.min(max, want))
}

/** A layout that carries the strip's track, as every layout from shells whose window never moves does. */
export type SlidingLayout = IslandLayout & { track: IslandRect }

/** The layout with the strip's top at `top` (window coordinates, kept in its track, whole pixels) and the popup level with it. */
export function slideLayout(l: SlidingLayout, top: number): SlidingLayout {
  const strip = { ...l.strip, y: Math.round(clampTop(top, l.strip.height, l.track)) }
  const popup = l.popup && {
    ...l.popup,
    y: Math.round(clampTop(Math.round(strip.y + strip.height / 2 - l.popup.height / 2), l.popup.height, l.track))
  }
  return { strip, popup, track: l.track }
}

/**
 * The island window for the work area and the strip and popup inside it. Layout rects are relative to the window; `top`
 * is the clamped strip top on screen, for the caller to save. The window is the work area's full-height right-hand
 * column whatever the strip does: on some X11 setups Mutter applied each move of it up to a second late, so a drag only
 * slides the strip inside it, and a resize makes Mutter hold this transparent window blank for about a second.
 */
export function islandBounds(o: { area: IslandRect; top: number | null; icons: number; open: boolean }): {
  window: IslandRect
  layout: SlidingLayout
  top: number
} {
  const area = { x: Math.round(o.area.x), y: Math.round(o.area.y), width: Math.round(o.area.width), height: Math.round(o.area.height) }
  const height = stripHeight(o.icons)
  const track = { x: POPUP_WIDTH + POPUP_GAP, y: 0, width: STRIP_WIDTH, height: area.height }
  const base: SlidingLayout = {
    strip: { x: track.x, y: 0, width: STRIP_WIDTH, height },
    popup: o.open ? { x: 0, y: 0, width: POPUP_WIDTH, height: Math.min(POPUP_HEIGHT, area.height) } : null,
    track
  }
  const layout = slideLayout(base, o.top === null ? (area.height - height) / 2 : o.top - area.y)
  return {
    window: { x: area.x + area.width - ISLAND_WIDTH, y: area.y, width: ISLAND_WIDTH, height: area.height },
    layout,
    top: area.y + layout.strip.y
  }
}
