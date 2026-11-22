import { useEffect, useMemo, useRef, useState } from 'react'
import { TODO_STATUSES, unanswered, type TodoBoard, type TodoItem, type TodoStatus } from '@zumibot/shared/todos'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { COLUMN_LABEL, assigneeLabel, creatorLabel, filterActive, matchesFilter, type BoardFilter } from '../state/todoBoard'
import { STATE_LABEL, cardState, statusTone } from '../state/todoCard'
import { gridRows, nextSort, selectedRows, selectionState, toggleAll, toggleSelected, type GridKey, type GridSort } from '../state/todoGrid'
import { plainTodoText } from '../state/todoLine'
import { ageLabel, isOld } from '../state/todosPage'
import { AssigneeMenu } from './TodoAssignee'
import { TodoHints } from './TodoCard'
import { Markdown } from './Markdown'
import { SearchSelect } from './SearchSelect'

const COLUMNS: { key: GridKey; label: string; className?: string }[] = [
  { key: 'status', label: 'Status', className: 'grid-status' },
  { key: 'title', label: 'Title', className: 'grid-title' },
  { key: 'assignee', label: 'Assignee' },
  { key: 'creator', label: 'Creator' },
  { key: 'created', label: 'Created' },
  { key: 'updated', label: 'Updated' }
]

const SortIcon = ({ dir }: { dir: 'asc' | 'desc' | null }) => (
  <svg className="grid-sort-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M5 6.5L8 3.5l3 3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={dir === 'desc' ? 0.3 : 1}
    />
    <path
      d="M5 9.5l3 3 3-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      opacity={dir === 'asc' ? 0.3 : 1}
    />
  </svg>
)

/** The head's box: all, none, or the dash while only some shown rows are checked (`indeterminate` has no attribute). */
function SelectAllBox({ state, onToggle }: { state: 'none' | 'some' | 'all'; onToggle: () => void }) {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some'
  }, [state])
  return (
    <input
      ref={ref}
      type="checkbox"
      className="grid-check"
      data-testid="grid-select-all"
      aria-label="Select all shown tasks"
      checked={state === 'all'}
      onChange={onToggle}
    />
  )
}

/**
 * The To-dos page as one table: a row per card (open, then the done ones the board loaded), sorted by a click on a
 * column's head. A row opens the card's drawer; its Status picker moves the card as a drop on the board would. Each row
 * has a box to pick it; the bar over the table removes every picked card shown at once, with the page's Undo.
 */
