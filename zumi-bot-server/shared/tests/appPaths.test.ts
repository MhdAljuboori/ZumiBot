import { describe, expect, it } from 'vitest'
import { VOICE, loginPath, safeNextPath, voiceFromPath } from '@zumibot/shared/appPaths'

describe('voiceFromPath', () => {
  it('routes /voice, and reads ?start=1 as an ask to start at once', () => {
    expect(voiceFromPath('/voice', '')).toEqual({ start: false })
    expect(voiceFromPath('/voice', '?start=1')).toEqual({ start: true })
    expect(voiceFromPath('/voice', '?a=2&start=1')).toEqual({ start: true })
    expect(VOICE).toBe('/voice')
  })

  it('takes only start=1 for a start', () => {
    for (const q of ['?start=0', '?start=', '?start', '?restart=1', '?start=11'])
      expect(voiceFromPath('/voice', q)).toEqual({ start: false })
  })

  it('routes nothing else', () => {
    for (const p of ['/voices', '/voice/', '/voice/a', '/', '', '/chat/voice', '/Voice']) expect(voiceFromPath(p, '?start=1')).toBeNull()
  })
})

describe('loginPath / safeNextPath', () => {
  it('sends the sign-in back to where it was asked from, the root needing no word', () => {
    expect(loginPath('/chat/x?popout=1')).toBe('/login?next=%2Fchat%2Fx%3Fpopout%3D1')
    expect(loginPath('/')).toBe('/login')
    expect(loginPath(null)).toBe('/login')
    expect(loginPath('//evil.example')).toBe('/login')
  })
  it('keeps only a path on this site', () => {
    expect(safeNextPath('/chat/a%20b?popout=1')).toBe('/chat/a%20b?popout=1')
    expect(safeNextPath('/settings/usage')).toBe('/settings/usage')
  })
  it('refuses another site, a scheme, a backslash, control characters, the login page and the API', () => {
    for (const bad of [
      '//evil.example/x',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      'chat/x',
      '/a\nb',
      '/login',
      '/login?next=/x',
      '/api/x',
      '/' + 'x'.repeat(600),
      5,
      null
    ]) {
      expect(safeNextPath(bad), String(bad)).toBeNull()
    }
  })
})
