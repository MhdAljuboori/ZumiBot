import type { CommandPick } from './commands'
import type { ConditionCheck, Schedule, WebhookCall } from './routines'
import type { CapHold } from './spendCaps'

export type StepKind =
  | 'trigger'
  | 'agent'
  | 'room'
  | 'foreach'
  | 'llm'
  | 'condition'
  | 'approval'
  | 'wait'
  | 'notify'
  | 'http'
  | 'transform'
  | 'workflow'
  | 'chat'
// error: the On failure path, only on a step whose onFailure is 'branch' (stepPorts).
export type Port = 'out' | 'yes' | 'no' | 'approved' | 'rejected' | 'error'
export type ModelAlias = 'opus' | 'sonnet' | 'haiku'
export type Effort = 'low' | 'medium' | 'high'
// op absent = equals, as stored before; 'contains' is a case-sensitive substring test.
export interface TriggerFilter {
  field: string
  equals: string
  op?: 'contains'
}
export type EventKind = 'reply' | 'todo' | 'inbox' | 'file' | 'email'
export type FileChange = 'added' | 'changed' | 'removed'
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export const HTTP_METHODS: readonly HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
export interface HttpHeader {
  name: string
  value: string
}
export interface TransformField {
  name: string
  path: string
}

// The trigger's config sits on the workflow, not on its step, so the scheduler and the hooks read it as they do a
// routine's; the trigger step is only the node the graph starts from.
export type WorkflowTrigger =
  | { kind: 'manual' }
  | { kind: 'schedule'; schedule: Schedule }
  | { kind: 'webhook'; sample: WebhookCall | null; filters: TriggerFilter[]; condition?: string } // condition: a plain-language test Jev judges on each call (jev.ts)
  | { kind: 'reply'; filters: TriggerFilter[] }
  | { kind: 'todo'; filters: TriggerFilter[] }
  | { kind: 'inbox'; filters: TriggerFilter[] }
  | { kind: 'file'; path: string; pattern: string; changes: FileChange[]; filters: TriggerFilter[] }
  // account: a Vault login's id, never its password.
  | { kind: 'email'; account: string; host: string; port: number; folder: string; filters: TriggerFilter[] }

/** A tool call a workflow step lets through without a card. command: Bash only, the exact command; agent: only that room member's calls. */
export interface StepRule {
  tool: string
  command?: string
  unsandboxed?: true
  agent?: string
}

interface StepBase {
  id: string
  handle: string
  name: string
  x: number
  y: number
}
// 'branch': a failure of the step's own goes along its error port instead of halting the run. Absent: halt, as before.
type Fails = { onFailure?: 'branch' }
export type Step =
  | (StepBase & { kind: 'trigger' })
  // keep: the step's chat stays in the sidebar (not archived) when it ends done; title names it. command: a pick whose name still leads the saved prompt.
  | (StepBase &
      Fails & {
        kind: 'agent'
        agent: string
        prompt: string
        cwd: string
        model?: ModelAlias
        keep?: true
        title?: string
        command?: CommandPick
      })
  // concurrency: how many items run at once; absent = one after another.
  // room: the template group room's chat id; each visit posts the prompt into a fresh copy of it. rules: tool calls the user
  // pre-allowed for this step, applied to the copy's turns (see stepRules.ts). members/role/cwd: a room built from these agents
  // instead of a template (room is then ''); section: where a kept room goes.
  | (StepBase &
      Fails & {
        kind: 'room'
        room: string
        prompt: string
        rules?: StepRule[]
        keep?: true
        title?: string
        section?: string
        command?: CommandPick
        members?: string[]
        role?: string
        cwd?: string
      })
  | (StepBase &
      Fails & {
        kind: 'foreach'
        agent: string
        prompt: string
        cwd: string
        model?: ModelAlias
        concurrency?: 2 | 3
        command?: CommandPick
      })
  | (StepBase & Fails & { kind: 'llm'; prompt: string; system?: string; model: ModelAlias; effort?: Effort })
  | (StepBase & Fails & { kind: 'condition'; question: string; model: ModelAlias })
  | (StepBase & { kind: 'approval'; question: string; editable: boolean })
  | (StepBase & { kind: 'wait'; minutes: number })
  | (StepBase & { kind: 'notify'; title: string; body?: string })
  // key: a vault API key's item id, never its value; the templates name it as {{key}}.
  // allowLocalNetwork: the user's opt-in to this machine and the LAN (loopback and private addresses); absent = public only.
  | (StepBase &
      Fails & {
        kind: 'http'
        method: HttpMethod
        url: string
        headers: HttpHeader[]
        body?: string
        bodyType: 'json' | 'text'
        key?: string
        allowLocalNetwork?: true
      })
  | (StepBase & Fails & { kind: 'transform'; fields: TransformField[]; format: 'json' | 'lines' })
  // workflow: the child workflow's id. input: the child's trigger text.
  | (StepBase & Fails & { kind: 'workflow'; workflow: string; input: string })
  // chat: an existing chat or room's id; the prompt is posted there as the user's own message. session 'fresh': start its agents
  // over, seeded from the recent messages (a routine's sessionPolicy).
  | (StepBase & Fails & { kind: 'chat'; chat: string; prompt: string; session?: 'fresh'; command?: CommandPick })

