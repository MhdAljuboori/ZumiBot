import type { Schedule } from './routines'

export interface CronSpec {
  minutes: number[]
  hours: number[]
  doms: number[]
  months: number[]
  dows: number[]
  domStar: boolean
  dowStar: boolean
  lastDay?: boolean
}

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
    formatters.set(tz, f)
  }
  return f
}
export function isTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || !tz) return false
  try {
    formatter(tz)
    return true
  } catch {
    return false
  }
}
/** The wall clock in `tz` at `ts`. */
export function wallClock(ts: number, tz: string) {
  const p = Object.fromEntries(
    formatter(tz)
      .formatToParts(ts)
      .map((x) => [x.type, x.value])
  )
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second }
}
function offsetAt(ts: number, tz: string): number {
  const p = wallClock(ts, tz)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000
}
/** The instant of a wall-clock minute in `tz`; a minute a DST gap skips gives the gap's first valid minute. */
export function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const offsets = new Set([-86_400_000, 0, 86_400_000].map((delta) => offsetAt(guess + delta, tz)))
  const candidates = [...offsets].map((offset) => guess - offset).sort((a, b) => a - b)
  const matches = candidates.filter((t) => {
    const p = wallClock(t, tz)
    return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi
  })
  if (matches.length) return matches[0]

  // Search between the offsets' candidate instants to find the gap's first valid minute.
  const target = h * 60 + mi
  const first = candidates[0],
    last = candidates[candidates.length - 1]
  for (let t = first; t <= last; t += 60_000) {
    const p = wallClock(t, tz)
    if (p.year === y && p.month === mo && p.day === d && p.hour * 60 + p.minute >= target) return t
  }
  return last
}

function parseField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>()
  for (const term of field.split(',')) {
    if (!term) return null
    const [base, stepText, extra] = term.split('/')
    if (extra !== undefined || (stepText !== undefined && (!/^\d+$/.test(stepText) || +stepText < 1))) return null
    const step = stepText === undefined ? 1 : +stepText
    let lo: number, hi: number
    if (base === '*') {
      lo = min
      hi = max
    } else {
      const m = /^(\d+)(?:-(\d+))?$/.exec(base)
      if (!m) return null
      lo = +m[1]
      hi = m[2] === undefined ? lo : +m[2]
      if (lo < min || hi > max || lo > hi) return null
    }
    for (let n = lo; n <= hi; n += step) values.add(n)
  }
  return [...values].sort((a, b) => a - b)
}
export function parseCron(expr: string): CronSpec | null {
  if (typeof expr !== 'string') return null
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const mins = parseField(fields[0], 0, 59),
    hrs = parseField(fields[1], 0, 23)
  const doms = parseField(fields[2], 1, 31),
    months = parseField(fields[3], 1, 12),
    rawDows = parseField(fields[4], 0, 7)
  if (!mins || !hrs || !doms || !months || !rawDows) return null
  const dows = [...new Set(rawDows.map((day) => (day === 7 ? 0 : day)))].sort((a, b) => a - b)
  return { minutes: mins, hours: hrs, doms, months, dows, domStar: fields[2] === '*', dowStar: fields[4] === '*' }
}
const timeOk = (v: unknown): v is string => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v)
const daysOk = (v: unknown): v is number[] =>
  Array.isArray(v) && v.length > 0 && v.every((n) => Number.isInteger(n) && n >= 0 && n <= 6) && new Set(v).size === v.length
