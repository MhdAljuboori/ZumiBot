import { describe, expect, it } from 'vitest'
import { describeSchedule, nextRun, nextRuns, parseCron, parseSchedule } from '@zumibot/shared/schedule'
import type { Schedule } from '@zumibot/shared/routines'

const at = (s: string) => Date.parse(s)
const daily = (time: string, days = [0, 1, 2, 3, 4, 5, 6]): Schedule => ({ freq: 'daily', time, days })
const next = (s: Schedule, after: string, tz = 'UTC') => nextRun(s, tz, at(after))

describe('schedule math', () => {
  it('computes daily schedules in local time', () => {
    expect(next(daily('07:00'), '2026-10-27T05:00:00Z', 'Asia/Baghdad')).toBe(at('2026-10-28T04:00:00Z'))
    expect(next(daily('07:00'), '2026-10-27T03:00:00Z', 'Asia/Baghdad')).toBe(at('2026-10-27T04:00:00Z'))
    expect(next(daily('07:00', [1, 2, 3, 4, 5]), '2026-10-30T08:00:00Z', 'Asia/Baghdad')).toBe(at('2026-11-02T04:00:00Z'))
  })

  it('handles DST transitions and gaps', () => {
    expect(next(daily('07:00'), '2026-03-07T13:00:00Z', 'America/New_York')).toBe(at('2026-03-08T11:00:00Z'))
    expect(next(daily('07:00'), '2026-10-31T12:00:00Z', 'America/New_York')).toBe(at('2026-11-01T12:00:00Z'))
    expect(next(daily('02:30'), '2026-03-08T05:00:00Z', 'America/New_York')).toBe(at('2026-03-08T07:00:00Z'))
    expect(next(daily('01:30'), '2026-11-01T04:00:00Z', 'America/New_York')).toBe(at('2026-11-01T05:30:00Z'))
    expect(next(daily('02:30'), '2027-03-28T00:00:00Z', 'Europe/Berlin')).toBe(at('2027-03-28T01:00:00Z'))
    expect(next(daily('02:30'), '2026-10-25T00:00:00Z', 'Europe/Berlin')).toBe(at('2026-10-25T00:30:00Z'))
    expect(next(daily('02:30'), '2026-10-03T14:00:00Z', 'Australia/Sydney')).toBe(at('2026-10-03T16:00:00Z'))
    expect(next(daily('02:30'), '2026-04-04T14:00:00Z', 'Australia/Sydney')).toBe(at('2026-04-04T15:30:00Z'))
    // Lord Howe advances 30 minutes: 02:15 is skipped to 02:30 (UTC+11).
    expect(next(daily('02:15'), '2026-10-03T14:00:00Z', 'Australia/Lord_Howe')).toBe(at('2026-10-03T15:30:00Z'))
    // Its autumn rollback repeats 01:45; choose the first occurrence (UTC+11).
    expect(next(daily('01:45'), '2026-04-04T14:00:00Z', 'Australia/Lord_Howe')).toBe(at('2026-04-04T14:45:00Z'))
  })

  it('computes hourly, weekly, monthly, yearly and once schedules', () => {
    expect(next({ freq: 'hourly', minute: 30, days: [0, 1, 2, 3, 4, 5, 6] }, '2026-10-27T10:45:00Z')).toBe(at('2026-10-27T11:30:00Z'))
    expect(next({ freq: 'weekly', day: 0, time: '09:00' }, '2026-10-27T10:00:00Z')).toBe(at('2026-11-01T09:00:00Z'))
    expect(next({ freq: 'monthly', day: 'last', time: '09:00' }, '2027-02-01T00:00:00Z')).toBe(at('2027-02-28T09:00:00Z'))
    expect(next({ freq: 'monthly', day: 31, time: '09:00' }, '2027-04-01T00:00:00Z')).toBe(at('2027-05-31T09:00:00Z'))
    expect(next({ freq: 'yearly', month: 2, day: 29, time: '09:00' }, '2027-03-01T00:00:00Z')).toBe(at('2028-02-29T09:00:00Z'))
    expect(next({ freq: 'once', date: '2027-01-01', time: '12:30' }, '2026-12-31T00:00:00Z')).toBe(at('2027-01-01T12:30:00Z'))
    expect(next({ freq: 'once', date: '2026-01-01', time: '12:30' }, '2026-12-31T00:00:00Z')).toBeNull()
  })

  it('parses cron and supports cron day-of-month/day-of-week OR semantics', () => {
    expect(parseCron('61 * * * *')).toBeNull()
    expect(parseCron('* * *')).toBeNull()
    expect(parseCron('0 0 * * 7')?.dows).toEqual([0])
    expect(next({ freq: 'custom', cron: '0 7 * * 1-5' }, '2026-10-27T05:00:00Z', 'Asia/Baghdad')).toBe(at('2026-10-28T04:00:00Z'))
    expect(next({ freq: 'custom', cron: '*/15 * * * *' }, '2026-10-27T10:07:00Z')).toBe(at('2026-10-27T10:15:00Z'))
    expect(next({ freq: 'custom', cron: '0 0 1 * 1' }, '2026-10-02T00:00:00Z')).toBe(at('2026-10-05T00:00:00Z'))
    expect(next({ freq: 'custom', cron: 'not cron' }, '2026-10-02T00:00:00Z')).toBeNull()
    const runs = nextRuns({ freq: 'custom', cron: '*/15 * * * *' }, 'UTC', at('2026-10-27T10:07:00Z'), 3)
    expect(runs).toEqual(['2026-10-27T10:15:00Z', '2026-10-27T10:30:00Z', '2026-10-27T10:45:00Z'].map(at))
  })

  it('describes schedules and rejects invalid schedule fields', () => {
    expect(describeSchedule(daily('07:00'))).toBe('Every day at 7:00 AM')
    expect(describeSchedule(daily('09:00', [1, 2, 3, 4, 5]))).toBe('Weekdays at 9:00 AM')
    expect(describeSchedule({ freq: 'hourly', minute: 30, days: [0, 1, 2, 3, 4, 5, 6] })).toBe('Every hour at :30')
    expect(describeSchedule({ freq: 'monthly', day: 'last', time: '18:00' })).toBe('Monthly on the last day at 6:00 PM')
    expect(describeSchedule({ freq: 'custom', cron: '0 7 * * 1-5' })).toBe('Custom: 0 7 * * 1-5')
    expect(parseSchedule({ freq: 'daily', time: '25:00', days: [1] })).toBeNull()
    expect(parseSchedule({ freq: 'daily', time: '07:00', days: [] })).toBeNull()
    const valid = [
      { freq: 'once', date: '2027-01-02', time: '07:00' },
      { freq: 'hourly', minute: 5, days: [0] },
      { freq: 'daily', time: '07:00', days: [1] },
      { freq: 'weekly', day: 1, time: '07:00' },
      { freq: 'monthly', day: 31, time: '07:00' },
      { freq: 'yearly', month: 2, day: 29, time: '07:00' },
      { freq: 'custom', cron: '0 0 31 1 *' }
    ]
    for (const schedule of valid) expect(parseSchedule(schedule)).toEqual(schedule)
    expect(parseSchedule({ freq: 'daily', time: '07:00', days: [1], extra: true })).toEqual({ freq: 'daily', time: '07:00', days: [1] })
    expect(parseSchedule({ freq: 'yearly', month: 2, day: 30, time: '07:00' })).toBeNull()
    expect(parseSchedule({ freq: 'yearly', month: 4, day: 31, time: '07:00' })).toBeNull()
    expect(parseSchedule({ freq: 'custom', cron: '0 0 31 2 *' })).toBeNull()
  })
})
