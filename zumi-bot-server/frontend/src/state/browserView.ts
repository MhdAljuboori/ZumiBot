import type { BrowserFrame, BrowserStatus, BrowserTarget } from '@zumibot/shared/browser'

export interface BrowserViewState {
  target: BrowserTarget | null
  open: boolean
  expanded: boolean
  visible: boolean
  status: BrowserStatus | null
  controlPending: boolean
  control: boolean
  connectionGeneration: number
  epoch: number
  error: string | null
}
export const initialBrowserView: BrowserViewState = {
  target: null,
  open: false,
  expanded: false,
  visible: true,
  status: null,
  controlPending: false,
  control: false,
  connectionGeneration: 0,
  epoch: 0,
  error: null
}
export type BrowserViewEvent =
  | { type: 'open'; target: BrowserTarget }
  | { type: 'close' | 'disconnect' | 'controlPending' | 'release' }
  | { type: 'visible'; visible: boolean }
  | { type: 'expanded'; expanded: boolean }
  | { type: 'status'; status: BrowserStatus }
  | { type: 'controlAck'; epoch: number }
  | { type: 'error'; error: string }
const reset = (s: BrowserViewState): BrowserViewState => ({ ...s, control: false, controlPending: false, epoch: s.epoch + 1 })
export function reduceBrowserView(s: BrowserViewState, e: BrowserViewEvent): BrowserViewState {
  switch (e.type) {
    case 'open':
      return { ...reset(s), target: e.target, open: true, expanded: false, status: null, error: null }
    case 'close':
      return { ...reset(s), target: null, open: false, status: null, expanded: false, error: null }
    case 'disconnect':
      return { ...reset(s), status: null, connectionGeneration: s.connectionGeneration + 1 }
    case 'visible':
      return { ...(e.visible ? s : { ...reset(s), status: null }), visible: e.visible }
    case 'expanded':
      return { ...s, expanded: e.expanded }
    case 'controlPending':
      return { ...reset(s), controlPending: true, error: null }
    case 'release':
      return reset(s)
    case 'error':
      return { ...reset(s), error: e.error }
    case 'controlAck':
      return e.epoch === s.epoch && s.controlPending && s.open && s.visible && s.status?.state === 'ready' && s.status.control === 'you'
        ? { ...s, control: true, controlPending: false }
        : s
    case 'status': {
      const changedGeneration = s.status !== null && s.status.generation !== e.status.generation
      const changedTab = s.status !== null && s.status.activeTabId !== e.status.activeTabId
      const lost = s.control && e.status.control !== 'you'
      const next =
        changedGeneration || lost || e.status.state !== 'ready'
          ? reset(s)
          : changedTab
            ? { ...reset(s), control: s.control && e.status.control === 'you' }
            : s
      return { ...next, status: e.status, error: e.status.error }
    }
  }
}

export function browserPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  width: number,
  height: number
): { x: number; y: number } | null {
  const scale = Math.min(rect.width / width, rect.height / height)
  if (!Number.isFinite(scale) || scale <= 0) return null
  const x = (clientX - rect.left - (rect.width - width * scale) / 2) / scale
  const y = (clientY - rect.top - (rect.height - height * scale) / 2) / scale
  return x < 0 || y < 0 || x >= width || y >= height ? null : { x, y }
}
export function browserPasteShortcut(e: { key: string; code?: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && (e.code === 'KeyV' || e.key.toLowerCase() === 'v')
}
export function browserKeyText(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  isComposing: boolean
  getModifierState?(key: string): boolean
}): string | null {
  if (e.isComposing || e.metaKey || [...e.key].length !== 1) return null
  const altGraph = e.getModifierState?.('AltGraph') === true
  if (e.ctrlKey && !altGraph) return null
  // Option can produce a different printable character; ordinary Alt+letter shortcuts stay remote.
  if (e.altKey && !altGraph && /^[a-z0-9]$/i.test(e.key)) return null
  return e.key
}
/**
 * A key event the keyboard turns into text or an edit itself: an IME's composition, a phone keyboard's 229, a dead key.
 * The page input's own input event carries what it did, so sending the key too would act twice.
 */
