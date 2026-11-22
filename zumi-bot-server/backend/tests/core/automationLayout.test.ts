import { describe, expect, test } from 'vitest'
import { COLUMN_WIDTH, ROW_HEIGHT, layout, type Point } from '../../src/core/automations/layout'

const steps = (ids: string[]) => ids.map((id) => ({ id }))
const e = (from: string, to: string) => ({ from, to })
// The canvas draws a step 220 by 72 (WorkflowCanvas.tsx NODE_HALF), so two closer than that on both axes overlap.
const overlapping = (pos: Map<string, Point>): string[] => {
  const all = [...pos.entries()]
  const out: string[] = []
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [a, p] = all[i]!,
        [b, q] = all[j]!
      if (Math.abs(p.x - q.x) < 220 && Math.abs(p.y - q.y) < 72) out.push(`${a}/${b}`)
    }
  }
  return out
}

describe('layout on create', () => {
  test('a loop edge lays out and terminates', () => {
    const pos = layout(steps(['t', 'a', 'b']), [e('t', 'a'), e('a', 'b'), e('b', 'a')], 't', new Map())
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x)
    expect(pos.size).toBe(3)
  })

  test('a self loop and an edge back into the trigger still place every step', () => {
    const pos = layout(steps(['t', 'a', 'b']), [e('t', 'a'), e('a', 'a'), e('a', 'b'), e('b', 't')], 't', new Map())
    expect(pos.get('t')).toEqual({ x: 0, y: 0 })
    expect(pos.get('a')).toEqual({ x: COLUMN_WIDTH, y: 0 })
    expect(pos.get('b')).toEqual({ x: 2 * COLUMN_WIDTH, y: 0 })
  })

  test('no two new steps overlap: a diamond shares a column and stacks by row', () => {
    const pos = layout(steps(['t', 'a', 'b', 'c']), [e('t', 'a'), e('t', 'b'), e('a', 'c'), e('b', 'c')], 't', new Map())
    expect(pos.get('a')!.x).toBe(pos.get('b')!.x)
    expect(pos.get('b')!.y - pos.get('a')!.y).toBe(ROW_HEIGHT)
    expect(pos.get('c')).toEqual({ x: 2 * COLUMN_WIDTH, y: 0 })
    expect(overlapping(pos)).toEqual([])
  })

  test('a column is the longest path from the trigger', () => {
    const pos = layout(steps(['t', 'a', 'b']), [e('t', 'b'), e('t', 'a'), e('a', 'b')], 't', new Map())
    expect(pos.get('b')!.x).toBe(2 * COLUMN_WIDTH)
  })

  test('steps in one column stack in the order the edges reach them', () => {
    // b is reached from the trigger before a, whatever order the step list has.
    const pos = layout(steps(['t', 'a', 'b']), [e('t', 'b'), e('t', 'a')], 't', new Map())
    expect(pos.get('b')).toEqual({ x: COLUMN_WIDTH, y: 0 })
    expect(pos.get('a')).toEqual({ x: COLUMN_WIDTH, y: ROW_HEIGHT })
  })

  test('unreachable steps go in a last column', () => {
    const pos = layout(steps(['t', 'a', 'x', 'y', 'z']), [e('t', 'a'), e('y', 'z')], 't', new Map())
    expect(pos.size).toBe(5)
    for (const id of ['x', 'y', 'z']) expect(pos.get(id)!.x).toBe(2 * COLUMN_WIDTH)
    expect(overlapping(pos)).toEqual([])
  })

  test('a long loop through several steps terminates with every step placed', () => {
    const ids = ['t', ...Array.from({ length: 30 }, (_, i) => `s${i}`)]
    const edges = ids.slice(1).map((id, i) => e(ids[i]!, id))
    edges.push(e('s29', 's0'), e('s15', 's3'))
    const pos = layout(steps(ids), edges, 't', new Map())
    expect(pos.size).toBe(31)
    expect(pos.get('s29')!.x).toBe(30 * COLUMN_WIDTH)
  })
})

