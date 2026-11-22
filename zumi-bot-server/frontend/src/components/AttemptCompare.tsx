import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { displayName } from '@zumibot/shared/frontmatter'
import type { GitChangedFile, GitChanges, GitFileDiff } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import { useConnected } from '../useConnected'
import { splitPath } from '../state/filesPanel'
import { changeRows, KIND, pathLine } from '../state/gitChanges'
import { changesLabel, type AttemptRow } from '../state/attempts'
import { languageOf } from '../state/syntax'
import { Lines } from './FilePreview'

/** One side of the comparison: an attempt's files since its base, and the picked file's diff. */
function Side({ row, path, onPick }: { row: AttemptRow; path: string | null; onPick: (path: string) => void }) {
  const [changes, setChanges] = useState<GitChanges | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [diff, setDiff] = useState<GitFileDiff | null>(null)
  const id = row.attempt.chatId
  const connected = useConnected()
  useEffect(() => {
    if (!connected) return
    let live = true
    api.chats.gitChanges(id, 'base').then(
      (c) => {
        if (!live) return
        setChanges(c)
        setError(null)
      },
      (e: unknown) => {
        if (live) {
          setChanges(null)
          setError(errorMessage(e))
        }
      }
    )
    return () => {
      live = false
    }
  }, [id, connected])
  // Both columns show the same path when both have it, so the same file is compared.
  const files: GitChangedFile[] = changes?.files ?? []
  const shown = path !== null && files.some((f) => f.path === path) ? path : null
  useEffect(() => {
    if (shown === null) {
      setDiff(null)
      return
    }
    if (!connected) return
    let live = true
    api.chats.gitDiff(id, shown, 'base').then(
      (d) => {
        if (live) setDiff(d)
      },
      () => {
        if (live) setDiff(null)
      }
    )
    return () => {
      live = false
    }
  }, [id, shown, connected])
  const rows = diff ? changeRows(diff, 'diff') : null
  return (
    <section className="compare-side" data-testid="compare-side" data-agent={row.attempt.agent}>
      <header className="compare-head">
        <span className="attempt-name">{displayName(row.attempt.agent)}</span>
        <span className="attempt-n">#{row.attempt.n}</span>
        <span className={`attempt-state tone-${row.tone}`}>{row.label}</span>
        <span className="attempt-stat">{changesLabel(changes)}</span>
      </header>
      <div className="compare-files">
        {error !== null && (
          <div className="file-note error" role="alert">
            {error}
          </div>
        )}
        {changes !== undefined && error === null && files.length === 0 && (
          <div className="file-note">Nothing has changed since this worktree started.</div>
        )}
        {files.map((f) => {
          const { name, dir } = splitPath(f.path)
          return (
            <button
              key={f.path}
              type="button"
              className={f.path === shown ? 'file-row on' : 'file-row'}
              data-testid="compare-row"
              data-path={f.path}
              data-tip={`${KIND[f.kind].label}: ${pathLine(f)}`}
              onClick={() => onPick(f.path)}
            >
              <span className="change-kind" data-kind={f.kind} aria-label={KIND[f.kind].label}>
                {KIND[f.kind].letter}
              </span>
              <span className="file-name">{name}</span>
              {dir !== '' && <span className="file-dir">{dir}</span>}
            </button>
          )
        })}
      </div>
      {shown !== null && (
        <Lines
          rows={rows}
          status="loading"
          shown={shown}
          view="diff"
          member={undefined}
          onQuote={() => {}}
          onExplain={null}
          lang={languageOf(shown)}
        />
      )}
    </section>
  )
}

/** Two attempts' diffs since their shared base, side by side, each chat one click away. */
export function AttemptCompare({
  rows,
  onClose,
  onOpenChat
}: {
  rows: AttemptRow[]
  onClose: () => void
  onOpenChat: (chatId: string) => void
}) {
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  // To the body, as the dialog does: side by side needs the window's width, not the drawer's.
  return createPortal(
    <div className="attempt-scrim" onMouseDown={onClose}>
      <div
        className="compare-sheet"
        data-testid="attempt-compare"
        role="dialog"
        aria-label="Compare attempts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="attempt-dialog-head">
          <h3>Compare attempts</h3>
          <span className="grow" />
          {rows.map((r) => (
            <button
              key={r.attempt.chatId}
              type="button"
              className="btn small"
              data-testid="compare-open"
              onClick={() => onOpenChat(r.attempt.chatId)}
            >
              Open {displayName(r.attempt.agent)} #{r.attempt.n} →
            </button>
          ))}
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="compare-body">
          {rows.map((r) => (
            <Side key={r.attempt.chatId} row={r} path={path} onPick={setPath} />
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
