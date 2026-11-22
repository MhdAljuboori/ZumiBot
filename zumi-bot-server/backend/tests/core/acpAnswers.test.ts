import { describe, expect, it } from 'vitest'
import { acpPermissionAnswer } from '../../src/core/acp/acpAnswers'
import { allowResponse, denyResponse, errorResponse } from '../../src/core/chat/controlProtocol'

const OPTIONS = [
  { optionId: 'aa', name: 'Always', kind: 'allow_always' },
  { optionId: 'ao', name: 'Once', kind: 'allow_once' },
  { optionId: 'ra', name: 'Never', kind: 'reject_always' },
  { optionId: 'ro', name: 'No', kind: 'reject_once' }
]
const CANCELLED = { outcome: { outcome: 'cancelled' } }

describe('acpPermissionAnswer', () => {
  it('allow selects allow_once, never allow_always', () => {
    expect(acpPermissionAnswer(allowResponse('r', {}), OPTIONS)).toEqual({ outcome: { outcome: 'selected', optionId: 'ao' } })
  })

  it('deny selects reject_once, never reject_always', () => {
    expect(acpPermissionAnswer(denyResponse('r', 'no'), OPTIONS)).toEqual({ outcome: { outcome: 'selected', optionId: 'ro' } })
  })

  it('allow with no allow_once option cancels', () => {
    expect(
      acpPermissionAnswer(
        allowResponse('r', {}),
        OPTIONS.filter((o) => o.kind !== 'allow_once')
      )
    ).toEqual(CANCELLED)
  })

  it('deny with no reject_once option cancels', () => {
    expect(
      acpPermissionAnswer(
        denyResponse('r', 'no'),
        OPTIONS.filter((o) => o.kind !== 'reject_once')
      )
    ).toEqual(CANCELLED)
  })

  it('an error response or anything unrecognised is never consent', () => {
    expect(acpPermissionAnswer(errorResponse('r', 'boom'), OPTIONS)).toEqual(CANCELLED)
    expect(
      acpPermissionAnswer({ type: 'control_response', response: { subtype: 'success', response: { behavior: 'maybe' } } }, OPTIONS)
    ).toEqual(CANCELLED)
    expect(acpPermissionAnswer({ type: 'control_response', response: { subtype: 'success', response: {} } }, OPTIONS)).toEqual(CANCELLED)
    expect(acpPermissionAnswer({ response: { subtype: 'error', response: { behavior: 'allow' } } }, OPTIONS)).toEqual(CANCELLED)
    expect(acpPermissionAnswer({}, OPTIONS)).toEqual(CANCELLED)
    expect(acpPermissionAnswer(null as never, OPTIONS)).toEqual(CANCELLED)
  })

  it('reads odd options defensively', () => {
    expect(acpPermissionAnswer(allowResponse('r', {}), undefined as never)).toEqual(CANCELLED)
    expect(
      acpPermissionAnswer(allowResponse('r', {}), [null, 4, { kind: 'allow_once' }, { optionId: 3, kind: 'allow_once' }] as never)
    ).toEqual(CANCELLED)
  })

  it('takes the first allow_once when there are several', () => {
    const two = [
      { optionId: 'x', kind: 'allow_once' },
      { optionId: 'y', kind: 'allow_once' }
    ]
    expect(acpPermissionAnswer(allowResponse('r', {}), two)).toEqual({ outcome: { outcome: 'selected', optionId: 'x' } })
  })
})