/** A room step built from agents (no template room to copy). */
export const roomFromAgents = (
  s: Extract<Step, { kind: 'room' }>
): s is Extract<Step, { kind: 'room' }> & { members: string[]; role: string; cwd: string } => s.members !== undefined

export interface Edge {
  id: string
  from: string
  port: Port
  to: string
}

// A sticky note on the canvas: Markdown the user writes for people, never read by the engine or any template.
export type NoteColor = 1 | 2 | 3 | 4 | 5 | 6 | 7 | `#${string}`
export interface Note {
  id: string
  x: number
  y: number
  width: number
  height: number
  color: NoteColor
  text: string
}
export const NOTE_HEX_RE = /^#[0-9a-f]{6}$/
export const NOTE_TEXT_MAX = 10_000
export const NOTES_MAX = 100
export const NOTE_MAX_SIDE = 5_000
export const NOTE_MIN = { width: 150, height: 80 }
export const NOTE_DEFAULT = { width: 240, height: 160, color: 1 as NoteColor, text: '## Note\nDouble-click to edit.' }
/** Workflows and runs stored before notes have none. */
export const notesOf = (w: { notes?: Note[] }): Note[] => w.notes ?? []

// A named box round steps and notes, for people: the engine, templates and problemsOf never read it. Its members are ids.
export interface CanvasGroup {
  id: string
  name: string
  description?: string
  steps: string[]
  notes: string[]
}
export const GROUP_NAME_MAX = 100
export const GROUP_DESCRIPTION_MAX = 145
export const GROUPS_MAX = 50
/** Workflows and runs stored before groups have none. */
export const groupsOf = (w: { groups?: CanvasGroup[] }): CanvasGroup[] => w.groups ?? []

export interface Workflow {
  id: string
  name: string
  enabled: boolean
  timeZone: string
  trigger: WorkflowTrigger
  steps: Step[]
  edges: Edge[]
  notes?: Note[]
  groups?: CanvasGroup[]
  spendCap?: number // USD one run may spend (spendCaps.ts); absent = no cap
  limitPolicy?: 'skip' // a run whose turn the usage limit stops is skipped; absent = wait for the reset
  missedPolicy?: 'skip' // a schedule run that came due while the server was off is skipped; absent = run once, late
  nextRunAt: number | null
  createdAt: number
  updatedAt: number
}
/** What the client saves. id: a saved workflow's id, or null for a new one (there are no drafts; an unknown id is refused). */
export type WorkflowInput = Pick<Workflow, 'name' | 'enabled' | 'timeZone' | 'trigger' | 'steps' | 'edges' | 'notes' | 'groups'> & {
  id: string | null
  spendCap?: number
  limitPolicy?: 'skip'
  missedPolicy?: 'skip'
}

/** One output on its way to a step: which edge carried it and from which step. */
export interface Delivery {
  edgeId: string
  from: string
  text: string
}

