import type { Edge, Step, Workflow } from './workflows'
import {
  NOTIFY_INBOX_BODY_MAX,
  NOTIFY_TITLE_MAX,
  PICK_CHAT,
  PICK_MEMBERS,
  PROMPT_MAX,
  TRANSFORM_NAME_MAX,
  WAIT_MAX,
  WAIT_MIN,
  failsBranch,
  roomFromAgents,
  spaced
} from './workflows'
import { HEADER_VALUE_MAX, URL_MAX, httpProblems } from './workflowHttp'
import { parsePath } from './workflowTransform'

export interface Problem {
  stepId: string | null
  text: string
}

/** Ids reachable by following edges from `from`, the start ids included. Loops are fine: each id is visited once. */
export function reachableFrom(edges: Edge[], from: string[]): Set<string> {
  const seen = new Set(from)
  const todo = [...from]
  while (todo.length) {
    const id = todo.pop()!
    for (const e of edges)
      if (e.from === id && !seen.has(e.to)) {
        seen.add(e.to)
        todo.push(e.to)
      }
  }
  return seen
}

/** A handle for a step name: lowercase, [a-z0-9-], at most 32 characters, -2, -3... on a clash. */
export function handleFor(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32)
      .replace(/-+$/, '') || 'step'
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const h = base.slice(0, 32 - suffix.length).replace(/-+$/, '') + suffix
    if (!taken.has(h)) return h
  }
}

/** The handles a text names with {{steps.<handle>.output}}, in order, without repeats. */
export function stepHandles(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\{\{\s*steps\.([^.\s}]+)\.output\s*\}\}/g)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `text` with every {{steps.<old>.output}} naming `handle` instead, whitespace inside the braces kept as typed. */
export function renameHandle(text: string, old: string, handle: string): string {
  const re = new RegExp(`\\{\\{(\\s*)steps\\.${escapeRe(old)}\\.output(\\s*)\\}\\}`, 'g')
  return text.replace(re, (_m, a: string, b: string) => `{{${a}steps.${handle}.output${b}}}`)
}

export const USE_ITEM_TEXT = 'Use {{item}} in the prompt'
export const FAILURE_PATH_TEXT = 'Connect the failure path, or set On failure to Stop the run'
export const SELF_TEXT = "A workflow can't run itself"

// The template fields of a step, with the label its length problem uses.
function textFields(s: Step): { label: string; text: string; max: number }[] {
  switch (s.kind) {
    case 'agent':
    case 'room':
    case 'chat':
    case 'foreach':
      return [{ label: 'Prompt', text: s.prompt, max: PROMPT_MAX }]
    case 'llm':
      return [
        { label: 'Prompt', text: s.prompt, max: PROMPT_MAX },
        { label: 'System prompt', text: s.system ?? '', max: PROMPT_MAX }
      ]
    case 'condition':
    case 'approval':
      return [{ label: 'Question', text: s.question, max: PROMPT_MAX }]
    case 'notify':
      return [
        { label: 'Title', text: s.title, max: NOTIFY_TITLE_MAX },
        { label: 'Body', text: s.body ?? '', max: NOTIFY_INBOX_BODY_MAX }
      ]
    case 'http':
      return [
        { label: 'Address', text: s.url, max: URL_MAX },
        { label: 'Body', text: s.body ?? '', max: PROMPT_MAX },
        ...s.headers.map((h) => ({ label: `The ${h.name.trim() || 'unnamed'} header`, text: h.value, max: HEADER_VALUE_MAX }))
      ]
    case 'workflow':
      return [{ label: 'Input', text: s.input, max: PROMPT_MAX }]
    default:
      return []
  }
}

// A Transform step's own problems: at least one field, each named once, each path one parsePath reads.
function transformProblems(s: Extract<Step, { kind: 'transform' }>): string[] {
  const out: string[] = []
  if (s.fields.length === 0) out.push('Add a field to pick')
  if (s.fields.some((f) => !f.name.trim())) out.push('Every field needs a name')
  if (s.fields.some((f) => f.name.length > TRANSFORM_NAME_MAX)) out.push(`A field name is over ${TRANSFORM_NAME_MAX} characters`)
  const names = s.fields.map((f) => f.name.trim())
  if (new Set(names).size !== names.length) out.push('Two fields have the same name')
  const bad = s.fields.find((f) => parsePath(f.path) === null)
  if (bad) out.push(`"${bad.path.slice(0, 40)}" is not a path`)
  return out
}

