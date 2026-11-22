import { describeSchedule } from '@zumibot/shared/schedule'
import { eventLabel } from '@zumibot/shared/workflowEvents'
import type { WorkflowRunStatus, WorkflowsSnapshot, WorkflowTrigger } from '@zumibot/shared/workflows'

/** The trigger in a few words, as the sidebar row shows it. The schedule text is the routines sidebar's own. */
export function triggerSummary(t: WorkflowTrigger, _timeZone: string): string {
  if (t.kind === 'manual') return 'Manual'
  if (t.kind === 'webhook') return 'Webhook'
  if (t.kind === 'schedule') return describeSchedule(t.schedule)
  if (t.kind === 'file') {
    // Both slash styles: the path is the server's, which may be a Windows one.
    const name = t.path.split(/[\\/]/).filter(Boolean).pop()
    return name ? `${eventLabel(t.kind)} · ${name}` : eventLabel(t.kind)
  }
  return eventLabel(t.kind)
}

/** Some run waits on the user (an Approval step, or a card in an Agent step's chat): the rail dot. */
export function anyWaiting(s: WorkflowsSnapshot): boolean {
  return Object.values(s.runs).some((runs) => runs.some((r) => r.status === 'waiting'))
}

/**
 * The status of a workflow's newest run, for its sidebar dot. A skipped webhook call made no real run, so it neither
 * clears nor sets the dot (as for routines).
 */
export function lastRunStatus(s: WorkflowsSnapshot, id: string): WorkflowRunStatus | null {
  let newest: { status: WorkflowRunStatus; startedAt: number } | null = null
  for (const r of s.runs[id] ?? []) if (r.status !== 'skipped' && (newest === null || r.startedAt > newest.startedAt)) newest = r
  return newest?.status ?? null
}