export type ItemStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped'
/** One list item of a For each visit; `id` names its slot, so a late answer for a replaced run finds nothing. */
export interface ItemRun {
  id: string
  n: number
  text: string
  status: ItemStatus
  chatId?: string
  messageId?: string
  until?: number
  // Its turn paused by the user: open until Resume's Continue or a message of the user's own, as an Agent step's visit.
  // capPaused: a spend cap asked that pause, not the user.
  paused?: true
  capPaused?: true
  resumes?: number
  output?: string
  error?: string
  costUsd?: number
  carried?: true // ended in an earlier visit of this step; not run in this one
  startedAt?: number
  endedAt?: number
}

export interface Visit {
  id: string
  stepId: string
  n: number // nth visit of that step in this run
  status: 'running' | 'waiting' | 'done' | 'failed' | 'stopped'
  input: string
  inputs: Delivery[]
  output?: string
  port?: Port
  reason?: string
  note?: string
  chatId?: string
  messageId?: string
  until?: number
  missing?: string[]
  error?: string
  // An Agent step whose turn the user paused: open (running) until Resume's Continue, which it then follows (resumes counts
  // those), or a message of the user's own, which fails it "Continued by hand". capPaused: a spend cap asked that pause.
  paused?: true
  capPaused?: true
  resumes?: number
  // A Notify visit's filled text as sent, kept so recover() can file its Inbox message without filling templates again.
  title?: string
  body?: string
  question?: string // an Approval visit's question, filled raw as it began; absent in visits stored before it was kept
  // USD the CLI reported for this visit's model call or agent turns; absent when none reported a cost.
  costUsd?: number
  items?: ItemRun[] // a For each visit's list, one run per item
  // An HTTP request visit's request, its URL with any vault key scrubbed, and the answer's status once there is one.
  http?: { method: HttpMethod; url: string; status?: number }
  childRunId?: string // a Sub-workflow visit's child run, named in the visit's own first write
  capped?: true // a Room visit's room hit the hop cap before its members stopped, so its output may be partial
  startedAt: number
  endedAt?: number
}

// Not RunStatus: routines own that name.
export type WorkflowRunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'skipped'
/** Who started a sub-workflow's run: the parent run's step visit, and how deep in a chain of sub-workflows this run is (1 first). */
export interface RunParent {
  workflowId: string
  runId: string
  visitId: string
  name: string
  stepName: string
  depth: number
}
export interface WorkflowRun {
  id: string
  workflowId: string
  via: 'manual' | 'schedule' | 'webhook' | 'workflow' | 'event' | 'chat'
  late: boolean
  status: WorkflowRunStatus
  parent?: RunParent
  // event: what started an 'event' run; depth only for inbox runs (1 = started by a message from a non-inbox run).
  // chat: the chat a /run-workflow started a 'chat' run from.
  event?: { kind: EventKind; depth?: number }
  chat?: { chatId: string; title: string }
  snapshot: { steps: Step[]; edges: Edge[]; notes?: Note[]; groups?: CanvasGroup[] }
  call?: WebhookCall
  input?: string
  visits: Visit[]
  // Outputs waiting at each step's door, and how many more visits each step and the run may still make.
  inbox: Record<string, Delivery[]>
  allowance: { perStep: Record<string, number>; total: number }
  halted: boolean // a visit failed: nothing new starts until Retry
  // Spend caps: capHold, a cap holds the run (nothing new starts until Continue); capLimitUsd, a limit Continue raised past the run's cap.
  capHold?: CapHold
  capLimitUsd?: number
  condition?: ConditionCheck // a webhook's Jev condition verdict, kept on a skipped run
  error?: string
  startedAt: number
  endedAt?: number
}
/**
 * How far a For each visit has got, for the run list and the canvas. current: the first open item, in list order.
 * running: how many items are open, when more than one is. paused: an open item's turn is paused by the user;
 * pausedItems: how many, when several are open (so the open run refetches when a second one pauses).
 */
export interface RunProgress {
  stepId: string
  done: number
  failed: number
  total: number
  current: string | null
  running?: number
  paused?: true
  pausedItems?: number
}
/** The run list's row: no visits or snapshot, so the snapshot of every workflow stays small. waiting/failed are step ids. */
export type WorkflowRunSummary = Pick<
  WorkflowRun,
  'id' | 'workflowId' | 'via' | 'status' | 'late' | 'error' | 'startedAt' | 'endedAt' | 'parent' | 'capHold'
