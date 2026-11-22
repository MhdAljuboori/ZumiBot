import {
  HANDBACK_TOOL,
  handbackMessage,
  type DispatchEntry,
  type DispatchStatus,
  type DispatchStep,
  type DispatchSummary
} from '@zumibot/shared/dispatch'

/**
 * What an agent's view shows. Entries recorded before the recorder knew SubagentHandback hold that call as a step and the
 * CLI's pointer to it as the report: the call's message becomes the report and the step goes.
 */
export function agentBody(entry: Pick<DispatchEntry, 'steps' | 'report'>): { steps: DispatchStep[]; report: string | null } {
  let report = entry.report
  const steps = entry.steps.filter((s) => {
    const m = s.kind === 'tool' && s.name === HANDBACK_TOOL ? handbackMessage(s.input) : null
    if (m !== null) report = m
    return m === null
  })
  return { steps, report }
}

/**
 * Whether the steps show. `pick` is the reader's own toggle (null: none yet). By default they show while the agent runs or
 * when there is no report to read; a finished agent opens on its report with the steps folded.
 */
export function stepsShown(pick: boolean | null, running: boolean, hasReport: boolean): boolean {
  return pick ?? (running || !hasReport)
}

export const stepsLabel = (n: number): string => (n === 1 ? '1 step' : `${n} steps`)

/** One reply's dispatched agents; each row's depth is how far it is nested under the agent that dispatched it. */
export interface DispatchGroup {
  turn: string
  label: string
  member?: string
  rows: { s: DispatchSummary; depth: number }[]
}

/** Newest reply first; inside a reply, the agents in start order, each followed by the ones it dispatched. */
export function groupDispatch(list: readonly DispatchSummary[], fmtTime: (ms: number) => string): DispatchGroup[] {
  const turns = new Map<string, DispatchSummary[]>()
  for (const s of list) turns.set(s.turn, [...(turns.get(s.turn) ?? []), s])
  const ids = new Set(list.map((s) => s.id))
  const groups = [...turns.entries()].map(([turn, all]) => {
    const byStart = [...all].sort((a, b) => a.startedAt - b.startedAt)
    const rows: DispatchGroup['rows'] = []
    const placed = new Set<string>()
    const walk = (s: DispatchSummary, depth: number): void => {
      if (placed.has(s.id)) return
      placed.add(s.id)
      rows.push({ s, depth })
      for (const child of byStart) if (child.parent === s.id) walk(child, depth + 1)
    }
    // An agent whose parent is not listed (another reply's, or hidden) stands on its own.
    for (const s of byStart) if (s.parent === null || !ids.has(s.parent)) walk(s, 0)
    const start = byStart[0].startedAt
    const member = all.find((s) => s.member !== undefined)?.member
    return { turn, start, last: Math.max(...all.map((s) => s.startedAt)), member, rows }
  })
  groups.sort((a, b) => b.last - a.last)
  return groups.map((g, i) => ({
    turn: g.turn,
    label: i === 0 ? 'This reply' : fmtTime(g.start),
    ...(g.member === undefined ? {} : { member: g.member }),
    rows: g.rows
  }))
}

const ENDED: Record<Exclude<DispatchStatus, 'running'>, string> = {
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted'
}

function tokensLabel(n: number): string {
  return n < 1000 ? `${n} tokens` : `${Math.round(n / 1000)}k tokens`
}

function timeLabel(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(sec / 60)
  return m === 0 ? `${sec}s` : `${m}m ${String(sec % 60).padStart(2, '0')}s`
}

/** "7 tool uses · 41k tokens · 1m 12s", or "Done · …" once it ended. A running agent's time counts up from its start. */
export function usageLine(s: DispatchSummary, nowMs: number): string {
  const parts: string[] = []
  if (s.status !== 'running') parts.push(ENDED[s.status])
  if (s.usage.toolUses !== null) parts.push(s.usage.toolUses === 1 ? '1 tool use' : `${s.usage.toolUses} tool uses`)
  if (s.usage.tokens !== null) parts.push(tokensLabel(s.usage.tokens))
  const ms = s.status === 'running' ? nowMs - s.startedAt : (s.usage.durationMs ?? (s.endedAt === null ? null : s.endedAt - s.startedAt))
  if (ms !== null) parts.push(timeLabel(ms))
  return parts.join(' · ')
}

/** The side panel list's badge: "N running" while any runs, else how many there are. */
export function dispatchBadge(list: readonly DispatchSummary[]): { text: string; live: boolean } | null {
  const running = list.filter((s) => s.status === 'running').length
  if (running > 0) return { text: `${running} running`, live: true }
  return list.length > 0 ? { text: String(list.length), live: false } : null
}

/** The agents whose tool call waits on an approval card in the chat. */
export function waitingIds(list: readonly DispatchSummary[], pendingToolIds: ReadonlySet<string>): Set<string> {
  return new Set(list.filter((s) => s.openTools.some((t) => pendingToolIds.has(t))).map((s) => s.id))
}

/** For an Agent row in the chat: Watch while its subagent runs, View after, nothing when none was recorded. */
export function linkState(list: readonly DispatchSummary[] | null, toolId: string): 'running' | 'ended' | null {
  const s = list?.find((x) => x.id === toolId)
  return s === undefined ? null : s.status === 'running' ? 'running' : 'ended'
}
