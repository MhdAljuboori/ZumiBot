import { describe, expect, it } from 'vitest'
import type { CanvasGroup, Edge, Note, Step, WorkflowInput } from '@zumibot/shared/workflows'
import { GRID as GRID_STEP, insertStep, removeItems } from '../src/state/workflowCanvas'
import {
  COLLAPSED_SIZE,
  GROUP_HEAD,
  GROUP_PAD,
  PUSH_GAP,
  collapsedView,
  deleteGroup,
  dropMoves,
  expandPush,
  fieldKey,
  groupBox,
  groupCountText,
  groupOf,
  groupsOfPicked,
  groupsToToggle,
  landField,
  loadCollapsed,
  makeGroup,
  moveGroup,
  realConnection,
  renameGroup,
  saveCollapsed,
  setGroupDescription,
  stepInto,
  stepOutOf,
  ungroup,
  ungroupNotice,
  visibleItem,
  visiblePicked,
  withCollapsed,
  type OpenField,
  type SizeOf
} from '../src/state/workflowGroupEdit'

const seq = (p: string) => {
  let n = 0
  return () => `${p}${++n}`
}
const trig = (id: string, x: number, y: number): Step => ({ id, handle: 'trigger', name: 'Trigger', kind: 'trigger', x, y })
const wait = (id: string, x: number, y: number): Step => ({ id, handle: id, name: id.toUpperCase(), kind: 'wait', x, y, minutes: 1 })
const edge = (from: string, port: Edge['port'], to: string): Edge => ({ id: `${from}-${port}-${to}`, from, port, to })
const note = (id: string, x: number, y: number, width = 240, height = 160): Note => ({ id, x, y, width, height, color: 1, text: '' })
const group = (id: string, name: string, steps: string[], notes: string[] = []): CanvasGroup => ({ id, name, steps, notes })

// t → a → b → c → d, and x on its own; one note under b.
const w: WorkflowInput = {
  id: null,
  name: 'W',
  enabled: false,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps: [trig('t', -300, 0), wait('a', 0, 0), wait('b', 300, 0), wait('c', 600, 0), wait('d', 900, 0), wait('x', 900, 300)],
  edges: [edge('t', 'out', 'a'), edge('a', 'out', 'b'), edge('b', 'out', 'c'), edge('c', 'out', 'd')],
  notes: [note('n1', 300, 120)],
  groups: []
}
// g1 = b, c, n1: its box is x 276..844, y -60..304.
const grouped = (): WorkflowInput => ({ ...w, groups: [group('g1', 'Deploy', ['b', 'c'], ['n1'])] })
// d sits inside g1's box; f is clear of the box but in the way of d once pushed; e is clear of both.
const crowded = (): WorkflowInput => {
  const g = grouped()
  return { ...g, steps: [...g.steps.map((s) => (s.id === 'd' ? { ...s, x: 520 } : s)), wait('e', 900, 400), wait('f', 900, 40)] }
}
const size: SizeOf = () => ({ width: 220, height: 80 })
const stepAt = (v: WorkflowInput, id: string) => {
  const s = v.steps.find((x) => x.id === id)!
  return { x: s.x, y: s.y }
}
const memoryStorage = (): Storage => {
  const m = new Map<string, string>()
  return {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => m.get(k) ?? null,
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => {
      m.delete(k)
    },
    setItem: (k: string, v: string) => {
      m.set(k, String(v))
    }
  }
}

describe('group geometry constants', () => {
  it('pads the box, leaves room for the header, and gives the push its gap', () => {
    expect([GROUP_PAD, GROUP_HEAD, PUSH_GAP]).toEqual([24, 36, 40])
    expect(COLLAPSED_SIZE).toEqual({ width: 220, height: 64 })
  })
})

