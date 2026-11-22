import { describe, expect, it } from 'vitest'
import {
  boundDesktopStatus,
  DESKTOP_ACTION_TOOLS,
  DESKTOP_LOOK_TOOLS,
  desktopActionSummary,
  desktopPoint,
  desktopToolName,
  parseDesktopCommand,
  parseDesktopRequest,
  type DesktopServerMessage,
  type DesktopStatus
} from '../src/desktop'

const stamp = { generation: 'g1', epoch: 3, observationId: 'o1' }
const t = (n: string) => desktopToolName(n)

describe('parseDesktopCommand', () => {
  it.each([
    { op: 'screenshot' },
    { op: 'windows' },
    { op: 'apps' },
    { op: 'windowState', windowId: 37748739 },
    { op: 'zoom', windowId: 12, x1: 0, y1: 0, x2: 400, y2: 300 },
    { op: 'click', stamp, x: 10, y: 20 },
    { op: 'click', stamp, element: 'e1', button: 'right', count: 2, modifiers: ['ctrl', 'shift'] },
    { op: 'drag', stamp, fromX: 1, fromY: 2, toX: 30, toY: 40 },
    { op: 'scroll', stamp, x: 5, y: 6, direction: 'down' },
    { op: 'scroll', stamp, x: 5, y: 6, direction: 'left', amount: 20 },
    { op: 'move', stamp, x: 5, y: 6 },
    { op: 'type', stamp, text: 'hello' },
    { op: 'type', stamp, text: 'hi', element: 'e2' },
    { op: 'key', stamp, keys: ['ctrl', 's'] },
    { op: 'launch', stamp, name: 'firefox' },
    { op: 'focus', stamp, windowId: 1 },
    { op: 'requestUserAction', reason: 'Please sign in' },
    { op: 'release' }
  ])('accepts %j', (c) => expect(parseDesktopCommand(c)).toEqual(c))

  it('click needs exactly one of a point or an element', () => {
    expect(() => parseDesktopCommand({ op: 'click', stamp, x: 1 })).toThrow('Invalid desktop message')
    expect(() => parseDesktopCommand({ op: 'click', stamp })).toThrow()
    expect(() => parseDesktopCommand({ op: 'click', stamp, x: 1, y: 2, element: 'e1' })).toThrow()
    expect(parseDesktopCommand({ op: 'click', stamp, element: 'e1' })).toEqual({ op: 'click', stamp, element: 'e1' })
  })

  it('coordinates are bounded', () => {
    for (const bad of [-1, 1920, NaN, Infinity, '5']) expect(() => parseDesktopCommand({ op: 'move', stamp, x: bad, y: 0 })).toThrow()
    for (const bad of [-1, 1080, NaN]) expect(() => parseDesktopCommand({ op: 'move', stamp, x: 0, y: bad })).toThrow()
    expect(parseDesktopCommand({ op: 'move', stamp, x: 1919, y: 1079 })).toBeTruthy()
    expect(() => parseDesktopCommand({ op: 'drag', stamp, fromX: 0, fromY: 0, toX: 1920, toY: 0 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'zoom', windowId: 1, x1: 0, y1: 0, x2: 1921, y2: 5 })).toThrow()
  })

  it('stamp fields are checked', () => {
    expect(() => parseDesktopCommand({ op: 'move', stamp: { ...stamp, epoch: -1 }, x: 0, y: 0 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'move', stamp: { ...stamp, epoch: 1.5 }, x: 0, y: 0 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'move', stamp: { ...stamp, generation: '../x' }, x: 0, y: 0 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'move', stamp: { ...stamp, extra: 1 }, x: 0, y: 0 })).toThrow()
    expect(parseDesktopCommand({ op: 'move', stamp: { ...stamp, epoch: 0 }, x: 0, y: 0 })).toBeTruthy()
  })

  it('click and scroll options are checked', () => {
    expect(() => parseDesktopCommand({ op: 'click', stamp, x: 1, y: 1, count: 3 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'click', stamp, x: 1, y: 1, button: 'back' })).toThrow()
    expect(() => parseDesktopCommand({ op: 'click', stamp, x: 1, y: 1, modifiers: ['meta'] })).toThrow()
    expect(() => parseDesktopCommand({ op: 'scroll', stamp, x: 1, y: 1, direction: 'up', amount: 0 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'scroll', stamp, x: 1, y: 1, direction: 'up', amount: 21 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'scroll', stamp, x: 1, y: 1, direction: 'up', amount: 1.5 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'scroll', stamp, x: 1, y: 1, direction: 'sideways' })).toThrow()
  })

  it('type text limit', () => {
    expect(parseDesktopCommand({ op: 'type', stamp, text: 'x'.repeat(16384) })).toBeTruthy()
    expect(() => parseDesktopCommand({ op: 'type', stamp, text: 'x'.repeat(16385) })).toThrow()
    expect(parseDesktopCommand({ op: 'type', stamp, text: 'مرحبا' })).toEqual({ op: 'type', stamp, text: 'مرحبا' })
  })

  it('key accepts 1 to 5 keys of 1..32 chars', () => {
    expect(parseDesktopCommand({ op: 'key', stamp, keys: ['Return'] })).toBeTruthy()
    expect(parseDesktopCommand({ op: 'key', stamp, keys: ['a', 'b', 'c', 'd', 'e'] })).toBeTruthy()
    expect(parseDesktopCommand({ op: 'key', stamp, keys: ['x'.repeat(32)] })).toBeTruthy()
    expect(() => parseDesktopCommand({ op: 'key', stamp, keys: [] })).toThrow()
    expect(() => parseDesktopCommand({ op: 'key', stamp, keys: ['a', 'b', 'c', 'd', 'e', 'f'] })).toThrow()
    expect(() => parseDesktopCommand({ op: 'key', stamp, keys: [''] })).toThrow()
    expect(() => parseDesktopCommand({ op: 'key', stamp, keys: ['x'.repeat(33)] })).toThrow()
    expect(() => parseDesktopCommand({ op: 'key', stamp, keys: 'ctrl' })).toThrow()
  })

  it('window ids are positive integers', () => {
    for (const bad of ['w12', '12', 0, -1, 1.5, NaN, null, undefined]) {
      expect(() => parseDesktopCommand({ op: 'windowState', windowId: bad })).toThrow('Invalid desktop message')
      expect(() => parseDesktopCommand({ op: 'focus', stamp, windowId: bad })).toThrow()
      expect(() => parseDesktopCommand({ op: 'zoom', windowId: bad, x1: 0, y1: 0, x2: 5, y2: 5 })).toThrow()
    }
    expect(() => parseDesktopCommand({ op: 'windowState' })).toThrow()
  })

  it('zoom needs a window and a non-empty region', () => {
    expect(() => parseDesktopCommand({ op: 'zoom', x1: 0, y1: 0, x2: 5, y2: 5 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'zoom', windowId: 1, x1: 5, y1: 0, x2: 5, y2: 5 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'zoom', windowId: 1, x1: 9, y1: 0, x2: 5, y2: 5 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'zoom', windowId: 1, x1: 0, y1: 5, x2: 5, y2: 5 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'zoom', windowId: 1, x1: 0, y1: 0, x2: 5, y2: 5, stamp })).toThrow()
  })

  it('element ids and requested names are checked', () => {
    for (const bad of ['', 'a b', '../x', 's00000001:3', 'e'.repeat(129), 5]) {
      expect(() => parseDesktopCommand({ op: 'click', stamp, element: bad })).toThrow()
      expect(() => parseDesktopCommand({ op: 'type', stamp, text: 'a', element: bad })).toThrow()
    }
    expect(() => parseDesktopCommand({ op: 'launch', stamp, name: 'x'.repeat(257) })).toThrow()
    expect(() => parseDesktopCommand({ op: 'launch', stamp, name: '' })).toThrow()
    expect(parseDesktopCommand({ op: 'launch', stamp, name: 'x'.repeat(256) })).toBeTruthy()
  })

  it('duplicate modifiers are refused', () => {
    expect(() => parseDesktopCommand({ op: 'click', stamp, x: 1, y: 1, modifiers: ['ctrl', 'ctrl'] })).toThrow()
    expect(() => parseDesktopCommand({ op: 'click', stamp, x: 1, y: 1, modifiers: 'ctrl' })).toThrow()
    expect(parseDesktopCommand({ op: 'click', stamp, x: 1, y: 1, modifiers: ['ctrl', 'alt', 'shift', 'super'] })).toBeTruthy()
  })

  it('extra fields rejected', () => {
    expect(() => parseDesktopCommand({ op: 'screenshot', x: 1 })).toThrow('Invalid desktop message')
    expect(() => parseDesktopCommand({ op: 'release', secret: 1 })).toThrow()
    expect(() => parseDesktopCommand({ op: 'type', stamp, text: 'a', x: 1 })).toThrow()
  })

  it('rejects unknown ops and non-objects', () => {
    for (const bad of [
      null,
      [],
      'screenshot',
      {},
      { op: 'eval' },
      { op: 'requestUserAction', reason: 'x'.repeat(501) },
      { op: 'requestUserAction', reason: '' }
    ]) {
      expect(() => parseDesktopCommand(bad)).toThrow('Invalid desktop message')
    }
    expect(() => parseDesktopCommand({ op: 'launch', stamp, name: 'a\0b' })).toThrow()
  })
})

