// End-of-speech from microphone levels. Pure: the hook samples the level on a timer and feeds it in.
export const SPEECH_LEVEL = 0.02 // RMS 0..1, tune live
// 1 s: long enough for a breath mid-sentence, short enough that the reply starts soon (it was 1.5 s, which felt slow).
export const QUIET_AFTER_SPEECH_MS = 1000
// A clip needs this much speech in all: a door slam or a cough is no answer (a silent "yes" must never come from noise).
export const MIN_SPEECH_MS = 300
export const NO_SPEECH_MS = 8000
export const MAX_CLIP_MS = 60_000
// A throttled timer (a hidden tab) must not turn one late sample into seconds of "speech".
const MAX_STEP_MS = 250

/**
 * heardAt: the last speech sample (null: none that counts). quietSince: the first quiet sample since then.
 * speechMs: speech time so far in this stretch. lastAt: the previous sample's time.
 */
export type EndpointState = {
  startedAt: number
  heardAt: number | null
  quietSince: number | null
  speechMs: number
  lastAt: number | null
}
export type EndpointOut = null | 'clip-done' | 'no-speech' | 'too-long'

export const endpointStart = (now: number): EndpointState => ({
  startedAt: now,
  heardAt: null,
  quietSince: null,
  speechMs: 0,
  lastAt: null
})

export function endpoint(s: EndpointState, level: number, now: number): { state: EndpointState; out: EndpointOut } {
  const speech = level >= SPEECH_LEVEL
  let speechMs = s.speechMs + (speech && s.lastAt !== null ? Math.min(now - s.lastAt, MAX_STEP_MS) : 0)
  let heardAt = speech ? now : s.heardAt
  // A pause only counts once there was speech to pause after; speaking again starts the count over.
  let quietSince = heardAt === null || speech ? null : (s.quietSince ?? now)
  // A blip followed by a whole quiet period was never speech: forgotten, the clip goes on listening. startedAt stays, so
  // blips never push the no-speech deadline out.
  if (speechMs < MIN_SPEECH_MS && quietSince !== null && now - quietSince >= QUIET_AFTER_SPEECH_MS) {
    heardAt = null
    quietSince = null
    speechMs = 0
  }
  const state = { startedAt: s.startedAt, heardAt, quietSince, speechMs, lastAt: now }
  // A clip that never stops (a fan, a TV) must still end, and be sent as it is.
  if (now - s.startedAt >= MAX_CLIP_MS) return { state, out: 'too-long' }
  if (speechMs < MIN_SPEECH_MS) {
    // Only a quiet sample ends the wait: a speaker who is mid-word at the deadline still gets to reach the minimum.
    return { state, out: !speech && now - s.startedAt >= NO_SPEECH_MS ? 'no-speech' : null }
  }
  return { state, out: quietSince !== null && now - quietSince >= QUIET_AFTER_SPEECH_MS ? 'clip-done' : null }
}
