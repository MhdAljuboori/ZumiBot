import type { RoutineDef, WorkflowDef } from '@zumibot/shared/definitionHistory'
import { renameStepAgent } from '@zumibot/shared/workflowRename'

// An agent rename in kept versions, as routineStore and workflowStore do it in the live definitions; null when untouched.

export function renameWorkflowDef(def: WorkflowDef, from: string, to: string): WorkflowDef | null {
  const steps = def.steps.map((s) => renameStepAgent(s, from, to))
  if (steps.every((s) => s === null)) return null
  return { ...def, steps: steps.map((s, i) => s ?? def.steps[i]!) }
}

export function renameRoutineDef(def: RoutineDef, from: string, to: string): RoutineDef | null {
  const t = def.target
  if (t.kind === 'new-chat' && t.agent === from) return { ...def, target: { ...t, agent: to } }
  if (t.kind === 'new-group' && t.members.includes(from))
    return { ...def, target: { ...t, members: t.members.map((m) => (m === from ? to : m)) } }
  return null
}
