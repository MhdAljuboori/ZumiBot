import type { RoutineRun } from '@zumibot/shared/routines'
import { PLACEHOLDER_RE } from '@zumibot/shared/routineFields'
import { dayAt } from './limitNotice'

export type PromptPart = { type: 'text'; text: string } | { type: 'field'; path: string }

export function splitPrompt(text: string): PromptPart[] {
  const parts: PromptPart[] = []
  let at = 0
  // matchAll clones the global regex, so its lastIndex state is never shared.
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (m.index > at) parts.push({ type: 'text', text: text.slice(at, m.index) })
    parts.push({ type: 'field', path: m[1] })
    at = m.index + m[0].length
  }
  if (at < text.length) parts.push({ type: 'text', text: text.slice(at) })
  return parts
}

export function joinPrompt(parts: PromptPart[]): string {
  return parts.map((p) => (p.type === 'text' ? p.text : `{{${p.path}}}`)).join('')
}

export interface DocNode {
  type: string
  text?: string
  attrs?: { path: string }
  content?: DocNode[]
}

/** One paragraph per line; fields become inline chip nodes (or stay as text when `chips` is off). */
export function promptToDoc(text: string, chips = true): DocNode {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => {
      const content = (chips ? splitPrompt(line) : line === '' ? [] : [{ type: 'text' as const, text: line }]).map((p): DocNode =>
        p.type === 'text' ? { type: 'text', text: p.text } : { type: 'fieldChip', attrs: { path: p.path } }
      )
      return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' }
    })
  }
}

export function docToPrompt(doc: DocNode): string {
  return (doc.content ?? [])
    .map((para) =>
      joinPrompt(
        (para.content ?? []).map((n): PromptPart =>
          n.type === 'fieldChip' ? { type: 'field', path: n.attrs?.path ?? '' } : { type: 'text', text: n.text ?? '' }
        )
      )
    )
    .join('\n')
}

/** Where a field menu goes, as offsets from the field's box: `top` puts it under the caret's line, `bottom` over it. */
export interface MenuPlace {
  left: number
  top?: number
  bottom?: number
}

interface Rect {
  left: number
  top: number
  bottom: number
}

/**
 * The `{{` menu in a tall field (the expand dialog) follows the caret: under the field it would sit off screen.
 * It opens under the caret's line, or over it when the viewport has less room below than the menu needs and more
 * above, and never pokes out past the field's right edge.
 */
export function caretMenuPlace(
  caret: Rect,
  box: Rect & { width: number },
  viewHeight: number,
  menu = { width: 240, height: 228 },
  gap = 4
): MenuPlace {
  const left = Math.max(0, Math.min(caret.left - box.left, box.width - menu.width))
  const below = viewHeight - caret.bottom - gap
  const above = caret.top - gap
  if (below >= menu.height || below >= above) return { left, top: caret.bottom - box.top + gap }
  return { left, bottom: box.bottom - caret.top + gap }
}

const dayKey = (t: number, tz: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t)

/** `Today 07:00`, `Yesterday 07:00` or `Oct 25 07:00`, all in the routine's (or workflow's) zone. */
export function runLabel(run: Pick<RoutineRun, 'startedAt'>, now: number, timeZone: string): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(run.startedAt)
  const day = dayKey(run.startedAt, timeZone)
  if (day === dayKey(now, timeZone)) return `Today ${time}`
  if (day === dayKey(now - 86_400_000, timeZone)) return `Yesterday ${time}`
  const date = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(run.startedAt)
  return `${date} ${time}`
}

/** `manual` for a Run now run: off its schedule, it would otherwise read like the trigger fired at that time. */
export function viaLabel(run: RoutineRun): string | null {
  return run.via === 'manual' ? 'manual' : null
}

/** What the routine's limit or missed policy did to the run: waiting, skipped, or continued after a reset. */
export function policyLabel(run: RoutineRun, now: number, timeZone: string): string | null {
  if (run.status === 'limited' && run.resumeAt !== undefined) return `Usage limit reached · continues ${dayAt(run.resumeAt, now, timeZone)}`
  if (run.skipReason === 'missed') return 'Skipped: ZumiBot was off when it was due'
  if (run.skipReason === 'limit') return 'Skipped: the usage limit was reached'
  if (run.skipReason === 'cap') return `Skipped: ${run.error ?? 'an agent reached its daily spend cap'}`
  const waits = run.waits ?? 0
  if (waits === 1) return 'Continued after a usage limit reset'
  return waits > 1 ? `Continued after ${waits} usage limit resets` : null
}

/** Something the user paused: how to go on with it, or, once Resume carried it on, that it was paused. Null when never paused. */
export function pauseText(paused: boolean, resumes: number | undefined): string | null {
  if (paused) return 'Paused by you · press Resume in its chat to continue'
  const n = resumes ?? 0
  if (n === 1) return 'Resumed after a pause'
  return n > 1 ? `Resumed after ${n} pauses` : null
}

/** A routine run the user paused, or one Resume carried on. */
export const pauseLabel = (run: RoutineRun): string | null =>
  run.status === 'paused' && run.capped
    ? 'Paused at its spend cap · press Resume in its chat to continue'
    : pauseText(run.status === 'paused', run.resumes)

const pct = (p: number | undefined): string => `${Math.round((p ?? 0) * 100)}%`

/** What Jev found when it checked a webhook call against the routine's condition. Null when it did not check. */
export function conditionLabel(run: RoutineRun): string | null {
  const c = run.condition
  if (!c) return null
  if (c.met === null) return 'Condition not checked: Jev did not answer, so the run went ahead'
  return c.met ? `Condition met (Jev: ${pct(c.p)} likely)` : `Condition not met (Jev: ${pct(c.p)} likely), so no chat was made`
}

/** `Missing: body.title, body.author`: the fields a webhook call lacked, which went in as empty text. Null when none. */
export function missingLabel(run: RoutineRun): string | null {
  const fields = run.missingFields ?? []
  return fields.length > 0 ? `Missing: ${fields.join(', ')}` : null
}
