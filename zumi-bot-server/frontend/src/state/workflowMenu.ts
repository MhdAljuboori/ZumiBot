import { groupsOf, type WorkflowInput } from '@zumibot/shared/workflows'
import { picked, type Picked, type Selection } from './workflowEditor'
import { groupRefusal, groupsOfPicked } from './workflowGroupEdit'

// What the canvas's right-click menu offers, as a pure rule so it is testable without a DOM. The editor runs each action
// with the same functions its keys use; the canvas only opens the menu and says what was picked.

export type MenuAction =
  | 'open'
  | 'rename'
  | 'copy'
  | 'cut'
  | 'duplicate'
  | 'delete'
  | 'group'
  | 'ungroup'
  | 'edit'
  | 'color'
  | 'editDescription'
  | 'collapse'
  | 'expand'
  | 'selectGroup'
  | 'copyGroup'
  | 'deleteGroup'
  | 'addStep'
  | 'addNote'
  | 'paste'
  | 'selectAll'
  | 'expandAll'
  | 'collapseAll'
  | 'fit'
  | 'removeEdge'

export interface MenuItem {
  action: MenuAction
  label: string
  keys?: string
  disabled?: string
}
export type MenuTarget = { kind: 'pane' } | { kind: 'step' | 'note' | 'group' | 'edge'; id: string } | { kind: 'selection' }
// `collapsed`: the groups shown collapsed, so a group's menu offers Expand or Collapse.
export interface MenuContext {
  canPaste: boolean
  collapsed: Set<string>
}

const TRIGGER_COPY = 'The trigger cannot be copied'
const TRIGGER_DELETE = 'The trigger cannot be deleted'

/** The menu's rows for what was right-clicked, in order; a row that cannot run says why in `disabled`. */
export function menuItems(w: WorkflowInput, target: MenuTarget, sel: Selection | null, ctx: MenuContext): MenuItem[] {
  // A connection is only ever removed: its + (a step into it) is on its own hover bar.
  if (target.kind === 'edge') return [{ action: 'removeEdge', label: 'Remove connection', keys: 'Del' }]
  if (target.kind === 'pane') {
    const all: MenuItem[] =
      groupsOf(w).length === 0
        ? []
        : [
            { action: 'expandAll', label: 'Expand all groups', keys: 'Alt+G' },
            { action: 'collapseAll', label: 'Collapse all groups', keys: 'Shift+Alt+G' }
          ]
    return [
      { action: 'addStep', label: 'Add step', keys: 'N' },
      { action: 'addNote', label: 'Add sticky note', keys: 'Shift+S' },
      { action: 'paste', label: 'Paste', keys: 'Ctrl+V', ...(ctx.canPaste ? {} : { disabled: 'Copy something first, or press Ctrl+V' }) },
      { action: 'selectAll', label: 'Select all', keys: 'Ctrl+A' },
      ...all,
      { action: 'fit', label: 'Fit view', keys: '1' }
    ]
  }
  if (target.kind === 'group') {
    const folded = ctx.collapsed.has(target.id)
    return [
      { action: 'rename', label: 'Rename', keys: 'F2' },
      { action: 'editDescription', label: 'Edit description' },
      folded ? { action: 'expand', label: 'Expand', keys: 'Alt+G' } : { action: 'collapse', label: 'Collapse', keys: 'Shift+Alt+G' },
      { action: 'selectGroup', label: 'Select its items' },
      { action: 'copyGroup', label: 'Copy group' },
      { action: 'ungroup', label: 'Ungroup', keys: 'Ctrl+Shift+G' },
      { action: 'deleteGroup', label: 'Delete group' }
    ]
  }
  // The trigger is never copied, cut, duplicated or deleted: a menu on it alone has none of those to offer.
  const p: Picked =
    target.kind === 'selection'
      ? picked(sel)
      : { steps: target.kind === 'step' ? [target.id] : [], notes: target.kind === 'note' ? [target.id] : [], groups: [] }
  const movable = p.steps.filter((id) => w.steps.find((s) => s.id === id)?.kind !== 'trigger').length + p.notes.length + p.groups.length
  const off = (reason: string): { disabled?: string } => (movable === 0 ? { disabled: reason } : {})
  const items: MenuItem[] = []
  if (target.kind === 'step') {
    items.push({ action: 'open', label: 'Open', keys: 'Enter' }, { action: 'rename', label: 'Rename', keys: 'F2' })
  }
  if (target.kind === 'note') {
    items.push({ action: 'edit', label: 'Edit', keys: 'Enter' }, { action: 'color', label: 'Color' })
  }
  // Group is always offered, and says which rule the picked items break; Ungroup only when they belong to a group.
  const refused = groupRefusal(w, p)
  const ungroup: MenuItem[] = groupsOfPicked(w, p).length > 0 ? [{ action: 'ungroup', label: 'Ungroup', keys: 'Ctrl+Shift+G' }] : []
  items.push(
    { action: 'copy', label: 'Copy', keys: 'Ctrl+C', ...off(TRIGGER_COPY) },
    { action: 'cut', label: 'Cut', keys: 'Ctrl+X', ...off(TRIGGER_COPY) },
    { action: 'duplicate', label: 'Duplicate', keys: 'Ctrl+D', ...off(TRIGGER_COPY) },
    { action: 'group', label: 'Group', keys: 'Ctrl+G', ...(refused ? { disabled: refused } : {}) },
    ...ungroup,
    { action: 'delete', label: 'Delete', keys: 'Del', ...off(TRIGGER_DELETE) }
  )
  return items
}

/** The selection a right-click acts on: an item outside the picked ones is picked alone; one inside keeps them all. */
export function selectionForMenu(sel: Selection | null, target: MenuTarget): Selection | null {
  if (target.kind === 'pane' || target.kind === 'selection') return sel
  if (target.kind === 'edge') return { kind: 'edge', id: target.id }
  const p = picked(sel)
  const list = target.kind === 'step' ? p.steps : target.kind === 'note' ? p.notes : p.groups
  return list.includes(target.id) ? sel : { kind: target.kind, id: target.id }
}

/** A key label for the platform: `Ctrl+C` reads `⌘C` on a Mac. The caller says which; this module never looks. */
export const keyLabel = (keys: string, mac: boolean): string => (mac && keys.startsWith('Ctrl+') ? `⌘${keys.slice(5)}` : keys)

export interface MenuFit {
  left: number
  top: number
  maxHeight: number
}

/**
 * Where a menu asked for at `at` (pixels from the canvas's corner) goes: moved up or left just enough to show whole,
 * `edge` clear of every side, and capped at the canvas's height so a menu taller than it scrolls instead of running
 * past the bottom, where the canvas clips it and its last rows are out of reach.
 */
export function placeMenu(
  at: { left: number; top: number },
  size: { width: number; height: number },
  box: { width: number; height: number },
  edge: number
): MenuFit {
  const maxHeight = Math.max(0, box.height - 2 * edge)
  const height = Math.min(size.height, maxHeight)
  return {
    left: Math.max(edge, Math.min(at.left, box.width - size.width - edge)),
    top: Math.max(edge, Math.min(at.top, box.height - height - edge)),
    maxHeight
  }
}
