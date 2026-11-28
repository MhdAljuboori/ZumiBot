import { describe, expect, it } from 'vitest'
import { LATER_ERRORS, laterRest, parseLater } from '../src/later'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
// Wednesday 2026-11-25 10:00 UTC.
const NOW = Date.UTC(2026, 10, 25, 10, 0)

const at = (rest: string, now = NOW, tz = 'UTC') => {
  const r = parseLater(rest, now, tz)
  if ('error' in r) throw new Error(r.error)
  return r
}
const error = (rest: string, now = NOW, tz = 'UTC') => {
  const r = parseLater(rest, now, tz)
  return 'error' in r ? r.error : null
}

describe('laterRest', () => {
  it('reads a leading /later only', () => {
    expect(laterRest('/later 9am check CI')).toBe('9am check CI')
    expect(laterRest('/later')).toBe('')
    expect(laterRest('/laterx 9am')).toBeNull()
    expect(laterRest('hi /later 9am')).toBeNull()
    expect(laterRest('/later\n9am x')).toBe('9am x')
  })
})

describe('parseLater', () => {
  it('reads a clock time today while it is still ahead, else tomorrow', () => {
    expect(at('11am check CI')).toEqual({ at: Date.UTC(2026, 10, 25, 11, 0), text: 'check CI' })
    expect(at('9am check CI').at).toBe(Date.UTC(2026, 10, 26, 9, 0))
    expect(at('10am x').at).toBe(Date.UTC(2026, 10, 26, 10, 0)) // now is not ahead
  })

  it('reads 24 h, am/pm, noon and midnight', () => {
    expect(at('21:30 x').at).toBe(Date.UTC(2026, 10, 25, 21, 30))
    expect(at('9:30pm x').at).toBe(Date.UTC(2026, 10, 25, 21, 30))
    expect(at('9:30 PM x').at).toBe(Date.UTC(2026, 10, 25, 21, 30))
    expect(at('12pm x').at).toBe(Date.UTC(2026, 10, 25, 12, 0))
    expect(at('12am x').at).toBe(Date.UTC(2026, 10, 26, 0, 0))
    expect(at('noon x').at).toBe(Date.UTC(2026, 10, 25, 12, 0))
    expect(at('midnight x').at).toBe(Date.UTC(2026, 10, 26, 0, 0))
  })

  it('reads durations', () => {
    expect(at('in 20m x').at).toBe(NOW + 20 * MIN)
    expect(at('in 2h x').at).toBe(NOW + 2 * HOUR)
    expect(at('in 1h30m x').at).toBe(NOW + 90 * MIN)
    expect(at('in 1d x').at).toBe(NOW + DAY)
    expect(at('in 5 minutes deploy')).toEqual({ at: NOW + 5 * MIN, text: 'deploy' })
    expect(at('in 2 hours hello')).toEqual({ at: NOW + 2 * HOUR, text: 'hello' })
  })

  it('reads today, tomorrow and weekdays, before or after the time', () => {
    expect(at('tomorrow 9am x').at).toBe(Date.UTC(2026, 10, 26, 9, 0))
    expect(at('9am tomorrow x')).toEqual({ at: Date.UTC(2026, 10, 26, 9, 0), text: 'x' })
    expect(at('today 3pm x').at).toBe(Date.UTC(2026, 10, 25, 15, 0))
    expect(error('today 9am x')).toBe(LATER_ERRORS.passed)
    // Wednesday: a later hour today, an earlier one next week.
    expect(at('wed 11am x').at).toBe(Date.UTC(2026, 10, 25, 11, 0))
    expect(at('wednesday 9am x').at).toBe(Date.UTC(2026, 11, 2, 9, 0))
    expect(at('mon 9am x').at).toBe(Date.UTC(2026, 10, 30, 9, 0))
    expect(at('Fri 21:00 x').at).toBe(Date.UTC(2026, 10, 27, 21, 0))
  })

  it('keeps the message as typed, lines included', () => {
    expect(at('11am  check CI\non this PR').text).toBe('check CI\non this PR')
  })

  it('reads the time in the given zone', () => {
    // 10:00 UTC is 11:00 in Berlin: 9am Berlin tomorrow is 08:00 UTC.
    expect(at('9am x', NOW, 'Europe/Berlin').at).toBe(Date.UTC(2026, 10, 26, 8, 0))
    expect(at('noon x', NOW, 'Europe/Berlin').at).toBe(Date.UTC(2026, 10, 25, 11, 0))
  })

  it('keeps the wall clock across a DST change', () => {
    // Berlin leaves summer time on 2026-10-25; 9am the day after is 08:00 UTC, not 07:00.
    const sat = Date.UTC(2026, 9, 24, 12, 0)
    expect(at('mon 9am x', sat, 'Europe/Berlin').at).toBe(Date.UTC(2026, 9, 26, 8, 0))
  })

  it('refuses what it cannot read', () => {
    expect(error('')).toBe(LATER_ERRORS.noTime)
    expect(error('check CI')).toBe(LATER_ERRORS.noTime)
    expect(error('9 check CI')).toBe(LATER_ERRORS.noTime) // a bare number is not a time
    expect(error('tomorrow check CI')).toBe(LATER_ERRORS.noTime)
    expect(error('25:00 x')).toBe(LATER_ERRORS.badTime)
    expect(error('13pm x')).toBe(LATER_ERRORS.badTime)
    expect(error('9:75 x')).toBe(LATER_ERRORS.badTime)
    expect(error('9am')).toBe(LATER_ERRORS.noMessage)
    expect(error('in 2h   ')).toBe(LATER_ERRORS.noMessage)
    expect(error('in 0m x')).toBe(LATER_ERRORS.noTime)
    expect(error('in 31d x')).toBe(LATER_ERRORS.tooFar)
    expect(error('in 30d x')).toBeNull()
  })
})
