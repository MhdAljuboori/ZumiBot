import { describe, expect, it } from 'vitest'
import { GROUP_RULE_TEXT, brokenGroups, dropBrokenGroups, groupEnds, groupRuleBreak } from '@zumibot/shared/workflowGroups'
import type { Edge, Port, Step, WorkflowInput } from '@zumibot/shared/workflows'

const step = (id: string, kind: 'trigger' | 'condition' | 'wait' = 'wait'): Step =>
  kind === 'trigger'
    ? { id, handle: id, name: id, x: 0, y: 0, kind }
    : kind === 'condition'
      ? { id, handle: id, name: id, x: 0, y: 0, kind, question: 'q', model: 'haiku' }
      : { id, handle: id, name: id, x: 0, y: 0, kind, minutes: 1 }
const edge = (from: string, port: Port, to: string): Edge => ({ id: `${from}-${port}-${to}`, from, port, to })

// t -> a -> b -> c -> d, and c (a condition) no -> x
const w: Pick<WorkflowInput, 'steps' | 'edges' | 'groups'> = {
  steps: [step('t', 'trigger'), step('a'), step('b'), step('c', 'condition'), step('d'), step('x')],
  edges: [edge('t', 'out', 'a'), edge('a', 'out', 'b'), edge('b', 'out', 'c'), edge('c', 'yes', 'd'), edge('c', 'no', 'x')],
  groups: []
}

describe('groupRuleBreak', () => {
  // c has two outside edges, so it is not a valid last step on its own graph: use b..c with x and d both gone.
  const flow = { ...w, edges: [edge('t', 'out', 'a'), edge('a', 'out', 'b'), edge('b', 'out', 'c'), edge('c', 'yes', 'd')] }

  it('accepts a chain inside the flow', () => expect(groupRuleBreak(flow, ['b', 'c'], [])).toBeNull())

  it('needs two items, one a step', () => {
    expect(groupRuleBreak(w, ['b'], [])).toBe('too-few')
    expect(groupRuleBreak(w, [], ['n1', 'n2'])).toBe('too-few')
    expect(groupRuleBreak(w, ['b'], ['n1'])).toBeNull()
  })

  it('refuses the trigger and taken items', () => {
    expect(groupRuleBreak(w, ['t', 'a'], [])).toBe('trigger')
    const g = { ...w, groups: [{ id: 'g1', name: 'G', steps: ['a', 'b'], notes: [] }] }
    expect(groupRuleBreak(g, ['b', 'c'], [])).toBe('taken')
    expect(groupRuleBreak(g, ['a', 'b'], [], 'g1')).toBeNull()
  })

  it('needs one connected chain', () => expect(groupRuleBreak(w, ['a', 'c'], [])).toBe('not-connected'))

  it('allows one entry and one exit, the same step when it is both', () => {
    expect(groupEnds(flow, ['b', 'c'])).toEqual({ entry: 'b', exit: 'c' })
    expect(groupRuleBreak(w, ['a', 'b'], [])).toBeNull()
    expect(groupEnds(w, ['b'])).toEqual({ entry: 'b', exit: 'b' })
    expect(groupEnds({ edges: [] }, ['b'])).toEqual({ entry: null, exit: null })
  })

  it('refuses a second entry or exit', () => {
    const w2 = { ...flow, edges: [...flow.edges, edge('t', 'out', 'c')] }
    expect(groupRuleBreak(w2, ['b', 'c'], [])).toBe('many-entries')
    const w3 = { ...flow, edges: [...flow.edges, edge('b', 'out', 'x')] }
    expect(groupRuleBreak(w3, ['b', 'c'], [])).toBe('many-exits')
    // one last step may have several outgoing edges (c leaves to both d and x)
    expect(groupRuleBreak(w, ['b', 'c'], [])).toBeNull()
  })

  it('keeps a loop inside the group', () => {
    const w4 = { ...flow, edges: [...flow.edges, edge('c', 'no', 'b')] }
    expect(groupRuleBreak(w4, ['b', 'c'], [])).toBeNull()
  })

  it('ignores edge direction when checking the chain is connected', () => {
    const w5 = { ...flow, edges: [edge('t', 'out', 'a'), edge('b', 'out', 'a')] }
    expect(groupRuleBreak(w5, ['a', 'b'], [])).toBeNull()
  })

  it('says what broke first, in rule order', () => {
    expect(groupRuleBreak(w, ['t'], [])).toBe('too-few')
    expect(Object.keys(GROUP_RULE_TEXT)).toEqual(['too-few', 'trigger', 'taken', 'not-connected', 'many-entries', 'many-exits'])
    expect(GROUP_RULE_TEXT['too-few']).toBe('A group needs at least two items, one of them a step')
  })

  it('names the earlier rule when two break at once', () => {
    const g = { ...w, groups: [{ id: 'g1', name: 'G', steps: ['a'], notes: [] }] }
    // the trigger and a taken step: trigger
    expect(groupRuleBreak(g, ['t', 'a'], [])).toBe('trigger')
    // a taken step, and b and d are not connected: taken
    expect(groupRuleBreak(g, ['a', 'd'], [])).toBe('taken')
    // b..c with a second entry (t → c) and a second exit (b → x): many-entries
    const both = { ...flow, edges: [...flow.edges, edge('t', 'out', 'c'), edge('b', 'out', 'x')] }
    expect(groupRuleBreak(both, ['b', 'c'], [])).toBe('many-entries')
  })

  it('counts a note in another group as taken', () => {
    const g = { ...w, groups: [{ id: 'g1', name: 'G', steps: ['a'], notes: ['n1'] }] }
    expect(groupRuleBreak(g, ['b', 'c'], ['n1'])).toBe('taken')
    expect(groupRuleBreak(g, ['a'], ['n1'], 'g1')).toBeNull()
  })
})

