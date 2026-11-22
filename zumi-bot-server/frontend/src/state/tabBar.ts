// The phone's tab bar: the main sections one tap away at the bottom of the screen, where the drawer's rail took two.

export type TabEntry = 'agents' | 'inbox' | 'todos' | 'routines' | 'workflows'

export const TABS: readonly TabEntry[] = ['agents', 'inbox', 'todos', 'routines', 'workflows']

export const TAB_LABELS: Record<TabEntry, string> = {
  agents: 'Agents',
  inbox: 'Inbox',
  todos: 'To-dos',
  routines: 'Routines',
  workflows: 'Workflows'
}

// Sections whose list (agents and chats, routines, workflows) lives in the drawer; the Inbox and To-dos have none.
const LISTED: ReadonlySet<TabEntry> = new Set(['agents', 'routines', 'workflows'])

/** The tab that reads as open, from the rail's entry: Archived and Settings are no tab, so none is. */
export function activeTab(railActive: string): TabEntry | null {
  return (TABS as readonly string[]).includes(railActive) ? (railActive as TabEntry) : null
}

/**
 * What a tap does: another section opens; the open one, tapped again, opens its list in the drawer (a phone shows the
 * open chat, routine or workflow, and its list is one step back), or does nothing when it has none.
 */
export function tabTap(tab: TabEntry, active: TabEntry | null): 'go' | 'list' | 'none' {
  if (tab !== active) return 'go'
  return LISTED.has(tab) ? 'list' : 'none'
}