describe('makeGroup', () => {
  it('makes a group named Group N and refuses a selection that breaks a rule', () => {
    const r = makeGroup(w, { steps: ['b', 'c'], notes: ['n1'], groups: [] }, seq('g')) as { w: WorkflowInput; groupId: string }
    expect(r.w.groups).toEqual([{ id: r.groupId, name: 'Group 1', steps: ['b', 'c'], notes: ['n1'] }])
    const r2 = makeGroup(r.w, { steps: ['d', 'x'], notes: [], groups: [] }, seq('h'))
    expect(r2).toEqual({ error: 'The steps must form one connected chain' })
  })
  it('names the next free number', () => {
    const w2 = { ...w, groups: [{ id: 'g1', name: 'Group 1', steps: ['a', 'b'], notes: [] }] }
    expect((makeGroup(w2, { steps: ['c', 'd'], notes: [], groups: [] }, seq('g')) as { w: WorkflowInput }).w.groups![1].name).toBe(
      'Group 2'
    )
    const gap = { ...w, groups: [group('g1', 'Group 2', ['a', 'b'])] }
    expect((makeGroup(gap, { steps: ['c', 'd'], notes: [], groups: [] }, seq('g')) as { w: WorkflowInput }).w.groups![1].name).toBe(
      'Group 1'
    )
  })
  it('keeps the steps in workflow order, whatever order they were picked in', () => {
    const r = makeGroup(w, { steps: ['c', 'b', 'c'], notes: [], groups: [] }, seq('g')) as { w: WorkflowInput }
    expect(r.w.groups![0].steps).toEqual(['b', 'c'])
  })
  it('gives the group an id no step, note, edge or group has', () => {
    const g = { ...w, groups: [group('g1', 'Old', ['d', 'x'])] }
    const gen = (() => {
      const ids = ['b', 'n1', 'a-out-b', 'g1', 'fresh']
      return () => ids.shift() ?? 'later'
    })()
    const r = makeGroup(g, { steps: ['b', 'c'], notes: [], groups: [] }, gen) as { w: WorkflowInput; groupId: string }
    expect(r.groupId).toBe('fresh')
    expect(r.w.groups!.map((x) => x.id)).toEqual(['g1', 'fresh'])
  })
  it('counts a picked collapsed group as taken, and leaves out ids the workflow does not have', () => {
    expect(makeGroup(grouped(), { steps: ['a'], notes: [], groups: ['g1'] }, seq('h'))).toEqual({
      error: 'A step or note is already in another group'
    })
    expect(makeGroup(w, { steps: ['b', 'gone'], notes: ['no-note'], groups: [] }, seq('h'))).toEqual({
      error: 'A group needs at least two items, one of them a step'
    })
    expect(makeGroup(w, { steps: ['t', 'a'], notes: [], groups: [] }, seq('h'))).toEqual({ error: 'The trigger cannot be in a group' })
  })
  it('refuses a 51st group', () => {
    const full = { ...w, groups: Array.from({ length: 50 }, (_, i) => group(`g${i}`, `G${i}`, [])) }
    expect(makeGroup(full, { steps: ['b', 'c'], notes: [], groups: [] }, seq('h'))).toEqual({ error: 'A workflow holds at most 50 groups' })
  })
})

