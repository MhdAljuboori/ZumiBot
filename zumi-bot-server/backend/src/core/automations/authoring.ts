import {
  limitPolicyOf,
  missedPolicyOf,
  sessionPolicyOf,
  type LimitPolicy,
  type MissedPolicy,
  type Routine,
  type RoutineInput,
  type RoutineTarget,
  type RoutineTrigger,
  type Schedule,
  type SessionPolicy
} from '@zumibot/shared/routines'
import { leadingCommand } from '@zumibot/shared/commands'
import { JEV_CONDITION_MAX } from '@zumibot/shared/jev'
import { ROUTINE_CHAT_TITLE_MAX } from '@zumibot/shared/routines'
import { ROLE_MAX_CHARS } from '@zumibot/shared/types'
import {
  FAILING_KINDS,
  HTTP_HEADERS_MAX,
  HTTP_METHODS,
  TRANSFORM_FIELDS_MAX,
  TRANSFORM_NAME_MAX,
  TRANSFORM_PATH_MAX,
  portsOf,
  type Edge,
  type FileChange,
  type Port,
  type Step,
  type StepKind,
  type TriggerFilter,
  type Workflow,
  type WorkflowInput,
  type WorkflowTrigger
} from '@zumibot/shared/workflows'
import { HEADER_NAME_MAX, HEADER_VALUE_MAX, URL_MAX } from '@zumibot/shared/workflowHttp'
import { stepDefaults } from '@zumibot/shared/workflowDefaults'
import { MAIL_FOLDER_DEFAULT, MAIL_PORT_DEFAULT } from '@zumibot/shared/workflowEvents'
import { handleFor, renameHandle } from '@zumibot/shared/workflowGraph'
import { isTimeZone, parseSchedule } from '@zumibot/shared/schedule'
import { parseRoutineInput } from '../routines/routineInput'
import {
  FILTER_TEXT_MAX,
  HANDLE_RE,
  NAME_MAX,
  PATH_MAX,
  SAVED_TEXT_MAX,
  parseTrigger,
  parseWorkflowInput,
  validId
} from '../workflows/workflowInput'
import { chatIdFrom } from './chatTranscript'
import { layout, type Point } from './layout'

// The format Zumi Bot reads and writes routines and workflows in: the stored shape minus what it should never have
// to invent (ids, canvas positions, the trigger step, webhook samples). Every refusal is a sentence the agent can act on.

/** folders: settings.lastFolderByAgent. A missing folder is the agent's last one, else home; a room's lastGroupFolder, else home. */
export interface AuthoringCtx {
  timeZone: string
  folders: Record<string, string>
  groupFolder: string | null
  home: string
  newId(): string
}

export interface RoutineAuthoring {
  id: string
  updatedAt: number
  name: string
  enabled: boolean
  timeZone: string
  trigger: Exclude<RoutineTrigger, { kind: 'webhook' }> | { kind: 'webhook'; condition?: string }
  target: RoutineTarget
  prompt: string
  limitPolicy: LimitPolicy
  missedPolicy: MissedPolicy
  sessionPolicy: SessionPolicy
  spendCap?: number // USD a run may spend; absent = no cap
}
// section and command are the editor's picks: the format never carries them.
type Unplaced<T> = T extends unknown ? Omit<T, 'id' | 'x' | 'y' | 'section' | 'command'> : never
export type StepAuthoring = Unplaced<Exclude<Step, { kind: 'trigger' }>>
export interface EdgeAuthoring {
  from: string
  port: Port
  to: string
}
// An email trigger has no account here: Zumi Bot never sees or invents one (a save keeps the saved one, see workflowTrigger).
export type WorkflowTriggerAuthoring =
  | { kind: 'manual' }
  | { kind: 'schedule'; schedule: Schedule }
  | { kind: 'webhook'; filters: TriggerFilter[]; condition?: string }
  | { kind: 'reply' | 'todo' | 'inbox'; filters: TriggerFilter[] }
  | { kind: 'file'; path: string; pattern: string; changes: FileChange[]; filters: TriggerFilter[] }
  | { kind: 'email'; host: string; port: number; folder: string; filters: TriggerFilter[] }
