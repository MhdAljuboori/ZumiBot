import { describe, expect, it } from 'vitest'
import { VOICE_MAX_MS, VOICE_MIN_MS } from '@zumibot/shared/voice'
import {
  IDLE,
  capNote,
  holdsSend,
  micDisabled,
  micVisible,
  step,
  voiceErrorText,
  type DictationEffect,
  type DictationEvent,
  type DictationState,
  type VoiceError
} from '../src/state/dictation'

const T0 = 1_000
const run = (s: DictationState, ...events: DictationEvent[]): { state: DictationState; effects: DictationEffect[] } => {
  let state = s
  let effects: DictationEffect[] = []
  for (const e of events) ({ state, effects } = step(state, e))
  return { state, effects }
}
const starting = (): DictationState => run(IDLE, { type: 'tap', now: T0 }).state
const listening = (): DictationState => run(starting(), { type: 'granted', run: 1, now: T0 }).state
const transcribing = (): DictationState => run(listening(), { type: 'tap', now: T0 + 1000 }).state
const held = (): DictationState => run(listening(), { type: 'send' }).state
const types = (fx: DictationEffect[]): string[] => fx.map((f) => f.type)

describe('start', () => {
  it('tap starts a new run', () => {
    const r = step(IDLE, { type: 'tap', now: T0 })
    expect(r.state).toMatchObject({ phase: 'starting', run: 1, startedAt: null, sendAfter: false, capped: false, error: null })
    expect(r.effects).toEqual([{ type: 'acquire', run: 1 }])
  })

  it('granted starts listening', () => {
    const r = step(starting(), { type: 'granted', run: 1, now: 5_000 })
    expect(r.state).toMatchObject({ phase: 'listening', run: 1, startedAt: 5_000 })
    expect(r.effects).toEqual([{ type: 'announce', text: 'Listening' }])
  })

  it('tap while starting cancels, and a late grant is let go', () => {
    const c = step(starting(), { type: 'tap', now: T0 + 1 })
    expect(c.state.phase).toBe('idle')
    expect(c.effects).toEqual([{ type: 'release' }])
    const late = step(c.state, { type: 'granted', run: 1, now: T0 + 2 })
    expect(late.state).toEqual(c.state)
    expect(late.effects).toEqual([{ type: 'release' }])
  })

  it('denied shows the error', () => {
    const r = step(starting(), { type: 'denied', run: 1, error: 'blocked' })
    expect(r.state).toMatchObject({ phase: 'error', error: 'blocked' })
    expect(r.effects).toEqual([{ type: 'release' }, { type: 'announce', text: voiceErrorText('blocked') }])
  })

  it('a denial after the user cancelled is ignored', () => {
    const idle = step(starting(), { type: 'tap', now: T0 + 1 }).state
    const r = step(idle, { type: 'denied', run: 1, error: 'nomic' })
    expect(r.state).toEqual(idle)
    expect(r.effects).toEqual([])
  })
})

describe('stopping', () => {
  const stop = [{ type: 'finish', run: 1 }, { type: 'release' }, { type: 'announce', text: 'Transcribing' }]

  it('tap while listening transcribes', () => {
    const r = step(listening(), { type: 'tap', now: T0 + 1000 })
    expect(r.state).toMatchObject({ phase: 'transcribing', run: 1, sendAfter: false, capped: false })
    expect(r.effects).toEqual(stop)
  })

  it('hidden while listening transcribes; elsewhere it does nothing', () => {
    const r = step(listening(), { type: 'hidden' })
    expect(r.state.phase).toBe('transcribing')
    expect(r.effects).toEqual(stop)
    for (const s of [IDLE, starting(), transcribing()]) {
      expect(step(s, { type: 'hidden' })).toEqual({ state: s, effects: [] })
    }
  })

  it('the cap stops at 5:00', () => {
    const s = listening()
    expect(step(s, { type: 'tick', now: T0 + VOICE_MAX_MS - 1 })).toEqual({ state: s, effects: [] })
    const r = step(s, { type: 'tick', now: T0 + VOICE_MAX_MS })
    expect(r.state).toMatchObject({ phase: 'transcribing', capped: true })
    expect(r.effects).toEqual(stop)
  })

  it('tick outside listening does nothing', () => {
    for (const s of [IDLE, starting(), transcribing()]) {
      expect(step(s, { type: 'tick', now: T0 + VOICE_MAX_MS * 2 })).toEqual({ state: s, effects: [] })
    }
  })

  it('tap while transcribing cancels', () => {
    const r = step(held(), { type: 'tap', now: T0 + 2000 })
    expect(r.state).toMatchObject({ phase: 'idle', sendAfter: false })
    expect(r.effects).toEqual([{ type: 'abort' }, { type: 'announce', text: 'Dictation cancelled' }])
  })
})

