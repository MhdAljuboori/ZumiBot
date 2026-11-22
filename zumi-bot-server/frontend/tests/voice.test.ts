import { afterEach, describe, expect, it } from 'vitest'
import { mentionQuery } from '../src/state/mentionInput'
import { textSlashQuery } from '../src/state/commandInput'
import * as dictation from '../src/state/dictation'
import {
  contentTypeOf,
  formatElapsed,
  insertIntoText,
  langLabel,
  loadLang,
  micError,
  micLabel,
  micShown,
  nextLang,
  pickRecorderType,
  saveLang,
  spaceDictation,
  transcribingText,
  voiceErrorText,
  type VoiceError
} from '../src/state/voice'
import * as voice from '../src/state/voice'

describe('spaceDictation', () => {
  it('adds only a trailing space at block edges', () => expect(spaceDictation('hi', null, null)).toBe('hi '))
  it('adds a leading space next to a word and a trailing one at the end', () => expect(spaceDictation('hi', 'a', null)).toBe(' hi '))
  it('adds no leading space after whitespace', () => expect(spaceDictation('hi', ' ', 'b')).toBe('hi '))
  it('always ends with a space, even before whitespace, so a typed @ or / never ends at the caret', () => {
    expect(spaceDictation('hi', 'a', ' ')).toBe(' hi ')
    expect(spaceDictation('hi', 'a', '\n')).toBe(' hi ')
  })
  it('trims the text first', () => expect(spaceDictation(' hi  ', null, null)).toBe('hi '))
  it('works for Arabic', () => expect(spaceDictation('مرحبا', 'o', null)).toBe(' مرحبا '))
})

describe('insertIntoText', () => {
  it('spaces both sides of a mid-word caret', () => expect(insertIntoText('ab', 1, 1, 'X')).toEqual({ value: 'a X b', caret: 4 }))
  it('replaces a full selection', () => expect(insertIntoText('ab', 0, 2, 'X')).toEqual({ value: 'X ', caret: 2 }))
  it('treats a newline before as a line edge', () => expect(insertIntoText('a\nb', 2, 2, 'X').value).toBe('a\nX b'))
  it('keeps its trailing space before a newline (a double whitespace is harmless)', () =>
    expect(insertIntoText('a\nb', 1, 1, 'X')).toEqual({ value: 'a X \nb', caret: 4 }))

  it.each(['/check', 'hello @ed', '@'])('never opens the mention or slash menu for %s', (text) => {
    for (const base of ['', 'x ']) {
      const r = insertIntoText(base, base.length, base.length, text)
      expect(mentionQuery(r.value, r.caret)).toBeNull()
      expect(textSlashQuery(r.value, r.caret, r.caret)).toBeNull()
    }
  })

  // Every position the caret can sit in: the inserted text must never leave an @word or a leading /name at the caret.
  const cases: [string, string, number, number][] = [
    ['before a space', 'a b', 1, 1],
    ['before a newline', 'a\nb', 1, 1],
    ['at the start of a non-empty value', 'b', 0, 0],
    ['at the start before a space', ' b', 0, 0],
    ['replacing a selection', 'abc', 0, 3],
    ['replacing a middle selection', 'a bc d', 2, 4]
  ]
  describe.each(['@ed', 'hello @ed', '/check'])('mid-text %s', (text) => {
    it.each(cases)('%s', (_name, value, start, end) => {
      const r = insertIntoText(value, start, end, text)
      expect(mentionQuery(r.value, r.caret)).toBeNull()
      expect(textSlashQuery(r.value, r.caret, r.caret)).toBeNull()
    })
  })
})

describe('language', () => {
  it('cycles auto → en → ar → auto', () => {
    expect(nextLang('auto')).toBe('en')
    expect(nextLang('en')).toBe('ar')
    expect(nextLang('ar')).toBe('auto')
  })
  it('reads auto when storage throws or holds junk', () => {
    expect(
      loadLang({
        getItem: () => {
          throw new Error('blocked')
        }
      })
    ).toBe('auto')
    expect(loadLang({ getItem: () => 'ar' })).toBe('ar')
    expect(loadLang({ getItem: () => 'xx' })).toBe('auto')
    expect(loadLang({ getItem: () => null })).toBe('auto')
  })
  it('saves under zumibot.voiceLang and swallows errors', () => {
    const calls: string[][] = []
    saveLang('en', { setItem: (k, v) => void calls.push([k, v]) })
    expect(calls).toEqual([['zumibot.voiceLang', 'en']])
    expect(() =>
      saveLang('en', {
        setItem: () => {
          throw new Error('full')
        }
      })
    ).not.toThrow()
  })
})