describe('group edits', () => {
  it('ungroup keeps the items; deleteGroup removes them and their edges', () => {
    const g = grouped() // group g1 = b, c, n1
    expect(ungroup(g, ['g1']).groups).toEqual([])
    expect(ungroup(g, ['g1']).steps).toHaveLength(g.steps.length)
    const d = deleteGroup(g, 'g1')
    expect(d.steps.map((s) => s.id)).not.toContain('b')
    expect(d.notes!.map((n) => n.id)).not.toContain('n1')
    expect(d.edges.some((e) => ['b', 'c'].includes(e.from) || ['b', 'c'].includes(e.to))).toBe(false)
    expect(d.steps.map((s) => s.id)).toEqual(['t', 'a', 'd', 'x'])
    expect(d.edges.map((e) => e.id)).toEqual(['t-out-a'])
    expect(d.groups).toEqual([])
  })
  it('ungroup and deleteGroup of a group that is not there change nothing', () => {
    const g = grouped()
    expect(ungroup(g, ['nope'])).toBe(g)
    expect(deleteGroup(g, 'nope')).toBe(g)
  })
  it('removing members prunes the group and drops it below two items or with no step', () => {
    const g = grouped()
    expect(removeItems(g, { steps: ['b'], notes: [], groups: [] }).groups![0]).toMatchObject({ steps: ['c'], notes: ['n1'] })
    expect(removeItems(g, { steps: ['b', 'c'], notes: [], groups: [] }).groups).toEqual([])
    expect(removeItems({ ...g, groups: [group('g1', 'Two', ['b', 'c'])] }, { steps: ['b'], notes: [], groups: [] }).groups).toEqual([])
    expect(removeItems(g, { steps: [], notes: ['n1'], groups: [] }).groups).toEqual([group('g1', 'Deploy', ['b', 'c'])])
  })
  it('renames (never blank) and sets or clears the description', () => {
    const g = grouped()
    expect(renameGroup(g, 'g1', '  ')).toBe(g)
    expect(renameGroup(g, 'g1', 'Ship it').groups![0].name).toBe('Ship it')
    expect(renameGroup(g, 'g1', 'Deploy')).toBe(g)
    expect(renameGroup(g, 'nope', 'X')).toBe(g)
    expect(renameGroup(g, 'g1', 'n'.repeat(120)).groups![0].name).toBe('n'.repeat(100))
    expect(setGroupDescription(g, 'g1', 'Hi').groups![0].description).toBe('Hi')
    expect(setGroupDescription(setGroupDescription(g, 'g1', 'Hi'), 'g1', '').groups![0]).not.toHaveProperty('description')
    expect(setGroupDescription(setGroupDescription(g, 'g1', 'Hi'), 'g1', '   ').groups![0]).not.toHaveProperty('description')
    expect(setGroupDescription(g, 'g1', '')).toBe(g)
    expect(setGroupDescription(g, 'g1', 'd'.repeat(200)).groups![0].description).toBe('d'.repeat(145))
  })
  it('moves every member by the drag', () => {
    const m = moveGroup(grouped(), 'g1', 40, 20)
    expect([stepAt(m, 'b').x, stepAt(m, 'c').y, m.notes![0].x]).toEqual([340, 20, 340])
    expect([stepAt(m, 'b'), stepAt(m, 'c'), { x: m.notes![0].x, y: m.notes![0].y }]).toEqual([
      { x: 340, y: 20 },
      { x: 640, y: 20 },
      { x: 340, y: 140 }
    ])
    expect(stepAt(m, 'a')).toEqual({ x: 0, y: 0 })
    const g = grouped()
    expect(moveGroup(g, 'g1', 0, 0)).toBe(g)
    expect(moveGroup(g, 'nope', 40, 20)).toBe(g)
  })
  it('an inserted step in an inner edge joins the group', () => {
    const r = insertStep(grouped(), 'b-out-c', 'wait', { x: 450, y: 0 }, seq('i'))
    expect(r.w.groups![0].steps).toContain(r.stepId)
    expect(r.w.groups![0].steps).toEqual(['b', 'c', 'i1'])
    expect(insertStep(grouped(), 'a-out-b', 'wait', { x: 150, y: 0 }, seq('i')).w.groups).toEqual(grouped().groups)
  })
})

describe('group lookups', () => {
  it('groupOf finds the group holding a step or note', () => {
    expect(groupOf(grouped(), 'c')?.id).toBe('g1')
    expect(groupOf(grouped(), 'n1')?.id).toBe('g1')
    expect(groupOf(grouped(), 'a')).toBeNull()
    expect(groupOf({}, 'a')).toBeNull()
  })
  it('groupsOfPicked lists the groups any picked item or picked group belongs to, once each', () => {
    const g = { ...grouped(), groups: [group('g1', 'One', ['b', 'c'], ['n1']), group('g2', 'Two', ['d', 'x'])] }
    expect(groupsOfPicked(g, { steps: ['c', 'b'], notes: ['n1'], groups: [] })).toEqual(['g1'])
    expect(groupsOfPicked(g, { steps: ['x', 'a'], notes: [], groups: ['g1'] })).toEqual(['g1', 'g2'])
    expect(groupsOfPicked(g, { steps: ['a'], notes: [], groups: ['gone'] })).toEqual([])
  })
})

