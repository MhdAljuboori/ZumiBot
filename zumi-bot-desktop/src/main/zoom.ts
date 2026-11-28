import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

// The app menu is removed (index.ts), and with it the roles that bound Ctrl+= / Ctrl+- / Ctrl+0, so the window had no
// way to enlarge text. The shell handles those keys itself, steps the way Chromium does, and keeps the factor between runs.

/** Chromium's own zoom steps, so a press lands where a browser's would. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const
const MIN = ZOOM_STEPS[0]
const MAX = ZOOM_STEPS[ZOOM_STEPS.length - 1]

export type ZoomKey = 'in' | 'out' | 'reset'

interface KeyInput {
  type: string
  key: string
  control: boolean
  alt: boolean
  meta: boolean
}

/** Ctrl (Cmd on a Mac) with = or + (Shift or the keypad), - or _, or 0. Auto-repeat counts: holding the key keeps stepping. */
export function zoomKey(i: KeyInput, mac: boolean): ZoomKey | null {
  if (i.type !== 'keyDown' || i.alt) return null
  if (mac ? !i.meta || i.control : !i.control || i.meta) return null
  switch (i.key) {
    case '=':
    case '+':
      return 'in'
    case '-':
    case '_':
      return 'out'
    case '0':
      return 'reset'
  }
  return null
}

/** The next factor from `current`; a factor between steps (an older file) goes to the nearest step that way. */
export function nextZoom(current: number, key: ZoomKey): number {
  if (key === 'reset') return 1
  if (key === 'in') return ZOOM_STEPS.find((s) => s > current + 0.001) ?? MAX
  return [...ZOOM_STEPS].reverse().find((s) => s < current - 0.001) ?? MIN
}

/**
 * The factor a key press sets, from the page's current one, or null for any other key. Read from the page, not kept
 * here: Chromium shares zoom per origin, so a popout's press zooms the main window too, and the other way round.
 */
export function zoomStep(i: KeyInput, mac: boolean, current: number): number | null {
  const k = zoomKey(i, mac)
  return k === null ? null : nextZoom(current, k)
}

export function parseZoom(raw: unknown): number {
  const f = raw && typeof raw === 'object' ? (raw as { factor?: unknown }).factor : undefined
  return typeof f === 'number' && Number.isFinite(f) && f >= MIN && f <= MAX ? f : 1
}

export function loadZoom(file: string): number {
  try {
    return parseZoom(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return 1
  }
}

export function saveZoom(file: string, factor: number): void {
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify({ factor }, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}
