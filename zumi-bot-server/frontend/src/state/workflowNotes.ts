import {
  NOTES_MAX,
  NOTE_DEFAULT,
  NOTE_HEX_RE,
  NOTE_MAX_SIDE,
  NOTE_MIN,
  notesOf,
  type Note,
  type NoteColor,
  type WorkflowInput
} from '@zumibot/shared/workflows'
import { freshId, idsOf, randomId, snap, type IdGen } from './workflowCanvas'

// Pure edits of a workflow's sticky notes, and the note color rules. Like workflowCanvas.ts, each returns a new
// workflow, or the same object back when it refuses or nothing changes.

export const NOTE_COLOR_NAMES: Record<1 | 2 | 3 | 4 | 5 | 6 | 7, string> = {
  1: 'Yellow',
  2: 'Orange',
  3: 'Red',
  4: 'Purple',
  5: 'Blue',
  6: 'Green',
  7: 'Gray'
}
export const NOTES_FULL = `A workflow holds at most ${NOTES_MAX} notes`

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))
const withNote = (w: WorkflowInput, id: string, change: (n: Note) => Note): WorkflowInput => {
  const notes = notesOf(w)
  const at = notes.find((n) => n.id === id)
  if (!at) return w
  const next = change(at)
  return next === at ? w : { ...w, notes: notes.map((n) => (n === at ? next : n)) }
}

/** A default note with its top-left at the point, on the grid. */
export function addNote(
  w: WorkflowInput,
  at: { x: number; y: number },
  gen: IdGen = randomId
): { w: WorkflowInput; noteId: string } | { error: string } {
  const notes = notesOf(w)
  if (notes.length >= NOTES_MAX) return { error: NOTES_FULL }
  const noteId = freshId(idsOf(w), gen)
  return { w: { ...w, notes: [...notes, { id: noteId, x: snap(at.x), y: snap(at.y), ...NOTE_DEFAULT }] }, noteId }
}

/** A drag of a handle: the box clamped to the note size limits and put on the grid. */
export function resizeNote(w: WorkflowInput, id: string, box: { x: number; y: number; width: number; height: number }): WorkflowInput {
  // A NaN would survive the clamp and the snap and reach the save, which refuses the whole workflow for it.
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return w
  return withNote(w, id, (n) => {
    const x = snap(box.x),
      y = snap(box.y)
    // Clamped first, then on the grid, so the smallest size lands on a grid line too.
    const width = snap(clamp(box.width, NOTE_MIN.width, NOTE_MAX_SIDE)),
      height = snap(clamp(box.height, NOTE_MIN.height, NOTE_MAX_SIDE))
    return n.x === x && n.y === y && n.width === width && n.height === height ? n : { ...n, x, y, width, height }
  })
}

/** A palette number (1 to 7) or `#rrggbb` in any case, stored lower case; anything else changes nothing. */
export function setNoteColor(w: WorkflowInput, id: string, color: NoteColor): WorkflowInput {
  const c: unknown = typeof color === 'string' ? color.toLowerCase() : color
  const ok = (typeof c === 'number' && Number.isInteger(c) && c >= 1 && c <= 7) || (typeof c === 'string' && NOTE_HEX_RE.test(c))
  if (!ok) return w
  return withNote(w, id, (n) => (n.color === c ? n : { ...n, color: c as NoteColor }))
}

/** The color popover's hex field: `#rrggbb` or `rrggbb` in any case, as the stored lower-case `#rrggbb`; null for anything else. */
export function hexInput(text: string): `#${string}` | null {
  const t = text.trim()
  const hex = (t.startsWith('#') ? t : `#${t}`).toLowerCase()
  return NOTE_HEX_RE.test(hex) ? (hex as `#${string}`) : null
}

/** A color as a label says it: the preset's name, or the custom hex. */
export const noteColorName = (c: NoteColor): string => (typeof c === 'number' ? NOTE_COLOR_NAMES[c] : c)

export function setNoteText(w: WorkflowInput, id: string, text: string): WorkflowInput {
  return withNote(w, id, (n) => (n.text === text ? n : { ...n, text }))
}

// WCAG relative luminance; the ink with the better contrast wins (dark ink #1a1d24, light ink #ffffff).
const DARK_INK = 0x1a1d24
const lum = (rgb: number): number => {
  const ch = (v: number): number => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch((rgb >> 16) & 255) + 0.7152 * ch((rgb >> 8) & 255) + 0.0722 * ch(rgb & 255)
}
// Any case, since the hex field's text can reach here before the color is stored lower case.
const HEX_ANY_CASE = /^#[0-9a-f]{6}$/i
export function noteInk(hex: string): 'dark' | 'light' {
  // parseInt reads a prefix ('#00000g' as 0), so anything not exactly #rrggbb gets the default ink.
  if (!HEX_ANY_CASE.test(hex)) return 'dark'
  const l = lum(Number.parseInt(hex.slice(1), 16))
  const onDark = (l + 0.05) / (lum(DARK_INK) + 0.05),
    onLight = 1.05 / (l + 0.05)
  return onDark >= onLight ? 'dark' : 'light'
}

export const RECENT_COLORS_MAX = 8
const RECENT_KEY = 'cb.wf.noteColors'

/** Newest first, a color already in the list moved up instead of repeated (any case), at most 8. */
export function pushRecentColor(list: string[], hex: string): string[] {
  const c = hex.toLowerCase()
  return [c, ...list.filter((x) => x.toLowerCase() !== c)].slice(0, RECENT_COLORS_MAX)
}

// Storage can throw (private window, blocked site data), so a failure is an empty list, never an error.
export function loadRecentColors(storage?: Storage): string[] {
  try {
    const raw = (storage ?? globalThis.localStorage).getItem(RECENT_KEY)
    const v: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && NOTE_HEX_RE.test(x)).slice(0, RECENT_COLORS_MAX) : []
  } catch {
    return []
  }
}

export function saveRecentColors(list: string[], storage?: Storage): void {
  try {
    ;(storage ?? globalThis.localStorage).setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_COLORS_MAX)))
  } catch {
    /* nothing to remember it in */
  }
}
