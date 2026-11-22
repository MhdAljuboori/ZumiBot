import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@zumibot/shared/types'
import {
  desktopApprovalPending,
  desktopCardOffer,
  desktopStatusLine,
  initialDesktopView,
  markerPosition,
  mustRelease,
  PASTE_MAX,
  pasteText,
  PASTE_TOO_LARGE,
  reduceDesktopView,
  takeControlEnabled,
  type DesktopViewState
} from '../src/state/desktopView'
import type { DesktopStatus } from '@zumibot/shared/desktop'

const ready: DesktopStatus = {
  agent: 'a',
  profileId: 'p',
  generation: 'g',
  state: 'ready',
  control: 'agent',
  pendingRequestId: null,
  error: null,
  width: 1280,
  height: 800,
  busy: false
}
const open = () => reduceDesktopView(initialDesktopView, { type: 'open', target: { agent: 'a', chatId: 'c' } })
const controlling = (): DesktopViewState => {
  let s = reduceDesktopView(open(), { type: 'status', status: ready })
  s = reduceDesktopView(s, { type: 'controlRequested' })
  return reduceDesktopView(s, { type: 'status', status: { ...ready, control: 'you' } })
}
const line = (s: DesktopViewState) => desktopStatusLine(s)
const withStatus = (patch: Partial<DesktopStatus>, s = open()) => reduceDesktopView(s, { type: 'status', status: { ...ready, ...patch } })

describe('desktop view reducer', () => {
  it('open sets target and clears control', () => {
    const s = reduceDesktopView(controlling(), { type: 'open', target: { agent: 'b' }, marker: { x: 5, y: 6 } })
    expect(s).toMatchObject({
      open: true,
      target: { agent: 'b' },
      control: false,
      controlPending: false,
      status: null,
      rfb: null,
      marker: { x: 5, y: 6 }
    })
    expect(open().marker).toBe(null)
  })
  it('control comes only after the server says you, and the marker clears on request', () => {
    let s = reduceDesktopView(open(), { type: 'open', target: { agent: 'a' }, marker: { x: 1, y: 1 } })
    s = reduceDesktopView(s, { type: 'status', status: ready })
    s = reduceDesktopView(s, { type: 'controlRequested' })
    expect(s).toMatchObject({ controlPending: true, control: false, marker: null })
    s = reduceDesktopView(s, { type: 'status', status: { ...ready, control: 'pausing' } })
    expect(s).toMatchObject({ controlPending: true, control: false })
    s = reduceDesktopView(s, { type: 'status', status: { ...ready, control: 'you' } })
    expect(s).toMatchObject({ controlPending: false, control: true })
    expect(reduceDesktopView(s, { type: 'controlReleased' }).control).toBe(false)
  })
  it('status other drops local control', () => {
    expect(controlling().control).toBe(true)
    const s = withStatus({ control: 'other' }, controlling())
    expect(s).toMatchObject({ control: false, controlPending: false })
    expect(withStatus({ control: 'other' }, reduceDesktopView(withStatus({}), { type: 'controlRequested' })).controlPending).toBe(false)
  })
  it('rfb open bumps n so the panel remounts noVNC per leg, and closed clears it', () => {
    let s = reduceDesktopView(open(), { type: 'rfb', state: 'open', generation: 'g' })
    expect(s.rfb).toEqual({ generation: 'g', n: 1 })
    s = reduceDesktopView(s, { type: 'rfb', state: 'open', generation: 'g' })
    expect(s.rfb).toEqual({ generation: 'g', n: 2 })
    expect(reduceDesktopView(s, { type: 'rfb', state: 'closed', generation: 'g' }).rfb).toBe(null)
  })
  it('generation change while controlling drops control', () => {
    const s = withStatus({ generation: 'g2', control: 'you' }, controlling())
    expect(s).toMatchObject({ control: false, controlPending: false })
    expect(s.status?.generation).toBe('g2')
  })
  it('generation change while pending drops the request', () => {
    const pending = reduceDesktopView(withStatus({}), { type: 'controlRequested' })
    expect(withStatus({ generation: 'g2' }, pending).controlPending).toBe(false)
  })
  it('visible false keeps target and status but marks hidden and ends control', () => {
    const s = reduceDesktopView(controlling(), { type: 'visible', visible: false })
    expect(s).toMatchObject({ visible: false, open: true, target: { agent: 'a', chatId: 'c' }, control: false })
    expect(s.status).not.toBe(null)
    expect(reduceDesktopView(s, { type: 'visible', visible: true }).visible).toBe(true)
  })
  it('a late you after the page hid mid-request is not control (the hook releases it)', () => {
    let s = reduceDesktopView(withStatus({}), { type: 'controlRequested' })
    s = reduceDesktopView(s, { type: 'visible', visible: false })
    s = reduceDesktopView(s, { type: 'visible', visible: true })
    s = reduceDesktopView(s, { type: 'status', status: { ...ready, control: 'you' } })
    expect(s).toMatchObject({ control: false, controlPending: false })
    expect(line(s)).toBe('Idle')
    // The same after a release the server had not seen yet.
    const released = reduceDesktopView(reduceDesktopView(controlling(), { type: 'controlReleased' }), {
      type: 'status',
      status: { ...ready, control: 'you', busy: true }
    })
    expect(released.control).toBe(false)
    expect(line(released)).toBe('Agent working')
  })
  it('a closed leg ends control: the watch behind it was replaced or ended', () => {
    const open1 = reduceDesktopView(controlling(), { type: 'rfb', state: 'open', generation: 'g' })
    expect(open1.control).toBe(true)
    const closed = reduceDesktopView(open1, { type: 'rfb', state: 'closed', generation: 'g' })
    expect(closed).toMatchObject({ control: false, controlPending: false, rfb: null })
    const pending = reduceDesktopView(reduceDesktopView(withStatus({}), { type: 'controlRequested' }), {
      type: 'rfb',
      state: 'closed',
      generation: 'g'
    })
    expect(pending.controlPending).toBe(false)
    // A server 'you' after that is released, not taken.
    expect(mustRelease(closed, { ...ready, control: 'you' })).toBe(true)
  })
  it('disconnect and close reset the connection state', () => {
    const d = reduceDesktopView(controlling(), { type: 'disconnect' })
    expect(d).toMatchObject({ status: null, control: false, rfb: null, open: true })
    expect(line(d)).toBe('Disconnected')
    expect(reduceDesktopView(controlling(), { type: 'close' })).toEqual(initialDesktopView)
  })
  it('an error ends control and a later status clears it', () => {
    const e = reduceDesktopView(controlling(), { type: 'error', error: 'boom' })
    expect(e).toMatchObject({ error: 'boom', control: false })
    expect(withStatus({}, e).error).toBe(null)
  })
})

