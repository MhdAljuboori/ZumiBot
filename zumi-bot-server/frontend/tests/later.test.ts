import { describe, expect, it } from 'vitest'
import { LATER_ERRORS, LATER_NESTED } from '@zumibot/shared/later'
import { LATER_HINT, laterPreview, laterSendError } from '../src/state/later'

// Wednesday 2026-11-25 10:00 UTC.
const NOW = Date.UTC(2026, 10, 25, 10, 0)

describe('laterPreview', () => {
  it('says when the message goes, in the zone', () => {
    expect(laterPreview('/later 11am check CI', NOW, 'UTC')).toEqual({ text: 'Sends today at 11:00', error: false })
    expect(laterPreview('/later 9am check CI', NOW, 'UTC')).toEqual({ text: 'Sends tomorrow at 09:00', error: false })
    expect(laterPreview('/later 9am check CI', NOW, 'Europe/Berlin')).toEqual({ text: 'Sends tomorrow at 09:00', error: false })
  })

  it('hints on the bare command and names what is wrong after it', () => {
    expect(laterPreview('/later ', NOW, 'UTC')).toEqual({ text: LATER_HINT, error: false })
    expect(laterPreview('/later 9am', NOW, 'UTC')).toEqual({ text: LATER_ERRORS.noMessage, error: true })
    expect(laterPreview('/later in 2h /btw why', NOW, 'UTC')).toEqual({ text: LATER_NESTED, error: true })
  })

  it('is null for any other text', () => {
    expect(laterPreview('hello', NOW, 'UTC')).toBeNull()
    expect(laterPreview('/laterx 9am', NOW, 'UTC')).toBeNull()
  })
})

describe('laterSendError', () => {
  it('refuses the bare command and a bad time, lets a good one go', () => {
    expect(laterSendError('/later', NOW, 'UTC')).toBe(LATER_ERRORS.noTime)
    expect(laterSendError('/later 25:00 x', NOW, 'UTC')).toBe(LATER_ERRORS.badTime)
    expect(laterSendError('/later in 2h x', NOW, 'UTC')).toBeNull()
    expect(laterSendError('hello', NOW, 'UTC')).toBeNull()
  })
})
