import { describe, expect, it } from 'vitest'
import { GH_LOGGED_OUT, GH_MISSING } from '@zumibot/shared/pullRequest'
import type { ChatMeta, ChatPr } from '@zumibot/shared/types'
import { canOpenPr, checksText, ghNote, prChipView, prTone } from '../src/state/pullRequest'

const pr = (o: Partial<ChatPr> = {}): ChatPr => ({
  number: 7,
  url: 'https://github.com/a/b/pull/7',
  state: 'open',
  branch: 'zumibot/coder-a1',
  at: 1,
  ...o
})
const checks = (status: 'pending' | 'passing' | 'failing', failing: string[] = []): ChatPr['checks'] => ({
  status,
  total: 3,
  pending: status === 'pending' ? 1 : 0,
  failing: failing.map((name) => ({ name }))
})

describe('prChipView', () => {
  it('is nothing without a pull request', () => {
    expect(prChipView(undefined)).toBeNull()
  })

  it('reads the number, the state and the checks, and names a failed read in its tooltip', () => {
    const view = prChipView(pr({ checks: checks('passing') }))!
    expect(view.label).toBe('#7 · open · 3 checks passing')
    expect(view.title).toContain('https://github.com/a/b/pull/7')
    expect(view.tone).toBe('done')
    expect(prChipView(pr({ error: 'error: could not reach github.com' }))!.title).toContain(
      'Last read failed: error: could not reach github.com'
    )
  })

  it('reads a draft as a draft only while it is open', () => {
    expect(prChipView(pr({ draft: true }))!.label).toBe('#7 · draft')
    expect(prChipView(pr({ draft: true, state: 'merged' }))!.label).toBe('#7 · merged')
  })
})

describe('prTone', () => {
  it('calls for the user on a failing check, whatever else is true', () => {
    expect(prTone({ state: 'open', checks: checks('failing', ['unit']) })).toBe('you')
    expect(prTone({ state: 'merged', checks: checks('failing', ['unit']) })).toBe('you')
  })

  it('is done when merged or green, busy while running, and quiet otherwise', () => {
    expect(prTone({ state: 'merged' })).toBe('done')
    expect(prTone({ state: 'open', checks: checks('passing') })).toBe('done')
    expect(prTone({ state: 'open', checks: checks('pending') })).toBe('busy')
    expect(prTone({ state: 'open' })).toBe('quiet')
    expect(prTone({ state: 'closed' })).toBe('quiet')
  })
})

describe('ghNote', () => {
  it('says nothing while gh can be used, and says what is wrong when it cannot', () => {
    expect(ghNote('ready')).toBeNull()
    expect(ghNote(undefined)).toBeNull() // still being read: no sentence yet
    expect(ghNote('missing')).toBe(GH_MISSING)
    expect(ghNote('logged-out')).toBe(GH_LOGGED_OUT)
    // No note anywhere offers to take a token.
    expect(`${GH_MISSING} ${GH_LOGGED_OUT}`.toLowerCase()).not.toContain('token')
  })
})

describe('canOpenPr and checksText', () => {
  it('needs a worktree whose folder is still there', () => {
    expect(canOpenPr({ worktree: undefined } as ChatMeta)).toBe(false)
    expect(canOpenPr({ worktree: { removed: true } } as ChatMeta)).toBe(false)
    expect(canOpenPr({ worktree: { branch: 'b' } } as ChatMeta)).toBe(true)
  })

  it('says plainly when nothing reported a check', () => {
    expect(checksText(undefined)).toBe('No checks reported')
    expect(checksText(checks('failing', ['unit', 'lint']))).toBe('2 of 3 checks failing')
  })
})
