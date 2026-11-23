import { useEffect, useRef, useState } from 'react'
import type { ItemRun, Port, Step, Visit, WorkflowRun } from '@zumibot/shared/workflows'
import { APPROVAL_TEXT_MAX, progressOf } from '@zumibot/shared/workflows'
import { errorMessage } from '../errors'
import {
  HANDLED_TEXT,
  ITEM_WORDS,
  approvalQuestion,
  canRetry,
  canRetryItem,
  costText,
  durationText,
  itemsCountText,
  pausedSlot,
  progressText,
  requestLine,
  runHref,
  visitPauseText,
  visitState,
  waitsUntil
} from '../state/workflowRun'
import { stateLabel } from '../state/workflowEditor'
import { AppLink } from './AppLink'
import { ExpandButton, ExpandDialog } from './ExpandDialog'
import { Markdown } from './Markdown'
import { StepIcon } from './WorkflowIcons'

// A visit is one go of a step in a run. Everything that came from an agent, a model or a webhook is untrusted text, so
// it is only ever drawn through Markdown (which never takes raw HTML), or as plain text.

/** What the panels can do to a run. Each rejects with the server's own fixed sentence ("Already answered"). */
export interface RunActions {
  approve: (visitId: string, ok: boolean, text: string | undefined, note: string) => Promise<void>
  /** itemId: only that failed item of a For each visit runs again. */
  retry: (visitId: string, itemId?: string) => Promise<void>
}

const PORT_WORDS: Partial<Record<Port, string>> = { yes: 'Yes', no: 'No', approved: 'Approved', rejected: 'Rejected' }
const NOTE_MAX = 2000 // APPROVAL_NOTE_MAX on the server
const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** The waiting approval: its question, the text to approve (editable when the step says so), a note, and the two answers. */
export function ApprovalBox({
  visit,
  step,
  onApprove
}: {
  visit: Visit
  step: Extract<Step, { kind: 'approval' }>
  onApprove: RunActions['approve']
}) {
  const [text, setText] = useState(visit.input)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The box leaves with the answer (a refetch), so an unmounted answer must not set state.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true // StrictMode re-runs effects after a simulated unmount
    return () => {
      alive.current = false
    }
  }, [])

  const answer = (ok: boolean): void => {
    setBusy(true)
    setError(null)
    onApprove(visit.id, ok, step.editable ? text : undefined, note.trim())
      .catch((e: unknown) => {
        if (alive.current) setError(errorMessage(e))
      })
      .finally(() => {
        if (alive.current) setBusy(false)
      })
  }

  return (
    <section className="wf-approval" data-testid="wf-approval" aria-label="Approval needed">
      <div className="wf-approval-q" data-testid="wf-approval-question">
        <Markdown text={approvalQuestion(visit, step)} />
      </div>
      {step.editable ? (
        <textarea
          className="rt-input wf-approval-text"
          data-testid="wf-approval-text"
          aria-label="Text to approve"
          rows={7}
          maxLength={APPROVAL_TEXT_MAX}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <div className="wf-visit-text" data-testid="wf-approval-readonly">
          {visit.input === '' ? <span className="rt-hint">Nothing to approve.</span> : <Markdown text={visit.input} />}
        </div>
      )}
      <input
        className="rt-input wf-approval-note"
        data-testid="wf-approval-note"
        aria-label="Note (optional)"
        placeholder="Note (optional)"
        maxLength={NOTE_MAX}
        value={note}
        disabled={busy}
        onChange={(e) => setNote(e.target.value)}
      />
      {error && (
        <div className="rt-hint rt-bad" data-testid="wf-approval-error" role="alert">
          {error}
        </div>
      )}
      <div className="wf-approval-buttons">
        <button type="button" className="btn wf-approve" data-testid="wf-approve" disabled={busy} onClick={() => answer(true)}>
          Approve
        </button>
        <button type="button" className="btn wf-reject" data-testid="wf-reject" disabled={busy} onClick={() => answer(false)}>
          Reject
        </button>
      </div>
    </section>
  )
}

