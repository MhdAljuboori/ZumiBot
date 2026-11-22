import { describe, expect, it } from 'vitest'
import { TALK_IDLE, step, type TalkEffect, type TalkEvent, type TalkState } from '../src/state/voiceTalk'

type Ev = TalkEvent extends infer E ? (E extends { run: number } ? Omit<E, 'run'> : never) : never
type Plain = Exclude<TalkEvent, { run: number }>
type Fire = Ev | Plain

/** Runs events in order; each async one is stamped with the current run, as the hook does. */
const play = (s: TalkState, ...events: Fire[]): { state: TalkState; effects: TalkEffect[]; all: TalkEffect[] } => {
  let state = s
  let effects: TalkEffect[] = []
  const all: TalkEffect[] = []
  for (const e of events) {
    const needsRun = !['start', 'stop'].includes(e.type)
    ;({ state, effects } = step(state, (needsRun ? { ...e, run: state.run } : e) as TalkEvent))
    all.push(...effects)
  }
  return { state, effects, all }
}
const kinds = (fx: TalkEffect[]): string[] => fx.map((f) => f.type)

const TO_ROUTE: Fire[] = [{ type: 'start' }, { type: 'clipDone' }, { type: 'heard', text: 'Ask Work Assistant to set a meeting' }]
const TO_CHAT: Fire[] = [...TO_ROUTE, { type: 'routed', route: { kind: 'agent', agent: 'work-assistant', request: 'set a meeting' } }]
const TO_SENT: Fire[] = [...TO_CHAT, { type: 'chatReady', chatId: 'c1', agent: 'work-assistant', agentLabel: 'Work Assistant' }]

describe('start and listen', () => {
  it('start acquires the mic and listens in a new run', () => {
    const r = play(TALK_IDLE, { type: 'start' })
    expect(r.state).toMatchObject({ phase: 'listening', run: 1, chatId: null, notice: null })
    expect(r.effects).toEqual([
      { type: 'acquire', run: 1 },
      { type: 'listen', run: 1 }
    ])
  })
  it('start works again from ended, in a new run', () => {
    const ended = play(TALK_IDLE, { type: 'start' }, { type: 'noSpeech' }).state
    expect(ended.phase).toBe('ended')
    const again = play(ended, { type: 'start' })
    expect(again.state).toMatchObject({ phase: 'listening', run: ended.run + 1 })
    expect(kinds(again.effects)).toEqual(['acquire', 'listen'])
  })
  it('start while a talk runs is ignored', () => {
    const s = play(TALK_IDLE, { type: 'start' }).state
    expect(play(s, { type: 'start' })).toMatchObject({ state: s, effects: [] })
  })
  it('a finished clip is transcribed with full cleaning (the request is cleaned like dictation)', () => {
    const r = play(TALK_IDLE, { type: 'start' }, { type: 'clipDone' })
    expect(r.state.phase).toBe('transcribing')
    expect(r.effects).toEqual([{ type: 'transcribe', run: 1 }])
  })
})

describe('happy path', () => {
  it('heard text is routed, the chat made, the request sent, then the chat is opened and everything released', () => {
    const heard = play(TALK_IDLE, ...TO_ROUTE)
    expect(heard.state.phase).toBe('sending')
    expect(heard.effects).toEqual([{ type: 'route', run: 1, text: 'Ask Work Assistant to set a meeting' }])

    const routed = play(heard.state, { type: 'routed', route: { kind: 'agent', agent: 'work-assistant', request: 'set a meeting' } })
    expect(routed.effects).toEqual([{ type: 'createChat', run: 1, agent: 'work-assistant' }])

    const ready = play(routed.state, { type: 'chatReady', chatId: 'c1', agent: 'work-assistant', agentLabel: 'Work Assistant' })
    expect(ready.state).toMatchObject({ phase: 'sending', chatId: 'c1' })
    expect(ready.effects).toEqual([{ type: 'send', run: 1, text: 'set a meeting' }])

    const sent = play(ready.state, { type: 'sent', itemId: 'u1' })
    expect(sent.state).toMatchObject({ phase: 'ended', chatId: 'c1' })
    expect(sent.effects).toEqual([{ type: 'release' }, { type: 'open', chatId: 'c1' }])
  })
  it('the default agent route sends the whole text', () => {
    const r = play(
      TALK_IDLE,
      { type: 'start' },
      { type: 'clipDone' },
      { type: 'heard', text: 'what is on today' },
      { type: 'routed', route: { kind: 'agent', agent: 'work-assistant', request: 'what is on today' } }
    )
    expect(r.effects).toEqual([{ type: 'createChat', run: 1, agent: 'work-assistant' }])
  })
  it('a Codex agent is an ordinary route now', () => {
    const r = play(
      TALK_IDLE,
      ...TO_ROUTE,
      { type: 'routed', route: { kind: 'agent', agent: 'codex-agent', request: 'hi' } },
      { type: 'chatReady', chatId: 'c9', agent: 'codex-agent', agentLabel: 'Codex Agent' }
    )
    expect(r.effects).toEqual([{ type: 'send', run: 1, text: 'hi' }])
  })
  it('nothing listens again after the chat opens: a late clip or cue event does nothing', () => {
    const done = play(TALK_IDLE, ...TO_SENT, { type: 'sent', itemId: 'u1' })
    expect(play(done.state, { type: 'clipDone' }).effects).toEqual([])
    expect(play(done.state, { type: 'noSpeech' }).effects).toEqual([])
  })
})

