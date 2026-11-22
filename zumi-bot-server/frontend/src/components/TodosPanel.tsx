import { useEffect, useMemo, useRef } from 'react'
import type { TodoItem } from '@zumibot/shared/todos'
import type { ChatMeta } from '@zumibot/shared/types'
import { panelView } from '../state/todosPanel'
import { TodoAddForm, TodoDoneSection, TodoRow, TodoUndoToast, useTodoActions } from './TodoParts'
import { SideBackButton } from './SidePanelMenu'
import { TodoListContext } from './TodoCard'

interface Props {
  chat: ChatMeta
  /** null until the first answer. */
  items: TodoItem[] | null
  /** The first fetch failed (only meaningful while `items` is null). */
  failed: boolean
  onRetry: () => void
  /** Fetch again now, after a change made here. */
  onRefresh: () => void
  /** The chat's loaded item ids: Show in chat is offered for a reply among them, or unknown while older pages remain. */
  visibleIds: ReadonlySet<string>
  /** Every page of the chat's items is loaded, so a reply missing from `visibleIds` is really gone. */
  historyComplete: boolean
  /** The reply to scroll to (from the chip under it); `focusRequest` makes a repeat of the same one a new request. */
  focusItemId: string | null
  focusRequest: number
  /** Back to the side panel's list. */
  onBack: () => void
  onClose: () => void
  onShowInChat: (itemId: string) => void
}

/** The to-dos made in this chat, from the board: open items by the reply that made them, ticked ones folded under Done. */
export function TodosPanel({
  chat,
  items,
  failed,
  onRetry,
  onRefresh,
  visibleIds,
  historyComplete,
  focusItemId,
  focusRequest,
  onBack,
  onClose,
  onShowInChat
}: Props) {
  const room = !!chat.group
  const view = useMemo(() => panelView(items ?? [], visibleIds, historyComplete), [items, visibleIds, historyComplete])
  const actions = useTodoActions(chat.id, onRefresh)

  const ref = useRef<HTMLDivElement>(null)
  const handled = useRef<string | null>(null)
  useEffect(() => {
    if (!focusItemId) return
    const request = `${focusRequest}:${focusItemId}`
    if (handled.current === request) return
    const group = ref.current?.querySelector<HTMLElement>(`[data-todo-reply="${CSS.escape(focusItemId)}"]`)
    if (group) {
      handled.current = request
      group.scrollIntoView({ block: 'start' })
      group.focus({ preventScroll: true })
    }
  }, [focusItemId, focusRequest, items])

  const listEnv = useMemo(() => ({ chatId: chat.id, onRefresh }), [chat.id, onRefresh])
  return (
    <TodoListContext.Provider value={listEnv}>
      <aside className="files-panel side-panel todos-panel" data-testid="todos-panel" aria-label="To-dos">
        <header className="files-head">
          <span className="side-head-title">
            <SideBackButton onBack={onBack} />
            <span className="files-title" data-testid="todos-title">
              To-dos · {view.left} left
            </span>
          </span>
          <button type="button" className="icon-btn" data-testid="todos-close" aria-label="Close to-dos" onClick={onClose}>
            ✕
          </button>
        </header>
        {items !== null && <TodoAddForm actions={actions} />}
        <div className="side-list" ref={ref}>
          {failed && items === null && (
            <div className="file-note" role="alert">
              Couldn't load to-dos.{' '}
              <button type="button" className="btn small" data-testid="todos-retry" onClick={onRetry}>
                Retry
              </button>
            </div>
          )}
          {actions.error && (
            <div className="side-error todo-error" role="alert" data-testid="todos-error">
              {actions.error}
            </div>
          )}
          {items !== null && items.length === 0 && (
            <div className="file-note" data-testid="todos-empty">
              No to-dos made in this chat yet. Start a message with /todo to make some; they go on the board too.
            </div>
          )}
          {view.open.map((g) => (
            <section key={g.key} className="todo-group" data-testid="todo-group" data-todo-reply={g.itemId ?? undefined} tabIndex={-1}>
              <div className="todo-group-head">
                <span className="todo-group-label" data-testid="todo-group-label" data-tip={g.label}>
                  {g.label}
                </span>
                <time dateTime={new Date(g.at).toISOString()}>
                  {new Date(g.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </time>
                {g.showInChat && g.itemId !== null && (
                  <button type="button" className="file-show" data-testid="todo-show" onClick={() => onShowInChat(g.itemId!)}>
                    Show in chat
                  </button>
                )}
              </div>
              {g.sections.map((s) => (
                <div key={s.heading ?? ''} className="todo-section">
                  {s.heading !== null && (
                    <h3 className="todo-heading" data-testid="todo-heading">
                      {s.heading}
                    </h3>
                  )}
                  <ul className="todo-list">
                    {s.items.map((item) => (
                      <TodoRow key={item.id} item={item} ticked={null} onRemove={() => void actions.remove(item)} />
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
          <TodoDoneSection done={view.done} room={room} onRemove={(item) => void actions.remove(item)} />
        </div>
        <TodoUndoToast actions={actions} />
      </aside>
    </TodoListContext.Provider>
  )
}
