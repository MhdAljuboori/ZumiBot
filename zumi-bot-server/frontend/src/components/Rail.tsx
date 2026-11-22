import type { ReactNode } from 'react'
import type { ClaudeAccount } from '@zumibot/shared/types'
import { AccountMenu } from './AccountMenu'
import { BotIcon } from './BotIcon'
import { MenuIcon } from './MenuIcon'
import { isMac } from './WorkflowMenu'

export type RailEntry = 'agents' | 'routines' | 'workflows' | 'inbox' | 'todos' | 'archived' | 'settings'

const ICON = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true
} as const

const GLYPHS = {
  agents: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 7V4M9 12v1M15 12v1" />
    </>
  ),
  routines: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
      <path d="M6.5 10v3a4 4 0 0 0 4 4H14" />
    </>
  ),
  workflows: (
    <>
      <circle cx="5" cy="6" r="2" />
      <circle cx="19" cy="12" r="2" />
      <circle cx="5" cy="18" r="2" />
      <path d="M7 6h3a4 4 0 0 1 4 4v0.5M7 18h3a4 4 0 0 0 4-4v-0.5M14 12h3" />
    </>
  ),
  inbox: (
    <>
      <path d="M6 9a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
      <path d="M10.3 20a2 2 0 0 0 3.4 0" />
    </>
  ),
  todos: (
    <>
      <path d="m4 6 1.6 1.6L8.5 4.5M4 13l1.6 1.6 2.9-3.1M4 20l1.6 1.6 2.9-3.1" />
      <path d="M12 6h8M12 13h8M12 20h8" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  )
} as const

export type RailGlyphName = keyof typeof GLYPHS

/** The rail's own icons, also drawn by the Ctrl+K palette. */
export function RailGlyph({ name, className = 'rail-icon' }: { name: RailGlyphName; className?: string }) {
  return (
    <svg className={className} {...ICON}>
      {GLYPHS[name]}
    </svg>
  )
}

const Glyph = RailGlyph

interface Props {
  active: RailEntry
  /** The drawer is out (small screens only; the rail is always there otherwise). */
  open: boolean
  /** Some chat waits on an approval (badge on Agents). */
  agentsPending: boolean
  /** Some chat holds a reply the user has not seen (dot on Agents, shown while it is not the open entry). */
  agentsUnread: boolean
  /** A routine run waits on an approval (dot on Routines). */
  routinesWaiting: boolean
  /** A workflow run waits on the user (dot on Workflows). */
  workflowsWaiting: boolean
  /** How many things wait on the user in the Inbox, or null for none (the number wins the slot over the dot). */
  inboxBadge: string | null
  /** A message in the Inbox the user has not seen. */
  inboxNew: boolean
  /** The open to-do count, or null for none. */
  todosBadge: string | null
  account: ClaudeAccount | null
  // undefined until the first claude status check resolves
  claudeFound: boolean | undefined
  onAccountOpen: () => void
  /** The logo: the root, Agents' new-chat screen. */
  onHome: () => void
  onAgents: () => void
  onRoutines: () => void
  onWorkflows: () => void
  onInbox: () => void
  onTodos: () => void
  onArchived: () => void
  onSettings: () => void
  onUsageDetails: () => void
  /** Opens the Ctrl+K palette. */
  onPalette: () => void
}

