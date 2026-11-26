import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChatMeta, GitChangedFile, GitDiffScope, GitFileDiff } from '@zumibot/shared/types'
import {
  REVIEW_TEXT_MAX,
  addComment,
  editComment,
  removeComment,
  rangeOf,
  reviewMessage,
  sortComments,
  type ReviewComment,
  type ReviewPick
} from '@zumibot/shared/reviewComments'
import { api } from '../api'
import { errorMessage } from '../errors'
import { splitPath, type FileView } from '../state/filesPanel'
import { changeRows, copyText, filesLine, KIND, lineTotals, pathLine, shownPath, sinceStart } from '../state/gitChanges'
import { commentRow, draftCount, loadDraft, saveDraft } from '../state/reviewDraft'
import { languageOf } from '../state/syntax'
import { canOpenPr } from '../state/pullRequest'
import { useGitChanges } from '../useGitChanges'
import { CopyButton, Lines } from './FilePreview'
import { OpenPrButton, PrBox } from './PullRequest'
import { MenuIcon } from './MenuIcon'
import { SideBackButton } from './SidePanelMenu'

interface Props {
  chat: ChatMeta
  /** Back to the side panel's list. */
  onBack: () => void
  onClose: () => void
  onQuote: (block: string) => void
  /** null while sending is not possible (offline, no claude). */
  onExplain: ((block: string, member?: string) => void) | null
  /**
   * Posts the review as one ordinary user turn; null while sending is not possible. Fire and forget, like Explain: a
   * send settles only when the turn ends, so the draft is cleared now and a failure shows as a failed message in the
   * chat, with its text (the whole review) and its Retry.
   */
  onSendReview: ((text: string) => void) | null
  /** After each list answer, so the header chip's count is read again with it. */
  onLoaded: () => void
}

function RefreshIcon() {
  return (
    <svg
      className="glyph"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M13.2 8A5.2 5.2 0 1 1 11.6 4.2M13.2 2.6v3h-3" />
    </svg>
  )
}

/** "+12 −3" in green and red; nothing for a file with no counts (binary, or an untracked file not read). */
function Counts({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null && removed === null) return null
  return (
    <span className="change-lines" data-testid="change-lines">
      {added !== null && added > 0 && <span className="change-add">+{added}</span>}
      {removed !== null && removed > 0 && <span className="change-del">−{removed}</span>}
    </span>
  )
}

function ChangePreview({
  chat,
  file,
  version,
  scope,
  onQuote,
  onExplain,
  onComment
}: Pick<Props, 'chat' | 'onQuote' | 'onExplain'> & {
  file: GitChangedFile
  version: number
  scope: GitDiffScope
  /** The selected line range and its text, straight from the diff's rows. */
  onComment: ((pick: { from: number; to: number; old: boolean; text: string }) => void) | null
}) {
  const [view, setView] = useState<FileView>('diff')
  const [got, setGot] = useState<{ diff: GitFileDiff } | { error: string } | null>(null)
  // Read again with every list answer: the agent or the user may have changed the file since.
  useEffect(() => {
    let live = true
    api.chats.gitDiff(chat.id, file.path, scope).then(
      (diff) => {
        if (live) setGot({ diff })
      },
      (e: unknown) => {
        if (live) setGot({ error: errorMessage(e) })
      }
    )
    return () => {
      live = false
    }
  }, [chat.id, file.path, scope, version])
  const diff = got && 'diff' in got ? got.diff : null
  const rows = useMemo(() => (diff ? changeRows(diff, view) : null), [diff, view])
  const full = useMemo(() => (diff ? { old: copyText(diff, 'old'), new: copyText(diff, 'new') } : undefined), [diff])
  const copy = diff ? copyText(diff, view) : null
  const kind = KIND[file.kind]
  const against = scope === 'base' ? 'the commit the worktree started from' : 'the last commit'
  return (
    <section className="file-preview" data-testid="change-preview" aria-label="Change preview">
      <div className="file-toolbar">
        <div className="seg" role="group" aria-label="View">
          {(['diff', 'old', 'new'] as const).map((v) => (
            <button
              key={v}
              type="button"
              data-testid={`change-view-${v}`}
              aria-pressed={view === v}
              data-tip={v === 'diff' ? `Against ${against}` : v === 'old' ? `As in ${against}` : 'As it is in the folder now'}
              onClick={() => setView(v)}
            >
              {v === 'diff' ? 'Diff' : v === 'old' ? 'Old' : 'New'}
            </button>
          ))}
        </div>
        <div className="file-actions">
          <CopyButton
            disabled={copy === null}
            text={() => (copy === null ? Promise.reject(new Error('no text')) : Promise.resolve(copy))}
          />
        </div>
      </div>
      <div className="file-meta">
        <span className="file-meta-path" data-testid="change-path" data-tip={pathLine(file)}>
          {pathLine(file)}
        </span>
        <span className="file-meta-who">
          {kind.label}
          {file.staged ? ' · staged' : ''}
        </span>
        <Counts added={file.added} removed={file.removed} />
      </div>
      {got && 'error' in got ? (
        <div className="file-body" data-testid="file-body">
          <div className="file-note error" role="alert">
            {got.error}
          </div>
        </div>
      ) : (
        <Lines
          key={view}
          rows={rows}
          status="loading"
          shown={file.path}
          view={view}
          member={undefined}
          onQuote={onQuote}
          onExplain={onExplain}
          {...(onComment ? { onComment } : {})}
          lang={languageOf(file.path)}
          full={full}
        />
      )}
    </section>
  )
}