describe('the clip and its result', () => {
  it('a short clip is not uploaded', () => {
    const short = step(transcribing(), { type: 'recorded', run: 1, ms: VOICE_MIN_MS - 1 })
    expect(short.state).toMatchObject({ phase: 'error', error: 'empty' })
    expect(short.effects).toEqual([{ type: 'abort' }, { type: 'announce', text: voiceErrorText('empty') }])
    const ok = step(transcribing(), { type: 'recorded', run: 1, ms: VOICE_MIN_MS })
    expect(ok.state.phase).toBe('transcribing')
    expect(ok.effects).toEqual([{ type: 'upload', run: 1 }])
  })

  it('a short clip with a held send still sends the box', () => {
    const r = step(held(), { type: 'recorded', run: 1, ms: 100 })
    expect(r.state).toMatchObject({ phase: 'error', error: 'empty', sendAfter: false })
    expect(types(r.effects)).toEqual(['abort', 'announce', 'send'])
  })

  it('result inserts', () => {
    const r = step(transcribing(), { type: 'result', run: 1, text: 'hello' })
    expect(r.state).toMatchObject({ phase: 'idle', error: null })
    expect(r.effects).toEqual([
      { type: 'insert', text: 'hello' },
      { type: 'announce', text: 'Dictation added' }
    ])
  })

  it('an empty result is "empty"', () => {
    const r = step(transcribing(), { type: 'result', run: 1, text: '  ' })
    expect(r.state).toMatchObject({ phase: 'error', error: 'empty' })
    expect(types(r.effects)).not.toContain('insert')
    expect(types(r.effects)).not.toContain('send')
  })

  it('failed shows the error and never sends', () => {
    const r = step(held(), { type: 'failed', run: 1, error: 'upstream' })
    expect(r.state).toMatchObject({ phase: 'error', error: 'upstream', sendAfter: false })
    expect(r.effects).toEqual([{ type: 'announce', text: voiceErrorText('upstream') }])
  })

  it('a recorder failure while listening releases the mic and shows the error', () => {
    const r = step(listening(), { type: 'failed', run: 1, error: 'failed' })
    expect(r.state).toMatchObject({ phase: 'error', error: 'failed' })
    expect(types(r.effects)).toEqual(['release', 'abort', 'announce'])
  })
})

describe('send while dictating', () => {
  it('send while listening holds it, then the result inserts before it sends', () => {
    const h = step(listening(), { type: 'send' })
    expect(h.state).toMatchObject({ phase: 'transcribing', sendAfter: true })
    expect(h.effects).toEqual([{ type: 'finish', run: 1 }, { type: 'release' }, { type: 'announce', text: 'Transcribing' }])
    const r = step(h.state, { type: 'result', run: 1, text: 'hi' })
    expect(r.state.phase).toBe('idle')
    expect(r.effects).toEqual([{ type: 'insert', text: 'hi' }, { type: 'announce', text: 'Dictation added' }, { type: 'send' }])
  })

  it('send while transcribing holds it', () => {
    const r = step(transcribing(), { type: 'send' })
    expect(r.state).toMatchObject({ phase: 'transcribing', sendAfter: true })
    expect(r.effects).toEqual([])
  })

  it('a second send while held changes nothing', () => {
    const s = held()
    expect(step(s, { type: 'send' })).toEqual({ state: s, effects: [] })
  })

  it('an empty result with a held send still sends the box', () => {
    const r = step(held(), { type: 'result', run: 1, text: '' })
    expect(r.state).toMatchObject({ phase: 'error', error: 'empty', sendAfter: false })
    expect(types(r.effects)).toContain('send')
    expect(types(r.effects)).not.toContain('insert')
  })

  it('send while starting drops the dictation, and the caller sends normally', () => {
    const s = starting()
    expect(holdsSend(s)).toBe(false)
    const r = step(s, { type: 'send' })
    expect(r.state.phase).toBe('idle')
    expect(r.effects).toEqual([{ type: 'release' }])
  })

  it('send while idle or in error is left to the caller', () => {
    const err = step(starting(), { type: 'denied', run: 1, error: 'nomic' }).state
    for (const s of [IDLE, err]) expect(step(s, { type: 'send' })).toEqual({ state: s, effects: [] })
  })

  it('holdsSend is true only while listening or transcribing', () => {
    expect([IDLE, starting(), listening(), transcribing()].map(holdsSend)).toEqual([false, false, true, true])
  })
})

describe('drop', () => {
  it('goes idle from every phase, with no insert or send', () => {
    for (const s of [starting(), listening(), transcribing(), held()]) {
      const r = step(s, { type: 'drop' })
      expect(r.state).toMatchObject({ phase: 'idle', sendAfter: false })
      expect(r.effects).toEqual([{ type: 'release' }, { type: 'abort' }])
    }
  })

  it('from idle does nothing', () => {
    expect(step(IDLE, { type: 'drop' })).toEqual({ state: IDLE, effects: [] })
  })
})

