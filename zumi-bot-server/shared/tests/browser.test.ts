import { describe, expect, it } from 'vitest'
import {
  SHOT_BYTES_MAX,
  SHOT_NAME_RE,
  SHOTS_PER_CHAT_MAX,
  browserKeyCode,
  parseBrowserCommand,
  parseBrowserInput,
  safeBrowserSite
} from '../src/browser'

const stamp = { generation: 'g1', tabId: 't1', observationId: 'o1' }
describe('browser command boundary', () => {
  it.each([
    { op: 'navigate', url: 'https://x.test/a' },
    { op: 'back' },
    { op: 'forward' },
    { op: 'reload' },
    { op: 'tabs' },
    { op: 'newTab' },
    { op: 'newTab', url: 'about:blank' },
    { op: 'selectTab', tabId: 't1' },
    { op: 'closeTab', tabId: 't1' },
    { op: 'observe' },
    { op: 'screenshot' },
    { op: 'click', stamp, ref: 'e1' },
    { op: 'type', stamp, ref: 'e1', text: 'hello' },
    { op: 'scroll', deltaX: 0, deltaY: 20 },
    { op: 'dialog', accept: true, text: 'yes' },
    { op: 'upload', stamp, ref: 'e1', fileIds: ['f1'] },
    { op: 'select', stamp, ref: 'e1', values: ['Fadi Selo'] },
    { op: 'select', stamp, ref: 'e1', values: ['', 'b'] },
    { op: 'release' },
    { op: 'requestUserAction', reason: 'Please sign in' },
    { op: 'saveScreenshot', name: 'row-hover-product' },
    { op: 'saveScreenshot', name: 'a', fullPage: true },
    { op: 'saveScreenshot', name: '0_a-b', ref: 'e1', stamp },
    { op: 'saveScreenshot', name: 'x'.repeat(64) },
    { op: 'computedStyle', stamp, ref: 'e1' },
    { op: 'hover', stamp, ref: 'e1' },
    { op: 'setViewport', width: 1440, height: 900 },
    { op: 'setViewport', width: 240, height: 200 },
    { op: 'setViewport', width: 1920, height: 1080 }
  ])('accepts supported command %j', (command) => expect(parseBrowserCommand(command)).toEqual(command))

  it.each([
    null,
    {},
    { op: 'evaluate', script: 'secret' },
    { op: 'back', secret: 'extra' },
    { op: 'navigate', url: 'file:///etc/passwd' },
    { op: 'navigate', url: 'javascript:alert(1)' },
    { op: 'navigate', url: 'https://user:secret@x.test' },
    { op: 'navigate', url: 'https://x.test/' + 'x'.repeat(8192) },
    { op: 'type', stamp, ref: 'e', text: 'x'.repeat(16385) },
    { op: 'click', stamp: { ...stamp, observationId: '' }, ref: 'e' },
    { op: 'upload', stamp, ref: 'e', fileIds: ['../secret'] },
    { op: 'upload', stamp, ref: 'e', fileIds: Array(17).fill('f') },
    { op: 'select', stamp, ref: 'e', values: [] },
    { op: 'select', stamp, ref: 'e', values: 'a' },
    { op: 'select', stamp, ref: 'e', values: [1] },
    { op: 'select', stamp, ref: 'e', values: Array(33).fill('a') },
    { op: 'select', stamp, ref: 'e', values: ['x'.repeat(1025)] },
    { op: 'select', stamp, ref: 'e', values: ['a'], text: 'a' },
    { op: 'scroll', deltaX: NaN, deltaY: 0 },
    { op: 'scroll', deltaX: 0, deltaY: Infinity },
    { op: 'dialog', accept: 'true' },
    { op: 'requestUserAction', reason: 'x'.repeat(501) },
    ...['', '../x', 'a/b', 'A', 'a.png', 'x'.repeat(65), 7, '-a', '_a'].map((name) => ({ op: 'saveScreenshot', name })),
    { op: 'saveScreenshot', name: 'a', ref: 'e1' },
    { op: 'saveScreenshot', name: 'a', stamp },
    { op: 'saveScreenshot', name: 'a', ref: 'e1', stamp, fullPage: true },
    { op: 'saveScreenshot', name: 'a', fullPage: 'yes' },
    { op: 'saveScreenshot', name: 'a', extra: 1 },
    ...['computedStyle', 'hover'].flatMap((op) => [
      { op },
      { op, ref: 'e1' },
      { op, stamp },
      { op, stamp, ref: 'x'.repeat(129) },
      { op, stamp, ref: 'e1', extra: 1 }
    ]),
    { op: 'setViewport', width: 1440.5, height: 900 },
    { op: 'setViewport', width: 0, height: 900 },
    { op: 'setViewport', width: -1440, height: 900 },
    { op: 'setViewport', width: 5000, height: 900 },
    { op: 'setViewport', width: NaN, height: 900 },
    { op: 'setViewport', width: 1440 },
    { op: 'setViewport', width: 1440, height: 5000 },
    { op: 'setViewport', width: 100, height: 900 },
    { op: 'setViewport', width: 239, height: 200 },
    { op: 'setViewport', width: 240, height: 199 },
    { op: 'setViewport', width: 1921, height: 1080 },
    { op: 'setViewport', width: 1920, height: 1081 },
    { op: 'setViewport', width: '1440', height: 900 },
    { op: 'setViewport', width: 1440, height: 900, scale: 2 }
  ])('rejects invalid command %j', (command) => expect(() => parseBrowserCommand(command)).toThrow())
})

it('exports the saved screenshot limits', () => {
  expect(SHOT_NAME_RE.test('row-hover-product')).toBe(true)
  expect(SHOT_NAME_RE.test('A')).toBe(false)
  expect(SHOTS_PER_CHAT_MAX).toBe(200)
  expect(SHOT_BYTES_MAX).toBe(5 * 1024 * 1024)
})