export interface WorkflowAuthoring {
  id: string
  updatedAt: number
  name: string
  enabled: boolean
  timeZone: string
  trigger: WorkflowTriggerAuthoring
  steps: StepAuthoring[]
  edges: EdgeAuthoring[]
  spendCap?: number // USD a run may spend; absent = no cap
  limitPolicy?: 'skip'
  missedPolicy?: 'skip' // a get shows them only when set; a save also takes 'wait' and 'run-once'
}

type Obj = Record<string, unknown>
/** The trigger step's reserved handle: edges name it, the author never lists it. */
const TRIGGER = 'trigger'

// The bridge passes an error on only when it holds these characters (todoIpc's filter, widened to quotes and slashes),
// so a value the agent sent is echoed with anything else as `?` and the sentence still reaches it.
export const said = (v: unknown, max = 40): string =>
  (typeof v === 'string' ? v : typeof v).replace(/[^A-Za-z0-9 .,:;'(){}?/-]/g, '?').slice(0, max)
const given = (v: unknown): boolean => v !== undefined && v !== null
const blank = (v: unknown): boolean => !given(v) || (typeof v === 'string' && !v.trim())

function record(v: unknown, what: string): Obj {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} must be an object`)
  return v as Obj
}
function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what} must be a list`)
  return v
}
// Exact keys: a misspelt field would otherwise be dropped while the agent believes it set it. `quiet` keys are taken
// and dropped (what a get adds beside the format), so get, change, save works.
function exact(o: Obj, keys: readonly string[], what: string, quiet: readonly string[] = []): void {
  const extra = Object.keys(o).find((k) => !keys.includes(k) && !quiet.includes(k))
  if (extra !== undefined) throw new Error(`${what} has no field "${said(extra)}"; its fields are ${keys.join(', ')}`)
}
// hasOwn: an agent named `constructor` must not read Object.prototype.
function folderOf(ctx: AuthoringCtx, agent: unknown): string {
  const f = typeof agent === 'string' && Object.hasOwn(ctx.folders, agent) ? ctx.folders[agent] : undefined
  return typeof f === 'string' && f ? f : ctx.home
}
const kindKeys = (table: Record<string, readonly string[]>, kind: unknown): readonly string[] | null =>
  typeof kind === 'string' && Object.hasOwn(table, kind) ? table[kind]! : null

const ROUTINE_KEYS = [
  'id',
  'updatedAt',
  'name',
  'enabled',
  'timeZone',
  'trigger',
  'target',
  'prompt',
  'limitPolicy',
  'missedPolicy',
  'sessionPolicy',
  'spendCap'
]
// path: what routine_get adds. command: the editor's `/` pick, which Zumi Bot never sets; a leading /name resolves at run time.
const ROUTINE_QUIET = ['path', 'command']
const ROUTINE_TRIGGERS: Record<string, readonly string[]> = {
  schedule: ['kind', 'schedule'],
  manual: ['kind'],
  webhook: ['kind', 'condition']
}
const TARGETS: Record<string, readonly string[]> = {
  'new-chat': ['kind', 'agent', 'cwd', 'title'],
  'new-group': ['kind', 'members', 'role', 'cwd', 'title', 'section'],
  chat: ['kind', 'chatId']
}

/** An authored routine as the editor would save it; parseRoutineInput has the last word, so the two refuse alike. */
export function routineFromAuthoring(raw: unknown, ctx: AuthoringCtx): RoutineInput {
  const x = record(raw, 'The routine')
  exact(x, ROUTINE_KEYS, 'The routine', ROUTINE_QUIET)
  const trigger = record(x.trigger, 'The trigger')
  const triggerKeys = kindKeys(ROUTINE_TRIGGERS, trigger.kind)
  if (!triggerKeys) throw new Error("The trigger's kind must be schedule, manual or webhook")
  exact(trigger, triggerKeys, 'The trigger')
  const target = { ...record(x.target, 'The target') }
  const targetKeys = kindKeys(TARGETS, target.kind)
  if (!targetKeys) throw new Error("The target's kind must be new-chat, new-group or chat")
  exact(target, targetKeys, 'The target')
  if (target.kind === 'new-chat' && blank(target.cwd)) target.cwd = folderOf(ctx, target.agent)
  if (target.kind === 'new-group' && blank(target.cwd)) target.cwd = ctx.groupFolder ?? ctx.home
  // The schema and the prompt call a room's role optional; the editor saves no role as ''.
  if (target.kind === 'new-group' && blank(target.role)) target.role = ''
  return parseRoutineInput({
    id: x.id ?? null,
    name: x.name,
    enabled: x.enabled ?? true,
    timeZone: x.timeZone ?? ctx.timeZone,
    trigger,
    target,
    prompt: x.prompt,
    limitPolicy: x.limitPolicy ?? limitPolicyOf(null),
    missedPolicy: x.missedPolicy ?? missedPolicyOf(null),
    sessionPolicy: x.sessionPolicy ?? sessionPolicyOf(null),
    command: null,
    spendCap: x.spendCap ?? null
  })
}