// The dots and the count are drawn, so the button's name carries what they say: a label replaces its contents for a screen reader.
function Item(p: {
  entry: RailEntry
  active: RailEntry
  label: string
  status?: string
  testId: string
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  const on = p.active === p.entry
  const name = p.status ? `${p.label}, ${p.status}` : p.label
  return (
    <button
      type="button"
      className="rail-btn"
      data-testid={p.testId}
      aria-label={name}
      data-tip={name}
      aria-pressed={p.pressed ? on : undefined}
      aria-current={on ? 'page' : undefined}
      onClick={p.onClick}
    >
      {p.children}
    </button>
  )
}

/** The icon column at the window's left edge: the views, then Usage and Settings at the bottom. */
export function Rail(p: Props) {
  const unreadShown = p.agentsUnread && p.active !== 'agents'
  const agentsStatus = p.agentsPending ? 'approval needed' : unreadShown ? 'unread chats' : undefined
  return (
    <nav className={p.open ? 'rail open' : 'rail'} data-testid="rail" aria-label="Main">
      {/* Zumi Bot's Z, drawn like its agent icon so it follows the theme; the PNG app icons are made from the same Z. */}
      <button type="button" className="rail-logo" data-testid="rail-home" aria-label="Home" data-tip="Home" onClick={p.onHome}>
        <BotIcon icon={null} color={null} builtIn working={false} size={36} />
      </button>
      <button
        type="button"
        className="rail-btn"
        data-testid="rail-palette"
        aria-label="Go to"
        aria-keyshortcuts="Control+K Meta+K"
        data-tip={`Go to… (${isMac() ? '⌘K' : 'Ctrl+K'})`}
        onClick={p.onPalette}
      >
        <Glyph name="search" />
      </button>
      <Item
        entry="inbox"
        active={p.active}
        label="Inbox"
        status={p.inboxBadge != null ? `${p.inboxBadge} waiting` : p.inboxNew ? 'new messages' : undefined}
        testId="rail-inbox"
        onClick={p.onInbox}
      >
        <Glyph name="inbox" />
        {p.inboxBadge != null ? (
          <span className="rail-count" data-testid="rail-inbox-count">
            {p.inboxBadge}
          </span>
        ) : (
          p.inboxNew && <span className="mode-unread rail-dot" data-testid="rail-inbox-new" />
        )}
      </Item>
      <Item entry="agents" active={p.active} label="Agents" status={agentsStatus} testId="mode-tab-agents" pressed onClick={p.onAgents}>
        <Glyph name="agents" />
        {p.agentsPending ? (
          <span className="approval-badge compact rail-dot" data-testid="rail-agents-approval" />
        ) : (
          unreadShown && <span className="mode-unread rail-dot" data-testid="mode-unread" />
        )}
      </Item>
      <Item
        entry="routines"
        active={p.active}
        label="Routines"
        status={p.routinesWaiting ? 'waiting for approval' : undefined}
        testId="mode-tab-routines"
        pressed
        onClick={p.onRoutines}
      >
        <Glyph name="routines" />
        {p.routinesWaiting && <span className="mode-waiting rail-dot" data-testid="mode-waiting" />}
      </Item>
      <Item
        entry="workflows"
        active={p.active}
        label="Workflows"
        status={p.workflowsWaiting ? 'waiting on you' : undefined}
        testId="mode-tab-workflows"
        pressed
        onClick={p.onWorkflows}
      >
        <Glyph name="workflows" />
        {p.workflowsWaiting && <span className="mode-waiting rail-dot" data-testid="workflows-waiting" />}
      </Item>
      <Item
        entry="todos"
        active={p.active}
        label="To-dos"
        status={p.todosBadge != null ? `${p.todosBadge} open` : undefined}
        testId="rail-todos"
        onClick={p.onTodos}
      >
        <Glyph name="todos" />
        {p.todosBadge != null && (
          <span className="rail-count" data-testid="rail-todos-count">
            {p.todosBadge}
          </span>
        )}
      </Item>
      <Item entry="archived" active={p.active} label="Archived" testId="archived-open" onClick={p.onArchived}>
        <MenuIcon name="archive" />
      </Item>
      <span className="rail-spacer" />
      <AccountMenu account={p.account} claudeFound={p.claudeFound} onOpen={p.onAccountOpen} onUsageDetails={p.onUsageDetails} />
      <Item entry="settings" active={p.active} label="Settings" testId="settings-open" onClick={p.onSettings}>
        <MenuIcon name="settings" />
      </Item>
    </nav>
  )
}
