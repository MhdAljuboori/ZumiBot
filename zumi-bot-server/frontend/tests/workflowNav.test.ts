import { describe, expect, it } from 'vitest'
import type { Edge, Step, WorkflowInput } from '@zumibot/shared/workflows'
import { navTarget, reachAll } from '../src/state/workflowNav'

const trig = (id: string, x: number, y: number): Step => ({ id, handle: id, name: id, kind: 'trigger', x, y })
const llm = (id: string, x: number, y: number): Step => ({ id, handle: id, name: id, kind: 'llm', x, y, prompt: '', model: 'haiku' })
const cond = (id: string, x: number, y: number): Step => ({
  id,
  handle: id,
  name: id,
  kind: 'condition',
  x,
  y,
  question: '',
  model: 'haiku'
})
const edge = (from: string, port: Edge['port'], to: string): Edge => ({ id: `${from}-${port}-${to}`, from, port, to })

const w: Pick<WorkflowInput, 'steps' | 'edges'> = {
  steps: [trig('t', 0, 0), llm('a', 300, 0), cond('c', 300, 200), llm('b', 600, 0), llm('d', 600, 150), llm('e', 600, 300)],
  edges: [edge('t', 'out', 'a'), edge('a', 'out', 'b'), edge('c', 'yes', 'd'), edge('c', 'no', 'e'), edge('t', 'out', 'c')]
}

describe('navTarget', () => {
  it('picks the trigger from nothing', () => expect(navTarget(w, null, 'next')).toBe('t'))
  it('goes downstream to the topmost child and upstream to the topmost parent', () => {
    expect(navTarget(w, 't', 'next')).toBe('a')
    expect(navTarget(w, 'c', 'next')).toBe('d')
    expect(navTarget(w, 'b', 'prev')).toBe('a')
    expect(navTarget(w, 't', 'prev')).toBeNull()
  })
  it('moves among siblings by y', () => {
    expect(navTarget(w, 'd', 'down')).toBe('e')
    expect(navTarget(w, 'e', 'up')).toBe('d')
    expect(navTarget(w, 'a', 'down')).toBe('c')
    expect(navTarget(w, 'a', 'up')).toBeNull()
  })
  it('stays put at the end, for an unknown step and for the trigger sideways', () => {
    expect(navTarget(w, 'b', 'next')).toBeNull()
    expect(navTarget(w, 'e', 'down')).toBeNull()
    expect(navTarget(w, 'zz', 'next')).toBeNull()
    expect(navTarget(w, 't', 'down')).toBeNull()
  })
})

describe('reachAll', () => {
  it('lists every step downstream or upstream, without the start, loops included once', () => {
    expect(reachAll(w, 'c', 'next').sort()).toEqual(['d', 'e'])
    expect(reachAll(w, 'b', 'prev').sort()).toEqual(['a', 't'])
    const loop = { steps: w.steps, edges: [...w.edges, edge('b', 'out', 'a')] }
    expect(reachAll(loop, 'a', 'next').sort()).toEqual(['b'])
  })
})
