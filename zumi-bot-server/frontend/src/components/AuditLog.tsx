import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { NOTIFY_TITLE_MAX, type ItemRun, type WorkflowRun } from '@zumibot/shared/workflows'
import { errorMessage } from '../errors'
import { auditLog, clockTime, foldText, type AuditEntry, type AuditTrigger } from '../state/auditLog'
import { fenced } from '../state/workflowMessage'
import {
  HANDLED_TEXT,
  ITEM_WORDS,
  canRetry,
  canRetryItem,
  costText,
  durationText,
  itemsCountText,
  parentLine,
  requestLine,
  runCostText,
  runHref
} from '../state/workflowRun'
import { STEP_LABELS } from '../state/workflowCanvas'
import { runStatusLabel } from '../state/workflowEditor'
import { ExpandButton, ExpandDialog } from './ExpandDialog'
import { Markdown } from './Markdown'
import { AppLink } from './AppLink'
import type { RunActions } from './VisitPanel'
import { StepIcon, TriggerKindIcon } from './WorkflowIcons'

// A finished run read top to bottom. Every text here came from an agent, a model, a webhook or the user, so it is only
// drawn through Markdown (which never takes raw HTML) or as plain text, as in the visit panel. The run's own errors carry
// no role="alert" (a refused Retry does): they are history here, and a log of several would each be read out on
// opening it. Read-only, except Retry where the caller passes actions (the phone, which has no canvas inspector).

interface TextProps {
  label: string
  text: string | undefined
  testId: string
  /** The Expand dialog's title, which stands alone: `Output · Review PR · Visit 2`. */
  title?: string
  /** A quieter box (a left rule) for the short texts around the input and output: Asked, Reason, Your note. */
  note?: boolean
  /** The Approval's Output when the user changed the text before approving. */
  edited?: boolean
  /** Shown as a JSON code block (a webhook's body). */
  json?: boolean
  /** Drawn above the text, inside the box (the title a Notify sent). With it, a missing or empty text shows nothing. */
  lead?: ReactNode
}

/**
 * One text of the log, folded to a preview with Show all, and Expand opening it whole at a size made for reading. Only
 * the preview is parsed until Show all, so a long run of long outputs stays light.
 */
export function AuditText({ label, text, testId, title = label, note = false, edited = false, json = false, lead }: TextProps) {
  const opener = useRef<HTMLButtonElement>(null)
  const [big, setBig] = useState(false)
  const [all, setAll] = useState(false)
  const blank = text === undefined || text.trim() === ''
  const fold = useMemo(() => (text && !blank ? foldText(text) : null), [text, blank])
  if (text === undefined && lead === undefined) return null
  const whole = text ?? ''
  const folded = fold !== null && fold.more && !all
  const md = (t: string): string => (json ? fenced(t, 'json') : t)
  // A preview renders live: one cut inside a ```mermaid fence stays code, so no half diagram is parsed and the Mermaid
  // chunk stays unloaded until Show all.
  return (
    <div className={`wf-audit-box${note ? ' note' : ''}`} data-testid={testId}>
      <div className="wf-field-head">
        <div className="wf-audit-label">
          <span className="rt-label">{label}</span>
          {edited && (
            <span className="rt-tag wf-audit-edited" data-testid="wf-audit-edited">
              edited
            </span>
          )}
        </div>
        {!blank && <ExpandButton ref={opener} label={label} testId={`${testId}-expand`} onClick={() => setBig(true)} />}
      </div>
      {lead}
      {blank ? (
        lead === undefined && <span className="rt-hint">Empty.</span>
      ) : (
        <div className={`wf-audit-text${folded ? ' folded' : ''}`}>
          <Markdown text={md(folded && fold ? fold.preview : whole)} live={folded} />
        </div>
      )}
      {fold?.more && (
        <button type="button" className="wf-audit-more" data-testid="wf-audit-more" aria-expanded={all} onClick={() => setAll((a) => !a)}>
          {all ? 'Show less' : 'Show all'}
        </button>
      )}
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
            <Markdown text={md(whole)} />
          </div>
        </ExpandDialog>
      )}
    </div>
  )
}

/** Clock times, how long it took and what it cost, joined by dots; a part that is not known is left out. */
function metaText(from: number, to: number | null, timeZone: string, cost: string | null, waited = false): string {
  const span = to === null ? null : durationText(from, to)
  return [
    to === null ? clockTime(from, timeZone) : `${clockTime(from, timeZone)} → ${clockTime(to, timeZone)}`,
    span && (waited ? `Waited ${span}` : span),
    cost
  ]
    .filter(Boolean)
    .join(' · ')
}

