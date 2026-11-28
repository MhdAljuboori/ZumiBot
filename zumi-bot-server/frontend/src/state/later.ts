// The composer's `/later` line: when the message would go, read as the server will read it (docs/architecture/agent-commands.md, /later).
import { LATER_ERRORS, LATER_NESTED, laterNests, laterRest, parseLater } from '@zumibot/shared/later'
import { dayAt } from './limitNotice'

/** The browser's zone: the server reads the time in it, since a VPS may run in another. */
export const browserZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

export const LATER_HINT = 'Say when, then the message: /later 9am check CI'

/** What the line under the box says while the text is a `/later`: when it goes, or why it cannot. Null for any other text. */
export function laterPreview(text: string, now: number, timeZone: string): { text: string; error: boolean } | null {
  const rest = laterRest(text)
  if (rest === null) return null
  // Just typed: a hint, not yet a mistake.
  if (rest === '') return { text: LATER_HINT, error: false }
  const r = parseLater(rest, now, timeZone)
  if ('error' in r) return { text: r.error, error: true }
  if (laterNests(r.text)) return { text: LATER_NESTED, error: true }
  return { text: `Sends ${dayAt(r.at, now, timeZone)}`, error: false }
}

/** Why Send must not go with this `/later` (shown as the box's notice), else null; null for any other text too. */
export function laterSendError(text: string, now: number, timeZone: string): string | null {
  const p = laterPreview(text, now, timeZone)
  if (p === null) return null
  if (p.error) return p.text
  return laterRest(text) === '' ? LATER_ERRORS.noTime : null
}
