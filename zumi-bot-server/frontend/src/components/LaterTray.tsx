import { useId, useState } from 'react'
import type { LaterSend } from '@zumibot/shared/later'
import { browserZone } from '../state/later'
import { dayAt } from '../state/limitNotice'
import { TrayHead } from './TrayHead'

/** Resolves true once the server took the action; false when it failed (the chat shows why). */
type LaterAction = (id: string) => Promise<boolean>

interface Props {
  later: LaterSend[]
  open: boolean
  onToggle: () => void
  onCancel: LaterAction
  /** Null while it cannot go now (offline, no CLI). */
  onSendNow: LaterAction | null
}

/** "Later": messages written with /later, soonest first, each going in by itself at its time (docs/architecture/agent-commands.md, /later). */
export function LaterTray({ later, open, onToggle, onCancel, onSendNow }: Props) {
  const listId = useId()
  // Rows whose Send now or × is on its way: their buttons wait, so a double tap acts once.
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const act = (run: LaterAction, id: string): void => {
    if (busy.has(id)) return
    setBusy((prev) => new Set(prev).add(id))
    void run(id).then(() =>
      setBusy((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    )
  }
  const now = Date.now()
  const zone = browserZone()
  return (
    <div className="tasks-tray later-tray" data-testid="later-tray">
      <TrayHead testId="later-head" label="Later" count={later.length} open={open} onToggle={onToggle} controls={listId} />
      <div className="tray-rows" id={listId} hidden={!open}>
        {open &&
          later.map((l) => {
            const when = dayAt(l.at, now, zone)
            const waiting = busy.has(l.id)
            return (
              <div key={l.id} className="task-row later-row" data-testid="later-row">
                <span className="later-when">{when}</span>
                <span className="task-text" data-tip={l.text}>
                  {l.text.split('\n')[0]}
                </span>
                <span className="task-actions">
                  {onSendNow && (
                    <button
                      type="button"
                      className="task-action"
                      data-testid="later-send"
                      aria-label={`Send now: ${l.text}`}
                      data-tip="Send now"
                      disabled={waiting}
                      onClick={() => act(onSendNow, l.id)}
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
                    type="button"
                    className="task-action"
                    data-testid="later-cancel"
                    aria-label={`Cancel /later message: ${l.text}`}
                    data-tip="Cancel"
                    disabled={waiting}
                    onClick={() => act(onCancel, l.id)}
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
