import { triggerOutput } from '@zumibot/shared/workflowTemplate'
import { eventLabel } from '@zumibot/shared/workflowEvents'
import {
  handledFailure,
  type ItemRun,
  type Port,
  type RunParent,
  type Step,
  type StepKind,
  type Visit,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowTrigger
} from '@zumibot/shared/workflows'
import { STEP_LABELS } from './workflowCanvas'
import { approvalQuestion, conditionText, timeline } from './workflowRun'

// Pure model of a finished run's audit log: the trigger, every visit in start order, and how the run ended.

export const FOLD_LINES = 6
export const FOLD_CHARS = 600

export interface AuditTrigger {
  via: WorkflowRun['via']
  late: boolean
  at: number
  label: string // Manual, Schedule, Webhook, Sub-workflow, the event's name, or 'From chat <title>'
  icon: WorkflowTrigger['kind'] // an event run draws its kind's icon; a chat or sub-workflow run, the manual one
  body: unknown | null // event and chat runs: the event's JSON (run.call.body); the others null
  callLine: string | null // webhook only: 'POST' or 'POST ?a=1&b=2' (query keys in stored order)
  text: string | null // manual, sub-workflow, event and chat: run input ('' when none); webhook: body JSON (triggerOutput); schedule: null
  parent: RunParent | null // a sub-workflow's: the run and step that started it
  condition: string | null // webhook only: what Jev found when it checked the call against the trigger's condition
}
export interface AuditEntry {
  n: number // 2, 3, … (the trigger is 1)
  visit: Visit
  step: Step | undefined
  name: string
  kind: Exclude<StepKind, 'trigger'> | null
  visitLabel: string | null // only when that step has more than one visit in the run
  answer: string | null
  question: string | null
  showOutput: boolean // a Condition, Wait and Notify pass their input on unchanged, so an Output box would repeat it
  edited: boolean
  endedAt: number | null
  items: ItemRun[] | null
  handled: boolean // failed, and the run went on along the step's failure path
}
export interface AuditEnd {
  status: WorkflowRunStatus
  at: number | null
  error: string | null
}
export interface AuditLogModel {
  trigger: AuditTrigger
  entries: AuditEntry[]
  end: AuditEnd
}

const ANSWERS: Partial<Record<Port, string>> = { yes: 'Yes', no: 'No', approved: 'Approved', rejected: 'Rejected', error: 'Failure path' }
const NO_OUTPUT = new Set<StepKind>(['condition', 'wait', 'notify'])

const queryText = (query: Record<string, string>): string => {
  const pairs = Object.entries(query).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  return pairs.length ? ` ?${pairs.join('&')}` : ''
}

function triggerOf(run: WorkflowRun): AuditTrigger {
  const first = run.visits.find((v) => run.snapshot.steps.find((s) => s.id === v.stepId)?.kind === 'trigger')
  const at = first?.startedAt ?? run.startedAt
  const parent = run.parent ?? null
  const head = { late: run.late, at, body: null, parent, condition: conditionText(run.condition) }
  if (run.via === 'schedule') return { ...head, via: run.via, label: 'Schedule', icon: 'schedule', callLine: null, text: null }
  if (run.via === 'webhook') {
    const call = run.call ?? null
    return {
      ...head,
      via: run.via,
      label: 'Webhook',
      icon: 'webhook',
      callLine: call ? `${call.method}${queryText(call.query)}` : null,
      text: first?.output ?? triggerOutput(call, run.input ?? null)
    }
  }
  // Whitespace alone reads as no input, not as an empty-looking box.
  const text = run.input?.trim() ? run.input : ''
  if (run.via === 'event') {
    const kind = run.event?.kind
    return {
      ...head,
      via: run.via,
      label: kind ? eventLabel(kind) : 'Event',
      icon: kind ?? 'manual',
      body: run.call?.body ?? null,
      callLine: null,
      text
    }
  }
  if (run.via === 'chat') {
    return {
      ...head,
      via: run.via,
      label: run.chat?.title ? `From chat ${run.chat.title}` : 'From chat',
      icon: 'manual',
      body: run.call?.body ?? null,
      callLine: null,
      text
    }
  }
  return { ...head, via: run.via, label: run.via === 'workflow' ? 'Sub-workflow' : 'Manual', icon: 'manual', callLine: null, text }
}

/** The server appends the user's note to an approved text, so the text that was approved is what comes before it. */
function approvedEdit(v: Visit): boolean {
  if (v.port !== 'approved' || v.output === undefined) return false
  const suffix = v.note ? `\n\nNote from the user: ${v.note}` : ''
  const text = suffix && v.output.endsWith(suffix) ? v.output.slice(0, -suffix.length) : v.output
  return text !== v.input
}

/** The log of a finished run; null while it runs or waits, since a step may still add to it. */
export function auditLog(run: WorkflowRun): AuditLogModel | null {
  if (run.status === 'running' || run.status === 'waiting') return null
  const byId = new Map(run.snapshot.steps.map((s) => [s.id, s]))
  const ran = new Map<string, number>()
  for (const v of run.visits) ran.set(v.stepId, (ran.get(v.stepId) ?? 0) + 1)
  const entries: AuditEntry[] = []
  for (const visit of timeline(run)) {
    const step = byId.get(visit.stepId)
    if (step?.kind === 'trigger') continue
    const kind = step ? step.kind : null
    entries.push({
      n: entries.length + 2,
      visit,
      step,
      name: step?.name.trim() || (kind ? STEP_LABELS[kind] : 'A step'),
      kind,
      visitLabel: (ran.get(visit.stepId) ?? 0) > 1 ? `Visit ${visit.n}` : null,
      answer: visit.port ? (ANSWERS[visit.port] ?? null) : null,
      question: step?.kind === 'approval' ? approvalQuestion(visit, step) : null,
      showOutput: kind === null || !NO_OUTPUT.has(kind),
      edited: step?.kind === 'approval' && approvedEdit(visit),
      endedAt: visit.endedAt ?? run.endedAt ?? null,
      items: visit.items ? [...visit.items].sort((a, b) => a.n - b.n) : null,
      handled: handledFailure(visit)
    })
  }
  return { trigger: triggerOf(run), entries, end: { status: run.status, at: run.endedAt ?? null, error: run.error ?? null } }
}

/** A long text's first part: up to FOLD_LINES lines and FOLD_CHARS characters, cut at a line break when one is near the end. */
export function foldText(text: string): { preview: string; more: boolean } {
  let preview = text.split('\n').slice(0, FOLD_LINES).join('\n')
  if (preview.length > FOLD_CHARS) {
    const head = preview.slice(0, FOLD_CHARS)
    const brk = head.lastIndexOf('\n')
    preview = brk >= FOLD_CHARS / 2 ? head.slice(0, brk) : head
  }
  preview = preview.trimEnd()
  return { preview, more: preview.length < text.trimEnd().length }
}

/** 14:02:11 in the workflow's time zone (the run title's), 24-hour clock. */
export function clockTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(ms)
}
