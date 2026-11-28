import { randomBytes } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// A chat popout's size (popout-state.json in userData) and where a new one opens. Electron-free, so it is unit-tested.

export interface Size {
  width: number
  height: number
}
export interface Rect extends Size {
  x: number
  y: number
}

export const DEFAULT_POPOUT_SIZE: Size = { width: 900, height: 700 }
const MIN_SIZE: Size = { width: 480, height: 360 }
const CASCADE_STEP = 32 // each popout opens this far down and right of the last, so none hides another

/** The saved size, whole pixels, never under the minimum; the default for anything broken. */
export function parsePopoutSize(raw: unknown): Size {
  const r = raw as { width?: unknown; height?: unknown } | null
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
  if (!r || !ok(r.width) || !ok(r.height)) return { ...DEFAULT_POPOUT_SIZE }
  return { width: Math.max(MIN_SIZE.width, Math.round(r.width)), height: Math.max(MIN_SIZE.height, Math.round(r.height)) }
}

export function loadPopoutSize(file: string): Size {
  try {
    return parsePopoutSize(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return { ...DEFAULT_POPOUT_SIZE }
  }
}

export function savePopoutSize(file: string, size: Size): void {
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify({ width: size.width, height: size.height }), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

/**
 * Where a popout opens: cascaded from the window it was opened from (`open` popouts already there), centred in the work
 * area when there is none, and always fully inside the work area, shrunk to it on a small screen.
 */
export function popoutBounds(size: Size, anchor: Rect | null, open: number, area: Rect): Rect {
  const width = Math.min(size.width, area.width)
  const height = Math.min(size.height, area.height)
  const right = area.x + area.width
  const bottom = area.y + area.height
  let x: number
  let y: number
  if (anchor === null) {
    x = area.x + Math.round((area.width - width) / 2)
    y = area.y + Math.round((area.height - height) / 2)
  } else {
    const step = CASCADE_STEP * (open + 1)
    x = anchor.x + step
    y = anchor.y + step
    // Past the edge the cascade starts again at the anchor's corner.
    if (x + width > right || y + height > bottom) {
      x = anchor.x + CASCADE_STEP
      y = anchor.y + CASCADE_STEP
    }
  }
  x = Math.max(area.x, Math.min(x, right - width))
  y = Math.max(area.y, Math.min(y, bottom - height))
  return { x, y, width, height }
}