describe('desktopStatusLine', () => {
  it('says what is going on', () => {
    expect(line(open())).toBe('Starting…')
    expect(line(withStatus({ state: 'starting' }))).toBe('Starting…')
    expect(line(withStatus({ state: 'queued' }))).toBe('Waiting for a desktop…')
    expect(line(withStatus({ state: 'stopped' }))).toBe('Idle')
    expect(line(withStatus({ busy: true }))).toBe('Agent working')
    expect(line(withStatus({}))).toBe('Idle')
    // A pending handoff is the user's turn, whatever busy says.
    expect(line(withStatus({ pendingRequestId: 'r' }))).toBe('Waiting for you')
    expect(line(withStatus({ pendingRequestId: 'r', busy: true }))).toBe('Waiting for you')
    expect(line(withStatus({ control: 'pausing' }))).toBe('Pausing agent…')
    expect(line(reduceDesktopView(withStatus({}), { type: 'controlRequested' }))).toBe('Pausing agent…')
    expect(line(controlling())).toBe('You have control')
    expect(line(withStatus({ control: 'other' }))).toBe('Controlled in another window')
    expect(line(withStatus({ state: 'off' }))).toBe('Computer use is off for this agent')
  })
  it('says when a desktop action waits for approval, after the handoff and before busy', () => {
    const line2 = (s: DesktopViewState) => desktopStatusLine(s, true)
    expect(line2(withStatus({}))).toBe('Waiting for approval')
    expect(line2(withStatus({ busy: true }))).toBe('Waiting for approval')
    expect(line2(withStatus({ state: 'stopped' }))).toBe('Waiting for approval')
    expect(line2(withStatus({ pendingRequestId: 'r' }))).toBe('Waiting for you')
    expect(line2(withStatus({ control: 'pausing' }))).toBe('Pausing agent…')
    expect(line2(withStatus({ control: 'other' }))).toBe('Controlled in another window')
    expect(line2(controlling())).toBe('You have control')
    expect(line2(withStatus({ state: 'off' }))).toBe('Computer use is off for this agent')
    expect(line2(withStatus({ state: 'unavailable', missing: ['Xvnc'] }))).toBe('Desktop unavailable on this server (missing: Xvnc)')
    expect(line2(withStatus({ state: 'starting' }))).toBe('Starting…')
    expect(desktopStatusLine(withStatus({}), false)).toBe('Idle')
  })
  it('names the missing programs', () => {
    expect(line(withStatus({ state: 'unavailable' }))).toBe('Desktop unavailable on this server')
    expect(line(withStatus({ state: 'unavailable', missing: ['Xvnc', 'cua-driver'] }))).toBe(
      'Desktop unavailable on this server (missing: Xvnc, cua-driver)'
    )
  })
})

