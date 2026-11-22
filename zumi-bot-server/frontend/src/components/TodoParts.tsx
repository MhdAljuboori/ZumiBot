import { useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { TODO_STATUSES, TODO_TEXT_MAX, type TodoItem, type TodoStatus } from '@zumibot/shared/todos'
import { errorMessage } from '../errors'
import { api } from '../api'
import { COLUMN_LABEL, columnOf, dropAction } from '../state/todoBoard'
import { STATE_LABEL, cardState, statusTone } from '../state/todoCard'
import { doneShown, tickedByLabel } from '../state/todosPanel'
import { batches } from '../state/todoGrid'
import { Markdown } from './Markdown'
import { TodoCard, TodoCardEnvContext, TodoHints, TodoListContext } from './TodoCard'
import { MenuSearch } from './MenuSearch'

// Shared by the side panel's To-dos view and the To-dos page.

const DONE_OPEN_KEY = 'zumibot.todos.doneOpen'
const UNDO_MS = 6000

// Per device; storage can be blocked or throw, and the list works without it.
function loadDoneOpen(): boolean {
  try {
    return localStorage.getItem(DONE_OPEN_KEY) === '1'
  } catch {
    return false
  }
}
function saveDoneOpen(open: boolean): void {
  try {
    localStorage.setItem(DONE_OPEN_KEY, open ? '1' : '0')
  } catch {
    /* not remembered */
  }
}

export function TodoRow({
  item,
  ticked,
  onRemove,
  extra
}: {
  item: TodoItem
  ticked: string | null
  onRemove: () => void
  /** Drawn after the text (the page's age and Ask). */
  extra?: ReactNode
}) {
  // A row opens as a card only inside a list that says which one it is; elsewhere it stays a plain to-do.
  const listEnv = useContext(TodoListContext)
  const cardEnv = useContext(TodoCardEnvContext)
  const cards = listEnv !== null && cardEnv !== null
  const [open, setOpen] = useState(() => cards && listEnv?.openId === item.id)
  // A status picked from the row that needs someone first (To do or In progress, nobody assigned): the card opens with
  // the assignee picker up, and the move follows the pick.
  const [assignThen, setAssignThen] = useState<TodoStatus | null>(null)
  const [moving, setMoving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const toggle = (): void => {
    setAssignThen(null)
    setOpen((o) => !o)
  }
  const col = cardEnv ? columnOf(item, cardEnv.chats, cardEnv.approvals) : item.done !== null ? 'done' : 'new'
  const state = cardEnv ? cardState(item, cardEnv.chats, cardEnv.approvals) : null
  const move = async (to: TodoStatus): Promise<void> => {
    const act = dropAction(item, col, to)
    if (!act) return
    setError(null)
    if (act.kind === 'assign') {
      setAssignThen(act.to)
      setOpen(true)
      return
    }
    setMoving(true)
    try {
      await api.todos.move(item.id, act.to)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setMoving(false)
      listEnv?.onRefresh() // also after a failure: the card may have moved under us
    }
  }
  const rowRef = useRef<HTMLLIElement>(null)
  // Opened on arrival (from the Inbox): brought into view once, where the list may be long.
  useEffect(() => {
    if (cards && listEnv?.openId === item.id) rowRef.current?.scrollIntoView({ block: 'start' })
  }, []) // once, on the row's first draw
  return (
    <li
      ref={rowRef}
      className={open ? 'todo-row open' : 'todo-row'}
      data-testid="todo-row"
      data-todo-id={item.id}
      data-done={item.done !== null}
    >
      <div className="todo-row-main">
        {/* No checkbox: the dot shows the card's status and, with cards, opens the menu that changes it. */}
        {cards ? (
          <StatusDot item={item} col={col} disabled={moving} onPick={(to) => void move(to)} />
        ) : (
          <span className="todo-row-dot" data-testid="todo-row-dot" data-col={col} aria-hidden="true" />
        )}
        <span
          className={cards ? 'todo-text openable' : 'todo-text'}
          data-testid="todo-text"
          // A link in the title opens the link, not the card.
          onClick={
            cards
              ? (e) => {
                  if (!(e.target as HTMLElement).closest('a')) toggle()
                }
              : undefined
          }
        >
          <Markdown text={item.text} inline />
          {cards && <TodoHints item={item} />}
        </span>
        {cards && state && state !== 'working' && (
          <span className={`todo-status ${statusTone(state)}`} data-testid="todo-row-state">
            {STATE_LABEL[state]}
          </span>
        )}
        {extra}
        {ticked && (
          <span className="todo-by" data-testid="todo-by">
            {ticked}
          </span>
        )}
        {cards && (
          <button
            type="button"
            className="icon-btn todo-open"
            data-testid="todo-open"
            aria-expanded={open}
            aria-label={open ? 'Close card' : 'Open card'}
            data-tip={open ? 'Close card' : 'Open card'}
            onClick={toggle}
          >
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          </button>
        )}
        <button
          type="button"
          className="icon-btn todo-remove"
          data-testid="todo-remove"
          aria-label="Remove to-do"
          data-tip="Remove"
          onClick={onRemove}
        >
          ✕
        </button>
      </div>
      {error && (
        <div className="side-error todo-row-error" role="alert" data-testid="todo-row-error">
          {error}
        </div>
      )}
      {open && cards && <TodoCard key={assignThen ?? ''} item={item} assignThen={assignThen} />}
    </li>
  )
}

/**
 * A row's status dot, which is also its status menu: a click lists every status with its dot, the current one checked;
 * a pick moves the card as a drop on the board does. Esc or a click elsewhere closes it; arrows move between options.
 */
function StatusDot({
  item,
  col,
  disabled,
  onPick
}: {
  item: TodoItem
  col: TodoStatus
  disabled: boolean
  onPick: (to: TodoStatus) => void
}) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  const dot = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!open) return
    const outside = (e: MouseEvent): void => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [open])
  const close = (): void => {
    setOpen(false)
    dot.current?.focus()
  }
  const keys = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      // The side panel's Esc (heard first, in capture) leaves the key to an open [role="menu"].
      e.preventDefault()
      close()
      return
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const items = [...(wrap.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
  }
  return (
    <span className="todo-row-dot-wrap" ref={wrap} onKeyDown={open ? keys : undefined}>
      <button
        ref={dot}
        type="button"
        className="todo-row-dot pick"
        data-testid="todo-row-dot"
        data-col={col}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Status: ${COLUMN_LABEL[col]}. Change status of ${item.text}`}
        data-tip={`${COLUMN_LABEL[col]} · change status`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <span className="todo-status-menu" role="menu" aria-label="Status" data-testid="todo-status-menu">
          <MenuSearch />
          {TODO_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              role="menuitemradio"
              aria-checked={s === col}
              className="todo-status-option"
              data-testid="todo-status-option"
              data-col={s}
              onClick={() => {
                close()
                if (s !== col) onPick(s)
              }}
            >
              <span className="todo-status-option-dot" data-col={s} aria-hidden="true" />
              <span className="grow">
                {COLUMN_LABEL[s]}
                {dropAction(item, col, s)?.kind === 'assign' ? '…' : ''}
              </span>
              {s === col && (
                <svg className="todo-status-check" viewBox="0 0 16 16" aria-hidden="true">
                  <path
                    d="M3.5 8.3l3 3 6-6.4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>
          ))}
        </span>
      )}
    </span>
  )
}

/** Tick, remove with Undo, restore and add, on the board; an add from a chat's panel (`chatId`) is made in that chat. */
export function useTodoActions(chatId: string | null, onRefresh: () => void) {
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraftRaw] = useState('')
  const [dupe, setDupe] = useState(false) // the last add was a repeat of an open item
  const adding = useRef(false) // a guard, not `disabled`: a disabled input would drop its focus
  const [undo, setUndo] = useState<string[] | null>(null) // ids removed in the last 6 s
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const act = async (run: () => Promise<void>): Promise<void> => {
    setError(null)
    try {
      await run()
    } catch (e) {
      setError(errorMessage(e))
    }
    onRefresh() // also after a failure: the list may have moved under us
  }
  const removeIds = (ids: string[]): Promise<void> =>
    act(async () => {
      const done: string[] = []
      try {
        // The server takes a bounded list per call; a later batch failing still leaves the earlier ones undoable.
        for (const batch of batches(ids)) {
          await api.todos.remove(batch)
          done.push(...batch)
        }
      } finally {
        if (done.length > 0) {
          // Removals close together share one toast, so none of them loses its Undo.
          setUndo((prev) => [...(prev ?? []), ...done])
          clearTimeout(timer.current)
          timer.current = setTimeout(() => setUndo(null), UNDO_MS)
        }
      }
    })
  const remove = (item: TodoItem): Promise<void> => removeIds([item.id])
  // Typing makes the note stale, so the exposed setter clears it as the box did.
  const setDraft = (s: string): void => {
    setDraftRaw(s)
    setDupe(false)
  }
  // Another chat starts with an empty box: a draft must not follow the view to it.
  useEffect(() => {
    setDraftRaw('')
    setDupe(false)
    setError(null)
  }, [chatId])
  const add = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || adding.current) return
    adding.current = true
    setError(null)
    setDupe(false)
    try {
      const r = await api.todos.add(text, chatId)
      if (r.added) setDraftRaw('')
      else setDupe(true) // the text stays, so the user can change it
    } catch (e) {
      setError(errorMessage(e))
    }
    adding.current = false
    onRefresh()
  }
  const restore = async (ids: string[]): Promise<void> => {
    clearTimeout(timer.current)
    setUndo(null)
    await act(async () => {
      for (const batch of batches(ids)) await api.todos.restore(batch)
    })
  }
  return { error, remove, removeIds, undo, restore, draft, setDraft, dupe, add }
}

export type TodoActions = ReturnType<typeof useTodoActions>

/** `primary`: the board's own form, with a filled Add button; a chat's panel keeps the quiet one. */
export function TodoAddForm({ actions, primary = false }: { actions: TodoActions; primary?: boolean }) {
  const { draft, setDraft, dupe, add } = actions
  return (
    <>
      <form
        className="todo-add"
        data-testid="todo-add"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <input
          className="field todo-add-input"
          data-testid="todo-add-input"
          value={draft}
          maxLength={TODO_TEXT_MAX}
          placeholder="Add a to-do…"
          aria-label="Add a to-do"
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="submit"
          className={primary ? 'btn primary' : 'btn small'}
          data-testid="todo-add-button"
          disabled={draft.trim() === ''}
        >
          Add
        </button>
      </form>
      {dupe && (
        <div className="file-note todo-add-note" role="status" data-testid="todo-add-note">
          Already on the list
        </div>
      )}
    </>
  )
}

/** Ticked items in one folded list; renders nothing while there are none. */
export function TodoDoneSection({ done, room, onRemove }: { done: TodoItem[]; room: boolean; onRemove: (item: TodoItem) => void }) {
  const [open, setOpen] = useState(loadDoneOpen)
  const [more, setMore] = useState(false)
  if (done.length === 0) return null
  const shown = doneShown(done, more)
  const toggle = (): void => {
    const next = !open
    setOpen(next)
    saveDoneOpen(next)
  }
  return (
    <section className="todo-group todo-done" data-testid="todo-done">
      <button type="button" className="todo-done-head" data-testid="todo-done-toggle" aria-expanded={open} onClick={toggle}>
        <span className="todo-chevron" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>{' '}
        Done · {done.length}
      </button>
      {open && (
        <>
          <ul className="todo-list">
            {shown.map((item) => (
              <TodoRow key={item.id} item={item} ticked={tickedByLabel(item, room)} onRemove={() => onRemove(item)} />
            ))}
          </ul>
          {shown.length < done.length && (
            <button type="button" className="btn small todo-more" data-testid="todo-done-more" onClick={() => setMore(true)}>
              Show more
            </button>
          )}
        </>
      )}
    </section>
  )
}

export function TodoUndoToast({ actions }: { actions: TodoActions }) {
  const { undo, restore } = actions
  if (!undo) return null
  return (
    <div className="todo-toast" role="status" data-testid="todo-toast">
      <span>{undo.length === 1 ? 'To-do removed' : `${undo.length} to-dos removed`}</span>
      <button type="button" className="todo-undo" data-testid="todo-undo" onClick={() => void restore(undo)}>
        Undo
      </button>
    </div>
  )
}