describe('group box and the collapsed view', () => {
  it('derives the box from its members with padding and header', () => {
    // b at (300,0) 220x80, c at (600,0) 220x80, n1 at (300,120) 240x160
    expect(groupBox(grouped(), grouped().groups![0], size)).toEqual({ x: 276, y: -60, width: 568, height: 364 })
  })
  it('measures the steps with sizeOf', () => {
    const tall: SizeOf = (id) => (id === 'c' ? { width: 240, height: 300 } : { width: 220, height: 80 })
    expect(groupBox(grouped(), grouped().groups![0], tall)).toEqual({ x: 276, y: -60, width: 588, height: 384 })
  })
  it('hides collapsed members and reroutes outside edges to the group', () => {
    const v = collapsedView(grouped(), new Set(['g1']))
    expect([...v.hidden].sort()).toEqual(['b', 'b-out-c', 'c', 'n1'])
    expect(v.edgeEnds.get('a-out-b')).toEqual({ target: 'g1' })
    expect(v.edgeEnds.get('c-out-d')).toEqual({ source: 'g1', sourceHandle: 'out' })
    expect([...v.edgeEnds.keys()].sort()).toEqual(['a-out-b', 'c-out-d'])
    expect(visibleItem(grouped(), new Set(['g1']), 'c')).toBe('g1')
  })
  it('hides an inner back edge with the members and reroutes nothing for it', () => {
    const back = { ...grouped(), edges: [...grouped().edges, edge('c', 'out', 'b')] }
    const v = collapsedView(back, new Set(['g1']))
    expect([...v.hidden].sort()).toEqual(['b', 'b-out-c', 'c', 'c-out-b', 'n1'])
    expect(v.edgeEnds.has('c-out-b')).toBe(false)
  })
  it('hides nothing for an expanded group or an unknown id, and maps a note or a visible step to itself', () => {
    expect(collapsedView(grouped(), new Set()).hidden.size).toBe(0)
    expect(collapsedView(grouped(), new Set(['nope'])).edgeEnds.size).toBe(0)
    expect(visibleItem(grouped(), new Set(['g1']), 'n1')).toBe('g1')
    expect(visibleItem(grouped(), new Set(['g1']), 'a')).toBe('a')
    expect(visibleItem(grouped(), new Set(), 'c')).toBe('c')
  })
  it('reroutes both ends of an edge between two collapsed groups', () => {
    const two = { ...grouped(), groups: [group('g1', 'One', ['a', 'b']), group('g2', 'Two', ['c', 'd'])] }
    const v = collapsedView(two, new Set(['g1', 'g2']))
    expect(v.edgeEnds.get('b-out-c')).toEqual({ source: 'g1', sourceHandle: 'out', target: 'g2' })
    expect(v.edgeEnds.get('t-out-a')).toEqual({ target: 'g1' })
    expect([...v.hidden].sort()).toEqual(['a', 'a-out-b', 'b', 'c', 'c-out-d', 'd'])
  })
})

