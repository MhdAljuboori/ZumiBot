import { isAbsolute } from 'node:path'
import { isRemoteAgent } from '@zumibot/shared/engine'
import { LIMIT_RESUME_MARGIN_MS } from '@zumibot/shared/limitResume'
import { effectiveLimit, raisedLimit, reached, type CapHold } from '@zumibot/shared/spendCaps'
import { ROUTINE_MAX_LIMIT_WAITS, type ConditionCheck, type WebhookCall } from '@zumibot/shared/routines'
import type { AgentSummary, ChatMeta, ChatPush, WorkflowSent } from '@zumibot/shared/types'
import { capHit, deliver, joinText, newState, outcome, retryAllowance, takeStarts } from '@zumibot/shared/workflowEngine'
import {
  concurrencyOf,
  itemCounts,
  itemsFailedText,
  joinItemOutputs,
  newItems,
  openVisitStatus,
  parseItems,
  retryItems,
  startPending
} from '@zumibot/shared/workflowForEach'
import { problemsOf, type Problem } from '@zumibot/shared/workflowGraph'
import { MATERIAL_RULE, fillTemplate, filtersMatch, modelPrompt, triggerOutput, type TemplateCtx } from '@zumibot/shared/workflowTemplate'
import { runTransform } from '@zumibot/shared/workflowTransform'
import { EVENT_SAMPLES, eventCall, isEventKind } from '@zumibot/shared/workflowEvents'
import {
  CONDITION_TEXT,
  FOREACH_ITEM_OUTPUT_MAX,
  LIMIT_SKIP_TEXT,
  MISSED_TEXT,
  NOTIFY_BODY_MAX,
  NOTIFY_INBOX_BODY_MAX,
  NOTIFY_TITLE_MAX,
  OUTPUT_MAX,
  SUBWORKFLOW_DEPTH_MAX,
  WORKFLOW_MAX_ACTIVE_RUNS,
  WORKFLOW_PROBLEMS_TEXT,
  failsBranch,
  groupsOf,
  haltingFailure,
  handledFailure,
  notesOf,
  roomFromAgents,
  runCostUsd,
  runMessages,
  summaryOf,
  type Delivery,
  type ItemRun,
  type ItemStatus,
  type Port,
  type EventKind,
  type RunParent,
  type Step,
  type Visit,
  type Workflow,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowRunSummary
} from '@zumibot/shared/workflows'
import type { TaskQueue } from '../chat/taskQueue'
import type { CommandResolver } from '../chat/commandResolver'
import { capRefusalAtRun, type CapEngines } from '../caps/capEngines'
import type { ChatStore } from '../store/chatStore'
import type { RunCost } from '../usage/runCost'
import { CALL_FAILED, NO_ANSWER, type BareCalls, type BareResult } from './bareCalls'
import { httpCall, type HttpRequest, type HttpResult } from './httpCalls'
import { KEY_UNAVAILABLE, buildHttpRequest, scrubKey, type VaultKey } from './httpStep'
import {
  RESTART_TEXT,
  WorkflowAgentSteps,
  chatStepProblem,
  type AgentTarget,
  type ChatTarget,
  type Slot,
  type SlotEnd
} from './workflowAgentSteps'
import type { RoomTarget } from './workflowRooms'
import type { WorkflowMessages } from './workflowMessages'
import type { WorkflowStore } from './workflowStore'

interface RunRef {
  workflowId: string
  runId: string
}

/** An agent past its daily spend cap: what it spent and may spend today, and its cap. */
export interface AgentOver {
  spentUsd: number
  limitUsd: number
  capUsd: number
}

/**
 * What the spend caps say about a run, read before each of its writes. cap: the workflow's run cap now (raising it on the
 * workflow applies at once), null = none. liveBy: what the running turns in its chats have cost so far, not yet in its visits,
 * by the message each answers (only the run's own messages count: liveOf). agents: agents past their daily cap, which none
 * of its steps may start. chatAgents: the agents of each Chat step's chat (a room's members), by chat id, read by the runner
 * itself while some agent is over, since the step names a chat, not an agent.
 */
export interface CapContext {
  cap: number | null
  liveBy: ReadonlyMap<string, number>
  agents: ReadonlyMap<string, AgentOver>
  chatAgents?: ReadonlyMap<string, readonly string[]>
}
const NO_CAPS: CapContext = { cap: null, liveBy: new Map(), agents: new Map() }
const liveOf = (r: Pick<WorkflowRun, 'visits'>, ctx: CapContext): number => {
  let usd = 0
  for (const m of runMessages(r)) usd += ctx.liveBy.get(m) ?? 0
  return usd
}

export interface WorkflowRunnerDeps {
  store: WorkflowStore
  bare: Pick<BareCalls, 'llm' | 'condition' | 'stopAll'>
  chats: Pick<ChatStore, 'get' | 'create' | 'update' | 'updateGroup' | 'patchInPlace' | 'loadItems' | 'loadVersions'>
  tasks: Pick<TaskQueue, 'submit' | 'drop'>
  stopChat(chatId: string): void
  isRunning(chatId: string): boolean
  // A chat's new meta to the tabs, so the sidebar follows an Agent step's chat into the archive.
  pushMeta(meta: ChatMeta): void
  /** Ends an archived step chat's background processes; absent, it has none to end. */
  endProcesses?(chatId: string): Promise<unknown>
  agents(): Promise<AgentSummary[]>
  /** Whether the workflow's spend cap can hold for its steps' agents' engines now (they may have changed since the save). */
  capEngines?: Pick<CapEngines, 'workflow'>
  zumiBot: string
  builtInCwd(agent: string): string | null
  dirExists(path: string): Promise<boolean>
  // Fire and forget: a notification problem never changes how a run moves.
  notify: {
    waiting(o: RunRef & { name: string }): void
    cleared(runId: string): void
    failed(o: RunRef & { name: string }): void
    message(o: RunRef & { title: string; body?: string; messageId: string }): void
  }
  // A Notify step's message is stored here before its push, so the push always has something to open.
  messages: Pick<WorkflowMessages, 'add' | 'has'>
  inboxChanged(): void
  recordCost(workflowId: string, cost: RunCost, id: string | null): void
  changed(): void
  now(): number
  newId(): string
  // Jev's check of a webhook call against the trigger's condition; null while Jev is off (the call runs, as before).
  condition?(condition: string, call: WebhookCall): Promise<ConditionCheck | null>
  // For Wait steps and usage-limit waits; a real timer when absent.
  setTimer?(fn: () => void, ms: number): { clear(): void }
  // What a Wait's minutes are divided by: only e2e's dev hook sets it (testWaitScale); 1 when absent.
  waitScale?: number
  // An HTTP request step's request; httpCall when absent (tests pass their own).
  http?(req: HttpRequest, signal: AbortSignal): Promise<HttpResult>
  // A vault API key an HTTP step may send, read per request so a revoked key stops at once; null when it may not.
  vaultKey(id: string): VaultKey | null
  // A Vault email login a workflow may read, by id; null when it may not (a missing one, or its switch off). Never logged.
  mailAccount(id: string): { username: string; password: string } | null
  // A Room step's own copy of its template room, made once per visit (a Retry reuses it); `error` is the visit's failure.
  rooms: { copy(t: RoomTarget): Promise<{ chatId: string } | { error: string }> }
  // Resolves a step's leading /command from its saved prompt, as a routine run does; absent: every prompt is sent as is.
  commands?: Pick<CommandResolver, 'forRoutine'>
  // Spend caps (absent: no caps). held: a cap began holding the run (pause its chats, notify); fire and forget. allowMore:
  // Continue on a run an agent's daily cap holds raises that agent's limit for today first.
  caps?: {
    context(workflowId: string, runId: string): Promise<CapContext>
    held(run: WorkflowRun, name: string): void
    allowMore(agent: string): Promise<void>
  }
}

export const CAP_TEXT = 'Ran too many times'
export const FILTER_TEXT = 'Filter did not match'
export const TOO_MANY_RUNS = 'Too many runs in progress'
// An event run over the cap is dropped quietly: a chatty source is not a failure to tell the user about.
export const EVENT_SKIPPED_BUSY = TOO_MANY_RUNS
export const ACCOUNT_MISSING = 'Pick an email account the Vault shares with workflows'
export const MAIL_HOST_MISSING = 'Enter the mail server'
export const PROBLEMS_TEXT = WORKFLOW_PROBLEMS_TEXT
export const ALREADY_ANSWERED = 'Already answered'
export const NOT_RETRYABLE = 'Only a failed step can be retried'
export const NO_TEST = 'This step has no test'
export const LIMIT_TEXT = 'Usage limit reached'
export const FOLDER_MISSING = 'Folder not found'
export const FOLDER_RELATIVE = 'Use the full folder path, like /home/you/invoices'
export const NO_ITEMS = 'No items in the input'
export const SUB_NOT_FOUND = 'Workflow not found'
export const SUB_STOPPED = 'Sub-workflow was stopped'
export const SUB_DEEP = `Sub-workflows nest more than ${SUBWORKFLOW_DEPTH_MAX} deep`
export const subFailed = (error: string | undefined): string => `Sub-workflow failed: ${error ?? 'a step failed'}`
export const SUB_START_FAILED = 'The sub-workflow could not start'
export const NOT_CAPPED = 'This run is not held by a spend cap'
const MISSING_STEP = 'This step is missing'
const FALLBACK_NAME = 'Workflow'
const FALLBACK_ZONE = 'UTC'
const TEST_FROM = 'test'
const TEST_NAME = 'Test input'
const MAX_TIMER_MS = 2 ** 31 - 1
const ITEM_TITLE_MAX = 60

export type Cause = 'step' | 'user' | 'restart'
type ModelStep = Extract<Step, { kind: 'llm' | 'condition' }>
type AgentStep = Extract<Step, { kind: 'agent' }>
type RoomStep = Extract<Step, { kind: 'room' }>
type ChatStepT = Extract<Step, { kind: 'chat' }>
type ForEachStep = Extract<Step, { kind: 'foreach' }>
type HttpStep = Extract<Step, { kind: 'http' }>
type SubStep = Extract<Step, { kind: 'workflow' }>
export type VisitEnd = Pick<Visit, 'output' | 'port' | 'reason' | 'note' | 'error' | 'costUsd' | 'missing' | 'http'> & {
  status: 'done' | 'failed'
}
type Draft = Pick<Workflow, 'name' | 'timeZone' | 'trigger' | 'steps' | 'edges'> & { id?: string | null }
type CtxSource = Pick<WorkflowRun, 'snapshot' | 'visits' | 'input' | 'call' | 'parent'> & { via?: WorkflowRun['via'] }
export interface StepTest {
  output?: string
  port?: Port
  reason?: string
  chatId?: string
  error?: string
  missing?: string[]
}

// What lives only in memory for an unfinished run: its timers and calls, so Stop and shutdown can reach them.
interface Live {
  workflowId: string
  name: string // for notifications and Agent step chats; the workflow's name when the run started or was recovered
  timeZone: string // for the date in an Agent step chat's title
  limitPolicy?: 'skip' // from the workflow when the run started or was recovered: a usage limit skips the run
  status: WorkflowRunStatus
  timers: Map<string, { clear(): void }> // by visit or item id
  aborts: Map<string, AbortController> // by visit id
  waits: Map<string, number> // usage-limit waits so far, by visit or item id
  quiet: Set<string> // visits and items failed by the user or a restart: not news, so the run's failure is not reported for them
  depth: number // the run's event chain depth (run.event.depth; 0 when absent or no event started it), for activeDepths
}

// A visit just written, and what it needs once the write has landed. item: a For each visit's item to start (one Begun
// per item, so a visit that starts several at once has several).
interface Begun {
  visit: Visit
  step: Step
  item?: ItemRun
  prompt?: string
  system?: string
  title?: string
  body?: string
}

