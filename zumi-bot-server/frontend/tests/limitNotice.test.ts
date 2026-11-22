import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@zumibot/shared/types'
import { dayAt, limitNoticeText, waitingErrors } from '../src/state/limitNotice'

const at = (h: number, m = 0, day = 6) => Date.UTC(2026, 10, day, h, m)
const NOW = at(18)
const user = (id: string): ChatItem => ({ type: 'user', id, text: id, ts: 1 })
const limitError = (id: string, extra: { compact?: true } = {}): ChatItem => ({
  type: 'error',
  id,
  text: 'Claude exited with code 1',
  ts: 2,
  limit: { resetsAt: at(20), ...extra }
})

describe('dayAt', () => {
  it('says today, tomorrow or the date, with a 24-hour time in the zone', () => {
    expect(dayAt(at(20, 21), NOW, 'UTC')).toBe('today at 20:21')
    expect(dayAt(at(6, 0, 7), NOW, 'UTC')).toBe('tomorrow at 06:00')
    expect(dayAt(at(6, 0, 9), NOW, 'UTC')).toBe('Nov 9 at 06:00')
    expect(dayAt(at(20, 21), NOW, 'Europe/Berlin')).toBe('today at 21:21')
  })
})

describe('waitingErrors', () => {
  const items: ChatItem[] = [user('u1'), limitError('old'), user('u2'), limitError('e1'), limitError('c1', { compact: true })]

  it('is the limit errors of the turn the wait continues', () => {
    expect(waitingErrors({ resume: { at: at(20, 21), after: 'u2', waits: 1 } }, items)).toEqual(new Set(['e1']))
  })

  it('is empty without a wait, or when its message is not loaded', () => {
    expect(waitingErrors({}, items).size).toBe(0)
    expect(waitingErrors({ resume: { at: at(20, 21), after: 'gone', waits: 1 } }, items).size).toBe(0)
  })

  it('is empty in a pausing or paused chat: its wait sends nothing', () => {
    expect(waitingErrors({ resume: { at: at(20, 21), after: 'u2', waits: 1 }, pause: 'pausing' }, items).size).toBe(0)
    expect(waitingErrors({ resume: { at: at(20, 21), after: 'u2', waits: 1 }, pause: 'paused' }, items).size).toBe(0)
  })
})

describe('limitNoticeText', () => {
  it('says when a waiting chat continues', () => {
    expect(limitNoticeText({ resetsAt: at(20, 20) }, at(20, 21), NOW, 'UTC')).toBe('Usage limit reached · continues today at 20:21')
  })

  it('says when the limit resets once nothing waits, and only that it was reached once the reset passed', () => {
    expect(limitNoticeText({ resetsAt: at(20, 20) }, null, NOW, 'UTC')).toBe('Usage limit reached · resets today at 20:20')
    expect(limitNoticeText({ resetsAt: at(17) }, null, NOW, 'UTC')).toBe('Usage limit reached')
    expect(limitNoticeText({ resetsAt: null }, null, NOW, 'UTC')).toBe('Usage limit reached')
  })

  it('names the room member it stopped', () => {
    expect(limitNoticeText({ resetsAt: at(20, 20), agent: 'ui-ux-specialist' }, at(20, 21), NOW, 'UTC')).toBe(
      'Ui Ux Specialist reached the usage limit · continues today at 20:21'
    )
  })
})