describe('expandPush', () => {
  it('expanding pushes overlapping items right, cascading, and leaves the rest', () => {
    // d at (520,0) would sit inside g1's box (x 276..844); e at (900,400) is clear; f at (900,40) gets hit by pushed d.
    const p = expandPush(crowded(), 'g1', size, new Set())
    // Box right 844 + 40 = 884, up to the next grid line, so the gap is never under 40.
    expect(stepAt(p, 'd')).toEqual({ x: 900, y: 0 })
    expect(stepAt(p, 'f').x).toBeGreaterThanOrEqual(900 + 220 + 40)
    expect(stepAt(p, 'f')).toEqual({ x: 1160, y: 40 })
    for (const id of ['t', 'a', 'b', 'c', 'e', 'x']) expect(stepAt(p, id)).toEqual(stepAt(crowded(), id))
    expect(p.notes).toEqual(crowded().notes)
  })
  it('cascades two deep: d into e, e into f', () => {
    // The brief's first layout: e at (900,0) is clear of the box but in d's way once pushed, and f in e's.
    const deep = { ...crowded(), steps: crowded().steps.map((s) => (s.id === 'e' ? { ...s, y: 0 } : s)) }
    const p = expandPush(deep, 'g1', size, new Set())
    expect([stepAt(p, 'd'), stepAt(p, 'e'), stepAt(p, 'f')]).toEqual([
      { x: 900, y: 0 },
      { x: 1160, y: 0 },
      { x: 1420, y: 40 }
    ])
    for (const id of ['t', 'a', 'b', 'c', 'x']) expect(stepAt(p, id)).toEqual(stepAt(deep, id))
  })
  it('leaves an item touching the box edge, or level with it past a gap, where it is', () => {
    // Box x 276..844, y -60..304: r touches its right edge, u its bottom; d (900,0) is level with it, v under it.
    const g = { ...grouped(), steps: [...grouped().steps, wait('r', 844, 100), wait('u', 300, 304), wait('v', 400, 400)] }
    expect(expandPush(g, 'g1', size, new Set())).toBe(g)
  })
  it('keeps two pushed items in the order they started in', () => {
    // p comes first in the list but starts right of q; both land on 900, and q must stay the left one.
    const g = {
      ...grouped(),
      steps: [
        ...grouped().steps.map((s) => (s.id === 'd' || s.id === 'x' ? { ...s, y: s.y + 1000 } : s)),
        wait('p', 700, 20),
        wait('q', 400, 30)
      ]
    }
    const out = expandPush(g, 'g1', size, new Set())
    expect([stepAt(out, 'q'), stepAt(out, 'p')]).toEqual([
      { x: 900, y: 30 },
      { x: 1160, y: 20 }
    ])
  })
  it('never pushes a note the collapsed group sat on (a backdrop), but still pushes what the box now covers', () => {
    // n9 holds the collapsed node's rect (276,-60 220x64) and is not a member: a phase note behind the group.
    const g = { ...crowded(), notes: [...crowded().notes!, note('n9', 200, -100, 400, 200)] }
    const p = expandPush(g, 'g1', size, new Set())
    expect(p.notes!.find((n) => n.id === 'n9')).toMatchObject({ x: 200, y: -100 })
    expect([stepAt(p, 'd'), stepAt(p, 'f')]).toEqual([
      { x: 900, y: 0 },
      { x: 1160, y: 40 }
    ])
  })
  it('pushes a note that only partly covers the collapsed node', () => {
    // n9 starts right of the node's left edge (300 > 276), so it does not hold it.
    const g = { ...grouped(), notes: [...grouped().notes!, note('n9', 300, -200, 300, 160)] }
    const p = expandPush(g, 'g1', size, new Set())
    expect(p.notes!.find((n) => n.id === 'n9')).toMatchObject({ x: 900, y: -200 })
    expect(stepAt(p, 'd')).toEqual({ x: 900, y: 0 })
  })
  it('hands back the same workflow when nothing is in the way', () => {
    const g = grouped()
    expect(expandPush(g, 'g1', size, new Set())).toBe(g)
    expect(expandPush(g, 'nope', size, new Set())).toBe(g)
  })
  it('pushes a loose note too', () => {
    const g = { ...grouped(), notes: [...grouped().notes!, note('n2', 700, 200)] }
    expect(expandPush(g, 'g1', size, new Set()).notes!.find((n) => n.id === 'n2')).toMatchObject({ x: 900, y: 200 })
  })
  it('counts another group as its collapsed node when collapsed, as its whole box when not, and moves it whole', () => {
    // g2's box is x 376..644, y -460..504, overlapping g1's; its collapsed node at (376,-460) is clear of it.
    const g = {
      ...grouped(),
      steps: grouped().steps.map((s) => (s.id === 'd' ? { ...s, x: 400, y: -400 } : s.id === 'x' ? { ...s, x: 400, y: 400 } : s)),
      groups: [...grouped().groups!, group('g2', 'Two', ['d', 'x'])]
    }
    expect(expandPush(g, 'g1', size, new Set(['g2']))).toBe(g)
    const p = expandPush(g, 'g1', size, new Set())
    // Moved by whole grid steps (520 = 884 - 376 rounded up to 20s), so its members stay on the grid.
    expect([stepAt(p, 'd'), stepAt(p, 'x')]).toEqual([
      { x: 920, y: -400 },
      { x: 920, y: 400 }
    ])
    expect(stepAt(p, 'b')).toEqual({ x: 300, y: 0 })
  })
})