export function routineToAuthoring(r: Routine): RoutineAuthoring {
  // A webhook's sample is a real caller's body: Zumi Bot never needs it to edit the routine.
  const trigger: RoutineAuthoring['trigger'] =
    r.trigger.kind === 'webhook'
      ? { kind: 'webhook', ...(r.trigger.condition ? { condition: r.trigger.condition } : {}) }
      : structuredClone(r.trigger)
  return {
    id: r.id,
    updatedAt: r.updatedAt,
    name: r.name,
    enabled: r.enabled,
    timeZone: r.timeZone,
    trigger,
    target: structuredClone(r.target),
    prompt: r.prompt,
    limitPolicy: limitPolicyOf(r),
    missedPolicy: missedPolicyOf(r),
    sessionPolicy: sessionPolicyOf(r),
    ...(r.spendCap !== undefined ? { spendCap: r.spendCap } : {})
  }
}

type AuthoredKind = Exclude<StepKind, 'trigger'>
const STEP_KINDS: readonly AuthoredKind[] = [
  'agent',
  'chat',
  'room',
  'foreach',
  'llm',
  'condition',
  'approval',
  'wait',
  'notify',
  'http',
  'transform',
  'workflow'
]
type Check = (v: unknown, what: string) => unknown
const text =
  (max: number) =>
  (v: unknown, what: string): string => {
    if (typeof v !== 'string') throw new Error(`${what} must be text`)
    if (v.length > max) throw new Error(`${what} is over ${max} characters`)
    return v
  }
const oneOf =
  (values: readonly string[]): Check =>
  (v, what) => {
    if (typeof v === 'string' && values.includes(v)) return v
    throw new Error(`${what} must be ${values.slice(0, -1).join(', ')} or ${values.at(-1)}`)
  }
const flag: Check = (v, what) => {
  if (typeof v === 'boolean') return v
  throw new Error(`${what} must be true or false`)
}
const number: Check = (v, what) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  throw new Error(`${what} must be a number`)
}
const MODEL = oneOf(['opus', 'sonnet', 'haiku'])
// A list of small objects with exactly these text fields, each within its cap.
const pairs =
  (keys: Record<string, number>, max: number, noun: string): Check =>
  (v, what) => {
    const items = list(v, what)
    if (items.length > max) throw new Error(`${what} has more than ${max} ${noun}s`)
    return items.map((item, i) => {
      const o = record(item, `${what}: ${noun} ${i + 1}`)
      exact(o, Object.keys(keys), `${what}: ${noun} ${i + 1}`)
      return Object.fromEntries(Object.entries(keys).map(([k, cap]) => [k, text(cap)(o[k] ?? '', `${what}: ${noun} ${i + 1}'s ${k}`)]))
    })
  }