/** A Retry in flight: its button waits while it is out, and a refusal shows under it. Keyed, so an item's is its own. */
function useRetry(): { busy: string | null; error: string | null; start: (key: string, go: () => Promise<void>) => void } {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A Retry that runs swaps the log for the visit list (the run is going again), so a late answer must not set state.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true // StrictMode re-runs effects after a simulated unmount
    return () => {
      alive.current = false
    }
  }, [])
  const start = (key: string, go: () => Promise<void>): void => {
    setBusy(key)
    setError(null)
    go()
      .catch((e: unknown) => {
        if (alive.current) setError(errorMessage(e))
      })
      .finally(() => {
        if (alive.current) setBusy(null)
      })
  }
  return { busy, error, start }
}

function TriggerEntry({ trigger, run, timeZone }: { trigger: AuditTrigger; run: WorkflowRun; timeZone: string }) {
  const title = (label: string): string => `${label} · Trigger`
  // A skipped run's filter turned the call away, so its first dot says so rather than "done".
  const dot = run.status === 'skipped' ? 'skipped' : 'done'
  return (
    <li className="wf-audit-ev" data-testid="wf-audit-trigger">
      <span className={`wf-audit-dot ${dot}`} aria-hidden="true">
        1
      </span>
      <div className="wf-audit-body">
        <div className="wf-audit-top">
          <span className="wf-visit-ic">
            {trigger.via === 'workflow' ? <StepIcon kind="workflow" /> : <TriggerKindIcon kind={trigger.icon} />}
          </span>
          <span className="wf-audit-name">Trigger</span>
          <span className="rt-tag rt-tag-plain">{trigger.label}</span>
          {trigger.late && <span className="rt-tag">late</span>}
          <span className="wf-audit-meta">{clockTime(trigger.at, timeZone)}</span>
        </div>
        {trigger.callLine && <div className="wf-audit-call">{trigger.callLine}</div>}
        {trigger.condition && (
          <div className="rt-hint wf-audit-condition" data-testid="wf-audit-condition">
            {trigger.condition}
          </div>
        )}
        {(() => {
          const parent = parentLine(run)
          return (
            parent && (
              <AppLink href={parent.href} className="wf-audit-link" testId="wf-audit-parent">
                {parent.text} →
              </AppLink>
            )
          )
        })()}
        {trigger.body !== null && (
          <AuditText
            label={trigger.via === 'chat' ? 'Chat' : 'Event'}
            text={JSON.stringify(trigger.body, null, 2)}
            testId="wf-audit-trigger-body"
            title={title(trigger.via === 'chat' ? 'Chat' : 'Event')}
            json
          />
        )}
        {trigger.text === '' && <div className="rt-hint wf-audit-none">No input.</div>}
        {trigger.text && (
          <AuditText
            label={trigger.via === 'webhook' ? 'Body' : 'Input'}
            text={trigger.text}
            testId="wf-audit-trigger-text"
            title={title(trigger.via === 'webhook' ? 'Body' : 'Input')}
            json={trigger.via === 'webhook' && run.call?.body !== null && run.call?.body !== undefined}
          />
        )}
      </div>
    </li>
  )
}

/** What every entry reads besides its own visit. actions: Retry is offered (the phone); absent, the log is read-only. */
interface Ctx {
  run: WorkflowRun
  timeZone: string
  workflowName: string
  actions?: RunActions
  onOpenChat: (chatId: string) => void
}

type Retry = ReturnType<typeof useRetry>