const unfinished = (r: WorkflowRun): boolean => r.status === 'running' || r.status === 'waiting'
// How deep in a chain of event starts the run is: a sub-workflow's parent stays unfinished while it runs, so it counts there.
const depthOf = (r: Pick<WorkflowRun, 'via' | 'event'>): number => (r.via === 'event' ? (r.event?.depth ?? 0) : 0)
const open = (v: { status: ItemStatus }): boolean => v.status === 'running' || v.status === 'waiting'
const stepOf = (r: Pick<WorkflowRun, 'snapshot'>, id: string): Step | undefined => r.snapshot.steps.find((s) => s.id === id)
// The visit's cost with usd added, for spreading into its end.
const paid = (v: Visit, usd: number): Pick<Visit, 'costUsd'> => (usd > 0 ? { costUsd: (v.costUsd ?? 0) + usd } : {})
const failedItemsText = (items: ItemRun[]): string =>
  items
    .filter((i) => i.status === 'failed')
    .map((i) => `- ${i.text}: ${i.error ?? 'failed'}`)
    .join('\n')
    .slice(0, OUTPUT_MAX)
const waitingApprovals = (r: WorkflowRun): number =>
  r.visits.filter((v) => v.status === 'waiting' && stepOf(r, v.stepId)?.kind === 'approval').length

// What a slot id names: an Agent step's visit, or an item of a For each visit (with the visit holding it). Both are
// newId()s, so they never clash, and retryItems gives every item of a Retry a new one, so an id names one visit's item
// only and a late answer for a replaced item finds nothing open.
function findSlot(r: Pick<WorkflowRun, 'visits'>, id: string): { visit: Visit; item?: ItemRun } | null {
  for (const visit of r.visits) {
    if (visit.id === id) return { visit }
    const item = visit.items?.find((i) => i.id === id)
    if (item) return { visit, item }
  }
  return null
}

type SlotKeys = Pick<Slot, 'chatId' | 'messageId' | 'until' | 'paused' | 'capPaused' | 'resumes' | 'capped'>
const SLOT_KEYS = ['chatId', 'messageId', 'until', 'paused', 'capPaused', 'resumes', 'capped'] as const
// Only the keys it holds, so a stored visit never gains an undefined one.
const heldKeys = (s: SlotKeys): SlotKeys => ({
  ...(s.chatId !== undefined ? { chatId: s.chatId } : {}),
  ...(s.messageId !== undefined ? { messageId: s.messageId } : {}),
  ...(s.until !== undefined ? { until: s.until } : {}),
  ...(s.paused !== undefined ? { paused: s.paused } : {}),
  ...(s.capPaused !== undefined ? { capPaused: s.capPaused } : {}),
  ...(s.resumes !== undefined ? { resumes: s.resumes } : {}),
  ...(s.capped !== undefined ? { capped: s.capped } : {})
})

// A step whose visit follows one turn in a chat: an Agent step's chat, a Room step's copy of a room, or a Chat step's given chat.
const isChatStep = (kind: Step['kind'] | undefined): boolean => kind === 'agent' || kind === 'room' || kind === 'chat'

type Slotted = SlotKeys & { status: ItemStatus } // a visit or an item

// The fields an Agent step follows its turn by, and nothing else of the visit or item.
const slotFields = (v: Slotted): Slot => ({ status: v.status, ...heldKeys(v) })

// The slot's fields back onto its visit or item; one the slot dropped (a lifted limit wait's until, a resumed pause) leaves it too.
function putSlot<T extends Slotted>(v: T, s: Slot): T {
  // Only an open state: an end goes through finishSlot, which hands the output on or moves the list on.
  const next: T = { ...v, status: open(s) ? s.status : v.status }
  for (const key of SLOT_KEYS) delete next[key]
  return { ...next, ...heldKeys(s) }
}

// "Nov 7" in the workflow's zone. A zone this Node cannot read falls back to UTC: a throw here would strand the visits
// begun after it in the same write.
function dayOf(at: number, timeZone: string): string {
  const format = (zone: string): string => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: zone }).format(at)
  try {
    return format(timeZone)
  } catch {
    return format(FALLBACK_ZONE)
  }
}

function latestByStep(visits: Visit[]): Visit[] {
  const latest = new Map<string, Visit>()
  for (const v of visits) latest.set(v.stepId, v)
  return [...latest.values()]
}

/**
 * What a finished run hands back to the Sub-workflow step that started it: its end visits' outputs (done visits whose
 * port has no edge leaving it, the latest per step, by end time), one as it is, several labelled by step name.
 */
export function childOutput(r: Pick<WorkflowRun, 'snapshot' | 'visits'>): string {
  const ends = latestByStep(
    r.visits.filter((v) => v.status === 'done' && !r.snapshot.edges.some((e) => e.from === v.stepId && e.port === v.port))
  ).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
  const names = Object.fromEntries(r.snapshot.steps.map((s) => [s.id, s.name]))
  return joinText(
    ends.map((v) => ({ edgeId: v.id, from: v.stepId, text: v.output ?? '' })),
    names
  ).slice(0, OUTPUT_MAX)
}

function contextOf(
  r: CtxSource,
  inputs: Delivery[],
  extraNames: Record<string, string> = {}
): { ctx: TemplateCtx; handles: Record<string, string> } {
  const names: Record<string, string> = { ...extraNames }
  const handles: Record<string, string> = {}
  for (const s of r.snapshot.steps) {
    names[s.id] = s.name
    handles[s.id] = s.handle
  }
  const outputs: TemplateCtx['outputs'] = {}
  for (const v of r.visits) {
    const s = v.status === 'done' && v.output !== undefined ? stepOf(r, v.stepId) : undefined
    if (s) outputs[s.handle] = { name: s.name, text: v.output! }
  }
  // A sub-workflow's trigger text came from its parent's steps, and an event's from a reply, mail or file name, so a model reads it
  // as material, not as the user's typing. A chat run is the user's own /run-workflow text, so it stays raw.
  return {
    ctx: {
      inputs,
      names,
      outputs,
      trigger: { text: r.input ?? null, call: r.call ?? null, ...(r.parent || r.via === 'event' ? { material: true } : {}) }
    },
    handles
  }
}

function promptsOf(
  r: CtxSource,
  step: ModelStep,
  inputs: Delivery[],
  extraNames?: Record<string, string>
): { prompt: string; system?: string; missing: string[] } {
  const { ctx, handles } = contextOf(r, inputs, extraNames)
  const p = modelPrompt(step.kind === 'llm' ? step.prompt : step.question, ctx, handles)
  if (step.kind !== 'llm' || !step.system?.trim()) return { prompt: p.text, missing: p.missing }
  // The user's system prompt reads step outputs too, so its material is wrapped like the prompt's.
  const s = fillTemplate(step.system, ctx, 'model')
  return { prompt: p.text, system: s.text, missing: [...new Set([...p.missing, ...s.missing])] }
}

function realTimer(fn: () => void, ms: number): { clear(): void } {
  const t = setTimeout(fn, ms)
  t.unref()
  return { clear: () => clearTimeout(t) }
}

// Messages only: outputs, prompts and Notify text never reach a log.
function logError(error: unknown): void {
  console.error(error instanceof Error ? error.message : String(error))
}

export class WorkflowRunner {
  private readonly live = new Map<string, Live>()
  private readonly queues = new Map<string, Promise<void>>()
  private readonly reserved = new Map<string, number>() // starts past the cap check, not yet live
  private readonly inFlight = new Map<string, Set<Promise<unknown>>>() // run() calls not yet returned, by workflow
  private readonly closed = new Set<string>() // workflows being deleted: nothing may start in them again
  private readonly lastEnd = new Map<string, number>() // when a run of each workflow last ended, in memory only (endedRecently)
  private readonly agentSteps: WorkflowAgentSteps
  private stopped = false
  // Pending from holdUntilRecovered() until recover() ends (or stop()); null = open, which it is unless the server asks.
  private gate: { wait: Promise<void>; open(): void } | null = null
  // Each run's spend caps as read before its current write (advance), for the item starts made inside that write.
  private readonly caps = new Map<string, CapContext>()

  constructor(private readonly d: WorkflowRunnerDeps) {
    this.agentSteps = new WorkflowAgentSteps(d, {
      serialize: (runId, op) => this.serialize(runId, op),
      slotOf: (r, slotId) => {
        const found = findSlot(r, slotId)
        return found ? slotFields(found.item ?? found.visit) : null
      },
      patchSlot: (runId, slotId, fn) => this.patchSlot(runId, slotId, fn),
      finishSlot: (runId, slotId, end, cause) => this.finishSlot(runId, slotId, end, cause),
      addCost: (runId, slotId, usd) => this.addCost(runId, slotId, usd),
      arm: (runId, slotId, at, fire) => this.arm(runId, slotId, at, fire),
      waits: (runId) => this.live.get(runId)?.waits ?? null,
      limitSkip: (runId) => this.live.get(runId)?.limitPolicy === 'skip',
      // Called from inside the run's queue (the steps' each() serializes), so halt directly: stopRun would queue behind itself.
      skipRun: (runId) => this.halt(runId, { status: 'skipped', error: LIMIT_SKIP_TEXT }),
      stopped: () => this.stopped
    })
  }

  /**
   * At server start, before it listens: run, approve, retry and Stop wait until recover() is done. One started earlier
   * would race recovery (its Live entry replaced, its calls asked twice, its Agent step taken for an interrupted one) and
   * the 5-run cap would count none of the recovered runs.
   */
  holdUntilRecovered(): void {
    if (this.gate || this.stopped) return
    let open!: () => void
    const wait = new Promise<void>((resolve) => {
      open = resolve
    })
    this.gate = { wait, open }
  }

  run(
    w: Workflow,
    via: WorkflowRun['via'],
    o: {
      late?: boolean
      call?: WebhookCall
      input?: string
      event?: { kind: EventKind; depth?: number }
      chat?: { chatId: string; title: string }
    } = {}
  ): Promise<WorkflowRunSummary> {
    if (this.closed.has(w.id)) return Promise.reject(new Error('Workflow not found'))
    // In flight from the call on, so a delete waiting with it at the gate still waits for it.
    const started = this.afterRecovery(() =>
      this.closed.has(w.id) ? Promise.reject(new Error('Workflow not found')) : this.start(w, via, o)
    )
    const set = this.inFlight.get(w.id) ?? new Set<Promise<unknown>>()
    set.add(started)
    this.inFlight.set(w.id, set)
    const done = (): void => {
      set.delete(started)
      if (set.size === 0 && this.inFlight.get(w.id) === set) this.inFlight.delete(w.id)
    }
    started.then(done, done)
    return started
  }

  approve(runId: string, visitId: string, o: { ok: boolean; text?: string; note?: string }): Promise<void> {
    // Through the run's queue, so a second tab's answer finds the first already written and the step runs once.
    return this.afterRecovery(() =>
      this.serialize(runId, async () => {
        const r = await this.d.store.getRun(runId)
        const v = r?.visits.find((x) => x.id === visitId)
        const step = r && v ? stepOf(r, v.stepId) : undefined
        if (!r || !v || !unfinished(r) || v.status !== 'waiting' || step?.kind !== 'approval') throw new Error(ALREADY_ANSWERED)
        const note = o.note?.trim() ?? ''
        const text = o.ok && step.editable && o.text !== undefined ? o.text : v.input
        const port: Port = o.ok ? 'approved' : 'rejected'
        const output = note ? `${text}\n\nNote from the user: ${note}` : text
        const ended = await this.finishVisit(runId, visitId, () => ({ status: 'done', output, port, ...(note ? { note } : {}) }))
        if (!ended) throw new Error(ALREADY_ANSWERED)
      })
    )
  }

