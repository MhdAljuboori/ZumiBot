import { describe, expect, it } from 'vitest'
import { attachmentTarget, openDecision } from '../src/main/attachmentPolicy'

const o = 'http://127.0.0.1:1234'

describe('attachmentTarget', () => {
  it('accepts the two attachment routes on the connected origin (relative or absolute)', () => {
    expect(attachmentTarget('/api/attachments/staged/abc-123', o)?.href).toBe(o + '/api/attachments/staged/abc-123')
    expect(attachmentTarget('/api/attachments/chat/c1/a-2', o)?.href).toBe(o + '/api/attachments/chat/c1/a-2')
    expect(attachmentTarget(o + '/api/attachments/chat/c1/a-2', o)).not.toBeNull()
  })

  it('rejects other paths, queries, other origins and bad ids', () => {
    for (const u of [
      '/',
      '/login.js',
      '/api/attachments/chat/c1',
      '/api/attachments/chat/c1/a/b',
      '/api/attachments/chat/../x/a',
      '/api/attachments/staged/a%2F..',
      '/api/attachments/staged/a.b',
      '/api/attachments/staged/a?download=1',
      '/api/attachments/staged/a#x',
      'https://evil.test/api/attachments/staged/a',
      'http://127.0.0.1:9999/api/attachments/staged/a',
      'javascript:1',
      ''
    ]) {
      expect(attachmentTarget(u, o), u).toBeNull()
    }
  })
})

describe('openDecision', () => {
  it('opens only inline-safe types where response MIME and extension agree', () => {
    expect(openDecision('image/png', 'a.png')).toBe('open')
    expect(openDecision('image/jpeg', 'a.JPG')).toBe('open')
    expect(openDecision('image/bmp', 'a.bmp')).toBe('open')
    expect(openDecision('application/pdf', 'a.pdf')).toBe('open')
    expect(openDecision('text/plain; charset=utf-8', 'notes.txt')).toBe('open')
    expect(openDecision('text/plain', 'a.md')).toBe('open')
  })

  it('reveals everything else', () => {
    expect(openDecision('application/octet-stream', 'x.jar')).toBe('reveal')
    expect(openDecision('application/octet-stream', 'x.desktop')).toBe('reveal')
    expect(openDecision('image/png', 'x.jar')).toBe('reveal') // extension disagrees
    expect(openDecision('application/octet-stream', 'a.png')).toBe('reveal') // MIME disagrees
    expect(openDecision('image/svg+xml', 'a.svg')).toBe('reveal')
    expect(openDecision('text/html', 'a.html')).toBe('reveal')
    expect(openDecision('image/png', 'noext')).toBe('reveal')
    expect(openDecision('', 'a.png')).toBe('reveal')
  })
})