describe('notices', () => {
  it('an unknown agent says so, releases, and can be started again', () => {
    const r = play(TALK_IDLE, ...TO_ROUTE, { type: 'routed', route: { kind: 'unknown', named: 'Obada' } })
    expect(r.state).toMatchObject({ phase: 'ended', notice: "I don't know an agent called Obada." })
    expect(r.effects).toEqual([{ type: 'release' }])
    expect(kinds(play(r.state, { type: 'start' }).effects)).toEqual(['acquire', 'listen'])
  })
  it('an unknown agent with no name heard has a plain notice', () => {
    const r = play(TALK_IDLE, ...TO_ROUTE, { type: 'routed', route: { kind: 'unknown', named: '' } })
    expect(r.state.notice).toBe("I don't know that agent.")
  })
  it('no usable agent asks who, and ends', () => {
    const r = play(TALK_IDLE, ...TO_ROUTE, { type: 'routed', route: { kind: 'no-agent' } })
    expect(r.state).toMatchObject({ phase: 'ended', notice: "Who should I ask? Say: ask, then an agent's name." })
    expect(r.effects).toEqual([{ type: 'release' }])
  })
  it('starting again clears the last notice', () => {
    const ended = play(TALK_IDLE, ...TO_ROUTE, { type: 'routed', route: { kind: 'no-agent' } }).state
    expect(play(ended, { type: 'start' }).state.notice).toBeNull()
  })
})

describe('an agent named with no request', () => {
  const named = (): TalkState =>
    play(TALK_IDLE, ...TO_ROUTE, { type: 'routed', route: { kind: 'agent', agent: 'work-assistant', request: '' } }).state
  it('asks what, and listens once more', () => {
    const r = play(TALK_IDLE, ...TO_ROUTE, { type: 'routed', route: { kind: 'agent', agent: 'work-assistant', request: '' } })
    expect(r.state).toMatchObject({ phase: 'listening', agent: 'work-assistant', notice: 'What should I ask Work Assistant?' })
    expect(r.effects).toEqual([{ type: 'listen', run: 1 }])
  })
  it('the next utterance is the request, sent to that agent without routing', () => {
    const r = play(named(), { type: 'clipDone' }, { type: 'heard', text: 'set a meeting at four' })
    expect(r.all).toEqual([
      { type: 'transcribe', run: 1 },
      { type: 'createChat', run: 1, agent: 'work-assistant' }
    ])
    expect(r.state.notice).toBeNull()
    const sent = play(r.state, { type: 'chatReady', chatId: 'c1', agent: 'work-assistant', agentLabel: 'Work Assistant' })
    expect(sent.effects).toEqual([{ type: 'send', run: 1, text: 'set a meeting at four' }])
  })
  it('silence the second time ends with nothing sent', () => {
    const r = play(named(), { type: 'noSpeech' })
    expect(r.state.phase).toBe('ended')
    expect(r.effects).toEqual([{ type: 'release' }])
  })
})

describe('nothing heard', () => {
  it('no speech ends the talk with nothing sent, releasing the mic', () => {
    const r = play(TALK_IDLE, { type: 'start' }, { type: 'noSpeech' })
    expect(r.state).toMatchObject({ phase: 'ended', notice: "Didn't hear anything." })
    expect(r.effects).toEqual([{ type: 'release' }])
  })
  it('an empty transcript is the same as no speech', () => {
    const r = play(TALK_IDLE, { type: 'start' }, { type: 'clipDone' }, { type: 'heard', text: '   ' })
    expect(r.state.phase).toBe('ended')
    expect(r.effects).toEqual([{ type: 'release' }])
  })
})

