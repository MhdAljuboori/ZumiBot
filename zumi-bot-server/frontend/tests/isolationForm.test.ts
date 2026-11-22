import { describe, expect, it } from 'vitest'
import { ISOLATION_OFF } from '@zumibot/shared/isolation'
import { formOf, grantsOf, isolationOf, levelBlocked, linesOf, sameForm } from '../src/state/isolationForm'

describe('isolation form', () => {
  it('round-trips a setting through the text lists', () => {
    const iso = { ...ISOLATION_OFF, level: 'sandbox' as const, network: ['a.com', '*.b.org'], write: ['/srv/out'], webSearch: true }
    expect(isolationOf(formOf(iso))).toEqual({ ok: true, isolation: iso })
  })
  it('ignores blank lines and spaces, and says what is wrong', () => {
    expect(linesOf(' a.com \n\n b.com\n')).toEqual(['a.com', 'b.com'])
    expect(isolationOf({ ...formOf(ISOLATION_OFF), level: 'sandbox', network: 'https://a.com' })).toEqual({
      ok: false,
      error: expect.stringContaining('host name only')
    })
  })
  it('a form is unchanged when only spacing differs', () => {
    const f = formOf({ ...ISOLATION_OFF, network: ['a.com'] })
    expect(sameForm(f, { ...f, network: 'a.com\n\n' })).toBe(true)
    expect(sameForm(f, { ...f, level: 'sandbox' })).toBe(false)
  })
  it('lists what a run gets, and "No network" for an empty list', () => {
    const g = grantsOf({ ...ISOLATION_OFF, level: 'sandbox', read: ['/opt/x'] }, ['/home/u/.nvm/versions/node/v22'])
    expect(g.network).toBe('No network')
    expect(g.read).toEqual(expect.arrayContaining(['/home/u/.nvm/versions/node/v22', '/opt/x']))
  })
})

describe('container level', () => {
  it('grants name what a container mounts, not the host toolchain', () => {
    const g = grantsOf({ ...ISOLATION_OFF, level: 'container', network: [] }, ['/home/u/.nvm'])
    expect(g.read.join(' ')).not.toContain('/home/u/.nvm')
    expect(g.read[0]).toContain("image's own")
    expect(g.network).toBe('No network')
  })
  it('levelBlocked: Off never, a Codex refusal both, computer use blocks the container only', () => {
    const base = { refused: null, sandbox: null, container: null, computerUse: false }
    expect(levelBlocked('off', { ...base, refused: 'codex' })).toBeNull()
    expect(levelBlocked('container', { ...base, refused: 'codex' })).toBe('codex')
    expect(levelBlocked('sandbox', { ...base, computerUse: true })).toBeNull()
    expect(levelBlocked('container', { ...base, computerUse: true })).toContain('Computer use')
    expect(levelBlocked('container', { ...base, container: 'Install Podman.' })).toBe('Install Podman.')
  })
})
