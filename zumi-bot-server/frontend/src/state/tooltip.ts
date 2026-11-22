/** The app tooltip's rules (`TooltipLayer.tsx` draws it): where it goes, when it shows, and when it is needed at all. */

/** The first tip waits, so passing the pointer over the UI does not flash tips. */
export const SHOW_MS = 500
/** While a tip is open, or this soon after one closed, the next shows at once: reading along a row of icons. */
export const WARM_MS = 300
/** Space between the target and the tip. */
export const GAP = 6
/** Space the tip keeps from the window's edges. */
export const MARGIN = 8

export type Box = { left: number; top: number; width: number; height: number }
type Size = { width: number; height: number }

/** Centered above the target; below when above would leave the window and below fits; never past the side margins. */
export function placeTip(target: Box, tip: Size, view: Size): { left: number; top: number; side: 'top' | 'bottom' } {
  const centered = target.left + target.width / 2 - tip.width / 2
  const left = Math.max(MARGIN, Math.min(centered, view.width - MARGIN - tip.width))
  const above = target.top - GAP - tip.height
  const below = target.top + target.height + GAP
  if (above < MARGIN && below + tip.height <= view.height - MARGIN) return { left, top: below, side: 'bottom' }
  return { left, top: above, side: 'top' }
}

export function showDelay(now: number, open: boolean, lastHiddenAt: number | null): number {
  if (open) return 0
  return lastHiddenAt !== null && now - lastHiddenAt < WARM_MS ? 0 : SHOW_MS
}

/** The tip only says what the element already shows: its own text, or the text of a part inside (a row's name). */
export function repeats(tip: string, texts: Iterable<string>): boolean {
  const t = tip.trim()
  for (const s of texts) if (s.trim() === t) return true
  return false
}

/**
 * A tip that only repeats what the element already says (a file name in a narrow row) is for when the text is cut off;
 * shown over the whole text it would just say it twice.
 */
export function tipNeeded(tip: string, repeated: boolean, truncated: boolean): boolean {
  if (tip.trim() === '') return false
  return repeated ? truncated : true
}

/** A tip equal to the target's accessible name would make a screen reader say it twice. */
export function describes(tip: string, name: string): boolean {
  return tip.trim() !== name.trim()
}
