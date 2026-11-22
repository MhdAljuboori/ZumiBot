import { elicitationAnswer, elicitationQuestions, mappableProperty, type ElicitationContent } from '../acp/acpElicitation'

// An AG-UI interrupt <-> ZumiBot's question card. Pure. An interrupt whose `responseSchema` maps as an ACP form does (once
// pruned, see `pruned`) becomes a card; its answers are the `resolved` payload. Anything else is `cancelled`: approval
// payloads are framework-specific, and guessing one could present a call as approved when it was not.

/** One interrupt of a `RUN_FINISHED` outcome, as the event mapper read it (absent fields left out). */
export interface AguiInterrupt {
  id: string
  reason: string
  message?: string
  toolCallId?: string
  responseSchema?: Record<string, unknown>
  expiresAt?: string
  metadata?: unknown
  subagentRunId?: string
}

export type AguiResumeEntry =
  { interruptId: string; status: 'resolved'; payload: ElicitationContent } | { interruptId: string; status: 'cancelled' }

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

// AG-UI alone (ACP's forms are read as they are): a schema with a required property is asked only that, so a Pydantic AI
// approval ({approved} required, `editedArgs` and `reason` optional) is a plain Yes/No and nothing the user did not choose
// is sent. One with none keeps the optional properties a card can show. A required one the card cannot show still leaves
// the form unmappable, and so does a form left with nothing. fromEntries and the spread define keys: `__proto__` is one.
function pruned(schema: Obj | undefined): Obj | undefined {
  if (schema === undefined || !isObj(schema.properties)) return schema
  const props = schema.properties
  const required = (Array.isArray(schema.required) ? schema.required : []).filter(
    (k): k is string => typeof k === 'string' && Object.hasOwn(props, k)
  )
  const keep = required.length > 0 ? ([k]: [string, unknown]) => required.includes(k) : ([, v]: [string, unknown]) => mappableProperty(v)
  return { ...schema, properties: Object.fromEntries(Object.entries(props).filter(keep)) }
}

// The interrupt as the ACP form the elicitation mapping reads, rebuilt (and pruned) both ways so the card and its answer
// read the same form, and nothing is remembered between them.
const formOf = (i: AguiInterrupt) => ({ mode: 'form', requestedSchema: pruned(i.responseSchema), message: i.message })

/** The AskUserQuestion input for the interrupt, or null when it has no schema the card can show (cancelled at once). */
export const interruptQuestions = (i: AguiInterrupt): ReturnType<typeof elicitationQuestions> => elicitationQuestions(formOf(i))

/** When `expiresAt` falls (epoch ms), or null: a value that is not a date never expires, as the schema notes. */
export function expiryOf(expiresAt: string | null | undefined): number | null {
  if (typeof expiresAt !== 'string') return null
  const t = Date.parse(expiresAt)
  return Number.isNaN(t) ? null : t
}

/** At or past its `expiresAt`. */
export function isExpired(i: { expiresAt?: string | null }, now: number): boolean {
  const t = expiryOf(i.expiresAt)
  return t !== null && t <= now
}

/**
 * The resume entry for the card's answer (`answer` is its control response, null when it never got one). Only an allow the
 * form accepts resolves; a skip, a stop, an error, a missing required answer or an expired interrupt is cancelled.
 */
export function resumeEntry(i: AguiInterrupt, answer: object | null, now: number): AguiResumeEntry {
  if (answer !== null && !isExpired(i, now)) {
    const a = elicitationAnswer(answer, formOf(i))
    if (a.action === 'accept') return { interruptId: i.id, status: 'resolved', payload: a.content }
  }
  return { interruptId: i.id, status: 'cancelled' }
}