export function TodoGrid({
  board,
  agents,
  chats,
  approvals,
  filter,
  showDone,
  onShowDone,
  sort,
  onSort,
  onClearFilter,
  openId,
  now,
  onOpen,
  onMove,
  onAssign,
  onRemove
}: {
  board: TodoBoard
  agents: AgentSummary[]
  chats: ChatMeta[]
  approvals: Record<string, number>
  filter: BoardFilter
  showDone: boolean
  openId: string | null
  now: number
  onShowDone: (on: boolean) => void
  onClearFilter: () => void
  /** The table's sort, held by the board so the drawer steps through rows in this order. */
  sort: GridSort
  onSort: (sort: GridSort) => void
  onOpen: (id: string) => void
  onMove: (item: TodoItem, from: TodoStatus, to: TodoStatus) => void
  onAssign: (item: TodoItem, who: string | null) => void
  onRemove: (ids: string[]) => void
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const rows = useMemo(() => gridRows(board, chats, approvals, filter, sort, showDone), [board, chats, approvals, filter, sort, showDone])
  // Only picked rows still shown count: a filter or another tab's removal never takes a card the user cannot see.
  const picked = useMemo(() => selectedRows(rows, selected), [rows, selected])
  const pickState = selectionState(rows, selected)
  const clear = (): void => setSelected(new Set())
  // Esc drops the picks, unless the drawer is open: there Esc closes the drawer first.
  useEffect(() => {
    if (picked.length === 0 || openId !== null) return
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) clear()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [picked.length, openId])
  const removePicked = (): void => {
    onRemove(picked.map((r) => r.item.id))
    clear()
  }
  const filtering = filterActive(filter)
  // Hidden completed cards the filter would show: every done one (also those not loaded) when nothing filters.
  const hidden = showDone ? 0 : filtering ? board.done.filter((i) => matchesFilter(i, filter)).length : board.doneTotal
  const older = showDone && !filtering ? board.doneTotal - board.done.length : 0
  return (
    <>
      {picked.length > 0 && (
        <div className="grid-selbar" role="toolbar" aria-label="Selected tasks" data-testid="grid-selbar">
          <span className="grid-selbar-count" data-testid="grid-sel-count">
            {picked.length === 1 ? '1 selected' : `${picked.length} selected`}
          </span>
          <button type="button" className="inbox-link" data-testid="grid-sel-clear" onClick={clear}>
            Clear
          </button>
          <span className="grow" />
          <button type="button" className="btn small board-drawer-remove" data-testid="grid-sel-delete" onClick={removePicked}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2c.05.7.6 1.3 1.3 1.3h3.2c.7 0 1.25-.6 1.3-1.3l.6-8.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {picked.length === 1 ? 'Delete' : `Delete ${picked.length}`}
          </button>
        </div>
      )}
      <div className="todo-grid-wrap" data-testid="todo-grid">
        <table className="todo-grid">
          <thead>
            <tr>
              <th scope="col" className="grid-pick">
                <SelectAllBox state={pickState} onToggle={() => setSelected((s) => toggleAll(rows, s))} />
              </th>
              {COLUMNS.map((c) => {
                const on = sort.key === c.key
                return (
                  <th
                    key={c.key}
                    scope="col"
                    className={c.className}
                    aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button
                      type="button"
                      className={on ? 'grid-sort on' : 'grid-sort'}
                      data-testid="grid-sort"
                      data-key={c.key}
                      onClick={() => onSort(nextSort(sort, c.key))}
                    >
                      {c.label}
                      <SortIcon dir={on ? sort.dir : null} />
                    </button>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ item, col }) => {
              const state = cardState(item, chats, approvals)
              const questions = item.done === null ? unanswered(item).length : 0
              const title = plainTodoText(item.text)
              const on = selected.has(item.id)
              return (
                <tr
                  key={item.id}
                  className={[openId === item.id ? 'open' : '', on ? 'picked' : ''].filter(Boolean).join(' ') || undefined}
                  aria-selected={on}
                  data-testid="grid-row"
                  data-todo-id={item.id}
                  data-col={col}
                  // The whole row opens the card, but not a click on its own controls.
                  onClick={(e) => {
                    if (!(e.target as HTMLElement).closest('button, select, a, input, label')) onOpen(item.id)
                  }}
                >
                  <td className="grid-pick">
                    <input
                      type="checkbox"
                      className="grid-check"
                      data-testid="grid-select"
                      aria-label={`Select ${title}`}
                      checked={on}
                      onChange={() => setSelected((s) => toggleSelected(s, item.id))}
                    />
                  </td>
                  <td className="grid-status">
                    <span className="grid-status-cell">
                      <span className="todo-card-status-wrap" data-col={col}>
                        <SearchSelect
                          className="field todo-card-status-select"
                          data-testid="grid-status-select"
                          value={col}
                          aria-label={`Status of ${title}`}
                          onChange={(v) => onMove(item, col, v as TodoStatus)}
                        >
                          {TODO_STATUSES.map((s) => (
                            <option key={s} value={s}>
                              {COLUMN_LABEL[s]}
                            </option>
                          ))}
                        </SearchSelect>
                      </span>
                      {state && (
                        <span className={`todo-status ${statusTone(state)}`} data-testid="grid-state">
                          {STATE_LABEL[state]}
                        </span>
                      )}
                      {questions > 0 && (
                        <span className="todo-status you" data-testid="grid-questions">
                          {questions === 1 ? '1 question' : `${questions} questions`}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="grid-title">
                    {/* Not a <button>, so the title's links are clickable; the row's click opens the card. */}
                    <div
                      role="button"
                      tabIndex={0}
                      className="grid-open"
                      data-testid="grid-open"
                      onKeyDown={(e) => {
                        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                          e.preventDefault()
                          onOpen(item.id)
                        }
                      }}
                    >
                      <span className="grid-open-text">
                        <Markdown text={item.text} inline />
                      </span>
                      <TodoHints item={item} />
                    </div>
                  </td>
                  <td>
                    {item.done === null ? (
                      <AssigneeMenu item={item} agents={agents} testId="grid-assignee" onPick={(who) => onAssign(item, who)} />
                    ) : item.assignee ? (
                      <span className={item.assignee === 'user' ? 'board-pill you' : 'board-pill agent'} data-testid="grid-assignee">
                        {assigneeLabel(item.assignee)}
                      </span>
                    ) : (
                      <span className="board-pill nobody" data-testid="grid-assignee">
                        unassigned
                      </span>
                    )}
                  </td>
                  <td className="grid-muted" data-testid="grid-creator">
                    {creatorLabel(item.addedBy)}
                  </td>
                  <td className={isOld(item.from.at, now) && item.done === null ? 'grid-muted todo-age old' : 'grid-muted'}>
                    {ageLabel(item.from.at, now)}
                  </td>
                  <td className="grid-muted">{ageLabel(item.updatedAt, now)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="grid-empty" data-testid="grid-empty">
            {filtering ? (
              <>
                No tasks match these filters.{' '}
                <button type="button" className="inbox-link" onClick={onClearFilter}>
                  Clear filters
                </button>
              </>
            ) : showDone || hidden === 0 ? (
              'No tasks yet. Add one above.'
            ) : (
              'Nothing open.'
            )}
          </div>
        )}
        {hidden > 0 && (
          <p className="grid-foot" data-testid="grid-done-hidden">
            {hidden === 1 ? '1 completed task hidden' : `${hidden} completed tasks hidden`} ·{' '}
            <button type="button" className="inbox-link" data-testid="grid-done-show" onClick={() => onShowDone(true)}>
              Show
            </button>
          </p>
        )}
        {older > 0 && (
          <p className="grid-foot" data-testid="grid-done-more">
            {older} older done not shown
          </p>
        )}
      </div>
    </>
  )
}
