import { describe, expect, it } from 'vitest'
import { PAUSE_BLOCK_CAP, PAUSE_BLOCK_TEXT, PAUSE_MARKER, RESUME_TEXT, lostNote } from '../src/pause'
import { NOTICE_TEXT } from '../src/types'

describe('lostNote', () => {
  it('returns null for no lost subagents', () => expect(lostNote([])).toBeNull())

  it('lists each lost subagent once, with a fallback for an empty description', () => {
    const t = lostNote(['Scan logs', ''])!
    expect(t).toContain('Your last reply was stopped while these subagents were running.')
    expect(t).toContain('- Scan logs')
    expect(t).toContain('- (no description)')
    expect(t).toContain('Run them again if you still need them.')
  })

  it('caps the list at 20 and says how many more', () => {
    const t = lostNote(Array.from({ length: 23 }, (_, i) => `job ${i}`))!
    expect(t).toContain('- job 19')
    expect(t).not.toContain('- job 20')
    expect(t).toContain('and 3 more')
  })
})

describe('pause texts', () => {
  it('marks the block text so the server can count blocked calls', () => expect(PAUSE_BLOCK_TEXT).toContain(PAUSE_MARKER))
  it('uses the agreed texts', () => {
    expect(PAUSE_BLOCK_TEXT).toBe(
      'The user paused this task (zumibot-pause). Do not start any tool or subagent. In a few lines, say where the task stands and what the next step is, then end your reply.'
    )
    expect(RESUME_TEXT).toBe('Continue')
    expect(PAUSE_BLOCK_CAP).toBe(3)
    expect(NOTICE_TEXT.userPaused).toBe('Paused. Press Resume to continue.')
  })
})
