import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkflowRun, WorkflowRunSummary } from '@zumibot/shared/workflows'
import { fetchOrder, needsPolling, summaryKey } from '../state/workflowRun'
import { getRun } from './useWorkflows'

export const RUN_POLL_MS = 2000

/** `undefined` while the first fetch is out, `null` when the server has no such run (or it could not be read at all). */
export type RunState = WorkflowRun | null | undefined

/**
 * One run with its visits. Fetched on open and again whenever the pushed summary changes (a status, a step waiting or
 * failed, a For each item moving: its progress is in the key), because the push carries no visits; and every 2 s while a plain visit runs, to show an agent's progress. The timer
 * exists only while mounted and unfinished, and skips a tick while a fetch is out, so a server slower than 2 s is not
 * superseded forever. An answer older than one already shown is dropped (fetchOrder).
 */
export function useWorkflowRun(runId: string, summary: WorkflowRunSummary | undefined): { run: RunState; refresh: () => void } {
  const [run, setRun] = useState<RunState>(undefined)
  const order = useRef(fetchOrder())
  const alive = useRef(true)

  const refresh = useCallback((): void => {
    const mine = order.current.start()
    getRun(runId).then(
      (r) => {
        if (order.current.land(mine) && alive.current) setRun(r)
      },
      // A failed refresh keeps what is shown; only a run never loaded reads as unavailable.
      () => {
        if (order.current.land(mine) && alive.current) setRun((cur) => (cur === undefined ? null : cur))
      }
    )
  }, [runId])

  useEffect(() => {
    alive.current = true
    setRun(undefined)
    refresh()
    return () => {
      alive.current = false
      order.current.reset()
    }
  }, [refresh])

  const key = summaryKey(summary)
  const first = useRef(true)
  useEffect(() => {
    // The mount's own fetch covers the first key.
    if (first.current) {
      first.current = false
      return
    }
    refresh()
  }, [key, refresh])

  const polling = run ? needsPolling(run) : false
  useEffect(() => {
    if (!polling) return
    const t = setInterval(() => {
      if (!order.current.busy()) refresh()
    }, RUN_POLL_MS)
    return () => clearInterval(t)
  }, [polling, refresh])

  return { run, refresh }
}