describe('brokenGroups', () => {
  it('lists each group that breaks a rule with its reason', () => {
    const g = {
      ...w,
      groups: [
        { id: 'ok', name: 'OK', steps: ['a', 'b'], notes: [] },
        { id: 'bad', name: 'Bad', steps: ['d'], notes: ['n1'] },
        { id: 'far', name: 'Far', steps: ['d', 'x'], notes: [] }
      ]
    }
    expect(brokenGroups(g).map((b) => [b.group.id, b.reason])).toEqual([
      ['bad', 'taken'],
      ['far', 'taken']
    ])
    expect(brokenGroups({ ...w, groups: [{ id: 'g', name: 'G', steps: ['a', 'd'], notes: [] }] }).map((b) => b.reason)).toEqual([
      'not-connected'
    ])
  })
})

describe('dropBrokenGroups', () => {
  it('removes broken groups and members that are gone', () => {
    const g = {
      ...w,
      edges: w.edges.filter((e) => e.to !== 'x'),
      groups: [
        { id: 'ok', name: 'OK', steps: ['b', 'c', 'gone'], notes: [] },
        { id: 'bad', name: 'Bad', steps: ['a', 'd'], notes: [] }
      ]
    }
    expect(dropBrokenGroups(g).groups).toEqual([{ id: 'ok', name: 'OK', steps: ['b', 'c'], notes: [] }])
  })

  it('takes the trigger and unknown notes out, and an earlier group keeps a contested item', () => {
    const g = {
      ...w,
      notes: [{ id: 'n1', x: 0, y: 0, width: 240, height: 160, color: 1 as const, text: '' }],
      groups: [
        { id: 'g1', name: 'One', steps: ['t', 'a', 'b'], notes: ['n1', 'nope'] },
        { id: 'g2', name: 'Two', steps: ['b', 'c'], notes: [] }
      ]
    }
    expect(dropBrokenGroups(g).groups).toEqual([{ id: 'g1', name: 'One', steps: ['a', 'b'], notes: ['n1'] }])
  })

  it('does not change the object it is given, and works with no groups', () => {
    const g = { ...w, groups: [{ id: 'bad', name: 'Bad', steps: ['a', 'd'], notes: [] }] }
    dropBrokenGroups(g)
    expect(g.groups).toHaveLength(1)
    expect(dropBrokenGroups({ steps: w.steps, edges: w.edges, groups: undefined }).groups).toEqual([])
  })

  it('leaves every nested member list of its input as it was', () => {
    // a kept group losing a gone member and the trigger, and a dropped one: either would show an in-place filter
    const g = {
      ...w,
      notes: [{ id: 'n1', x: 0, y: 0, width: 240, height: 160, color: 1 as const, text: '' }],
      groups: [
        { id: 'g1', name: 'One', steps: ['t', 'a', 'b', 'gone'], notes: ['n1', 'nope'] },
        { id: 'g2', name: 'Two', steps: ['a', 'd'], notes: [] }
      ]
    }
    const before = JSON.stringify(g)
    const out = dropBrokenGroups(g)
    expect(JSON.stringify(g)).toBe(before)
    expect(out.groups).toEqual([{ id: 'g1', name: 'One', steps: ['a', 'b'], notes: ['n1'] }])
  })
})