describe('stale runs', () => {
  it('events from an older run change nothing', () => {
    const dropped = step(held(), { type: 'drop' }).state
    const second = step(dropped, { type: 'tap', now: T0 + 5000 }).state
    expect(second.run).toBe(2)
    const transcribing2 = run(second, { type: 'granted', run: 2, now: T0 + 5000 }, { type: 'tap', now: T0 + 6000 }).state
    for (const s of [second, transcribing2]) {
      for (const e of [
        { type: 'result', run: 1, text: 'x' },
        { type: 'recorded', run: 1, ms: 900 },
        { type: 'failed', run: 1, error: 'upstream' },
        { type: 'denied', run: 1, error: 'blocked' }
      ] as DictationEvent[]) {
        expect(step(s, e)).toEqual({ state: s, effects: [] })
      }
    }
  })

  it('a result after the user cancelled the transcription is ignored', () => {
    const idle = step(transcribing(), { type: 'tap', now: T0 + 2000 }).state
    expect(step(idle, { type: 'result', run: 1, text: 'late' })).toEqual({ state: idle, effects: [] })
  })

  it('a grant for an older run leaves the current run alone', () => {
    const second = run(starting(), { type: 'tap', now: T0 + 1 }, { type: 'tap', now: T0 + 2 }).state
    expect(second).toMatchObject({ phase: 'starting', run: 2 })
    expect(step(second, { type: 'granted', run: 1, now: T0 + 3 })).toEqual({ state: second, effects: [] })
  })
})

describe('error', () => {
  const err = (): DictationState => step(starting(), { type: 'denied', run: 1, error: 'blocked' }).state

  it('tap starts again with the next run', () => {
    const r = step(err(), { type: 'tap', now: T0 + 9 })
    expect(r.state).toMatchObject({ phase: 'starting', run: 2, error: null })
    expect(r.effects).toEqual([{ type: 'acquire', run: 2 }])
  })

  it('dismiss clears it', () => {
    const r = step(err(), { type: 'dismiss' })
    expect(r.state).toMatchObject({ phase: 'idle', error: null, run: 1 })
    expect(r.effects).toEqual([])
  })

  it('dismiss and drop elsewhere / drop in error do nothing harmful', () => {
    expect(step(IDLE, { type: 'dismiss' })).toEqual({ state: IDLE, effects: [] })
    expect(step(listening(), { type: 'dismiss' }).state.phase).toBe('listening')
    expect(step(err(), { type: 'drop' }).state.phase).toBe('idle')
  })
})

describe('micVisible', () => {
  it('follows voiceOn while idle or in error', () => {
    expect(micVisible(true, IDLE)).toBe(true)
    expect(micVisible(false, IDLE)).toBe(false)
    expect(micVisible(false, run(starting(), { type: 'denied', run: 1, error: 'nomic' }).state)).toBe(false)
  })
  it('stays while starting, listening or transcribing even after voice turns off, so a recording never loses its stop button', () => {
    for (const s of [starting(), listening(), transcribing()]) expect(micVisible(false, s)).toBe(true)
  })
})

describe('micDisabled', () => {
  it('follows the box only while idle or in error', () => {
    const error = run(starting(), { type: 'denied', run: 1, error: 'nomic' }).state
    expect(micDisabled(true, IDLE)).toBe(true)
    expect(micDisabled(true, error)).toBe(true)
    expect(micDisabled(false, IDLE)).toBe(false)
    expect(micDisabled(false, error)).toBe(false)
  })
  it('never while starting, listening or transcribing, so a box disabled mid-dictation can still stop it', () => {
    for (const s of [starting(), listening(), transcribing(), held()]) {
      expect(micDisabled(true, s)).toBe(false)
      expect(micDisabled(false, s)).toBe(false)
    }
  })
})

describe('capNote', () => {
  const capped = (): DictationState => run(listening(), { type: 'tick', now: T0 + VOICE_MAX_MS }).state
  it('is true when the text of a recording the cap stopped is inserted', () => {
    const s = capped()
    expect(capNote(s, step(s, { type: 'result', run: 1, text: 'hi' }).effects)).toBe(true)
  })
  it('is false for an uncapped insert, or a capped recording that ends without text', () => {
    const t = transcribing()
    expect(capNote(t, step(t, { type: 'result', run: 1, text: 'hi' }).effects)).toBe(false)
    const s = capped()
    expect(capNote(s, step(s, { type: 'result', run: 1, text: '  ' }).effects)).toBe(false)
    expect(capNote(s, step(s, { type: 'failed', run: 1, error: 'upstream' }).effects)).toBe(false)
  })
})

describe('voiceErrorText', () => {
  it('has the copy for every code', () => {
    const copy: Record<VoiceError, string> = {
      blocked: "Microphone is blocked. Allow it in the browser's site settings.",
      nomic: 'No microphone found.',
      empty: "Didn't catch anything.",
      network: "Couldn't reach the server. Try again.",
      upstream: 'Transcription failed. Try again.',
      timeout: 'Transcription failed. Try again.',
      failed: 'Transcription failed. Try again.',
      'too-large': 'That recording is too long.',
      off: 'Voice input is off.',
      busy: 'Too many recordings. Wait a moment.'
    }
    for (const [code, text] of Object.entries(copy)) expect(voiceErrorText(code as VoiceError)).toBe(text)
  })
})
