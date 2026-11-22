import { leadingCommand, type CommandPick } from './commands'
import { JEV_CONDITION_MAX } from './jev'
import { ROUTINE_CHAT_TITLE_MAX } from './routines'
import { ROLE_MAX_CHARS } from './types'
import { parseSpendCap } from './spendCaps'
import { isTimeZone, parseSchedule } from './schedule'
import { concurrencyKey } from './workflowForEach'
import { HEADER_NAME_MAX, HEADER_VALUE_MAX, URL_MAX } from './workflowHttp'
import {
  FAILING_KINDS,
  GROUPS_MAX,
  NAME_MAX,
  GROUP_DESCRIPTION_MAX,
  GROUP_NAME_MAX,
  HTTP_HEADERS_MAX,
  HTTP_METHODS,
  NOTES_MAX,
  NOTE_HEX_RE,
  NOTE_MAX_SIDE,
  NOTE_MIN,
  NOTE_TEXT_MAX,
  PROMPT_MAX,
  STEP_RULES_MAX,
  TRANSFORM_FIELDS_MAX,
  TRANSFORM_NAME_MAX,
  TRANSFORM_PATH_MAX,
  stepPorts,
  type CanvasGroup,
  type Edge,
  type FileChange,
  type Note,
  type NoteColor,
  type Effort,
  type ModelAlias,
  type Port,
  type Step,
  type StepRule,
  type StepKind,
  type TriggerFilter,
  type WorkflowInput,
  type WorkflowTrigger
} from './workflows'
import { sameStepRule, stepRuleShapeOk } from './stepRules'

/** The one answer to any malformed input: the editor never sends one, so a detail would only help a probe. */
export const INVALID_WORKFLOW = 'Invalid workflow'
/**
 * A text field may be saved over its cap: Save always works, problemsOf flags the field, and running or turning the
 * workflow on refuses it. This bound only keeps a bad client from bloating workflows.json.
 */
export const SAVED_TEXT_MAX = 5 * PROMPT_MAX
export { NAME_MAX }
export const FILTER_TEXT_MAX = 1_000
export const PATH_MAX = 4_096
const ID_RE = /^[A-Za-z0-9-]{1,64}$/
/**
 * A workflow, run, visit, step or edge id. Run state and the runs file are plain objects keyed by these ids, so a name
 * like `constructor` or `toString` would read an inherited member there.
 */
export const validId = (v: unknown): v is string => typeof v === 'string' && ID_RE.test(v) && !Object.hasOwn(Object.prototype, v)
// What handleFor makes: templates read `{{steps.<handle>.output}}`, so a dot, space or brace would break them.
export const HANDLE_RE = /^[a-z0-9-]{1,32}$/

const KINDS: readonly StepKind[] = [
  'trigger',
  'agent',
  'room',
  'foreach',
  'llm',
  'condition',
  'approval',
  'wait',
  'notify',
  'http',
  'transform',
  'workflow',
  'chat'
]
const members = (v: unknown): string[] => list(v).map(id)
const MODELS: readonly ModelAlias[] = ['opus', 'sonnet', 'haiku']
const EFFORTS: readonly Effort[] = ['low', 'medium', 'high']

function fail(): never {
  throw new Error(INVALID_WORKFLOW)
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : fail())
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : fail())
const text = (v: unknown, max: number): string => (typeof v === 'string' && v.length <= max ? v : fail())
const optText = (v: unknown, max: number): string | undefined => (v === undefined || v === null ? undefined : text(v, max))
const id = (v: unknown): string => (validId(v) ? v : fail())
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail())
const oneOf = <T extends string>(v: unknown, values: readonly T[]): T => (values.includes(v as T) ? (v as T) : fail())
const optOneOf = <T extends string>(v: unknown, values: readonly T[]): T | undefined =>
  v === undefined || v === null ? undefined : oneOf(v, values)