const workflowRef: Check = (v, what) => {
  if (typeof v === 'string' && (v === '' || validId(v))) return v
  throw new Error(`${what} must be a workflow's id from workflows_list`)
}
// The user names a room by its link (or id); the step stores the chat id.
const roomRef: Check = (v, what) => {
  const id = typeof v === 'string' ? chatIdFrom(v) : null
  if (id !== null) return id
  throw new Error(`${what} must be a room's link or id`)
}
// The user names a chat the same way; the step stores the chat id.
const chatRef: Check = (v, what) => {
  const id = typeof v === 'string' ? chatIdFrom(v) : null
  if (id !== null) return id
  throw new Error(`${what} must be a chat's link or id`)
}
// Agent names reach here already resolved to file names (withWorkflowAgents), so only the shape is checked.
const memberList: Check = (v, what) => {
  const names = list(v, what).map((m, i) => text(NAME_MAX)(m, `${what}: member ${i + 1}`))
  if (new Set(names).size !== names.length) throw new Error(`${what} names an agent twice`)
  return names
}
const AGENT_FIELDS: Record<string, Check> = { agent: text(NAME_MAX), prompt: text(SAVED_TEXT_MAX), cwd: text(PATH_MAX), model: MODEL }
// keep: the step's chat stays in the sidebar; title names it (only a kept chat has one).
const KEEP_FIELDS: Record<string, Check> = { keep: flag, title: text(ROUTINE_CHAT_TITLE_MAX) }
// 1 is one at a time, the stored form's absent key; parseStep keeps only 2 and 3.
const CONCURRENCY: Check = (v, what) => {
  if (v === 1 || v === 2 || v === 3) return v
  throw new Error(`${what} must be 1, 2 or 3`)
}
// Each kind's stored fields, within the bounds workflowInput.ts saves, so its bare `Invalid workflow` is never reached.
const FIELDS: Record<AuthoredKind, Record<string, Check>> = {
  agent: { ...AGENT_FIELDS, ...KEEP_FIELDS },
  // 'continue' is the stored form's absent key.
  chat: { chat: chatRef, prompt: text(SAVED_TEXT_MAX), session: oneOf(['continue', 'fresh']) },
  // A template room or one built from agents (members, role, cwd), never both.
  room: {
    room: roomRef,
    prompt: text(SAVED_TEXT_MAX),
    members: memberList,
    role: text(ROLE_MAX_CHARS),
    cwd: text(PATH_MAX),
    ...KEEP_FIELDS
  },
  foreach: { ...AGENT_FIELDS, concurrency: CONCURRENCY },
  llm: { prompt: text(SAVED_TEXT_MAX), system: text(SAVED_TEXT_MAX), model: MODEL, effort: oneOf(['low', 'medium', 'high']) },
  condition: { question: text(SAVED_TEXT_MAX), model: MODEL },
  approval: { question: text(SAVED_TEXT_MAX), editable: flag },
  wait: { minutes: number },
  notify: { title: text(SAVED_TEXT_MAX), body: text(SAVED_TEXT_MAX) },
  // No key: the user picks a vault key in the editor, and an edit keeps it.
  http: {
    method: oneOf(HTTP_METHODS),
    url: text(URL_MAX),
    headers: pairs({ name: HEADER_NAME_MAX, value: HEADER_VALUE_MAX }, HTTP_HEADERS_MAX, 'header'),
    body: text(SAVED_TEXT_MAX),
    bodyType: oneOf(['json', 'text'])
  },
  transform: {
    fields: pairs({ name: TRANSFORM_NAME_MAX, path: TRANSFORM_PATH_MAX }, TRANSFORM_FIELDS_MAX, 'field'),
    format: oneOf(['json', 'lines'])
  },
  workflow: { workflow: workflowRef, input: text(SAVED_TEXT_MAX) }
}
const WORKFLOW_KEYS = [
  'id',
  'updatedAt',
  'name',
  'enabled',
  'timeZone',
  'trigger',
  'steps',
  'edges',
  'spendCap',
  'limitPolicy',
  'missedPolicy'
]
const WORKFLOW_QUIET = ['path', 'problems'] // what workflow_get adds
// roomTitle: what workflow_get adds to a Room step. rules: approval rules only the user adds, so a get never shows them and a save ignores them.
const ROOM_QUIET = ['roomTitle', 'rules']
// allowLocalNetwork: only the user turns it on in the editor (it opens this machine and the LAN to the step), so a save ignores
// what is sent and an edit keeps the stored one, as a vault key.
const HTTP_QUIET = ['allowLocalNetwork']
const FILTERS = ['filters']
const WORKFLOW_TRIGGERS: Record<string, readonly string[]> = {
  manual: ['kind'],
  schedule: ['kind', 'schedule'],
  webhook: ['kind', 'filters', 'condition'],
  reply: ['kind', ...FILTERS],
  todo: ['kind', ...FILTERS],
  inbox: ['kind', ...FILTERS],
  file: ['kind', 'path', 'pattern', 'changes', 'filters'],
  email: ['kind', 'host', 'port', 'folder', 'filters']
}
const FILE_CHANGES: readonly FileChange[] = ['added', 'changed', 'removed']