/** The comment being written: a new one on a selection, or an edit of one already in the draft. */
type Writing = { kind: 'new'; pick: ReviewPick } | { kind: 'edit'; comment: ReviewComment }

function CommentForm({ writing, onCancel, onSave }: { writing: Writing; onCancel: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState(writing.kind === 'edit' ? writing.comment.text : '')
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    area.current?.focus()
  }, [])
  const where = writing.kind === 'edit' ? rangeOf(writing.comment) : rangeOf(writing.pick)
  const quote = writing.kind === 'edit' ? writing.comment.quote : writing.pick.quote
  return (
    <form
      className="review-form"
      data-testid="review-form"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(text)
      }}
    >
      <div className="review-form-where" data-testid="review-form-where">
        {where}
      </div>
      <pre className="review-form-quote" data-testid="review-form-quote">
        {quote}
      </pre>
      <textarea
        ref={area}
        className="review-form-text"
        data-testid="review-form-text"
        rows={3}
        maxLength={REVIEW_TEXT_MAX}
        placeholder="What should change here?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        // Enter sends, as the composer does; Shift+Enter is a new line and Esc drops the comment.
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSave(text)
          }
        }}
      />
      <div className="review-form-actions">
        <button type="submit" className="btn small primary" data-testid="review-add" disabled={text.trim() === ''}>
          {writing.kind === 'edit' ? 'Save' : 'Add comment'}
        </button>
        <button type="button" className="btn small" data-testid="review-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

/**
 * The side panel's Changes: every changed file in the chat's repo — uncommitted, or everything since the worktree's
 * base commit — the picked one's diff, and the review comments waiting to be sent.
 */
