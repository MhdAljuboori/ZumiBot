import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLEAN,
  DEFAULT_TALK,
  VOICE_CLEAN_HEADER,
  VOICE_CLEAN_MODES,
  parseCleanPatch,
  parseTalkPatch,
  voiceOn
} from '@zumibot/shared/voice'

describe('parseTalkPatch', () => {
  it('round-trips Arabic aliases', () => {
    const p = { aliases: { 'work-assistant': ['مساعد العمل'] } }
    expect(parseTalkPatch(p)).toEqual(p)
  })
  it('takes each field alone', () => {
    expect(parseTalkPatch({})).toEqual({})
    expect(parseTalkPatch({ enabled: false })).toEqual({ enabled: false })
    expect(parseTalkPatch({ defaultAgent: 'x' })).toEqual({ defaultAgent: 'x' })
    expect(parseTalkPatch({ defaultAgent: null })).toEqual({ defaultAgent: null })
  })
  it('trims phrases', () => expect(parseTalkPatch({ aliases: { a: ['  hi  '] } })).toEqual({ aliases: { a: ['hi'] } }))
  it('rejects non-objects, unknown keys and wrong types', () => {
    for (const v of [
      null,
      'x',
      5,
      [],
      { nope: 1 },
      { enabled: 'yes' },
      { defaultAgent: 5 },
      { aliases: [] },
      { aliases: { a: 'x' } },
      { aliases: { a: [5] } }
    ]) {
      expect(parseTalkPatch(v)).toBeNull()
    }
  })
  it('rejects an empty default agent', () => expect(parseTalkPatch({ defaultAgent: '' })).toBeNull())
  it('no longer takes a spoken voice', () => expect(parseTalkPatch({ ttsVoice: 'gemini' })).toBeNull())
  it('limits phrase length', () => {
    expect(parseTalkPatch({ aliases: { a: ['x'.repeat(60)] } })).not.toBeNull()
    expect(parseTalkPatch({ aliases: { a: ['x'.repeat(61)] } })).toBeNull()
    expect(parseTalkPatch({ aliases: { a: ['   '] } })).toBeNull()
    expect(parseTalkPatch({ aliases: { a: [''] } })).toBeNull()
  })
  it('limits agent names, agent count and phrase count', () => {
    expect(parseTalkPatch({ aliases: { ['n'.repeat(101)]: ['x'] } })).toBeNull()
    expect(parseTalkPatch({ defaultAgent: 'n'.repeat(101) })).toBeNull()
    const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, ['x']]))
    expect(parseTalkPatch({ aliases: many(50) })).not.toBeNull()
    expect(parseTalkPatch({ aliases: many(51) })).toBeNull()
    expect(parseTalkPatch({ aliases: { a: Array.from({ length: 10 }, (_, i) => `p${i}`) } })).not.toBeNull()
    expect(parseTalkPatch({ aliases: { a: Array.from({ length: 11 }, (_, i) => `p${i}`) } })).toBeNull()
  })
  it('rejects control characters', () => {
    expect(parseTalkPatch({ aliases: { a: ['a\nb'] } })).toBeNull()
    expect(parseTalkPatch({ aliases: { a: ['a\u0000b'] } })).toBeNull()
    expect(parseTalkPatch({ aliases: { 'a\tb': ['x'] } })).toBeNull()
    expect(parseTalkPatch({ defaultAgent: 'a\u007fb' })).toBeNull()
  })
  it('refuses prototype keys', () => {
    expect(parseTalkPatch(JSON.parse('{"aliases":{"__proto__":["x"]}}'))).toBeNull()
  })
})

describe('DEFAULT_TALK', () => {
  it('is on with the work assistant, and no aliases', () =>
    expect(DEFAULT_TALK).toEqual({ enabled: true, defaultAgent: 'work-assistant', aliases: {} }))
})

describe('voiceOn', () => {
  it('needs the switch and a key', () => {
    expect(voiceOn({ enabled: true, keySaved: true })).toBe(true)
    expect(voiceOn({ enabled: true, keySaved: false })).toBe(false)
  })
})

describe('parseCleanPatch', () => {
  it('takes each switch alone', () => {
    expect(parseCleanPatch({})).toEqual({})
    expect(parseCleanPatch({ fillers: true })).toEqual({ fillers: true })
    expect(parseCleanPatch({ rewrite: false })).toEqual({ rewrite: false })
    expect(parseCleanPatch({ fillers: false, rewrite: true })).toEqual({ fillers: false, rewrite: true })
  })
  it('rejects non-objects, unknown keys and wrong types', () => {
    for (const v of [null, 'x', 5, [], { other: true }, { fillers: 'yes' }, { rewrite: 1 }, { fillers: null }])
      expect(parseCleanPatch(v)).toBeNull()
  })
})

describe('clean defaults', () => {
  it('both switches are off', () => expect(DEFAULT_CLEAN).toEqual({ fillers: false, rewrite: false }))
  it('header and modes', () => {
    expect(VOICE_CLEAN_HEADER).toBe('X-ZumiBot-Voice-Clean')
    expect(VOICE_CLEAN_MODES).toEqual(['full', 'light'])
  })
})