// Each key taken on its own: a rule that could never apply (a command on Edit) is refused rather than kept inert.
function parseRules(v: unknown): StepRule[] {
  const out: StepRule[] = []
  for (const r of list(v)) {
    const o = obj(r)
    // One check for the parser and for a rule a card adds (stepRuleFits), so what a card saves always parses again.
    if (!stepRuleShapeOk(o)) fail()
    const agent = optText(o.agent, NAME_MAX)
    const rule: StepRule = {
      tool: o.tool as string,
      ...(o.tool === 'Bash' ? { command: o.command as string } : {}),
      ...(o.unsandboxed ? { unsandboxed: true as const } : {}),
      ...(agent ? { agent } : {})
    }
    if (!out.some((x) => sameStepRule(x, rule))) out.push(rule)
    if (out.length > STEP_RULES_MAX) fail()
  }
  return out
}

const FILE_CHANGES: readonly FileChange[] = ['added', 'changed', 'removed']

// op is kept only as 'contains' (absent = equals); anything else is refused.
function filters(v: unknown): TriggerFilter[] {
  return list(v ?? []).map((f): TriggerFilter => {
    const o = obj(f)
    const op = o.op === undefined || o.op === null || o.op === 'equals' ? undefined : o.op === 'contains' ? ('contains' as const) : fail()
    return { field: text(o.field, FILTER_TEXT_MAX), equals: text(o.equals, FILTER_TEXT_MAX), ...(op ? { op } : {}) }
  })
}

/** A trigger on its own, as a workflow's is parsed (Check mailbox sends the editor's email trigger). */
export function parseTrigger(v: unknown): WorkflowTrigger {
  const x = obj(v)
  if (x.kind === 'manual') return { kind: 'manual' }
  if (x.kind === 'schedule') return { kind: 'schedule', schedule: parseSchedule(x.schedule) ?? fail() }
  if (x.kind === 'webhook') {
    // Never the client's sample: the handler puts in the hook's latest real call, as routines do.
    // Trimmed; blank is none, so one stored shape means "no condition".
    const raw = x.condition === undefined || x.condition === null ? '' : typeof x.condition === 'string' ? x.condition.trim() : fail()
    if (raw.length > JEV_CONDITION_MAX) fail()
    return { kind: 'webhook', sample: null, filters: filters(x.filters), ...(raw ? { condition: raw } : {}) }
  }
  if (x.kind === 'reply' || x.kind === 'todo' || x.kind === 'inbox') return { kind: x.kind, filters: filters(x.filters) }
  if (x.kind === 'file') {
    const changes = [...new Set(list(x.changes).map((c) => oneOf(c, FILE_CHANGES)))]
    if (!changes.length) fail()
    return { kind: 'file', path: text(x.path, 1_000), pattern: text(x.pattern, 200), changes, filters: filters(x.filters) }
  }
  if (x.kind === 'email') {
    const port = x.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535) fail()
    return {
      kind: 'email',
      account: text(x.account, 64),
      host: text(x.host, 253),
      port,
      folder: text(x.folder, 200),
      filters: filters(x.filters)
    }
  }
  return fail()
}

// Kept only while the saved prompt still starts with its name (a pick for a command the prompt no longer holds is stale) and names an agent.
function parseCommand(v: unknown, prompt: string): { command?: CommandPick } {
  if (v === undefined || v === null) return {}
  const o = obj(v)
  const agent = text(o.agent, NAME_MAX),
    name = text(o.name, NAME_MAX)
  return agent.trim() && leadingCommand(prompt)?.name === name ? { command: { agent, name } } : {}
}
// keep is true or absent; a blank title is none, a long one refused.
function parseKeep(x: Obj): { keep?: true; title?: string } {
  if (x.keep !== true) return {}
  const title = typeof x.title === 'string' ? x.title.trim() : ''
  if (title.length > ROUTINE_CHAT_TITLE_MAX) fail()
  return { keep: true, ...(title ? { title } : {}) }
}