describe('fillVault command', () => {
  it('parses fillVault and refuses unknown fields and extra keys', () => {
    const fill = { op: 'fillVault', stamp, ref: 'e1', item: 'item-1', field: 'password' }
    expect(parseBrowserCommand(fill)).toEqual(fill)
    for (const field of [
      'username',
      'code',
      'number',
      'expiry',
      'expiryMonth',
      'expiryYear',
      'expiryYear2',
      'cvc',
      'holder',
      'email',
      'postalCode'
    ]) {
      expect(parseBrowserCommand({ ...fill, field })).toEqual({ ...fill, field })
    }
    // An agent can never carry a value: the value travels only in BrowserFill, which is not a command.
    expect(() => parseBrowserCommand({ ...fill, value: 'hunter2' })).toThrow()
    expect(() => parseBrowserCommand({ ...fill, secret: true })).toThrow()
    for (const field of ['pin', 'value', '', 'toString', 1, null]) expect(() => parseBrowserCommand({ ...fill, field })).toThrow()
    for (const item of ['', 'x'.repeat(129), 7, 'a\0b']) expect(() => parseBrowserCommand({ ...fill, item })).toThrow()
    expect(parseBrowserCommand({ ...fill, item: 'x'.repeat(128) })).toMatchObject({ item: 'x'.repeat(128) })
    expect(() => parseBrowserCommand({ ...fill, stamp: undefined })).toThrow()
    expect(() => parseBrowserCommand({ ...fill, ref: '../x' })).toThrow()
  })
})

describe('browser viewer input boundary', () => {
  const target = { generation: 'g1', tabId: 't1' }
  it.each([
    { type: 'mouseDown', x: 10, y: 20, button: 'left' },
    { type: 'mouseUp', x: 10, y: 20, button: 'right' },
    { type: 'mouseMove', x: 0, y: 0 },
    { type: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: 30 },
    { type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: ['Shift'] },
    { type: 'keyUp', key: 'Enter', code: 'Enter' },
    // A phone keyboard's keys have no physical key, so no code.
    { type: 'keyDown', key: 'Backspace', code: '' },
    { type: 'text', text: 'مرحبا' }
  ])('accepts committed event %j', (event) => {
    const value = { ...target, ...event }
    expect(parseBrowserInput(value)).toEqual(value)
  })
  it.each([
    { type: 'compositionStart' },
    { type: 'mouseMove', x: NaN, y: 1 },
    { type: 'mouseMove', x: -1, y: 1 },
    { type: 'mouseMove', x: 1920, y: 1 },
    { type: 'wheel', x: 1, y: 1, deltaX: Infinity, deltaY: 1 },
    { type: 'mouseDown', x: 1, y: 1, button: 'unknown' },
    { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: ['Unknown'] },
    { type: 'text', text: 'x'.repeat(16385) },
    { type: 'text', text: 'ok', capability: 'secret' }
  ])('rejects invalid input %j', (event) => expect(() => parseBrowserInput({ ...target, ...event })).toThrow())
  it('requires generation and tab identity', () => expect(() => parseBrowserInput({ type: 'text', text: 'ok' })).toThrow())
})

describe('browserKeyCode', () => {
  it('keeps a physical key code', () => {
    expect(browserKeyCode('a', 'KeyQ')).toBe('KeyQ')
    expect(browserKeyCode('Enter', 'NumpadEnter')).toBe('NumpadEnter')
  })
  it.each([
    ['Backspace', 'Backspace'],
    ['Enter', 'Enter'],
    ['Delete', 'Delete'],
    ['ArrowLeft', 'ArrowLeft'],
    ['Home', 'Home'],
    ['F5', 'F5'],
    ['a', 'KeyA'],
    ['Z', 'KeyZ'],
    ['7', 'Digit7'],
    [' ', 'Space'],
    ['Shift', 'ShiftLeft'],
    ['Control', 'ControlLeft']
  ])('names a phone keyboard key %j by what it is', (key, code) => expect(browserKeyCode(key, '')).toBe(code))
  it('leaves a key with no physical counterpart unnamed', () => {
    expect(browserKeyCode('@', '')).toBe('')
    expect(browserKeyCode('Unidentified', '')).toBe('')
    expect(browserKeyCode('é', '')).toBe('')
  })
})

it('uses only the safe origin for handoff metadata', () => {
  expect(safeBrowserSite('https://x.test/a?secret=1#token')).toBe('https://x.test')
  expect(safeBrowserSite('https://user:secret@x.test/a')).toBe('https://x.test')
  expect(safeBrowserSite('data:text/plain,secret')).toBe('')
  expect(safeBrowserSite('not a url')).toBe('')
})

// browser-viewer.e2e.mjs loads this file with plain node, whose type stripping resolves no extensionless relative import.
describe('plain node load', () => {
  const [major, minor] = process.versions.node.split('.').map(Number)
  const strips = major > 22 || (major === 22 && minor >= 18)
  it.skipIf(!strips)('imports shared/src/browser.ts under plain node (type stripping, Node 22.18 or later)', async () => {
    const { spawnSync } = await import('node:child_process')
    const { fileURLToPath, pathToFileURL } = await import('node:url')
    const file = pathToFileURL(fileURLToPath(new URL('../src/browser.ts', import.meta.url))).href
    const r = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(file)}); if (typeof m.encodeBrowserFrame !== 'function') process.exit(3)`
      ],
      { encoding: 'utf8' }
    )
    expect(r.stderr.split('\n').filter((l) => /Error|Cannot find/.test(l))).toEqual([])
    expect(r.status).toBe(0)
  })
})
