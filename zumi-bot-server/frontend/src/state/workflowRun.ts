import type { WorkflowLink } from '@zumibot/shared/types'
import { itemCounts } from '@zumibot/shared/workflowForEach'
import type { ConditionCheck } from '@zumibot/shared/routines'
import { eventLabel } from '@zumibot/shared/workflowEvents'
import {
  CONDITION_TEXT,
  handledFailure,
  runCostUsd,
  type Delivery,
  type ItemRun,
  type ItemStatus,
  type RunProgress,
  type Step,
  type Visit,
  type WorkflowRun,
  type WorkflowRunSummary
} from '@zumibot/shared/workflows'
import { workflowsPath } from './route'
import { displayName } from '@zumibot/shared/agentName'
import { capUsd, type CapHold } from '@zumibot/shared/spendCaps'
import { pauseText } from './promptFields'
import { formatUsd } from './usageReport'
import type { StepRunState } from './workflowCanvas'

// Pure rules of the run view. A step's visits are in arrival order in `run.visits`, so "latest" is the last one.

const unfinished = (run: Pick<WorkflowRun, 'status'>): boolean => run.status === 'running' || run.status === 'waiting'

const open = (v: Pick<ItemRun, 'status'>): boolean => v.status === 'running' || v.status === 'waiting'

/** An Agent step (or a For each item) whose turn the user paused, still open until Resume or a message of the user's own. */
export const pausedSlot = (v: Pick<ItemRun, 'status' | 'paused'>): boolean => open(v) && v.paused === true

/**
 * An open visit the user paused: an Agent step's own turn, or a For each visit whose open items are all paused (with
 * several running at once, one paused item leaves the others going, so the visit still runs).
 */
const pausedVisit = (v: Pick<Visit, 'status' | 'paused' | 'items'>): boolean => {
  if (pausedSlot(v)) return true
  const live = open(v) ? (v.items?.filter(open) ?? []) : []
  return live.length > 0 && live.every(pausedSlot)
}

/** A visit's state as shown: paused (an open visit the user paused) or its status. */
export const visitState = (v: Pick<Visit, 'status' | 'paused' | 'items'>): Exclude<StepRunState['status'], 'idle'> =>
  pausedVisit(v) ? 'paused' : v.status

/** The latest visit's state per step, and how many times it ran. A step that never ran has no entry (the canvas draws it idle). */
export function stepStates(run: Pick<WorkflowRun, 'visits'>): Record<string, StepRunState> {
  const out: Record<string, StepRunState> = {}
  for (const v of run.visits) out[v.stepId] = { status: visitState(v), visits: (out[v.stepId]?.visits ?? 0) + 1 }
  return out
}

/**
 * One state mark for a collapsed group's steps: failed if any failed, else waiting if any waits (a paused step waits on
 * the user too), else running, else done once every one that ran is done; null when none ran or one was stopped.
 */
export function groupRunState(states: Record<string, StepRunState>, steps: string[]): StepRunState['status'] | null {
  const ran = steps.flatMap((id) => (Object.hasOwn(states, id) && states[id].status !== 'idle' ? [states[id].status] : []))
  if (ran.length === 0) return null
  if (ran.includes('failed')) return 'failed'
  if (ran.includes('waiting') || ran.includes('paused')) return 'waiting'
  if (ran.includes('running')) return 'running'
  return ran.every((s) => s === 'done') ? 'done' : null
}

export const ROOM_CAPPED_TEXT = 'Room hit its turn limit · post in the room to continue'

/**
 * A paused visit's or item's way on, or a note that Resume carried it on; null otherwise (a stop ends a pause, so it says
 * nothing; a Room visit whose room hit its turn limit says so while it is open, since only the user's own post carries it on).
 * A For each visit says nothing itself: each item row says it, under the item whose chat holds the Resume.
 */