> & {
  waiting: string[]
  failed: string[]
  event?: EventKind
  costUsd?: number // runCostUsd, absent at 0
  progress?: RunProgress[] // one per open For each visit; absent when none
}
export interface WorkflowsSnapshot {
  workflows: Workflow[]
  runs: Record<string, WorkflowRunSummary[]>
}

export const WORKFLOW_RUNS_KEPT = 30
export const WORKFLOW_SKIPPED_RUNS_KEPT = 10 // of those 30: a noisy webhook's skipped calls must not push out real runs
export const WORKFLOW_MAX_ACTIVE_RUNS = 5
export const STEP_VISITS_MAX = 20
export const RUN_VISITS_MAX = 200
export const OUTPUT_MAX = 50_000
export const TRIGGER_BODY_MAX = 20_000
export const PROMPT_MAX = 20_000
export const NAME_MAX = 100 // a step, workflow or agent name
export const STEP_RULES_MAX = 100
export const STEP_RULE_TOOL_MAX = 200
export const STEP_RULE_COMMAND_MAX = 4_000
export const NOTIFY_TITLE_MAX = 80
export const NOTIFY_BODY_MAX = 200 // the push shows this much of a Notify body
export const NOTIFY_INBOX_BODY_MAX = 20_000 // the Inbox message and the Audit log keep this much
export const WAIT_MIN = 1
export const WAIT_MAX = 1440
export const LLM_TIMEOUT_MS = 5 * 60_000
export const CONDITION_TIMEOUT_MS = 2 * 60_000
export const BARE_CALLS_MAX = 4
export const FOREACH_ITEMS_MAX = 100
export const FOREACH_ITEM_MAX = 1_000
export const FOREACH_ITEM_OUTPUT_MAX = 20_000
export const FOREACH_OUTPUT_MAX = 100_000 // all item replies together, shared equally
export const FOREACH_CURRENT_MAX = 80
export const FOREACH_CONCURRENCY_MAX = 3
export const HTTP_HEADERS_MAX = 20
export const HTTP_TIMEOUT_MS = 60_000
export const HTTP_BODY_MAX = 1024 * 1024 // a filled request body, in UTF-8 bytes
export const HTTP_READ_MAX = 1024 * 1024 // bytes of a response read before it is refused
export const HTTP_REDIRECTS_MAX = 5
export const TRANSFORM_FIELDS_MAX = 20
export const TRANSFORM_NAME_MAX = 64
export const TRANSFORM_PATH_MAX = 500
export const SUBWORKFLOW_DEPTH_MAX = 3
/** An Approval's editable text starts as its input, which a For each step before it can make this long. */
export const APPROVAL_TEXT_MAX = FOREACH_OUTPUT_MAX
/** Fixed refusal and skip texts of the Chat step, the Room step's members, the run policies and the webhook condition; shared so the editor and the run view read the same words. */
export const PICK_CHAT = 'Pick a chat'
export const CHAT_NOT_FOUND = 'Chat not found'
export const CHAT_READ_ONLY = 'This chat is read-only'
export const CHAT_OF_WORKFLOW = 'This chat belongs to a workflow'
export const PICK_MEMBERS = 'Pick at least two agents'
export const LIMIT_SKIP_TEXT = 'Skipped at the usage limit'
export const MISSED_TEXT = 'Missed while ZumiBot was off'
export const CONDITION_TEXT = 'Condition not met'
/** The refusal of Run and of turning a workflow on; shared so the editor can tell it from other errors and add hints. */
export const WORKFLOW_PROBLEMS_TEXT = 'This workflow has problems: fix them before running'

export const portsOf = (kind: StepKind): Port[] =>
  kind === 'condition' ? ['yes', 'no'] : kind === 'approval' ? ['approved', 'rejected'] : ['out']