describe('failures', () => {
  it('a failed transcription listens once more, then ends with a notice', () => {
    const first = play(TALK_IDLE, { type: 'start' }, { type: 'clipDone' }, { type: 'transcribeFailed' })
    expect(first.state).toMatchObject({ phase: 'listening', failures: 1 })
    expect(first.effects).toEqual([{ type: 'listen', run: 1 }])
    const second = play(first.state, { type: 'clipDone' }, { type: 'transcribeFailed' })
    expect(second.state).toMatchObject({ phase: 'ended', notice: "Couldn't understand that." })
    expect(second.effects).toEqual([{ type: 'release' }])
  })
  it('a heard text resets the failure count', () => {
    const r = play(
      TALK_IDLE,
      { type: 'start' },
      { type: 'clipDone' },
      { type: 'transcribeFailed' },
      { type: 'clipDone' },
      { type: 'heard', text: 'hi' }
    )
    expect(r.state.failures).toBe(0)
  })
  it('a failed send ends with a notice and releases; no chat is opened', () => {
    const r = play(TALK_IDLE, ...TO_SENT, { type: 'sendFailed' })
    expect(r.state).toMatchObject({ phase: 'ended', notice: "Couldn't send that: “set a meeting”" })
    expect(r.effects).toEqual([{ type: 'release' }])
  })
  it('a long request is cut in the notice so the words are kept but the line stays short', () => {
    const long = 'word '.repeat(80).trim()
    const r = play(
      TALK_IDLE,
      { type: 'start' },
      { type: 'clipDone' },
      { type: 'heard', text: long },
      { type: 'routed', route: { kind: 'agent', agent: 'a', request: long } },
      { type: 'sendFailed' }
    )
    expect(r.state.notice!.length).toBeLessThan(260)
    expect(r.state.notice).toMatch(/^Couldn't send that: “word word/)
    expect(r.state.notice).toMatch(/…”$/)
  })
  it('a failed chat creation (a sendFailed before chatReady) ends the same way', () => {
    const r = play(TALK_IDLE, ...TO_CHAT, { type: 'sendFailed' })
    expect(r.state.phase).toBe('ended')
    expect(r.effects).toEqual([{ type: 'release' }])
  })
})

describe('stop', () => {
  it.each([
    ['listening', [{ type: 'start' }] as Fire[]],
    ['transcribing', [{ type: 'start' }, { type: 'clipDone' }] as Fire[]],
    ['sending', TO_ROUTE],
    ['sending with a chat', TO_SENT]
  ])('mid-way in %s releases and starts a new run', (_n, evs) => {
    const s = play(TALK_IDLE, ...evs).state
    const r = play(s, { type: 'stop' })
    expect(r.state).toEqual({ ...TALK_IDLE, run: s.run + 1 })
    expect(r.effects).toEqual([{ type: 'release' }])
  })
  it('a stopped talk ignores what was still in flight', () => {
    const s = play(TALK_IDLE, { type: 'start' }, { type: 'clipDone' }).state
    const stopped = play(s, { type: 'stop' }).state
    for (const e of [
      { type: 'heard', run: s.run, text: 'hello' },
      { type: 'routed', run: s.run, route: { kind: 'no-agent' } },
      { type: 'sent', run: s.run, itemId: 'u' },
      { type: 'sendFailed', run: s.run },
      { type: 'chatReady', run: s.run, chatId: 'c', agent: 'a', agentLabel: 'A' }
    ] as TalkEvent[]) {
      expect(step(stopped, e)).toMatchObject({ state: stopped, effects: [] })
    }
  })
  it('stale events of an earlier talk never reach the next one', () => {
    const first = play(TALK_IDLE, { type: 'start' }, { type: 'clipDone' }).state
    const second = play(first, { type: 'stop' }, { type: 'start' }).state
    expect(second.run).toBe(first.run + 2)
    expect(step(second, { type: 'heard', run: first.run, text: 'old' })).toMatchObject({ state: second, effects: [] })
  })
})

describe('out of order events', () => {
  it('ignores events that do not fit the phase', () => {
    const idle = TALK_IDLE
    for (const e of [
      { type: 'clipDone', run: 0 },
      { type: 'heard', run: 0, text: 'x' },
      { type: 'noSpeech', run: 0 },
      { type: 'sent', run: 0, itemId: 'u' }
    ] as TalkEvent[]) {
      expect(step(idle, e)).toMatchObject({ state: idle, effects: [] })
    }
    const listening = play(TALK_IDLE, { type: 'start' }).state
    expect(play(listening, { type: 'heard', text: 'x' })).toMatchObject({ state: listening, effects: [] })
    expect(play(listening, { type: 'sent', itemId: 'u' })).toMatchObject({ state: listening, effects: [] })
    expect(play(listening, { type: 'routed', route: { kind: 'no-agent' } })).toMatchObject({ state: listening, effects: [] })
  })
  it('a second routed or chatReady is ignored', () => {
    const s = play(TALK_IDLE, ...TO_SENT).state
    expect(play(s, { type: 'chatReady', chatId: 'c2', agent: 'x', agentLabel: 'X' }).effects).toEqual([])
    expect(play(s, { type: 'routed', route: { kind: 'no-agent' } }).effects).toEqual([])
  })
})
