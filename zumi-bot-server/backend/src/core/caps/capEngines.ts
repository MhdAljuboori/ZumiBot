import { routineRefs, spendCapBlocker, workflowRefs, type AgentRefs, type ChatAgents } from '@zumibot/shared/capAgents'
import { engineCaps, SPEND_CAP_UNCHECKED, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import type { Routine } from '@zumibot/shared/routines'
import type { AgentSummary } from '@zumibot/shared/types'
import type { Workflow } from '@zumibot/shared/workflows'

export interface CapEnginesDeps {
  agents(): Promise<AgentSummary[]>
  chats: { get(id: string): Promise<ChatAgents | null> }
  /** What each engine can do (default engineCaps). */
  caps?(engine: Engine): EngineCaps
}

/**
 * Whether a routine's or workflow's spend cap can hold: it can't while one of the agents it runs is on an engine without
 * `cost` (an ACP cost may be in credits). Each check answers the fixed sentence naming that agent, or null (no cap set,
 * or every agent reports a cost). Asked at save and again where a run starts, since the agent may have changed engine since.
 */
export interface CapEngines {
  routine(r: Pick<Routine, 'target'> & { spendCap?: number | undefined }): Promise<string | null>
  workflow(w: Pick<Workflow, 'steps'> & { spendCap?: number | undefined }): Promise<string | null>
}

export function capEngines(d: CapEnginesDeps): CapEngines {
  const judge = async (refs: AgentRefs): Promise<string | null> => {
    if (refs.agents.length === 0 && refs.chats.length === 0) return null
    const known = new Map<string, ChatAgents | null>()
    for (const id of new Set(refs.chats)) known.set(id, await d.chats.get(id))
    return spendCapBlocker(refs, await d.agents(), (id) => known.get(id), d.caps ?? engineCaps)
  }
  return {
    routine: async (r) => (r.spendCap === undefined ? null : judge(routineRefs(r.target))),
    // A sub-workflow step runs its own workflow, whose own run is judged by its own cap.
    workflow: async (w) => (w.spendCap === undefined ? null : judge(workflowRefs(w.steps)))
  }
}

/**
 * A run-start check: the refusal sentence, or null. A lookup that throws refuses the run with SPEND_CAP_UNCHECKED (a cap that
 * cannot be shown to hold is never ignored); only the error's code is logged.
 */
export async function capRefusalAtRun(check: (() => Promise<string | null>) | undefined): Promise<string | null> {
  if (!check) return null
  try {
    return await check()
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code
    console.error('spend cap engine check failed:', typeof code === 'string' ? code : 'error')
    return SPEND_CAP_UNCHECKED
  }
}