describe('markerPosition', () => {
  const desktop = { width: 1280, height: 800 }
  it('letterboxes a 1280x800 desktop in a 640x600 box', () => {
    // scale 0.5, picture 640x400, centered with 100px bars above and below
    expect(markerPosition({ x: 0, y: 0 }, desktop, { width: 640, height: 600 })).toEqual({ left: 0, top: 100 })
    expect(markerPosition({ x: 640, y: 400 }, desktop, { width: 640, height: 600 })).toEqual({ left: 320, top: 300 })
  })
  it('centers sideways when the box is wider', () => {
    expect(markerPosition({ x: 0, y: 0 }, desktop, { width: 1000, height: 400 })).toEqual({ left: 180, top: 0 })
  })
  it('is null outside the desktop or with bad sizes', () => {
    expect(markerPosition({ x: 1280, y: 0 }, desktop, { width: 640, height: 600 })).toBe(null)
    expect(markerPosition({ x: -1, y: 0 }, desktop, { width: 640, height: 600 })).toBe(null)
    expect(markerPosition({ x: 0, y: 800 }, desktop, { width: 640, height: 600 })).toBe(null)
    expect(markerPosition({ x: 1, y: 1 }, desktop, { width: 0, height: 600 })).toBe(null)
    expect(markerPosition({ x: 1, y: 1 }, { width: 0, height: 800 }, { width: 640, height: 600 })).toBe(null)
    expect(markerPosition({ x: NaN, y: 1 }, desktop, { width: 640, height: 600 })).toBe(null)
  })
})

describe('mustRelease', () => {
  it('is true only for a you this window does not hold or ask for', () => {
    expect(mustRelease(withStatus({}), { ...ready, control: 'you' })).toBe(true)
    expect(mustRelease(withStatus({}), ready)).toBe(false)
    expect(mustRelease(withStatus({}), { ...ready, control: 'pausing' })).toBe(false)
    expect(mustRelease(controlling(), { ...ready, control: 'you' })).toBe(false)
    expect(mustRelease(reduceDesktopView(withStatus({}), { type: 'controlRequested' }), { ...ready, control: 'you' })).toBe(false)
  })
  it('after the reducer: a granted request is kept, a late you after a release is let go', () => {
    const pending = reduceDesktopView(withStatus({}), { type: 'controlRequested' })
    const granted = reduceDesktopView(pending, { type: 'status', status: { ...ready, control: 'you' } })
    expect(mustRelease(granted, { ...ready, control: 'you' })).toBe(false)
    const released = reduceDesktopView(reduceDesktopView(controlling(), { type: 'controlReleased' }), {
      type: 'status',
      status: { ...ready, control: 'you' }
    })
    expect(mustRelease(released, { ...ready, control: 'you' })).toBe(true)
  })
})

describe('takeControlEnabled', () => {
  it('is off until the desktop is ready', () => {
    expect(takeControlEnabled(open())).toBe(false)
    expect(takeControlEnabled(withStatus({ state: 'starting' }))).toBe(false)
    expect(takeControlEnabled(withStatus({ state: 'stopped' }))).toBe(false)
    expect(takeControlEnabled(withStatus({}))).toBe(true)
  })
  it('is off while another window holds or is taking control', () => {
    expect(takeControlEnabled(withStatus({ control: 'other' }))).toBe(false)
    expect(takeControlEnabled(withStatus({ control: 'pausing' }))).toBe(false)
  })
  it('stays on for this window, so its own request can be cancelled and its control released', () => {
    const pending = reduceDesktopView(withStatus({}), { type: 'controlRequested' })
    expect(takeControlEnabled(reduceDesktopView(pending, { type: 'status', status: { ...ready, control: 'pausing' } }))).toBe(true)
    expect(takeControlEnabled(controlling())).toBe(true)
  })
})

