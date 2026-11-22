import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from 'react'
import { TODO_STATUSES, unanswered, type TodoBoard as Board, type TodoItem, type TodoStatus } from '@zumibot/shared/todos'
import type { AgentSummary, ChatMeta } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import { agentInk } from '../state/bot'
import {
  COLLAPSED_KEY,
  COLUMN_LABEL,
  DRAWER_EXPANDED_KEY,
  NO_FILTER,
  assigneeLabel,
  avatarInitials,
  boardAssignees,
  boardColumns,
  boardCreators,
  cardNeighbors,
  cardStepKey,
  columnOf,
  creatorLabel,
  dropAction,
  filterActive,
  filterCount,
  kanbanOrder,
  parseCollapsed,
  toggleCollapsed,
  type BoardFilter,
  type CardNeighbors
} from '../state/todoBoard'
import { STATE_LABEL, cardState, quickFolder, statusTone } from '../state/todoCard'
import { ageLabel, isOld } from '../state/todosPage'
import { GRID_SORT, SHOW_DONE_KEY, gridRows, type GridSort, type TodoView } from '../state/todoGrid'
import { Markdown } from './Markdown'
import { todosPath } from '../state/route'
import { AssigneeMenu } from './TodoAssignee'
import { TodoCard, TodoCardEnvContext, TodoHints, TodoListContext } from './TodoCard'
import { TodoFilters } from './TodoFilters'
import { TodoGrid } from './TodoGrid'
import { TodoAddForm, TodoUndoToast, useTodoActions } from './TodoParts'

// Per device; storage can be blocked or throw, and the board works without it.
function loadCollapsed(): TodoStatus[] {
  try {
    return parseCollapsed(localStorage.getItem(COLLAPSED_KEY))
  } catch {
    return []
  }
}
function saveCollapsed(list: TodoStatus[]): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(list))
  } catch {
    /* not remembered */
  }
}
// The drawer's size (expanded: the card left, its comments right) is per device too.
function loadExpanded(): boolean {
  try {
    return localStorage.getItem(DRAWER_EXPANDED_KEY) === '1'
  } catch {
    return false
  }
}
function saveExpanded(on: boolean): void {
  try {
    localStorage.setItem(DRAWER_EXPANDED_KEY, on ? '1' : '0')
  } catch {
    /* not remembered */
  }
}
// The grid hides completed cards until asked; the choice is per device.
function loadShowDone(): boolean {
  try {
    return localStorage.getItem(SHOW_DONE_KEY) === '1'
  } catch {
    return false
  }
}
function saveShowDone(on: boolean): void {
  try {
    localStorage.setItem(SHOW_DONE_KEY, on ? '1' : '0')
  } catch {
    /* not remembered */
  }
}

const VIEWS: { view: TodoView; label: string; icon: string }[] = [
  { view: 'kanban', label: 'Kanban', icon: 'M2.5 3h3v10h-3zM6.5 3h3v7h-3zM10.5 3h3v5h-3z' },
  { view: 'grid', label: 'Grid', icon: 'M2.5 3h11v10h-11zM2.5 6.5h11M2.5 9.75h11M6.5 3v10' }
]