function triggerFilters(v: unknown): TriggerFilter[] {
  return (given(v) ? list(v, 'filters') : []).map((f, i): TriggerFilter => {
    const o = record(f, `Filter ${i + 1}`)
    exact(o, ['field', 'equals', 'op'], `Filter ${i + 1}`)
    const op = given(o.op) ? oneOf(['contains', 'equals'])(o.op, `Filter ${i + 1}'s op`) : 'equals'
    return {
      field: text(FILTER_TEXT_MAX)(o.field, `Filter ${i + 1}'s field`),
      equals: text(FILTER_TEXT_MAX)(o.equals, `Filter ${i + 1}'s equals`),
      ...(op === 'contains' ? { op } : {})
    }
  })
}

// `before` is the saved trigger: an email trigger's account is the user's pick in the editor, so it stays only while the
// mailbox it points at is unchanged. A new host or port would otherwise send the stored password to a server Zumi Bot chose.
function workflowTrigger(v: unknown, before: WorkflowTrigger | null): WorkflowTrigger {
  const t = record(v, 'The trigger')
  const keys = kindKeys(WORKFLOW_TRIGGERS, t.kind)
  if (!keys) throw new Error("The trigger's kind must be one of manual, schedule, webhook, reply, todo, inbox, file or email")
  exact(t, keys, 'The trigger')
  if (t.kind === 'manual') return { kind: 'manual' }
  if (t.kind === 'schedule') {
    const schedule = parseSchedule(t.schedule)
    if (!schedule) throw new Error('The schedule is invalid')
    return { kind: 'schedule', schedule }
  }
  const filters = triggerFilters(t.filters)
  if (t.kind === 'webhook') {
    // Blank is none: one stored shape means "no condition". The check Jev runs on each call (jev.ts).
    const condition = given(t.condition)
      ? text(JEV_CONDITION_MAX)(typeof t.condition === 'string' ? t.condition.trim() : t.condition, "The trigger's condition")
      : ''
    // The hook's latest real call becomes the sample on save, never anything the author sends.
    return { kind: 'webhook', sample: null, filters, ...(condition ? { condition } : {}) }
  }
  if (t.kind === 'reply' || t.kind === 'todo' || t.kind === 'inbox') return { kind: t.kind, filters }
  // Types are checked here for a readable refusal; the limits and the port range stay in the shared parser, run last.
  let trigger: unknown
  if (t.kind === 'file') {
    const changes = given(t.changes) ? list(t.changes, 'changes').map((c) => oneOf(FILE_CHANGES)(c, 'changes')) : [...FILE_CHANGES]
    if (!changes.length) throw new Error('changes must list at least one of added, changed or removed')
    trigger = {
      kind: 'file',
      path: text(Infinity)(t.path, 'The trigger: path'),
      pattern: given(t.pattern) ? text(Infinity)(t.pattern, 'The trigger: pattern') : '',
      changes,
      filters
    }
  } else {
    const port = given(t.port) ? t.port : MAIL_PORT_DEFAULT
    if (typeof port !== 'number' || !Number.isInteger(port)) throw new Error('The trigger: port must be a whole number')
    const host = text(Infinity)(t.host, 'The trigger: host')
    const folder = given(t.folder) ? text(Infinity)(t.folder, 'The trigger: folder') : MAIL_FOLDER_DEFAULT
    const keep = before?.kind === 'email' && before.port === port && before.host.trim().toLowerCase() === host.trim().toLowerCase()
    trigger = { kind: 'email', account: keep ? before.account : '', host: host.trim(), port, folder, filters }
  }
  try {
    return parseTrigger(trigger)
  } catch {
    throw new Error('The trigger is invalid: a path, pattern, host, folder or filter is too long, or the port is not from 1 to 65535')
  }
}

type Draft = Obj & { id: string; handle: string; kind: StepKind }

/**
 * An authored workflow as the editor would save it. On an edit (`before`) a step whose handle exists keeps its id and
 * place and an unchanged connection its id, so the user's canvas stays as they left it; parseWorkflowInput runs last.
 */
