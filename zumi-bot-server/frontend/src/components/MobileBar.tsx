import type { ReactNode, Ref } from 'react'

interface Props {
  title: string
  /** Drawn before the title: the open chat's agent or members. */
  icon?: ReactNode
  navOpen: boolean
  /** A chat other than the open one waits on an approval. */
  pending: boolean
  /** A chat other than the open one holds a reply the user has not seen. */
  unread: boolean
  onOpenNav: () => void
  toggleRef: Ref<HTMLButtonElement>
  /** Drawn after the title: the open chat's side panel toggle, kept on this line instead of a row of its own. */
  action?: ReactNode
  /** Opens the voice conversation page; absent while voice talk is off or this browser cannot record. */
  onTalk?: () => void
}

/** The bar over the main area on a small screen, where the sidebar is a drawer: its toggle and what is open. */
export function MobileBar({ title, icon, navOpen, pending, unread, onOpenNav, toggleRef, action, onTalk }: Props) {
  return (
    <header className="mobile-bar" data-testid="mobile-bar">
      <button
        ref={toggleRef}
        type="button"
        className="head-btn nav-toggle"
        data-testid="nav-toggle"
        aria-label="Open sidebar"
        aria-controls="sidebar"
        aria-expanded={navOpen}
        onClick={onOpenNav}
      >
        <svg
          className="glyph"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
        </svg>
        {pending && (
          <span
            className="approval-badge compact nav-badge"
            role="status"
            aria-label="Approval needed in another chat"
            data-testid="nav-approval-badge"
          />
        )}
        {!pending && unread && (
          <span className="unread-dot nav-badge" role="status" aria-label="Unread messages in another chat" data-testid="nav-unread-dot" />
        )}
      </button>
      {icon}
      <h1 className="mobile-bar-title">{title}</h1>
      {onTalk && (
        <button
          type="button"
          className="head-btn talk-btn"
          data-testid="talk-button"
          aria-label="Talk to an agent"
          data-tip="Talk to an agent"
          onClick={onTalk}
        >
          <svg
            className="glyph"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" />
            <path d="M3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25v2" />
          </svg>
        </button>
      )}
      {action}
    </header>
  )
}
