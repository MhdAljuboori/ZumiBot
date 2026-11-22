import type { Step, WorkflowInput } from '@zumibot/shared/workflows'
import { STEP_LABELS } from './workflowCanvas'

/** One row of the phone's read-only step list. */
export interface PhoneStep {
  id: string
  kind: Step['kind']
  name: string
  detail: string
}

const MINUTES_DAY = 1440

function waitText(minutes: number): string {
  if (minutes % MINUTES_DAY === 0) return `${minutes / MINUTES_DAY} d`
  if (minutes % 60 === 0) return `${minutes / 60} h`
  return `${minutes} min`
}

/** What the step does in a few words, under its name: the kind plus the one setting that tells steps apart. */
export function stepDetail(s: Step): string {
  switch (s.kind) {
    case 'trigger':
      return 'Trigger'
    case 'agent':
    case 'foreach':
      return s.agent ? `${STEP_LABELS[s.kind]} · @${s.agent}` : STEP_LABELS[s.kind]
    case 'llm':
    case 'condition':
      return `${STEP_LABELS[s.kind]} · ${s.model}`
    case 'wait':
      return `Wait · ${waitText(s.minutes)}`
    case 'http':
      return `HTTP · ${s.method}`
    default:
      return STEP_LABELS[s.kind]
  }
}

/**
 * The steps in the order a run reaches them, for a phone that has no canvas: by the fewest edges from the trigger, then
 * top to bottom and left to right as drawn. Steps nothing reaches come last, in drawn order. The trigger is left out:
 * the trigger line above the list already says how the workflow starts.
 */
export function phoneSteps(w: Pick<WorkflowInput, 'steps' | 'edges'>): PhoneStep[] {
  const depth = new Map<string, number>()
  const start = w.steps.find((s) => s.kind === 'trigger')
  if (start) {
    depth.set(start.id, 0)
    let frontier = [start.id]
    for (let d = 1; frontier.length > 0; d++) {
      const next: string[] = []
      for (const e of w.edges) {
        if (frontier.includes(e.from) && !depth.has(e.to)) {
          depth.set(e.to, d)
          next.push(e.to)
        }
      }
      frontier = next
    }
  }
  const far = Number.MAX_SAFE_INTEGER
  return w.steps
    .filter((s) => s.kind !== 'trigger')
    .sort((a, b) => (depth.get(a.id) ?? far) - (depth.get(b.id) ?? far) || a.y - b.y || a.x - b.x)
    .map((s) => ({
      id: s.id,
      kind: s.kind,
      name: s.name || STEP_LABELS[s.kind as Exclude<Step['kind'], 'trigger'>],
      detail: stepDetail(s)
    }))
}
