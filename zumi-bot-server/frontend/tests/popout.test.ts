import { describe, expect, it } from 'vitest'
import { cssColorToHex, forkDraftKey, openPopoutWindow, parseForkDraft, popoutClick, staysInPopout } from '../src/state/popout'

const click = { button: 0, ctrlKey: false, metaKey: false }

describe('popoutClick', () => {
  it('takes Ctrl+click and Cmd+click', () => {
    expect(popoutClick({ ...click, ctrlKey: true })).toBe(true)
    expect(popoutClick({ ...click, metaKey: true })).toBe(true)
  })
  it('takes a middle click', () => {
    expect(popoutClick({ ...click, button: 1 })).toBe(true)
  })
  it('leaves a plain click and a right click to the row', () => {
    expect(popoutClick(click)).toBe(false)
    expect(popoutClick({ ...click, button: 2 })).toBe(false)
    expect(popoutClick({ ...click, button: 2, ctrlKey: true })).toBe(false)
  })
})

describe('cssColorToHex', () => {
  it('reads the computed rgb() and rgba() forms', () => {
    expect(cssColorToHex('rgb(10, 12, 16)')).toBe('#0a0c10')
    expect(cssColorToHex('rgba(238, 241, 246, 1)')).toBe('#eef1f6')
  })
  it('reads hex forms', () => {
    expect(cssColorToHex('#ABC')).toBe('#aabbcc')
    expect(cssColorToHex('#0a0C10')).toBe('#0a0c10')
  })
  it('is null for anything it cannot place', () => {
    expect(cssColorToHex('transparent')).toBeNull()
    expect(cssColorToHex('rgba(0, 0, 0, 0)')).toBeNull()
    expect(cssColorToHex('rgb(300, 0, 0)')).toBeNull()
    expect(cssColorToHex('')).toBeNull()
  })
})

describe('openPopoutWindow', () => {
  type Opened = { url: string; name: string; features?: string }
  const fakeWindow = (href: string) => ({ location: { href }, focus: () => {} })
  it('opens a new popup window on the popout address', () => {
    const calls: Opened[] = []
    const w = fakeWindow('about:blank')
    const ok = openPopoutWindow((url, name, features) => (calls.push({ url, name, features }), w), 'c 1')
    expect(ok).toBe(true)
    expect(calls).toEqual([{ url: '', name: 'zumibot-chat-c 1', features: 'popup,width=900,height=700' }])
    expect(w.location.href).toBe('/chat/c%201?popout=1')
  })
  it('only raises a popup already showing the chat, so its draft and scroll stay', () => {
    const w = fakeWindow('http://x/chat/c1?popout=1')
    expect(openPopoutWindow(() => w, 'c1')).toBe(true)
    expect(w.location.href).toBe('http://x/chat/c1?popout=1')
  })
  it('is false when the browser blocked it', () => {
    expect(openPopoutWindow(() => null, 'c1')).toBe(false)
  })
})

describe('parseForkDraft', () => {
  const a = { id: 'a1', name: 'x.png', mime: 'image/png', size: 3, kind: 'image' }
  it('reads a draft handed over from a popout', () => {
    expect(parseForkDraft(JSON.stringify({ text: 'hi', attachments: [a] }))).toEqual({ text: 'hi', attachments: [a] })
    expect(forkDraftKey('c1')).toBe('zumibot-fork-draft:c1')
  })
  it('is null for anything else', () => {
    expect(parseForkDraft(null)).toBeNull()
    expect(parseForkDraft('{nope')).toBeNull()
    expect(parseForkDraft(JSON.stringify({ text: 5, attachments: [] }))).toBeNull()
    expect(parseForkDraft(JSON.stringify({ text: 'hi', attachments: [{ id: 1 }] }))).toBeNull()
  })
})

describe('staysInPopout', () => {
  it('keeps a popout on its own chat and lets the main page open any', () => {
    expect(staysInPopout('a', 'a')).toBe(true)
    expect(staysInPopout('a', 'b')).toBe(false)
    expect(staysInPopout(null, 'b')).toBe(true)
  })
})
