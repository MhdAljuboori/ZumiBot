import { matchAgent } from '@zumibot/shared/agentMatch'
import { AGUI_TEXT } from '@zumibot/shared/agui'
import { ZUMI_BOT_NAME } from '@zumibot/shared/zumiBot'
import { engineCaps, isRemoteAgent, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import type { Routine } from '@zumibot/shared/routines'
import type { AgentSummary } from '@zumibot/shared/types'
import type { Workflow } from '@zumibot/shared/workflows'
import { said } from './authoring'

// The agent names a routine or workflow step holds, as the user says them ("@X Expert") turned into the file's own
// name, before the authoring conversion fills a folder from that name.

export const ZUMI_BOT_REFUSED = "Zumi Bot can't run routines or workflow steps"
// The bridge drops an error over 400 characters, so a long roster is cut and counted instead.
const ROSTER_MAX = 300

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function unknownAgent(named: string, loadable: AgentSummary[]): string {
  const names = loadable.map((a) => said(a.name, 64)).sort()
  let shown = ''
  let count = 0
  for (const n of names) {
    const next = shown ? `${shown}, ${n}` : n
    if (next.length > ROSTER_MAX) break
    shown = next
    count++
  }
  const roster = names.length === 0 ? 'none' : count < names.length ? `${shown}, and ${names.length - count} more` : shown
  return `Unknown agent "${said(named)}". Agents: ${roster}`
}

/** A place an agent can sit in a routine or workflow: the routine's target, or a workflow step by its handle. */
export const ROUTINE_PLACE = 'target'
export const keptKey = (place: string, agent: string): string => `${place}\n${agent}`

/**
 * The exact name first, else one agent whose name or display name matches without case; Zumi Bot never. A remote agent
 * only when `kept` (the stored routine's or workflow's `keptKey`s: which agent sits in which place) names it there: Zumi Bot
 * may keep one the user chose, in the place they chose it, never add one or move it to another place, so it can still edit a
 * workflow that holds one.
 */
export function agentResolver(
  agents: AgentSummary[],
  kept: ReadonlySet<string> = new Set(),
  caps: (e: Engine) => EngineCaps = engineCaps
): (named: string, place?: string) => string {
  // A broken file can't run, so it is as unknown as a missing one.
  const loadable = agents.filter((a) => a.error === null && a.name !== ZUMI_BOT_NAME)
  return (named, place) => {
    const m = matchAgent(named, agents)
    if (m.ok) {
      const held = place !== undefined && kept.has(keptKey(place, m.name))
      if (
        isRemoteAgent(
          agents.find((a) => a.name === m.name),
          caps
        ) &&
        !held
      )
        throw new Error(AGUI_TEXT.zumiBotPick(said(m.name, 64)))
      return m.name
    }
    throw new Error(m.reason === 'zumi-bot' ? ZUMI_BOT_REFUSED : unknownAgent(named, loadable))
  }
}

/** Which agents a stored routine holds, in which place (its target). */
export const routineAgents = (r: Routine): Set<string> =>
  new Set(
    (r.target.kind === 'new-chat' ? [r.target.agent] : r.target.kind === 'new-group' ? r.target.members : []).map((a) =>
      keptKey(ROUTINE_PLACE, a)
    )
  )

/** Which agents a stored workflow holds, in which step (by handle). */
export const workflowAgents = (w: Workflow): Set<string> =>
  new Set(
    w.steps.flatMap((s) =>
      s.kind === 'agent' || s.kind === 'foreach'
        ? [keptKey(s.handle, s.agent)]
        : s.kind === 'room' && s.members
          ? s.members.map((m) => keptKey(s.handle, m))
          : []
    )
  )

// Only well-shaped names are rewritten: anything else reaches the authoring parsers, which refuse it with the reason.
export function withRoutineAgents(raw: unknown, resolve: (named: string, place?: string) => string): unknown {
  if (!isObj(raw) || !isObj(raw.target)) return raw
  const t = raw.target
  if (t.kind === 'new-chat' && typeof t.agent === 'string') return { ...raw, target: { ...t, agent: resolve(t.agent, ROUTINE_PLACE) } }
  if (t.kind === 'new-group' && Array.isArray(t.members)) {
    return { ...raw, target: { ...t, members: t.members.map((m) => (typeof m === 'string' ? resolve(m, ROUTINE_PLACE) : m)) } }
  }
  return raw
}

export function withWorkflowAgents(raw: unknown, resolve: (named: string, place?: string) => string): unknown {
  if (!isObj(raw) || !Array.isArray(raw.steps)) return raw
  const steps = raw.steps.map((s) => {
    if (!isObj(s)) return s
    const place = typeof s.handle === 'string' ? s.handle : undefined
    if ((s.kind === 'agent' || s.kind === 'foreach') && typeof s.agent === 'string') return { ...s, agent: resolve(s.agent, place) }
    // A room built from agents: the same names, the same refusals.
    if (s.kind === 'room' && Array.isArray(s.members))
      return { ...s, members: s.members.map((m) => (typeof m === 'string' ? resolve(m, place) : m)) }
    return s
  })
  return { ...raw, steps }
}
