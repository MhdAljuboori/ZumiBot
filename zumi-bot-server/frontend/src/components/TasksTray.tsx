import { useEffect, useId, useRef, useState } from 'react'
import type { QueuedTask } from '@zumibot/shared/types'
import { focusAfterRemoval, taskLabel, taskName } from '../state/tasks'
import { ReplyIcon } from './MessageActions'
import { TrayHead } from './TrayHead'

/** Resolves true once the server took the action; false when it failed (the chat shows why). */
type TaskAction = (taskId: string) => Promise<boolean>

interface Props {
  tasks: QueuedTask[]
  open: boolean
  onToggle: () => void
  onDrop: TaskAction
  /** Sends a task now; null unless the queue holds its tasks (a paused group). */
  onSend?: TaskAction | null
}

/** "Tasks": messages sent while the chat ran, oldest first; each goes in on its own once the run before it ends. */
export function TasksTray({ tasks, open, onToggle, onDrop, onSend = null }: Props) {
  const listId = useId()
  const head = useRef<HTMLButtonElement>(null)
  const drops = useRef(new Map<string, HTMLButtonElement>())
  const root = useRef<HTMLDivElement>(null)
  // Rows whose Send now or × is on its way: their buttons wait, so a double tap acts once.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  // The row the user removed or sent, and the one after it: focus moves there once the meta push takes the row away.
  const acted = useRef<{ gone: string; next: string | null } | null>(null)

  useEffect(() => {
    const a = acted.current
    const target = a && focusAfterRemoval(tasks, a.gone, a.next)
    if (!target) return
    acted.current = null
    // Only when focus went with the row (to the body), not when the user has moved on meanwhile.
    const active = document.activeElement
    if (active && active !== document.body && !root.current?.contains(active)) return
    ;(target.to === 'row' ? drops.current.get(target.id) : head.current)?.focus()
  }, [tasks])

  const act = (run: TaskAction, task: QueuedTask, index: number): void => {
    if (busy.has(task.id)) return
    acted.current = { gone: task.id, next: tasks[index + 1]?.id ?? null }
    setBusy((prev) => new Set(prev).add(task.id))
    void run(task.id).then((ok) => {
      // A failed action leaves the row: focus has nowhere to move.
      if (!ok && acted.current?.gone === task.id) acted.current = null
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(task.id)
        return next
      })
    })
  }

  return (
    <div ref={root} className="tasks-tray" data-testid="tasks-tray">
      <TrayHead testId="tasks-head" label="Tasks" count={tasks.length} open={open} onToggle={onToggle} controls={listId} headRef={head} />
      <div className="tray-rows" id={listId} hidden={!open}>
        {open &&
          tasks.map((task, index) => {
            const files = task.attachments?.length ?? 0
            const filesLabel = files === 1 ? '1 file' : `${files} files`
            const name = taskName(task)
            const waiting = busy.has(task.id)
            return (
              <div key={task.id} className="task-row" data-testid="task-row">
                <span className="task-dot" aria-hidden="true" />
                <span className="task-text" data-tip={task.text || undefined}>
                  {taskLabel(task)}
                </span>
                {task.replyTo !== undefined && (
                  <span className="task-mark" data-tip="Replies to a message">
                    <ReplyIcon />
                    <span className="sr-only">Replies to a message</span>
                  </span>
                )}
                {files > 0 && (
                  <span className="task-mark" data-tip={filesLabel}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M13.2 7.4 8.1 12.5a3 3 0 0 1-4.2-4.2l5.4-5.4a2 2 0 0 1 2.8 2.8L6.7 11.1a1 1 0 0 1-1.4-1.4l4.9-4.9"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.4"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                    <span aria-hidden="true">{files}</span>
                    <span className="sr-only">{filesLabel}</span>
                  </span>
                )}
                <span className="task-actions">
                  {onSend && (
                    <button
                      type="button"
                      className="task-action"
                      data-testid="task-send"
                      aria-label={`Send now: ${name}`}
                      data-tip="Send now"
                      disabled={waiting}
                      onClick={() => act(onSend, task, index)}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path
                          d="M12.5 3.5v4a2.5 2.5 0 0 1-2.5 2.5H3.5M6.5 7l-3 3 3 3"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                  <button
                    ref={(b) => {
                      if (b) drops.current.set(task.id, b)
                      else drops.current.delete(task.id)
                    }}
                    type="button"
                    className="task-action"
                    data-testid="task-drop"
                    aria-label={`Remove queued message: ${name}`}
                    data-tip="Remove"
                    disabled={waiting}
                    onClick={() => act(onDrop, task, index)}
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </span>
              </div>
            )
          })}
      </div>
    </div>
  )
}