export function browserImeKey(e: { key: string; keyCode?: number; isComposing: boolean }): boolean {
  return e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Unidentified' || e.key === 'Dead'
}

/**
 * What the page input holds when it gets focus. A phone keyboard edits the text it believes is in the field: with some
 * there, its Backspace deletes a character (an input event) rather than doing nothing, and since the field is never
 * rewritten while typing, the keyboard never restarts, which closed and reopened it, or repeated its word, on every key.
 * Spaces, so the padding never joins a word the keyboard is composing.
 */
export const BROWSER_INPUT_PAD = ' '.repeat(32)
/** Past this the input goes back to the padding: one keyboard restart in thousands of characters. */
export const BROWSER_INPUT_MAX = 2000
/** Backspaces one edit may send: input is never queued, and a burst past the connection's bound would drop control. */
export const BROWSER_BACKSPACES_MAX = 64
export type BrowserTyping = { type: 'keyDown' | 'keyUp'; key: string; code: string } | { type: 'text'; text: string }
const ENTER = [
  { type: 'keyDown', key: 'Enter', code: 'Enter' },
  { type: 'keyUp', key: 'Enter', code: 'Enter' }
] as const
/**
 * What the page must receive for the page input to go from `before` to `after`. The page's caret sits where the input's
 * does, at the end, so whatever changed (a key, a correction, a suggestion, voice typing) is replayed from where the two
 * texts part: Backspaces back to there, then the new rest. Characters, not UTF-16 units, so one press deletes an emoji.
 */
export function browserTyping(before: string, after: string): BrowserTyping[] {
  const a = Array.from(before),
    b = Array.from(after)
  let same = 0
  while (same < a.length && same < b.length && a[same] === b[same]) same++
  const out: BrowserTyping[] = []
  const backspaces = Math.min(a.length - same, BROWSER_BACKSPACES_MAX)
  // A held key repeats its key down and lets go once.
  for (let i = 0; i < backspaces; i++) out.push({ type: 'keyDown', key: 'Backspace', code: 'Backspace' })
  if (backspaces) out.push({ type: 'keyUp', key: 'Backspace', code: 'Backspace' })
  // A keyboard may commit a line break as text; only Enter's key submits a form or breaks a line in the page.
  b.slice(same)
    .join('')
    .split(/\r\n|\r|\n/)
    .forEach((part, i) => {
      if (i) out.push(...ENTER)
      if (part) out.push({ type: 'text', text: part.slice(0, 16384) })
    })
  return out
}

/** Client-local shortcut only. Never keep paths, credentials, query strings or fragments. */
export function safeReopenOrigin(value: string): string | null {
  try {
    const u = new URL(value)
    return ['http:', 'https:'].includes(u.protocol) ? u.origin : null
  } catch {
    return null
  }
}

export interface BrowserImage {
  close(): void
}
/** One decode plus one newest pending JPEG. A retired decode can never paint a replacement page. */
export function createBrowserFrames<T extends BrowserImage>(o: {
  decode(frame: BrowserFrame): Promise<T>
  show(image: T | null, frame?: BrowserFrame): void
}) {
  let generation = '',
    tabId: string | null = null,
    epoch = 0,
    decoding = false,
    sequence = -1
  let queued: BrowserFrame | null = null,
    current: T | null = null
  const clear = (): void => {
    epoch++
    queued = null
    sequence = -1
    current?.close()
    current = null
    o.show(null)
  }
  const matches = (f: BrowserFrame): boolean => f.generation === generation && f.tabId === tabId
  const run = async (f: BrowserFrame): Promise<void> => {
    decoding = true
    const before = epoch
    try {
      const image = await o.decode(f)
      if (before !== epoch || !matches(f)) image.close()
      else {
        current?.close()
        current = image
        o.show(image, f)
      }
    } catch {
      /* A corrupt/dropped frame must not retain an unbounded retry queue. */
    } finally {
      decoding = false
      const next = queued
      queued = null
      if (next && matches(next)) void run(next)
    }
  }
  return {
    page(status: BrowserStatus | null) {
      const g = status?.state === 'ready' ? status.generation : '',
        t = status?.state === 'ready' ? status.activeTabId : null
      if (generation !== g || tabId !== t) {
        generation = g
        tabId = t
        clear()
      }
    },
    push(frame: BrowserFrame) {
      if (!matches(frame) || frame.sequence <= sequence) return
      sequence = frame.sequence
      if (decoding) queued = frame
      else void run(frame)
    },
    clear() {
      generation = ''
      tabId = null
      clear()
    }
  }
}

