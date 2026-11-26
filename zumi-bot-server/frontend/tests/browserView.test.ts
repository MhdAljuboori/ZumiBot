import { describe, expect, it } from 'vitest'
import {
  initialBrowserView,
  reduceBrowserView,
  browserPoint,
  createBrowserFrames,
  safeReopenOrigin,
  browserKeyText,
  browserPasteShortcut,
  browserScale,
  nextClickCount,
  createBrowserTouch,
  browserTyping,
  browserImeKey,
  BROWSER_INPUT_PAD,
  BROWSER_BACKSPACES_MAX
} from '../src/state/browserView'
import type { BrowserStatus, BrowserFrame } from '@zumibot/shared/browser'
const ready: BrowserStatus = {
  agent: 'a',
  profileId: 'p',
  generation: 'g',
  state: 'ready',
  tabs: [{ id: 't', title: 'Fixture', url: 'about:blank' }],
  activeTabId: 't',
  control: 'agent',
  pendingRequestId: null,
  error: null
}
const open = () => reduceBrowserView(initialBrowserView, { type: 'open', target: { agent: 'a' } })
describe('browser view', () => {
  it('starts closed and read-only and only opens explicitly', () => {
    expect(initialBrowserView.open).toBe(false)
    expect(open()).toMatchObject({ open: true, control: false, target: { agent: 'a' } })
  })
  it('drops control on hidden, close, disconnect and generation changes', () => {
    let s = reduceBrowserView(open(), { type: 'status', status: ready })
    s = reduceBrowserView(s, { type: 'controlPending' })
    s = reduceBrowserView(s, { type: 'status', status: { ...ready, control: 'you' } })
    s = reduceBrowserView(s, { type: 'controlAck', epoch: s.epoch })
    expect(s.control).toBe(true)
    for (const event of [
      { type: 'visible', visible: false },
      { type: 'close' },
      { type: 'disconnect' },
      { type: 'status', status: { ...ready, generation: 'g2', control: 'you' } }
    ] as const) {
      expect(reduceBrowserView(s, event).control).toBe(false)
    }
  })
  it('never accepts stale control acknowledgment after close/reopen or a changed page', () => {
    const pending = reduceBrowserView(reduceBrowserView(open(), { type: 'status', status: ready }), { type: 'controlPending' })
    const reopened = reduceBrowserView(reduceBrowserView(pending, { type: 'close' }), { type: 'open', target: { agent: 'a' } })
    expect(reduceBrowserView(reopened, { type: 'controlAck', epoch: pending.epoch }).control).toBe(false)
  })
  it('keeps acknowledged control across a manual tab selection while invalidating pending input', () => {
    let s = reduceBrowserView(open(), { type: 'status', status: ready })
    s = reduceBrowserView(s, { type: 'controlPending' })
    s = reduceBrowserView(s, { type: 'status', status: { ...ready, control: 'you' } })
    s = reduceBrowserView(s, { type: 'controlAck', epoch: s.epoch })
    const next = reduceBrowserView(s, { type: 'status', status: { ...ready, activeTabId: 'new', control: 'you' } })
    expect(next.control).toBe(true)
    expect(next.epoch).toBeGreaterThan(s.epoch)
  })
  it('maps pointer positions through letterboxing and rejects margins', () => {
    expect(browserPoint(50, 75, { left: 0, top: 0, width: 200, height: 200 }, 400, 200)).toEqual({ x: 100, y: 50 })
    expect(browserPoint(50, 20, { left: 0, top: 0, width: 200, height: 200 }, 400, 200)).toBeNull()
  })
  it('commits printable text once and leaves shortcuts and composition to their own paths', () => {
    expect(browserKeyText({ key: 'a', ctrlKey: false, metaKey: false, altKey: false, isComposing: false })).toBe('a')
    expect(browserKeyText({ key: 'a', ctrlKey: true, metaKey: false, altKey: false, isComposing: false })).toBeNull()
    expect(browserKeyText({ key: 'ش', ctrlKey: false, metaKey: false, altKey: false, isComposing: true })).toBeNull()
  })
  it('keeps client clipboard paste shortcuts local rather than forwarding raw V', () => {
    expect(browserPasteShortcut({ key: 'v', ctrlKey: true, metaKey: false, altKey: false })).toBe(true)
    expect(browserPasteShortcut({ key: 'v', ctrlKey: false, metaKey: true, altKey: false })).toBe(true)
    expect(browserPasteShortcut({ key: 'V', ctrlKey: true, metaKey: false, altKey: false })).toBe(true)
    expect(browserPasteShortcut({ key: 'v', ctrlKey: true, metaKey: false, altKey: true })).toBe(false)
    expect(browserPasteShortcut({ key: 'c', ctrlKey: true, metaKey: false, altKey: false })).toBe(false)
  })
  it('allows AltGraph and Option-generated printable text while preserving modifier shortcuts', () => {
    const plain = { key: 'a', ctrlKey: false, metaKey: false, altKey: false, isComposing: false }
    expect(browserKeyText({ ...plain, key: '@', ctrlKey: true, altKey: true, getModifierState: (key) => key === 'AltGraph' })).toBe('@')
    expect(browserKeyText({ ...plain, key: 'ø', altKey: true })).toBe('ø')
    expect(browserKeyText({ ...plain, key: '@', altKey: true })).toBe('@')
    expect(browserKeyText({ ...plain, key: 'f', altKey: true })).toBeNull()
    expect(browserKeyText({ ...plain, key: 'k', ctrlKey: true, altKey: true, getModifierState: () => false })).toBeNull()
    expect(browserKeyText({ ...plain, key: 'ArrowLeft', altKey: true })).toBeNull()
    expect(browserKeyText({ ...plain, key: 'ø', metaKey: true, altKey: true })).toBeNull()
  })
  it('remembers only http origins, without credentials or sensitive paths', () => {
    expect(safeReopenOrigin('https://u:pw@example.test/login?token=secret#code')).toBe('https://example.test')
    expect(safeReopenOrigin('about:blank')).toBeNull()
    expect(safeReopenOrigin('file:///tmp/private')).toBeNull()
  })
  it('disposes old asynchronous decodes and keeps only one queued latest frame', async () => {
    const completions: Array<(v: { close(): void }) => void> = []
    const shown: unknown[] = []
    let disposed = 0
    const sink = createBrowserFrames({ decode: () => new Promise((r) => completions.push(r)), show: (r) => shown.push(r) })
    const frame: BrowserFrame = { generation: 'g', tabId: 't', sequence: 1, width: 400, height: 200, jpeg: new Uint8Array([1]) }
    sink.page(ready)
    sink.push(frame)
    sink.push({ ...frame, sequence: 2 })
    sink.push({ ...frame, sequence: 3 })
    expect(completions).toHaveLength(1)
    sink.page({ ...ready, activeTabId: 'new' })
    completions[0]({
      close() {
        disposed++
      }
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(disposed).toBe(1)
    expect(shown.filter(Boolean)).toHaveLength(0)
    expect(completions).toHaveLength(1)
    sink.page(ready)
    sink.push(frame)
    completions[1]({
      close() {
        disposed++
      }
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(shown.filter(Boolean)).toHaveLength(1)
    sink.clear()
    expect(disposed).toBe(2)
  })
})

describe('browser pointer gestures', () => {
  it('scales scroll distances by the letterboxed picture', () => {
    expect(browserScale({ width: 400, height: 300 }, 400, 300)).toBe(1)
    expect(browserScale({ width: 200, height: 200 }, 400, 200)).toBe(0.5)
    expect(browserScale({ width: 0, height: 0 }, 400, 200)).toBe(1)
  })
  it('counts quick nearby presses of one button up to a triple click', () => {
    const first = { x: 10, y: 10, t: 0, button: 'left', count: 1 }
    expect(nextClickCount(null, 10, 10, 0, 'left')).toBe(1)
    expect(nextClickCount(first, 12, 11, 300, 'left')).toBe(2)
    expect(nextClickCount({ ...first, count: 2 }, 10, 10, 300, 'left')).toBe(3)
    expect(nextClickCount({ ...first, count: 3 }, 10, 10, 300, 'left')).toBe(1)
    expect(nextClickCount(first, 10, 10, 501, 'left')).toBe(1)
    expect(nextClickCount(first, 30, 10, 100, 'left')).toBe(1)
    expect(nextClickCount(first, 10, 10, 100, 'right')).toBe(1)
  })
  it('turns a tap into a click and taps in a row into a double click', () => {
    const t = createBrowserTouch()
    t.down(50, 60)
    expect(t.move(54, 63)).toEqual([])
    expect(t.up(54, 63, 1000)).toEqual([{ type: 'click', x: 50, y: 60, count: 1 }])
    t.down(55, 62)
    expect(t.up(55, 62, 1200)).toEqual([{ type: 'click', x: 55, y: 62, count: 2 }])
    t.down(55, 62)
    expect(t.up(55, 62, 2000)).toEqual([{ type: 'click', x: 55, y: 62, count: 1 }])
  })
  it('scrolls the page against a dragging finger, never clicking', () => {
    const t = createBrowserTouch()
    t.down(100, 300)
    expect(t.move(100, 280)).toEqual([{ type: 'scroll', x: 100, y: 300, dx: 0, dy: 20 }])
    expect(t.move(95, 250)).toEqual([{ type: 'scroll', x: 100, y: 300, dx: 5, dy: 30 }])
    expect(t.longPress()).toEqual([])
    expect(t.up(95, 250, 500)).toEqual([])
    // A scroll breaks a run of taps.
    t.down(100, 300)
    expect(t.up(100, 300, 600)).toEqual([{ type: 'click', x: 100, y: 300, count: 1 }])
  })
  it('selects text by a long press and drag, or the word under a long press', () => {
    const t = createBrowserTouch()
    t.down(20, 30)
    expect(t.longPress()).toEqual([{ type: 'press', x: 20, y: 30 }])
    expect(t.move(24, 31)).toEqual([{ type: 'drag', x: 24, y: 31 }])
    expect(t.move(80, 31)).toEqual([{ type: 'drag', x: 80, y: 31 }])
    expect(t.up(80, 31, 900)).toEqual([{ type: 'release', x: 80, y: 31 }])
    t.down(20, 30)
    t.longPress()
    expect(t.up(21, 30, 2000)).toEqual([
      { type: 'release', x: 20, y: 30 },
      { type: 'click', x: 20, y: 30, count: 2 }
    ])
  })
  it('releases a held press when the touch is cancelled and ignores stray events', () => {
    const t = createBrowserTouch()
    expect(t.move(1, 1)).toEqual([])
    expect(t.up(1, 1, 0)).toEqual([])
    expect(t.longPress()).toEqual([])
    t.down(20, 30)
    t.longPress()
    t.move(60, 30)
    expect(t.cancel()).toEqual([{ type: 'release', x: 60, y: 30 }])
    t.down(20, 30)
    expect(t.cancel()).toEqual([])
    expect(t.mode).toBe('idle')
  })
})

describe('browser typing from the page input', () => {
  const pad = BROWSER_INPUT_PAD
  const back = { type: 'keyDown', key: 'Backspace', code: 'Backspace' }
  const backUp = { type: 'keyUp', key: 'Backspace', code: 'Backspace' }
  it('starts with text a phone keyboard can delete', () => expect(pad.length).toBeGreaterThan(0))
  it('sends what a keystroke added, never the whole field again', () => {
    expect(browserTyping(pad, pad + 'm')).toEqual([{ type: 'text', text: 'm' }])
    expect(browserTyping(pad + 'm', pad + 'mo')).toEqual([{ type: 'text', text: 'o' }])
    expect(browserTyping(pad + 'mo', pad + 'mo')).toEqual([])
  })
  it('turns a deletion into Backspace presses, a held key letting go once', () => {
    expect(browserTyping(pad + 'mo', pad + 'm')).toEqual([back, backUp])
    expect(browserTyping(pad, pad.slice(1))).toEqual([back, backUp])
    expect(browserTyping(pad + 'word', pad)).toEqual([back, back, back, back, backUp])
  })
  it('replays a correction or a mid-text edit from where the texts part', () => {
    expect(browserTyping(pad + 'teh', pad + 'the ')).toEqual([back, back, backUp, { type: 'text', text: 'he ' }])
    expect(browserTyping(pad + 'hello', pad + 'helXlo')).toEqual([back, back, backUp, { type: 'text', text: 'Xlo' }])
  })
  it('presses Enter for a line break a keyboard commits as text', () => {
    expect(browserTyping(pad, pad + 'ab\ncd\n')).toEqual([
      { type: 'text', text: 'ab' },
      { type: 'keyDown', key: 'Enter', code: 'Enter' },
      { type: 'keyUp', key: 'Enter', code: 'Enter' },
      { type: 'text', text: 'cd' },
      { type: 'keyDown', key: 'Enter', code: 'Enter' },
      { type: 'keyUp', key: 'Enter', code: 'Enter' }
    ])
  })
  it('deletes a character outside the BMP with one press', () => {
    expect(browserTyping(pad + 'a😀', pad + 'a')).toEqual([back, backUp])
    expect(browserTyping(pad + '😀', pad + '😁')).toEqual([back, backUp, { type: 'text', text: '😁' }])
  })
  it('bounds the presses one edit sends', () => {
    const sent = browserTyping('x'.repeat(500), '')
    expect(sent.filter((i) => i.type === 'keyDown')).toHaveLength(BROWSER_BACKSPACES_MAX)
    expect(sent.at(-1)).toEqual(backUp)
  })
  it('leaves keys the keyboard turns into text to the input event', () => {
    for (const e of [
      { key: 'Unidentified', keyCode: 229, isComposing: false },
      { key: 'Backspace', keyCode: 229, isComposing: false },
      { key: 'Process', keyCode: 229, isComposing: false },
      { key: 'Dead', keyCode: 222, isComposing: false },
      { key: 'a', keyCode: 65, isComposing: true }
    ])
      expect(browserImeKey(e)).toBe(true)
    for (const e of [
      { key: 'Backspace', keyCode: 8, isComposing: false },
      { key: 'Enter', keyCode: 13, isComposing: false },
      { key: 'a', keyCode: 65, isComposing: false }
    ])
      expect(browserImeKey(e)).toBe(false)
  })
})