const intIn = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max
export function parseSchedule(v: unknown): Schedule | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const x = v as Record<string, unknown>
  switch (x.freq) {
    case 'once': {
      if (typeof x.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.date) || !timeOk(x.time)) return null
      const d = new Date(`${x.date}T00:00:00Z`)
      return d.toISOString().slice(0, 10) === x.date ? { freq: 'once', date: x.date, time: x.time } : null
    }
    case 'hourly':
      return intIn(x.minute, 0, 59) && daysOk(x.days) ? { freq: 'hourly', minute: x.minute, days: [...x.days] } : null
    case 'daily':
      return timeOk(x.time) && daysOk(x.days) ? { freq: 'daily', time: x.time, days: [...x.days] } : null
    case 'weekly':
      return intIn(x.day, 0, 6) && timeOk(x.time) ? { freq: 'weekly', day: x.day, time: x.time } : null
    case 'monthly':
      return (x.day === 'last' || intIn(x.day, 1, 31)) && timeOk(x.time) ? { freq: 'monthly', day: x.day, time: x.time } : null
    case 'yearly': {
      if (!intIn(x.month, 1, 12) || !intIn(x.day, 1, 31) || !timeOk(x.time)) return null
      if (x.day > new Date(Date.UTC(2024, x.month, 0)).getUTCDate()) return null
      return { freq: 'yearly', month: x.month, day: x.day, time: x.time }
    }
    case 'custom': {
      if (typeof x.cron !== 'string') return null
      const cron = parseCron(x.cron)
      return cron && canFire(cron) ? { freq: 'custom', cron: x.cron } : null
    }
    default:
      return null
  }
}
function canFire(c: CronSpec): boolean {
  for (const month of c.months) {
    const max = new Date(Date.UTC(2024, month, 0)).getUTCDate()
    for (let day = 1; day <= max; day++) {
      const dom = c.doms.includes(day),
        dow = c.dows.includes(new Date(Date.UTC(2024, month - 1, day)).getUTCDay())
      if (!c.domStar && !c.dowStar && (dom || dow)) return true
      if (!c.domStar && c.dowStar && dom) return true
      if (c.domStar && !c.dowStar && dow) return true
      if (c.domStar && c.dowStar) return true
    }
  }
  return false
}
const range = (from: number, count: number): number[] => Array.from({ length: count }, (_, i) => from + i)
// A one-off date is handled by findNextRun itself, so it never needs a cron form.
function cronFor(s: Exclude<Schedule, { freq: 'once' }>): CronSpec {
  if (s.freq === 'custom') return parseCron(s.cron)!
  const allMonths = range(1, 12)
  const allDays = range(1, 31)
  if (s.freq === 'hourly') {
    return { minutes: [s.minute], hours: range(0, 24), doms: allDays, months: allMonths, dows: s.days, domStar: true, dowStar: false }
  }
  const [h, m] = s.time.split(':').map(Number)
  if (s.freq === 'daily') {
    return { minutes: [m], hours: [h], doms: allDays, months: allMonths, dows: s.days, domStar: true, dowStar: false }
  }
  if (s.freq === 'weekly') {
    return { minutes: [m], hours: [h], doms: allDays, months: allMonths, dows: [s.day], domStar: true, dowStar: false }
  }
  if (s.freq === 'monthly') {
    return {
      minutes: [m],
      hours: [h],
      doms: s.day === 'last' ? allDays : [s.day],
      months: allMonths,
      dows: range(0, 7),
      domStar: false,
      dowStar: true,
      lastDay: s.day === 'last'
    }
  }
  return { minutes: [m], hours: [h], doms: [s.day], months: [s.month], dows: range(0, 7), domStar: false, dowStar: true }
}
function dayMatches(c: CronSpec, y: number, mo: number, d: number): boolean {
  if (!c.months.includes(mo)) return false
  const maxDay = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  const dom = c.lastDay ? d === maxDay : c.doms.includes(d)
  const dow = c.dows.includes(new Date(Date.UTC(y, mo - 1, d)).getUTCDay())
  if (!c.domStar && !c.dowStar) return dom || dow
  if (!c.domStar) return dom
  if (!c.dowStar) return dow
  return true
}
export function nextRun(s: Schedule, timeZone: string, after: number): number | null {
  try {
    return findNextRun(s, timeZone, after)
  } catch {
    return null
  }
}
function findNextRun(s: Schedule, timeZone: string, after: number): number | null {
  if (!isTimeZone(timeZone) || !Number.isFinite(after)) return null
  if (s.freq === 'once') {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.date),
      t = /^(\d{2}):(\d{2})$/.exec(s.time)
    if (!m || !t) return null
    const y = +m[1],
      mo = +m[2],
      d = +m[3]
    if (new Date(Date.UTC(y, mo - 1, d)).toISOString().slice(0, 10) !== s.date) return null
    const result = zonedToUtc(y, mo, d, +t[1], +t[2], timeZone)
    return result > after ? result : null
  }
  const c = cronFor(s)
  let local = wallClock(after, timeZone)
  let day = new Date(Date.UTC(local.year, local.month - 1, local.day))
  const limitYear = local.year + 8
  for (let i = 0; i <= 8 * 366; i++) {
    const y = day.getUTCFullYear(),
      mo = day.getUTCMonth() + 1,
      d = day.getUTCDate()
    if (y > limitYear) break
    if (dayMatches(c, y, mo, d)) {
      for (const h of c.hours)
        for (const mi of c.minutes) {
          const result = zonedToUtc(y, mo, d, h, mi, timeZone)
          if (result > after) return result
        }
    }
    day.setUTCDate(day.getUTCDate() + 1)
  }
  return null
}
export function nextRuns(s: Schedule, timeZone: string, after: number, n: number): number[] {
  const out: number[] = []
  let cursor = after
  for (let i = 0; i < Math.max(0, Math.floor(n)); i++) {
    const next = nextRun(s, timeZone, cursor)
    if (next === null) break
    out.push(next)
    cursor = next
  }
  return out
}
function clockLabel(time: string): string {
  const [hh, mm] = time.split(':').map(Number),
    h = hh % 12 || 12
  return `${h}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`
}
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const LONG_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
function daysLabel(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b)
  if (sorted.length === 7) return 'Every day'
  if (sorted.join(',') === '1,2,3,4,5') return 'Weekdays'
  if (sorted.join(',') === '0,6') return 'Weekends'
  return `On ${sorted.map((d) => SHORT_DAYS[d]).join(', ')}`
}
export function describeSchedule(s: Schedule): string {
  if (s.freq === 'custom') return `Custom: ${s.cron}`
  if (s.freq === 'once') return `Once on ${s.date} at ${clockLabel(s.time)}`
  if (s.freq === 'hourly') return `Every hour at :${String(s.minute).padStart(2, '0')}`
  if (s.freq === 'daily') return `${daysLabel(s.days)} at ${clockLabel(s.time)}`
  if (s.freq === 'weekly') return `Weekly on ${LONG_DAYS[s.day]} at ${clockLabel(s.time)}`
  if (s.freq === 'monthly') return `Monthly on ${s.day === 'last' ? 'the last day' : `day ${s.day}`} at ${clockLabel(s.time)}`
  return `Yearly on ${s.month}/${s.day} at ${clockLabel(s.time)}`
}