/** Page pixels per screen pixel of the letterboxed picture; scroll distances divide by it. */
export function browserScale(rect: Pick<DOMRect, 'width' | 'height'>, width: number, height: number): number {
  const scale = Math.min(rect.width / width, rect.height / height)
  return Number.isFinite(scale) && scale > 0 ? scale : 1
}

export type BrowserClick = { x: number; y: number; t: number; button: string; count: number }
/** CDP needs the click count itself: a second press soon after, near the first, selects a word and a third a line. */
export function nextClickCount(prev: BrowserClick | null, x: number, y: number, t: number, button: string, slop = 5, ms = 500): number {
  if (!prev || prev.button !== button || t - prev.t > ms || Math.hypot(x - prev.x, y - prev.y) > slop) return 1
  return prev.count >= 3 ? 1 : prev.count + 1
}

/** Screen coordinates; the panel maps them to the page. */
export type BrowserTouchAction =
  | { type: 'click'; x: number; y: number; count: number }
  | { type: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { type: 'press' | 'drag' | 'release'; x: number; y: number }
export const BROWSER_LONG_PRESS_MS = 450
/**
 * One finger on a phone: a tap clicks (taps in a row count up), a drag scrolls the page, and a long press then drag
 * selects text, with a long press alone selecting the word under it. Mouse and pen keep plain mouse events.
 */
export function createBrowserTouch(o: { slop?: number; tapMs?: number; tapSlop?: number } = {}) {
  const slop = o.slop ?? 10,
    tapMs = o.tapMs ?? 350,
    tapSlop = o.tapSlop ?? 24
  let mode: 'idle' | 'pending' | 'scroll' | 'select' = 'idle',
    moved = false
  let start = { x: 0, y: 0 },
    last = { x: 0, y: 0 },
    tap: BrowserClick | null = null
  return {
    get mode() {
      return mode
    },
    down(x: number, y: number): BrowserTouchAction[] {
      mode = 'pending'
      moved = false
      start = last = { x, y }
      return []
    },
    move(x: number, y: number): BrowserTouchAction[] {
      if (mode === 'idle') return []
      if (mode === 'pending' && Math.hypot(x - start.x, y - start.y) <= slop) return []
      const from = last
      last = { x, y }
      if (mode === 'select') {
        if (Math.hypot(x - start.x, y - start.y) > slop) moved = true
        return [{ type: 'drag', x, y }]
      }
      mode = 'scroll'
      // Content follows the finger, so the page scrolls against it.
      return [{ type: 'scroll', x: start.x, y: start.y, dx: from.x - x, dy: from.y - y }]
    },
    longPress(): BrowserTouchAction[] {
      if (mode !== 'pending') return []
      mode = 'select'
      return [{ type: 'press', ...start }]
    },
    up(x: number, y: number, t: number): BrowserTouchAction[] {
      const was = mode
      mode = 'idle'
      if (was === 'pending') {
        const count = nextClickCount(tap, start.x, start.y, t, 'left', tapSlop, tapMs)
        tap = { ...start, t, button: 'left', count }
        return [{ type: 'click', ...start, count }]
      }
      tap = null
      if (was === 'select')
        return moved
          ? [{ type: 'release', x, y }]
          : [
              { type: 'release', ...start },
              { type: 'click', ...start, count: 2 }
            ]
      return []
    },
    cancel(): BrowserTouchAction[] {
      const was = mode
      mode = 'idle'
      tap = null
      return was === 'select' ? [{ type: 'release', ...last }] : []
    }
  }
}
