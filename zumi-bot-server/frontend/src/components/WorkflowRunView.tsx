import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { progressOf, type Step, type Visit, type WorkflowInput, type WorkflowRun, type WorkflowRunSummary } from '@zumibot/shared/workflows'
import { api } from '../api'
import { errorMessage } from '../errors'
import { useNarrow } from '../media'
import { useWorkflowRun } from '../net/useWorkflowRun'
import { runLabel } from '../state/promptFields'
import {
  viaText,
  capHoldBanner,
  conditionText,
  pendingApproval,
  canStop,
  costByStep,
  costText,
  edgeRuns,
  parentLine,
  progressText,
  runCostText,
  stepStates,
  timeline,
  visitsOf
} from '../state/workflowRun'
import { runStatusLabel, type Selection } from '../state/workflowEditor'
import { STEP_LABELS } from '../state/workflowCanvas'
import { withCollapsed } from '../state/workflowGroupEdit'
import { AppLink } from './AppLink'
import { AuditLog } from './AuditLog'
import { ApprovalBox, VisitPanel, VisitText, type RunActions } from './VisitPanel'
import { LazyCanvas } from './WorkflowPanels'
import { StepIcon } from './WorkflowIcons'

interface Props {
  workflowName: string
  timeZone: string
  runId: string
  /** The pushed summary of this run: a change in it is what makes the open run fetch again. */
  summary: WorkflowRunSummary | undefined
  /** Whether the Audit log tab shows (the address's `/audit`); a phone has no tabs and ignores it. */
  audit: boolean
  onTab: (audit: boolean) => void
  onBack: () => void
  onOpenChat: (chatId: string) => void
}

const NO_PROBLEMS: never[] = []
const KIND_NAMES = { trigger: 'Trigger', ...STEP_LABELS } as const
const COST_TITLE = 'API estimate of this run’s model calls and agent turns, in USD'

// The same canvas as the editor, read-only, drawn from the run's own copy of the workflow: editing the workflow
// afterwards never changes a run in flight. Keyed by content, so a refetch with nothing new keeps the canvas as it is.
function useCanvasWorkflow(run: WorkflowRun | null | undefined, name: string, timeZone: string): WorkflowInput | null {
  const key = run ? JSON.stringify(run.snapshot) : ''
  const id = run?.workflowId ?? ''
  const latest = useRef(run)
  latest.current = run
  return useMemo(() => {
    const r = latest.current
    if (!r) return null
    return {
      id,
      name,
      enabled: false,
      timeZone,
      trigger: { kind: 'manual' as const },
      steps: r.snapshot.steps,
      edges: r.snapshot.edges,
      notes: r.snapshot.notes ?? [],
      groups: r.snapshot.groups ?? []
    }
  }, [key, id, name, timeZone])
}

function Unavailable({ text, onBack }: { text: string; onBack: () => void }) {
  return (
    <div className="routine-placeholder wf-empty" data-testid="workflow-run-unavailable">
      <span>{text}</span>
      <button type="button" className="btn" onClick={onBack}>
        Back to the workflow
      </button>
    </div>
  )
}