const CollapseIcon = ({ open }: { open: boolean }) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path
      d={open ? 'M9.5 4L5.5 8l4 4' : 'M6.5 4l4 4-4 4'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

interface Props {
  /** null until the first answer. */
  board: Board | null
  agents: AgentSummary[]
  chats: ChatMeta[]
  approvals: Record<string, number>
  /** The card shown in the drawer (the address's `/todos/<id>`); null: none. */
  openId: string | null
  onOpen: (id: string | null) => void
  onRefresh: () => void
  now: number
  /** Kanban (the default each time the app starts) or Grid; held by the app, so it lasts while the page is left. */
  view: TodoView
  onView: (view: TodoView) => void
  /** Search, assignee and creator, for both views; held by the app with the view. */
  filter: BoardFilter
  onFilter: (filter: BoardFilter) => void
}

/**
 * The task board: every task, wherever it was made, as Kanban (a column per status) or Grid (one sortable table). A card is dragged (or moved with its menu or
 * its drawer's Status) to any column. To do starts its agent, New and Done stop it; one nobody is assigned asks who first.
 * A task chat's turns move its card on by themselves: In progress, then Blocked, In review or New.
 */
export function TodoBoard({ board, agents, chats, approvals, openId, onOpen, onRefresh, now, view, onView, filter, onFilter }: Props) {
  const actions = useTodoActions(null, onRefresh)
  const [showDone, setShowDone] = useState(loadShowDone)
  const showCompleted = (on: boolean): void => {
    setShowDone(on)
    saveShowDone(on)
  }
  const [error, setError] = useState<string | null>(null)
  // A card nobody has, dropped on To do or In progress: its drawer opens with the assignee picker up, then it moves.
  const [assigning, setAssigning] = useState<{ id: string; then: TodoStatus } | null>(null)
  const [drag, setDrag] = useState<{ id: string; from: TodoStatus } | null>(null)
  const [over, setOver] = useState<TodoStatus | null>(null)
  // Columns folded to a strip: still a place to drop on, with their count.
  const [collapsed, setCollapsed] = useState<TodoStatus[]>(loadCollapsed)
  const toggle = (col: TodoStatus): void => {
    setCollapsed((list) => {
      const next = toggleCollapsed(list, col)
      saveCollapsed(next)
      return next
    })
  }
  const cols = useMemo(() => (board ? boardColumns(board, chats, approvals, filter) : null), [board, chats, approvals, filter])
  const creators = useMemo(() => boardCreators(board), [board])
  const assignees = useMemo(() => boardAssignees(board), [board])
  const filtering = filterActive(filter)
  // A phone folds the filters behind the head's Filters button, so the board keeps the screen; they start open while
  // one is set (filters outlive the page), so a filtered board never hides why.
  const [toolsOpen, setToolsOpen] = useState(filtering)
  const filtersSet = filterCount(filter)
  const listEnv = useMemo(() => ({ chatId: null, onRefresh }), [onRefresh])
  const openItem = openId === null || !board ? null : ([...board.open, ...board.done].find((i) => i.id === openId) ?? null)
  // The grid's sort lives here, so the drawer steps through the rows in the order the table shows them.
  const [sort, setSort] = useState<GridSort>(GRID_SORT)
  const order = useMemo(() => {
    if (!board || !cols) return []
    return view === 'grid' ? gridRows(board, chats, approvals, filter, sort, showDone).map((r) => r.item.id) : kanbanOrder(cols)
  }, [board, cols, view, chats, approvals, filter, sort, showDone])
  const neighbors = cardNeighbors(order, openId)

  const run = async (what: () => Promise<unknown>): Promise<void> => {
    setError(null)
    try {
      await what()
    } catch (e) {
      setError(errorMessage(e))
    }
    onRefresh()
  }
  /** A card going to `to`: a move, or its drawer with the assignee picker when nobody has it and it should start. */
  const moveCard = (item: TodoItem, from: TodoStatus, to: TodoStatus): void => {
    const act = dropAction(item, from, to)
    if (!act) return
    if (act.kind === 'move') {
      void run(() => api.todos.move(item.id, act.to))
      return
    }
    setAssigning({ id: item.id, then: act.to })
    onOpen(item.id)
  }

  /** The assignee menu's pick: an agent gets the folder the drawer's picker would start at, without asking. */
  const assignCard = (item: TodoItem, who: string | null): void => {
    void run(async () => {
      let folder: string | null = null
      if (who !== null && who !== 'user') {
        folder = quickFolder(item, who, chats.find((c) => c.id === item.from.chatId) ?? null) ?? (await api.app.newChatFolder(who))
      }
      await api.todos.assign(item.id, who, folder)
    })
  }

  const onDragStart = (e: DragEvent, item: TodoItem, from: TodoStatus): void => {
    e.dataTransfer.setData('text/plain', item.id)
    e.dataTransfer.effectAllowed = 'move'
    setDrag({ id: item.id, from })
  }
  const end = (): void => {
    setDrag(null)
    setOver(null)
  }
  const dropOn =
    (to: TodoStatus) =>
    (e: DragEvent): void => {
      e.preventDefault()
      const d = drag
      end()
      const item = d && board ? [...board.open, ...board.done].find((i) => i.id === d.id) : undefined
      if (d && item) moveCard(item, d.from, to)
    }

  return (
    <TodoListContext.Provider value={listEnv}>
      <section className="todos-page board-page" data-testid="todo-board" aria-label="To-dos">
        <header className="todos-page-head board-head">
          <div className="todos-page-title">
            <h2>To-dos</h2>
            <span className="todos-page-who">Every task, wherever it was made</span>
          </div>
          {board && (
            <span className="count-badge todos-page-count" data-testid="board-open-count">
              {board.open.length} open
            </span>
          )}
          <span className="grow" />
          <div className="board-views" role="group" aria-label="View">
            {VIEWS.map((v) => (
              <button
                key={v.view}
                type="button"
                className={view === v.view ? 'board-view on' : 'board-view'}
                data-testid="board-view"
                data-view={v.view}
                aria-pressed={view === v.view}
                onClick={() => onView(v.view)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d={v.icon} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
                {v.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={toolsOpen ? 'board-tools-toggle on' : 'board-tools-toggle'}
            data-testid="board-tools-toggle"
            aria-expanded={toolsOpen}
            aria-controls="board-tools"
            onClick={() => setToolsOpen(!toolsOpen)}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2.5 3.5h11l-4.25 5v4l-2.5 1.25V8.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
            Filters
            {filtersSet > 0 && (
              <span className="board-tools-count" data-testid="board-tools-count">
                {filtersSet}
              </span>
            )}
          </button>
        </header>
        <div className="board-bar">
          <div className="board-add">
            <TodoAddForm actions={actions} primary />
          </div>
          <TodoFilters
            filter={filter}
            onFilter={onFilter}
            assignees={assignees}
            creators={creators}
            folded={!toolsOpen}
            {...(view === 'grid' ? { showDone, onShowDone: showCompleted } : {})}
          />
        </div>
        {(error || actions.error) && (
          <div className="side-error todo-error" role="alert" data-testid="board-error">
            {error ?? actions.error}
          </div>
        )}
        {cols === null || board === null ? (
          <div className="file-note" data-testid="board-loading">
            Loading…
          </div>
        ) : view === 'grid' ? (
          <TodoGrid
            board={board}
            chats={chats}
            approvals={approvals}
            filter={filter}
            showDone={showDone}
            onShowDone={showCompleted}
            sort={sort}
            onSort={setSort}
            onClearFilter={() => onFilter(NO_FILTER)}
            openId={openId}
            now={now}
            onOpen={(id) => {
              setAssigning(null)
              onOpen(id)
            }}
            onMove={moveCard}
            agents={agents}
            onAssign={assignCard}
            onRemove={(ids) => {
              if (openId !== null && ids.includes(openId)) onOpen(null)
              void actions.removeIds(ids)
            }}
          />
        ) : (
          <div className="board-columns" data-testid="board-columns">
            {TODO_STATUSES.map((col) => {
              const items = cols[col]
              const canDrop = drag !== null && drag.from !== col
              const folded = collapsed.includes(col)
              // Done counts every done card, also the older ones not loaded, unless a filter picks among them.
              const count = col === 'done' && board && !filtering ? board.doneTotal : items.length
              const cls = ['board-col', folded ? 'collapsed' : '', canDrop ? 'can-drop' : '', canDrop && over === col ? 'over' : '']
                .filter(Boolean)
                .join(' ')
              return (
                <section
                  key={col}
                  className={cls}
                  data-testid="board-col"
                  data-col={col}
                  data-collapsed={folded}
                  aria-label={COLUMN_LABEL[col]}
                  onDragOver={(e) => {
                    if (canDrop) {
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'move'
                      setOver(col)
                    }
                  }}
                  onDragLeave={() => setOver((o) => (o === col ? null : o))}
                  onDrop={dropOn(col)}
                >
                  {folded ? (
                    <button
                      type="button"
                      className="board-col-strip"
                      data-testid="board-col-expand"
                      aria-expanded={false}
                      aria-label={`Expand ${COLUMN_LABEL[col]}`}
                      data-tip={`Expand ${COLUMN_LABEL[col]}`}
                      onClick={() => toggle(col)}
                    >
                      <CollapseIcon open={false} />
                      <span className="board-col-dot" aria-hidden="true" />
                      <span className="count-badge" data-testid="board-col-count">
                        {count}
                      </span>
                      <span className="board-col-name">{COLUMN_LABEL[col]}</span>
                    </button>
                  ) : (
                    <>
                      <header className="board-col-head">
                        <span className="board-col-dot" aria-hidden="true" />
                        <h3>{COLUMN_LABEL[col]}</h3>
                        <span className="count-badge" data-testid="board-col-count">
                          {count}
                        </span>
                        <button
                          type="button"
                          className="icon-btn board-col-collapse"
                          data-testid="board-col-collapse"
                          aria-expanded={true}
                          aria-label={`Collapse ${COLUMN_LABEL[col]}`}
                          data-tip={`Collapse ${COLUMN_LABEL[col]}`}
                          onClick={() => toggle(col)}
                        >
                          <CollapseIcon open />
                        </button>
                      </header>
                      <div className="board-col-cards">
                        {items.map((item) => (
                          <BoardCard
                            key={item.id}
                            item={item}
                            col={col}
                            agents={agents}
                            chats={chats}
                            approvals={approvals}
                            now={now}
                            dragging={drag?.id === item.id}
                            open={openId === item.id}
                            onOpen={() => {
                              setAssigning(null)
                              onOpen(item.id)
                            }}
                            onRemove={() => {
                              if (openId === item.id) onOpen(null)
                              void actions.remove(item)
                            }}
                            onAssign={(who) => assignCard(item, who)}
                            onDragStart={(e) => onDragStart(e, item, col)}
                            onDragEnd={end}
                          />
                        ))}
                        {items.length === 0 && <p className="board-col-empty">{filtering ? 'No matches.' : EMPTY[col]}</p>}
                        {col === 'done' && board && !filtering && board.doneTotal > board.done.length && (
                          <p className="board-col-more" data-testid="board-done-more">
                            {board.doneTotal - board.done.length} older done
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </section>
              )
            })}
          </div>
        )}
        {/* The board dims under the drawer; a click there closes it, as Esc does. */}
        {openId !== null && (
          <div
            className="board-scrim"
            data-testid="board-scrim"
            aria-hidden="true"
            onClick={() => {
              setAssigning(null)
              onOpen(null)
            }}
          />
        )}
        {openId !== null && (
          <CardDrawer
            item={openItem}
            loaded={board !== null}
            assignThen={assigning?.id === openId ? assigning.then : null}
            neighbors={neighbors}
            onStep={(id) => {
              setAssigning(null)
              onOpen(id)
            }}
            onClose={() => {
              setAssigning(null)
              onOpen(null)
            }}
            onRemove={(item) => {
              void actions.remove(item)
              onOpen(null)
            }}
          />
        )}
        <TodoUndoToast actions={actions} />
      </section>
    </TodoListContext.Provider>
  )
}

const EMPTY: Record<TodoStatus, string> = {
  new: 'Nothing new.',
  todo: 'Nothing waits to start.',
  blocked: 'No agent is waiting on you.',
  progress: 'No agent is working.',
  review: 'Nothing to check.',
  done: '—'
}

// Field icons: 16px line drawings in the text colour, so dark mode follows.
const Icon = ({ d }: { d: string }) => (
  <svg className="board-field-icon" viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)
const ICON = {
  status: 'M5.5 2.5h5M5 2.5H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-10a1 1 0 0 0-1-1h-1M6 7h4M6 10h4',
  creator: 'M10.5 3 13 5.5 6 12.5H3.5V10L10.5 3ZM9 4.5 11.5 7',
  agent: 'M2 8h2.5l1.5-4 3 8 1.5-4H14',
  questions: 'M6 6a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5M8 12v.01'
}
const CalendarIcon = () => (
  <svg className="board-card-date-icon" viewBox="0 0 16 16" aria-hidden="true">
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.4" />
    <path d="M5.5 2v3M10.5 2v3M2.5 7h11" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
)

function Field({ icon, label, children }: { icon: keyof typeof ICON; label: string; children: ReactNode }) {
  return (
    <div className="board-field">
      <Icon d={ICON[icon]} />
      <span className="board-field-label">{label}</span>
      <span className="board-field-value">{children}</span>
    </div>
  )
}

function BoardCard({
  item,
  col,
  agents,
  chats,
  approvals,
  now,
  dragging,
  open,
  onOpen,
  onRemove,
  onAssign,
  onDragStart,
  onDragEnd
}: {
  item: TodoItem
  col: TodoStatus
  agents: AgentSummary[]
  chats: ChatMeta[]
  approvals: Record<string, number>
  now: number
  dragging: boolean
  open: boolean
  onOpen: () => void
  onRemove: () => void
  onAssign: (who: string | null) => void
  onDragStart: (e: DragEvent) => void
  onDragEnd: () => void
}) {
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // The menu closes on a click anywhere else, as a menu does.
  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menu])
  const state = cardState(item, chats, approvals)
  const questions = unanswered(item).length
  const assignedAgent = item.assignee && item.assignee !== 'user' ? agents.find((a) => a.name === item.assignee) : undefined
  const avatarTint =
    item.assignee === 'user' ? 'var(--accent)' : assignedAgent && assignedAgent.error === null ? agentInk(assignedAgent.color) : null
  const avatar = item.assignee ? (
    <span
      className="board-avatar"
      style={avatarTint ? { background: avatarTint } : undefined}
      data-tip={`Assignee: ${assigneeLabel(item.assignee)}`}
    >
      {avatarInitials(item.assignee)}
    </span>
  ) : (
    <span className="board-avatar nobody" data-tip="Unassigned" />
  )
  return (
    <article
      className={['board-card', dragging ? 'dragging' : '', open ? 'open' : ''].filter(Boolean).join(' ')}
      data-testid="board-card"
      data-todo-id={item.id}
      data-col={col}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="board-card-top">
        {/* Not a <button>: a title's links must be clickable, and a link cannot sit inside a button. */}
        <div
          role="button"
          tabIndex={0}
          className="board-card-open"
          data-testid="board-card-open"
          onClick={(e) => {
            if (!(e.target as HTMLElement).closest('a')) onOpen()
          }}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              onOpen()
            }
          }}
        >
          <Markdown text={item.text} inline />
          <TodoHints item={item} />
        </div>
        <div className="board-card-menu" ref={menuRef}>
          <button
            type="button"
            className="icon-btn"
            data-testid="board-card-menu"
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-label="Card actions"
            data-tip="Card actions"
            onClick={() => setMenu((m) => !m)}
          >
            ⋯
          </button>
          {menu && (
            <div className="board-menu" role="menu" data-testid="board-menu">
              <button
                type="button"
                role="menuitem"
                data-testid="board-menu-open"
                onClick={() => {
                  setMenu(false)
                  onOpen()
                }}
              >
                Open
              </button>
              <button
                type="button"
                role="menuitem"
                data-testid="board-menu-copy-link"
                onClick={() => {
                  setMenu(false)
                  void navigator.clipboard.writeText(new URL(todosPath(item.id), window.location.origin).href).catch(() => undefined)
                }}
              >
                Copy link
              </button>
              <button
                type="button"
                role="menuitem"
                className="danger"
                data-testid="board-menu-remove"
                onClick={() => {
                  setMenu(false)
                  onRemove()
                }}
              >
                Remove
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="board-card-fields">
        <Field icon="status" label="Status">
          <span className="board-tag status" data-col={col}>
            {COLUMN_LABEL[col]}
          </span>
        </Field>
        <Field icon="creator" label="Created by">
          <span className="board-card-by" data-testid="board-card-creator">
            {creatorLabel(item.addedBy)}
          </span>
        </Field>
        {state && (
          <Field icon="agent" label="Agent">
            <span className={`todo-status ${statusTone(state)}`} data-testid="board-card-state">
              {STATE_LABEL[state]}
            </span>
          </Field>
        )}
        {questions > 0 && item.done === null && (
          <Field icon="questions" label="Questions">
            <span className="todo-status you" data-testid="board-card-questions">
              {questions === 1 ? '1 question' : `${questions} questions`}
            </span>
          </Field>
        )}
      </div>
      <div className="board-card-foot">
        {item.done === null ? (
          <AssigneeMenu item={item} agents={agents} buttonTestId="board-card-assignee" bare onPick={onAssign}>
            {avatar}
          </AssigneeMenu>
        ) : (
          avatar
        )}
        <span className="board-card-sep" aria-hidden="true" />
        <span className={isOld(item.from.at, now) && item.done === null ? 'board-card-date old' : 'board-card-date'} data-tip="Created">
          <CalendarIcon />
          {ageLabel(item.from.at, now)}
        </span>
      </div>
    </article>
  )
}

function CardDrawer({
  item,
  loaded,
  assignThen,
  neighbors,
  onStep,
  onClose,
  onRemove
}: {
  item: TodoItem | null
  loaded: boolean
  assignThen: TodoStatus | null
  neighbors: CardNeighbors
  onStep: (id: string) => void
  onClose: () => void
  onRemove: (item: TodoItem) => void
}) {
  const ref = useRef<HTMLElement>(null)
  const [expanded, setExpanded] = useState(loadExpanded)
  const toggleExpanded = (): void => {
    setExpanded((on) => {
      saveExpanded(!on)
      return !on
    })
  }
  // Esc closes it, from anywhere in it.
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [onClose])
  // K and J step to the card before and after in the view's order, unless the user is typing.
  const { prev, next } = neighbors
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) return
      const dir = cardStepKey({
        key: e.key,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        target: e.target instanceof HTMLElement ? e.target : null
      })
      const to = dir === 'prev' ? prev : dir === 'next' ? next : null
      if (to === null) return
      e.preventDefault()
      onStep(to)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [prev, next, onStep])
  useEffect(() => {
    ref.current?.focus()
  }, [item?.id])
  const env = useContext(TodoCardEnvContext)
  const col = item && env ? columnOf(item, env.chats, env.approvals) : null
  // Two columns only where the CSS lays them out: expanded, on a window wide enough.
  const wideWindow = useWideWindow()
  const wide = expanded && wideWindow
  return (
    <aside
      className={expanded ? 'board-drawer expanded' : 'board-drawer'}
      data-testid="board-drawer"
      data-expanded={expanded}
      aria-label="To-do card"
      tabIndex={-1}
      ref={ref}
    >
      <header className="board-drawer-head">
        {neighbors.index >= 0 && neighbors.total > 1 && (
          <div className="board-drawer-nav" role="group" aria-label="Step through cards">
            <button
              type="button"
              className="board-drawer-step"
              data-testid="board-drawer-prev"
              aria-label="Previous card"
              data-tip="Previous card (← or K)"
              disabled={prev === null}
              onClick={() => {
                if (prev !== null) onStep(prev)
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M10 4l-4 4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <span className="board-drawer-pos" data-testid="board-drawer-pos">
              {neighbors.index + 1} of {neighbors.total}
            </span>
            <button
              type="button"
              className="board-drawer-step"
              data-testid="board-drawer-next"
              aria-label="Next card"
              data-tip="Next card (→ or J)"
              disabled={next === null}
              onClick={() => {
                if (next !== null) onStep(next)
              }}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>
        )}
        {col && (
          <span className="board-drawer-col" data-testid="board-drawer-col">
            in <strong>{COLUMN_LABEL[col]}</strong>
          </span>
        )}
        {!item && <h3 className="board-drawer-missing">{loaded ? 'Not on the board' : 'Loading…'}</h3>}
        <span className="grow" />
        <button
          type="button"
          className="icon-btn board-drawer-close board-drawer-expand"
          data-testid="board-drawer-expand"
          aria-pressed={expanded}
          aria-label={expanded ? 'Shrink' : 'Expand'}
          data-tip={expanded ? 'Shrink' : 'Expand'}
          onClick={toggleExpanded}
        >
          {expanded ? (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M9.5 2.5v4h4M6.5 13.5v-4h-4M9.5 6.5l4-4M6.5 9.5l-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M10 2.5h3.5V6M6 13.5H2.5V10M13.5 2.5L9 7M2.5 13.5L7 9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="icon-btn board-drawer-close"
          data-testid="board-drawer-close"
          aria-label="Close"
          data-tip="Close (Esc)"
          onClick={onClose}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </header>
      {item ? (
        // Keyed by card and the drop that asks who, so a new drop opens the picker again.
        <TodoCard key={`${item.id}:${assignThen ?? ''}`} item={item} assignThen={assignThen} drawer={{ wide }} />
      ) : (
        loaded && <p className="file-note">This card was removed, or is an older done one the board does not load.</p>
      )}
      {item && (
        <footer className="board-drawer-foot">
          <button type="button" className="board-drawer-remove" data-testid="board-drawer-remove" onClick={() => onRemove(item)}>
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
            Remove card
          </button>
          <span className="grow" />
          <span className="board-drawer-keys" aria-hidden="true">
            {neighbors.total > 1 && (
              <>
                <kbd>←</kbd> <kbd>→</kbd> to move ·{' '}
              </>
            )}
            <kbd>Esc</kbd> to close
          </span>
        </footer>
      )}
    </aside>
  )
}

const WIDE_QUERY = '(min-width: 900px)' // the width styles/board.css gives the expanded drawer its two columns at
const onWideChange = (changed: () => void): (() => void) => {
  const q = window.matchMedia(WIDE_QUERY)
  q.addEventListener('change', changed)
  return () => q.removeEventListener('change', changed)
}
const useWideWindow = (): boolean => useSyncExternalStore(onWideChange, () => window.matchMedia(WIDE_QUERY).matches)