export function GitChangesPanel({ chat, onBack, onClose, onQuote, onExplain, onSendReview, onLoaded }: Props) {
  const [scope, setScope] = useState<GitDiffScope>('uncommitted')
  const { changes, error, loading, version, refresh } = useGitChanges(chat, scope)
  const [picked, setPicked] = useState<string | null>(null)
  const [draft, setDraft] = useState<ReviewComment[]>(() => loadDraft(chat.id))
  const [writing, setWriting] = useState<Writing | null>(null)
  const [listOpen, setListOpen] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  useEffect(() => {
    if (version > 0) onLoaded()
  }, [version]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    saveDraft(chat.id, draft)
  }, [chat.id, draft])
  const files = changes?.files ?? []
  const path = shownPath(files, picked)
  const file = files.find((f) => f.path === path)
  const totals = lineTotals(files)
  // Only a worktree has a start to measure from: the chat's (made since base diffs recorded its commit) or the agent's own.
  const start = sinceStart(chat.worktree, changes)
  const base = start.base
  const canBase = start.show
  // The agent left its worktree, or it has no start any more: back to what the switch can still offer.
  useEffect(() => {
    if (scope === 'base' && (!canBase || base === undefined)) setScope('uncommitted')
  }, [scope, canBase, base])
  const save = (text: string): void => {
    if (!writing) return
    try {
      setDraft((cur) =>
        writing.kind === 'edit'
          ? editComment(cur, writing.comment.id, text)
          : addComment(cur, writing.pick, text, Date.now(), crypto.randomUUID())
      )
      setWriting(null)
      setRefusal(null)
      setListOpen(true)
    } catch (e: unknown) {
      setRefusal(errorMessage(e))
    }
  }
  const send = (): void => {
    if (!onSendReview || draft.length === 0) return
    onSendReview(reviewMessage(draft))
    setDraft([])
    setWriting(null)
    setListOpen(false)
    setRefusal(null)
  }
  return (
    <aside className="files-panel changes-panel" data-testid="changes-panel" aria-label="Changes">
      <header className="files-head">
        <span className="side-head-title">
          <SideBackButton onBack={onBack} />
          <span className="files-title">Changes</span>
        </span>
        <span className="changes-head-actions">
          <button
            type="button"
            className={loading ? 'icon-btn changes-refresh spinning' : 'icon-btn changes-refresh'}
            data-testid="changes-refresh"
            aria-label="Refresh changes"
            data-tip="Refresh"
            onClick={refresh}
          >
            <RefreshIcon />
          </button>
          <button type="button" className="icon-btn" data-testid="changes-close" aria-label="Close changes" onClick={onClose}>
            ✕
          </button>
        </span>
      </header>
      {changes && (
        <div className="changes-sum" data-testid="changes-sum">
          <MenuIcon name="gitBranch" className="menu-icon git-icon" />
          <span className="changes-branch" data-tip={`${changes.top}\nBranch: ${changes.branch ?? `detached at ${changes.head}`}`}>
            {changes.branch ?? changes.head}
          </span>
          <span className="changes-files" data-testid="changes-count">
            {filesLine(changes)}
          </span>
          <Counts added={totals.added} removed={totals.removed} />
        </div>
      )}
      {changes?.agentTree && (
        <div className="changes-where" data-testid="changes-agent-tree" data-tip="The agent made this worktree and works in it">
          In the agent's worktree: <span className="changes-where-path">{changes.agentTree}</span>
        </div>
      )}
      {canBase && (
        <div className="seg changes-scope" role="group" aria-label="Which changes" data-testid="changes-scope">
          <button
            type="button"
            data-testid="changes-scope-uncommitted"
            aria-pressed={scope === 'uncommitted'}
            data-tip="What is not committed yet"
            onClick={() => setScope('uncommitted')}
          >
            Uncommitted
          </button>
          <button
            type="button"
            data-testid="changes-scope-base"
            aria-pressed={scope === 'base'}
            disabled={base === undefined}
            data-tip={base === undefined ? start.missing : `Everything since ${base.slice(0, 7)}, committed or not`}
            onClick={() => setScope('base')}
          >
            Since start
          </button>
        </div>
      )}
      {error !== null && changes !== undefined && (
        <div className="changes-error" role="alert">
          Couldn't refresh: {error}
        </div>
      )}
      <div className="files-list">
        {changes === undefined ? (
          error !== null ? (
            <div className="file-note" role="alert">
              Couldn't load changes: {error}{' '}
              <button type="button" className="btn small" data-testid="changes-retry" onClick={refresh}>
                Retry
              </button>
            </div>
          ) : (
            <div className="file-note" role="status">
              <span className="spinner" aria-hidden="true" /> Loading…
            </div>
          )
        ) : changes === null ? (
          <div className="file-note" data-testid="changes-none">
            {chat.worktree?.removed
              ? `Its worktree folder was removed. Branch ${chat.worktree.branch} is kept.`
              : scope === 'base'
                ? 'This worktree was made before base diffs, so there is no commit to compare against.'
                : "This chat's folder is not in a git repository."}
          </div>
        ) : files.length === 0 ? (
          <div className="file-note" data-testid="changes-clean">
            {scope === 'base' ? 'Nothing has changed since this worktree started.' : 'No uncommitted changes. Everything is committed.'}
          </div>
        ) : (
          <>
            {files.map((f) => {
              const { name, dir } = splitPath(f.path)
              const kind = KIND[f.kind]
              const mine = draft.filter((c) => c.path === f.path).length
              return (
                <button
                  key={f.path}
                  type="button"
                  className={f.path === path ? 'file-row on' : 'file-row'}
                  data-testid="change-row"
                  data-path={f.path}
                  data-kind={f.kind}
                  data-tip={`${kind.label}: ${pathLine(f)}`}
                  onClick={() => setPicked(f.path)}
                >
                  <span className="change-kind" data-kind={f.kind} aria-label={kind.label}>
                    {kind.letter}
                  </span>
                  <span className="file-name">{name}</span>
                  {dir !== '' && <span className="file-dir">{dir}</span>}
                  {mine > 0 && (
                    <span className="review-dot" data-testid="review-dot" data-tip={draftCount(mine)}>
                      {mine}
                    </span>
                  )}
                  <Counts added={f.added} removed={f.removed} />
                </button>
              )
            })}
            {changes.more > 0 && <div className="file-note">{changes.more} more not listed.</div>}
          </>
        )}
      </div>
      {file ? (
        <ChangePreview
          key={file.path}
          chat={chat}
          file={file}
          version={version}
          scope={scope}
          onQuote={onQuote}
          onExplain={onExplain}
          onComment={({ from, to, old, text }) => {
            setRefusal(null)
            // The selected text is the quote: it is what the user saw, kept so the agent finds the place again.
            setWriting({ kind: 'new', pick: { path: file.path, from, to, old, quote: text, scope } })
          }}
        />
      ) : (
        changes && files.length > 0 && <div className="file-note file-empty">Pick a file to see its changes.</div>
      )}
      {writing && (
        <CommentForm
          key={writing.kind === 'edit' ? writing.comment.id : `${writing.pick.path}:${writing.pick.from}-${writing.pick.to}`}
          writing={writing}
          onCancel={() => setWriting(null)}
          onSave={save}
        />
      )}
      {refusal !== null && (
        <div className="review-error" role="alert" data-testid="review-error">
          {refusal}
        </div>
      )}
      {canOpenPr(chat) && (
        <div className="changes-pr" data-testid="changes-pr">
          {chat.pr ? <PrBox chat={chat} /> : <OpenPrButton chat={chat} onOpened={() => refresh()} />}
        </div>
      )}
      {draft.length > 0 && (
        <div className="review-bar" data-testid="review-bar">
          <div className="review-bar-top">
            <button
              type="button"
              className="review-toggle"
              data-testid="review-toggle"
              aria-expanded={listOpen}
              onClick={() => setListOpen((v) => !v)}
            >
              <span className="review-chevron" aria-hidden="true">
                {listOpen ? '▾' : '▸'}
              </span>
              {draftCount(draft.length)}
            </button>
            <button
              type="button"
              className="btn small primary"
              data-testid="review-send"
              disabled={onSendReview === null}
              data-tip={onSendReview === null ? 'Not connected' : 'Posts the comments as one message to this chat'}
              onClick={send}
            >
              Send review
            </button>
          </div>
          {listOpen && (
            <ul className="review-list" data-testid="review-list">
              {sortComments(draft).map((c) => {
                const row = commentRow(c)
                return (
                  <li key={c.id} className="review-row" data-testid="review-row" data-path={c.path}>
                    <span className="review-row-text">
                      <span className="review-row-where" data-tip={c.quote}>
                        {row.where}
                      </span>
                      <span className="review-row-first">{row.first}</span>
                    </span>
                    <button
                      type="button"
                      className="btn small"
                      data-testid="review-edit"
                      onClick={() => {
                        setRefusal(null)
                        setWriting({ kind: 'edit', comment: c })
                      }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      data-testid="review-delete"
                      onClick={() => {
                        setDraft((cur) => removeComment(cur, c.id))
                        setWriting((w) => (w?.kind === 'edit' && w.comment.id === c.id ? null : w))
                      }}
                    >
                      Delete
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </aside>
  )
}
