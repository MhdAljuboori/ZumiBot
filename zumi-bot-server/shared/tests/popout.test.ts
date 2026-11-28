import { describe, expect, it } from 'vitest'
import { POPOUT_PARAM, cleanChatId, cleanHexColor, popoutChatFrom, popoutPath } from '@zumibot/shared/popout'

describe('popoutPath', () => {
  it("is the chat's own address with the popout flag", () => {
    expect(POPOUT_PARAM).toBe('popout')
    expect(popoutPath('abc')).toBe('/chat/abc?popout=1')
    expect(popoutPath('a b/c')).toBe('/chat/a%20b%2Fc?popout=1')
  })
})

describe('popoutChatFrom', () => {
  it('reads the chat of a popout address', () => {
    expect(popoutChatFrom('/chat/x', '?popout=1')).toBe('x')
    expect(popoutChatFrom('/chat/a%20b', '?popout=1&other=2')).toBe('a b')
  })
  it('is null for anything else', () => {
    expect(popoutChatFrom('/chat/x', '')).toBeNull()
    expect(popoutChatFrom('/chat/x', '?popout=0')).toBeNull()
    expect(popoutChatFrom('/archived/x', '?popout=1')).toBeNull()
    expect(popoutChatFrom('/', '?popout=1')).toBeNull()
    expect(popoutChatFrom('/chat/x/y', '?popout=1')).toBeNull()
  })
  it('round-trips popoutPath', () => {
    const url = new URL(popoutPath('id with spaces'), 'http://x')
    expect(popoutChatFrom(url.pathname, url.search)).toBe('id with spaces')
  })
})

describe('cleanChatId', () => {
  it('keeps a bounded string without control characters', () => {
    expect(cleanChatId('2f3e-room')).toBe('2f3e-room')
    expect(cleanChatId('x'.repeat(200))).toBe('x'.repeat(200))
  })
  it('rejects anything else', () => {
    expect(cleanChatId('')).toBeNull()
    expect(cleanChatId('x'.repeat(201))).toBeNull()
    expect(cleanChatId('a\nb')).toBeNull()
    expect(cleanChatId(5)).toBeNull()
    expect(cleanChatId(null)).toBeNull()
  })
})

describe('cleanHexColor', () => {
  it('keeps a six-digit hex color, lower-cased', () => {
    expect(cleanHexColor('#A0b1C2')).toBe('#a0b1c2')
  })
  it('rejects names, short forms and other types', () => {
    expect(cleanHexColor('red')).toBeNull()
    expect(cleanHexColor('#abc')).toBeNull()
    expect(cleanHexColor('#a0b1c2ff')).toBeNull()
    expect(cleanHexColor(0xffffff)).toBeNull()
  })
})
