import { useEffect, useState } from 'react'
import type { WorkflowRun, WorkflowsSnapshot } from '@zumibot/shared/workflows'
import { api } from '../api'

/** The snapshot, plus whether any list or push has arrived yet: an address naming a workflow waits for it. */
export interface WorkflowsState extends WorkflowsSnapshot {
  loaded: boolean
}

const none: WorkflowsState = { workflows: [], runs: {}, loaded: false }

/**
 * Every workflow and its run summaries: listed when the socket connects (again after a reconnect), then replaced by each
 * push. A list answer that comes back after a newer push is dropped, so a slow reply never shows older state.
 */
export function useWorkflows(connected: boolean): WorkflowsState {
  const [snapshot, setSnapshot] = useState<WorkflowsState>(none)
  useEffect(() => {
    let live = true
    let seq = 0
    const off = api.workflows.onChanged((s) => {
      seq++
      if (live) setSnapshot({ ...s, loaded: true })
    })
    if (connected) {
      const mine = ++seq
      api.workflows.list().then(
        (s) => {
          if (live && mine === seq) setSnapshot({ ...s, loaded: true })
        },
        () => {
          /* keep what is shown; the next push or reconnect tries again */
        }
      )
    }
    return () => {
      live = false
      off()
    }
  }, [connected])
  return snapshot
}

/** One run with every visit's input and output (the snapshot only carries summaries); null when it is gone. */
export const getRun = (runId: string): Promise<WorkflowRun | null> => api.workflows.getRun(runId)
