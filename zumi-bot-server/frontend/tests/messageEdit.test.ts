import { describe, expect, it } from 'vitest'
import type { ChatItem, VersionInfo } from '@zumibot/shared/types'
import { canStep, dimmedAfter, editOutcome, editStillValid, resendTarget, switchBlocked, versionLabel } from '../src/state/messageEdit'

const user = (id: string): ChatItem => ({ type: 'user', id, text: id, ts: 1 })
const agent = (id: string, name?: string): ChatItem => ({ type: 'assistant', id, text: id, ts: 1, agent: name })
const tool = (id: string): ChatItem => ({ type: 'tool', id, name: 'Read', input: {}, result: null, isError: false, blocked: false, ts: 1 })

describe('resendTarget', () => {
  it('is the user message before the latest agent message, else null', () => {
    const items = [user('u1'), agent('a1'), user('u2'), tool('t'), agent('a2')]
    expect(resendTarget(items, 'a2')).toBe('u2')
    expect(resendTarget(items, 'a1')).toBeNull() // not the latest
    expect(resendTarget(items, 'u2')).toBeNull() // not an agent message
    expect(resendTarget(items, 'nope')).toBeNull()
    expect(resendTarget([agent('a')], 'a')).toBeNull() // no user message above
  })
  it("in a room uses the room's last agent message", () => {
    const items = [user('u1'), agent('a1', 'ann'), agent('b1', 'bob'), user('u2'), agent('a2', 'ann'), agent('b2', 'bob')]
    expect(resendTarget(items, 'b2')).toBe('u2')
    expect(resendTarget(items, 'a2')).toBeNull()
  })
})

describe('resendTarget and run messages', () => {
  it('no resend target behind a run message', () => {
    const run: ChatItem = { type: 'user', id: 'r', text: 'result', ts: 1, run: { processId: 'p' } }
    expect(resendTarget([user('u1'), agent('a1'), run, agent('a2')], 'a2')).toBeNull()
  })
})

describe('versions', () => {
  const v = (index: number, count: number): VersionInfo => ({ root: 'r', index, count })
  it('versionLabel and canStep at the ends', () => {
    expect(versionLabel(v(1, 3))).toBe('2 / 3')
    expect(canStep(v(0, 3), -1)).toBe(false)
    expect(canStep(v(0, 3), 1)).toBe(true)
    expect(canStep(v(2, 3), 1)).toBe(false)
    expect(canStep(v(2, 3), -1)).toBe(true)
  })

  it('switchBlocked says why the arrows are off, or null when a switch can go', () => {
    const free = { canAct: true, running: false, switching: false }
    expect(switchBlocked(free)).toBeNull()
    expect(switchBlocked({ ...free, running: true })).toBe('Wait for the reply to finish to switch versions')
    expect(switchBlocked({ ...free, switching: true })).toBe('Switching versions…')
    expect(switchBlocked({ ...free, canAct: false })).toBe("Versions can't be switched while sending is unavailable")
    // Offline or no CLI comes first: a running flag seen before the connection dropped may be stale.
    expect(switchBlocked({ canAct: false, running: true, switching: false })).toBe(
      "Versions can't be switched while sending is unavailable"
    )
    expect(switchBlocked({ canAct: true, running: true, switching: true })).toBe('Switching versions…')
  })
})

describe('dimmedAfter', () => {
  const items = [user('u1'), agent('a1'), user('u2'), agent('a2')]
  it('lists every item after the edited one', () => {
    expect([...dimmedAfter(items, 'u1')]).toEqual(['a1', 'u2', 'a2'])
    expect([...dimmedAfter(items, 'u2')]).toEqual(['a2'])
  })
  it('is empty when nothing is edited or the id is gone', () => {
    expect(dimmedAfter(items, null).size).toBe(0)
    expect(dimmedAfter(items, 'zzz').size).toBe(0)
  })
})

describe('editOutcome', () => {
  it('an unchanged edit is a resend; a blank edit without files is empty', () => {
    expect(editOutcome('hello', 'hello', false)).toEqual({ kind: 'resend' })
    expect(editOutcome('hello', ' hello \n', false)).toEqual({ kind: 'resend' })
    expect(editOutcome('hello', 'bye', false)).toEqual({ kind: 'edit', text: 'bye' })
    expect(editOutcome('hello', '  \n', false)).toEqual({ kind: 'empty' })
    expect(editOutcome('hello', '', true)).toEqual({ kind: 'edit', text: '' })
    expect(editOutcome('', '', true)).toEqual({ kind: 'resend' })
  })
  it('a menu pick keeps unchanged text an edit, since a resend would not carry the pick', () => {
    expect(editOutcome('/check x', '/check x', false, true)).toEqual({ kind: 'edit', text: '/check x' })
    expect(editOutcome('/check x', '/check x', false, false)).toEqual({ kind: 'resend' })
  })
  it('sends an edit as typed, keeping leading indentation', () => {
    expect(editOutcome('code', '    indented\n  more', false)).toEqual({ kind: 'edit', text: '    indented\n  more' })
    expect(editOutcome('hello', 'hello  \n', false)).toEqual({ kind: 'resend' })
  })
})

describe('editStillValid', () => {
  it('is false once the id is gone', () => {
    const items = [user('u1'), agent('a1')]
    expect(editStillValid(items, 'u1')).toBe(true)
    expect(editStillValid(items, 'u9')).toBe(false)
    expect(editStillValid(items, 'a1')).toBe(false) // only a user message can be edited
  })
})