describe('desktopApprovalPending', () => {
  const approval = (patch: Partial<Extract<ChatItem, { type: 'approval' }>>): ChatItem => ({
    type: 'approval',
    id: 'r',
    toolUseId: null,
    toolName: 'mcp__zumibot_desktop__desktop_click',
    input: {},
    description: null,
    reason: null,
    status: 'pending',
    ts: 1,
    ...patch
  })
  it('finds a pending desktop approval of that agent in a room', () => {
    expect(desktopApprovalPending([approval({ agent: 'a' })], 'a')).toBe(true)
    expect(desktopApprovalPending([approval({ agent: 'b' })], 'a')).toBe(false)
  })
  it('in a single chat, items without an agent are the chat agent’s', () => {
    expect(desktopApprovalPending([approval({})], 'a', 'a')).toBe(true)
    expect(desktopApprovalPending([approval({})], 'a', 'b')).toBe(false)
    expect(desktopApprovalPending([approval({})], 'a')).toBe(false)
  })
  it('ignores answered cards and other tools', () => {
    expect(desktopApprovalPending([approval({ agent: 'a', status: 'allowed-once' })], 'a')).toBe(false)
    expect(desktopApprovalPending([approval({ agent: 'a', toolName: 'mcp__zumibot_browser__browser_click' })], 'a')).toBe(false)
    expect(desktopApprovalPending([approval({ agent: 'a', toolName: 'Bash' })], 'a')).toBe(false)
    expect(desktopApprovalPending([], 'a')).toBe(false)
  })
})

describe('desktopCardOffer', () => {
  const t = (name: string) => `mcp__zumibot_desktop__${name}`
  it('marks the point of a pointer action', () => {
    expect(desktopCardOffer(t('desktop_click'), { x: 1, y: 2 })).toEqual({ point: { x: 1, y: 2 } })
    expect(desktopCardOffer(t('desktop_drag'), { fromX: 3, fromY: 4, toX: 5, toY: 6 })).toEqual({ point: { x: 3, y: 4 } })
  })
  it('opens the desktop without a mark for every other desktop call', () => {
    expect(desktopCardOffer(t('desktop_type'), { text: 'hi' })).toEqual({ point: null })
    expect(desktopCardOffer(t('desktop_key'), { keys: ['Return'] })).toEqual({ point: null })
    expect(desktopCardOffer(t('desktop_launch'), { name: 'mousepad' })).toEqual({ point: null })
    expect(desktopCardOffer(t('desktop_focus'), { windowId: 5 })).toEqual({ point: null })
    expect(desktopCardOffer(t('desktop_click'), { element: 'e1' })).toEqual({ point: null })
    expect(desktopCardOffer(t('desktop_screenshot'), {})).toEqual({ point: null })
  })
  it('offers nothing for other tools', () => {
    expect(desktopCardOffer('mcp__zumibot_browser__browser_click', { x: 1, y: 2 })).toBeNull()
    expect(desktopCardOffer('Bash', { command: 'ls' })).toBeNull()
  })
})

describe('pasteText', () => {
  const data = (values: Record<string, string>) => ({ getData: (type: string) => values[type] ?? '' })
  it('takes the plain text', () => {
    expect(pasteText(data({ 'text/plain': 'user@example.com' }), 100)).toEqual({ text: 'user@example.com' })
    expect(pasteText(data({ 'text/plain': 'مرحبا' }), 10)).toEqual({ text: 'مرحبا' })
  })
  it('has nothing to send without plain text', () => {
    expect(pasteText(null, 100)).toBeNull()
    expect(pasteText(data({}), 100)).toBeNull()
    expect(pasteText(data({ 'text/html': '<b>x</b>' }), 100)).toBeNull()
  })
  it('refuses text past the limit in UTF-8 bytes, never cutting it', () => {
    expect(pasteText(data({ 'text/plain': 'x'.repeat(10) }), 10)).toEqual({ text: 'x'.repeat(10) })
    expect(pasteText(data({ 'text/plain': 'x'.repeat(11) }), 10)).toEqual({ error: PASTE_TOO_LARGE })
    // Five Arabic letters are ten bytes.
    expect(pasteText(data({ 'text/plain': 'مرحبا' }), 9)).toEqual({ error: PASTE_TOO_LARGE })
    expect(PASTE_TOO_LARGE).toBe('Paste too large')
  })
  it("stays under Xvnc's default 256 KiB cut-text limit, which would drop a larger paste silently", () => {
    expect(PASTE_MAX).toBe(256 * 1024 - 1024)
    expect(pasteText(data({ 'text/plain': 'x'.repeat(PASTE_MAX) }), PASTE_MAX)).toEqual({ text: 'x'.repeat(PASTE_MAX) })
    expect(pasteText(data({ 'text/plain': 'x'.repeat(PASTE_MAX + 1) }), PASTE_MAX)).toEqual({ error: PASTE_TOO_LARGE })
  })
  it('refuses an over-long text before encoding it', () => {
    const original = TextEncoder.prototype.encode
    let encoded = 0
    TextEncoder.prototype.encode = function (this: TextEncoder, input?: string) {
      encoded++
      return original.call(this, input)
    }
    try {
      expect(pasteText(data({ 'text/plain': 'x'.repeat(11) }), 10)).toEqual({ error: PASTE_TOO_LARGE })
      expect(encoded).toBe(0)
    } finally {
      TextEncoder.prototype.encode = original
    }
  })
})