export const visitPauseText = (v: Pick<ItemRun, 'status' | 'paused' | 'capPaused' | 'resumes'> & { capped?: true }): string | null =>
  v.capped === true && (v.status === 'running' || v.status === 'waiting')
    ? ROOM_CAPPED_TEXT
    : v.status === 'stopped'
      ? null
      : pausedSlot(v) && v.capPaused
        ? 'Paused at a spend cap · Continue the run, or press Resume in its chat'
        : pauseText(pausedSlot(v), v.resumes)

/**
 * How many outputs each edge carried in the run, by edge id: every delivery a visit started from, plus the ones still
 * waiting at a step's door. The canvas paints those edges green, as n8n does a connection that ran.
 */
export function edgeRuns(run: Pick<WorkflowRun, 'visits' | 'inbox'>): Record<string, number> {
  const out: Record<string, number> = {}
  const count = (d: Delivery): void => {
    out[d.edgeId] = (out[d.edgeId] ?? 0) + 1
  }
  for (const v of run.visits) v.inputs.forEach(count)
  for (const waiting of Object.values(run.inbox)) waiting.forEach(count)
  return out
}

/** One step's visits, newest first. */
export const visitsOf = (run: Pick<WorkflowRun, 'visits'>, stepId: string): Visit[] =>
  run.visits.filter((v) => v.stepId === stepId).reverse()

/** Every visit by start time, for the phone's list; visits that started together keep their arrival order. */
export const timeline = (run: Pick<WorkflowRun, 'visits'>): Visit[] =>
  run.visits
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v.startedAt - b.v.startedAt || a.i - b.i)
    .map((x) => x.v)

/** The approval that has waited longest, which the run view opens on; null once the run ended (a stop closes them all). */
export function pendingApproval(run: Pick<WorkflowRun, 'visits' | 'snapshot' | 'status'>): Visit | null {
  if (!unfinished(run)) return null
  const approvals = new Set(run.snapshot.steps.filter((s) => s.kind === 'approval').map((s) => s.id))
  let oldest: Visit | null = null
  for (const v of run.visits)
    if (v.status === 'waiting' && approvals.has(v.stepId) && (oldest === null || v.startedAt < oldest.startedAt)) oldest = v
  return oldest
}

/**
 * Retry is for a failed visit that is still its step's latest (an older failure a later visit got past has nothing left
 * to retry), in a run that can still move: the server refuses it in a stopped one.
 */
export function canRetry(run: Pick<WorkflowRun, 'visits' | 'status'>, visit: Visit): boolean {
  // One that went along its failure path is not retried: the run already went on from it.
  if (visit.status !== 'failed' || handledFailure(visit) || !(unfinished(run) || run.status === 'failed')) return false
  const latest = [...run.visits].reverse().find((v) => v.stepId === visit.stepId)
  return latest?.id === visit.id
}

/** Retry for one failed item (carried ones too, which the server runs again): only where its whole visit could be retried. */
export const canRetryItem = (run: Pick<WorkflowRun, 'visits' | 'status'>, visit: Visit, item: ItemRun): boolean =>
  item.status === 'failed' && canRetry(run, visit)

/**
 * A For each's progress line: the position is the ended items (failed ones too, the run goes on past them) plus the ones
 * in hand, which the user may have paused. One in hand is named; several are counted.
 */
export function progressText(p: RunProgress): string {
  const ended = p.done + p.failed
  if (p.current === null) return `${ended} / ${p.total}`
  const running = p.running ?? 1
  if (running > 1) return `${ended + running} / ${p.total} · ${running} running${p.paused ? ` · ${p.pausedItems ?? 1} paused` : ''}`
  return `${ended + 1} / ${p.total} · ${p.current}${p.paused ? ' · paused' : ''}`
}

/** How a run started, in words: the run header, the canvas trigger and the audit log. */
export const VIA_TEXT = {
  manual: 'Manual',
  schedule: 'Schedule',
  webhook: 'Webhook',
  workflow: 'Sub-workflow',
  event: 'Event',
  chat: 'From chat'
} as const

