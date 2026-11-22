import { describe, expect, it } from 'vitest'
import type { CanvasGroup, Edge, LlmStep, Note, Step, WorkflowInput } from '@zumibot/shared/workflows'
import { rewriteHandles } from '../src/state/workflowCanvas'
import { CLIP_MARK, clipText, copyClip, lastClip, parseClip, pasteClip, setLastClip } from '../src/state/workflowClipboard'

const seq = (p: string) => {
  let n = 0
  return () => `${p}${++n}`
}
const trig = (id: string, x: number, y: number): Step => ({ id, handle: 'trigger', name: 'Trigger', kind: 'trigger', x, y })
const llm = (id: string, handle: string, x: number, y: number, prompt: string): Step => ({
  id,
  handle,
  name: handle.toUpperCase(),
  kind: 'llm',
  x,
  y,
  prompt,
  model: 'haiku'
})
const edge = (from: string, port: Edge['port'], to: string): Edge => ({ id: `${from}-${port}-${to}`, from, port, to })
const base = (steps: Step[], edges: Edge[]): WorkflowInput => ({
  id: null,
  name: 'W',
  enabled: false,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps,
  edges
})

const w = base(
  [trig('t', 0, 0), llm('a', 'a', 100, 0, '{{steps.b.output}} and {{ steps.x.output }}'), llm('b', 'b', 400, 0, 'hi')],
  [edge('t', 'out', 'a'), edge('a', 'out', 'b')]
)

