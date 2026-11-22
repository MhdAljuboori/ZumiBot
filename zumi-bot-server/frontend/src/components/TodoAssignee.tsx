import { useEffect, useRef, useState, type ReactNode } from 'react'
import { displayName } from '@zumibot/shared/frontmatter'
import type { TodoItem } from '@zumibot/shared/todos'
import type { AgentSummary } from '@zumibot/shared/types'
import { assigneeLabel } from '../state/todoBoard'
import { givableAgents } from '../state/todoCard'
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
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  // Closes on a click elsewhere or Esc, as the card's Move to menu does.
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', esc, true)
    }
  }, [open])
  const pick = (who: string | null): void => {
    setOpen(false)
    if (who !== (item.assignee ?? null)) onPick(who)
  }
  const options: { who: string | null; label: string }[] = [
    { who: null, label: 'Nobody' },
    { who: 'user', label: 'You' },
    ...givableAgents(agents).map((a) => ({ who: a.name, label: displayName(a.name) }))
  ]
  const pill = item.assignee ? (item.assignee === 'user' ? 'board-pill you' : 'board-pill agent') : 'board-pill nobody'
  return (
    <div className="assignee-menu" ref={ref}>
      <button
        type="button"
        className={bare ? 'assignee-menu-button bare' : children ? 'assignee-menu-button big' : 'assignee-menu-button'}
        data-testid={buttonTestId ?? `${testId}-button`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip="Change assignee"
        // A press on the pill must not start dragging the card under it.
        draggable={false}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
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
      {open && (
        <div className="board-menu assignee-menu-list" role="menu" data-testid="assignee-menu" onMouseDown={(e) => e.stopPropagation()}>
          <MenuSearch />
          {options.map((o) => (
            <button
              key={o.who ?? ''}
              type="button"
              role="menuitemradio"
              aria-checked={o.who === (item.assignee ?? null)}
              data-testid="assignee-menu-item"
              data-who={o.who ?? ''}
              onClick={(e) => {
                e.stopPropagation()
                pick(o.who)
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
