import { describe, expect, it } from 'vitest'
import { isPermissionAllowed, isServerError, isSameOrigin, isWebUrl, redirectAction, safeFileName } from '../src/main/navigation'

describe('isSameOrigin', () => {
  it('same origin true', () => {
    expect(isSameOrigin('http://127.0.0.1:1234/chat/1?x=2#y', 'http://127.0.0.1:1234')).toBe(true)
    expect(isSameOrigin('https://zumibot-server.mhdaljuboori.me/', 'https://zumibot-server.mhdaljuboori.me')).toBe(true)
  })

  it('different port false', () => {
    expect(isSameOrigin('http://127.0.0.1:1235/', 'http://127.0.0.1:1234')).toBe(false)
  })

  it('https vs http false', () => {
    expect(isSameOrigin('http://zumibot-server.mhdaljuboori.me/', 'https://zumibot-server.mhdaljuboori.me')).toBe(false)
  })

  it('javascript: false', () => {
    expect(isSameOrigin('javascript:alert(1)', 'http://127.0.0.1:1234')).toBe(false)
    expect(isSameOrigin('data:text/html,hi', 'http://127.0.0.1:1234')).toBe(false)
    expect(isSameOrigin('file:///etc/passwd', 'http://127.0.0.1:1234')).toBe(false)
  })

  it('lookalike hosts and garbage are false', () => {
    expect(isSameOrigin('https://zumibot-server.mhdaljuboori.me.evil.test/', 'https://zumibot-server.mhdaljuboori.me')).toBe(false)
    expect(isSameOrigin('https://u@zumibot-server.mhdaljuboori.me@evil.test/', 'https://zumibot-server.mhdaljuboori.me')).toBe(false)
    expect(isSameOrigin('not a url', 'http://127.0.0.1:1234')).toBe(false)
  })
})

describe('isWebUrl', () => {
  it('only http and https', () => {
    expect(isWebUrl('https://example.com')).toBe(true)
    expect(isWebUrl('http://example.com')).toBe(true)
    expect(isWebUrl('file:///x')).toBe(false)
    expect(isWebUrl('javascript:1')).toBe(false)
    expect(isWebUrl('mailto:a@b.c')).toBe(false)
    expect(isWebUrl('junk')).toBe(false)
  })
})

describe('safeFileName', () => {
  it('keeps a plain name and strips any path', () => {
    expect(safeFileName('report.pdf')).toBe('report.pdf')
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('a\\b\\c.txt')).toBe('c.txt')
  })

  it('never returns an empty or dot name', () => {
    expect(safeFileName('')).toBe('attachment')
    expect(safeFileName('..')).toBe('attachment')
    expect(safeFileName('dir/')).toBe('attachment')
  })
})

describe('safeFileName by bytes', () => {
  it('stays within 255 bytes and keeps the extension', () => {
    const n = safeFileName('é'.repeat(300) + '.pdf')
    expect(Buffer.byteLength(n)).toBeLessThanOrEqual(200)
    expect(n.endsWith('.pdf')).toBe(true)
    const m = safeFileName('日本語'.repeat(80) + '.txt')
    expect(Buffer.byteLength(m)).toBeLessThanOrEqual(200)
    expect(m.endsWith('.txt')).toBe(true)
    expect(m).not.toContain('�') // never cut inside a character
  })
})

describe('redirectAction', () => {
  const o = 'https://zumibot-server.mhdaljuboori.me'
  it('allows same origin', () => {
    expect(redirectAction({ isMainFrame: true, url: o + '/login' }, o)).toBe('allow')
    expect(redirectAction({ isMainFrame: false, url: o + '/x' }, o)).toBe('allow')
  })
  it('a main-frame redirect away shows the error page, a subframe one is just blocked', () => {
    expect(redirectAction({ isMainFrame: true, url: 'https://evil.test/' }, o)).toBe('error')
    expect(redirectAction({ isMainFrame: false, url: 'https://evil.test/' }, o)).toBe('block')
  })
})

describe('isServerError', () => {
  it('only VPS 5xx', () => {
    expect(isServerError(502, 'vps')).toBe(true)
    expect(isServerError(500, 'vps')).toBe(true)
    expect(isServerError(404, 'vps')).toBe(false)
    expect(isServerError(200, 'vps')).toBe(false)
    expect(isServerError(0, 'vps')).toBe(false)
    expect(isServerError(503, 'local')).toBe(false)
  })
})

describe('isPermissionAllowed', () => {
  const o = 'http://127.0.0.1:1234'
  it('allows clipboard-sanitized-write for the connected origin and no other permission', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', o + '/', o)).toBe(true)
    expect(isPermissionAllowed('clipboard-sanitized-write', 'https://evil.test/', o)).toBe(false)
    expect(isPermissionAllowed('notifications', o + '/', o)).toBe(false)
    expect(isPermissionAllowed('display-capture', o + '/', o)).toBe(false)
    expect(isPermissionAllowed('screen-wake-lock', o + '/', o)).toBe(false)
  })

  it('allows media only for audio-only asks from the connected origin', () => {
    expect(isPermissionAllowed('media', o + '/', o, { mediaTypes: ['audio'] })).toBe(true)
    expect(isPermissionAllowed('media', o + '/', o, { mediaTypes: ['video'] })).toBe(false)
    expect(isPermissionAllowed('media', o + '/', o, { mediaTypes: ['audio', 'video'] })).toBe(false)
    expect(isPermissionAllowed('media', o + '/', o, { mediaTypes: [] })).toBe(false)
    expect(isPermissionAllowed('media', o + '/', o, {})).toBe(false)
    expect(isPermissionAllowed('media', o + '/', o)).toBe(false)
    expect(isPermissionAllowed('media', 'https://evil.test/', o, { mediaTypes: ['audio'] })).toBe(false)
    expect(isPermissionAllowed('media', 'file:///x', o, { mediaTypes: ['audio'] })).toBe(false)
  })

  it('check form uses mediaType', () => {
    expect(isPermissionAllowed('media', o + '/', o, { mediaType: 'audio' })).toBe(true)
    expect(isPermissionAllowed('media', o + '/', o, { mediaType: 'video' })).toBe(false)
    expect(isPermissionAllowed('media', o + '/', o, { mediaType: 'unknown' })).toBe(false)
    // The check handler's requestingOrigin is a bare origin, with no path.
    expect(isPermissionAllowed('media', o, o, { mediaType: 'audio' })).toBe(true)
    expect(isPermissionAllowed('media', 'https://evil.test', o, { mediaType: 'audio' })).toBe(false)
    expect(isPermissionAllowed('media', 'file://', o, { mediaType: 'audio' })).toBe(false)
    expect(isPermissionAllowed('media', o, o, {})).toBe(false)
  })
})
