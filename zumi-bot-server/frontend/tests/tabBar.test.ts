import { describe, expect, it } from 'vitest'
import { activeTab, TAB_LABELS, TABS, tabTap } from '../src/state/tabBar'

describe('activeTab', () => {
  it('is the rail entry when it is a tab', () => {
    for (const t of TABS) expect(activeTab(t)).toBe(t)
  })
  it('is none for Archived and Settings', () => {
    expect(activeTab('archived')).toBeNull()
    expect(activeTab('settings')).toBeNull()
  })
})

describe('tabTap', () => {
  it('goes to another section', () => {
    expect(tabTap('inbox', 'agents')).toBe('go')
    expect(tabTap('agents', null)).toBe('go')
  })
  it('opens the list of the open section that has one', () => {
    expect(tabTap('agents', 'agents')).toBe('list')
    expect(tabTap('routines', 'routines')).toBe('list')
    expect(tabTap('workflows', 'workflows')).toBe('list')
  })
  it('does nothing on the open Inbox or To-dos', () => {
    expect(tabTap('inbox', 'inbox')).toBe('none')
    expect(tabTap('todos', 'todos')).toBe('none')
  })
})

describe('TAB_LABELS', () => {
  it('names every tab in one or two short words', () => {
    for (const t of TABS) expect(TAB_LABELS[t].length).toBeLessThanOrEqual(10)
  })
})