/** A For each visit's items: each with its outcome, output and error, and Retry for a failed one where the run allows it. */
function Items({ e, ctx, retry, title }: { e: AuditEntry; ctx: Ctx; retry: Retry; title: (label: string) => string }) {
  const items = e.items ?? []
  const { run, actions, onOpenChat } = ctx
  return (
    <div className="wf-audit-items">
      <div className="wf-audit-label">
        <span className="rt-label">Items ({items.length})</span>
        <span className="rt-hint wf-items-count">{items.length === 0 ? 'No items' : itemsCountText(items)}</span>
      </div>
      {items.length > 0 && (
        <ol className="wf-audit-item-list">
          {items.map((item) => {
            const cost = costText(item.costUsd)
            const span = item.startedAt !== undefined && item.endedAt !== undefined ? durationText(item.startedAt, item.endedAt) : null
            const retryable = actions !== undefined && canRetryItem(run, e.visit, item)
            return (
              <li key={item.id} className="wf-audit-item" data-testid="wf-audit-item" data-status={item.status} data-item-n={item.n}>
                <div className="wf-audit-item-head">
                  <span className="wf-item-n">{item.n}</span>
                  <span className={`routine-dot wf-item-dot ${item.status}`} aria-hidden="true" />
                  <span className="wf-audit-item-text" data-tip={item.text}>
                    {item.text}
                  </span>
                  <span className={`wf-audit-item-status ${item.status}`}>{ITEM_WORDS[item.status]}</span>
                  {item.carried && (
                    <span className="rt-tag rt-tag-plain" data-testid="wf-audit-carried">
                      from an earlier visit
                    </span>
                  )}
                  {(span || cost) && <span className="wf-audit-meta">{[span, cost].filter(Boolean).join(' · ')}</span>}
                  {(item.chatId || retryable) && (
                    <span className="wf-audit-actions">
                      {item.chatId && (
                        <button
                          type="button"
                          className="wf-audit-link"
                          data-testid="wf-audit-item-open-chat"
                          onClick={() => onOpenChat(item.chatId as string)}
                        >
                          Open chat →
                        </button>
                      )}
                      {retryable && actions && (
                        <button
                          type="button"
                          className="btn wf-audit-retry"
                          data-testid="wf-item-retry"
                          disabled={retry.busy !== null}
                          onClick={() => retry.start(item.id, () => actions.retry(e.visit.id, item.id))}
                        >
                          {retry.busy === item.id ? 'Retrying…' : 'Retry'}
                        </button>
                      )}
                    </span>
                  )}
                </div>
                <AuditText label="Output" text={item.output} testId="wf-audit-item-output" title={title(`Output · Item ${item.n}`)} />
                {item.error && (
                  <div className="wf-visit-error" data-testid="wf-audit-item-error">
                    {item.error}
                  </div>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

function Entry({ e, ctx }: { e: AuditEntry; ctx: Ctx }) {
  const { visit, step, kind } = e
  const { run, timeZone, workflowName, actions, onOpenChat } = ctx
  const retry = useRetry()
  const title = (label: string): string => `${label} · ${e.name} · Visit ${visit.n}`
  const agent = step && (step.kind === 'agent' || step.kind === 'foreach') && step.agent ? ` · @${step.agent}` : ''
  // A For each's joined output comes after its items, so the list reads before what was made of it.
  const output = e.showOutput && kind !== 'foreach' ? visit.output : undefined
  const retryable = actions !== undefined && canRetry(run, visit)
  // As the server sends it: a title that filled empty goes out as the workflow's name.
  const sentTitle = visit.title?.trim() ? visit.title : workflowName.slice(0, NOTIFY_TITLE_MAX)
  return (
    <li
      className="wf-audit-ev"
      data-testid="wf-audit-entry"
      data-step-id={visit.stepId}
      data-kind={kind ?? undefined}
      data-status={visit.status}
    >
      <span className={`wf-audit-dot ${visit.status}`} aria-hidden="true">
        {e.n}
      </span>
      <div className="wf-audit-body">
        <div className="wf-audit-top">
          {kind && (
            <span className="wf-visit-ic">
              <StepIcon kind={kind} />
            </span>
          )}
          <span className="wf-audit-name">{e.name}</span>
          {kind && (
            <span className="rt-tag rt-tag-plain wf-audit-kind">
              {STEP_LABELS[kind]}
              {agent}
            </span>
          )}
          {e.visitLabel && <span className="wf-visit-n">{e.visitLabel}</span>}
          <span className={`wf-visit-status ${visit.status}`}>{runStatusLabel(visit.status)}</span>
          {e.answer && <span className={`wf-audit-answer ${visit.port ?? ''}`}>→ {e.answer}</span>}
          <span className="wf-audit-meta">{metaText(visit.startedAt, e.endedAt, timeZone, costText(visit.costUsd), kind === 'wait')}</span>
          {(visit.chatId || visit.childRunId || retryable) && (
            <span className="wf-audit-actions">
              {visit.chatId && (
                <button
                  type="button"
                  className="wf-audit-link"
                  data-testid="wf-audit-open-chat"
                  onClick={() => onOpenChat(visit.chatId as string)}
                >
                  Open chat →
                </button>
              )}
              {visit.childRunId && step?.kind === 'workflow' && (
                <AppLink href={runHref(step.workflow, visit.childRunId)} className="wf-audit-link" testId="wf-audit-open-run">
                  Open run →
                </AppLink>
              )}
              {retryable && actions && (
                <button
                  type="button"
                  className="btn wf-audit-retry"
                  data-testid="wf-retry"
                  disabled={retry.busy !== null}
                  onClick={() => retry.start('visit', () => actions.retry(visit.id))}
                >
                  {retry.busy === 'visit' ? 'Retrying…' : 'Retry'}
                </button>
              )}
            </span>
          )}
        </div>
        {retry.error && (
          <div className="rt-hint rt-bad" data-testid="wf-retry-error" role="alert">
            {retry.error}
          </div>
        )}
        {kind === 'notify' && (visit.title !== undefined || visit.body !== undefined) && (
          // The body holds up to 20 000 characters, so it folds like every other box.
          <AuditText
            label="Sent"
            text={visit.body}
            testId="wf-audit-sent"
            title={title('Sent')}
            lead={<div className="wf-audit-sent-title">{sentTitle}</div>}
          />
        )}
        {e.question !== null && <AuditText label="Asked" text={e.question} testId="wf-audit-asked" title={title('Asked')} note />}
        {visit.http && (
          <div className="wf-audit-call" data-testid="wf-audit-request">
            {requestLine(visit.http)}
          </div>
        )}
        <div className={`wf-audit-io${output === undefined ? ' one' : ''}`}>
          <AuditText label="Input" text={visit.input} testId="wf-audit-input" title={title('Input')} />
          {output !== undefined && (
            <AuditText label="Output" text={output} testId="wf-audit-output" title={title('Output')} edited={e.edited} />
          )}
        </div>
        {visit.reason !== undefined && (
          <AuditText label="Reason" text={visit.reason} testId="wf-audit-reason" title={title('Reason')} note />
        )}
        {visit.note && <AuditText label="Your note" text={visit.note} testId="wf-audit-note" title={title('Your note')} note />}
        {e.items && <Items e={e} ctx={ctx} retry={retry} title={title} />}
        {kind === 'foreach' && <AuditText label="Output" text={visit.output} testId="wf-audit-output" title={title('Output')} />}
        {visit.missing && visit.missing.length > 0 && (
          <div className="rt-hint rt-bad" data-testid="wf-audit-missing">
            Missing fields: {visit.missing.join(', ')}
          </div>
        )}
        {visit.error && (
          <div className="wf-visit-error" data-testid="wf-audit-error">
            {visit.error}
          </div>
        )}
        {e.handled && (
          <div className="rt-hint" data-testid="wf-audit-handled">
            {HANDLED_TEXT}
          </div>
        )}
      </div>
    </li>
  )
}

/** A finished run's audit log; while the run goes on, only a note that the log comes when it ends. */
export function AuditLog({ run, timeZone, workflowName, actions, onOpenChat }: Ctx) {
  const log = useMemo(() => auditLog(run), [run])
  if (log === null) {
    return (
      <div className="wf-audit" data-testid="wf-audit" data-state="pending">
        <p className="wf-audit-pending" data-testid="wf-audit-pending">
          The audit log shows once this run ends.
        </p>
      </div>
    )
  }
  const { trigger, entries, end } = log
  const cost = runCostText(run)
  return (
    <div className="wf-audit" data-testid="wf-audit" data-state="ready">
      <ol className="wf-audit-list">
        <TriggerEntry trigger={trigger} run={run} timeZone={timeZone} />
        {entries.map((e) => (
          <Entry key={e.visit.id} e={e} ctx={{ run, timeZone, workflowName, actions, onOpenChat }} />
        ))}
        <li className="wf-audit-ev wf-audit-end" data-testid="wf-audit-end" data-status={end.status}>
          <span className={`wf-audit-dot end ${end.status}`} aria-hidden="true" />
          <div className="wf-audit-body">
            <div className="wf-audit-top">
              <span className="wf-audit-name">Run {runStatusLabel(end.status).toLowerCase()}</span>
              <span className="wf-audit-meta">
                {[end.at !== null && clockTime(end.at, timeZone), end.at !== null && durationText(run.startedAt, end.at), cost]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>
            {end.error && (
              <div className="wf-visit-error" data-testid="wf-audit-run-error">
                {end.error}
              </div>
            )}
          </div>
        </li>
      </ol>
    </div>
  )
}