export function workflowFromAuthoring(raw: unknown, before: Workflow | null, ctx: AuthoringCtx): WorkflowInput {
  const x = record(raw, 'The workflow')
  exact(x, WORKFLOW_KEYS, 'The workflow', WORKFLOW_QUIET)
  if (given(x.id) && !validId(x.id)) throw new Error('id is not a workflow id')
  if (typeof x.name !== 'string' || !x.name.trim()) throw new Error('The workflow needs a name')
  if (x.name.length > NAME_MAX) throw new Error(`The workflow's name is over ${NAME_MAX} characters`)
  if (given(x.enabled) && typeof x.enabled !== 'boolean') throw new Error('enabled must be true or false')
  const timeZone = given(x.timeZone) ? x.timeZone : ctx.timeZone
  if (typeof timeZone !== 'string' || !isTimeZone(timeZone)) throw new Error('timeZone must be an IANA time zone, such as Europe/Istanbul')
  const trigger = workflowTrigger(x.trigger, before?.trigger ?? null)
  const rawSteps = list(x.steps, 'steps')
  const rawEdges = list(x.edges, 'edges')

  // Every id the workflow held stays taken: its runs and chats still name a removed step's id.
  const used = new Set([...(before?.steps ?? []).map((s) => s.id), ...(before?.edges ?? []).map((e) => e.id)])
  const fresh = (): string => {
    for (let i = 0; i < 1000; i++) {
      const id = ctx.newId()
      if (validId(id) && !used.has(id)) {
        used.add(id)
        return id
      }
    }
    throw new Error('No unused id') // a generator stuck on taken ids is a bug, not a loop to hang in
  }
  const placed = new Map<string, Point>()
  const oldTrigger = before?.steps.find((s) => s.kind === 'trigger')
  if (oldTrigger) placed.set(oldTrigger.id, { x: oldTrigger.x, y: oldTrigger.y })
  const steps: Draft[] = [{ id: oldTrigger?.id ?? fresh(), handle: TRIGGER, name: oldTrigger?.name ?? 'Trigger', kind: 'trigger' }]
  const oldByHandle = new Map((before?.steps ?? []).filter((s) => s.kind !== 'trigger').map((s) => [s.handle, s]))
  const handles = new Set<string>()

  rawSteps.forEach((r, i) => {
    const o = record(r, `Step ${i + 1}`)
    const handle = o.handle
    if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
      const hint = handleFor(
        typeof handle === 'string' ? handle : typeof o.name === 'string' ? o.name : 'step',
        new Set([...handles, TRIGGER])
      )
      throw new Error(`Step ${i + 1}'s handle must be 1 to 32 lowercase letters, digits or dashes, such as "${hint}"`)
    }
    if (handle === TRIGGER) throw new Error(`The handle "trigger" is kept for the trigger step: give step ${i + 1} another handle`)
    if (handles.has(handle)) throw new Error(`Two steps have the handle "${handle}": each step needs its own handle`)
    handles.add(handle)
    const what = `Step "${handle}"`
    const kind = STEP_KINDS.find((k) => k === o.kind)
    if (!kind) throw new Error(`${what} needs a kind: ${STEP_KINDS.join(', ')}`)
    const fields = FIELDS[kind]
    exact(
      o,
      ['handle', 'name', 'kind', ...Object.keys(fields)],
      `${what} (${kind})`,
      kind === 'room' ? ROOM_QUIET : kind === 'http' ? HTTP_QUIET : []
    )
    const old = oldByHandle.get(handle)
    const name = given(o.name) ? text(NAME_MAX)(o.name, `${what}: name`) : handle
    const step: Draft = { id: '', handle, name, kind, ...stepDefaults(kind) }
    // A room built from agents has no template: the two shapes never mix, and role and folder belong to the first.
    const sentMembers = kind === 'room' && given(o.members)
    if (sentMembers && !blank(o.room)) throw new Error(`${what}: give a room or members, not both`)
    // An edit that names neither keeps the members, role and folder of a room built from agents: role or cwd alone change just those.
    const oldRoom = kind === 'room' && old?.kind === 'room' ? old : null
    const keepMembers = !!oldRoom?.members && !sentMembers && blank(o.room)
    const fromAgents = sentMembers || keepMembers
    if (kind === 'room' && !fromAgents && (!blank(o.role) || !blank(o.cwd)))
      throw new Error(`${what}: role and cwd belong to a room built from members`)
    // A room or chat left out (or blank) on an edit keeps the stored one; on a create it stays empty, which problemsOf reports.
    const ref = kind === 'room' ? 'room' : kind === 'chat' ? 'chat' : null
    const keepRef = ref !== null && old?.kind === kind && blank(o[ref]) && !fromAgents
    for (const [k, check] of Object.entries(fields))
      if (given(o[k]) && !(k === ref && (keepRef || blank(o[k])))) step[k] = check(o[k], `${what}: ${k}`)
    if (keepMembers && oldRoom) {
      step.members = oldRoom.members
      step.role ??= oldRoom.role ?? ''
      if (blank(step.cwd) && oldRoom.cwd) step.cwd = oldRoom.cwd
    }
    // 'continue' is a chat step's default, stored as the absent key.
    if (kind === 'chat' && step.session === 'continue') delete step.session
    // keep is true or absent, so one stored shape means "not kept".
    if (step.keep === false) delete step.keep
    // A blank folder can never run, so it gets what the editor's folder picker would offer.
    if ((kind === 'agent' || kind === 'foreach') && blank(step.cwd)) step.cwd = folderOf(ctx, step.agent)
    if (fromAgents) {
      step.role ??= ''
      if (blank(step.cwd)) step.cwd = ctx.groupFolder ?? ctx.home
    }
    // The format has no vault key: an edit keeps the one the user picked.
    if (kind === 'http' && old?.kind === 'http' && old.key) step.key = old.key
    if (kind === 'http' && old?.kind === 'http' && old.allowLocalNetwork) step.allowLocalNetwork = true
    // Same for a Room step's room and approval rules: only the user adds a rule, and the author never sees one. The rules
    // were approved for that room's members, so a step pointed at another room starts with none.
    if (kind === 'room' && old?.kind === 'room') {
      if (keepRef) step.room = old.room
      if (old.rules?.length && step.room === old.room) step.rules = old.rules
      // The sidebar section is picked in the editor: kept while the room still is.
      if (old.section && step.keep === true) step.section = old.section
    }
    if (keepRef && kind === 'chat' && old?.kind === 'chat') step.chat = old.chat
    // The editor's `/` pick stays while the step keeps its handle and the prompt still starts with its name (parseStep checks it again).
    if (
      old &&
      old.kind === kind &&
      'command' in old &&
      old.command &&
      typeof step.prompt === 'string' &&
      leadingCommand(step.prompt)?.name === old.command.name
    )
      step.command = old.command
    step.id = old?.id ?? fresh()
    if (old) placed.set(old.id, { x: old.x, y: old.y })
    steps.push(step)
  })

  const byHandle = new Map(steps.map((s) => [s.handle, s]))
  const oldEdges = new Map((before?.edges ?? []).map((e) => [`${e.from}\n${e.port}\n${e.to}`, e.id]))
  const edges: Edge[] = []
  const seen = new Set<string>()
  rawEdges.forEach((r, i) => {
    const o = record(r, `Edge ${i + 1}`)
    exact(o, ['from', 'port', 'to'], `Edge ${i + 1}`)
    const from = typeof o.from === 'string' ? byHandle.get(o.from) : undefined
    if (!from) throw new Error(`An edge comes from "${said(o.from)}", but no step has that handle`)
    if (o.to === TRIGGER) throw new Error('No edge can go into the trigger')
    const to = typeof o.to === 'string' ? byHandle.get(o.to) : undefined
    if (!to) throw new Error(`An edge goes to "${said(o.to)}", but no step has that handle`)
    // As the canvas: it never draws a step feeding itself.
    if (from === to) throw new Error(`A step can't connect to itself: "${from.handle}"`)
    // error is the failure path's port: a connection from it turns the step's On failure setting on.
    const ports: Port[] = FAILING_KINDS.includes(from.kind) ? [...portsOf(from.kind), 'error'] : portsOf(from.kind)
    const port = ports.find((p) => p === (given(o.port) ? o.port : 'out'))
    if (!port) {
      throw new Error(
        `The edge from "${from.handle}" to "${to.handle}" names the port "${said(o.port)}", but step "${from.handle}" (${from.kind}) only has ${ports.length > 1 ? 'the ports' : 'the port'} ${ports.join(', ')}`
      )
    }
    const k = `${from.id}\n${port}\n${to.id}`
    if (seen.has(k)) return // the canvas never draws one connection twice
    seen.add(k)
    edges.push({ id: oldEdges.get(k) ?? fresh(), from: from.id, port, to: to.id })
  })

  // The setting follows the connections: on where an error edge leaves the step, off everywhere else.
  for (const s of steps) {
    if (edges.some((e) => e.from === s.id && e.port === 'error')) s.onFailure = 'branch'
    else delete s.onFailure
  }
  const pos = layout(steps, edges, steps[0]!.id, placed)
  return parseWorkflowInput({
    id: before?.id ?? x.id ?? null,
    name: x.name,
    enabled: x.enabled ?? true,
    timeZone,
    trigger,
    steps: steps.map((s) => ({ ...s, ...pos.get(s.id)! })),
    edges,
    spendCap: x.spendCap ?? null,
    // wait and run-once are the stored form's absent keys.
    limitPolicy: given(x.limitPolicy) && oneOf(['wait', 'skip'])(x.limitPolicy, 'limitPolicy') === 'skip' ? 'skip' : undefined,
    missedPolicy: given(x.missedPolicy) && oneOf(['run-once', 'skip'])(x.missedPolicy, 'missedPolicy') === 'skip' ? 'skip' : undefined
  })
}

