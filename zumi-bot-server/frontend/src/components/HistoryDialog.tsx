import { useEffect, useRef, useState } from 'react'
import type { VersionSummary } from '@zumibot/shared/definitionHistory'
import { errorMessage } from '../errors'
import { changesText, sourceText, versionTimeText } from '../state/versionHistory'

interface Props {
  /** What the dialog lists: "workflow" or "routine", for its words. */
  noun: string
  load: () => Promise<VersionSummary[]>
  /** Puts the version into the editor; the dialog closes once it resolves, and shows its error when it fails. */
  onRestore: (v: VersionSummary) => Promise<void>
  onClose: () => void
}

/** The saved versions of a workflow or routine, newest first, each with Restore but the one that is saved now. */
export function HistoryDialog({ noun, load, onRestore, onClose }: Props) {
  const [list, setList] = useState<VersionSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const alive = useRef(true)
  const now = Date.now()

  useEffect(() => {
    alive.current = true // StrictMode re-runs effects after a simulated unmount
    load().then(
      (l) => {
        if (alive.current) setList(l)
      },
      (e: unknown) => {
        if (alive.current) setError(errorMessage(e))
      }
    )
    return () => {
      alive.current = false
    }
  }, [load])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const restore = (v: VersionSummary): void => {
    setBusy(v.id)
    setError(null)
    onRestore(v)
      .catch((e: unknown) => {
        if (alive.current) setError(errorMessage(e))
      })
      .finally(() => {
        if (alive.current) setBusy(null)
      })
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal history-dialog" role="dialog" aria-modal="true" aria-labelledby="history-title" data-testid="history-dialog">
        <h2 id="history-title" className="modal-title">
          History
        </h2>
        <p className="modal-message">
          Every save keeps a version of this {noun}. Restore puts one back in the editor; nothing changes until you save.
        </p>
        {error && (
          <p className="history-error" role="alert" data-testid="history-error">
            {error}
          </p>
        )}
        {list === null && !error && <p className="history-empty">Loading…</p>}
        {list !== null && list.length === 0 && (
          <p className="history-empty" data-testid="history-empty">
            No versions kept yet. The next save that changes it keeps one.
          </p>
        )}
        {list !== null && list.length > 0 && (
          <ol className="history-list">
            {list.map((v, i) => (
              <li key={v.id} className="history-row" data-testid="history-row" data-current={v.current || undefined}>
                <div className="history-main">
                  <div className="history-when">
                    {versionTimeText(v.savedAt, now)}
                    {v.current && (
                      <span className="history-current" data-testid="history-current">
                        Current
                      </span>
                    )}
                  </div>
                  <div className="history-who">{sourceText(v, now)}</div>
                  <div className="history-changes" data-testid="history-changes">
                    {changesText(v, i === list.length - 1)}
                  </div>
                </div>
                {!v.current && (
                  <button type="button" className="btn" data-testid="history-restore" disabled={busy !== null} onClick={() => restore(v)}>
                    {busy === v.id ? 'Restoring…' : 'Restore'}
                  </button>
                )}
              </li>
            ))}
          </ol>
        )}
        <div className="modal-buttons">
          <button type="button" className="btn" data-testid="history-close" autoFocus onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