/** Each step's share of the cost, costliest first; a row opens that step's visits. */
function RunCosts({ run, onSelect }: { run: WorkflowRun; onSelect: (stepId: string) => void }) {
  const rows = costByStep(run)
  const total = runCostText(run)
  if (rows.length === 0 || total === null) return null
  return (
    <div className="wf-visit-part" data-testid="wf-run-costs">
      <div className="rt-label">Cost</div>
      <ul className="wf-costs">
        {rows.map((c) => {
          const step = run.snapshot.steps.find((s) => s.id === c.stepId)
          return (
            <li key={c.stepId}>
              <button type="button" className="wf-cost-row" data-testid="wf-cost-row" onClick={() => onSelect(c.stepId)}>
                <span className="wf-cost-name">{step?.name.trim() || (step ? KIND_NAMES[step.kind] : 'A step')}</span>
                {c.visits > 1 && <span className="wf-cost-n">{c.visits} visits</span>}
                <span className="wf-cost-usd">{costText(c.usd)}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <div className="wf-cost-total" data-testid="wf-cost-total">
        <span>Total</span>
        <span className="wf-cost-usd">{total}</span>
      </div>
      <p className="rt-hint">{COST_TITLE}, as the CLI reported it.</p>
    </div>
  )
}

/** The run's own words when nothing is selected: how it started, the input it got, what it cost, and a way to the approval. */
function RunOverview({ run, pending, onSelect }: { run: WorkflowRun; pending: Visit | null; onSelect: (stepId: string) => void }) {
  const step = pending ? run.snapshot.steps.find((s) => s.id === pending.stepId) : undefined
  return (
    <div className="wf-inspect" data-testid="wf-run-overview">
      <div className="wf-inspect-head">
        <h3>Run</h3>
      </div>
      {pending && step && (
        <button type="button" className="rt-insert wf-goto" data-testid="wf-goto-approval" onClick={() => onSelect(pending.stepId)}>
          Waiting on you: {step.name}
        </button>
      )}
      <p className="rt-hint">Select a step to see its visits. Steps that ran more than once show how many times.</p>
      {run.error && (
        <div className="wf-visit-error" data-testid="wf-run-error" role="alert">
          {run.error}
        </div>
      )}
      {conditionText(run.condition) && (
        <div className="rt-hint" data-testid="wf-run-condition">
          {conditionText(run.condition)}
        </div>
      )}
      {run.input !== undefined && run.input !== '' && <VisitText label="Run input" text={run.input} testId="wf-run-input" />}
      <RunCosts run={run} onSelect={onSelect} />
    </div>
  )
}

/**
 * One run: the canvas with each step's state and the visits of the selected step, or its audit log (the Audit log tab).
 * On a phone, the visits in time order while the run goes on, and the audit log once it ended.
 */
export function WorkflowRunView({ workflowName, timeZone, runId, summary, audit, onTab, onBack, onOpenChat }: Props) {
  const narrow = useNarrow()
  const { run, refresh } = useWorkflowRun(runId, summary)
  // undefined: the user has not picked, so the run's oldest waiting approval is open (also when it arrives later).
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  // The step the approval was on stays open after it is answered, instead of the panel jumping to the overview.
  const [followed, setFollowed] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)
  const [continuing, setContinuing] = useState(false)
  // Groups start expanded, as in n8n's read-only views; collapsing one here is for this look only, never remembered.
  const [folded, setFolded] = useState<Set<string>>(() => new Set())
  const unmounted = useRef(false)
  useEffect(() => {
    unmounted.current = false // StrictMode re-runs effects after a simulated unmount
    return () => {
      unmounted.current = true
    }
  }, [])
  // The two tabs share one panel, whose content follows the selected tab.
  const tabsId = useId()
  const tabRefs = { canvas: useRef<HTMLButtonElement>(null), audit: useRef<HTMLButtonElement>(null) }
  const panelId = `${tabsId}-panel`
  const tabId = (a: boolean): string => `${tabsId}-${a ? 'audit' : 'canvas'}`

  const w = useCanvasWorkflow(run, workflowName, timeZone)
  const states = useMemo(() => (run ? stepStates(run) : undefined), [run])
  const carried = useMemo(() => (run ? edgeRuns(run) : undefined), [run])
  const progress = useMemo(() => (run ? progressOf(run) : undefined), [run])

  const actions = useMemo<RunActions>(
    () => ({
      approve: async (visitId, ok, text, note) => {
        try {
          await api.workflows.approve(runId, visitId, ok, text, note === '' ? undefined : note)
        } finally {
          refresh()
        }
      },
      retry: async (visitId, itemId) => {
        try {
          await api.workflows.retry(runId, visitId, itemId)
        } finally {
          refresh()
        }
      }
    }),
    [runId, refresh]
  )

  const pending = run ? pendingApproval(run) : null
  if (pending && picked === undefined && followed !== pending.stepId) setFollowed(pending.stepId)

  if (run === undefined)
    return (
      <div className="routine-placeholder" data-testid="workflow-run-loading">
        Loading…
      </div>
    )
  if (run === null || w === null) return <Unavailable text="This run is not available." onBack={onBack} />

  const selectedId = picked !== undefined ? picked : (pending?.stepId ?? followed)
  const stepOf = (id: string): Step | undefined => run.snapshot.steps.find((s) => s.id === id)
  const selected = selectedId === null ? undefined : stepOf(selectedId)
  const selection: Selection | null = selected ? { kind: 'step', id: selected.id } : null

  const stop = (): void => {
    setStopping(true)
    setStopError(null)
    api.workflows
      .stop(runId)
      .then(
        () => undefined,
        (e: unknown) => {
          if (!unmounted.current) setStopError(errorMessage(e))
        }
      )
      .finally(() => {
        if (!unmounted.current) setStopping(false)
        refresh()
      })
  }

  const continueCap = (): void => {
    setContinuing(true)
    setStopError(null)
    api.workflows
      .continueCap(runId)
      .then(
        () => undefined,
        (e: unknown) => {
          if (!unmounted.current) setStopError(errorMessage(e))
        }
      )
      .finally(() => {
        if (!unmounted.current) setContinuing(false)
        refresh()
      })
  }

  const pickTab = (a: boolean): void => {
    if (a !== audit) onTab(a)
  }
  // Arrow keys move between the tabs and pick the one they land on (two tabs, so each arrow goes to the other).
  const tabKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    const to = e.key === 'ArrowLeft' || e.key === 'ArrowRight' ? !audit : e.key === 'Home' ? false : e.key === 'End' ? true : null
    if (to === null) return
    e.preventDefault()
    pickTab(to)
    ;(to ? tabRefs.audit : tabRefs.canvas).current?.focus()
  }

  const now = Date.now()
  const cost = runCostText(run)
  const parent = parentLine(run)
  // Open For each visits only (progressOf), and none once the run ended; two can run on parallel branches, the first shows.
  const headProgress = canStop(run) && progress && progress.length > 0 ? progressText(progress[0]) : null
  const back = (
    <button type="button" className="rt-insert wf-run-back" data-testid="wf-run-back" onClick={onBack}>
      ‹ {workflowName}
    </button>
  )
  const title = (
    <h2 className="wf-run-title" data-testid="wf-run-title">
      {runLabel(run, now, timeZone)}
    </h2>
  )
  const tags = (
    <>
      <span className={`wf-visit-status ${run.status}`} data-testid="wf-run-status" data-status={run.status}>
        {runStatusLabel(run.status)}
      </span>
      {headProgress && (
        <span className="wf-run-progress" data-testid="wf-run-progress" data-tip={headProgress}>
          {headProgress}
        </span>
      )}
      <span className="rt-tag rt-tag-plain">{viaText(run)}</span>
      {parent && (
        <AppLink href={parent.href} className="rt-insert wf-run-parent" testId="wf-run-parent">
          {parent.text}
        </AppLink>
      )}
      {run.late && <span className="rt-tag">late</span>}
      {cost && (
        <span className="rt-tag rt-tag-plain wf-run-cost" data-testid="wf-run-cost" data-tip={COST_TITLE}>
          {cost}
        </span>
      )}
    </>
  )
  const stopButton = canStop(run) && (
    <button type="button" className="btn wf-stop" data-testid="wf-stop" disabled={stopping} onClick={stop}>
      {stopping ? 'Stopping…' : 'Stop'}
    </button>
  )
  // A phone has no room for one wrapping row: back and Stop keep fixed places on top, the run's title and tags go under.
  const head = narrow ? (
    <header className="rt-head wf-head wf-run-head">
      <div className="wf-run-bar">
        {back}
        {stopButton}
      </div>
      <div className="wf-run-info">
        {title}
        {tags}
      </div>
    </header>
  ) : (
    <header className="rt-head wf-head wf-run-head">
      {back}
      {title}
      {tags}
      <span className="grow" />
      <div className="seg wf-run-tabs" role="tablist" aria-label="Run view" data-testid="wf-run-tabs" onKeyDown={tabKey}>
        {([false, true] as const).map((a) => (
          <button
            key={String(a)}
            ref={a ? tabRefs.audit : tabRefs.canvas}
            type="button"
            role="tab"
            id={tabId(a)}
            aria-selected={audit === a}
            aria-controls={panelId}
            tabIndex={audit === a ? 0 : -1}
            data-testid={a ? 'wf-tab-audit' : 'wf-tab-canvas'}
            onClick={() => pickTab(a)}
          >
            {a ? 'Audit log' : 'Canvas'}
          </button>
        ))}
      </div>
      {stopButton}
    </header>
  )
  const capped = run.capHold && canStop(run) ? capHoldBanner(run.capHold) : null
  const banner = (stopError || capped) && (
    <div className="wf-banner" data-testid="wf-run-banner">
      {capped && (
        <div className="wf-notice warn wf-cap-hold" data-testid="wf-cap-hold" data-kind={run.capHold?.kind}>
          <span className="wf-notice-text">{capped.text}</span>
          <button type="button" className="btn primary" data-testid="wf-cap-continue" disabled={continuing} onClick={continueCap}>
            {continuing ? 'Continuing…' : capped.action}
          </button>
        </div>
      )}
      {stopError && (
        <div className="wf-notice error" role="alert">
          <span className="wf-notice-text">{stopError}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setStopError(null)}>
            ✕
          </button>
        </div>
      )}
    </div>
  )

  if (narrow) {
    const pendingStep = pending ? stepOf(pending.stepId) : undefined
    // No canvas to switch from on a phone: an ended run reads as its log, one still going as its visits.
    const ended = run.status !== 'running' && run.status !== 'waiting'
    return (
      <div className="wf-editor wf-phone wf-run-view" data-testid="workflow-run-view" data-narrow="true">
        {head}
        {banner}
        <div className="wf-phone-body">
          {run.error && !ended && (
            <div className="wf-visit-error" data-testid="wf-run-error" role="alert">
              {run.error}
            </div>
          )}
          {pending && pendingStep?.kind === 'approval' && (
            <div className="wf-phone-approval">
              <div className="wf-phone-approval-name">{pendingStep.name}</div>
              <ApprovalBox key={pending.id} visit={pending} step={pendingStep} onApprove={actions.approve} />
            </div>
          )}
          {ended ? (
            // Retry here only: a phone has no canvas inspector to retry a failed run from.
            <AuditLog run={run} timeZone={timeZone} workflowName={workflowName} actions={actions} onOpenChat={onOpenChat} />
          ) : (
            <ol className="wf-timeline" data-testid="wf-timeline">
              {timeline(run).map((v) => (
                <li key={v.id}>
                  <VisitPanel
                    run={run}
                    visit={v}
                    step={stepOf(v.stepId)}
                    now={now}
                    named
                    answerable={v.id !== pending?.id}
                    actions={actions}
                    onOpenChat={onOpenChat}
                  />
                </li>
              ))}
            </ol>
          )}
          {!ended && run.visits.length === 0 && <p className="rt-hint">Nothing has run yet.</p>}
        </div>
      </div>
    )
  }

  const visits = selected ? visitsOf(run, selected.id) : []
  return (
    <div className="wf-editor wf-run-view" data-testid="workflow-run-view">
      {head}
      {banner}
      {audit ? (
        <div className="wf-audit-scroll" role="tabpanel" id={panelId} aria-labelledby={tabId(true)}>
          <AuditLog run={run} timeZone={timeZone} workflowName={workflowName} onOpenChat={onOpenChat} />
        </div>
      ) : (
        <div className="wf-body" role="tabpanel" id={panelId} aria-labelledby={tabId(false)}>
          <LazyCanvas
            w={w}
            problems={NO_PROBLEMS}
            selected={selection}
            onSelect={(s) => {
              if (s === null || s.kind === 'step') setPicked(s ? s.id : null)
            }}
            triggerSummary={viaText(run)}
            states={states}
            carried={carried}
            progress={progress}
            collapsed={folded}
            onToggleGroup={(id, collapse) => setFolded((f) => withCollapsed(f, [id], collapse))}
          />
          <aside className="wf-inspector" data-testid="wf-inspector">
            {selected ? (
              <div className="wf-inspect" data-testid="wf-run-step">
                <div className="wf-inspect-head">
                  <span className="wf-visit-ic">
                    <StepIcon kind={selected.kind} />
                  </span>
                  <h3>{selected.name.trim() || KIND_NAMES[selected.kind]}</h3>
                </div>
                <div className="rt-hint">
                  {KIND_NAMES[selected.kind]}
                  {visits.length > 1 ? `, ran ${visits.length} times` : ''}
                </div>
                {visits.length === 0 && (
                  <p className="rt-hint" data-testid="wf-run-notrun">
                    This step has not run in this run.
                  </p>
                )}
                <div className="wf-visits">
                  {visits.map((v) => (
                    <VisitPanel
                      key={v.id}
                      run={run}
                      visit={v}
                      step={selected}
                      now={now}
                      answerable
                      actions={actions}
                      onOpenChat={onOpenChat}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <RunOverview run={run} pending={pending} onSelect={setPicked} />
            )}
          </aside>
        </div>
      )}
    </div>
  )
}