/** The run's trigger in words: an event run names its event, since 'Event' alone would not say which. */
export function viaText(run: Pick<WorkflowRun, 'via' | 'event'>): string {
  return run.via === 'event' && run.event ? eventLabel(run.event.kind) : VIA_TEXT[run.via]
}

/** Under a failed visit that went along its failure path: the run did not stop there. */
export const HANDLED_TEXT = 'Went on along the failure path'

/** An HTTP request visit's request line: "GET https://… · 200" (the URL as stored, any vault key already replaced). */
export const requestLine = (h: NonNullable<Visit['http']>): string =>
  `${h.method} ${h.url}${h.status !== undefined ? ` · ${h.status}` : ''}`

/** The words for a sub-workflow run's start: "Started by Main › Check" with the parent run's address. */
export function parentLine(run: Pick<WorkflowRun, 'parent'>): { text: string; href: string } | null {
  const p = run.parent
  return p ? { text: `Started by ${p.name} › ${p.stepName}`, href: runHref(p.workflowId, p.runId) } : null
}

/** An item's state in words, in the visit panel's list and the audit log. */
export const ITEM_WORDS: Record<ItemStatus | 'paused', string> = {
  pending: 'To go',
  running: 'Running',
  paused: 'Paused',
  waiting: 'Waiting',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped'
}

/** The item list's count line: "31 done · 2 failed · 3 to go"; zero parts other than done are left out. */
export function itemsCountText(items: ItemRun[]): string {
  const c = itemCounts(items)
  return [`${c.done} done`, c.failed ? `${c.failed} failed` : '', c.pending ? `${c.pending} to go` : ''].filter(Boolean).join(' · ')
}

export const canStop = (run: Pick<WorkflowRun, 'status'>): boolean => unfinished(run)

/** What an Approval asks: the question as its visit filled it (the template's fields hold what ran); older visits kept none. */
export function approvalQuestion(visit: Pick<Visit, 'question'>, step: Extract<Step, { kind: 'approval' }>): string {
  const q = visit.question ?? step.question
  return q.trim() ? q : 'Approve?'
}

/** When an open visit goes on by itself: a Wait (running) or a usage-limit wait hold their due time in `until`. */
export function waitsUntil(visit: Pick<Visit, 'status' | 'until'>): number | null {
  return (visit.status === 'running' || visit.status === 'waiting') && visit.until !== undefined ? visit.until : null
}

/**
 * The run view's fetches. An answer shows unless a newer one already did, so a server slower than the poll still updates
 * the view; the poll skips a tick while a fetch is out instead of starting one that supersedes it. reset() drops every
 * answer still out (another run, an unmount).
 */
export function fetchOrder(): { start(): number; land(n: number): boolean; busy(): boolean; reset(): void } {
  let started = 0
  let shown = 0
  const out = new Set<number>()
  return {
    start: () => {
      out.add(++started)
      return started
    },
    land: (n) => {
      if (!out.delete(n) || n <= shown) return false
      shown = n
      return true
    },
    busy: () => out.size > 0,
    reset: () => {
      out.clear()
      shown = started
    }
  }
}

/**
 * Agent progress shows only through a refetch, so the view polls while some visit of an unfinished run is running.
 * Not a For each visit: it stays running for the whole list and every poll would carry every item's output; its item
 * moves (a pause and a Resume too) are in the pushed summary's progress (summaryKey), which refetches. Nor a paused one,
 * which moves only on Resume, whose write pushes `workflows:changed`.
 */
export const needsPolling = (run: Pick<WorkflowRun, 'status' | 'visits'>): boolean =>
  unfinished(run) && run.visits.some((v) => v.status === 'running' && !v.items && !pausedVisit(v))

