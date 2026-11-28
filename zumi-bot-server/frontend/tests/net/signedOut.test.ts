import { describe, expect, it, vi } from 'vitest'
import { onBeforeSignedOut, redirectToLogin } from '../../src/net/signedOut'
import { loadDrafts, saveDrafts } from '../../src/state/draftStore'

const memory = (): Storage => {
  const m = new Map<string, string>()
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) } as Storage
}

describe('redirectToLogin', () => {
  it('expiry path persists drafts, then goes to /login', () => {
    const s = memory()
    const assign = vi.fn()
    onBeforeSignedOut(() => saveDrafts(s, { a: 'unsent' }))
    redirectToLogin(assign, true, s)
    expect(assign).toHaveBeenCalledWith('/login')
    expect(loadDrafts(s)).toEqual({ a: 'unsent' })
  })

  it('explicit sign-out saves nothing and clears the key', () => {
    const s = memory()
    const assign = vi.fn()
    saveDrafts(s, { old: 'left' })
    onBeforeSignedOut(() => saveDrafts(s, { a: 'unsent' }))
    redirectToLogin(assign, false, s)
    expect(assign).toHaveBeenCalledWith('/login')
    expect(s.getItem('zumibot:drafts')).toBeNull()
  })
})

describe('redirectToLogin back to the page', () => {
  it('an expired session in a chat or popout comes back to it after sign-in', () => {
    const assign = vi.fn()
    redirectToLogin(assign, true, memory(), '/chat/x?popout=1')
    expect(assign).toHaveBeenCalledWith('/login?next=%2Fchat%2Fx%3Fpopout%3D1')
  })
  it('a sign-out starts over at the root', () => {
    const assign = vi.fn()
    redirectToLogin(assign, false, memory(), '/chat/x?popout=1')
    expect(assign).toHaveBeenCalledWith('/login')
  })
})