describe('workflow clipboard', () => {
  it('copies the picked steps and only the edges between them, never the trigger', () => {
    const c = copyClip(w, { kind: 'items', steps: ['t', 'a', 'b'], notes: [], groups: [] }, new Set())!
    expect(c.steps.map((s) => s.id)).toEqual(['a', 'b'])
    expect(c.edges.map((e) => e.id)).toEqual(['a-out-b'])
  })
  it('copies nothing for only the trigger, an edge or no selection', () => {
    expect(copyClip(w, { kind: 'step', id: 't' }, new Set())).toBeNull()
    expect(copyClip(w, { kind: 'edge', id: 'a-out-b' }, new Set())).toBeNull()
    expect(copyClip(w, null, new Set())).toBeNull()
  })
  it('round-trips through text', () => {
    const c = copyClip(w, { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }, new Set())!
    expect(parseClip(clipText(c))).toEqual(c)
  })
  it('ignores text that is not a valid clip', () => {
    for (const t of [
      '',
      'hello',
      '{}',
      '[]',
      '{"zumibot":"other","v":1}',
      '{"zumibot":"workflow-clip","v":2,"steps":[]}',
      JSON.stringify({ zumibot: CLIP_MARK, v: 1, steps: [{ id: 'x', kind: 'shell' }], edges: [], notes: [], groups: [] }),
      JSON.stringify({
        zumibot: CLIP_MARK,
        v: 1,
        steps: [],
        edges: [{ id: 'e', from: 'a', port: 'out', to: 'b' }],
        notes: [],
        groups: []
      }),
      JSON.stringify({ zumibot: CLIP_MARK, v: 1, steps: [trig('t2', 0, 0)], edges: [], notes: [], groups: [] })
    ])
      expect(parseClip(t), t).toBeNull()
  })
  it('pastes with new ids, unique handles and rewritten templates among the pasted steps', () => {
    const c = copyClip(w, { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }, new Set())!
    const r = pasteClip(w, c, null, seq('p'))
    if ('error' in r) throw new Error(r.error)
    const [a2, b2] = r.w.steps.slice(3)
    expect(new Set(r.w.steps.map((s) => s.id)).size).toBe(5)
    expect(b2.handle).toBe('b-2')
    expect((a2 as LlmStep).prompt).toBe('{{steps.b-2.output}} and {{ steps.x.output }}')
    expect(r.w.edges.at(-1)).toMatchObject({ from: a2.id, to: b2.id, port: 'out' })
    expect(r.picked).toEqual({ kind: 'items', steps: [a2.id, b2.id], notes: [], groups: [] })
  })
  it('round-trips and pastes a For each step, keeping {{item}} and rewriting a pasted handle', () => {
    const each: Step = {
      id: 'e',
      handle: 'each',
      name: 'Each',
      kind: 'foreach',
      x: 700,
      y: 0,
      agent: 'helper',
      prompt: 'Check {{item}} after {{steps.b.output}}',
      cwd: '/tmp',
      model: 'opus'
    }
    const fw = base([...w.steps, each], [...w.edges, edge('b', 'out', 'e')])
    const c = copyClip(fw, { kind: 'items', steps: ['b', 'e'], notes: [], groups: [] }, new Set())!
    expect(parseClip(clipText(c))).toEqual(c)
    const r = pasteClip(fw, c, null, seq('p'))
    if ('error' in r) throw new Error(r.error)
    const pasted = r.w.steps.at(-1)!
    expect(pasted).toMatchObject({
      kind: 'foreach',
      handle: 'each-2',
      agent: 'helper',
      cwd: '/tmp',
      model: 'opus',
      prompt: 'Check {{item}} after {{steps.b-2.output}}'
    })
  })
  it('offsets by 40 px without a point, and puts the top-left at the point', () => {
    const c = copyClip(w, { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }, new Set())!
    const off = pasteClip(w, c, null, seq('p')) as { w: WorkflowInput }
    expect(off.w.steps.slice(3).map((s) => [s.x, s.y])).toEqual([
      [140, 40],
      [440, 40]
    ])
    const at = pasteClip(w, c, { x: 1000, y: 500 }, seq('q')) as { w: WorkflowInput }
    expect(at.w.steps.slice(3).map((s) => [s.x, s.y])).toEqual([
      [1000, 500],
      [1300, 500]
    ])
  })
  it('gives pasted steps that share a handle their own unused handles, and rewrites only unique old handles', () => {
    const dup = base(
      [
        trig('t', 0, 0),
        llm('a', 'a', 100, 0, '{{steps.b.output}} {{steps.u.output}}'),
        llm('b', 'b', 200, 0, 'x'),
        llm('c', 'b', 300, 0, 'y'),
        llm('u', 'u', 400, 0, 'z')
      ],
      []
    )
    const c = copyClip(dup, { kind: 'items', steps: ['a', 'b', 'c', 'u'], notes: [], groups: [] }, new Set())!
    const r = pasteClip(dup, c, null, seq('p'))
    if ('error' in r) throw new Error(r.error)
    const [a2, b2, c2, u2] = r.w.steps.slice(5)
    // The source already holds two steps named b (Save allows it); the pasted four are unique and clash with none of those.
    const pasted = r.w.steps.slice(5).map((s) => s.handle)
    expect(new Set(pasted).size).toBe(4)
    expect(pasted.filter((h) => dup.steps.some((s) => s.handle === h))).toEqual([])
    expect(b2.handle).not.toBe(c2.handle)
    expect((a2 as LlmStep).prompt).toBe(`{{steps.b.output}} {{steps.${u2.handle}.output}}`)
  })
  it('refuses a clip with a prototype-named id or an edge to a step outside it', () => {
    const mk = (steps: unknown[], edges: unknown[]) => JSON.stringify({ zumibot: CLIP_MARK, v: 1, steps, edges, notes: [], groups: [] })
    expect(parseClip(mk([{ ...llm('constructor', 'a', 0, 0, '') }], []))).toBeNull()
    expect(parseClip(mk([llm('a', 'a', 0, 0, '')], [edge('a', 'out', 'gone')]))).toBeNull()
  })
  it('keeps the last clip in memory', () => {
    const c = copyClip(w, { kind: 'step', id: 'a' }, new Set())!
    setLastClip(c)
    expect(lastClip()).toBe(c)
  })
})

