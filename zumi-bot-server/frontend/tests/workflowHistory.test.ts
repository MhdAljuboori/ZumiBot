import { describe, expect, it } from 'vitest'
import type { WorkflowInput } from '@zumibot/shared/workflows'
import { newWorkflow, removeItems } from '../src/state/workflowCanvas'
import { emptyHistory, record, redo, undo } from '../src/state/workflowHistory'

const base = newWorkflow('UTC', () => 'trigger-id')
const wf = (o: Partial<WorkflowInput> = {}): WorkflowInput => ({ ...base, ...o })

describe('workflow history', () => {
  it('records a change and undoes it, keeping enabled and the id', () => {
    const a = wf({ name: 'A' }),
      b = { ...a, name: 'B', enabled: true }
    const h = record(emptyHistory, a, b, null, 0)
    const u = undo(h, b)!
    expect(u.w).toEqual({ ...a, enabled: true })
    expect(redo(u.h, u.w)!.w.name).toBe('B')
  })
  it('records nothing when only enabled changed', () => {
    const a = wf(),
      b = { ...a, enabled: !a.enabled }
    expect(record(emptyHistory, a, b, null, 0)).toBe(emptyHistory)
  })
  it('coalesces edits from the same field within 1 s, not after, and not across fields', () => {
    let h = record(emptyHistory, wf({ name: '' }), wf({ name: 'a' }), 's1:prompt', 0)
    h = record(h, wf({ name: 'a' }), wf({ name: 'ab' }), 's1:prompt', 900)
    expect(h.past).toHaveLength(1)
    h = record(h, wf({ name: 'ab' }), wf({ name: 'abc' }), 's1:prompt', 1_901)
    expect(h.past).toHaveLength(2)
    h = record(h, wf({ name: 'abc' }), wf({ name: 'abcd' }), 's1:name', 1_902)
    expect(h.past).toHaveLength(3)
  })
  it("typing that ends where it began (the field's own undo within 1 s) leaves no step, so the next Ctrl+Z is not a no-op", () => {
    let h = record(emptyHistory, wf({ name: 'one' }), wf({ name: 'two' }), null, 0)
    h = record(h, wf({ name: 'two' }), wf({ name: 'twoX' }), 's1:name', 1_000)
    h = record(h, wf({ name: 'twoX' }), wf({ name: 'two' }), 's1:name', 1_500)
    expect(h.past).toHaveLength(1)
    expect(undo(h, wf({ name: 'two' }))!.w.name).toBe('one')
    // The same field typed again right after is a step of its own, never joined to the edit before the burst.
    h = record(h, wf({ name: 'two' }), wf({ name: 'twoY' }), 's1:name', 1_600)
    expect(h.past).toHaveLength(2)
    expect(undo(h, wf({ name: 'twoY' }))!.w.name).toBe('two')
  })
  it('a null key never coalesces', () => {
    let h = record(emptyHistory, wf({ name: 'a' }), wf({ name: 'b' }), null, 0)
    h = record(h, wf({ name: 'b' }), wf({ name: 'c' }), null, 1)
    expect(h.past).toHaveLength(2)
  })
  it('caps the past at 100 and a new edit clears redo', () => {
    let h = emptyHistory
    for (let i = 0; i < 120; i++) h = record(h, wf({ name: String(i) }), wf({ name: String(i + 1) }), null, i * 10_000)
    expect(h.past).toHaveLength(100)
    const u = undo(h, wf({ name: '120' }))!
    expect(record(u.h, u.w, wf({ name: 'x' }), null, 0).future).toEqual([])
  })
  it('undo and redo with nothing to do return null', () => {
    expect(undo(emptyHistory, wf())).toBeNull()
    expect(redo(emptyHistory, wf())).toBeNull()
  })
  it('undoing a note delete restores the note, and redo takes it away again', () => {
    const n = { id: 'n1', x: 40, y: 60, width: 240, height: 160, color: 3 as const, text: '## Phase' }
    const a = wf({ notes: [n] })
    const b = removeItems(a, { steps: [], notes: ['n1'], groups: [] })
    expect(b.notes).toEqual([])
    const u = undo(record(emptyHistory, a, b, null, 0), b)!
    expect(u.w.notes).toEqual([n])
    expect(redo(u.h, u.w)!.w.notes).toEqual([])
  })
  it('an undo ends coalescing, so the next typing is its own step', () => {
    let h = record(emptyHistory, wf({ name: 'a' }), wf({ name: 'ab' }), 's1:prompt', 0)
    const u = undo(h, wf({ name: 'ab' }))!
    h = record(u.h, u.w, wf({ name: 'ac' }), 's1:prompt', 10)
    expect(h.past).toHaveLength(1)
    expect(undo(h, wf({ name: 'ac' }))!.w.name).toBe('a')
  })
})