describe('parseDesktopRequest', () => {
  const target = { agent: 'a', chatId: 'c1', requestId: 'r1' }
  it.each([
    { id: 1, op: 'watch', target },
    { id: 2, op: 'watch', target: { agent: 'a' } },
    { id: 3, op: 'unwatch' },
    { id: 4, op: 'takeControl' },
    { id: 5, op: 'releaseControl' },
    { id: 6, op: 'answer', target, requestId: 'r1', decision: 'done' },
    { id: 7, op: 'answer', target, requestId: 'r1', decision: 'cancel' }
  ])('accepts %j', (r) => expect(parseDesktopRequest(r)).toEqual(r))

  it.each([
    { id: 1, op: 'nope' },
    { id: -1, op: 'unwatch' },
    { op: 'unwatch' },
    { id: 1, op: 'unwatch', extra: 1 },
    { id: 1, op: 'watch', target: { agent: '' } },
    { id: 1, op: 'watch', target: { agent: 'a', chatId: '../x' } },
    { id: 1, op: 'answer', target, requestId: 'r1', decision: 'maybe' },
    { id: 1, op: 'answer', target, decision: 'done' }
  ])('rejects %j', (r) => expect(() => parseDesktopRequest(r)).toThrow('Invalid desktop message'))

  it('request and target ids must match the id format', () => {
    for (const bad of ['', 'a b', 'x/y', 'r'.repeat(129), 5, null]) {
      expect(() => parseDesktopRequest({ id: 1, op: 'answer', target, requestId: bad, decision: 'done' })).toThrow()
      expect(() => parseDesktopRequest({ id: 1, op: 'watch', target: { agent: 'a', requestId: bad } })).toThrow()
    }
    expect(() => parseDesktopRequest({ id: 1.5, op: 'unwatch' })).toThrow()
    expect(() => parseDesktopRequest({ id: '1', op: 'unwatch' })).toThrow()
    expect(() => parseDesktopRequest({ id: 1, op: 'watch', target: { agent: 'a'.repeat(129) } })).toThrow()
  })
})