describe('workflow clipboard with notes', () => {
  const note = (id: string, x: number, y: number): Note => ({ id, x, y, width: 240, height: 160, color: 2, text: 'hello' })
  const wn: WorkflowInput = { ...w, notes: [note('n1', 50, 300), note('n2', 900, 900)] }
  const items = (steps: string[], notes: string[]) => ({ kind: 'items' as const, steps, notes, groups: [] })

  it('copies the picked notes, and a clip of only notes is valid', () => {
    const c = copyClip(wn, { kind: 'note', id: 'n1' }, new Set())!
    expect(c).toEqual({ steps: [], edges: [], notes: [wn.notes![0]], groups: [] })
    expect(parseClip(clipText(c))).toEqual(c)
    expect(copyClip(wn, items(['a'], ['n2']), new Set())!.notes.map((n) => n.id)).toEqual(['n2'])
  })
  it('pastes notes with new ids, shifted with the steps by one offset', () => {
    const c = copyClip(wn, items(['a'], ['n1']), new Set())!
    const r = pasteClip(wn, c, null, seq('p'))
    if ('error' in r) throw new Error(r.error)
    const added = r.w.notes!.slice(2)
    expect(added).toHaveLength(1)
    expect(added[0].id).not.toBe('n1')
    expect(new Set([...r.w.steps, ...r.w.notes!].map((x) => x.id)).size).toBe(r.w.steps.length + r.w.notes!.length)
    // The clip's top-left is the step at 100,0, so both move by the 40 px offset.
    expect(r.w.steps.at(-1)).toMatchObject({ x: 140, y: 40 })
    expect(added[0]).toMatchObject({ x: 90, y: 340, text: 'hello', color: 2 })
    expect(r.picked).toEqual({ kind: 'items', steps: [r.w.steps.at(-1)!.id], notes: [added[0].id], groups: [] })
  })
  it('puts the top-left over steps and notes at the point', () => {
    const c = copyClip(wn, items(['a'], ['n1']), new Set())!
    const r = pasteClip(wn, c, { x: 1000, y: 500 }, seq('p')) as { w: WorkflowInput }
    // The clip's top-left is the note's x (50) and the step's y (0).
    expect(r.w.steps.at(-1)).toMatchObject({ x: 1050, y: 500 })
    expect(r.w.notes!.at(-1)).toMatchObject({ x: 1000, y: 800 })
  })
  it('pastes a note-only clip, picking just the note', () => {
    const c = copyClip(wn, { kind: 'note', id: 'n2' }, new Set())!
    const r = pasteClip(wn, c, null, seq('p'))
    if ('error' in r) throw new Error(r.error)
    expect(r.w.steps).toEqual(wn.steps)
    expect(r.w.notes!.at(-1)).toMatchObject({ x: 940, y: 940 })
    expect(r.picked).toEqual({ kind: 'note', id: r.w.notes!.at(-1)!.id })
  })
  it('gives pasted notes ids that clash with no step, note or edge', () => {
    const c = copyClip(wn, { kind: 'note', id: 'n1' }, new Set())!
    const r = pasteClip(
      wn,
      c,
      null,
      (() => {
        const ids = ['n1', 'n2', 'a', 'a-out-b', 'fresh']
        return () => ids.shift() ?? 'fresh'
      })()
    )
    if ('error' in r) throw new Error(r.error)
    expect(r.w.notes!.at(-1)!.id).toBe('fresh')
  })
  it('refuses a paste that would pass 100 notes and adds nothing', () => {
    const full: WorkflowInput = { ...wn, notes: Array.from({ length: 100 }, (_, i) => note(`x${i}`, 0, 0)) }
    const c = copyClip(wn, { kind: 'note', id: 'n1' }, new Set())!
    expect(pasteClip(full, c, null, seq('p'))).toEqual({ error: 'A workflow holds at most 100 notes' })
    const mixed = copyClip(wn, items(['a'], ['n1']), new Set())!
    expect(pasteClip(full, mixed, null, seq('p'))).toEqual({ error: 'A workflow holds at most 100 notes' })
  })
  it('refuses a note the server would refuse', () => {
    const mk = (n: unknown) => JSON.stringify({ zumibot: CLIP_MARK, v: 1, steps: [], edges: [], notes: [n], groups: [] })
    expect(parseClip(mk({ ...note('n', 0, 0), color: 9 }))).toBeNull()
    expect(parseClip(mk({ ...note('constructor', 0, 0) }))).toBeNull()
    expect(parseClip(mk({ ...note('n', 0, 0), color: '#AbCdEf' }))!.notes).toEqual([{ ...note('n', 0, 0), color: '#abcdef' }])
  })
  it('refuses a clip with a repeated note id or one that clashes with a step id', () => {
    const mk = (steps: unknown[], notes: unknown[]) => JSON.stringify({ zumibot: CLIP_MARK, v: 1, steps, edges: [], notes, groups: [] })
    expect(parseClip(mk([], [note('n', 0, 0), note('n', 5, 5)]))).toBeNull()
    expect(parseClip(mk([llm('a', 'a', 0, 0, '')], [note('a', 0, 0)]))).toBeNull()
  })
  it('refuses a clip with more than 100 notes', () => {
    const notes = Array.from({ length: 101 }, (_, i) => note(`n${i}`, 0, 0))
    expect(parseClip(JSON.stringify({ zumibot: CLIP_MARK, v: 1, steps: [], edges: [], notes, groups: [] }))).toBeNull()
  })
})

