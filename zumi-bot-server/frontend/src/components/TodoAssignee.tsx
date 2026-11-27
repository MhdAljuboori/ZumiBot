import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { displayName } from '@zumibot/shared/frontmatter'
import type { TodoItem } from '@zumibot/shared/todos'
import type { AgentSummary } from '@zumibot/shared/types'
import { assigneeLabel } from '../state/todoBoard'
import { givableAgents } from '../state/todoCard'
import { useAnchoredMenu } from '../useAnchoredMenu'
import { MenuIcon } from './MenuIcon'
import { MenuSearch } from './MenuSearch'

/**
 * The assignee pill as a menu: Nobody, you, or an agent, picked in place on a board card or grid row. `onPick` gets
 * the new assignee (null: nobody); picking the current one does nothing. `children` replaces the pill (the drawer shows
 * the face and name), and then `buttonTestId` names the button. `bare` drops the caret and the pill's styling, for a
 * button that is only its children (the board card's footer avatar).
 */
export function AssigneeMenu({
  item,
  agents,
  testId,
  buttonTestId,
  disabled = false,
  bare = false,
  children,
  onPick
}: {
  item: TodoItem
  agents: AgentSummary[]
  testId?: string
  buttonTestId?: string
  disabled?: boolean
  bare?: boolean
  children?: ReactNode
  onPick: (assignee: string | null) => void
}) {
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  // Portalled and placed as the Status picker's menu is, so the drawer's scrolling body cannot clip it.
  const { place, open, close } = useAnchoredMenu(button, menu)
  const pick = (who: string | null): void => {
    close(true)
    if (who !== (item.assignee ?? null)) onPick(who)
  }
  const options: { who: string | null; label: string }[] = [
    { who: null, label: 'Nobody' },
    { who: 'user', label: 'You' },
    ...givableAgents(agents).map((a) => ({ who: a.name, label: displayName(a.name) }))
  ]
  const pill = item.assignee ? (item.assignee === 'user' ? 'board-pill you' : 'board-pill agent') : 'board-pill nobody'
  return (
    <div className="assignee-menu">
      <button
        ref={button}
        type="button"
        className={bare ? 'assignee-menu-button bare' : children ? 'assignee-menu-button big' : 'assignee-menu-button'}
        data-testid={buttonTestId ?? `${testId}-button`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={place !== null}
        data-tip="Change assignee"
        // A press on the pill must not start dragging the card under it.
        draggable={false}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          if (place) close()
          else open()
        }}
      >
        {children ?? (
          <span className={pill} data-testid={testId}>
            {item.assignee ? assigneeLabel(item.assignee) : 'unassigned'}
          </span>
        )}
        {!bare && (
          <svg className="assignee-menu-caret" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2.5 4 5 6.5 7.5 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>
      {place &&
        createPortal(
          <div
            ref={menu}
            className="menu picker-menu search-select-menu assignee-menu-list"
            role="menu"
            data-testid="assignee-menu"
            style={{ left: place.left, top: place.top, bottom: place.bottom, minWidth: place.minWidth, maxHeight: place.maxHeight }}
            // React events still bubble to the card or row the button sits in, which would open its drawer or drag it.
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <MenuSearch />
            {options.map((o) => {
              const on = o.who === (item.assignee ?? null)
              return (
                <button
                  key={o.who ?? ''}
                  type="button"
                  role="menuitemradio"
                  aria-checked={on}
                  data-testid="assignee-menu-item"
                  data-who={o.who ?? ''}
                  onClick={() => pick(o.who)}
                >
                  <span className="menu-text">{o.label}</span>
                  {on && <MenuIcon name="check" className="menu-icon menu-current" />}
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </div>
  )
}
