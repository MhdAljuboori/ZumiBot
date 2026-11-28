import type { Routine, RoutineRun, RoutinesSnapshot } from '@zumibot/shared/routines'
import { describeSchedule, nextRun } from '@zumibot/shared/schedule'
import { isGroup, type AgentSummary, type ChatMeta } from '@zumibot/shared/types'

export interface RoutineRow {
  id: string
  name: string
  icon: 'schedule' | 'manual' | 'webhook'
  subline: string
  dot: 'done' | 'waiting' | 'failed' | null
  enabled: boolean
  warning: string | null
}

const MINUTE = 60_000

/** `9h`, `25m` or `2d`; a run under a minute away still reads 1m. */
function untilLabel(ms: number): string {
  if (ms < 60 * MINUTE) return `${Math.max(1, Math.ceil(ms / MINUTE))}m`
  if (ms < 48 * 60 * MINUTE) return `${Math.floor(ms / (60 * MINUTE))}h`
  return `${Math.floor(ms / (24 * 60 * MINUTE))}d`
}

/** The agent or chat the routine points at is gone (what would make its next run fail). */
export function targetWarning(r: Routine, agents: AgentSummary[], chats: ChatMeta[]): string | null {
  const t = r.target
  // As the runner sees it: an agent whose file is broken can't run either.
  const missing = (name: string): boolean => !agents.some((a) => a.name === name && a.error === null)
  if (t.kind === 'new-chat') return missing(t.agent) ? `Agent "${t.agent}" not found` : null
  if (t.kind === 'new-group') {
    const gone = t.members.find(missing)
    return gone === undefined ? null : `Agent "${gone}" not found`
  }
  const chat = chats.find((c) => c.id === t.chatId)
  if (!chat) return 'Chat not found'
  // A group room runs with the members it has left.
  return !isGroup(chat) && missing(chat.agentName) ? `Agent "${chat.agentName}" not found` : null
}

export function anyWaiting(s: RoutinesSnapshot): boolean {
  return Object.values(s.runs).some((runs) => runs.some((r) => r.status === 'waiting'))
}

// A skipped webhook call made no run, so it neither clears nor sets the dot.
function newestDot(runs: RoutineRun[]): RoutineRow['dot'] {
  let newest: RoutineRun | undefined
  for (const r of runs) if (r.status !== 'skipped' && (!newest || r.startedAt > newest.startedAt)) newest = r
  // A wait for the usage limit, or a pause the user chose, is still under way and asks nothing new of the user.
  return newest && newest.status !== 'running' && newest.status !== 'limited' && newest.status !== 'paused' && newest.status !== 'skipped'
    ? newest.status
    : null
}

function subline(r: Routine, runs: RoutineRun[], now: number): string {
  let base: string
  if (r.trigger.kind === 'webhook') base = 'Webhook'
  else if (r.trigger.kind === 'manual') base = 'Manual'
  else {
    base = describeSchedule(r.trigger.schedule)
    // The row's switch shows Off, so the line keeps the schedule; an Off routine has no next run.
    const at = r.enabled ? (r.nextRunAt ?? nextRun(r.trigger.schedule, r.timeZone, now)) : null
    if (at !== null) base += ` · next in ${untilLabel(Math.max(0, at - now))}`
  }
  if (runs.some((x) => x.status === 'waiting')) return `${base} · waiting for approval`
  if (runs.some((x) => x.status === 'limited')) return `${base} · waiting for limit reset`
  return runs.some((x) => x.status === 'paused') ? `${base} · paused by you` : base
}

export function routineRows(s: RoutinesSnapshot, agents: AgentSummary[], chats: ChatMeta[], now: number, query: string): RoutineRow[] {
  const q = query.trim().toLowerCase()
  return s.routines
    .filter((r) => r.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => {
      const runs = s.runs[r.id] ?? []
      return {
        id: r.id,
        name: r.name,
        icon: r.trigger.kind,
        subline: subline(r, runs, now),
        dot: newestDot(runs),
        enabled: r.enabled,
        warning: targetWarning(r, agents, chats)
      }
    })
}