describe('tool names', () => {
  it('builds CLI-visible names', () => {
    expect(desktopToolName('desktop_click')).toBe('mcp__zumibot_desktop__desktop_click')
    expect(DESKTOP_ACTION_TOOLS).toHaveLength(8)
    expect(DESKTOP_ACTION_TOOLS).toContain('desktop_type')
    expect(DESKTOP_LOOK_TOOLS).toContain('desktop_screenshot')
    expect(DESKTOP_ACTION_TOOLS.filter((n) => DESKTOP_LOOK_TOOLS.includes(n))).toEqual([])
  })
})

describe('desktopActionSummary', () => {
  it.each([
    ['desktop_click', { x: 412, y: 300, count: 2, button: 'right' }, 'Click at 412, 300 (double, right button)'],
    ['desktop_click', { x: 1, y: 2 }, 'Click at 1, 2'],
    ['desktop_click', { x: 1, y: 2, button: 'middle' }, 'Click at 1, 2 (middle button)'],
    ['desktop_click', { element: 'e4' }, 'Click element e4'],
    ['desktop_type', { text: 'hello world' }, 'Type: hello world'],
    ['desktop_key', { keys: ['ctrl', 's'] }, 'Press Ctrl+S'],
    ['desktop_key', { keys: ['Return'] }, 'Press Return'],
    ['desktop_launch', { name: 'firefox' }, 'Launch firefox'],
    ['desktop_drag', { fromX: 10, fromY: 10, toX: 200, toY: 200 }, 'Drag from 10, 10 to 200, 200'],
    ['desktop_scroll', { x: 400, y: 300, direction: 'down' }, 'Scroll down 3 at 400, 300'],
    ['desktop_scroll', { x: 400, y: 300, direction: 'up', amount: 5 }, 'Scroll up 5 at 400, 300'],
    ['desktop_move', { x: 5, y: 5 }, 'Move pointer to 5, 5'],
    ['desktop_focus', { windowId: 12 }, 'Bring window 12 to front']
  ])('%s %j', (name, input, expected) => expect(desktopActionSummary(t(name), input)).toBe(expected))

  it('cuts long typed text', () => {
    const s = desktopActionSummary(t('desktop_type'), { text: 'x'.repeat(300) })!
    expect(s).toBe(`Type: ${'x'.repeat(200)}…`)
  })

  it('cuts every interpolated string at 200 characters', () => {
    const long = 'y'.repeat(500),
      cut = `${'y'.repeat(200)}…`
    expect(desktopActionSummary(t('desktop_click'), { element: long })).toBe(`Click element ${cut}`)
    expect(desktopActionSummary(t('desktop_launch'), { name: long })).toBe(`Launch ${cut}`)
    expect(desktopActionSummary(t('desktop_scroll'), { x: 1, y: 2, direction: long })).toBe(`Scroll ${cut} 3 at 1, 2`)
    expect(desktopActionSummary(t('desktop_key'), { keys: [long] })).toBe(`Press ${'Y'.repeat(1)}${'y'.repeat(199)}…`)
    expect(desktopActionSummary(t('desktop_type'), { text: 'x'.repeat(200) })).toBe(`Type: ${'x'.repeat(200)}`)
  })

  it('shows every Return a typed text presses, and counts them past the cut', () => {
    expect(desktopActionSummary(t('desktop_type'), { text: 'ls\nrm -rf ~/work\n' })).toBe('Type: ls⏎rm -rf ~/work⏎ · presses Enter 2×')
    // A CR may press Return too: each one is marked and counted, never hidden.
    expect(desktopActionSummary(t('desktop_type'), { text: 'a\r\nb' })).toBe('Type: a⏎⏎b · presses Enter 2×')
    expect(desktopActionSummary(t('desktop_type'), { text: 'a\tb' })).toBe('Type: a⇥b')
    const long = `${'x'.repeat(250)}\nrm -rf ~\n`
    expect(desktopActionSummary(t('desktop_type'), { text: long })).toBe(`Type: ${'x'.repeat(200)}… · presses Enter 2×`)
    expect(desktopActionSummary(t('desktop_type'), { text: 'hello' })).toBe('Type: hello')
  })

  it('shows invisible and reordering characters as escapes', () => {
    expect(desktopActionSummary(t('desktop_type'), { text: 'safe\u202Ecod.exe' })).toBe('Type: safe\\u{202e}cod.exe')
    expect(desktopActionSummary(t('desktop_type'), { text: 'a\u2066b\u2069\u200Bc\uFEFF' })).toBe(
      'Type: a\\u{2066}b\\u{2069}\\u{200b}c\\u{feff}'
    )
    expect(desktopActionSummary(t('desktop_type'), { text: 'a\u007Fb\u0085c\u0000d\u001Be' })).toBe(
      'Type: a\\u{7f}b\\u{85}c\\u{0}d\\u{1b}e'
    )
    // Escapes are made before the cut: the cut may end inside one, but never lets the raw character through.
    expect(desktopActionSummary(t('desktop_type'), { text: `${'x'.repeat(190)}\u202E` })).toBe(`Type: ${'x'.repeat(190)}\\u{202e}`)
    expect(desktopActionSummary(t('desktop_type'), { text: `${'x'.repeat(199)}\u202E` })).toBe(`Type: ${'x'.repeat(199)}\\…`)
    expect(desktopActionSummary(t('desktop_launch'), { name: 'fire\nfox\u202E' })).toBe('Launch fire⏎fox\\u{202e}')
    expect(desktopActionSummary(t('desktop_key'), { keys: ['ctrl', 'a\u200Fb'] })).toBe('Press Ctrl+A\\u{200f}b')
    expect(desktopActionSummary(t('desktop_click'), { element: 'e\n4' })).toBe('Click element e⏎4')
    expect(desktopActionSummary(t('desktop_scroll'), { x: 1, y: 2, direction: 'up\u202E' })).toBe('Scroll up\\u{202e} 3 at 1, 2')
  })

  it('shows format and default-ignorable characters as escapes too', () => {
    const typed = (text: string) => desktopActionSummary(t('desktop_type'), { text })
    // Tag characters can hide a whole command after 'hi'.
    expect(typed('hi\u{E0072}\u{E006D}')).toBe('Type: hi\\u{e0072}\\u{e006d}')
    expect(typed('a\u180Eb\u2061c\u00ADd')).toBe('Type: a\\u{180e}b\\u{2061}c\\u{ad}d')
    expect(typed('a\uFE00b\u3164c\u115Fd\u034Fe')).toBe('Type: a\\u{fe00}b\\u{3164}c\\u{115f}d\\u{34f}e')
    expect(typed('a\u206Ab\uFFF9c\u{1D173}d\u200De')).toBe('Type: a\\u{206a}b\\u{fff9}c\\u{1d173}d\\u{200d}e')
    expect(typed('a\u202Bb\u2067c\uD800d')).toBe('Type: a\\u{202b}b\\u{2067}c\\u{d800}d')
  })

  it('keeps letters and emoji readable', () => {
    for (const text of ['شكراً لك', '你好 世界', 'é ü ñ', '😀 👍🏽 🇸🇦', '❤\uFE0F ok'])
      expect(desktopActionSummary(t('desktop_type'), { text })).toBe(`Type: ${text}`)
  })

  it('leaves plain Arabic text as it is', () => {
    expect(desktopActionSummary(t('desktop_type'), { text: 'مرحبا بالعالم' })).toBe('Type: مرحبا بالعالم')
    expect(desktopActionSummary(t('desktop_launch'), { name: 'محرر النصوص' })).toBe('Launch محرر النصوص')
  })

  it('is null for looking tools, other tools and bad input', () => {
    expect(desktopActionSummary(t('desktop_focus'), { windowId: 'w1' })).toBeNull()
    expect(desktopActionSummary(t('desktop_screenshot'), {})).toBeNull()
    expect(desktopActionSummary(t('desktop_windows'), {})).toBeNull()
    expect(desktopActionSummary('Bash', {})).toBeNull()
    expect(desktopActionSummary(t('desktop_click'), null)).toBeNull()
    expect(desktopActionSummary(t('desktop_type'), { text: 5 })).toBeNull()
  })
})

