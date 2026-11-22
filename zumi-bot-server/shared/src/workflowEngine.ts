import { reachableFrom } from './workflowGraph'
import { RUN_VISITS_MAX, STEP_VISITS_MAX, failureText, haltingFailure } from './workflows'
import type { Delivery, Visit, WorkflowRun } from './workflows'

// The run's moving parts, apart from its id, status and clock: the runner saves these with the run.
export type EngineState = Pick<WorkflowRun, 'snapshot' | 'visits' | 'inbox' | 'allowance' | 'halted'>

// Own keys only: these maps are keyed by step ids, and an inherited member (`constructor`) must never read as a value.
const own = <T>(o: Record<string, T>, key: string): T | undefined => (Object.hasOwn(o, key) ? o[key] : undefined)

export function newState(snapshot: WorkflowRun['snapshot']): EngineState {
  return { snapshot, visits: [], inbox: {}, allowance: { perStep: {}, total: RUN_VISITS_MAX }, halted: false }
}

/** A done visit's output goes into the inbox of every edge leaving its port; a handled failure's text along its error edges. */
export function deliver(s: EngineState, visit: Visit): EngineState {
  const inbox = { ...s.inbox }
  const text = visit.status === 'failed' ? failureText(visit) : (visit.output ?? '')
  for (const e of s.snapshot.edges) {
    if (e.from !== visit.stepId || e.port !== visit.port) continue
    inbox[e.to] = [...(own(inbox, e.to) ?? []), { edgeId: e.id, from: visit.stepId, text }]
  }
  return { ...s, inbox }
}

const liveSteps = (s: EngineState) => new Set(s.visits.filter((v) => v.status === 'running' || v.status === 'waiting').map((v) => v.stepId))

/**
 * The join rule. A step with deliveries starts once no step that could still feed one of its missing inputs is live or
 * about to start; pass 2 stops two partial inboxes that wait on each other from deadlocking.
 */
export function takeStarts(s: EngineState): { state: EngineState; starts: { stepId: string; inputs: Delivery[] }[] } {
  if (s.halted) return { state: s, starts: [] }
  const live = liveSteps(s)
  const candidates = Object.keys(s.inbox).filter((id) => s.inbox[id].length > 0 && !live.has(id))
  const edges = s.snapshot.edges
  let firing = candidates.filter((t) => {
    const got = new Set(s.inbox[t].map((d) => d.edgeId))
    const missing = edges.filter((e) => e.to === t && !got.has(e.id)).map((e) => e.from)
    if (!missing.length) return true
    const others = [...live, ...candidates.filter((c) => c !== t)]
    const reach = reachableFrom(edges, others)
    return !missing.some((m) => reach.has(m))
  })
  if (!firing.length && !live.size) firing = candidates
  if (!firing.length) return { state: s, starts: [] }
  const inbox = { ...s.inbox }
  for (const id of firing) inbox[id] = []
  // Edge order, not arrival order, so a step's input does not change from run to run; the sort is stable, so repeat
  // deliveries on one edge keep their arrival order.
  const order = new Map(edges.map((e, i) => [e.id, i]))
  const byEdge = (inputs: Delivery[]) => [...inputs].sort((a, b) => (order.get(a.edgeId) ?? 0) - (order.get(b.edgeId) ?? 0))
  return { state: { ...s, inbox }, starts: firing.map((stepId) => ({ stepId, inputs: byEdge(s.inbox[stepId]) })) }
}

const count = (s: EngineState, stepId: string) => s.visits.filter((v) => v.stepId === stepId).length

export function capHit(s: EngineState, stepId: string): boolean {
  return count(s, stepId) >= (own(s.allowance.perStep, stepId) ?? STEP_VISITS_MAX) || s.visits.length >= s.allowance.total
}

export function outcome(s: EngineState): 'running' | 'waiting' | 'done' | 'failed' {
  if (s.visits.some((v) => v.status === 'running')) return 'running'
  if (s.visits.some((v) => v.status === 'waiting')) return 'waiting'
  if (takeStarts(s).starts.length) return 'running'
  const latest = new Map<string, Visit>()
  for (const v of s.visits) latest.set(v.stepId, v)
  // A failure taken along its failure path is not the run's: the run went on.
  return [...latest.values()].some(haltingFailure) ? 'failed' : 'done'
}

/**
 * Retry of a step that hit a cap is a deliberate click: 20 more visits for it and for every other step that used up its
 * allowance (a loop's other steps are there too, so one Retry pushes the whole loop on), and 200 more for the run.
 */
export function retryAllowance(s: EngineState, stepId: string): EngineState {
  const raised = [...new Set([stepId, ...s.snapshot.steps.map((x) => x.id)])].flatMap((id): [string, number][] => {
    const n = count(s, id)
    return id === stepId || n >= (own(s.allowance.perStep, id) ?? STEP_VISITS_MAX) ? [[id, n + STEP_VISITS_MAX]] : []
  })
  // fromEntries defines own keys, so no step id can reach the object's prototype.
  const perStep = Object.fromEntries([...Object.entries(s.allowance.perStep), ...raised])
  return { ...s, halted: false, allowance: { perStep, total: s.visits.length + RUN_VISITS_MAX } }
}

/** One input as it is; several labelled by the name of the step they came from, in the inbox's edge order. */
export function joinText(inputs: Delivery[], names: Record<string, string>): string {
  if (inputs.length === 1) return inputs[0].text
  return inputs.map((d) => `From ${own(names, d.from) ?? d.from}:\n${d.text}`).join('\n\n')
}
