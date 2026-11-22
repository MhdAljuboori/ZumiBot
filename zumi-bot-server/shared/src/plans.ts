import { displayName } from './frontmatter'

/** The CLI's tool name; its can_use_tool request carries the plan (read from the plan file) as `input.plan`. */
export const PLAN_TOOL = 'ExitPlanMode'

/** Matches the question card's text box cap. */
export const FEEDBACK_MAX_CHARS = 8192

export interface ParsedPlan {
  plan: string | null
  planFilePath: string | null
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)

/** Never throws: the input comes straight from JSON, and the card must still render without a plan. */
export function parsePlan(input: unknown): ParsedPlan {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { plan: null, planFilePath: null }
  const o = input as Record<string, unknown>
  return { plan: text(o.plan), planFilePath: text(o.planFilePath) }
}

/** Optional feedback of a "Keep planning" answer: trimmed text, or null for none. Throws TypeError before anything is sent. */
export function checkFeedback(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new TypeError('feedback must be a string')
  if (v.length > FEEDBACK_MAX_CHARS) throw new TypeError(`feedback must be at most ${FEEDBACK_MAX_CHARS} chars`)
  const t = v.trim()
  return t === '' ? null : t
}

/** The card's heading, also the group tray row's text for a pending plan. `agent` is null for a single chat's card. */
export function planHeading(agent: string | null): string {
  return agent ? `Plan from ${displayName(agent)}` : 'Plan for your approval'
}
