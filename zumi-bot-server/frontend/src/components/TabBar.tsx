import { activeTab, TAB_LABELS, TABS, tabTap, type TabEntry } from '../state/tabBar'
import { RailGlyph } from './Rail'

interface Props {
  /** The rail's entry (see App's railActive): the tab that matches it reads as open. */
  railActive: string
  agentsPending: boolean
  agentsUnread: boolean
  routinesWaiting: boolean
  workflowsWaiting: boolean
  inboxBadge: string | null
  inboxNew: boolean
  todosBadge: string | null
  onGo: (tab: TabEntry) => void
  /** The open section tapped again: its list, in the drawer. */
  onList: () => void
}

/**
 * The bottom tab bar on a small screen: Agents, Inbox, To-dos, Routines and Workflows, each with its label and the
 * rail's own marks. The drawer keeps the rail for the rest (Go to, Archived, Usage, Settings) and each section's list.
 */
export function TabBar(p: Props) {
  const active = activeTab(p.railActive)
  const unreadShown = p.agentsUnread && active !== 'agents'
  // The marks are drawn, so each tab's name carries what they say, as the rail's do.
  const status: Record<TabEntry, string | undefined> = {
    agents: p.agentsPending ? 'approval needed' : unreadShown ? 'unread chats' : undefined,
    inbox: p.inboxBadge != null ? `${p.inboxBadge} waiting` : p.inboxNew ? 'new messages' : undefined,
    todos: p.todosBadge != null ? `${p.todosBadge} open` : undefined,
    routines: p.routinesWaiting ? 'waiting for approval' : undefined,
    workflows: p.workflowsWaiting ? 'waiting on you' : undefined
  }
  const mark = (tab: TabEntry) => {
    if (tab === 'agents')
      return p.agentsPending ? <span className="approval-badge compact tab-dot" /> : unreadShown && <span className="mode-unread tab-dot" />
    if (tab === 'inbox')
      return p.inboxBadge != null ? (
        <span className="tab-count" data-testid="tab-inbox-count">
          {p.inboxBadge}
        </span>
      ) : (
        p.inboxNew && <span className="mode-unread tab-dot" />
      )
    if (tab === 'todos')
      return (
        p.todosBadge != null && (
          <span className="tab-count" data-testid="tab-todos-count">
            {p.todosBadge}
          </span>
        )
      )
    return status[tab] !== undefined && <span className="mode-waiting tab-dot" />
  }
  return (
    <nav className="tab-bar" data-testid="tab-bar" aria-label="Sections">
      {TABS.map((tab) => {
        const name = status[tab] ? `${TAB_LABELS[tab]}, ${status[tab]}` : TAB_LABELS[tab]
        return (
          <button
            key={tab}
            type="button"
            className="tab"
            data-testid={`tab-${tab}`}
            aria-label={name}
            aria-current={tab === active ? 'page' : undefined}
            onClick={() => {
              const what = tabTap(tab, active)
              if (what === 'go') p.onGo(tab)
              else if (what === 'list') p.onList()
            }}
          >
            <span className="tab-icon">
              <RailGlyph name={tab} className="tab-glyph" />
              {mark(tab)}
            </span>
            <span className="tab-label" aria-hidden="true">
              {TAB_LABELS[tab]}
            </span>
          </button>
        )
      })}
    </nav>
  )
}
