import { useCallback, useEffect, useState } from 'react'
import { PR_BODY_MAX, PR_TITLE_MAX, checksLine } from '@zumibot/shared/pullRequest'
import type { ChatMeta, ChatPr, GhState, PrDraft } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import { useConnected } from '../useConnected'
import { checksText, ghNote, prTone } from '../state/pullRequest'
import { Dialog } from './Dialog'

/** gh's state, read once per mount (and after a reconnect): it changes only when the user installs gh or signs in. */
export function useGhState(enabled: boolean): GhState | undefined {
  const [state, setState] = useState<GhState | undefined>(undefined)
  // A call made while the socket is down fails, and would read as gh missing.
  const connected = useConnected()
  useEffect(() => {
    if (!enabled || !connected) return
    let live = true
    api.github.state().then(
      (r) => {
        if (live) setState(r.gh)
      },
      () => {
        if (live) setState('missing')
      }
    )
    return () => {
      live = false
    }
  }, [enabled, connected])
  return state
}

/** The Open PR dialog: the branch, what it commits, and a title and body drafted from the card that the user can edit. */
export function PrDialog({ chat, onClose, onOpened }: { chat: ChatMeta; onClose: () => void; onOpened: (pr: ChatPr) => void }) {
  const [draft, setDraft] = useState<PrDraft | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [asDraft, setAsDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    api.github.draftPr(chat.id).then(
      (d) => {
        if (!live) return
        setDraft(d)
        setTitle(d.title)
        setBody(d.body)
      },
      (e: unknown) => {
        if (live) setError(errorMessage(e))
      }
    )
    return () => {
      live = false
    }
  }, [chat.id])
  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const pr = await api.github.createPr(chat.id, { title, body, draft: asDraft })
      onOpened(pr)
      onClose()
    } catch (e: unknown) {
      setError(errorMessage(e))
      setBusy(false)
    }
  }
  const refusal = draft?.refusal
  return (
    <Dialog title="Open a pull request" onClose={onClose} testId="pr-dialog">
      {draft === null ? (
        error === null ? (
          <p className="todo-card-hint" role="status">
            Reading the branch…
          </p>
        ) : (
          <div className="side-error" role="alert" data-testid="pr-error">
            {error}
          </div>
        )
      ) : (
        <>
          <p className="pr-branch" data-testid="pr-branch">
            <span className="pr-branch-name">{draft.branch}</span>
            <span className="todo-card-hint"> → the repository's default branch</span>
          </p>
          {draft.commits.length > 0 && (
            <ul className="pr-commits" data-testid="pr-commits">
              {draft.commits.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          {refusal !== undefined && (
            <div className="side-error" role="alert" data-testid="pr-refusal">
              {refusal}
            </div>
          )}
          <label className="pr-field">
            <span>Title</span>
            <input
              className="field"
              data-testid="pr-title"
              value={title}
              maxLength={PR_TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="pr-field">
            <span>Body</span>
            <textarea
              className="field"
              data-testid="pr-body"
              rows={8}
              value={body}
              maxLength={PR_BODY_MAX}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <label className="pr-draft">
            <input type="checkbox" data-testid="pr-as-draft" checked={asDraft} onChange={(e) => setAsDraft(e.target.checked)} />
            Open it as a draft
          </label>
          {error !== null && (
            <div className="side-error" role="alert" data-testid="pr-error">
              {error}
            </div>
          )}
          <div className="attempt-actions">
            <button
              type="button"
              className="btn small primary"
              data-testid="pr-create"
              disabled={busy || refusal !== undefined || title.trim() === ''}
              onClick={() => void create()}
            >
              {busy ? 'Pushing…' : 'Push and open the pull request'}
            </button>
            <button type="button" className="btn small" data-testid="pr-cancel" onClick={onClose}>
              Cancel
            </button>
          </div>
          <p className="todo-card-hint">
            The branch is pushed to <code>origin</code> as it is. Nothing is forced, and the default branch is never pushed to.
          </p>
        </>
      )}
    </Dialog>
  )
}

/**
 * What a chat's pull request shows wherever it is listed: its state, its checks, and for each failing check a link and
 * **Send to agent**, which posts the check and the tail of its log into the chat as an ordinary message.
 */
export function PrBox({ chat, onRefreshed }: { chat: ChatMeta; onRefreshed?: (pr: ChatPr) => void }) {
  const pr = chat.pr
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string[]>([])
  const refresh = useCallback(async (): Promise<void> => {
    setBusy('refresh')
    setError(null)
    try {
      const next = await api.github.refreshPr(chat.id)
      onRefreshed?.(next)
    } catch (e: unknown) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }, [chat.id, onRefreshed])
  if (!pr) return null
  const send = async (name: string): Promise<void> => {
    setBusy(name)
    setError(null)
    try {
      await api.github.sendCheck(chat.id, name)
      setSent((s) => [...s, name])
    } catch (e: unknown) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="pr-box" data-testid="pr-box" data-state={pr.state} data-checks={pr.checks?.status ?? 'none'}>
      <div className="pr-box-head">
        <a className="pr-number" data-testid="pr-link" href={pr.url} target="_blank" rel="noreferrer">
          #{pr.number}
        </a>
        <span className={`pr-state tone-${prTone(pr)}`} data-testid="pr-state">
          {pr.draft && pr.state === 'open' ? 'draft' : pr.state}
        </span>
        <span className="pr-checks" data-testid="pr-checks">
          {checksText(pr.checks)}
        </span>
        <span className="grow" />
        <button type="button" className="btn small" data-testid="pr-refresh" disabled={busy !== null} onClick={() => void refresh()}>
          {busy === 'refresh' ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {pr.checks && pr.checks.failing.length > 0 && (
        <ul className="pr-failing" data-testid="pr-failing">
          {pr.checks.failing.map((c) => (
            <li key={c.name} data-testid="pr-failing-row" data-name={c.name}>
              <span className="pr-check-name">
                {c.url ? (
                  <a href={c.url} target="_blank" rel="noreferrer">
                    {c.name}
                  </a>
                ) : (
                  c.name
                )}
              </span>
              <button
                type="button"
                className="btn small"
                data-testid="pr-send-check"
                disabled={busy !== null}
                data-tip="Posts the check and the tail of its log into this chat"
                onClick={() => void send(c.name)}
              >
                {sent.includes(c.name) ? 'Sent' : busy === c.name ? 'Sending…' : 'Send to agent'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {pr.error !== undefined && (
        <p className="todo-card-hint" data-testid="pr-read-error">
          Last read failed: {pr.error}
        </p>
      )}
      {error !== null && (
        <div className="side-error" role="alert" data-testid="pr-box-error">
          {error}
        </div>
      )}
    </div>
  )
}

/** Open PR… where a chat has a worktree branch and no pull request yet, with gh's own state said plainly instead. */
export function OpenPrButton({ chat, onOpened }: { chat: ChatMeta; onOpened: (pr: ChatPr) => void }) {
  const [open, setOpen] = useState(false)
  const gh = useGhState(true)
  const note = ghNote(gh)
  if (note !== null)
    return (
      <span className="todo-card-hint" data-testid="pr-gh-note">
        {note}
      </span>
    )
  return (
    <>
      <button type="button" className="btn small" data-testid="pr-open" disabled={gh === undefined} onClick={() => setOpen(true)}>
        Open PR…
      </button>
      {open && <PrDialog chat={chat} onClose={() => setOpen(false)} onOpened={onOpened} />}
    </>
  )
}

/** The chip beside the git chip: the PR's number, its state and its checks; a click opens it on GitHub. */
export function PrChip({ pr }: { pr: ChatPr | undefined }) {
  if (!pr) return null
  const checks = checksLine(pr.checks)
  return (
    <a
      className={`picker set pr-chip tone-${prTone(pr)}`}
      data-testid="chat-pr"
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      data-tip={[`Pull request #${pr.number}`, pr.url, checks ?? 'No checks reported', pr.error ? `Last read failed: ${pr.error}` : '']
        .filter(Boolean)
        .join('\n')}
    >
      <span className="picker-text">#{pr.number}</span>
      <span className="pr-chip-state">{pr.draft && pr.state === 'open' ? 'draft' : pr.state}</span>
      {pr.checks && (
        <span className={`pr-chip-dot ${pr.checks.status}`} aria-label={checks ?? ''} data-testid="chat-pr-checks">
          ●
        </span>
      )}
    </a>
  )
}