/**
 * What stops a workflow from being saved as enabled. One problem per step per rule; folder existence, a sub-workflow's
 * existence and a vault key's are the server's checks. `id`: the workflow's own, so a step can't name it.
 */
export function problemsOf(
  w: Pick<Workflow, 'trigger' | 'steps' | 'edges'> & { id?: string | null },
  agents: { name: string; error: string | null }[],
  zumiBot: string
): Problem[] {
  const out: Problem[] = []
  const triggers = w.steps.filter((s) => s.kind === 'trigger')
  if (triggers.length !== 1) out.push({ stepId: null, text: 'A workflow needs exactly one trigger' })
  const triggerIds = new Set(triggers.map((t) => t.id))
  const reach = triggers.length === 1 ? reachableFrom(w.edges, [triggers[0].id]) : null
  const handles = new Set(w.steps.map((s) => s.handle))
  const handleCount = new Map<string, number>()
  for (const s of w.steps) handleCount.set(s.handle, (handleCount.get(s.handle) ?? 0) + 1)

  for (const s of w.steps) {
    const add = (text: string) => out.push({ stepId: s.id, text })
    if (triggerIds.has(s.id) && w.edges.some((e) => e.to === s.id)) add('Nothing can lead into the trigger')
    if (reach && s.kind !== 'trigger' && !reach.has(s.id)) add('No path from the trigger reaches this step')
    if ((handleCount.get(s.handle) ?? 0) > 1) add('Another step has this handle')

    // A room built from agents has no template to pick; a chat's own checks (it exists, is a chat a workflow may post to) are the server's.
    if (s.kind === 'room' && !roomFromAgents(s) && !s.room) add('Pick a room')
    if (s.kind === 'chat' && !s.chat) add(PICK_CHAT)
    // The one agent rule, for an agent or For each step's agent and for each member of a room built from agents.
    const judge = (name: string) => {
      const a = agents.find((x) => x.name === name)
      if (!name) add('Pick an agent')
      else if (name === zumiBot) add('Zumi Bot cannot be a workflow step')
      else if (!a) add(`Agent "${name}" not found`)
      else if (a.error) add(`Agent "${name}" has an error`)
    }
    if (s.kind === 'agent' || s.kind === 'foreach') judge(s.agent)
    if (s.kind === 'room' && roomFromAgents(s)) {
      if (s.members.length < 2) add(PICK_MEMBERS)
      for (const m of s.members) judge(m)
    }
    if (s.kind === 'agent' || s.kind === 'room' || s.kind === 'chat' || s.kind === 'foreach' || s.kind === 'llm') {
      if (!s.prompt.trim()) add('Write a prompt')
    }
    // Without {{item}} every pass would send the same text.
    if (s.kind === 'foreach' && s.prompt.trim() && !/\{\{\s*item\s*\}\}/.test(s.prompt)) add(USE_ITEM_TEXT)
    if (s.kind === 'condition' || s.kind === 'approval') {
      if (!s.question.trim()) add('Write a question')
    }
    if (s.kind === 'notify') {
      if (!s.title.trim()) add('Write a title')
    }
    if (s.kind === 'wait' && !(Number.isInteger(s.minutes) && s.minutes >= WAIT_MIN && s.minutes <= WAIT_MAX)) {
      add(`Wait between ${WAIT_MIN} and ${WAIT_MAX} minutes`)
    }
    if (s.kind === 'http') for (const p of httpProblems(s)) add(p)
    if (s.kind === 'transform') for (const p of transformProblems(s)) add(p)
    if (s.kind === 'workflow') {
      if (!s.workflow) add('Pick a workflow')
      else if (w.id && s.workflow === w.id) add(SELF_TEXT)
    }
    // The setting asks for a path, so one with nothing on it is half drawn.
    if (failsBranch(s) && !w.edges.some((e) => e.from === s.id && e.port === 'error')) add(FAILURE_PATH_TEXT)

    for (const f of textFields(s)) {
      if (f.text.length > f.max) add(`${f.label} is over ${spaced(f.max)} characters`)
    }
    const unknown = textFields(s)
      .flatMap((f) => stepHandles(f.text))
      .find((h) => !handles.has(h))
    if (unknown !== undefined) add(`No step has the handle "${unknown}"`)
  }
  return out
}