describe('collapse state', () => {
  it('collapse state survives broken storage and skips an unsaved workflow', () => {
    expect(
      loadCollapsed('w1', {
        getItem: () => {
          throw new Error('x')
        }
      } as unknown as Storage)
    ).toEqual(new Set())
    const mem = memoryStorage()
    saveCollapsed(null, new Set(['g1']), mem)
    expect(mem.length).toBe(0)
  })
  it('round-trips per workflow, ignores what is not a list of strings, and never throws on save', () => {
    const mem = memoryStorage()
    saveCollapsed('w1', new Set(['g1', 'g2']), mem)
    expect(mem.getItem('cb.wf.collapsed.w1')).toBe('["g1","g2"]')
    expect(loadCollapsed('w1', mem)).toEqual(new Set(['g1', 'g2']))
    expect(loadCollapsed('w2', mem)).toEqual(new Set())
    expect(loadCollapsed(null, mem)).toEqual(new Set())
    saveCollapsed('w1', new Set(), mem)
    expect(mem.getItem('cb.wf.collapsed.w1')).toBeNull()
    mem.setItem('cb.wf.collapsed.w3', '["g1",5,null,"g2"]')
    expect(loadCollapsed('w3', mem)).toEqual(new Set(['g1', 'g2']))
    mem.setItem('cb.wf.collapsed.w4', '{not json')
    expect(loadCollapsed('w4', mem)).toEqual(new Set())
    mem.setItem('cb.wf.collapsed.w5', '{"g1":true}')
    expect(loadCollapsed('w5', mem)).toEqual(new Set())
    expect(() =>
      saveCollapsed('w1', new Set(['g1']), {
        setItem: () => {
          throw new Error('full')
        }
      } as unknown as Storage)
    ).not.toThrow()
  })
})

describe('ungroupNotice', () => {
  const g = (name: string): CanvasGroup => group(name.toLowerCase(), name, ['b', 'c'])
  it('says which groups the save ungrouped and why', () => {
    expect(ungroupNotice([])).toBeNull()
    expect(ungroupNotice([{ group: g('Deploy'), reason: 'many-entries' }])).toBe(
      'Ungrouped Deploy: Steps outside can only connect into the first step of the group.'
    )
    expect(
      ungroupNotice([
        { group: g('A'), reason: 'too-few' },
        { group: g('B'), reason: 'not-connected' }
      ])
    ).toBe('Ungrouped 2 groups: A (A group needs at least two items, one of them a step), B (The steps must form one connected chain).')
  })
  it('ends in a full stop, so the save notice after it reads as its own sentence', () => {
    const text = [ungroupNotice([{ group: g('Deploy'), reason: 'many-entries' }]), 'Saved, but turned off.'].join(' ')
    expect(text).toBe('Ungrouped Deploy: Steps outside can only connect into the first step of the group. Saved, but turned off.')
  })
})

describe('dropMoves', () => {
  const at = new Map([
    ['g1', { x: 276, y: -60 }],
    ['g2', { x: 876, y: 236 }]
  ])
  it('puts a lone step or note on the grid', () => {
    expect(dropMoves([{ id: 'a', x: 113, y: 49 }], at)).toEqual({ items: [{ id: 'a', x: 120, y: 40 }], folded: [] })
  })
  it('keeps several items by their shared offset, as React Flow snapped the first', () => {
    expect(
      dropMoves(
        [
          { id: 'a', x: 120, y: 40 },
          { id: 'b', x: 433, y: 47 }
        ],
        at
      ).items
    ).toEqual([
      { id: 'a', x: 120, y: 40 },
      { id: 'b', x: 433, y: 47 }
    ])
  })
  it('moves a collapsed group by whole grid steps, alone or with others', () => {
    // React Flow snapped g1's own node (off the grid by the padding) to the grid: 4 px off its members' grid
    expect(dropMoves([{ id: 'g1', x: 320, y: -20 }], at).folded).toEqual([{ id: 'g1', dx: 40, dy: 40 }])
    // two collapsed groups and nothing else: React Flow snapped only the first, and both still move on the grid
    const two = dropMoves(
      [
        { id: 'g1', x: 320, y: -20 },
        { id: 'g2', x: 920, y: 276 }
      ],
      at
    )
    expect(two.items).toEqual([])
    expect(two.folded).toEqual([
      { id: 'g1', dx: 40, dy: 40 },
      { id: 'g2', dx: 40, dy: 40 }
    ])
    for (const f of two.folded) expect([f.dx % GRID_STEP, f.dy % GRID_STEP]).toEqual([0, 0])
    // with a step that React Flow snapped, the group keeps the step's (whole) offset
    const mixed = dropMoves(
      [
        { id: 'a', x: 40, y: 40 },
        { id: 'g1', x: 316, y: -20 }
      ],
      at
    )
    expect(mixed).toEqual({ items: [{ id: 'a', x: 40, y: 40 }], folded: [{ id: 'g1', dx: 40, dy: 40 }] })
  })
})