/** Kinds whose visits can fail by themselves, so the On failure setting applies. Approval, Wait and Notify never do. */
export const FAILING_KINDS: readonly StepKind[] = ['agent', 'room', 'chat', 'foreach', 'llm', 'condition', 'http', 'transform', 'workflow']
export const failsBranch = (s: Pick<Step, 'kind'> & { onFailure?: 'branch' }): boolean =>
  s.onFailure === 'branch' && FAILING_KINDS.includes(s.kind)
/** The ports this step has: its kind's, plus `error` while its failures take the failure path. */
export const stepPorts = (s: Pick<Step, 'kind'> & { onFailure?: 'branch' }): Port[] =>
  failsBranch(s) ? [...portsOf(s.kind), 'error'] : portsOf(s.kind)

/** A failed visit that went on along its failure path: not the run's failure, and nothing to Retry. */
export const handledFailure = (v: Pick<Visit, 'status' | 'port'>): boolean => v.status === 'failed' && v.port === 'error'
/** A failure that stops the run: failed and not taken along a failure path. */
export const haltingFailure = (v: Pick<Visit, 'status' | 'port'>): boolean => v.status === 'failed' && v.port !== 'error'

/** What a handled failure hands on: the error, then the visit's output (an HTTP error's body) when it has one. */
export const failureText = (v: Pick<Visit, 'error' | 'output'>): string =>
  [v.error ?? 'Failed', v.output ?? ''].filter(Boolean).join('\n\n')

/** What the run cost so far: every visit's, retried and stopped ones included, since each call was paid for. */
/** Every message a run's Agent steps and For each items followed: their turns are the run's, any other turn in their chats is not. */
export function runMessages(r: Pick<WorkflowRun, 'visits'>): Set<string> {
  const out = new Set<string>()
  for (const v of r.visits) {
    if (v.messageId) out.add(v.messageId)
    for (const i of v.items ?? []) if (i.messageId) out.add(i.messageId)
  }
  return out
}

export const runCostUsd = (r: Pick<WorkflowRun, 'visits'>): number => r.visits.reduce((sum, v) => sum + (v.costUsd ?? 0), 0)

/** Thin-space grouping of a limit in a message ("1 000"). */
export const spaced = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

/** An entry per open For each visit (so a loop's second visit counts on its own), in visit order. */
export function progressOf(r: Pick<WorkflowRun, 'visits'>): RunProgress[] {
  const out: RunProgress[] = []
  for (const v of r.visits) {
    if ((v.status !== 'running' && v.status !== 'waiting') || !v.items) continue
    const live = v.items.filter((i) => i.status === 'running' || i.status === 'waiting')
    const paused = live.filter((i) => i.paused).length
    out.push({
      stepId: v.stepId,
      done: v.items.filter((i) => i.status === 'done').length,
      failed: v.items.filter((i) => i.status === 'failed').length,
      total: v.items.length,
      current: live[0] ? live[0].text.slice(0, FOREACH_CURRENT_MAX) : null,
      ...(live.length > 1 ? { running: live.length } : {}),
      // In the summary, so the open run refetches when an item pauses or Resume carries it on.
      ...(paused > 0 ? { paused: true as const } : {}),
      ...(paused > 0 && live.length > 1 ? { pausedItems: paused } : {})
    })
  }
  return out
}

export function summaryOf(r: WorkflowRun): WorkflowRunSummary {
  // A step counts as failed by its latest visit only: a failure later retried successfully no longer counts.
  const latest = new Map<string, Visit>()
  for (const v of r.visits) latest.set(v.stepId, v)
  const waiting = [...new Set(r.visits.filter((v) => v.status === 'waiting').map((v) => v.stepId))]
  const failed = [...latest.values()].filter(haltingFailure).map((v) => v.stepId)
  const costUsd = runCostUsd(r)
  const progress = progressOf(r)
  return {
    id: r.id,
    workflowId: r.workflowId,
    via: r.via,
    status: r.status,
    late: r.late,
    error: r.error,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    waiting,
    failed,
    ...(r.parent ? { parent: r.parent } : {}),
    ...(r.event ? { event: r.event.kind } : {}),
    ...(r.capHold ? { capHold: r.capHold } : {}),
    ...(costUsd > 0 ? { costUsd } : {}),
    ...(progress.length ? { progress } : {})
  }
}