describe('layout on edit', () => {
  test('placed steps keep their place', () => {
    const placed = new Map([
      ['t', { x: 10, y: 20 }],
      ['a', { x: 900, y: -40 }]
    ])
    const pos = layout(steps(['t', 'a']), [e('t', 'a')], 't', placed)
    expect(pos.get('t')).toEqual({ x: 10, y: 20 })
    expect(pos.get('a')).toEqual({ x: 900, y: -40 })
  })

  test('a new step goes one column right of its first source, below the lowest step in that column', () => {
    const placed = new Map([
      ['t', { x: 0, y: 0 }],
      ['a', { x: 320, y: 0 }],
      ['b', { x: 640, y: 300 }]
    ])
    // c is new and fed by a; b already sits in the column right of a.
    const pos = layout(steps(['t', 'a', 'b', 'c']), [e('t', 'a'), e('a', 'b'), e('a', 'c')], 't', placed)
    expect(pos.get('c')).toEqual({ x: 640, y: 300 + ROW_HEIGHT })
    expect(overlapping(pos)).toEqual([])
  })

  test('a new step in an empty column sits level with its source, and a chain of new steps follows it', () => {
    const placed = new Map([
      ['t', { x: 0, y: 0 }],
      ['a', { x: 40, y: 500 }]
    ])
    const pos = layout(steps(['t', 'a', 'n1', 'n2']), [e('t', 'a'), e('a', 'n1'), e('n1', 'n2')], 't', placed)
    expect(pos.get('n1')).toEqual({ x: 360, y: 500 })
    expect(pos.get('n2')).toEqual({ x: 680, y: 500 })
  })

  test('a step moved near the new column counts as being in it', () => {
    // m sits between columns, close enough to overlap a step put at x 320.
    const placed = new Map([
      ['t', { x: 0, y: 0 }],
      ['m', { x: 450, y: 0 }]
    ])
    const pos = layout(steps(['t', 'm', 'n']), [e('t', 'm'), e('t', 'n')], 't', placed)
    expect(pos.get('n')).toEqual({ x: 320, y: ROW_HEIGHT })
    expect(overlapping(pos)).toEqual([])
  })

  test('new steps fed by one source stack without overlapping', () => {
    const placed = new Map([['t', { x: 0, y: 0 }]])
    const pos = layout(steps(['t', 'a', 'b', 'c']), [e('t', 'a'), e('t', 'b'), e('t', 'c')], 't', placed)
    expect(pos.get('a')).toEqual({ x: 320, y: 0 })
    expect(pos.get('b')).toEqual({ x: 320, y: ROW_HEIGHT })
    expect(pos.get('c')).toEqual({ x: 320, y: 2 * ROW_HEIGHT })
  })

  test('a new step in a loop is placed from the source that feeds it forward, not the one closing the loop', () => {
    const placed = new Map([
      ['t', { x: 0, y: 0 }],
      ['a', { x: 320, y: 0 }]
    ])
    // a → n is listed first, but it closes the loop t → n → a → n.
    const pos = layout(steps(['t', 'a', 'n']), [e('a', 'n'), e('t', 'n'), e('n', 'a')], 't', placed)
    expect(pos.get('n')).toEqual({ x: 320, y: ROW_HEIGHT })
    expect(overlapping(pos)).toEqual([])
  })

  test('an unreachable new step goes in a column right of everything', () => {
    const placed = new Map([
      ['t', { x: 0, y: 0 }],
      ['a', { x: 700, y: 80 }]
    ])
    const pos = layout(steps(['t', 'a', 'x']), [e('t', 'a')], 't', placed)
    expect(pos.get('x')!.x).toBe(700 + COLUMN_WIDTH)
    expect(overlapping(pos)).toEqual([])
  })
})
