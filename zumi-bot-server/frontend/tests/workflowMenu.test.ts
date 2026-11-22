import { describe, expect, it } from 'vitest'
import type { Edge, Step, WorkflowInput } from '@zumibot/shared/workflows'
import type { Selection } from '../src/state/workflowEditor'
import { keyLabel, menuItems, placeMenu, selectionForMenu, type MenuContext, type MenuItem } from '../src/state/workflowMenu'

const trig = (id: string): Step => ({ id, handle: 'trigger', name: 'Trigger', kind: 'trigger', x: 0, y: 0 })
const llm = (id: string): Step => ({ id, handle: id, name: id.toUpperCase(), kind: 'llm', x: 100, y: 0, prompt: 'hi', model: 'haiku' })
const w: WorkflowInput = {
  id: null,
  name: 'W',
  enabled: false,
  timeZone: 'UTC',
  trigger: { kind: 'manual' },
  steps: [trig('t'), llm('a'), llm('b')],
  edges: []
}
const ctx: MenuContext = { canPaste: true, collapsed: new Set() }
const edge = (from: string, port: Edge['port'], to: string): Edge => ({ id: `${from}-${port}-${to}`, from, port, to })
// t → a → b with g1 = a, b.
const wg: WorkflowInput = {
  ...w,
  edges: [edge('t', 'out', 'a'), edge('a', 'out', 'b')],
  groups: [{ id: 'g1', name: 'G', steps: ['a', 'b'], notes: [] }]
}
const actions = (items: MenuItem[]) => items.map((i) => i.action)

