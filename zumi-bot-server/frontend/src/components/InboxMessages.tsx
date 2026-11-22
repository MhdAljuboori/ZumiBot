import { useEffect, useMemo, useRef, useState } from 'react'
import type { InboxMessages as Data } from '@zumibot/shared/inbox'
import { UNDO_MS } from '@zumibot/shared/inbox'
import type { WorkflowsSnapshot } from '@zumibot/shared/workflows'
import { errorMessage } from '../errors'
import { api } from '../api'
import { foldText } from '../state/auditLog'
import { focusStep, messageTime, messageView } from '../state/inbox'
import { Markdown } from './Markdown'

interface Props {
  data: Data
  runs: WorkflowsSnapshot
  /** The seenAt from when the page opened: what was new then stays marked while it is read. */
  heldSeenAt: number
  /** A message the address named: scrolled to and lit once. */
  focusId: string | null
  /** The section is on screen (not hidden under the Waiting chip): a focus waits until it is. */
  shown: boolean
  /** The focus has been dealt with (or the message is gone), so the address can drop the id. */
  onFocused: () => void
  /** A change made here: fetch now instead of waiting for the broadcast. */
  onChange: () => void
  onOpenRun: (workflowId: string, runId: string) => void
  now: number
}

/** A message's body as Markdown (links clickable), folded to a preview past a few lines until Show all. */
function MessageBody({ text }: { text: string }) {
  const [all, setAll] = useState(false)
  const fold = useMemo(() => foldText(text), [text])
  const folded = fold.more && !all
  // A preview renders live, so a cut inside a code fence stays code instead of parsing half a diagram.
  return (
    <div className="inbox-msg-body" data-testid="inbox-msg-body">
      <Markdown text={folded ? fold.preview : text} live={folded} />
      {fold.more && (
        <button
          type="button"
          className="inbox-link inbox-msg-more"
          data-testid="inbox-msg-more"
          aria-expanded={all}
          onClick={() => setAll((a) => !a)}
        >
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
    </div>
  )
}

/** Workflow Notify messages, newest first; archived ones fold away, a delete can be undone for a few seconds. */
export function InboxMessages({ data, runs, heldSeenAt, focusId, shown, onFocused, onChange, onOpenRun, now }: Props) {
  const view = useMemo(() => messageView(data, heldSeenAt, runs), [data, heldSeenAt, runs])
  const [showArchived, setShowArchived] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [undo, setUndo] = useState<string[] | null>(null) // ids deleted in the last 6 s
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const act = async (run: () => Promise<void>): Promise<void> => {
    setError(null)
    try {
      await run()
    } catch (e) {
      setError(errorMessage(e))
    }
    onChange() // also after a failure: the list may have moved under us
  }
  const archive = (id: string, on: boolean): Promise<void> => act(() => api.inbox.archive(id, on))
  const remove = (id: string): Promise<void> =>
    act(async () => {
      await api.inbox.remove(id)
      // Deletes close together share one toast, so none of them loses its Undo.
      setUndo((prev) => [...(prev ?? []), id])
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setUndo(null), UNDO_MS)
    })
  const restore = async (ids: string[]): Promise<void> => {
    clearTimeout(timer.current)
    setUndo(null)
    await act(async () => {
      for (const id of ids) await api.inbox.restore(id)
    })
  }

  // Once per focus request, when the message is on screen (an archived one unfolds first); see focusStep. A request that
  // ends forgets the last one, so the same address opened again lights it again.
  const lit = useRef<string | null>(null)
  const [litId, setLitId] = useState<string | null>(null)
  useEffect(() => {
    if (focusId === null) {
      lit.current = null
      return
    }
    const step = focusStep(
      focusId,
      lit.current,
      shown,
      { shown: view.shown.map((m) => m.id), archived: view.archived.map((m) => m.id) },
      showArchived
    )
    if (step === 'unfold') setShowArchived(true)
    if (step !== 'light') return
    lit.current = focusId
    document.querySelector(`[data-testid="inbox-message"][data-message-id="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: 'center' })
    setLitId(focusId)
    onFocused()
  }, [focusId, shown, showArchived, view, onFocused])
  useEffect(() => {
    if (litId === null) return
    const t = setTimeout(() => setLitId(null), 2500)
    return () => clearTimeout(t)
  }, [litId])

  const row = (m: Data['messages'][number] & { runGone: boolean; isNew?: boolean }, archived: boolean) => (
    <article
      key={m.id}
      className={m.id === litId ? 'inbox-msg lit' : 'inbox-msg'}
      data-testid="inbox-message"
      data-message-id={m.id}
      data-new={m.isNew ? 'true' : undefined}
    >
      <div className="inbox-msg-head">
        <span className="inbox-av" aria-hidden="true">
          ⇄
        </span>
        <span className="inbox-msg-where">
          {m.workflowName} › {m.stepName} · {messageTime(m.at, now)}
        </span>
        <span className="inbox-msg-actions">
          {!m.runGone && (
            <button type="button" className="inbox-link" data-testid="inbox-open-run" onClick={() => onOpenRun(m.workflowId, m.runId)}>
              Open run →
            </button>
          )}
          <button
            type="button"
            className="btn small ghost"
            data-testid={archived ? 'inbox-unarchive' : 'inbox-archive'}
            onClick={() => void archive(m.id, !archived)}
          >
            {archived ? 'Unarchive' : 'Archive'}
          </button>
          <button type="button" className="btn small ghost" data-testid="inbox-delete" onClick={() => void remove(m.id)}>
            Delete
          </button>
        </span>
      </div>
      <div className="inbox-msg-title">{m.title}</div>
      {m.body !== undefined && m.body !== '' && <MessageBody text={m.body} />}
    </article>
  )

  return (
    <div className="inbox-messages">
      {error && (
        <div className="side-error" role="alert" data-testid="inbox-messages-error">
          {error}
        </div>
      )}
      {view.shown.length === 0 && (
        <div className="file-note" data-testid="inbox-messages-empty">
          No messages. A workflow's Notify step puts its message here.
        </div>
      )}
      {view.shown.map((m) => row(m, false))}
      {view.archived.length > 0 && (
        <>
          <button
            type="button"
            className="inbox-link inbox-archived-toggle"
            data-testid="inbox-show-archived"
            aria-expanded={showArchived}
            onClick={() => setShowArchived((s) => !s)}
          >
            {showArchived ? 'Hide' : 'Show'} archived ({view.archived.length})
          </button>
          {showArchived && view.archived.map((m) => row(m, true))}
        </>
      )}
      {undo && (
        <div className="inbox-toast" role="status" data-testid="inbox-toast">
          <span>{undo.length === 1 ? 'Message deleted' : `${undo.length} messages deleted`}</span>
          <button type="button" className="todo-undo" data-testid="inbox-undo" onClick={() => void restore(undo)}>
            Undo
          </button>
        </div>
      )}
    </div>
  )
}
