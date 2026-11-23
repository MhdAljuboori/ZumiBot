import { useContext } from 'react'
import type { CardAsk } from '@zumibot/shared/todos'
import { cardAskView } from '../state/cardAsk'
import { plainClick } from '../state/appLink'
import { AppLink } from './AppLink'
import { AppLinkContext } from './Markdown'
import { TodoCardEnvContext } from './TodoCard'

/**
 * The task card a comment was written on, over the comment's bubble in the agent's chat. It reads the board from the
 * app when it has it (live title and status); in a view with none (the compact popup chat) it shows the stored title.
 */
export function CardAskCard({ ask }: { ask: CardAsk }) {
  const env = useContext(TodoCardEnvContext)
  // The island popup opens links in the main window (AppLinkContext); AppLink would move the popup's own address.
  const openApp = useContext(AppLinkContext)
  const view = cardAskView(ask, { board: env?.board, chats: env?.chats ?? [], approvals: env?.approvals ?? {} })
  return (
    <div className="card-ask" data-testid="card-ask" {...(view.column ? { 'data-col': view.column } : {})}>
      <div className="card-ask-meta">
        <svg
          className="glyph"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M8 9h8M8 13h8M8 17h4" />
        </svg>
        <span>Task card</span>
        {view.status !== null && (
          <span className="card-ask-status" data-testid="card-ask-status">
            {view.status}
          </span>
        )}
        {view.removed && (
          <span className="card-ask-status removed" data-testid="card-ask-removed">
            Card removed
          </span>
        )}
        {openApp ? (
          <a
            href={view.path}
            className="card-ask-open"
            data-testid="card-ask-open"
            onClick={(e) => {
              if (!plainClick(e)) return
              e.preventDefault()
              openApp(view.path)
            }}
          >
            Open card <span aria-hidden="true">→</span>
          </a>
        ) : (
          <AppLink href={view.path} className="card-ask-open" testId="card-ask-open">
            Open card <span aria-hidden="true">→</span>
          </AppLink>
        )}
      </div>
      <div className="card-ask-title" data-testid="card-ask-title">
        {view.title}
      </div>
    </div>
  )
}
