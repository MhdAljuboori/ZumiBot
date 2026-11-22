// The info line under a chat's messages (beside its send error): a workflow started from `/run-workflow`.
import type { WorkflowRunSummary } from '@zumibot/shared/workflows'

export interface SendNotice {
  text: string
  /** The run the line's "Open run" opens. */
  workflowId: string
  runId: string
}

/** The workflow may be missing from the list the app holds (just created elsewhere); the line still opens its run. */
export function startedNotice(workflowName: string | undefined, run: Pick<WorkflowRunSummary, 'id' | 'workflowId'>): SendNotice {
  const name = workflowName?.trim()
  return { text: `Started ${name ? name : 'the workflow'}`, workflowId: run.workflowId, runId: run.id }
}

export const setNotice = (
  notices: Readonly<Record<string, SendNotice>>,
  chatId: string,
  notice: SendNotice
): Record<string, SendNotice> => ({ ...notices, [chatId]: notice })

export function clearNotice(notices: Record<string, SendNotice>, chatId: string): Record<string, SendNotice> {
  if (!(chatId in notices)) return notices
  const { [chatId]: _gone, ...rest } = notices
  return rest
}

/** Whether a chat view's `/` menu offers `/run-workflow`: not in the island, which refuses one. A typed one still goes. */
export const offersRunWorkflow = (o: { compact: boolean }): boolean => !o.compact