describe('an open note or group header field', () => {
  const ws = (): WorkflowInput => ({
    ...grouped(),
    notes: [{ ...note('n1', 300, 120), text: 'Hi' }],
    groups: [{ ...group('g1', 'Deploy', ['b', 'c'], ['n1']), description: 'Why' }]
  })
  it('lands as the edit the field makes on blur, with its history key', () => {
    const w0 = ws()
    const f: OpenField = { kind: 'note', id: 'n1', text: 'Hi there' }
    expect(landField(w0, f).notes![0].text).toBe('Hi there')
    expect(landField(w0, { kind: 'group', id: 'g1', field: 'name', text: 'Ship' }).groups![0].name).toBe('Ship')
    expect(landField(w0, { kind: 'group', id: 'g1', field: 'description', text: 'Because' }).groups![0].description).toBe('Because')
    expect([
      fieldKey(f),
      fieldKey({ kind: 'group', id: 'g1', field: 'name', text: '' }),
      fieldKey({ kind: 'group', id: 'g1', field: 'description', text: '' })
    ]).toEqual(['note:n1:text', 'group:g1:name', 'group:g1:description'])
  })
  it('changes nothing (the same object) when landing it would change nothing', () => {
    const w0 = ws()
    for (const f of [
      { kind: 'note', id: 'n1', text: 'Hi' },
      { kind: 'note', id: 'gone', text: 'x' },
      { kind: 'group', id: 'g1', field: 'name', text: 'Deploy' },
      { kind: 'group', id: 'g1', field: 'name', text: '   ' },
      { kind: 'group', id: 'g1', field: 'description', text: 'Why' },
      { kind: 'group', id: 'nope', field: 'name', text: 'Ship' }
    ] as OpenField[])
      expect(landField(w0, f), JSON.stringify(f)).toBe(w0)
    const bare = { ...w0, groups: [group('g1', 'Deploy', ['b', 'c'], ['n1'])] }
    expect(landField(bare, { kind: 'group', id: 'g1', field: 'description', text: '  ' })).toBe(bare)
  })
})