/** A visit's (or the run's) input or output, read-only, with Expand opening it at a size made for reading. */
export function VisitText({
  label,
  text,
  testId,
  title = label
}: {
  label: string
  text: string | undefined
  testId: string
  title?: string
}) {
  const opener = useRef<HTMLButtonElement>(null)
  const [big, setBig] = useState(false)
  if (text === undefined) return null
  return (
    <div className="wf-visit-part">
      <div className="wf-field-head">
        <div className="rt-label">{label}</div>
        {text !== '' && <ExpandButton ref={opener} label={label} testId={`${testId}-expand`} onClick={() => setBig(true)} />}
      </div>
      <div className="wf-visit-text" data-testid={testId}>
        {text === '' ? <span className="rt-hint">Empty.</span> : <Markdown text={text} />}
      </div>
      {big && (
        <ExpandDialog
          title={title}
          testId={`${testId}-dialog`}
          onClose={() => {
            setBig(false)
            opener.current?.focus()
          }}
        >
          <div className="wf-visit-text wf-expand-read" data-testid={`${testId}-big`} tabIndex={0} autoFocus>
            <Markdown text={text} />
          </div>
        </ExpandDialog>
      )}
    </div>
  )
}

/** One For each visit's items: number, text, state, what it cost, its chat, its reply or error, and Retry for a failed one. */
function ItemList({
  run,
  visit,
  actions,
  onOpenChat
}: {
  run: WorkflowRun
  visit: Visit
  actions: RunActions
  onOpenChat: (chatId: string) => void
}) {
  const items = visit.items ?? []
  const [retrying, setRetrying] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true // StrictMode re-runs effects after a simulated unmount
    return () => {
      alive.current = false
    }
  }, [])
  // The item in hand stays in view inside the list's own scroll, never moving the page the reader is on.
  const liveId = items.find((i) => i.status === 'running' || i.status === 'waiting')?.id
  const list = useRef<HTMLUListElement>(null)
  const live = useRef<HTMLLIElement>(null)
  useEffect(() => {
    const box = list.current
    const el = live.current
    if (!box || !el) return
    if (el.offsetTop < box.scrollTop) box.scrollTop = el.offsetTop
    else if (el.offsetTop + el.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = el.offsetTop + el.offsetHeight - box.clientHeight
  }, [liveId])

  const retry = (item: ItemRun): void => {
    setRetrying(item.id)
    setRetryError(null)
    actions
      .retry(visit.id, item.id)
      .catch((e: unknown) => {
        if (alive.current) setRetryError(errorMessage(e))
      })
      .finally(() => {
        if (alive.current) setRetrying(null)
      })
  }

  return (
    <>
      {retryError && (
        <div className="rt-hint rt-bad" data-testid="wf-item-retry-error" role="alert">
          {retryError}
        </div>
      )}
      <ul className="wf-items" data-testid="wf-items" ref={list}>
        {items.map((item) => {
          const until = item.status === 'running' || item.status === 'waiting' ? item.until : undefined
          const cost = costText(item.costUsd)
          // Paused by the user: still open (its status says running), so the item in hand until Resume.
          const state = pausedSlot(item) ? 'paused' : item.status
          const pause = visitPauseText(item)
          return (
            <li
              key={item.id}
              ref={item.id === liveId ? live : undefined}
              className="wf-item"
              data-testid="wf-item"
              data-status={item.status}
              data-state={state}
              data-item-n={item.n}
            >
              <div className="wf-item-head">
                <span className="wf-item-n">{item.n}</span>
                <span className={`routine-dot wf-item-dot ${state}`} role="img" aria-label={ITEM_WORDS[state]} data-tip={ITEM_WORDS[state]} />
                <span className="wf-item-text" data-tip={item.text}>
                  {item.text}
                </span>
                {cost && (
                  <span className="wf-item-cost" data-testid="wf-item-cost" data-tip="API estimate, in USD">
                    {cost}
                  </span>
                )}
              </div>
              {until !== undefined && (
                <div className="rt-hint" data-testid="wf-item-until">
                  Waits until {timeOf(until)}.
                </div>
              )}
              {pause && (
                <div className="rt-hint" data-testid="wf-item-paused">
                  {pause}
                </div>
              )}
              <VisitText label="Output" text={item.output} testId="wf-item-output" title={`Output · Item ${item.n} · Visit ${visit.n}`} />
              {item.error && (
                <div className="wf-visit-error wf-item-error" data-testid="wf-item-error" role="alert">
                  {item.error}
                </div>
              )}
              {(item.chatId || canRetryItem(run, visit, item)) && (
                <div className="wf-visit-actions">
                  {item.chatId && (
                    <button type="button" className="btn" data-testid="wf-item-open-chat" onClick={() => onOpenChat(item.chatId as string)}>
                      Open chat
                    </button>
                  )}
                  {canRetryItem(run, visit, item) && (
                    <button
                      type="button"
                      className="btn"
                      data-testid="wf-item-retry"
                      disabled={retrying !== null}
                      onClick={() => retry(item)}
                    >
                      {retrying === item.id ? 'Retrying…' : 'Retry'}
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}

/**
 * A For each visit's counter and item list. On a phone (`named`) the list sits behind a row that shows the progress, since
 * the timeline mixes every step's visits; on a wide screen the panel is about this one step, so the list is open.
 */
function ItemsSection({
  run,
  visit,
  named,
  actions,
  onOpenChat
}: {
  run: WorkflowRun
  visit: Visit
  named: boolean
  actions: RunActions
  onOpenChat: (chatId: string) => void
}) {
  const items = visit.items ?? []
  const [open, setOpen] = useState(false)
  const progress = progressOf({ visits: [visit] })[0]
  const showList = items.length > 0 && (!named || open)
  return (
    <div className="wf-visit-part">
      {named && items.length > 0 && (
        <button
          type="button"
          className="wf-timeline-progress"
          data-testid="wf-timeline-progress"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="wf-timeline-progress-text">
            {progress ? progressText(progress) : `${items.length} ${items.length === 1 ? 'item' : 'items'}`}
          </span>
          <span className="wf-timeline-progress-caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
        </button>
      )}
      <div className="rt-hint wf-items-count" data-testid="wf-items-count">
        {items.length === 0 ? 'No items' : itemsCountText(items)}
      </div>
      {showList && <ItemList run={run} visit={visit} actions={actions} onOpenChat={onOpenChat} />}
    </div>
  )
}

interface Props {
  run: WorkflowRun
  visit: Visit
  step: Step | undefined
  now: number
  /** Show the step's name and icon on the card (the phone list mixes steps; the panel is already about one). */
  named?: boolean
  /** The approval box shows here when this visit waits on one; the phone shows the oldest one at the top instead. */
  answerable: boolean
  actions: RunActions
  onOpenChat: (chatId: string) => void
}

/** One visit: its status, input and output, what a Condition or Approval added, what went wrong, and what can be done. */
export function VisitPanel({ run, visit, step, now, named = false, answerable, actions, onOpenChat }: Props) {
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true // StrictMode re-runs effects after a simulated unmount
    return () => {
      alive.current = false
    }
  }, [])

  const retry = (): void => {
    setRetrying(true)
    setRetryError(null)
    actions
      .retry(visit.id)
      .catch((e: unknown) => {
        if (alive.current) setRetryError(errorMessage(e))
      })
      .finally(() => {
        if (alive.current) setRetrying(false)
      })
  }
  const waitingApproval = visit.status === 'waiting' && step?.kind === 'approval'
  const ended = visit.endedAt ?? (visit.status === 'running' ? now : undefined)
  const until = waitsUntil(visit)
  const state = visitState(visit)
  const pause = visitPauseText(visit)
  const cost = costText(visit.costUsd)
  // The dialog stands alone, so its title says whose input or output it is.
  const titleOf = (label: string): string => `${label} · ${step?.name.trim() || 'A step'} · Visit ${visit.n}`

  return (
    <article className="wf-visit" data-testid="wf-visit" data-visit-id={visit.id} data-status={visit.status}>
      <header className="wf-visit-head">
        {named && step && (
          <span className="wf-visit-ic">
            <StepIcon kind={step.kind} />
          </span>
        )}
        {named && <span className="wf-visit-name">{step?.name.trim() || 'A step'}</span>}
        <span className="wf-visit-meta">
          <span className="wf-visit-n">Visit {visit.n}</span>
          <span className={`wf-visit-status ${state}`} data-testid="wf-visit-status">
            {stateLabel(state)}
          </span>
          {ended !== undefined && <span className="wf-visit-time">{durationText(visit.startedAt, ended)}</span>}
          {cost && (
            <span className="wf-visit-cost" data-testid="wf-visit-cost" data-tip="API estimate, in USD">
              {cost}
            </span>
          )}
        </span>
      </header>
      {waitingApproval && answerable && step.kind === 'approval' && <ApprovalBox visit={visit} step={step} onApprove={actions.approve} />}
      {until !== null && (
        <div className="rt-hint" data-testid="wf-visit-until">
          Waits until {new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
        </div>
      )}
      {pause && (
        <div className="rt-hint" data-testid="wf-visit-paused">
          {pause}
        </div>
      )}
      {visit.http && (
        <div className="wf-audit-call" data-testid="wf-visit-request">
          {requestLine(visit.http)}
        </div>
      )}
      {step?.kind === 'workflow' && visit.status === 'waiting' && (
        <div className="rt-hint" data-testid="wf-visit-sub-waiting">
          Its run waits on you: open it to answer.
        </div>
      )}
      {!(waitingApproval && answerable) && <VisitText label="Input" text={visit.input} testId="wf-visit-input" title={titleOf('Input')} />}
      {visit.items && <ItemsSection run={run} visit={visit} named={named} actions={actions} onOpenChat={onOpenChat} />}
      {visit.port !== undefined && PORT_WORDS[visit.port] && (
        <div className="wf-visit-answer" data-testid="wf-visit-port">
          Answer: <strong>{PORT_WORDS[visit.port]}</strong>
        </div>
      )}
      {visit.reason && (
        <div className="wf-visit-reason" data-testid="wf-visit-reason">
          <div className="rt-label">Reason</div>
          <Markdown text={visit.reason} />
        </div>
      )}
      {visit.note && (
        <div className="wf-visit-reason" data-testid="wf-visit-note">
          <div className="rt-label">Note</div>
          <Markdown text={visit.note} />
        </div>
      )}
      <VisitText label="Output" text={visit.output} testId="wf-visit-output" title={titleOf('Output')} />
      {visit.missing && visit.missing.length > 0 && (
        <div className="rt-hint rt-bad" data-testid="wf-visit-missing">
          Missing fields: {visit.missing.join(', ')}
        </div>
      )}
      {visit.error && (
        <div className="wf-visit-error" data-testid="wf-visit-error" role="alert">
          {visit.error}
        </div>
      )}
      {visit.status === 'failed' && visit.port === 'error' && (
        <div className="rt-hint" data-testid="wf-visit-handled">
          {HANDLED_TEXT}
        </div>
      )}
      {retryError && (
        <div className="rt-hint rt-bad" data-testid="wf-retry-error" role="alert">
          {retryError}
        </div>
      )}
      <div className="wf-visit-actions">
        {visit.chatId && (
          <button type="button" className="btn" data-testid="wf-open-chat" onClick={() => onOpenChat(visit.chatId as string)}>
            Open chat
          </button>
        )}
        {visit.childRunId && step?.kind === 'workflow' && (
          <AppLink href={runHref(step.workflow, visit.childRunId)} className="btn" testId="wf-open-run">
            Open run
          </AppLink>
        )}
        {canRetry(run, visit) && (
          <button type="button" className="btn" data-testid="wf-retry" disabled={retrying} onClick={retry}>
            {retrying ? 'Retrying…' : 'Retry'}
          </button>
        )}
      </div>
    </article>
  )
}