// Rebuilt key by key, so nothing else the client sends is stored.
export function parseStep(v: unknown): Step {
  const x = obj(v)
  const handle = typeof x.handle === 'string' && HANDLE_RE.test(x.handle) ? x.handle : fail()
  const kind = oneOf(x.kind, KINDS)
  // Only where a step can fail by itself; anywhere else the key is dropped, not refused.
  if (x.onFailure !== undefined && x.onFailure !== null && x.onFailure !== 'branch') fail()
  const onFailure = x.onFailure === 'branch' && FAILING_KINDS.includes(kind) ? { onFailure: 'branch' as const } : {}
  const base = { id: id(x.id), handle, name: text(x.name, NAME_MAX), x: num(x.x), y: num(x.y), ...onFailure }
  switch (kind) {
    case 'trigger':
      return { ...base, kind: 'trigger' }
    case 'agent': {
      const model = optOneOf(x.model, MODELS) // absent: the agent's own
      const prompt = text(x.prompt, SAVED_TEXT_MAX)
      return {
        ...base,
        kind: 'agent',
        agent: text(x.agent, NAME_MAX),
        prompt,
        cwd: text(x.cwd, PATH_MAX),
        ...(model ? { model } : {}),
        ...parseKeep(x),
        ...parseCommand(x.command, prompt)
      }
    }
    // An empty room is a half-made step (a problem); any other value must be an id.
    case 'room': {
      const room = x.room === undefined || x.room === '' ? '' : id(x.room)
      const rules = x.rules === undefined || x.rules === null ? [] : parseRules(x.rules)
      const prompt = text(x.prompt, SAVED_TEXT_MAX)
      const kept = parseKeep(x)
      // Only a kept room is in the sidebar, so only it has a section.
      const section = kept.keep && typeof x.section === 'string' && x.section ? { section: id(x.section) } : {}
      // Built from agents: no template, so room is '' and any other value is refused; fewer than two is problemsOf's.
      const agents =
        x.members === undefined || x.members === null
          ? {}
          : { members: members(x.members), role: text(x.role ?? '', ROLE_MAX_CHARS), cwd: text(x.cwd ?? '', PATH_MAX) }
      if (agents.members && (room !== '' || new Set(agents.members).size !== agents.members.length)) fail()
      return {
        ...base,
        kind: 'room',
        room,
        prompt,
        ...(rules.length ? { rules } : {}),
        ...kept,
        ...section,
        ...parseCommand(x.command, prompt),
        ...agents
      }
    }
    // Same keys as an agent step: it runs one agent per item.
    case 'foreach': {
      const model = optOneOf(x.model, MODELS)
      // Any finite number is kept within 1 to 3; only 2 and 3 are stored, so one at a time stays the absent key.
      const concurrency = x.concurrency === undefined || x.concurrency === null ? {} : concurrencyKey(num(x.concurrency))
      const prompt = text(x.prompt, SAVED_TEXT_MAX)
      return {
        ...base,
        kind: 'foreach',
        agent: text(x.agent, NAME_MAX),
        prompt,
        cwd: text(x.cwd, PATH_MAX),
        ...(model ? { model } : {}),
        ...concurrency,
        ...parseCommand(x.command, prompt)
      }
    }
    case 'llm': {
      const system = optText(x.system, SAVED_TEXT_MAX)
      const effort = optOneOf(x.effort, EFFORTS)
      return {
        ...base,
        kind: 'llm',
        prompt: text(x.prompt, SAVED_TEXT_MAX),
        model: optOneOf(x.model, MODELS) ?? 'haiku',
        ...(system !== undefined ? { system } : {}),
        ...(effort ? { effort } : {})
      }
    }
    case 'condition':
      return { ...base, kind: 'condition', question: text(x.question, SAVED_TEXT_MAX), model: optOneOf(x.model, MODELS) ?? 'haiku' }
    case 'approval': {
      const editable = x.editable === undefined ? true : typeof x.editable === 'boolean' ? x.editable : fail()
      return { ...base, kind: 'approval', question: text(x.question, SAVED_TEXT_MAX), editable }
    }
    // Any finite number: outside 1 to 1440 is a problem the editor shows, not a refusal.
    case 'wait':
      return { ...base, kind: 'wait', minutes: num(x.minutes) }
    case 'notify': {
      const body = optText(x.body, SAVED_TEXT_MAX)
      return { ...base, kind: 'notify', title: text(x.title, SAVED_TEXT_MAX), ...(body !== undefined ? { body } : {}) }
    }
    // Header names and the address's origin are problems, not refusals: a half-typed header still saves.
    case 'http': {
      const headers = list(x.headers ?? []).map((h) => {
        const o = obj(h)
        return { name: text(o.name, HEADER_NAME_MAX), value: text(o.value, HEADER_VALUE_MAX) }
      })
      if (headers.length > HTTP_HEADERS_MAX) fail()
      const body = optText(x.body, SAVED_TEXT_MAX)
      const key = x.key === undefined || x.key === null || x.key === '' ? undefined : id(x.key)
      return {
        ...base,
        kind: 'http',
        method: optOneOf(x.method, HTTP_METHODS) ?? 'GET',
        url: text(x.url, URL_MAX),
        headers,
        ...(body !== undefined ? { body } : {}),
        bodyType: optOneOf(x.bodyType, ['json', 'text'] as const) ?? 'json',
        ...(key ? { key } : {}),
        // Only true is stored: absent is the safe default, and an older saved step reads the same.
        ...(x.allowLocalNetwork === true ? { allowLocalNetwork: true as const } : {})
      }
    }
    case 'transform': {
      const fields = list(x.fields ?? []).map((f) => {
        const o = obj(f)
        return { name: text(o.name, TRANSFORM_NAME_MAX), path: text(o.path, TRANSFORM_PATH_MAX) }
      })
      if (fields.length > TRANSFORM_FIELDS_MAX) fail()
      return { ...base, kind: 'transform', fields, format: optOneOf(x.format, ['json', 'lines'] as const) ?? 'json' }
    }
    // An empty workflow is a half-made step (a problem); any other value must be an id.
    case 'workflow': {
      const workflow = x.workflow === undefined || x.workflow === '' ? '' : id(x.workflow)
      return { ...base, kind: 'workflow', workflow, input: text(x.input ?? '', SAVED_TEXT_MAX) }
    }
    // An empty chat is a half-made step (a problem); any other value must be an id. Only 'fresh' is a session policy.
    case 'chat': {
      const chat = x.chat === undefined || x.chat === '' ? '' : id(x.chat)
      const prompt = text(x.prompt, SAVED_TEXT_MAX)
      return {
        ...base,
        kind: 'chat',
        chat,
        prompt,
        ...(x.session === 'fresh' ? { session: 'fresh' as const } : {}),
        ...parseCommand(x.command, prompt)
      }
    }
  }
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n))
const noteColor = (v: unknown): NoteColor => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 7) return v as NoteColor
  // Stored lower case, so two spellings of one color are one value.
  if (typeof v === 'string' && NOTE_HEX_RE.test(v.toLowerCase())) return v.toLowerCase() as NoteColor
  return fail()
}