const filtersToAuthoring = (fs: TriggerFilter[]): TriggerFilter[] =>
  fs.map((f) => ({ field: f.field, equals: f.equals, ...(f.op ? { op: f.op } : {}) }))

// Every kind is listed, so a new one fails the compile here instead of reading as manual. No webhook sample (a real
// caller's body) and no email account (a mailbox the user picked).
function triggerToAuthoring(t: WorkflowTrigger): WorkflowTriggerAuthoring {
  switch (t.kind) {
    case 'manual':
      return { kind: 'manual' }
    case 'schedule':
      return { kind: 'schedule', schedule: structuredClone(t.schedule) }
    case 'webhook':
      return { kind: 'webhook', filters: filtersToAuthoring(t.filters), ...(t.condition ? { condition: t.condition } : {}) }
    case 'reply':
    case 'todo':
    case 'inbox':
      return { kind: t.kind, filters: filtersToAuthoring(t.filters) }
    case 'file':
      return { kind: 'file', path: t.path, pattern: t.pattern, changes: [...t.changes], filters: filtersToAuthoring(t.filters) }
    case 'email':
      return { kind: 'email', host: t.host, port: t.port, folder: t.folder, filters: filtersToAuthoring(t.filters) }
    default:
      throw new Error('The workflow has a trigger this format does not know')
  }
}