describe('language with a localStorage global that throws on access', () => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
    if (saved) Object.defineProperty(globalThis, 'localStorage', saved)
  })
  it('loadLang reads auto and saveLang does not throw', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError')
      }
    })
    expect(loadLang()).toBe('auto')
    expect(() => saveLang('ar')).not.toThrow()
  })
})

describe('pickRecorderType', () => {
  it('takes the first supported type in order', () => {
    expect(pickRecorderType((t) => t === 'audio/mp4')).toBe('audio/mp4')
    expect(pickRecorderType(() => true)).toBe('audio/webm;codecs=opus')
    expect(pickRecorderType((t) => t.startsWith('audio/ogg'))).toBe('audio/ogg;codecs=opus')
  })
  it('is null when none is supported', () => expect(pickRecorderType(() => false)).toBeNull())
})

describe('micShown', () => {
  const on = { on: true, enabled: true, keySaved: true }
  const off = { on: false, enabled: true, keySaved: false }
  const base = { status: on, canRecord: true, shell: false, micPermission: 'prompt' as const }
  it('shows when on and able to record', () => expect(micShown(base)).toBe(true))
  it('hides when off', () => expect(micShown({ ...base, status: off })).toBe(false))
  it('hides before the status is known', () => expect(micShown({ ...base, status: null })).toBe(false))
  it('hides when the browser cannot record', () => expect(micShown({ ...base, canRecord: false })).toBe(false))
  it('hides in the shell when the mic is denied', () => expect(micShown({ ...base, shell: true, micPermission: 'denied' })).toBe(false))
  it('keeps showing in a browser when denied, so the tap can explain', () =>
    expect(micShown({ ...base, micPermission: 'denied' })).toBe(true))
  it('shows in the shell when granted', () => expect(micShown({ ...base, shell: true, micPermission: 'granted' })).toBe(true))
})

describe('contentTypeOf', () => {
  it('drops codec parameters', () => {
    expect(contentTypeOf('audio/webm;codecs=opus')).toBe('audio/webm')
    expect(contentTypeOf('audio/mp4')).toBe('audio/mp4')
  })
})

describe('formatElapsed', () => {
  it('shows m:ss, rounding down', () => {
    expect(formatElapsed(0)).toBe('0:00')
    expect(formatElapsed(999)).toBe('0:00')
    expect(formatElapsed(7_400)).toBe('0:07')
    expect(formatElapsed(65_000)).toBe('1:05')
    expect(formatElapsed(300_000)).toBe('5:00')
  })
  it('never goes negative (a clock set back)', () => expect(formatElapsed(-500)).toBe('0:00'))
})

describe('micError', () => {
  const named = (name: string): Error => Object.assign(new Error('x'), { name })
  it('reads a refusal as blocked', () => {
    expect(micError(named('NotAllowedError'))).toBe('blocked')
    expect(micError(named('SecurityError'))).toBe('blocked')
  })
  it('reads a missing device as nomic', () => expect(micError(named('NotFoundError'))).toBe('nomic'))
  it('reads anything else as failed', () => {
    expect(micError(named('NotReadableError'))).toBe('failed')
    expect(micError('nope')).toBe('failed')
    expect(micError(undefined)).toBe('failed')
  })
})

describe('langLabel', () => {
  it('names each language for the chip', () => {
    expect(langLabel('auto')).toBe('Auto')
    expect(langLabel('en')).toBe('EN')
    expect(langLabel('ar')).toBe('AR')
  })
})

describe('micLabel', () => {
  it('names what a tap does in each phase', () => {
    expect(micLabel('idle')).toBe('Start dictation')
    expect(micLabel('error')).toBe('Start dictation')
    expect(micLabel('starting')).toBe('Cancel dictation')
    expect(micLabel('listening')).toBe('Stop dictation')
    expect(micLabel('transcribing')).toBe('Cancel dictation')
  })
})

describe('transcribingText', () => {
  const s = { ...dictation.IDLE, phase: 'transcribing' as const, run: 1 }
  it('says when a send waits for the text', () => {
    expect(transcribingText(s)).toBe('Transcribing…')
    expect(transcribingText({ ...s, sendAfter: true })).toBe('Transcribing, then sending…')
  })
})

describe('re-exports', () => {
  it('is the same VoiceError copy as the state machine', () => {
    expect(voice.voiceErrorText).toBe(dictation.voiceErrorText)
    const e: VoiceError = 'busy'
    expect(voiceErrorText(e)).toBe('Too many recordings. Wait a moment.')
  })
})
