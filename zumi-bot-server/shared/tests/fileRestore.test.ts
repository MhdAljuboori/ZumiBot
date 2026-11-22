import { describe, expect, it } from 'vitest'
import { restorePlan } from '@zumibot/shared/fileRestore'
import type { ChangedFile, ChangeStep } from '@zumibot/shared/files'

const step = (id: string, over: Partial<ChangeStep> = {}): ChangeStep => ({
  itemId: 'i',
  id,
  ts: 1,
  op: 'update',
  patch: null,
  before: null,
  after: null,
  ...over
})
const file = (...changes: ChangeStep[]): ChangedFile => ({ path: '/w/a', shown: 'a', created: changes[0]?.op === 'create', changes })

describe('restorePlan', () => {
  it('one step: its after must be on disk, its before goes back', () => {
    expect(restorePlan(file(step('s1', { before: 'b', after: 'a' })), 's1', 's1')).toEqual({ expect: { id: 'a' }, put: { id: 'b' } })
  })

  it("a range: the first step's before against the last step's after", () => {
    const f = file(step('s1', { before: 'b1', after: 'a1' }), step('s2', { before: 'a1', after: 'a2' }))
    expect(restorePlan(f, 's1', 's2')).toEqual({ expect: { id: 'a2' }, put: { id: 'b1' } })
  })

  it('a created file goes to the Trash; a deleted one must still be absent', () => {
    expect(restorePlan(file(step('s1', { op: 'create', after: 'a' })), 's1', 's1')).toEqual({ expect: { id: 'a' }, put: { remove: true } })
    expect(restorePlan(file(step('s1', { before: 'b', why: { after: 'deleted' } })), 's1', 's1')).toEqual({
      expect: { absent: true },
      put: { id: 'b' }
    })
  })

  it('refuses what it cannot check or put back', () => {
    expect(restorePlan(file(step('s1', { after: 'a', why: { before: 'not-sent' } })), 's1', 's1')).toEqual({ refused: 'noBefore' })
    expect(restorePlan(file(step('s1', { op: 'unknown', after: 'a' })), 's1', 's1')).toEqual({ refused: 'noBefore' }) // legacy: never "created"
    expect(restorePlan(file(step('s1', { before: 'b', why: { after: 'too-big' } })), 's1', 's1')).toEqual({ refused: 'noAfter' })
    expect(restorePlan(file(step('s1', { before: 'b', after: 'a' })), 'x', 's1')).toEqual({ refused: 'gone' })
    const f = file(step('s1', { before: 'b', after: 'a' }), step('s2', { before: 'a', after: 'c' }))
    expect(restorePlan(f, 's2', 's1')).toEqual({ refused: 'gone' })
  })
})
