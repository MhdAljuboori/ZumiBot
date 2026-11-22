import { useMemo, useState } from 'react'
import type { WorkflowRunSummary, WorkflowsSnapshot } from '@zumibot/shared/workflows'
import { api } from '../api'
import { runLabel } from '../state/promptFields'
import { recentRuns, runStatusLabel, workflowRows } from '../state/workflowEditor'
import { costText, progressText } from '../state/workflowRun'
import { runTag } from '../state/workflowTriggers'
import { Glyph } from './Sidebar'
import { TriggerKindIcon } from './WorkflowIcons'

interface Props {
  open: boolean
  onClose: () => void
  snapshot: WorkflowsSnapshot
  /** Epoch ms from the caller; the run times follow it. */
  now: number
  selectedId: string | null
  selectedRunId: string | null
  onNew: () => void
  onOpen: (id: string) => void
  onOpenRun: (id: string, runId: string) => void
  onError: (e: unknown) => void
}

/** The Workflows column, in the sidebar's place: each workflow with its switch and last run's dot, and the selected one's runs. */
export function WorkflowsSidebar(p: Props) {
  const rows = useMemo(() => workflowRows(p.snapshot), [p.snapshot])
  const [switching, setSwitching] = useState<ReadonlySet<string>>(new Set())
  const runs = p.selectedId === null ? [] : recentRuns(p.snapshot, p.selectedId)
  const timeZone = p.snapshot.workflows.find((w) => w.id === p.selectedId)?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  // Applies at once, like the phone's switch. A refusal (problems) is shown by the caller; the push brings the new state.
  const toggle = (id: string, on: boolean): void => {
    setSwitching((s) => new Set(s).add(id))
    api.workflows
      .setEnabled(id, on)
      .catch(p.onError)
      .finally(() =>
        setSwitching((s) => {
          const next = new Set(s)
          next.delete(id)
          return next
        })
      )
  }

  return (
    <aside className={p.open ? 'sidebar open' : 'sidebar'} id="sidebar" data-testid="workflows-sidebar">
      <div className="sidebar-head">
        <h2 className="sidebar-title">Workflows</h2>
        <span className="count-badge" aria-label={`${p.snapshot.workflows.length} workflows`}>
          {p.snapshot.workflows.length}
        </span>
        <span className="grow" />
        <button
          type="button"
          className="head-btn"
          data-testid="new-workflow"
          aria-label="New workflow"
          data-tip="New workflow"
          onClick={p.onNew}
        >
          <Glyph name="plus" />
        </button>
        <button
          type="button"
          className="head-btn nav-close"
          data-testid="nav-close"
          aria-label="Close sidebar"
          data-tip="Close sidebar"
          onClick={p.onClose}
        >
          <Glyph name="close" />
        </button>
      </div>
      <nav className="agent-list routine-list" aria-label="Workflows">
        {rows.map((r) => {
          const selected = r.id === p.selectedId
          return (
            <div key={r.id} className="wf-row-group">
              <div
                className={selected ? 'wf-row selected' : 'wf-row'}
                data-testid="workflow-row"
                data-workflow-id={r.id}
                data-dot={r.dot ?? ''}
                data-enabled={r.enabled ? 'true' : 'false'}
              >
                <button
                  type="button"
                  className="routine-row"
                  aria-current={selected && p.selectedRunId === null ? 'page' : undefined}
                  onClick={() => p.onOpen(r.id)}
                >
                  <span className="routine-ic">
                    <TriggerKindIcon kind={r.trigger} />
                  </span>
                  <span className="routine-text">
                    <span className="routine-name">
                      <span className="routine-name-text">{r.name}</span>
                      {r.dot && (
                        <span
                          className={`routine-dot ${r.dot}`}
                          role="img"
                          aria-label={`Last run: ${runStatusLabel(r.dot)}`}
                          data-tip={`Last run: ${runStatusLabel(r.dot)}`}
                        />
                      )}
                    </span>
                    <span className="routine-sub">{r.summary}</span>
                  </span>
                </button>
                <button
                  type="button"
                  role="switch"
                  className="wf-row-switch"
                  data-testid="workflow-row-enabled"
                  aria-checked={r.enabled}
                  aria-label={`${r.name}: ${r.enabled ? 'on' : 'off'}`}
                  data-tip={r.enabled ? 'On' : 'Off'}
                  disabled={switching.has(r.id)}
                  onClick={() => toggle(r.id, !r.enabled)}
                >
                  <span className="wf-row-knob" />
                </button>
              </div>
              {selected && runs.length > 0 && (
                <ul className="wf-runs" data-testid="workflow-runs" aria-label="Recent runs">
                  {runs.map((run) => (
                    <li key={run.id}>
                      <WorkflowRunRow
                        run={run}
                        now={p.now}
                        timeZone={timeZone}
                        selected={run.id === p.selectedRunId}
                        onOpen={() => p.onOpenRun(r.id, run.id)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
        {rows.length === 0 && <p className="routine-empty">No workflows yet. Press + to add one.</p>}
      </nav>
    </aside>
  )
}

/** One run: when, status, tags, cost and a running For each's progress. The sidebar's run list and the phone's editor share it. */
export function WorkflowRunRow({
  run,
  now,
  timeZone,
  selected = false,
  onOpen
}: {
  run: WorkflowRunSummary
  now: number
  timeZone: string
  selected?: boolean
  onOpen: () => void
}) {
  const tag = runTag(run)
  return (
    <button
      type="button"
      className={selected ? 'wf-run-row selected' : 'wf-run-row'}
      data-testid="workflow-run-row"
      data-run-id={run.id}
      data-status={run.status}
      aria-current={selected ? 'page' : undefined}
      onClick={onOpen}
    >
      <span className={`routine-dot ${run.status}`} aria-hidden="true" />
      <span className="wf-run-when">{runLabel(run, now, timeZone)}</span>
      <span className="wf-run-status">{runStatusLabel(run.status)}</span>
      {tag && <span className="rt-tag rt-tag-plain">{tag}</span>}
      {run.via === 'workflow' && (
        <span className="rt-tag rt-tag-plain" data-tip={run.parent ? `Started by ${run.parent.name}` : undefined}>
          sub-workflow
        </span>
      )}
      {run.late && <span className="rt-tag">late</span>}
      {costText(run.costUsd) && (
        <span className="wf-run-cost" data-testid="workflow-run-cost" data-tip="API estimate, in USD">
          {costText(run.costUsd)}
        </span>
      )}
      {(run.status === 'running' || run.status === 'waiting') && run.progress?.[0] && (
        <span className="wf-run-progress" data-testid="workflow-run-progress" data-tip={progressText(run.progress[0])}>
          {progressText(run.progress[0])}
        </span>
      )}
    </button>
  )
}
