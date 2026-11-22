import { useEffect, useRef, useState } from 'react'
import type { WorkflowApproval } from '@zumibot/shared/inbox'
import type { WorkflowsSnapshot } from '@zumibot/shared/workflows'
import { api } from '../api'
import { anyWaiting } from '../state/workflows'

const none: WorkflowApproval[] = []

/**
 * Every workflow Approval waiting for the user. The snapshot carries run summaries only, so each new one (every
 * `workflows:changed`) asks again while some run waits; with none waiting nothing is asked and the list is empty. An
 * answer older than one already asked for is dropped; a failed one keeps the last list, as does a dropped socket.
 */
export function useWorkflowApprovals(connected: boolean, snapshot: WorkflowsSnapshot): WorkflowApproval[] {
  const [list, setList] = useState<WorkflowApproval[]>(none)
  const seq = useRef(0)
  const waiting = anyWaiting(snapshot)
  useEffect(() => {
    const mine = ++seq.current
    if (!waiting) {
      setList(none)
      return
    }
    if (!connected) return
    api.workflows.approvals().then(
      (l) => {
        if (mine === seq.current) setList(l)
      },
      () => {
        /* keep what is shown; the next push or reconnect asks again */
      }
    )
  }, [connected, snapshot, waiting])
  return waiting ? list : none
}