  /** itemId: one failed item of a For each visit, the others carried as they ended. */
  retry(runId: string, visitId: string, itemId?: string): Promise<void> {
    return this.afterRecovery(() =>
      this.serialize(runId, async () => {
        const r = await this.d.store.getRun(runId)
        const v = r?.visits.find((x) => x.id === visitId)
        const latest = r && v ? r.visits.filter((x) => x.stepId === v.stepId).at(-1) : undefined
        // Only the step's latest visit: an older failure a later visit got past has nothing left to retry.
        // A failure that went along its failure path is not retried: the run already went on from it.
        if (
          !r ||
          !v ||
          v.status !== 'failed' ||
          handledFailure(v) ||
          latest?.id !== v.id ||
          !(unfinished(r) || r.status === 'failed') ||
          this.closed.has(r.workflowId)
        ) {
          throw new Error(NOT_RETRYABLE)
        }
        if (itemId !== undefined && !v.items?.some((i) => i.id === itemId && i.status === 'failed')) throw new Error(NOT_RETRYABLE)
        if (!this.live.has(runId))
          this.live.set(runId, this.newLive(r.workflowId, await this.workflowInfo(r.workflowId), r.status, depthOf(r)))
        const updated = await this.advance(runId, (cur, begun) => {
          const failed = cur.visits.find((x) => x.id === visitId)
          if (!failed || failed.status !== 'failed') return null
          // A Retry of the cap is a deliberate click: that step and the run get a fresh allowance. Either way the run
          // carries on from the inboxes as they were.
          const state = failed.error === CAP_TEXT ? retryAllowance(cur, failed.stepId) : { ...cur, halted: false }
          // A For each visit runs only what did not finish; done items carry their outputs into the new visit.
          const items = failed.items && retryItems(failed.items, () => this.d.newId(), itemId)
          return this.open({ ...cur, ...state }, failed.stepId, failed.inputs, begun, items)
        })
        if (!updated) {
          if (!unfinished(r)) this.forget(runId) // nothing was retried: an ended run keeps nothing in memory
          throw new Error(NOT_RETRYABLE) // the workflow is being deleted
        }
      })
    )
  }

  stopRun(runId: string): Promise<void> {
    return this.afterRecovery(() => this.serialize(runId, () => this.halt(runId)))
  }

  /**
   * Continue on a run a spend cap holds: the user allows one more cap's worth (the run's, or the agent's for today), the
   * hold ends, and what the inboxes and For each lists allow starts. The chats the cap paused are resumed by the caller.
   */
  continueCap(runId: string): Promise<WorkflowRun> {
    return this.afterRecovery(() =>
      this.serialize(runId, async () => {
        const r = await this.d.store.getRun(runId)
        const hold = r?.capHold
        if (!r || !hold || !unfinished(r) || this.closed.has(r.workflowId)) throw new Error(NOT_CAPPED)
        if (hold.kind === 'agent' && hold.agent) await this.d.caps?.allowMore(hold.agent)
        if (!this.live.has(runId))
          this.live.set(runId, this.newLive(r.workflowId, await this.workflowInfo(r.workflowId), r.status, depthOf(r)))
        const ctx = await this.capsOf(runId)
        const updated = await this.advance(runId, (cur) => {
          if (!cur.capHold || !unfinished(cur)) return null
          const { capHold: _gone, ...rest } = cur
          return hold.kind === 'run' ? { ...rest, capLimitUsd: raisedLimit(runCostUsd(cur) + liveOf(cur, ctx), hold.capUsd) } : rest
        })
        if (!updated) throw new Error(NOT_CAPPED)
        // For each lists the hold kept from starting items: their free slots fill now.
        for (const v of updated.visits) if (open(v) && v.items && !updated.capHold) await this.goOn(runId, v.id)
        return (await this.d.store.getRun(runId)) ?? updated
      })
    )
  }

  /** A spend cap may have been reached while a turn of this run streams: holds the run if so. Writes only when it holds. */
  checkCap(runId: string): Promise<void> {
    return this.afterRecovery(() =>
      this.serialize(runId, async () => {
        if (!this.live.has(runId)) return
        await this.advance(runId, (cur) => {
          if (!unfinished(cur) || cur.capHold) return null
          return this.capCheck(cur) ? cur : null
        })
      })
    )
  }

  /**
   * Before a delete: every unfinished run of the workflow stops, and none can start or move after (advance refuses a
   * closed workflow's runs in the write), so no approval is left waiting.
   */
  async stopAllOf(workflowId: string): Promise<void> {
    // Before closing: recovery moves the workflow's runs normally, then this stops every one it left unfinished.
    await this.afterRecovery(async () => undefined)
    this.closed.add(workflowId)
    await Promise.allSettled([...(this.inFlight.get(workflowId) ?? [])])
    const ids = new Set([...this.live].filter(([, l]) => l.workflowId === workflowId).map(([id]) => id))
    for (const r of (await this.d.store.runs())[workflowId] ?? []) if (unfinished(r)) ids.add(r.id)
    for (const id of ids) await this.stopRun(id)
  }

  /** The editor's unsaved draft, so the user tests what they see. No run is stored. */
  async testStep(w: Draft, stepId: string, input: string): Promise<StepTest> {
    const step = w.steps.find((s) => s.id === stepId)
    const testable = ['llm', 'condition', 'agent', 'foreach', 'http', 'transform']
    if (!step || !testable.includes(step.kind)) throw new Error(NO_TEST)
    const inputs: Delivery[] = input === '' ? [] : [{ edgeId: TEST_FROM, from: TEST_FROM, text: input }]
    const t = w.trigger
    // An event workflow tests against its kind's sample body, read as material as a run's would be.
    const call =
      t.kind === 'webhook' ? (t.sample ?? undefined) : isEventKind(t.kind) ? eventCall(EVENT_SAMPLES[t.kind], this.d.now()) : undefined
    const src: CtxSource = {
      snapshot: { steps: w.steps, edges: w.edges },
      visits: [],
      ...(call ? { call } : {}),
      ...(isEventKind(t.kind) ? { via: 'event' as const } : {})
    }
    if (step.kind === 'agent' || step.kind === 'foreach') return this.testAgent(w.name, step, src, inputs, input)
    if (step.kind === 'transform') {
      const res = runTransform(input, step.fields, step.format)
      const missing = res.missing.length ? { missing: res.missing } : {}
      return res.ok ? { output: res.output, ...missing } : { error: res.error, ...missing }
    }
    if (step.kind === 'http') return this.testHttp(step, src, inputs)
    if (step.kind !== 'llm' && step.kind !== 'condition') throw new Error(NO_TEST)
    const p = promptsOf(src, step, inputs, { [TEST_FROM]: TEST_NAME })
    const signal = new AbortController().signal // bare.stopAll() still ends it at shutdown
    const res =
      step.kind === 'llm'
        ? await this.d.bare.llm(
            {
              model: step.model,
              ...(step.effort ? { effort: step.effort } : {}),
              ...(p.system !== undefined ? { system: p.system } : {}),
              prompt: p.prompt
            },
            signal
          )
        : await this.d.bare.condition({ model: step.model, prompt: p.prompt }, signal)
    if (!res.ok) return { error: res.limit ? LIMIT_TEXT : res.error }
    if (res.cost && w.id) this.cost(w.id, res.cost, res.id)
    if (step.kind === 'llm') return { output: res.text.slice(0, OUTPUT_MAX) }
    if (res.answer !== 'yes' && res.answer !== 'no') return { error: NO_ANSWER }
    return { output: input, port: res.answer, ...(res.reason !== undefined ? { reason: res.reason } : {}) }
  }

  // Agent steps follow their chats through these, wired to ChatService's idle and push and to the chat handlers.
  chatIdle(chatId: string): void {
    this.agentSteps.chatIdle(chatId)
  }
  chatPush(push: ChatPush): void {
    this.agentSteps.chatPush(push)
  }
  taskDropped(chatId: string, messageId: string): void {
    this.agentSteps.taskDropped(chatId, messageId)
  }
  chatRemoved(chatId: string): void {
    this.agentSteps.chatRemoved(chatId)
  }
  chatResumed(chatId: string, messageId: string): void {
    this.agentSteps.chatResumed(chatId, messageId)
  }
  /** A turn's own cost in this chat (ChatService's onRunCost, before the turn ends): an Agent step's visit counts it. */
  chatCost(chatId: string, usd: number): void {
    this.agentSteps.chatCost(chatId, usd)
  }

  /**
   * The runs whose steps follow a message in this chat, each with that message: SpendCaps matches a running turn to its
   * run by it, since a Chat step's chat has no workflow link. Only runs this server holds.
   */
  runsIn(chatId: string): { workflowId: string; runId: string; messageId: string }[] {
    return this.agentSteps.runsIn(chatId).flatMap((r) => {
      const workflowId = this.live.get(r.runId)?.workflowId
      return workflowId ? [{ workflowId, ...r }] : []
    })
  }

  /**
   * The messages Agent steps follow in this chat. Synchronous, so it can be read before chatIdle settles them: the
   * step waits out a usage limit itself, so the chat's own limit wait (LimitResumes) must leave those turns alone.
   */
  messagesOf(chatId: string): Set<string> {
    return this.agentSteps.messagesOf(chatId)
  }

  /**
   * At start: model calls that were running ask again, waits re-arm, approvals keep waiting, Agent steps follow or
   * settle their chats; then each run starts what its inboxes allow.
   */
  async recover(): Promise<void> {
    try {
      await this.recoverRuns()
    } finally {
      this.openGate() // even after a failure: the server must never wait on the gate for good
    }
  }

  private async recoverRuns(): Promise<void> {
    const [all, workflows] = await Promise.all([this.d.store.runs(), this.d.store.list()])
    const infos = new Map(workflows.map((w) => [w.id, { name: w.name, timeZone: w.timeZone, limitPolicy: w.limitPolicy }]))
    const work: Promise<void>[] = []
    for (const [workflowId, rows] of Object.entries(all)) {
      for (const r of rows) {
        if (!unfinished(r)) continue
        this.live.set(
          r.id,
          this.newLive(workflowId, infos.get(workflowId) ?? { name: FALLBACK_NAME, timeZone: FALLBACK_ZONE }, r.status, depthOf(r))
        )
        work.push(this.serialize(r.id, () => this.resume(r.id)).catch(logError))
      }
    }
    await Promise.all(work)
  }

  /** At shutdown: no timer fires and no call result is written; the runs stay as stored, and recover() picks them up. */
  stop(): void {
    this.stopped = true
    for (const l of this.live.values()) {
      for (const t of l.timers.values()) t.clear()
      l.timers.clear()
    }
    this.d.bare.stopAll()
    this.openGate() // a shutdown during startup must not leave callers waiting
  }

  /** Runs waiting on the user: an Approval, or a card in an Agent step's chat. */
  waitingRuns(): number {
    return [...this.live.values()].filter((l) => l.status === 'waiting').length
  }

  /** A run of the workflow is unfinished or reserved (the cap's own count), so a file start can skip rather than queue. */
  busy(workflowId: string): boolean {
    return this.activeCount(workflowId) > 0
  }

  /** How many more runs of the workflow may start now: the email trigger fetches no more messages than this. */
  freeRuns(workflowId: string): number {
    return Math.max(0, WORKFLOW_MAX_ACTIVE_RUNS - this.activeCount(workflowId))
  }

  /** The chain depth of every unfinished run of the other workflows: a file change may be one of their writes, so its run is one deeper. */
  activeDepths(exceptWorkflowId: string): number[] {
    return [...this.live.values()].filter((l) => l.workflowId !== exceptWorkflowId).map((l) => l.depth)
  }

  /** A run of the workflow ended (done, failed or stopped) less than `ms` ago: the watcher can still be reporting its writes. */
  endedRecently(workflowId: string, ms: number): boolean {
    const at = this.lastEnd.get(workflowId)
    return at !== undefined && this.d.now() - at < ms
  }

