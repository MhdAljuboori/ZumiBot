import { useEffect, useReducer, useRef, useState } from 'react'
import { CLONE_TITLE_MAX } from '@zumibot/shared/roomClone'
import type { ChatMeta } from '@zumibot/shared/types'
import { api } from '../api'
import { errorMessage } from '../errors'
import { coarsePointer } from '../media'
import { nextTrapIndex } from '../net/folderPicker'
import {
  closeAsks,
  cloneReducer,
  handoffCount,
  handoffOf,
  initialClone,
  primaryOf,
  summaryOffered,
  type CloneState
} from '../state/cloneRoom'
import { ConfirmDialog } from './ConfirmDialog'

interface Props {
  chat: ChatMeta
  /** Every chat's title, so the default name is not one already used. */
  takenTitles: string[]
  memberCount: number
  /** False when this tab knows there is nothing to summarize; the server checks again either way. */
  canSummarize: boolean
  onClose: () => void
  onCreated: (meta: ChatMeta) => void
}

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)'

const keepsLine = (n: number): string => `Keeps ${n} member${n === 1 ? '' : 's'}, role and folder. Messages stay behind.`

/** Clone room: a new room with the same members, role and folder, started over or from a summary the user reviewed. */
export function CloneRoomDialog({ chat, takenTitles, memberCount, canSummarize, onClose, onCreated }: Props) {
  const [s, dispatch] = useReducer(cloneReducer, null, () => initialClone(chat.title, takenTitles))
  const [confirm, setConfirm] = useState<'rewrite' | 'close' | null>(null)
  const dialog = useRef<HTMLDivElement>(null)
  // A summary's answer counts only while it is the latest call and the dialog still waits for it: leaving writing
  // bumps this, so a late draft or the Cancelled rejection of a stopped call is dropped.
  const request = useRef(0)

  const summarize = (): void => {
    const token = ++request.current
    api.chats.summarizeRoom(chat.id).then(
      (text) => {
        if (request.current === token) dispatch({ type: 'summaryReady', text })
      },
      (e: unknown) => {
        if (request.current === token) dispatch({ type: 'summaryFailed', error: errorMessage(e) })
      }
    )
  }

  // A failed cancel (offline) leaves a call the server's timeout ends; nothing here waits on it.
  const stopSummary = (): void => {
    request.current++
    api.chats.cancelSummary(chat.id).catch(() => undefined)
  }

  // Closing, Esc and the backdrop all unmount the dialog, so a call still running is stopped here, once.
  const step = useRef(s.step)
  step.current = s.step
  useEffect(
    () => () => {
      if (step.current === 'writing') stopSummary()
    },
    []
  )

  const close = (): void => {
    if (s.step === 'creating') return // the room may be made already: wait for the answer
    if (closeAsks(s)) setConfirm('close')
    else onClose()
  }

  const write = (): void => {
    // From choose with a kept draft this goes straight back to review: only Rewrite pays for a new call.
    const next = cloneReducer(s, { type: 'write' })
    dispatch({ type: 'write' })
    if (next.step === 'writing') summarize()
  }

  const rewriteNow = (): void => {
    dispatch({ type: 'rewrite' })
    summarize()
  }
  const rewrite = (): void => {
    if (s.step !== 'review') return
    if (s.edited) setConfirm('rewrite')
    else rewriteNow()
  }

  const cancelWriting = (): void => {
    stopSummary()
    dispatch({ type: 'cancelWriting' })
  }

  const create = (state: CloneState): void => {
    const handoff = handoffOf(state)
    dispatch({ type: 'create' })
    api.chats
      .cloneRoom(chat.id, state.name.trim(), handoff)
      .then(onCreated, (e: unknown) => dispatch({ type: 'createFailed', error: errorMessage(e) }))
  }

  const primary = primaryOf(s, canSummarize)
  const runPrimary = (): void => {
    if (!primary?.enabled) return
    if (primary.kind === 'create') create(s)
    else write()
  }

  // Read by the window's key handler, which is added once.
  const keys = useRef({ confirm, close })
  keys.current = { confirm, close }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (keys.current.confirm !== null || e.isComposing) return // the confirm on top has the key
      if (e.key === 'Escape') {
        e.preventDefault()
        keys.current.close()
      } else if (e.key === 'Tab') {
        const items = Array.from(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
        const to = nextTrapIndex(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey)
        if (to !== null) {
          e.preventDefault()
          items[to].focus()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // A step change removes the focused button: keep the keyboard in the dialog.
  useEffect(() => {
    const el = dialog.current
    if (el && !el.contains(document.activeElement)) el.focus()
  }, [s.step])

  const creating = s.step === 'creating'
  // While creating, the step it came from stays on screen with everything disabled.
  const shown = creating ? s.from : s.step
  const offered = summaryOffered(s, canSummarize)
  const count = shown === 'review' ? handoffCount(s.text) : null

  const createButton = (
    <button
      type="button"
      className="btn primary"
      data-testid="clone-create"
      disabled={!primary?.enabled || primary.kind !== 'create'}
      onClick={runPrimary}
    >
      {creating ? 'Creating…' : 'Create room'}
    </button>
  )

  return (
    <>
      <div className="modal-backdrop clone-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div
          ref={dialog}
          tabIndex={-1}
          className="modal clone-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="clone-title"
          aria-busy={s.step === 'writing' || creating}
          data-testid="clone-dialog"
          data-step={s.step}
        >
          <h2 id="clone-title" className="modal-title">
            {shown === 'review' ? 'Review summary' : 'Clone room'}
          </h2>

          {shown === 'choose' && (
            <div className="clone-body">
              <label className="clone-label" htmlFor="clone-name">
                Name
              </label>
              <input
                id="clone-name"
                className="field clone-name"
                data-testid="clone-name"
                value={s.name}
                maxLength={CLONE_TITLE_MAX}
                disabled={creating}
                // A phone's keyboard would cover the options.
                autoFocus={!coarsePointer()}
                onChange={(e) => dispatch({ type: 'name', name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  runPrimary()
                }}
              />
              <p className="clone-keeps">{keepsLine(memberCount)}</p>
              <div className="clone-options">
                <button
                  type="button"
                  className="clone-option"
                  data-testid="clone-option-fresh"
                  aria-pressed={s.option === 'fresh'}
                  disabled={creating}
                  onClick={() => dispatch({ type: 'option', option: 'fresh' })}
                >
                  <span className="clone-option-title">Start over</span>
                  <span className="clone-option-sub">Members start with no memory of this room.</span>
                </button>
                <button
                  type="button"
                  className="clone-option"
                  data-testid="clone-option-summary"
                  aria-pressed={s.option === 'summary'}
                  disabled={creating || !offered}
                  onClick={() => dispatch({ type: 'option', option: 'summary' })}
                >
                  <span className="clone-option-title">With summary</span>
                  <span className="clone-option-sub">
                    {offered ? 'Members read a handoff note you check first.' : 'Nothing to summarize yet'}
                  </span>
                </button>
              </div>
            </div>
          )}

          {shown === 'writing' && (
            <div className="clone-body clone-writing" role="status" data-testid="clone-writing">
              <span className="spinner" aria-hidden="true" />
              <div>
                <div className="clone-writing-title">Writing summary…</div>
                <div className="clone-hint">It reads the room's messages. This can take a minute.</div>
              </div>
            </div>
          )}

          {shown === 'review' && (
            <div className="clone-body clone-review">
              <p className="clone-for">
                For <strong>{s.name.trim()}</strong>
              </p>
              <textarea
                className="field clone-text"
                data-testid="clone-text"
                aria-label="Handoff note"
                dir="auto"
                value={s.text}
                disabled={creating}
                onChange={(e) => dispatch({ type: 'edit', text: e.target.value })}
              />
              <div className="clone-text-foot">
                <span className="clone-hint">Edit freely. Agents read exactly this.</span>
                {count && (
                  <span className={count.over ? 'clone-count over' : 'clone-count'} data-testid="clone-count">
                    {count.label}
                  </span>
                )}
              </div>
            </div>
          )}

          {s.error !== null && (
            <p className="clone-error" role="alert" data-testid="clone-error">
              {s.error}
            </p>
          )}

          <div className="modal-buttons clone-buttons">
            {shown === 'choose' && (
              <>
                <button type="button" className="btn" data-testid="clone-cancel" disabled={creating} onClick={close}>
                  Cancel
                </button>
                {s.option === 'fresh' ? (
                  createButton
                ) : (
                  <button type="button" className="btn primary" data-testid="clone-write" disabled={!primary?.enabled} onClick={runPrimary}>
                    {s.draft === null ? 'Write summary' : 'Review summary'}
                  </button>
                )}
              </>
            )}
            {shown === 'writing' && (
              <button type="button" className="btn" data-testid="clone-cancel" autoFocus onClick={cancelWriting}>
                Cancel
              </button>
            )}
            {shown === 'review' && (
              <>
                <button type="button" className="btn" data-testid="clone-rewrite" disabled={creating} onClick={rewrite}>
                  Rewrite
                </button>
                <span className="modal-spacer" />
                <button
                  type="button"
                  className="btn"
                  data-testid="clone-back"
                  disabled={creating}
                  onClick={() => dispatch({ type: 'back' })}
                >
                  Back
                </button>
                {createButton}
              </>
            )}
            {shown === 'failed' && (
              <>
                <button type="button" className="btn" data-testid="clone-back" onClick={() => dispatch({ type: 'back' })}>
                  Back
                </button>
                <button type="button" className="btn primary" data-testid="clone-write" autoFocus onClick={runPrimary}>
                  Try again
                </button>
              </>
            )}
          </div>
        </div>
      </div>
      {confirm && (
        <ConfirmDialog
          title="Discard this summary?"
          message={confirm === 'rewrite' ? 'A new summary replaces your edits.' : 'Your edits to the summary will be lost.'}
          buttons={[
            { label: 'Keep editing', value: 'keep' },
            { label: confirm === 'rewrite' ? 'Rewrite' : 'Discard', value: 'discard', danger: true }
          ]}
          onResolve={(value) => {
            const what = confirm
            setConfirm(null)
            if (value !== 'discard') return
            if (what === 'rewrite') rewriteNow()
            else onClose()
          }}
        />
      )}
    </>
  )
}