export function workflowToAuthoring(w: Workflow): WorkflowAuthoring {
  const handleOf = new Map(w.steps.map((s) => [s.id, s.kind === 'trigger' ? TRIGGER : s.handle]))
  // Renaming the trigger in the editor moves its handle and its placeholders with it. The format calls it `trigger`,
  // and saving rebuilds it under that handle, so its placeholders must read `trigger` too or they would name no step.
  const old = w.steps.find((s) => s.kind === 'trigger')?.handle ?? TRIGGER
  const steps = w.steps.flatMap((s): StepAuthoring[] => {
    if (s.kind === 'trigger') return []
    const out: Obj = {}
    for (const [k, v] of Object.entries(s)) {
      // onFailure follows the error edges; key is a vault item, allowLocalNetwork the user's opt-in and rules the user's
      // approvals: the format never shows them.
      // section and command are the editor's picks, kept on an edit; the format never shows them.
      if (
        k === 'id' ||
        k === 'x' ||
        k === 'y' ||
        k === 'onFailure' ||
        k === 'key' ||
        k === 'allowLocalNetwork' ||
        k === 'rules' ||
        k === 'section' ||
        k === 'command'
      )
        continue
      // Every text field, as the canvas's rehandle does, so a new template field is covered without a list.
      out[k] = typeof v === 'string' && k !== 'handle' && k !== 'kind' && old !== TRIGGER ? renameHandle(v, old, TRIGGER) : v
    }
    return [out as StepAuthoring]
  })
  const edges = w.edges.flatMap((e): EdgeAuthoring[] => {
    const from = handleOf.get(e.from),
      to = handleOf.get(e.to)
    return from !== undefined && to !== undefined ? [{ from, port: e.port, to }] : []
  })
  const trigger = triggerToAuthoring(w.trigger)
  return {
    id: w.id,
    updatedAt: w.updatedAt,
    name: w.name,
    enabled: w.enabled,
    timeZone: w.timeZone,
    trigger,
    steps,
    edges,
    ...(w.spendCap !== undefined ? { spendCap: w.spendCap } : {}),
    ...(w.limitPolicy ? { limitPolicy: w.limitPolicy } : {}),
    ...(w.missedPolicy ? { missedPolicy: w.missedPolicy } : {})
  }
}
