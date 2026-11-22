import { VOICE_MAX_MS, VOICE_MIN_MS } from '@zumibot/shared/voice'

export type VoiceError = 'blocked' | 'nomic' | 'empty' | 'network' | 'upstream' | 'timeout' | 'failed' | 'too-large' | 'off' | 'busy'

const ERROR_TEXT: Record<VoiceError, string> = {
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

export const voiceErrorText = (e: VoiceError): string => ERROR_TEXT[e]

export type DictationPhase = 'idle' | 'starting' | 'listening' | 'transcribing' | 'error'

/** `run` counts attempts: every async event carries the run it belongs to, so a late one from a dropped run is ignored. */
export interface DictationState {
  phase: DictationPhase
  run: number
  startedAt: number | null
  /** A Send pressed while dictating: sent after the transcript is inserted. */
  sendAfter: boolean
  /** The 5-minute cap ended the recording. */
  capped: boolean
  error: VoiceError | null
}

export type DictationEvent =
  | { type: 'tap'; now: number }
  | { type: 'granted'; run: number; now: number }
  | { type: 'denied'; run: number; error: 'blocked' | 'nomic' | 'failed' }
  | { type: 'tick'; now: number }
  | { type: 'hidden' }
  | { type: 'send' }
  | { type: 'drop' }
  | { type: 'dismiss' }
  | { type: 'recorded'; run: number; ms: number }
  | { type: 'result'; run: number; text: string }
  | { type: 'failed'; run: number; error: VoiceError }

/** finish: stop the recorder so it delivers its clip. release: stop every track and the wake lock. upload: send the finished clip. abort: discard the clip and abort any upload. */
export type DictationEffect =
  | { type: 'acquire'; run: number }
  | { type: 'finish'; run: number }
  | { type: 'release' }
  | { type: 'upload'; run: number }
  | { type: 'abort' }
  | { type: 'insert'; text: string }
  | { type: 'send' }
  | { type: 'announce'; text: string }

export const IDLE: DictationState = { phase: 'idle', run: 0, startedAt: null, sendAfter: false, capped: false, error: null }

export interface DictationStep {
  state: DictationState
  effects: DictationEffect[]
}

const same = (s: DictationState): DictationStep => ({ state: s, effects: [] })
const announce = (text: string): DictationEffect => ({ type: 'announce', text })
const settled = (s: DictationState, phase: 'idle' | 'error', error: VoiceError | null = null): DictationState => ({
  ...s,
  phase,
  startedAt: null,
  sendAfter: false,
  capped: false,
  error
})
/** A fresh run, so nothing from the previous one can reach it. */
const begin = (s: DictationState): DictationStep => ({
  state: { phase: 'starting', run: s.run + 1, startedAt: null, sendAfter: false, capped: false, error: null },
  effects: [{ type: 'acquire', run: s.run + 1 }]
})
const stopListening = (s: DictationState, patch: Partial<DictationState> = {}): DictationStep => ({
  state: { ...s, ...patch, phase: 'transcribing' },
  effects: [{ type: 'finish', run: s.run }, { type: 'release' }, announce('Transcribing')]
})
/** A held Send still goes out when nothing was dictated, but not when the transcription failed. */
const emptied = (s: DictationState, first: DictationEffect[]): DictationStep => ({
  state: settled(s, 'error', 'empty'),
  effects: [...first, announce(voiceErrorText('empty')), ...(s.sendAfter ? [{ type: 'send' } as const] : [])]
})

/** Only the current run's transcription answers count: any other phase or run means the user already moved on. */
const awaiting = (s: DictationState, run: number): boolean => s.phase === 'transcribing' && run === s.run

export function step(s: DictationState, e: DictationEvent): DictationStep {
  switch (e.type) {
    case 'tap':
      switch (s.phase) {
        case 'idle':
        case 'error':
          return begin(s)
        case 'starting':
          return { state: settled(s, 'idle'), effects: [{ type: 'release' }] }
        case 'listening':
          return stopListening(s)
        case 'transcribing':
          return { state: settled(s, 'idle'), effects: [{ type: 'abort' }, announce('Dictation cancelled')] }
      }
      return same(s)

    case 'granted':
      if (e.run !== s.run) return same(s) // the hook lets go of a stream it got for an older run itself
      if (s.phase !== 'starting') return { state: s, effects: [{ type: 'release' }] }
      return { state: { ...s, phase: 'listening', startedAt: e.now }, effects: [announce('Listening')] }

    case 'denied':
      if (e.run !== s.run || s.phase !== 'starting') return same(s)
      return { state: settled(s, 'error', e.error), effects: [{ type: 'release' }, announce(voiceErrorText(e.error))] }

    case 'tick':
      if (s.phase !== 'listening' || s.startedAt === null || e.now - s.startedAt < VOICE_MAX_MS) return same(s)
      return stopListening(s, { capped: true })

    case 'hidden':
      return s.phase === 'listening' ? stopListening(s) : same(s)

    case 'send':
      switch (s.phase) {
        case 'starting':
          return { state: settled(s, 'idle'), effects: [{ type: 'release' }] }
        case 'listening':
          return stopListening(s, { sendAfter: true })
        case 'transcribing':
          return s.sendAfter ? same(s) : { state: { ...s, sendAfter: true }, effects: [] }
      }
      return same(s)

    case 'drop':
      if (s.phase === 'idle') return same(s)
      if (s.phase === 'error') return { state: settled(s, 'idle'), effects: [] }
      return { state: settled(s, 'idle'), effects: [{ type: 'release' }, { type: 'abort' }] }

    case 'dismiss':
      return s.phase === 'error' ? { state: settled(s, 'idle'), effects: [] } : same(s)

    case 'recorded':
      if (!awaiting(s, e.run)) return same(s)
      if (e.ms < VOICE_MIN_MS) return emptied(s, [{ type: 'abort' }])
      return { state: s, effects: [{ type: 'upload', run: s.run }] }

    case 'result': {
      if (!awaiting(s, e.run)) return same(s)
      const text = e.text.trim()
      if (!text) return emptied(s, [])
      // Insert before the held send, so the sent message carries the transcript.
      return {
        state: settled(s, 'idle'),
        effects: [{ type: 'insert', text }, announce('Dictation added'), ...(s.sendAfter ? [{ type: 'send' } as const] : [])]
      }
    }

    case 'failed':
      if (e.run !== s.run) return same(s)
      if (s.phase === 'transcribing') return { state: settled(s, 'error', e.error), effects: [announce(voiceErrorText(e.error))] }
      // A recorder that breaks while listening still holds the mic.
      if (s.phase === 'listening')
        return { state: settled(s, 'error', e.error), effects: [{ type: 'release' }, { type: 'abort' }, announce(voiceErrorText(e.error))] }
      return same(s)
  }
}

export const holdsSend = (s: DictationState): boolean => s.phase === 'listening' || s.phase === 'transcribing'

/** Voice turned off mid-recording must not take away the only way to stop it. */
export const micVisible = (voiceOn: boolean, s: DictationState): boolean => voiceOn || s.phase === 'starting' || holdsSend(s)

/** A box disabled mid-dictation (claudeFound lost, the edit sending) must still let the user stop or cancel it. */
export const micDisabled = (boxDisabled: boolean, s: DictationState): boolean => boxDisabled && (s.phase === 'idle' || s.phase === 'error')

/** Read from the state before the step: a settled state no longer says the cap stopped it. */
export const capNote = (prev: DictationState, effects: DictationEffect[]): boolean =>
  prev.capped && effects.some((f) => f.type === 'insert')
