import { ACP_YES_NO } from '@zumibot/shared/acp'

// ACP's `elicitation/create` (form mode) <-> ZumiBot's AskUserQuestion card. Pure.
// The card answers by question text; ACP wants the schema's own property names and value types. The questions are
// derived from the request's params both ways, so nothing has to be remembered between the card and the answer.

export type ElicitationContent = Record<string, string | number | boolean | string[]>
export type ElicitationAnswer = { action: 'accept'; content: ElicitationContent } | { action: 'decline' } | { action: 'cancel' }

type Obj = Record<string, any>
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const blank = (s: string): boolean => s.trim() === ''

interface Choice {
  label: string
  value: string
}
type Shape =
  | { type: 'choice'; choices: Choice[] }
  | { type: 'boolean' }
  | { type: 'multi'; choices: Choice[] }
  | { type: 'text' }
  | { type: 'number'; integer: boolean; min: number | null; max: number | null; def: number | null }
interface Field {
  key: string
  text: string
  description: string | null
  required: boolean
  shape: Shape
}

// enum (with the legacy enumNames), or oneOf / anyOf of {const, title}. null when there is no usable list.
function choicesOf(s: Obj): Choice[] | null {
  if (Array.isArray(s.enum)) {
    if (s.enum.length === 0 || !s.enum.every((v: unknown) => typeof v === 'string')) return null
    const names = Array.isArray(s.enumNames) ? s.enumNames : []
    return s.enum.map((v: string, i: number) => ({ value: v, label: typeof names[i] === 'string' && !blank(names[i]) ? names[i] : v }))
  }
  const alts = Array.isArray(s.oneOf) ? s.oneOf : Array.isArray(s.anyOf) ? s.anyOf : null
  if (!alts || alts.length === 0) return null
  const out: Choice[] = []
  for (const a of alts) {
    const o = obj(a)
    const value = str(o?.const)
    if (value === null) return null
    out.push({ value, label: str(o?.title) && !blank(o!.title) ? o!.title : value })
  }
  return out
}

function shapeOf(s: Obj): Shape | null {
  if (s.type === 'string') {
    const choices = choicesOf(s)
    if (choices) return { type: 'choice', choices }
    return s.enum !== undefined || s.oneOf !== undefined || s.anyOf !== undefined ? null : { type: 'text' }
  }
  if (s.type === 'boolean') return { type: 'boolean' }
  if (s.type === 'number' || s.type === 'integer')
    return { type: 'number', integer: s.type === 'integer', min: num(s.minimum), max: num(s.maximum), def: num(s.default) }
  if (s.type === 'array') {
    const items = obj(s.items)
    const choices = items ? choicesOf(items) : null
    return choices ? { type: 'multi', choices } : null
  }
  return null // nested objects and anything else
}

/** Whether the card can show one property of a form's schema (AG-UI prunes optional ones it cannot). */
export const mappableProperty = (s: unknown): boolean => {
  const o = obj(s)
  return o !== null && shapeOf(o) !== null
}

// One field per property, or null when the form is not one the card can show.
function fieldsOf(params: unknown): Field[] | null {
  const p = obj(params)
  if (p?.mode !== 'form') return null
  const schema = obj(p.requestedSchema)
  const props = obj(schema?.properties)
  if (!props) return null
  const required = new Set(Array.isArray(schema!.required) ? schema!.required.filter((r: unknown) => typeof r === 'string') : [])
  const fields: Field[] = []
  const texts = new Set<string>()
  for (const key of Object.keys(props)) {
    const s = obj(props[key])
    const shape = s ? shapeOf(s) : null
    if (!s || !shape) return null
    // The question text is the answer's key, so it must be non-blank and unique: the property name stands in otherwise.
    const title = str(s.title)
    let text = title !== null && !blank(title) ? title : key
    if (texts.has(text)) text = `${text} (${key})`
    if (texts.has(text)) return null
    texts.add(text)
    fields.push({ key, text, description: str(s.description), required: required.has(key), shape })
  }
  return fields.length ? fields : null
}

/** The AskUserQuestion input for a form request, or null when the form does not map (the caller declines at once). */
export function elicitationQuestions(params: unknown): { title?: string; questions: Obj[] } | null {
  const fields = fieldsOf(params)
  if (!fields) return null
  const message = str(obj(params)!.message)
  const questions = fields.map((f) => {
    const base = { question: f.text, header: '', description: f.description }
    switch (f.shape.type) {
      case 'choice':
      case 'multi':
        return { ...base, kind: 'choice', multiSelect: f.shape.type === 'multi', options: f.shape.choices.map((c) => ({ label: c.label })) }
      case 'boolean':
        return { ...base, kind: 'choice', multiSelect: false, options: [{ label: ACP_YES_NO.yes }, { label: ACP_YES_NO.no }] }
      case 'text':
        return { ...base, kind: 'text' }
      case 'number': {
        const n = f.shape
        return { ...base, kind: 'number', min: n.min, max: n.max, step: n.integer ? 1 : null, defaultValue: n.def }
      }
    }
  })
  return { ...(message !== null && !blank(message) ? { title: message.slice(0, 500) } : {}), questions }
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((a): a is string => typeof a === 'string' && !blank(a))

function valueOf(f: Field, given: unknown): string | number | boolean | string[] | undefined {
  const s = f.shape
  if (s.type === 'multi') {
    // Only the schema's own values go back: one pick off the list makes the whole answer unusable.
    const picks = asList(given).map((a) => s.choices.find((c) => c.label === a)?.value)
    return picks.length && picks.every((v): v is string => v !== undefined) ? picks : undefined
  }
  if (typeof given !== 'string' || blank(given)) return undefined
  switch (s.type) {
    case 'choice':
      return s.choices.find((c) => c.label === given)?.value
    case 'boolean':
      return given === ACP_YES_NO.yes ? true : given === ACP_YES_NO.no ? false : undefined
    case 'text':
      return given
    case 'number': {
      const n = Number(given)
      return Number.isFinite(n) && (!s.integer || Number.isInteger(n)) && (s.min === null || n >= s.min) && (s.max === null || n <= s.max)
        ? n
        : undefined
    }
  }
}

/**
 * ZumiBot's answer to the card as ACP's. Allow accepts with the answers (decline when a required one is missing),
 * Skip (deny) declines, and Stop, an error or anything else cancels: only an explicit allow ever accepts.
 */
export function elicitationAnswer(controlResponse: object, params: unknown): ElicitationAnswer {
  const r = obj(obj(controlResponse)?.response)
  const behavior = r?.subtype === 'success' ? obj(r.response)?.behavior : undefined
  if (behavior === 'deny') return { action: 'decline' }
  if (behavior !== 'allow') return { action: 'cancel' }
  const fields = fieldsOf(params)
  if (!fields) return { action: 'decline' }
  const given = obj(obj(obj(r!.response)?.updatedInput)?.answers) ?? {}
  // No prototype: a property may be named __proto__, and assigning to it would set the prototype instead.
  const content: ElicitationContent = Object.create(null)
  for (const f of fields) {
    // Only the form's own questions are read; an answer for any other name is never sent.
    const v = Object.hasOwn(given, f.text) ? valueOf(f, given[f.text]) : undefined
    if (v !== undefined) content[f.key] = v
    else if (f.required) return { action: 'decline' }
  }
  return { action: 'accept', content }
}