describe('connections drawn to and from a collapsed group', () => {
  const folded = new Set(['g1'])
  it('maps a connection out of a collapsed group to its exit step, and one into it to its entry step', () => {
    expect(realConnection(grouped(), folded, { source: 'g1', sourceHandle: 'out', target: 'x' })).toEqual({
      from: { stepId: 'c', port: 'out' },
      to: 'x'
    })
    expect(realConnection(grouped(), folded, { source: 'x', sourceHandle: 'out', target: 'g1' })).toEqual({
      from: { stepId: 'x', port: 'out' },
      to: 'b'
    })
    expect(stepOutOf(grouped(), folded, 'g1', 'out')).toBe('c')
    expect(stepInto(grouped(), folded, 'g1')).toBe('b')
  })
  it('leaves steps and groups that are not collapsed as they are', () => {
    expect(realConnection(grouped(), folded, { source: 'a', sourceHandle: 'out', target: 'd' })).toEqual({
      from: { stepId: 'a', port: 'out' },
      to: 'd'
    })
    expect(realConnection(grouped(), new Set(), { source: 'b', sourceHandle: 'out', target: 'x' })).toEqual({
      from: { stepId: 'b', port: 'out' },
      to: 'x'
    })
    expect(stepInto(grouped(), new Set(), 'g1')).toBe('g1')
  })
  it('joins nothing for a missing port, a group to itself, or a step to itself', () => {
    expect(realConnection(grouped(), folded, { source: 'a', sourceHandle: null, target: 'g1' })).toBeNull()
    expect(realConnection(grouped(), folded, { source: 'g1', sourceHandle: 'out', target: 'g1' })).toBeNull()
    expect(realConnection(grouped(), folded, { source: 'a', sourceHandle: 'out', target: 'a' })).toBeNull()
  })
  it('takes the member that leaves by that port, even when the group breaks the exit rule', () => {
    // b leaves to x by out, and c (a condition) to d by yes: two exits, each found by its own port.
    const c: Step = { id: 'c', handle: 'c', name: 'C', kind: 'condition', x: 600, y: 0, model: 'haiku', question: 'q' }
    const two = {
      ...grouped(),
      steps: grouped().steps.map((s) => (s.id === 'c' ? c : s)),
      edges: [edge('a', 'out', 'b'), edge('b', 'out', 'c'), edge('c', 'yes', 'd'), edge('b', 'out', 'x')]
    }
    expect(stepOutOf(two, folded, 'g1', 'yes')).toBe('c')
    expect(stepOutOf(two, folded, 'g1', 'out')).toBe('b')
    expect(stepOutOf({ ...grouped(), edges: [edge('b', 'out', 'c')] }, folded, 'g1', 'out')).toBeNull()
  })
  it('drops into a collapsed group with no entry at its first step, top-left first, and nowhere in a loop', () => {
    const noEntry = { ...grouped(), edges: [edge('b', 'out', 'c'), edge('c', 'out', 'd')] }
    expect(stepInto(noEntry, folded, 'g1')).toBe('b')
    const apart = { ...grouped(), edges: [], steps: grouped().steps.map((s) => (s.id === 'c' ? { ...s, y: -100 } : s)) }
    expect(stepInto(apart, folded, 'g1')).toBe('c')
    const loop = { ...grouped(), edges: [edge('b', 'out', 'c'), edge('c', 'out', 'b')] }
    expect(stepInto(loop, folded, 'g1')).toBeNull()
    expect(realConnection(loop, folded, { source: 'a', sourceHandle: 'out', target: 'g1' })).toBeNull()
  })
})

describe('which groups fold, and how', () => {
  const two = (): WorkflowInput => ({ ...grouped(), groups: [group('g1', 'Deploy', ['b', 'c'], ['n1']), group('g2', 'Tail', ['d', 'x'])] })
  it("groupsToToggle takes the picked items' groups, or every group when nothing is picked", () => {
    expect(groupsToToggle(two(), null)).toEqual(['g1', 'g2'])
    expect(groupsToToggle(two(), { kind: 'step', id: 'c' })).toEqual(['g1'])
    expect(groupsToToggle(two(), { kind: 'group', id: 'g2' })).toEqual(['g2'])
    expect(groupsToToggle(two(), { kind: 'items', steps: ['a', 'x'], notes: ['n1'], groups: [] })).toEqual(['g1', 'g2'])
    expect(groupsToToggle(two(), { kind: 'step', id: 'a' })).toEqual([])
    expect(groupsToToggle(two(), { kind: 'edge', id: 'a-out-b' })).toEqual([])
  })
  it('withCollapsed adds or takes out ids, and gives the same set back when nothing changes', () => {
    const s = new Set(['g1'])
    expect(withCollapsed(s, ['g2'], true)).toEqual(new Set(['g1', 'g2']))
    expect(withCollapsed(s, ['g1', 'g2'], false)).toEqual(new Set())
    expect(withCollapsed(s, ['g1'], true)).toBe(s)
    expect(withCollapsed(s, ['g2'], false)).toBe(s)
    expect(withCollapsed(s, [], true)).toBe(s)
  })
  it('groupCountText counts the steps, and the notes when there are any', () => {
    expect(groupCountText(2, 0)).toBe('2 steps')
    expect(groupCountText(1, 1)).toBe('1 step · 1 note')
    expect(groupCountText(3, 2)).toBe('3 steps · 2 notes')
  })
  it('visiblePicked shows a hidden step as its collapsed group, once, in order', () => {
    expect(visiblePicked(two(), new Set(['g1']), ['a', 'b', 'c', 'd'])).toEqual({ steps: ['a', 'd'], groups: ['g1'] })
    expect(visiblePicked(two(), new Set(), ['b', 'c'])).toEqual({ steps: ['b', 'c'], groups: [] })
    expect(visiblePicked(two(), new Set(['g1', 'g2']), ['x', 'b'])).toEqual({ steps: [], groups: ['g2', 'g1'] })
  })
})
