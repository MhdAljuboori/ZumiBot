import { describe, expect, it } from 'vitest'
import { appLinkClick, appPath, islandLinkTarget, pathToOpen, plainClick } from '../src/state/appLink'

const o = 'https://bot.example.com'
const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }

describe('appPath', () => {
  it('accepts a relative path a route parser knows', () => {
    expect(appPath('/routines/0f6c-aa', o)).toBe('/routines/0f6c-aa')
    expect(appPath('/chat/abc', o)).toBe('/chat/abc')
    expect(appPath('/inbox/m1', o)).toBe('/inbox/m1')
    expect(appPath('/todos', o)).toBe('/todos')
    expect(appPath('/settings/usage', o)).toBe('/settings/usage')
    expect(appPath('/archived/x', o)).toBe('/archived/x')
    expect(appPath('/routines/new', o)).toBe('/routines/new')
    expect(appPath('/workflows/w1/runs/r1/audit', o)).toBe('/workflows/w1/runs/r1/audit')
  })

  it('accepts an absolute URL on this origin and returns only its path', () => {
    expect(appPath('https://bot.example.com/workflows/w1', o)).toBe('/workflows/w1')
  })

  it('keeps the query and the hash', () => {
    expect(appPath('/workflows/w1?x=1#top', o)).toBe('/workflows/w1?x=1#top')
  })

  it('refuses another origin, protocol-relative URLs and other schemes', () => {
    expect(appPath('//evil.com/routines/x', o)).toBeNull()
    expect(appPath('https://evil.com/routines/x', o)).toBeNull()
    expect(appPath('http://bot.example.com/routines/x', o)).toBeNull()
    expect(appPath('javascript:alert(1)', o)).toBeNull()
    expect(appPath('data:text/html,hi', o)).toBeNull()
    expect(appPath('mailto:a@b.c', o)).toBeNull()
    expect(appPath('ftp://bot.example.com/routines/x', o)).toBeNull()
  })

  it('refuses same-origin paths no route parser accepts', () => {
    expect(appPath('/api/files/x', o)).toBeNull()
    expect(appPath('/hooks/x', o)).toBeNull()
    expect(appPath('/sw.js', o)).toBeNull()
    expect(appPath('/routines/a/b', o)).toBeNull()
  })

  it('refuses a missing or unparsable href', () => {
    expect(appPath(undefined, o)).toBeNull()
    expect(appPath('', o)).toBeNull()
    expect(appPath('http://', o)).toBeNull()
  })

  // No rule of its own: new URL() resolves dot segments, so a traversal that ends outside a route is refused, and an
  // encoded one stays an id the parser decodes (the app only ever looks it up in its lists).
  it('leaves dot segments to URL and encoded ones to the route parser', () => {
    expect(appPath('/routines/../etc', o)).toBeNull()
    expect(appPath('/routines/..%2Fetc', o)).toBe('/routines/..%2Fetc')
  })
})

describe('plainClick', () => {
  it('is true for a plain left click', () => {
    expect(plainClick(click)).toBe(true)
  })
  it('is false for a modifier or another button', () => {
    expect(plainClick({ ...click, ctrlKey: true })).toBe(false)
    expect(plainClick({ ...click, metaKey: true })).toBe(false)
    expect(plainClick({ ...click, shiftKey: true })).toBe(false)
    expect(plainClick({ ...click, altKey: true })).toBe(false)
    expect(plainClick({ ...click, button: 1 })).toBe(false)
    expect(plainClick({ ...click, button: 2 })).toBe(false)
  })
})

describe('islandLinkTarget', () => {
  it('opens the chat of a chat path', () => {
    expect(islandLinkTarget('/chat/abc-1')).toEqual({ chatId: 'abc-1', live: null })
    expect(islandLinkTarget('/chat/abc-1?x=1#h')).toEqual({ chatId: 'abc-1', live: null })
  })
  it('only brings the main window forward for any other page', () => {
    expect(islandLinkTarget('/routines/r1')).toEqual({ chatId: null, live: null })
    expect(islandLinkTarget('/settings/usage')).toEqual({ chatId: null, live: null })
  })
})

describe('appLinkClick', () => {
  const here = '/chat/a'
  it('hands every click to a context that opens links elsewhere (the island, a popout)', () => {
    const open = () => {}
    expect(appLinkClick(click, '/chat/b', here, open)).toBe('context')
    expect(appLinkClick({ ...click, ctrlKey: true }, '/chat/b', here, open)).toBe('context')
  })
  it('leaves a modified click to the browser, does nothing for the page you are on, else moves the app', () => {
    expect(appLinkClick({ ...click, ctrlKey: true }, '/chat/b', here, null)).toBe('browser')
    expect(appLinkClick(click, here, here, null)).toBe('same')
    expect(appLinkClick(click, '/chat/b', here, null)).toBe('push')
  })
})

describe('pathToOpen', () => {
  it('is an in-app path that is not the page already shown', () => {
    expect(pathToOpen('/settings/usage', o, '/')).toBe('/settings/usage')
    expect(pathToOpen('/chat/x', o, '/chat/x')).toBeNull()
    expect(pathToOpen('/api/attachments/x', o, '/')).toBeNull()
    expect(pathToOpen('https://evil.example/chat/x', o, '/')).toBeNull()
  })
})