// Rebuilt key by key, like a step; a size out of range is clamped, not refused, since a drag can overshoot.
export function parseNote(v: unknown): Note {
  const x = obj(v)
  return {
    id: id(x.id),
    x: num(x.x),
    y: num(x.y),
    width: clamp(num(x.width), NOTE_MIN.width, NOTE_MAX_SIDE),
    height: clamp(num(x.height), NOTE_MIN.height, NOTE_MAX_SIDE),
    color: noteColor(x.color),
    text: text(x.text, NOTE_TEXT_MAX)
  }
}

// Rebuilt key by key; shape only, since whether the members exist is parseWorkflowInput's to check. The chain rules are
// not checked here either: a group breaking them is dropped on save, never a refusal.
export function parseGroup(v: unknown): CanvasGroup {
  const x = obj(v)
  // The cap is on the name as stored, so a trailing space typed in the editor never refuses the whole workflow.
  const name = typeof x.name === 'string' ? x.name.trim() : fail()
  if (!name || name.length > GROUP_NAME_MAX) fail()
  // A blank description is none, as the editor's clear removes the key: one stored shape for "no description". Blank
  // is checked before the cap, so a run of spaces past it is still none, not a refusal.
  const raw = x.description === undefined || x.description === null ? '' : typeof x.description === 'string' ? x.description : fail()
  const description = raw.trim() === '' ? undefined : text(raw, GROUP_DESCRIPTION_MAX)
  return { id: id(x.id), name, ...(description !== undefined ? { description } : {}), steps: members(x.steps), notes: members(x.notes) }
}