describe('workflow context menu', () => {
  it('offers step actions with their keys', () => {
    const items = menuItems(w, { kind: 'step', id: 'a' }, { kind: 'step', id: 'a' }, ctx)
    expect(actions(items)).toEqual(['open', 'rename', 'copy', 'cut', 'duplicate', 'group', 'delete'])
    expect(items.find((i) => i.action === 'rename')?.keys).toBe('F2')
    expect(items.find((i) => i.action === 'group')).toEqual({
      action: 'group',
      label: 'Group',
      keys: 'Ctrl+G',
      disabled: 'A group needs at least two items, one of them a step'
    })
  })
  it('disables copy, cut and delete for the trigger alone', () => {
    const items = menuItems(w, { kind: 'step', id: 't' }, { kind: 'step', id: 't' }, ctx)
    for (const a of ['copy', 'cut', 'delete'] as const) expect(items.find((i) => i.action === a)?.disabled).toBeTruthy()
    expect(items.find((i) => i.action === 'open')?.disabled).toBeUndefined()
  })
  it('offers the pane actions, paste disabled without a clip', () => {
    const items = menuItems(w, { kind: 'pane' }, null, { ...ctx, canPaste: false })
    expect(actions(items)).toEqual(['addStep', 'addNote', 'paste', 'selectAll', 'fit'])
    expect(items.find((i) => i.action === 'paste')?.disabled).toBe('Copy something first, or press Ctrl+V')
    expect(menuItems(w, { kind: 'pane' }, null, ctx).find((i) => i.action === 'paste')?.disabled).toBeUndefined()
  })
  it('offers Add sticky note on the pane', () => {
    expect(menuItems(w, { kind: 'pane' }, null, ctx).find((i) => i.action === 'addNote')?.disabled).toBeUndefined()
  })
  it('offers edit, color, copy, cut, duplicate, group and delete for a note', () => {
    const wn: WorkflowInput = { ...w, notes: [{ id: 'n1', x: 0, y: 0, width: 240, height: 160, color: 1, text: 'hi' }] }
    const items = menuItems(wn, { kind: 'note', id: 'n1' }, { kind: 'note', id: 'n1' }, ctx)
    expect(actions(items)).toEqual(['edit', 'color', 'copy', 'cut', 'duplicate', 'group', 'delete'])
    expect(items.filter((i) => i.disabled !== undefined).map((i) => [i.action, i.disabled])).toEqual([
      ['group', 'A group needs at least two items, one of them a step']
    ])
  })
  it('a selection of notes and steps offers the same copy, cut, duplicate, group and delete', () => {
    const wn: WorkflowInput = { ...w, notes: [{ id: 'n1', x: 0, y: 0, width: 240, height: 160, color: 1, text: 'hi' }] }
    const sel: Selection = { kind: 'items', steps: ['t'], notes: ['n1'], groups: [] }
    const items = menuItems(wn, { kind: 'selection' }, sel, ctx)
    expect(actions(items)).toEqual(['copy', 'cut', 'duplicate', 'group', 'delete'])
    expect(items.filter((i) => i.disabled !== undefined).map((i) => [i.action, i.disabled])).toEqual([
      ['group', 'The trigger cannot be in a group']
    ])
  })
  it('offers copy, cut, duplicate, group and delete for several steps, with no open or rename', () => {
    const sel: Selection = { kind: 'items', steps: ['t', 'a', 'b'], notes: [], groups: [] }
    const items = menuItems(w, { kind: 'selection' }, sel, ctx)
    expect(actions(items)).toEqual(['copy', 'cut', 'duplicate', 'group', 'delete'])
    expect(items.filter((i) => i.disabled !== undefined).map((i) => i.action)).toEqual(['group'])
  })
  it('a right-click on an unselected item selects it alone; on a selected one keeps the selection', () => {
    const sel: Selection = { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }
    expect(selectionForMenu(sel, { kind: 'step', id: 'c' })).toEqual({ kind: 'step', id: 'c' })
    expect(selectionForMenu(sel, { kind: 'step', id: 'a' })).toBe(sel)
    expect(selectionForMenu(sel, { kind: 'pane' })).toBe(sel)
    expect(selectionForMenu(sel, { kind: 'selection' })).toBe(sel)
  })
  it('offers Group enabled for a selection that makes a valid group', () => {
    const chain: WorkflowInput = { ...w, edges: [edge('t', 'out', 'a'), edge('a', 'out', 'b')] }
    const items = menuItems(chain, { kind: 'selection' }, { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }, ctx)
    expect(items.find((i) => i.action === 'group')).toEqual({ action: 'group', label: 'Group', keys: 'Ctrl+G' })
    expect(actions(items)).not.toContain('ungroup')
  })
  it('a selection that breaks a rule shows Group disabled with the rule text', () => {
    const items = menuItems(w, { kind: 'selection' }, { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }, ctx)
    expect(items.find((i) => i.action === 'group')?.disabled).toBe('The steps must form one connected chain')
  })
  it('offers Ungroup after Group when a picked item belongs to a group', () => {
    const items = menuItems(wg, { kind: 'step', id: 'a' }, { kind: 'step', id: 'a' }, ctx)
    expect(actions(items)).toEqual(['open', 'rename', 'copy', 'cut', 'duplicate', 'group', 'ungroup', 'delete'])
    expect(items.find((i) => i.action === 'ungroup')).toEqual({ action: 'ungroup', label: 'Ungroup', keys: 'Ctrl+Shift+G' })
    expect(items.find((i) => i.action === 'group')?.disabled).toBe('A group needs at least two items, one of them a step')
    const sel: Selection = { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }
    expect(menuItems(wg, { kind: 'selection' }, sel, ctx).find((i) => i.action === 'group')?.disabled).toBe(
      'A step or note is already in another group'
    )
  })
  it('a group target gives its own items, collapse or expand by its state', () => {
    const expanded = menuItems(wg, { kind: 'group', id: 'g1' }, null, ctx)
    expect(actions(expanded)).toEqual(['rename', 'editDescription', 'collapse', 'selectGroup', 'copyGroup', 'ungroup', 'deleteGroup'])
    expect(expanded.every((i) => i.disabled === undefined)).toBe(true)
    expect(expanded.map((i) => [i.label, i.keys])).toEqual([
      ['Rename', 'F2'],
      ['Edit description', undefined],
      ['Collapse', 'Shift+Alt+G'],
      ['Select its items', undefined],
      ['Copy group', undefined],
      ['Ungroup', 'Ctrl+Shift+G'],
      ['Delete group', undefined]
    ])
    const collapsed = menuItems(wg, { kind: 'group', id: 'g1' }, { kind: 'group', id: 'g1' }, { ...ctx, collapsed: new Set(['g1']) })
    expect(actions(collapsed)).toEqual(['rename', 'editDescription', 'expand', 'selectGroup', 'copyGroup', 'ungroup', 'deleteGroup'])
    expect(collapsed.find((i) => i.action === 'expand')?.keys).toBe('Alt+G')
  })
  it('the pane adds Expand all and Collapse all before Fit view when the workflow has groups', () => {
    const items = menuItems(wg, { kind: 'pane' }, null, ctx)
    expect(actions(items)).toEqual(['addStep', 'addNote', 'paste', 'selectAll', 'expandAll', 'collapseAll', 'fit'])
    expect(items.slice(4, 6)).toEqual([
      { action: 'expandAll', label: 'Expand all groups', keys: 'Alt+G' },
      { action: 'collapseAll', label: 'Collapse all groups', keys: 'Shift+Alt+G' }
    ])
  })
  it('an edge gives one row, Remove connection, and is picked alone', () => {
    const items = menuItems(wg, { kind: 'edge', id: 'a-out-b' }, { kind: 'edge', id: 'a-out-b' }, ctx)
    expect(items).toEqual([{ action: 'removeEdge', label: 'Remove connection', keys: 'Del' }])
    const sel: Selection = { kind: 'items', steps: ['a', 'b'], notes: [], groups: [] }
    expect(selectionForMenu(sel, { kind: 'edge', id: 'a-out-b' })).toEqual({ kind: 'edge', id: 'a-out-b' })
    expect(selectionForMenu({ kind: 'edge', id: 'a-out-b' }, { kind: 'edge', id: 'a-out-b' })).toEqual({ kind: 'edge', id: 'a-out-b' })
    // An edge is never one of the picked items, even under an id a picked group also has.
    expect(selectionForMenu({ kind: 'items', steps: [], notes: [], groups: ['x1'] }, { kind: 'edge', id: 'x1' })).toEqual({
      kind: 'edge',
      id: 'x1'
    })
  })
  it('writes Ctrl as the command key on a Mac', () => {
    expect(keyLabel('Ctrl+C', false)).toBe('Ctrl+C')
    expect(keyLabel('Ctrl+C', true)).toBe('⌘C')
    expect(keyLabel('Del', true)).toBe('Del')
  })
})

describe('placeMenu', () => {
  const box = { width: 900, height: 400 }
  it('opens where asked when the whole menu fits', () => {
    expect(placeMenu({ left: 100, top: 50 }, { width: 240, height: 200 }, box, 8)).toEqual({ left: 100, top: 50, maxHeight: 384 })
  })
  it('moves up and left just enough to keep its bottom and right edges inside', () => {
    expect(placeMenu({ left: 800, top: 300 }, { width: 240, height: 200 }, box, 8)).toEqual({ left: 652, top: 192, maxHeight: 384 })
  })
  it('a menu taller than the canvas starts at the top edge and is capped, so every row scrolls into reach', () => {
    expect(placeMenu({ left: 560, top: 70 }, { width: 240, height: 520 }, box, 8)).toEqual({ left: 560, top: 8, maxHeight: 384 })
  })
  it('never goes past the top-left edge', () => {
    expect(placeMenu({ left: -20, top: -5 }, { width: 240, height: 100 }, box, 8)).toEqual({ left: 8, top: 8, maxHeight: 384 })
  })
})