describe('workflow clipboard with groups', () => {
  const note = (id: string, x: number, y: number): Note => ({ id, x, y, width: 240, height: 160, color: 1, text: 'n' })
  const g1: CanvasGroup = { id: 'g1', name: 'Deploy', description: 'Ships it', steps: ['a', 'b'], notes: ['n1'] }
  // t → a → b, with g1 = a, b, n1 and a loose note n2.
  const wg: WorkflowInput = { ...w, notes: [note('n1', 100, 200), note('n2', 900, 900)], groups: [g1] }
  const items = (steps: string[], notes: string[], groups: string[] = []) => ({ kind: 'items' as const, steps, notes, groups })
  const clip = (o: Record<string, unknown>) =>
    JSON.stringify({ zumibot: CLIP_MARK, v: 1, steps: [], edges: [], notes: [], groups: [], ...o })

  it('copies a group when all its members are copied, and none for part of it', () => {
    expect(copyClip(wg, items(['a', 'b'], ['n1']), new Set())!.groups).toEqual([g1])
    expect(copyClip(wg, items(['a', 'b'], []), new Set())!.groups).toEqual([])
    expect(copyClip(wg, items(['t', 'a'], ['n1', 'n2']), new Set())!.groups).toEqual([])
  })
  it('copies a collapsed group in the selection as all its members and the group', () => {
    const c = copyClip(wg, { kind: 'group', id: 'g1' }, new Set(['g1']))!
    expect(c.steps.map((s) => s.id)).toEqual(['a', 'b'])
    expect(c.notes.map((n) => n.id)).toEqual(['n1'])
    expect(c.edges.map((e) => e.id)).toEqual(['a-out-b'])
    expect(c.groups).toEqual([g1])
    // An expanded group is never picked as a group: its members are.
    expect(copyClip(wg, { kind: 'group', id: 'g1' }, new Set())).toBeNull()
  })
  it('round-trips a group through text', () => {
    const c = copyClip(wg, items(['a', 'b'], ['n1']), new Set())!
    expect(parseClip(clipText(c))).toEqual(c)
  })
  it('pastes a group with new ids for it and its members, keeping its name and description', () => {
    const c = copyClip(wg, items(['a', 'b'], ['n1']), new Set())!
    const r = pasteClip(wg, c, null, seq('p'))
    if ('error' in r) throw new Error(r.error)
    const [a2, b2] = r.w.steps.slice(3),
      n12 = r.w.notes!.at(-1)!
    expect(r.w.groups).toEqual([g1, { id: 'p5', name: 'Deploy', description: 'Ships it', steps: [a2.id, b2.id], notes: [n12.id] }])
    expect([a2.id, b2.id, n12.id]).toEqual(['p1', 'p2', 'p4'])
    const all = [
      ...r.w.steps.map((s) => s.id),
      ...r.w.notes!.map((n) => n.id),
      ...r.w.groups!.map((g) => g.id),
      ...r.w.edges.map((e) => e.id)
    ]
    expect(new Set(all).size).toBe(all.length)
    // The pasted items are picked, not the group: it lands expanded.
    expect(r.picked).toEqual({ kind: 'items', steps: [a2.id, b2.id], notes: [n12.id], groups: [] })
  })
  it('refuses a paste past 50 groups and adds nothing', () => {
    const full: WorkflowInput = { ...wg, groups: Array.from({ length: 50 }, (_, i) => ({ id: `x${i}`, name: 'G', steps: [], notes: [] })) }
    const c = copyClip(wg, items(['a', 'b'], ['n1']), new Set())!
    expect(pasteClip(full, c, null, seq('p'))).toEqual({ error: 'A workflow holds at most 50 groups' })
    // A clip with no group pastes into a full workflow.
    expect('error' in pasteClip(full, copyClip(wg, items(['a'], []), new Set())!, null, seq('p'))).toBe(false)
  })
  it('reads an old clip with no groups key as none', () => {
    const text = JSON.stringify({ zumibot: CLIP_MARK, v: 1, steps: [llm('a', 'a', 0, 0, '')], edges: [], notes: [] })
    expect(parseClip(text)!.groups).toEqual([])
  })
  it('refuses groups the save would refuse, or whose members are not in the clip', () => {
    const a = llm('a', 'a', 0, 0, ''),
      b = llm('b', 'b', 10, 0, '')
    const n = note('n1', 0, 0)
    const ok = { id: 'g', name: 'G', steps: ['a', 'b'], notes: ['n1'] }
    expect(parseClip(clip({ steps: [a, b], notes: [n], groups: [ok] }))!.groups).toEqual([ok])
    for (const groups of [
      [{ ...ok, steps: ['a', 'gone'] }],
      [{ ...ok, notes: ['gone'] }],
      [{ ...ok, notes: ['a'] }],
      [{ ...ok, steps: ['n1'] }],
      [ok, { ...ok, id: 'h' }],
      [ok, ok],
      [{ ...ok, id: 'a' }],
      [{ ...ok, id: 'n1' }],
      [{ ...ok, name: '  ' }],
      [{ ...ok, description: 'x'.repeat(146) }],
      [{ ...ok, id: 'constructor' }],
      'g'
    ])
      expect(parseClip(clip({ steps: [a, b], notes: [n], groups })), JSON.stringify(groups).slice(0, 60)).toBeNull()
  })
  it('refuses a group with no members, which would paste as an invisible group', () => {
    const a = llm('a', 'a', 0, 0, '')
    expect(parseClip(clip({ steps: [a], groups: [{ id: 'g', name: 'G', steps: [], notes: [] }] }))).toBeNull()
    expect(
      parseClip(clip({ steps: [a], notes: [note('n1', 0, 0)], groups: [{ id: 'g', name: 'G', steps: [], notes: ['n1'] }] }))!.groups
    ).toHaveLength(1)
  })
  it('refuses a clip with more than 50 groups', () => {
    // One note each, so only the count can refuse it.
    const notes = Array.from({ length: 51 }, (_, i) => note(`n${i}`, 0, 0))
    const groups = notes.map((x, i) => ({ id: `g${i}`, name: 'G', steps: [], notes: [x.id] }))
    expect(parseClip(clip({ notes, groups: groups.slice(0, 50) }))!.groups).toHaveLength(50)
    expect(parseClip(clip({ notes, groups }))).toBeNull()
  })
})

describe('rewriteHandles', () => {
  it('moves named handles in every text field, keeping the braces whitespace, and leaves others alone', () => {
    const s = llm('a', 'a', 0, 0, '{{steps.b.output}} {{ steps.c.output }} {{steps.z.output}}')
    const r = rewriteHandles(
      s,
      new Map([
        ['b', 'b-2'],
        ['c', 'c-2']
      ])
    ) as LlmStep
    expect(r.prompt).toBe('{{steps.b-2.output}} {{ steps.c-2.output }} {{steps.z.output}}')
    expect(r.id).toBe('a')
  })
  it('swaps two handles without chaining', () => {
    const s = llm('a', 'a', 0, 0, '{{steps.b.output}} {{steps.c.output}}')
    expect(
      (
        rewriteHandles(
          s,
          new Map([
            ['b', 'c'],
            ['c', 'b']
          ])
        ) as LlmStep
      ).prompt
    ).toBe('{{steps.c.output}} {{steps.b.output}}')
  })
})