/** Edges checked against the steps they join (by id): known ends, a port the source has (stepPorts), no repeated id. */
export function parseEdges(v: unknown, steps: Map<string, Pick<Step, 'kind'> & { onFailure?: 'branch' }>): Edge[] {
  const edges = list(v).map((e): Edge => {
    const o = obj(e)
    const from = id(o.from),
      to = id(o.to)
    const source = steps.get(from) ?? fail()
    if (!steps.has(to)) fail()
    const port = oneOf<Port>(o.port, stepPorts(source))
    return { id: id(o.id), from, port, to }
  })
  if (new Set(edges.map((e) => e.id)).size !== edges.length) fail()
  return edges
}

/**
 * The workflow the editor sends, checked deeply. A half-drawn graph passes (problemsOf says what keeps it from
 * running); what the engine could trip on does not: an unknown kind or port, a bad or repeated id, an edge to no step,
 * a number that is not finite. Throws `Invalid workflow`.
 */
export function parseWorkflowInput(v: unknown): WorkflowInput {
  const x = obj(v)
  const wid = x.id === null ? null : id(x.id)
  const name = text(x.name, NAME_MAX)
  if (!name.trim()) fail()
  const enabled = typeof x.enabled === 'boolean' ? x.enabled : fail()
  const timeZone = typeof x.timeZone === 'string' && isTimeZone(x.timeZone) ? x.timeZone : fail()
  const steps = list(x.steps).map(parseStep)
  const kinds = new Map(steps.map((s) => [s.id, s.kind]))
  if (kinds.size !== steps.length) fail()
  const notes = list(x.notes ?? []).map(parseNote)
  if (notes.length > NOTES_MAX) fail()
  // One id space with the steps: React Flow keys steps and notes together.
  if (new Set([...steps.map((s) => s.id), ...notes.map((n) => n.id)]).size !== steps.length + notes.length) fail()
  const groups = list(x.groups ?? []).map(parseGroup)
  if (groups.length > GROUPS_MAX) fail()
  // A group's id is in the same space as the steps and notes it holds.
  if (
    new Set([...steps.map((s) => s.id), ...notes.map((n) => n.id), ...groups.map((g) => g.id)]).size !==
    steps.length + notes.length + groups.length
  )
    fail()
  const noteIds = new Set(notes.map((n) => n.id)),
    taken = new Set<string>()
  for (const g of groups) {
    for (const m of [...g.steps, ...g.notes]) {
      if (taken.has(m)) fail()
      taken.add(m)
    }
    if (g.steps.some((m) => kinds.get(m) === undefined || kinds.get(m) === 'trigger') || g.notes.some((m) => !noteIds.has(m))) fail()
  }
  const edges = parseEdges(x.edges, new Map(steps.map((s) => [s.id, s])))
  // Absent or null: no cap.
  const spendCap = x.spendCap === undefined || x.spendCap === null ? null : (parseSpendCap(x.spendCap) ?? fail())
  // A wrong value is dropped, not refused: only 'skip' is stored, so an older saved version still compares equal.
  return {
    id: wid,
    name,
    enabled,
    timeZone,
    trigger: parseTrigger(x.trigger),
    steps,
    edges,
    notes,
    groups,
    ...(spendCap !== null ? { spendCap } : {}),
    ...(x.limitPolicy === 'skip' ? { limitPolicy: 'skip' as const } : {}),
    ...(x.missedPolicy === 'skip' ? { missedPolicy: 'skip' as const } : {})
  }
}
