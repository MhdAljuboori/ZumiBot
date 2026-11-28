import { wallClock, zonedToUtc } from './schedule'

export const LATER_NAME = 'later'
export const LATER_DESCRIPTION = 'Send a message into this chat at a set time: /later 9am check CI'
export const LATER_MAX = 10
export const LATER_MAX_MS = 30 * 86_400_000

/** A message the user wrote with `/later`, waiting on the chat to go in at `at` (epoch ms) as if typed then. */
export interface LaterSend {
  id: string
  at: number
  text: string
  createdAt: number
}

export const LATER_ERRORS = {
  noTime: 'Say when first: 9am, 21:30, in 2h or tomorrow 9am',
  badTime: 'That is not a time of day',
  passed: 'That time has already passed today',
  noMessage: 'Write the message after the time',
  tooFar: 'A /later message can be at most 30 days ahead'
} as const

export const laterFullText = `A chat can hold at most ${LATER_MAX} /later messages`
export const LATER_GONE = 'That message was already sent or cancelled'
export const LATER_NESTED = 'A /later message cannot start with /later, /btw or /run-workflow'

// The commands the composer routes away from the agent: inside a /later they would reach it as plain text.
const ROUTED = /^\/(?:later|btw|run-workflow)(?=\s|$)/

/** Whether the message would start with a command the agent never sees as one. */
export const laterNests = (text: string): boolean => ROUTED.test(text.trimStart())

// Same boundary rule as /btw: `/laterx` is another command's name.
const LEAD = new RegExp(`^/${LATER_NAME}(?=\\s|$)`)

/** What follows a leading `/later` (trimmed). Null when the text is not that command. */
export function laterRest(text: string): string | null {
  const m = LEAD.exec(text)
  return m ? text.slice(m[0].length).trim() : null
}

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 }
const DURATION = /^in\s+((?:\d+\s*(?:minutes?|mins?|m|hours?|hrs?|h|days?|d)(?![a-z])\s*)+)/i
const PIECE = /(\d+)\s*([mhd])/gi

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6
}
type Day = 'today' | 'tomorrow' | number

function dayWord(word: string): Day | null {
  const w = word.toLowerCase()
  if (w === 'today' || w === 'tomorrow') return w
  return WEEKDAYS[w] ?? null
}

const LEAD_DAY = /^([a-z]+)\s+/i
const TRAIL_DAY = /^\s+([a-z]+)(?=\s|$)/i
const CLOCK = /^(?:(noon|midnight)|(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)(?=\s|$)/i

/** The clock time a match names, null for no time at all (a bare number), or 'bad' for one out of range. */
function clockOf(m: RegExpExecArray): { h: number; mi: number } | null | 'bad' {
  if (m[1]) return m[1].toLowerCase() === 'noon' ? { h: 12, mi: 0 } : { h: 0, mi: 0 }
  const h = Number(m[2])
  const mi = m[3] === undefined ? 0 : Number(m[3])
  const half = m[4]?.toLowerCase()
  // `9` alone could be a count as easily as a time: only `9am` or `09:00` is read as one.
  if (half === undefined && m[3] === undefined) return null
  if (mi > 59) return 'bad'
  if (half === undefined) return h > 23 ? 'bad' : { h, mi }
  if (h < 1 || h > 12) return 'bad'
  return { h: (h % 12) + (half === 'pm' ? 12 : 0), mi }
}

/** When `rest` (what follows `/later`) asks the message to go, read in `timeZone`, and the message itself. */
export function parseLater(rest: string, now: number, timeZone: string): { at: number; text: string } | { error: string } {
  const src = rest.trimStart()
  let at: number
  let tail: string
  const dur = DURATION.exec(src)
  if (dur) {
    tail = src.slice(dur[0].length)
    // `in 2h3` stops at the `3`: the duration must end at whitespace.
    if (tail !== '' && !/\s$/.test(dur[0])) return { error: LATER_ERRORS.noTime }
    let ms = 0
    for (const p of dur[1]!.matchAll(PIECE)) ms += Number(p[1]) * UNIT_MS[p[2]!.toLowerCase()]!
    if (ms <= 0) return { error: LATER_ERRORS.noTime }
    at = now + ms
  } else {
    let day: Day | null = null
    let s = src
    const lead = LEAD_DAY.exec(s)
    if (lead && dayWord(lead[1]!) !== null) {
      day = dayWord(lead[1]!)
      s = s.slice(lead[0].length)
    }
    const m = CLOCK.exec(s)
    if (!m) return { error: LATER_ERRORS.noTime }
    const clock = clockOf(m)
    if (clock === null) return { error: LATER_ERRORS.noTime }
    if (clock === 'bad') return { error: LATER_ERRORS.badTime }
    s = s.slice(m[0].length)
    if (day === null) {
      const trail = TRAIL_DAY.exec(s)
      if (trail && dayWord(trail[1]!) !== null) {
        day = dayWord(trail[1]!)
        s = s.slice(trail[0].length)
      }
    }
    tail = s
    const w = wallClock(now, timeZone)
    const on = (k: number): number => {
      // Date.UTC rolls the day over months and years; the zone only matters for the minute itself.
      const d = new Date(Date.UTC(w.year, w.month - 1, w.day + k))
      return zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), clock.h, clock.mi, timeZone)
    }
    if (day === 'today') {
      at = on(0)
      if (at <= now) return { error: LATER_ERRORS.passed }
    } else if (day === 'tomorrow') {
      at = on(1)
    } else if (typeof day === 'number') {
      const k = (day - new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay() + 7) % 7
      at = on(k)
      if (at <= now) at = on(k + 7)
    } else {
      at = on(0)
      if (at <= now) at = on(1)
    }
  }
  const text = tail.trim()
  if (text === '') return { error: LATER_ERRORS.noMessage }
  if (at - now > LATER_MAX_MS) return { error: LATER_ERRORS.tooFar }
  return { at, text }
}