/** A cost for the page: null when none was reported, so a run of Notify and Wait steps shows no "$0.00". */
export const costText = (usd: number | undefined): string | null => (usd !== undefined && usd > 0 ? formatUsd(usd) : null)

/** The run header's cost: "so far" while the run can still spend more (an unfinished turn reports its cost at its end). */
export function runCostText(run: Pick<WorkflowRun, 'status' | 'visits'>): string | null {
  const text = costText(runCostUsd(run))
  return text && unfinished(run) ? `${text} so far` : text
}

export interface StepCost {
  stepId: string
  usd: number
  visits: number
}

/** Each step's share of the run's cost, the costliest first; only steps that reported one. visits = how many of its visits did. */
export function costByStep(run: Pick<WorkflowRun, 'visits'>): StepCost[] {
  const by = new Map<string, StepCost>()
  for (const v of run.visits) {
    if (!v.costUsd || !(v.costUsd > 0)) continue
    const row = by.get(v.stepId) ?? { stepId: v.stepId, usd: 0, visits: 0 }
    row.usd += v.costUsd
    row.visits++
    by.set(v.stepId, row)
  }
  return [...by.values()].sort((a, b) => b.usd - a.usd)
}

/** What of a pushed summary makes the open run worth fetching again (the push carries no visits). Empty without one. */
export const summaryKey = (s: WorkflowRunSummary | undefined): string =>
  s
    ? JSON.stringify([
        s.status,
        s.waiting,
        s.failed,
        s.endedAt ?? null,
        s.costUsd ?? 0,
        s.progress ?? null,
        s.capHold?.at ?? null,
        s.event ?? null
      ])
    : ''

const pct = (p: number | undefined): string => `${Math.round((p ?? 0) * 100)}%`

/** What Jev found when it checked a webhook call against the trigger's condition. Null when it did not check. */
export function conditionText(c: ConditionCheck | undefined): string | null {
  if (!c) return null
  if (c.met === null) return 'Condition not checked: Jev did not answer, so the run went ahead'
  return c.met ? `Condition met (Jev: ${pct(c.p)} likely)` : `${CONDITION_TEXT} (Jev: ${pct(c.p)} likely)`
}

export const runHref = (workflowId: string, runId: string): string => workflowsPath(workflowId, runId)

/** The one-line bar over a workflow Agent step's chat: its words and the run's address. `stepName` is the step's name now. */
export function chatBarText(link: WorkflowLink, stepName: string | undefined): { lead: string; href: string } {
  const step = stepName?.trim()
  const of = link.item ? `Item ${link.item.n} of ${link.item.total} · ` : ''
  return {
    lead: `${of}${step ? `Step "${step}"` : 'A step'} of workflow ${link.name}`,
    href: runHref(link.workflowId, link.runId)
  }
}

/** How long a visit took, or has taken: "<1 s", "2 s", "1 min 5 s", "1 h 2 min". */
export function durationText(from: number, to: number): string {
  const s = Math.max(0, Math.floor((to - from) / 1000))
  if (s < 1) return '<1 s'
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
}

/**
 * The banner over a run a spend cap holds: why it holds, and what its Continue does. The run's own cap allows one more cap's
 * worth of the run; an agent's daily cap, one more of that agent's day.
 */
export function capHoldBanner(h: CapHold): { text: string; action: string } {
  if (h.kind === 'agent') {
    const who = `@${displayName(h.agent ?? '')}`
    return {
      text: `${who} reached its daily spend cap (${capUsd(h.spentUsd)} of ${capUsd(h.limitUsd)}). Its steps wait.`,
      action: `Allow ${capUsd(h.capUsd)} more today`
    }
  }
  return {
    text: `This run reached its ${capUsd(h.limitUsd)} spend cap (${capUsd(h.spentUsd)} spent). Nothing new starts and its agents are paused.`,
    action: `Continue · allows ${capUsd(h.capUsd)} more`
  }
}
