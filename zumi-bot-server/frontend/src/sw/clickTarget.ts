import { inboxPath } from '../state/route'

/**
 * Where a notification click goes when it is not a chat: a Notify message's Inbox page, the Inbox for a to-do card's
 * question (answered there), else its workflow run, else null.
 */
export function clickUrl(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const { message, run, inbox } = data as { message?: unknown; run?: { workflowId?: unknown; runId?: unknown } | null; inbox?: unknown }
  if (typeof message === 'string') return inboxPath(message)
  if (inbox === true) return inboxPath()
  if (run && typeof run.workflowId === 'string' && typeof run.runId === 'string') {
    return `/workflows/${encodeURIComponent(run.workflowId)}/runs/${encodeURIComponent(run.runId)}`
  }
  return null
}