describe('desktopPoint', () => {
  it('gives the point Show on desktop marks', () => {
    expect(desktopPoint(t('desktop_click'), { x: 1, y: 2 })).toEqual({ x: 1, y: 2 })
    expect(desktopPoint(t('desktop_move'), { x: 3, y: 4 })).toEqual({ x: 3, y: 4 })
    expect(desktopPoint(t('desktop_scroll'), { x: 5, y: 6, direction: 'up' })).toEqual({ x: 5, y: 6 })
    expect(desktopPoint(t('desktop_drag'), { fromX: 7, fromY: 8, toX: 9, toY: 10 })).toEqual({ x: 7, y: 8 })
  })
  it('is null otherwise', () => {
    expect(desktopPoint(t('desktop_type'), { text: 'a' })).toBeNull()
    expect(desktopPoint(t('desktop_click'), { element: 'e1' })).toBeNull()
    expect(desktopPoint('Bash', { x: 1, y: 2 })).toBeNull()
    expect(desktopPoint(t('desktop_click'), null)).toBeNull()
  })
})

describe('boundDesktopStatus', () => {
  it('clips text fields', () => {
    const s: DesktopStatus = {
      agent: 'a'.repeat(200),
      profileId: 'p',
      generation: 'g',
      state: 'ready',
      control: 'agent',
      pendingRequestId: null,
      error: 'e'.repeat(900),
      width: 1280,
      height: 800,
      busy: true,
      missing: Array.from({ length: 15 }, () => 'm'.repeat(100))
    }
    const b = boundDesktopStatus(s)
    expect(b.agent).toHaveLength(128)
    expect(b.error).toHaveLength(512)
    expect(b.missing).toHaveLength(10)
    expect(b.missing![0]).toHaveLength(64)
    expect(b.state).toBe('ready')
    expect(b.busy).toBe(true)
  })
  it('leaves absent fields absent', () => {
    const b = boundDesktopStatus({
      agent: 'a',
      profileId: 'p',
      generation: 'g',
      state: 'off',
      control: 'agent',
      pendingRequestId: 'r',
      error: null,
      width: 1,
      height: 2,
      busy: false
    })
    expect('missing' in b).toBe(false)
    expect(b.pendingRequestId).toBe('r')
    expect(b.error).toBeNull()
    expect(b.busy).toBe(false)
  })
})

describe('DesktopServerMessage', () => {
  it('ties statuses and RFB legs to the watch that made them', () => {
    const status: DesktopStatus = {
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
    const messages: DesktopServerMessage[] = [
      { type: 'status', watchId: 3, status },
      { type: 'rfb', watchId: 3, state: 'open', generation: 'g' }
    ]
    // @ts-expect-error without its watch, a message cannot be told apart from a stale one
    const untagged: DesktopServerMessage = { type: 'rfb', state: 'closed', generation: 'g' }
    expect(messages.map((m) => (m.type === 'response' ? -1 : m.watchId))).toEqual([3, 3])
    expect(untagged.type).toBe('rfb')
  })
})
