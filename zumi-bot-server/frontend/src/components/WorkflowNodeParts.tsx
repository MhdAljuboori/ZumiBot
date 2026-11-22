import type { Port } from '@zumibot/shared/workflows'
import type { StepRunState } from '../state/workflowCanvas'
import { stateLabel } from '../state/workflowEditor'

// What a step node and a collapsed group's node draw alike. Kept apart from WorkflowCanvas.tsx, which imports the
// group nodes: one module for both would import itself in a circle.

/** A port's name beside its handle; the plain way on (`out`) has none. */
export const PORT_TEXT: Record<Port, string> = {
  out: '',
  yes: 'Yes',
  no: 'No',
  approved: 'Approved',
  rejected: 'Rejected',
  error: 'Failed'
}

/** A step's state in a run: a spinner while it runs, a check, a pause bar (waiting, or paused by the user), a cross or a stop square. */
export function StateMark({ status }: { status: Exclude<StepRunState['status'], 'idle'> }) {
  return (
    <span
      className={`wf-node-state ${status}`}
      data-testid="wf-node-state"
      role="img"
      aria-label={stateLabel(status)}
      data-tip={stateLabel(status)}
    >
      {status === 'running' ? (
        <span className="spinner" aria-hidden="true" />
      ) : (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {status === 'done' && <path d="M3.5 8.5l3 3 6-6.5" />}
          {(status === 'waiting' || status === 'paused') && <path d="M6 4v8M10 4v8" />}
          {status === 'failed' && <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />}
          {status === 'stopped' && <rect x="4.5" y="4.5" width="7" height="7" rx="1" />}
        </svg>
      )}
    </span>
  )
}

/** Where the i-th of `count` out ports sits down a node's right edge: the middle for one, spread evenly for more. */
export const portTop = (i: number, count: number): { top: string } | undefined =>
  count > 1 ? { top: `${((i + 1) * 100) / (count + 1)}%` } : undefined
