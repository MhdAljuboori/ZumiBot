import { describe, expect, it } from 'vitest'
import type { Note, NoteColor, WorkflowInput } from '@zumibot/shared/workflows'
import { newWorkflow } from '../src/state/workflowCanvas'
import {
  NOTE_COLOR_NAMES,
  RECENT_COLORS_MAX,
  addNote,
  hexInput,
  loadRecentColors,
  noteColorName,
  noteInk,
  pushRecentColor,
  resizeNote,
  saveRecentColors,
  setNoteColor,
  setNoteText
} from '../src/state/workflowNotes'

const seq = (p = 'id') => {
  let n = 0
  return () => `${p}${++n}`
}
const base = (): WorkflowInput => newWorkflow('UTC', seq())
const note = (id: string, over: Partial<Note> = {}): Note => ({ id, x: 0, y: 0, width: 240, height: 160, color: 1, text: 'hi', ...over })
const withNote = (): WorkflowInput => ({ ...base(), notes: [note('n1')] })

describe('notes', () => {
  it('adds a default note at the point, snapped, and refuses past 100', () => {
    const r = addNote(base(), { x: 13, y: 27 }, seq('n')) as { w: WorkflowInput; noteId: string }
    expect(r.w.notes).toEqual([{ id: r.noteId, x: 20, y: 20, width: 240, height: 160, color: 1, text: '## Note\nDouble-click to edit.' }])
    const full = { ...base(), notes: Array.from({ length: 100 }, (_, i) => ({ ...r.w.notes![0], id: `x${i}` })) }
    expect(addNote(full, { x: 0, y: 0 })).toEqual({ error: 'A workflow holds at most 100 notes' })
  })
  it('never reuses a step, edge or note id', () => {
    const w = withNote()
    const r = addNote(
      w,
      { x: 0, y: 0 },
      (() => {
        const ids = ['n1', w.steps[0].id, 'fresh']
        return () => ids.shift() ?? 'fresh'
      })()
    ) as { noteId: string }
    expect(r.noteId).toBe('fresh')
  })
  it('resizes with the minimum and the grid', () => {
    const w = withNote()
    expect(resizeNote(w, 'n1', { x: 3, y: 0, width: 90, height: 333 }).notes![0]).toMatchObject({ x: 0, width: 160, height: 340 })
  })
  it('clamps a resize to the largest side and returns the same workflow for an unknown note', () => {
    const w = withNote()
    expect(resizeNote(w, 'n1', { x: 0, y: 0, width: 99_999, height: 99_999 }).notes![0]).toMatchObject({ width: 5000, height: 5000 })
    expect(resizeNote(w, 'nope', { x: 0, y: 0, width: 200, height: 200 })).toBe(w)
  })
  it('leaves the note as it is for a box with a value that is not a finite number', () => {
    const w = withNote()
    expect(resizeNote(w, 'n1', { x: Number.NaN, y: 0, width: 200, height: 200 })).toBe(w)
    expect(resizeNote(w, 'n1', { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 200 })).toBe(w)
    expect(resizeNote(w, 'n1', { x: 0, y: Number.NEGATIVE_INFINITY, width: 200, height: 200 })).toBe(w)
    expect(resizeNote(w, 'n1', { x: 0, y: 0, width: 200, height: Number.NaN })).toBe(w)
  })
  it('sets a color, lower-casing a custom one, and refuses a bad one', () => {
    expect(setNoteColor(withNote(), 'n1', '#AABBCC').notes![0].color).toBe('#aabbcc')
    expect(setNoteColor(withNote(), 'n1', 5).notes![0].color).toBe(5)
    const w = withNote()
    expect(setNoteColor(w, 'n1', '#abc' as NoteColor)).toBe(w)
    expect(setNoteColor(w, 'n1', 9 as NoteColor)).toBe(w)
    expect(setNoteColor(w, 'nope', 2)).toBe(w)
  })
  it('sets the text, and the same object when it did not change', () => {
    const w = withNote()
    expect(setNoteText(w, 'n1', 'new').notes![0].text).toBe('new')
    expect(setNoteText(w, 'n1', 'hi')).toBe(w)
    expect(setNoteText(w, 'nope', 'x')).toBe(w)
  })
  it('picks readable ink', () => {
    expect(noteInk('#ffffff')).toBe('dark')
    expect(noteInk('#000000')).toBe('light')
    expect(noteInk('#ffeb3b')).toBe('dark')
    expect(noteInk('#1a237e')).toBe('light')
  })
  it('gives dark ink to anything that is not #rrggbb', () => {
    for (const bad of ['#000', '000000', '#00000g', '#0000000', 'black', '', '#-00000']) expect(noteInk(bad)).toBe('dark')
    expect(noteInk('#000000')).toBe('light')
    expect(noteInk('#1A237E')).toBe('light')
  })
  it('reads the hex field as #rrggbb or rrggbb, lower case, and nothing else', () => {
    expect(hexInput('#12AB56')).toBe('#12ab56')
    expect(hexInput('12ab56')).toBe('#12ab56')
    expect(hexInput('  #123456 ')).toBe('#123456')
    for (const bad of ['', '#', '#123', '12345', '#1234567', '##123456', '#12345g', 'red']) expect(hexInput(bad)).toBeNull()
  })
  it('names a color for a label: the preset name, or the hex', () => {
    expect(noteColorName(1)).toBe('Yellow')
    expect(noteColorName(7)).toBe('Gray')
    expect(noteColorName('#123456')).toBe('#123456')
  })
  it('names the seven colors', () => {
    expect(Object.values(NOTE_COLOR_NAMES)).toEqual(['Yellow', 'Orange', 'Red', 'Purple', 'Blue', 'Green', 'Gray'])
  })
})

describe('recent colors', () => {
  it('keeps 8 recent colors, newest first, without repeats', () => {
    let l: string[] = []
    for (const c of ['#000001', '#000002', '#000001']) l = pushRecentColor(l, c)
    expect(l).toEqual(['#000001', '#000002'])
    for (let i = 3; i < 12; i++) l = pushRecentColor(l, `#0000${String(i).padStart(2, '0')}`)
    expect(l).toHaveLength(RECENT_COLORS_MAX)
    expect(l[0]).toBe('#000011')
  })
  it('treats two spellings of one color as one', () => {
    expect(pushRecentColor(['#aabbcc'], '#AABBCC')).toEqual(['#aabbcc'])
  })
  it('loads an empty list from broken storage, and saves without throwing', () => {
    expect(
      loadRecentColors({
        getItem: () => {
          throw new Error('denied')
        }
      } as unknown as Storage)
    ).toEqual([])
    expect(() =>
      saveRecentColors(['#000001'], {
        setItem: () => {
          throw new Error('full')
        }
      } as unknown as Storage)
    ).not.toThrow()
  })
  it('round-trips through storage and drops entries that are not colors', () => {
    const mem = new Map<string, string>()
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v)
    } as unknown as Storage
    saveRecentColors(['#aabbcc', '#112233'], storage)
    expect(loadRecentColors(storage)).toEqual(['#aabbcc', '#112233'])
    mem.set('cb.wf.noteColors', JSON.stringify(['#aabbcc', 'red', 5, '#12']))
    expect(loadRecentColors(storage)).toEqual(['#aabbcc'])
    mem.set('cb.wf.noteColors', 'not json')
    expect(loadRecentColors(storage)).toEqual([])
  })
})