  /** What keeps a workflow from running or being turned on: the graph checks, then each Agent or For each step's folder. */
  async problems(w: Pick<Workflow, 'trigger' | 'steps' | 'edges'> & { id?: string | null }): Promise<Problem[]> {
    const agents = await this.d.agents()
    const out = problemsOf(w, agents, this.d.zumiBot)
    const trig = w.steps.find((s) => s.kind === 'trigger')
    if (trig && w.trigger.kind === 'file') {
      const path = w.trigger.path.trim()
      // `~/x` or `x` would be read against the server's own folder, never the one the user meant.
      if (path && !isAbsolute(path)) out.push({ stepId: trig.id, text: FOLDER_RELATIVE })
      else if (!path || !(await this.d.dirExists(w.trigger.path).catch(() => false))) out.push({ stepId: trig.id, text: FOLDER_MISSING })
    }
    if (trig && w.trigger.kind === 'email') {
      if (!this.d.mailAccount(w.trigger.account)) out.push({ stepId: trig.id, text: ACCOUNT_MISSING })
      if (!w.trigger.host.trim()) out.push({ stepId: trig.id, text: MAIL_HOST_MISSING })
    }
    for (const s of w.steps) {
      if (s.kind === 'chat' && s.chat) {
        const problem = chatStepProblem(await this.d.chats.get(s.chat), agents, this.d.zumiBot)
        if (problem) out.push({ stepId: s.id, text: problem })
      }
      if (s.kind === 'http' && s.key && !this.d.vaultKey(s.key)) out.push({ stepId: s.id, text: KEY_UNAVAILABLE })
      if (s.kind === 'workflow' && s.workflow && s.workflow !== w.id && !(await this.d.store.get(s.workflow)))
        out.push({ stepId: s.id, text: SUB_NOT_FOUND })
      if (s.kind === 'room' && roomFromAgents(s) && !(await this.d.dirExists(s.cwd).catch(() => false)))
        out.push({ stepId: s.id, text: FOLDER_MISSING })
      if ((s.kind !== 'agent' && s.kind !== 'foreach') || this.d.builtInCwd(s.agent) !== null) continue
      if (!(await this.d.dirExists(s.cwd).catch(() => false))) out.push({ stepId: s.id, text: FOLDER_MISSING })
    }
    return out
  }

  private async start(
    w: Workflow,
    via: WorkflowRun['via'],
    o: {
      late?: boolean
      call?: WebhookCall
      input?: string
      runId?: string
      parent?: RunParent
      event?: { kind: EventKind; depth?: number }
      chat?: { chatId: string; title: string }
    }
  ): Promise<WorkflowRunSummary> {
    // A copy: saving the workflow, or the caller changing its object, must never reach a run in flight. Retry uses it too.
    const snapshot = structuredClone({ steps: w.steps, edges: w.edges, notes: notesOf(w), groups: groupsOf(w) })
    const call = o.call ?? (via === 'manual' && w.trigger.kind === 'webhook' ? (w.trigger.sample ?? undefined) : undefined)
    const run: WorkflowRun = {
      id: o.runId ?? this.d.newId(),
      workflowId: w.id,
      via,
      late: o.late ?? false,
      status: 'running',
      ...newState(snapshot),
      ...(call ? { call } : {}),
      ...(o.input !== undefined ? { input: o.input } : {}),
      ...(o.parent ? { parent: o.parent } : {}),
      ...(o.event ? { event: o.event } : {}),
      ...(o.chat ? { chat: o.chat } : {}),
      startedAt: this.d.now()
    }
    // quiet: stored failed without the push (an event workflow's problems, after the first of a streak).
    const endAs = async (
      status: 'skipped' | 'failed',
      error: string,
      extra: Pick<WorkflowRun, 'condition'> = {},
      quiet = false
    ): Promise<WorkflowRunSummary> => {
      const r: WorkflowRun = { ...run, ...extra, status, error, endedAt: this.d.now() }
      await this.d.store.addRun(r)
      this.d.changed()
      // A sub-workflow's failure is its parent's to report.
      if (status === 'failed' && !r.parent && !quiet)
        this.safely(() => this.d.notify.failed({ workflowId: w.id, runId: r.id, name: w.name }))
      this.ended(r)
      return summaryOf(r)
    }
    // Late only when ZumiBot was off or asleep at the due time: the workflow may want that run dropped.
    if (via === 'schedule' && o.late && w.missedPolicy === 'skip') return endAs('skipped', MISSED_TEXT)
    // Real calls only: Run workflow on a webhook workflow is the user asking for this run.
    if (via === 'webhook' && o.call && w.trigger.kind === 'webhook') {
      if (!filtersMatch(w.trigger.filters, o.call)) return endAs('skipped', FILTER_TEXT)
      // Before the cap: a slow check must not hold one of the workflow's start slots. A Jev failure runs the call, as for routines.
      const condition = w.trigger.condition?.trim()
      if (condition && this.d.condition) {
        const check = await this.d.condition(condition, o.call).catch((): ConditionCheck => ({ met: null }))
        if (check?.met === false) return endAs('skipped', CONDITION_TEXT, { condition: check })
        if (check) run.condition = check
      }
    }
    if (this.activeCount(w.id) >= WORKFLOW_MAX_ACTIVE_RUNS)
      return via === 'event' ? endAs('skipped', EVENT_SKIPPED_BUSY) : endAs('failed', TOO_MANY_RUNS)

    // Held from the cap check until the run is live, so starts racing through the awaits below cannot pass the cap.
    this.reserved.set(w.id, (this.reserved.get(w.id) ?? 0) + 1)
    let holding = true
    const release = (): void => {
      if (!holding) return
      holding = false
      const n = (this.reserved.get(w.id) ?? 1) - 1
      if (n > 0) this.reserved.set(w.id, n)
      else this.reserved.delete(w.id)
    }
    try {
      if ((await this.problems({ id: w.id, trigger: w.trigger, ...snapshot })).length > 0) {
        release()
        // The user asked for a manual run and a chat run, so they get the refusal; the rest are stored as failed.
        if (via === 'manual' || via === 'chat') throw new Error(PROBLEMS_TEXT)
        // An event workflow with problems fails on every event (up to 30 a minute): only the first of a streak pushes.
        return await endAs('failed', PROBLEMS_TEXT, {}, via === 'event' && (await this.failedOn(w.id, PROBLEMS_TEXT)))
      }
      // A cap that can't hold for an agent's engine fails the run, never runs it uncapped. Stored text, like the problems above.
      const uncapped = await capRefusalAtRun(
        this.d.capEngines &&
          (() => this.d.capEngines!.workflow({ steps: snapshot.steps, ...(w.spendCap !== undefined ? { spendCap: w.spendCap } : {}) }))
      )
      if (uncapped !== null) {
        release()
        if (via === 'manual' || via === 'chat') throw new Error(uncapped)
        // Like the problems above: an event workflow fails on every event, and only the first of a streak pushes.
        return await endAs('failed', uncapped, {}, via === 'event' && (await this.failedOn(w.id, uncapped)))
      }
      const trigger = snapshot.steps.find((s) => s.kind === 'trigger')!
      const now = this.d.now()
      const first: Visit = {
        id: this.d.newId(),
        stepId: trigger.id,
        n: 1,
        status: 'done',
        input: '',
        inputs: [],
        // An event's or a chat's text is what the trigger hands on; its call is only for {{trigger.body.…}} and the filters.
        output: via === 'event' || via === 'chat' ? (o.input ?? '') : triggerOutput(call ?? null, o.input ?? null),
        port: 'out',
        startedAt: now,
        endedAt: now
      }
      const withTrigger: WorkflowRun = { ...run, visits: [first] }
      const stored: WorkflowRun = { ...withTrigger, ...deliver(withTrigger, first) }
      await this.d.store.addRun(stored)
      this.live.set(
        stored.id,
        this.newLive(w.id, { name: w.name, timeZone: w.timeZone, limitPolicy: w.limitPolicy }, 'running', depthOf(stored))
      )
      release()
      this.d.changed()
      return await this.serialize(stored.id, async () => {
        // A delete began while this run was being written: it stops before anything runs or notifies.
        if (this.closed.has(w.id)) await this.halt(stored.id)
        else await this.advance(stored.id, (cur) => (unfinished(cur) ? cur : null))
        return summaryOf((await this.d.store.getRun(stored.id)) ?? stored)
      })
    } finally {
      release()
    }
  }

  /** The workflow's newest run already failed with this text (its problems, or a spend cap that can't hold), so the user has heard of it. */
  private async failedOn(workflowId: string, text: string): Promise<boolean> {
    const prev = (await this.d.store.runs())[workflowId]?.[0] // newest first
    return prev?.status === 'failed' && prev.error === text
  }

  private activeCount(workflowId: string): number {
    let n = this.reserved.get(workflowId) ?? 0
    for (const l of this.live.values()) if (l.workflowId === workflowId) n++
    return n
  }

  /**
   * Inside the run's queue only. One store write holds the change, the starts the join rule then allows and the
   * status that follows; after it, what the new visits need (calls, timers, notifications).
   */
  private async advance(runId: string, change: (r: WorkflowRun, begun: Begun[]) => WorkflowRun | null): Promise<WorkflowRun | null> {
    const begun: Begun[] = []
    const seen: { before?: WorkflowRun } = {}
    // Read before the write: the write itself cannot wait. Kept for the item starts the change makes inside it.
    this.caps.set(runId, await this.capsOf(runId))
    const updated = await this.d.store.updateRun(runId, (cur) => {
      begun.length = 0
      // In the write, after stopAllOf marked the workflow closed and before its read of the runs: a change landing
      // later (a Retry held in an await, an answer, a call's result) can never reopen or move a run it did not collect.
      if (this.closed.has(cur.workflowId)) return null
      const next = change(cur, begun)
      if (!next) return null
      seen.before = cur
      return this.progress(next, begun)
    })
    this.caps.delete(runId) // read only inside the write
    const before = seen.before
    if (!updated || !before) return null
    const live = this.live.get(runId)
    if (live) live.status = updated.status
    this.d.changed()
    // Before the visits below begin: a new approval's notification must come after this clear, never be wiped by it.
    if (waitingApprovals(before) > 0 && waitingApprovals(updated) === 0) this.cleared(runId)
    if (updated.status === 'failed' && before.status !== 'failed') this.reportFailure(updated, live)
    if (!unfinished(updated)) this.forget(runId)
    if (updated.parent && unfinished(updated) && updated.status !== before.status) this.childMoved(updated)
    if (!unfinished(updated) && unfinished(before)) this.ended(updated)
    // A hold that began in this write: its chats pause and the user hears of it, once.
    if (updated.capHold && updated.capHold.at !== before.capHold?.at)
      this.safely(() => this.d.caps?.held(updated, live?.name ?? FALLBACK_NAME))
    for (const b of begun) await this.begin(updated, b)
    return updated
  }

  private async capsOf(runId: string): Promise<CapContext> {
    const workflowId = this.live.get(runId)?.workflowId
    if (!workflowId || !this.d.caps) return NO_CAPS
    try {
      const ctx = await this.d.caps.context(workflowId, runId)
      return ctx.agents.size > 0 ? { ...ctx, chatAgents: await this.chatAgentsOf(runId) } : ctx
    } catch (e) {
      logError(e)
      return NO_CAPS
    }
  }

