import { describe, expect, it } from 'vitest'
import {
  MAX_CLIP_MS,
  MIN_SPEECH_MS,
  NO_SPEECH_MS,
  QUIET_AFTER_SPEECH_MS,
  SPEECH_LEVEL,
  endpoint,
  endpointStart,
  type EndpointOut,
  type EndpointState
} from '../src/state/endpointer'

const LOUD = SPEECH_LEVEL * 2
const QUIET = 0
const STEP = 50
const fresh = (): EndpointState => endpointStart(0)
/** Feeds `[level, now]` samples and returns the first outcome and the state after it. */
const feed = (s: EndpointState, samples: [number, number][]): { state: EndpointState; out: EndpointOut } => {
  let state = s
  for (const [level, now] of samples) {
    const r = endpoint(state, level, now)
    state = r.state
    if (r.out) return r
  }
  return { state, out: null }
}
/** One sample every 50 ms from `from` to `to`, as the hook's timer makes them. */
const run = (level: number, from: number, to: number): [number, number][] => {
  const out: [number, number][] = []
  for (let t = from; t <= to; t += STEP) out.push([level, t])
  return out
}

describe('endpoint', () => {
  it('waits 1 s of quiet after speech', () => expect(QUIET_AFTER_SPEECH_MS).toBe(1000))

  it('speech then QUIET_AFTER_SPEECH_MS (1 s) of quiet is a finished clip', () => {
    const speech = run(LOUD, 500, 1000)
    const r = feed(fresh(), [...speech, ...run(QUIET, 1050, 1000 + QUIET_AFTER_SPEECH_MS - STEP)])
    expect(r.out).toBeNull()
    expect(feed(r.state, [[QUIET, 1000 + QUIET_AFTER_SPEECH_MS + STEP]]).out).toBe('clip-done')
  })

  it('does not finish before the quiet has lasted QUIET_AFTER_SPEECH_MS', () => {
    expect(feed(fresh(), [...run(LOUD, 500, 1000), ...run(QUIET, 1050, 2000)]).out).toBeNull()
  })

  it('speaking again restarts the quiet count', () => {
    const r = feed(fresh(), [
      ...run(LOUD, 500, 1000),
      ...run(QUIET, 1050, 1500),
      ...run(LOUD, 1550, 2000),
      ...run(QUIET, 2050, 2050 + QUIET_AFTER_SPEECH_MS - 100)
    ])
    expect(r.out).toBeNull()
    expect(r.state.quietSince).toBe(2050)
  })

  it('8000 ms with no speech is no-speech', () => {
    expect(
      feed(fresh(), [
        [QUIET, 1000],
        [QUIET, NO_SPEECH_MS - 1]
      ]).out
    ).toBeNull()
    expect(feed(fresh(), [[QUIET, NO_SPEECH_MS]]).out).toBe('no-speech')
  })

  it('quiet before any speech never counts as the end of a clip', () => {
    expect(
      feed(fresh(), [
        [QUIET, 100],
        [QUIET, 5000]
      ]).out
    ).toBeNull()
  })

  it('60 s is too-long even while speech goes on', () => {
    expect(feed(fresh(), [[LOUD, MAX_CLIP_MS - 1]]).out).toBeNull()
    expect(feed(fresh(), [...run(LOUD, 1000, 1500), [LOUD, MAX_CLIP_MS]]).out).toBe('too-long')
  })

  it('a level just under the threshold is quiet', () => {
    const r = endpoint(fresh(), SPEECH_LEVEL - 0.001, 100)
    expect(r.state.heardAt).toBeNull()
  })

  describe('minimum speech', () => {
    it('a 100 ms blip then 1.5 s of quiet is no clip, and listening goes on', () => {
      const r = feed(fresh(), [...run(LOUD, 500, 600), ...run(QUIET, 650, 600 + QUIET_AFTER_SPEECH_MS + STEP)])
      expect(r.out).toBeNull()
      expect(r.state).toMatchObject({ heardAt: null, quietSince: null, speechMs: 0 })
    })

    it('400 ms of speech then 1.5 s of quiet is a clip', () => {
      expect(MIN_SPEECH_MS).toBe(300)
      const r = feed(fresh(), [...run(LOUD, 500, 900), ...run(QUIET, 950, 900 + QUIET_AFTER_SPEECH_MS + STEP)])
      expect(r.out).toBe('clip-done')
    })

    it('a blip, a discard, then real speech still makes a clip', () => {
      const r = feed(fresh(), [...run(LOUD, 500, 600), ...run(QUIET, 650, 2300), ...run(LOUD, 2350, 2800), ...run(QUIET, 2850, 4500)])
      expect(r.out).toBe('clip-done')
    })

    it('speech in short bursts adds up to the minimum', () => {
      const r = feed(fresh(), [...run(LOUD, 500, 650), ...run(QUIET, 700, 900), ...run(LOUD, 950, 1100), ...run(QUIET, 1150, 3000)])
      expect(r.out).toBe('clip-done')
    })

    it('blips never extend the 8 s no-speech deadline', () => {
      const blip = run(LOUD, NO_SPEECH_MS - 400, NO_SPEECH_MS - 300)
      expect(feed(fresh(), [...run(QUIET, 50, NO_SPEECH_MS - 450), ...blip]).out).toBeNull()
      const r = feed(fresh(), [...run(QUIET, 50, NO_SPEECH_MS - 450), ...blip, ...run(QUIET, NO_SPEECH_MS - 250, NO_SPEECH_MS + 200)])
      expect(r.out).toBe('no-speech')
    })

    it('blips spread out before the deadline do not delay it either', () => {
      const samples: [number, number][] = []
      for (let t = 1000; t < NO_SPEECH_MS; t += 2000) samples.push(...run(LOUD, t, t + 50), ...run(QUIET, t + 100, t + 1900))
      const r = feed(fresh(), [...samples, ...run(QUIET, NO_SPEECH_MS - 50, NO_SPEECH_MS + 100)])
      expect(r.out).toBe('no-speech')
    })

    it('one late sample from a throttled timer is not seconds of speech', () => {
      const r = feed(fresh(), [[LOUD, 100], [LOUD, 5000], ...run(QUIET, 5050, 5050 + QUIET_AFTER_SPEECH_MS + STEP)])
      expect(r.out).toBeNull()
    })
  })
})
