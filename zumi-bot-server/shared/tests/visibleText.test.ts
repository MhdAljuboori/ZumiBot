import { describe, expect, it } from 'vitest'
import { visibleJson, visibleLines, visibleText } from '../src/visibleText'

describe('visibleText', () => {
  it('escapes what cannot be seen or reorders text, and keeps the rest', () => {
    expect(visibleText('a\u202Eb\u200Bc\u{E0041}d\u007Fe\u0085f\u2028g')).toBe('a\\u{202e}b\\u{200b}c\\u{e0041}d\\u{7f}e\\u{85}f\\u{2028}g')
    expect(visibleText('مرحبا 😀 ❤\uFE0F 你好')).toBe('مرحبا 😀 ❤\uFE0F 你好')
  })
})

describe('visibleJson', () => {
  it('is byte for byte JSON.stringify(value, null, 2) for ordinary input', () => {
    const input = {
      command: 'ls -la\nrm x\t"q"',
      path: '/tmp/ملف.txt',
      n: 3,
      ok: true,
      none: null,
      list: [1, 'two', { deep: '你好 😀 ❤\uFE0F' }],
      ctrl: '\u001B[0m'
    }
    expect(visibleJson(input)).toBe(JSON.stringify(input, null, 2))
    expect(visibleJson('text')).toBe(JSON.stringify('text', null, 2))
    expect(visibleJson(undefined)).toBe('')
  })
  it('escapes bidi, zero-width, tag, DEL, C1 and separator characters as JSON escapes, still valid JSON', () => {
    const input = { text: 'safe\u202Ecod.exe', zw: 'a\u200Bb', tag: 'hi\u{E0072}', del: 'x\u007F\u0085', sep: 'a\u2028b', ['k\u2066']: 1 }
    const out = visibleJson(input)
    expect(out).toContain('"safe\\u202ecod.exe"')
    expect(out).toContain('"a\\u200bb"')
    expect(out).toContain('"hi\\udb40\\udc72"')
    expect(out).toContain('"x\\u007f\\u0085"')
    expect(out).toContain('"a\\u2028b"')
    expect(out).toContain('"k\\u2066": 1')
    expect(JSON.parse(out)).toEqual(input)
    // Only the indentation's own newlines stay raw.
    expect(out.split('\n')).toHaveLength(JSON.stringify(input, null, 2).split('\n').length)
  })
  it('keeps a typed backslash-u apart from an escaped character', () => {
    expect(visibleJson('\\u202e')).toBe('"\\\\u202e"')
    expect(visibleJson('\u202E')).toBe('"\\u202e"')
  })
})

describe('visibleLines', () => {
  it('keeps line breaks and escapes every other hidden character', () => {
    expect(visibleLines('a\nb\u202Ec\tz')).toBe('a\nb\\u{202e}c\\u{9}z')
  })
})