  // The agents of the chats the run's Chat steps post into, so the daily cap can judge them; a gone chat has none.
  private async chatAgentsOf(runId: string): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>()
    const run = await this.d.store.getRun(runId)
    for (const s of run?.snapshot.steps ?? []) {
      if (s.kind !== 'chat' || !s.chat || out.has(s.chat)) continue
      const chat = await this.d.chats.get(s.chat)
      if (chat) out.set(s.chat, chat.group ? chat.group.members : [chat.agentName])
    }
    return out
  }

  // Inside a write: the run's own cap, reached by what its visits and running turns cost, holds it.
  private capCheck(r: WorkflowRun): CapHold | null {
    const ctx = this.caps.get(r.id) ?? NO_CAPS
    if (ctx.cap === null || r.capHold) return null
    const spent = runCostUsd(r) + liveOf(r, ctx)
    const limit = effectiveLimit(ctx.cap, r.capLimitUsd)
    return reached(spent, limit) ? { kind: 'run', at: this.d.now(), spentUsd: spent, limitUsd: limit, capUsd: ctx.cap } : null
  }

  // Inside a write: an Agent or For each step about to start on an agent past its daily cap holds the run, and so does a
  // Chat step whose chat's agent (or any room member) is.
  private agentHold(r: WorkflowRun, stepIds: string[]): CapHold | null {
    const ctx = this.caps.get(r.id) ?? NO_CAPS
    for (const id of stepIds) {
      const step = stepOf(r, id)
      if (!step) continue
      const names =
        step.kind === 'agent' || step.kind === 'foreach' ? [step.agent] : step.kind === 'chat' ? (ctx.chatAgents?.get(step.chat) ?? []) : []
      for (const agent of names) {
        const over = ctx.agents.get(agent)
        if (over) return { kind: 'agent', agent, at: this.d.now(), ...over }
      }
    }
    return null
  }

  // A sub-workflow run ended: its parent's visit learns of it on the parent's own queue, never awaited here, since this
  // can run inside a step's begin() on the parent's queue, which is waiting on this child.
  private ended(child: WorkflowRun): void {
    const p = child.parent
    if (!p) return
    void this.serialize(p.runId, () => this.settleChild(p, child)).catch(logError)
  }

  // A sub-workflow run moved between running and waiting: its parent's visit shows the same, so the parent run waits too.
  private childMoved(child: WorkflowRun): void {
    const p = child.parent!
    const status: Visit['status'] = child.status === 'waiting' ? 'waiting' : 'running'
    void this.serialize(p.runId, async () => {
      await this.advance(p.runId, (cur) => {
        const v = cur.visits.find((x) => x.id === p.visitId)
        return v && open(v) && v.status !== status && v.childRunId === child.id
          ? this.withVisit(cur, v.id, (x) => ({ ...x, status }))
          : null
      })
    }).catch(logError)
  }

  // The parent's visit ends as its child did; the child's cost is the visit's. A stop is the user's doing, not the step's.
  private async settleChild(p: Pick<RunParent, 'runId' | 'visitId'>, child: WorkflowRun): Promise<void> {
    const usd = runCostUsd(child)
    const [end, cause]: [VisitEnd, Cause] =
      child.status === 'done'
        ? [{ status: 'done', output: childOutput(child), port: 'out' }, 'step']
        : child.status === 'stopped'
          ? [{ status: 'failed', error: SUB_STOPPED }, 'user']
          : [{ status: 'failed', error: subFailed(child.error) }, 'step']
    const ended = await this.advance(p.runId, (cur) => {
      const v = cur.visits.find((x) => x.id === p.visitId)
      return v?.childRunId === child.id ? this.endVisit(cur, p.visitId, (x) => ({ ...end, ...paid(x, usd) }), cause) : null
    })
    if (ended) return
    // Only a visit a Stop ended took none of its child's cost; one that ended with its child already holds it, and a child
    // Retried by hand after it ended would otherwise count again.
    const v = (await this.d.store.getRun(p.runId))?.visits.find((x) => x.id === p.visitId)
    if (v?.status === 'stopped' && v.childRunId === child.id) await this.addCost(p.runId, p.visitId, usd)
  }

  // Pure but for ids and the clock: starts what the join rule lets through, then the status that follows.
  // A visit failed at its open may go along its failure path, which feeds new starts: so it starts again until nothing
  // more can. Every pass opens a visit, and the caps fail one past them for good (never along a failure path).
  private progress(r: WorkflowRun, begun: Begun[]): WorkflowRun {
    let next = r
    for (;;) {
      // A spend cap holds the run: nothing new starts until Continue (the inboxes keep what waits).
      if (next.capHold) break
      const capped = this.capCheck(next)
      if (capped) {
        next = { ...next, capHold: capped }
        break
      }
      const { state, starts } = takeStarts(next)
      if (!starts.length) break
      const agentHeld = this.agentHold(
        next,
        starts.map((s) => s.stepId)
      )
      if (agentHeld) {
        next = { ...next, capHold: agentHeld }
        break
      }
      next = { ...next, ...state }
      for (const s of starts) next = this.open(next, s.stepId, s.inputs, begun)
    }
    return this.settle(next)
  }

  /** Whether this failure goes along the step's failure path: a step's own failure, with the setting on and a connection. */
  private takesPath(r: WorkflowRun, visit: Visit, cause: Cause): boolean {
    if (cause !== 'step' || visit.error === CAP_TEXT || visit.error === MISSING_STEP) return false
    const step = stepOf(r, visit.stepId)
    return !!step && failsBranch(step) && r.snapshot.edges.some((e) => e.from === step.id && e.port === 'error')
  }

  // Inside a write: a visit that just failed either goes along its failure path (the run goes on) or halts the run.
  private failed(r: WorkflowRun, visit: Visit, cause: Cause): WorkflowRun {
    if (!this.takesPath(r, visit, cause)) return { ...r, halted: true }
    const i = r.visits.findIndex((v) => v.id === visit.id)
    const visits = r.visits.slice()
    const routed: Visit = { ...visit, port: 'error' }
    visits[i] = routed
    const next: WorkflowRun = { ...r, visits }
    return { ...next, ...deliver(next, routed) }
  }

  /**
   * A new visit of a step: failed at once past a cap (or with a list it cannot run), else prepared to begin once written.
   * carried: a For each Retry's items; without them a For each visit splits its input into a fresh list.
   */
  private open(r: WorkflowRun, stepId: string, inputs: Delivery[], begun: Begun[], carried?: ItemRun[]): WorkflowRun {
    const names = Object.fromEntries(r.snapshot.steps.map((s) => [s.id, s.name]))
    const now = this.d.now()
    const visit: Visit = {
      id: this.d.newId(),
      stepId,
      n: r.visits.filter((v) => v.stepId === stepId).length + 1,
      status: 'running',
      input: joinText(inputs, names),
      inputs,
      startedAt: now
    }
    // The caps and a missing step always halt; a list the step can't run is its own failure, so it may take the path.
    const fail = (error: string): WorkflowRun => {
      const failedVisit: Visit = { ...visit, status: 'failed', error, endedAt: now }
      return this.failed({ ...r, visits: [...r.visits, failedVisit] }, failedVisit, 'step')
    }
    const step = stepOf(r, stepId)
    if (!step || step.kind === 'trigger') return fail(MISSING_STEP)
    if (capHit(r, stepId)) return fail(CAP_TEXT)
    let started: ItemRun[] = []
    if (step.kind === 'foreach') {
      let items = carried
      if (!items) {
        const parsed = parseItems(visit.input)
        if ('error' in parsed) return fail(parsed.error)
        items = newItems(parsed.items, () => this.d.newId())
      }
      // Marked running in the visit's own write, so a restart before their sends starts them again.
      const s = startPending(items, concurrencyOf(step), now)
      visit.items = s.items
      started = s.started
    }
    const b = this.prepare(r, step, visit)
    if (started.length === 0) begun.push(b)
    for (const item of started) begun.push({ ...b, item })
    return { ...r, visits: [...r.visits, visit] }
  }

  // Fills the step's templates now, so the visit's missing fields go out in the same write.
  private prepare(r: WorkflowRun, step: Step, visit: Visit): Begun {
    const b: Begun = { visit, step }
    let missing: string[] = []
    if (step.kind === 'llm' || step.kind === 'condition') {
      const p = promptsOf(r, step, visit.inputs)
      b.prompt = p.prompt
      if (p.system !== undefined) b.system = p.system
      missing = p.missing
    } else if (step.kind === 'agent' || step.kind === 'room' || step.kind === 'chat') {
      const { ctx, handles } = contextOf(r, visit.inputs)
      const p = modelPrompt(step.prompt, ctx, handles)
      b.prompt = p.text
      missing = p.missing
    } else if (step.kind === 'foreach') {
      // Each item fills its own prompt as it starts; this fill, with a stand-in item, only records the missing fields.
      const { ctx, handles } = contextOf(r, visit.inputs)
      missing = modelPrompt(step.prompt, { ...ctx, item: { text: '', number: 1, total: 1 } }, handles, { appendInputs: false }).missing
    } else if (step.kind === 'approval') {
      // Raw: only the user reads it. Stored, since the run view has no step outputs or trigger call to fill it from.
      const q = fillTemplate(step.question, contextOf(r, visit.inputs).ctx, 'raw')
      visit.question = q.text.slice(0, OUTPUT_MAX)
      missing = q.missing
      visit.status = 'waiting'
    } else if (step.kind === 'workflow') {
      // Named in this write, so a restart finds the child it started, or starts it under this id, never a second one.
      visit.childRunId = this.d.newId()
      const f = fillTemplate(step.input, contextOf(r, visit.inputs).ctx, 'raw')
      b.prompt = f.text
      missing = f.missing
    } else if (step.kind === 'wait') {
      // From the visit's own start, not a second clock read: the run view shows the wait as exactly its minutes.
      visit.until = visit.startedAt + Math.round((step.minutes * 60_000) / (this.d.waitScale ?? 1))
    } else if (step.kind === 'notify') {
      const { ctx } = contextOf(r, visit.inputs)
      const title = fillTemplate(step.title, ctx, 'raw')
      b.title = title.text.slice(0, NOTIFY_TITLE_MAX)
      visit.title = b.title
      missing = [...title.missing]
      if (step.body) {
        const body = fillTemplate(step.body, ctx, 'raw')
        // The push is built from b.body only (200); the visit keeps the Inbox's longer text, which fileMessage and recover() read.
        b.body = body.text.slice(0, NOTIFY_BODY_MAX)
        visit.body = body.text.slice(0, NOTIFY_INBOX_BODY_MAX)
        missing = [...new Set([...missing, ...body.missing])]
      }
    }
    if (missing.length) visit.missing = missing
    return b
  }

  private settle(r: WorkflowRun): WorkflowRun {
    const o = outcome(r)
    const next: WorkflowRun = { ...r }
    delete next.endedAt
    delete next.error
    // Waiting wins over running: the run shows waiting while anything waits on the user, even with other steps running. A
    // spend cap's hold waits on the user too.
    if (o === 'running' || o === 'waiting')
      return { ...next, status: r.capHold || r.visits.some((v) => v.status === 'waiting') ? 'waiting' : 'running' }
    // An ended run holds nothing: what was left to start is gone with it.
    delete next.capHold
    const failed = latestByStep(r.visits).find(haltingFailure)
    return { ...next, status: o, endedAt: this.d.now(), ...(o === 'failed' && failed?.error ? { error: failed.error } : {}) }
  }

  private async begin(r: WorkflowRun, b: Begun): Promise<void> {
    if (this.stopped) return // shutdown: the visit stays as stored, and recover() picks it up
    const { visit, step } = b
    const ref = { workflowId: r.workflowId, runId: r.id }
    switch (step.kind) {
      case 'llm':
      case 'condition':
        this.call(r.id, r.workflowId, visit.id, step, b.prompt ?? '', b.system)
        return
      case 'approval':
        this.safely(() => this.d.notify.waiting({ ...ref, name: this.nameOf(r.id) }))
        return
      case 'wait':
        this.arm(r.id, visit.id, visit.until ?? this.d.now(), () => this.passOn(r.id, visit.id))
        return
      case 'notify': {
        const title = this.sentTitle(r.id, b.title)
        await this.fileMessage(r, visit, step.name, title, visit.body)
        this.safely(() => this.d.notify.message({ ...ref, title, ...(b.body ? { body: b.body } : {}), messageId: visit.id }))
        await this.passOn(r.id, visit.id)
        return
      }
      case 'agent':
        await this.agentSteps.start(r, this.agentTarget(r, visit, step), b.prompt ?? '', { saved: step.prompt, pick: step.command })
        return
      case 'room':
        await this.agentSteps.start(r, this.roomTarget(r, visit, step), b.prompt ?? '', { saved: step.prompt, pick: step.command })
        return
      case 'chat': {
        // A Chat step's chat has no workflow paragraph in its system prompt (its cache must not change), so the rule rides
        // in the message, after the blocks, which keeps a leading /command first. Never to a remote agent: its host is sent
        // none of ZumiBot's own text (Rulings 13).
        const prompt = b.prompt ?? ''
        const text = prompt.includes('<input') && !(await this.remoteChat(step.chat)) ? `${prompt}\n\n${MATERIAL_RULE}` : prompt
        await this.agentSteps.start(r, this.chatTarget(r, visit, step), text, { saved: step.prompt, pick: step.command })
        return
      }
      case 'foreach':
        if (b.item) await this.startItem(r, visit, b.item, step)
        else await this.goOn(r.id, visit.id) // an empty list: done at once, with an empty output
        return
      case 'http':
        await this.request(r, visit, step)
        return
      case 'transform':
        await this.transform(r.id, visit, step)
        return
      case 'workflow':
        await this.startChild(r, visit, step, b.prompt ?? '')
        return
    }
  }

  // The request goes out apart from the run's queue (it may take a minute); its answer comes back through the queue.
  private async request(r: WorkflowRun, visit: Visit, step: HttpStep): Promise<void> {
    const live = this.live.get(r.id)
    if (!live || this.stopped) return
    const key = step.key ? this.d.vaultKey(step.key) : null
    const fail = async (error: string, extra: Partial<VisitEnd> = {}): Promise<void> => {
      await this.finishVisit(r.id, visit.id, () => ({ status: 'failed', error, ...extra }))
    }
    if (step.key && !key) return fail(KEY_UNAVAILABLE)
    const built = buildHttpRequest(step, contextOf(r, visit.inputs).ctx, key)
    const missing = built.missing.length ? { missing: built.missing } : {}
    if ('error' in built) return fail(built.error, missing)
    const http = { method: built.req.method, url: scrubKey(built.req.url, key) }
    // Shown while it runs, and kept for the run view if a restart cuts it.
    if (!(await this.advance(r.id, (cur) => this.withVisit(cur, visit.id, (v) => ({ ...v, http, ...missing }))))) return
    const ac = new AbortController()
    live.aborts.set(visit.id, ac)
    void (this.d.http ?? httpCall)(built.req, ac.signal)
      .catch((): HttpResult => ({ ok: false, error: 'The request failed' }))
      .then((res) => this.serialize(r.id, () => this.answered(r.id, visit.id, res, key, http)))
      .catch(logError)
  }

  private async answered(
    runId: string,
    visitId: string,
    res: HttpResult,
    key: VaultKey | null,
    http: NonNullable<Visit['http']>
  ): Promise<void> {
    if (this.stopped) return // shutdown cut it: recover() fails the visit as a restart's, since it may have landed
    this.live.get(runId)?.aborts.delete(visitId)
    const done = { ...http, ...(res.status !== undefined ? { status: res.status } : {}) }
    const body = res.body !== undefined ? scrubKey(res.body, key) : undefined
    await this.finishVisit(runId, visitId, () =>
      res.ok
        ? { status: 'done', output: body ?? '', port: 'out', http: done }
        : { status: 'failed', error: scrubKey(res.error, key), ...(body ? { output: body } : {}), http: done }
    )
  }

  // Pure and instant, so recover() simply runs it again.
  private async transform(runId: string, visit: Visit, step: Extract<Step, { kind: 'transform' }>): Promise<void> {
    const res = runTransform(visit.input, step.fields, step.format)
    const missing = res.missing.length ? { missing: res.missing } : {}
    await this.finishVisit(runId, visit.id, () =>
      res.ok ? { status: 'done', output: res.output, port: 'out', ...missing } : { status: 'failed', error: res.error, ...missing }
    )
  }

  /**
   * A Sub-workflow visit's child run, under the id its visit named. Awaited on the parent's queue; the child's end comes
   * back through ended(), queued behind this.
   */
  private async startChild(r: WorkflowRun, visit: Visit, step: SubStep, input: string): Promise<void> {
    if (this.stopped || !visit.childRunId) return
    const fail = async (error: string): Promise<void> => {
      await this.finishVisit(r.id, visit.id, () => ({ status: 'failed', error }))
    }
    const depth = (r.parent?.depth ?? 0) + 1
    if (depth > SUBWORKFLOW_DEPTH_MAX) return fail(SUB_DEEP)
    const child = this.closed.has(step.workflow) ? null : await this.d.store.get(step.workflow)
    if (!child) return fail(SUB_NOT_FOUND)
    if (await this.d.store.getRun(visit.childRunId)) return // a restart found it started
    const parent: RunParent = {
      workflowId: r.workflowId,
      runId: r.id,
      visitId: visit.id,
      name: this.nameOf(r.id),
      stepName: step.name,
      depth
    }
    try {
      await this.start(child, 'workflow', { input, runId: visit.childRunId, parent })
    } catch (error) {
      logError(error)
      await fail(SUB_START_FAILED)
    }
  }

  // At start: a child never started starts now; one that ended while the server was down settles the visit; one still
  // going shows its state on the visit and reports its end as usual.
  private async recoverChild(r: WorkflowRun, v: Visit, step: SubStep): Promise<void> {
    const child = v.childRunId ? await this.d.store.getRun(v.childRunId) : null
    if (!child) {
      await this.startChild(r, v, step, fillTemplate(step.input, contextOf(r, v.inputs).ctx, 'raw').text)
      return
    }
    if (!unfinished(child)) await this.settleChild({ runId: r.id, visitId: v.id }, child)
    else if ((child.status === 'waiting') !== (v.status === 'waiting')) this.childMoved(child)
  }

  // One item's turn, in a fresh chat or, for a Retry, the chat the item had, so the agent keeps what it found.
  private async startItem(r: WorkflowRun, visit: Visit, item: ItemRun, step: ForEachStep): Promise<void> {
    if (this.stopped) return // the item stays as stored, and recover() starts it again
    const total = visit.items?.length ?? 0
    // Upstream {{steps.x.output}} are read here, as each item starts, not when the visit opened: a parallel branch that
    // ends mid-list reaches later items only. visit.missing was computed at open, so it does not follow them.
    const { ctx, handles } = contextOf(r, visit.inputs)
    // The item is the material: the whole list appended to every item would invite the agent to do them all.
    const prompt = modelPrompt(step.prompt, { ...ctx, item: { text: item.text, number: item.n, total } }, handles, {
      appendInputs: false
    }).text
    const name = this.nameOf(r.id)
    await this.agentSteps.start(
      r,
      {
        slotId: item.id,
        agent: step.agent,
        cwd: step.cwd,
        ...(step.model ? { model: step.model } : {}),
        title: this.chatTitle(r.id, [name, step.name, item.text.slice(0, ITEM_TITLE_MAX)]),
        ...(item.chatId ? { earlierChat: item.chatId } : {}),
        // The item's place is for the chat's bar; the system prompt reads only the name, so the cache holds.
        link: { workflowId: r.workflowId, runId: r.id, stepId: step.id, name, item: { n: item.n, total } }
      },
      prompt,
      { saved: step.prompt, pick: step.command }
    )
  }

  // A For each visit with a free slot: pending items start until its slots are full, or the visit ends (an empty list, a
  // crash between items). Nothing to write when every slot is taken.
  private async goOn(runId: string, visitId: string): Promise<void> {
    await this.advance(runId, (cur, begun) => {
      const i = cur.visits.findIndex((v) => v.id === visitId)
      const v = cur.visits[i]
      if (!unfinished(cur) || !v || !open(v)) return null
      const step = stepOf(cur, v.stepId)
      const items = v.items ?? []
      const room = step?.kind === 'foreach' && items.filter(open).length < concurrencyOf(step) && items.some((x) => x.status === 'pending')
      if (items.some(open) && !room) return null
      return this.nextItem(cur, i, items, begun)
    })
  }

  /**
   * Inside a write: the list after an item ended. Pending items are marked running and begun until the step's slots are
   * full; with none open or left the visit ends: done with every reply, or failed once every item was tried. A paused item
   * has not ended (it stays open until Resume carries it on, as an Agent step's visit does), so it holds its slot: one at
   * a time, a Pause holds the rest without a rule of its own; with more slots, the others go on.
   */
  private nextItem(cur: WorkflowRun, i: number, items: ItemRun[], begun: Begun[]): WorkflowRun {
    const v = cur.visits[i]!
    const step = stepOf(cur, v.stepId)
    const now = this.d.now()
    const visits = cur.visits.slice()
    if (step?.kind === 'foreach') {
      // A spend cap holds the run, or the step's agent is past its daily cap: no new item starts, and the visit stays
      // open (its pending items wait) until Continue fills the slots.
      const hold = cur.capHold ?? this.capCheck(cur) ?? (items.some((x) => x.status === 'pending') ? this.agentHold(cur, [step.id]) : null)
      if (hold && (items.some(open) || items.some((x) => x.status === 'pending'))) {
        visits[i] = { ...v, status: items.some(open) ? openVisitStatus(items) : 'running', items }
        return { ...cur, visits, capHold: hold }
      }
      const { items: next, started } = startPending(items, concurrencyOf(step), now)
      if (next.some(open)) {
        const visit: Visit = { ...v, status: openVisitStatus(next), items: next }
        visits[i] = visit
        for (const item of started) begun.push({ visit, step, item })
        return { ...cur, visits }
      }
    }
    const { failed, total } = itemCounts(items)
    if (failed === 0) {
      const visit: Visit = { ...v, items, status: 'done', output: joinItemOutputs(items), port: 'out', endedAt: now }
      visits[i] = visit
      const next: WorkflowRun = { ...cur, visits }
      return { ...next, ...deliver(next, visit) }
    }
    // Quiet when every failed item was the user's doing or a restart's, as one visit's failure would be; such a failure
    // halts the run, as the user's own doing does, rather than take the failure path.
    const live = this.live.get(cur.id)
    const quiet = !!live && items.every((x) => x.status !== 'failed' || live.quiet.has(x.id))
    if (quiet) live!.quiet.add(v.id)
    const cause: Cause = quiet ? 'user' : 'step'
    const ended: Visit = { ...v, items, status: 'failed', error: itemsFailedText(failed, total), endedAt: now }
    // Along the failure path, which items failed and why goes with it.
    const visit = this.takesPath(cur, ended, cause) ? { ...ended, output: failedItemsText(items) } : ended
    visits[i] = visit
    return this.failed({ ...cur, visits }, visit, cause)
  }

  // The step's earlier chat, if any visit of it made one: a loop's next visit and a Retry go on in it.
  private earlierChat(r: WorkflowRun, visit: Visit): string | undefined {
    return r.visits.filter((v) => v.stepId === visit.stepId && v.id !== visit.id && v.chatId).at(-1)?.chatId
  }

  // A loop's next visit and a Retry go on in the step's earlier chat, so the agent keeps its context.
  private agentTarget(r: WorkflowRun, visit: Visit, step: AgentStep): AgentTarget {
    const name = this.nameOf(r.id)
    const earlierChat = this.earlierChat(r, visit)
    return {
      slotId: visit.id,
      agent: step.agent,
      cwd: step.cwd,
      ...(step.model ? { model: step.model } : {}),
      title: step.title ?? this.chatTitle(r.id, [name, step.name]),
      ...(earlierChat ? { earlierChat } : {}),
      // keep: the chat stays in the sidebar and notifies like a routine run's, instead of archiving silently.
      link: { workflowId: r.workflowId, runId: r.id, stepId: step.id, name, ...(step.keep ? { keep: true as const } : {}) }
    }
  }

  // A Room step's copy is made once; a Retry or a loop's next visit goes on in it.
  private roomTarget(r: WorkflowRun, visit: Visit, step: RoomStep): RoomTarget {
    const name = this.nameOf(r.id)
    const earlierChat = this.earlierChat(r, visit)
    return {
      slotId: visit.id,
      room: step.room,
      rules: step.rules ?? [],
      title: step.title ?? this.chatTitle(r.id, [name, step.name]),
      ...(roomFromAgents(step) ? { agents: { members: step.members, role: step.role, cwd: step.cwd } } : {}),
      // Only a kept room is placed.
      ...(step.keep && step.section ? { section: step.section } : {}),
      ...(earlierChat ? { earlierChat } : {}),
      link: { workflowId: r.workflowId, runId: r.id, stepId: step.id, name, ...(step.keep ? { keep: true as const } : {}) }
    }
  }

  // Whether a Chat step's chat is a remote agent's (a room never is). A lookup that fails reads as a local one, so the rule
  // a local agent needs is never lost; the most a remote host gets then is that one fixed sentence.
  private async remoteChat(chatId: string): Promise<boolean> {
    try {
      const chat = await this.d.chats.get(chatId)
      if (!chat || chat.group) return false
      return isRemoteAgent((await this.d.agents()).find((a) => a.name === chat.agentName))
    } catch {
      return false
    }
  }

  // A Chat step posts into the user's own chat: nothing is made or linked, and a Retry or a loop sends into it again.
  private chatTarget(r: WorkflowRun, visit: Visit, step: ChatStepT): ChatTarget {
    const sent: WorkflowSent = { workflowId: r.workflowId, runId: r.id, stepId: step.id, name: this.nameOf(r.id), step: step.name }
    return { slotId: visit.id, chat: step.chat, ...(step.session ? { session: step.session } : {}), sent }
  }

  // A step chat's title, ending in the workflow's own day (its zone as the run started or was recovered).
  private chatTitle(runId: string, parts: string[]): string {
    return [...parts, dayOf(this.d.now(), this.live.get(runId)?.timeZone ?? FALLBACK_ZONE)].join(' · ')
  }

  // The push's title: the filled one, else the workflow's name; the Inbox keeps the same text.
  private sentTitle(runId: string, filled: string | undefined): string {
    return filled?.trim() ? filled : this.nameOf(runId).slice(0, NOTIFY_TITLE_MAX)
  }

  // A store failure never stops the push or the run; only its error text is logged, never the message.
  private async fileMessage(
    r: Pick<WorkflowRun, 'id' | 'workflowId'>,
    visit: Visit,
    stepName: string,
    title: string,
    body: string | undefined
  ): Promise<void> {
    try {
      const added = await this.d.messages.add({
        id: visit.id,
        workflowId: r.workflowId,
        workflowName: this.nameOf(r.id),
        runId: r.id,
        stepName,
        title,
        ...(body ? { body } : {}),
        at: visit.startedAt
      })
      if (added) this.safely(() => this.d.inboxChanged())
    } catch (error) {
      logError(error)
    }
  }

  // A real request, as Run step of an Agent step is a real turn: the user asked for it.
  private async testHttp(step: HttpStep, src: CtxSource, inputs: Delivery[]): Promise<StepTest> {
    const key = step.key ? this.d.vaultKey(step.key) : null
    if (step.key && !key) return { error: KEY_UNAVAILABLE }
    const built = buildHttpRequest(step, contextOf(src, inputs, { [TEST_FROM]: TEST_NAME }).ctx, key)
    const missing = built.missing.length ? { missing: built.missing } : {}
    if ('error' in built) return { error: built.error, ...missing }
    const res = await (this.d.http ?? httpCall)(built.req, new AbortController().signal)
    const body = res.body !== undefined ? scrubKey(res.body, key) : undefined
    return res.ok ? { output: body ?? '', ...missing } : { error: scrubKey(res.error, key), ...(body ? { output: body } : {}), ...missing }
  }

  private async testAgent(
    name: string,
    step: AgentStep | ForEachStep,
    src: CtxSource,
    inputs: Delivery[],
    input: string
  ): Promise<StepTest> {
    let item: TemplateCtx['item']
    if (step.kind === 'foreach') {
      // The first item only: testing the whole list would be a real run.
      const parsed = parseItems(input)
      if ('error' in parsed) return { error: parsed.error }
      if (parsed.items.length === 0) return { error: NO_ITEMS }
      item = { text: parsed.items[0]!, number: 1, total: parsed.items.length }
    }
    if (this.d.builtInCwd(step.agent) === null && !(await this.d.dirExists(step.cwd).catch(() => false))) return { error: FOLDER_MISSING }
    const { ctx, handles } = contextOf(src, inputs, { [TEST_FROM]: TEST_NAME })
    return this.agentSteps.test(
      name,
      step,
      modelPrompt(step.prompt, { ...ctx, ...(item ? { item } : {}) }, handles, { appendInputs: !item }).text
    )
  }

  private passOn(runId: string, visitId: string): Promise<WorkflowRun | null> {
    return this.finishVisit(runId, visitId, (v) => ({ status: 'done', output: v.input, port: 'out' }))
  }

  /** Ends an open visit: done hands its output on, failed stops new starts until Retry. Null when it was not open. */
  private finishVisit(runId: string, visitId: string, end: (v: Visit) => VisitEnd, cause: Cause = 'step'): Promise<WorkflowRun | null> {
    return this.advance(runId, (cur) => this.endVisit(cur, visitId, end, cause))
  }

  // Inside a write: finishVisit's change.
  private endVisit(cur: WorkflowRun, visitId: string, end: (v: Visit) => VisitEnd, cause: Cause): WorkflowRun | null {
    if (!unfinished(cur)) return null
    const i = cur.visits.findIndex((v) => v.id === visitId)
    const v = cur.visits[i]
    if (!v || !open(v)) return null
    // Whatever way it ends, the visit no longer waits for a post in the room.
    const { capped: _capped, ...rest } = v
    const visit: Visit = { ...rest, ...end(v), endedAt: this.d.now() }
    this.release(cur.id, visitId, visit.status === 'failed', cause)
    const visits = cur.visits.slice()
    visits[i] = visit
    const next: WorkflowRun = { ...cur, visits }
    return visit.status === 'done' ? { ...next, ...deliver(next, visit) } : this.failed(next, visit, cause)
  }

  /** An Agent step's change to its open slot: only the slot's own fields move, in one write. */
  private async patchSlot(runId: string, slotId: string, fn: (s: Slot) => Slot): Promise<boolean> {
    return (
      (await this.advance(runId, (cur) => {
        const found = findSlot(cur, slotId)
        if (!found?.item) return this.withVisit(cur, slotId, (v) => putSlot(v, fn(slotFields(v))))
        const item = found.item
        if (!open(item)) return null
        const next = putSlot(item, fn(slotFields(item)))
        // The visit waits while any open item waits, so a card makes the visit, and so the run, wait.
        return this.withVisit(cur, found.visit.id, (v) => {
          const items = v.items!.map((x) => (x.id === slotId ? next : x))
          return { ...v, status: openVisitStatus(items), items }
        })
      })) !== null
    )
  }

  /** An Agent step's turn settled: a visit's reply goes out on its only port; an item's moves its list on. One write. */
  private async finishSlot(runId: string, slotId: string, end: SlotEnd, cause?: Cause): Promise<boolean> {
    return (
      (await this.advance(runId, (cur, begun) => {
        const found = findSlot(cur, slotId)
        if (found?.item) return this.endItem(cur, found.visit, found.item, end, cause ?? 'step', begun)
        return this.endVisit(
          cur,
          slotId,
          () => (end.status === 'done' ? { status: 'done', output: end.output, port: 'out' } : { status: 'failed', error: end.error }),
          cause ?? 'step'
        )
      })) !== null
    )
  }

  // A visit or item ended: what lives in memory for it goes (its timer, call and limit waits). A failure the user or a
  // restart caused is not news, so the run's failure is not reported for it.
  private release(runId: string, slotId: string, failed: boolean, cause: Cause): void {
    const live = this.live.get(runId)
    if (!live) return
    live.timers.get(slotId)?.clear()
    live.timers.delete(slotId)
    live.aborts.delete(slotId)
    live.waits.delete(slotId)
    if (failed && cause !== 'step') live.quiet.add(slotId)
  }

  // Inside a write: an open item ends, and its timer and waits go with it; then the list goes on.
  private endItem(cur: WorkflowRun, visit: Visit, item: ItemRun, end: SlotEnd, cause: Cause, begun: Begun[]): WorkflowRun | null {
    if (!unfinished(cur) || !open(visit) || !open(item)) return null
    const now = this.d.now()
    const ended: ItemRun =
      end.status === 'done'
        ? { ...item, status: 'done', output: end.output.slice(0, FOREACH_ITEM_OUTPUT_MAX), endedAt: now }
        : { ...item, status: 'failed', error: end.error, endedAt: now }
    delete ended.until
    this.release(cur.id, item.id, ended.status === 'failed', cause)
    return this.nextItem(
      cur,
      cur.visits.indexOf(visit),
      visit.items!.map((x) => (x.id === item.id ? ended : x)),
      begun
    )
  }

  private call(runId: string, workflowId: string, visitId: string, step: ModelStep, prompt: string, system: string | undefined): void {
    const live = this.live.get(runId)
    if (!live || this.stopped) return
    const ac = new AbortController()
    live.aborts.set(visitId, ac)
    const pending =
      step.kind === 'llm'
        ? this.d.bare.llm(
            { model: step.model, ...(step.effort ? { effort: step.effort } : {}), ...(system !== undefined ? { system } : {}), prompt },
            ac.signal
          )
        : this.d.bare.condition({ model: step.model, prompt }, ac.signal)
    void pending
      .catch((): BareResult => ({ ok: false, limit: null, error: CALL_FAILED }))
      .then((res) => this.serialize(runId, () => this.called(runId, workflowId, visitId, step, res)))
      .catch(logError)
  }

  private async called(runId: string, workflowId: string, visitId: string, step: ModelStep, res: BareResult): Promise<void> {
    if (this.stopped) return // shutdown cut it: the visit stays running, and recover() asks again
    // Paid for even when the run was stopped meanwhile.
    if (res.ok && res.cost) this.cost(workflowId, res.cost, res.id)
    const usd = res.ok && res.cost ? res.cost.totalUsd : 0
    const live = this.live.get(runId)
    if (!live) {
      await this.addCost(runId, visitId, usd) // the run ended or was stopped: its total still counts the call
      return
    }
    live.aborts.delete(visitId)
    if (res.ok) {
      // In the same write as the end; a visit no longer open still gets it, on its own.
      const end = async (fn: (v: Visit) => VisitEnd): Promise<void> => {
        if (!(await this.finishVisit(runId, visitId, (v) => ({ ...fn(v), ...paid(v, usd) })))) await this.addCost(runId, visitId, usd)
      }
      if (step.kind === 'llm') {
        await end(() => ({ status: 'done', output: res.text.slice(0, OUTPUT_MAX), port: 'out' }))
        return
      }
      const answer = res.answer
      if (answer !== 'yes' && answer !== 'no') {
        await end(() => ({ status: 'failed', error: NO_ANSWER }))
        return
      }
      // The input passes through, so the next step gets the material, not the word yes.
      await end((v) => ({ status: 'done', output: v.input, port: answer, ...(res.reason !== undefined ? { reason: res.reason } : {}) }))
      return
    }
    if (res.limit) {
      // Already inside the run's queue (called() runs under serialize), so halt directly: stopRun would wait behind itself.
      if (live.limitPolicy === 'skip') {
        await this.halt(runId, { status: 'skipped', error: LIMIT_SKIP_TEXT })
        return
      }
      const waits = (live.waits.get(visitId) ?? 0) + 1
      if (res.limit.resetsAt !== null && waits <= ROUTINE_MAX_LIMIT_WAITS) {
        live.waits.set(visitId, waits)
        await this.holdUntil(runId, visitId, res.limit.resetsAt + LIMIT_RESUME_MARGIN_MS)
        return
      }
      await this.finishVisit(runId, visitId, () => ({ status: 'failed', error: LIMIT_TEXT }))
      return
    }
    await this.finishVisit(runId, visitId, () => ({ status: 'failed', error: res.error }))
  }

  // The usage limit: the visit keeps running, with its due time stored so a restart waits too.
  private async holdUntil(runId: string, visitId: string, until: number): Promise<void> {
    const r = await this.advance(runId, (cur) => this.withVisit(cur, visitId, (v) => ({ ...v, until })))
    if (r) this.arm(runId, visitId, until, () => this.rerun(runId, visitId))
  }

  // The limit wait is over, or a restart cut the call: the same visit asks again. Bare calls have no side effects.
  private async rerun(runId: string, visitId: string): Promise<void> {
    if (this.stopped) return
    const r = await this.d.store.getRun(runId)
    const v = r?.visits.find((x) => x.id === visitId)
    const step = r && v ? stepOf(r, v.stepId) : undefined
    if (!r || !v || !unfinished(r) || v.status !== 'running' || (step?.kind !== 'llm' && step?.kind !== 'condition')) return
    if (v.until !== undefined) {
      const cleared = await this.advance(runId, (cur) =>
        this.withVisit(cur, visitId, (x) => {
          const next = { ...x }
          delete next.until
          return next
        })
      )
      if (!cleared) return
    }
    const p = promptsOf(r, step, v.inputs)
    this.call(runId, r.workflowId, visitId, step, p.prompt, p.system)
  }

  /**
   * Inside the run's queue only. Adds to a visit's cost, open or not, in a run ended or not: the call was paid for either
   * way. A plain write, not advance(): nothing else about the run may move, and an ended run must not settle again.
   */
  private async addCost(runId: string, slotId: string, usd: number): Promise<void> {
    if (!(usd > 0)) return
    const updated = await this.d.store.updateRun(runId, (cur) => {
      const found = findSlot(cur, slotId)
      if (!found) return null
      const { visit, item } = found
      const visits = cur.visits.slice()
      // An item's turn counts on the item and on its visit, so the run's total stays the sum of its visits.
      visits[cur.visits.indexOf(visit)] = {
        ...visit,
        ...paid(visit, usd),
        ...(item ? { items: visit.items!.map((x) => (x.id === slotId ? { ...x, costUsd: (x.costUsd ?? 0) + usd } : x)) } : {})
      }
      return { ...cur, visits }
    })
    if (updated) this.d.changed()
  }

  private withVisit(r: WorkflowRun, visitId: string, fn: (v: Visit) => Visit): WorkflowRun | null {
    if (!unfinished(r)) return null
    const i = r.visits.findIndex((v) => v.id === visitId)
    if (i < 0 || !open(r.visits[i]!)) return null
    const visits = r.visits.slice()
    visits[i] = fn(r.visits[i]!)
    return { ...r, visits }
  }

  private arm(runId: string, visitId: string, at: number, fire: () => Promise<unknown>): void {
    const live = this.live.get(runId)
    if (!live) return
    live.timers.get(visitId)?.clear()
    live.timers.delete(visitId)
    if (this.stopped) return
    const ms = Math.min(MAX_TIMER_MS, Math.max(0, at - this.d.now()))
    const handle = (this.d.setTimer ?? realTimer)(() => {
      if (live.timers.get(visitId) === handle) live.timers.delete(visitId)
      if (this.stopped) return
      if (ms === MAX_TIMER_MS)
        this.arm(runId, visitId, at, fire) // longer than one timer can hold
      else
        void this.serialize(runId, async () => {
          await fire()
        }).catch(logError)
    }, ms)
    live.timers.set(visitId, handle)
  }

  // The body of Stop. Silent: the user asked for it, so no failure is reported.
  // `end` skipped: the run ends skipped with that error, still silently (no failure push).
  private async halt(
    runId: string,
    end: { status: 'stopped' } | { status: 'skipped'; error: string } = { status: 'stopped' }
  ): Promise<void> {
    const now = this.d.now()
    const agentChats: (Pick<Visit, 'messageId' | 'until' | 'paused'> & { chatId: string })[] = []
    const children: string[] = []
    const updated = await this.d.store.updateRun(runId, (cur) => {
      agentChats.length = 0
      children.length = 0
      if (!unfinished(cur)) return null
      const visits = cur.visits.map((v): Visit => {
        if (!open(v)) return v
        if (v.childRunId) children.push(v.childRunId)
        if (v.chatId && isChatStep(stepOf(cur, v.stepId)?.kind))
          agentChats.push({ chatId: v.chatId, messageId: v.messageId, until: v.until, paused: v.paused })
        // A For each visit's open item stops with its turn; the pending ones stay pending, never tried.
        const items = v.items?.map((i): ItemRun => {
          if (!open(i)) return i
          // A Retry's item holds its old chat before its message is sent: with no message of ours there, nothing to stop.
          if (i.chatId && i.messageId) agentChats.push({ chatId: i.chatId, messageId: i.messageId, until: i.until, paused: i.paused })
          return { ...i, status: 'stopped', endedAt: now }
        })
        const { capped: _capped, ...rest } = v
        return { ...rest, ...(items ? { items } : {}), status: 'stopped', endedAt: now }
      })
      // A stopped run holds nothing: a spend cap's hold goes with it.
      const { capHold: _gone, ...rest } = cur
      return { ...rest, visits, ...end, endedAt: now }
    })
    this.forget(runId) // aborts its calls and clears its timers, written or not
    if (!updated) return
    this.d.changed()
    for (const { chatId, messageId, until, paused } of agentChats) {
      // A step's message still in the chat's tray waits behind another turn (the user's own, say): dropping it is the
      // whole Stop, and that turn runs on. So does any turn during a usage-limit wait or a pause, whose step turn already ended.
      const dropped = messageId
        ? await this.d.tasks.drop(chatId, messageId).catch((error: unknown) => {
            logError(error)
            return false
          })
        : false
      if (!dropped && until === undefined && !paused) this.safely(() => this.d.stopChat(chatId))
    }
    this.cleared(runId)
    // Not awaited: each child's Stop goes through its own queue, and its end comes back to this run, already stopped.
    for (const child of children) void this.stopRun(child).catch(logError)
    this.ended(updated)
  }

  private async resume(runId: string): Promise<void> {
    const r = await this.d.store.getRun(runId)
    if (!r || !unfinished(r)) return
    for (const v of r.visits) {
      const step = stepOf(r, v.stepId)
      // An approval keeps waiting, its notification still on the devices; an Agent step's (or item's) cards went with its turn.
      if (
        v.status !== 'running' &&
        !(v.status === 'waiting' && (isChatStep(step?.kind) || step?.kind === 'foreach' || step?.kind === 'workflow'))
      )
        continue
      if (step?.kind === 'llm' || step?.kind === 'condition') {
        if (v.until !== undefined && v.until > this.d.now()) this.arm(runId, v.id, v.until, () => this.rerun(runId, v.id))
        else await this.rerun(runId, v.id)
      } else if (step?.kind === 'wait') {
        this.arm(runId, v.id, v.until ?? this.d.now(), () => this.passOn(runId, v.id))
      } else if (step?.kind === 'notify') {
        // Done without sending: a duplicate push is worse than a missing one. The message is filed, since that is silent.
        if (v.title !== undefined && !(await this.d.messages.has(v.id).catch(() => true))) {
          await this.fileMessage(r, v, step.name, this.sentTitle(runId, v.title), v.body)
        }
        await this.passOn(runId, v.id)
      } else if (step?.kind === 'agent' || step?.kind === 'room' || step?.kind === 'chat') {
        await this.agentSteps.recover(r, v.id, v)
      } else if (step?.kind === 'foreach') {
        // Each open item is followed or settled as an Agent visit is; one never sent starts again, since nothing of it
        // ran. Then free slots fill (or, with none open, the list goes on).
        for (const item of v.items?.filter(open) ?? []) {
          if (item.messageId) await this.agentSteps.recover(r, item.id, slotFields(item))
          else await this.startItem(r, v, item, step)
        }
        await this.goOn(runId, v.id)
      } else if (step?.kind === 'http') {
        // The request may or may not have landed: the user decides, with Retry.
        await this.finishVisit(runId, v.id, () => ({ status: 'failed', error: RESTART_TEXT }), 'restart')
      } else if (step?.kind === 'transform') {
        await this.transform(runId, v, step)
      } else if (step?.kind === 'workflow') {
        await this.recoverChild(r, v, step)
      }
    }
    // A crash between the run's first write and its first advance left an inbox nothing started: the join rule starts
    // what it allows now, and the status follows, so such a run never holds one of the 5 slots for good.
    await this.advance(runId, (cur) => (unfinished(cur) ? cur : null))
  }

  private reportFailure(r: WorkflowRun, live: Live | undefined): void {
    // A step's own failure only: a Stop or a restart is something the user did or already knows about.
    if (r.parent) return // a sub-workflow's failure reaches the user through its parent's
    const quiet = live?.quiet ?? new Set<string>()
    if (!latestByStep(r.visits).some((v) => haltingFailure(v) && !quiet.has(v.id))) return
    this.safely(() => this.d.notify.failed({ workflowId: r.workflowId, runId: r.id, name: live?.name ?? FALLBACK_NAME }))
  }

  private forget(runId: string): void {
    const live = this.live.get(runId)
    if (!live) return
    this.lastEnd.set(live.workflowId, this.d.now())
    for (const t of live.timers.values()) t.clear()
    for (const ac of live.aborts.values()) ac.abort()
    this.live.delete(runId)
    this.agentSteps.forgetRun(runId)
  }

  private newLive(
    workflowId: string,
    info: { name: string; timeZone: string; limitPolicy?: 'skip' },
    status: WorkflowRunStatus,
    depth: number
  ): Live {
    return { workflowId, ...info, status, timers: new Map(), aborts: new Map(), waits: new Map(), quiet: new Set(), depth }
  }

  private nameOf(runId: string): string {
    return this.live.get(runId)?.name ?? FALLBACK_NAME
  }

  private async workflowInfo(workflowId: string): Promise<{ name: string; timeZone: string; limitPolicy?: 'skip' }> {
    const w = await this.d.store.get(workflowId)
    return { name: w?.name ?? FALLBACK_NAME, timeZone: w?.timeZone ?? FALLBACK_ZONE, limitPolicy: w?.limitPolicy }
  }

  private cleared(runId: string): void {
    this.safely(() => this.d.notify.cleared(runId))
  }

  private cost(workflowId: string, cost: RunCost, id: string | null): void {
    this.safely(() => this.d.recordCost(workflowId, cost, id))
  }

  private safely(fn: () => void): void {
    try {
      fn()
    } catch (error) {
      logError(error)
    }
  }

  // Outside changes only: recover() and everything it reaches (timers, call results, chat events) never wait here.
  private afterRecovery<T>(op: () => Promise<T>): Promise<T> {
    return this.gate ? this.gate.wait.then(op) : op()
  }

  private openGate(): void {
    this.gate?.open()
    this.gate = null
  }

  // One queue per run: every change to a run is read, decided and written in turn.
  private serialize<T>(runId: string, op: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(runId) ?? Promise.resolve()
    const next = previous.then(op, op)
    const tail = next.then(
      () => undefined,
      () => undefined
    )
    this.queues.set(runId, tail)
    void tail.then(() => {
      if (this.queues.get(runId) === tail) this.queues.delete(runId)
    })
    return next
  }
}
