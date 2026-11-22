// A voice request as a pure machine: listen once, transcribe, route, create the chat, send, then open the chat. The
// hook (useVoiceTalk) performs the effects and feeds events back; nothing here does I/O. Modelled on dictation.ts:
// `run` counts talks, so a late event from an old one is ignored. The talk is seconds long and ends by opening the chat.
import { displayName } from '@zumibot/shared/agentName'
import type { VoiceRoute } from './voiceRoute'

/**
 * listening: one clip is being recorded. transcribing: it is being turned into text. sending: a route, the chat's
 * creation or the message is in flight. ended: over (the chat was opened, or nothing was sent), the mic is released.
 */
export type TalkPhase = 'idle' | 'listening' | 'transcribing' | 'sending' | 'ended'

export interface TalkState {
  phase: TalkPhase
  run: number
  chatId: string | null
  /** The agent the talk goes to once known; set early when it was named without a request. */
  agent: string | null
  /** What to send: the request after the agent's name; kept after the send so a failure can quote it. */
  request: string | null
  /** Transcription failures in a row. */
  failures: number
  /** Why the talk went nowhere, or what it still needs from the user (English, like the rest of the UI); null otherwise. */
  notice: string | null
}

export type TalkEvent =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'clipDone'; run: number }
  | { type: 'heard'; run: number; text: string }
  | { type: 'noSpeech'; run: number }
  | { type: 'transcribeFailed'; run: number }
  | { type: 'routed'; run: number; route: VoiceRoute }
  | { type: 'chatReady'; run: number; chatId: string; agent: string }
  | { type: 'sent'; run: number; itemId: string }
  | { type: 'sendFailed'; run: number }

/**
 * acquire: the wake lock and the microphone. release: all of them and every request in flight. listen: record one clip
 * (endpointer), then clipDone or noSpeech. transcribe: the clip, with full cleaning like dictation. route: routeUtterance
 * on the text, then routed. open: show the chat; the talk is already released. Every effect that answers later carries its run.
 */
export type TalkEffect =
  | { type: 'acquire'; run: number }
  | { type: 'release' }
  | { type: 'listen'; run: number }
  | { type: 'transcribe'; run: number }
  | { type: 'route'; run: number; text: string }
  | { type: 'createChat'; run: number; agent: string }
  | { type: 'send'; run: number; text: string }
  | { type: 'open'; chatId: string }

/** The notice of a talk that heard nothing: the one ending the island closes on without a word (see talkEndAction). */
export const NO_SPEECH_NOTICE = "Didn't hear anything."
const QUOTE_MAX = 200
const failedSend = (request: string | null): string => {
  const t = (request ?? '').trim()
  if (t === '') return "Couldn't send that."
  return `Couldn't send that: “${[...t].length > QUOTE_MAX ? `${[...t].slice(0, QUOTE_MAX).join('')}…` : t}”`
}

export const TALK_IDLE: TalkState = { phase: 'idle', run: 0, chatId: null, agent: null, request: null, failures: 0, notice: null }

export interface TalkStep {
  state: TalkState
  effects: TalkEffect[]
}

const same = (s: TalkState): TalkStep => ({ state: s, effects: [] })
const out = (state: TalkState, ...effects: TalkEffect[]): TalkStep => ({ state, effects })
const listen = (s: TalkState): TalkStep => out({ ...s, phase: 'listening' }, { type: 'listen', run: s.run })
/** Over with nothing sent (or the chat already opened): the mic and the wake lock go. */
const finish = (s: TalkState, notice: string | null = null): TalkStep => out({ ...s, phase: 'ended', notice }, { type: 'release' })

function heard(s: TalkState, raw: string): TalkStep {
  const text = raw.trim()
  if (text === '') return finish(s, NO_SPEECH_NOTICE) // noise the transcriber found nothing in
  const t: TalkState = { ...s, failures: 0, notice: null }
  // An agent was named alone: this is what to ask it. Otherwise this is the first utterance, which picks the agent.
  if (t.agent !== null) return out({ ...t, phase: 'sending', request: text }, { type: 'createChat', run: t.run, agent: t.agent })
  return out({ ...t, phase: 'sending' }, { type: 'route', run: t.run, text })
}

function routed(s: TalkState, r: VoiceRoute): TalkStep {
  switch (r.kind) {
    case 'agent':
      // "Ask Work Assistant" and nothing after it: listen once more for the request itself.
      if (r.request === '') return listen({ ...s, agent: r.agent, notice: `What should I ask ${displayName(r.agent)}?` })
      return out({ ...s, agent: r.agent, request: r.request }, { type: 'createChat', run: s.run, agent: r.agent })
    case 'unknown':
      return finish(s, r.named === '' ? "I don't know that agent." : `I don't know an agent called ${r.named}.`)
    case 'no-agent':
      return finish(s, "Who should I ask? Say: ask, then an agent's name.")
  }
}

export function step(s: TalkState, e: TalkEvent): TalkStep {
  switch (e.type) {
    case 'start':
      if (s.phase !== 'idle' && s.phase !== 'ended') return same(s)
      return out(
        { ...TALK_IDLE, run: s.run + 1, phase: 'listening' },
        { type: 'acquire', run: s.run + 1 },
        { type: 'listen', run: s.run + 1 }
      )

    case 'stop':
      // A new run, so nothing still in flight from this one can reach the next.
      return out({ ...TALK_IDLE, run: s.run + 1 }, { type: 'release' })
  }

  if (e.run !== s.run) return same(s)

  switch (e.type) {
    case 'clipDone':
      return s.phase === 'listening' ? out({ ...s, phase: 'transcribing' }, { type: 'transcribe', run: s.run }) : same(s)

    case 'heard':
      return s.phase === 'transcribing' ? heard(s, e.text) : same(s)

    case 'noSpeech':
      return s.phase === 'listening' ? finish(s, NO_SPEECH_NOTICE) : same(s)

    case 'transcribeFailed':
      if (s.phase !== 'listening' && s.phase !== 'transcribing') return same(s)
      // Once more, then it is a notice: a flaky connection should not loop.
      return s.failures + 1 >= 2 ? finish({ ...s, failures: 0 }, "Couldn't understand that.") : listen({ ...s, failures: s.failures + 1 })

    case 'routed':
      return s.phase === 'sending' && s.chatId === null ? routed(s, e.route) : same(s)

    case 'chatReady':
      if (s.phase !== 'sending' || s.chatId !== null) return same(s)
      return out({ ...s, chatId: e.chatId, agent: e.agent }, { type: 'send', run: s.run, text: s.request ?? '' })

    case 'sent':
      // The message is in the chat: nothing more to wait for, the chat is shown and the mic goes.
      if (s.phase !== 'sending' || s.chatId === null) return same(s)
      return out({ ...s, phase: 'ended' }, { type: 'release' }, { type: 'open', chatId: s.chatId })

    case 'sendFailed':
      return s.phase === 'sending' ? finish(s, failedSend(s.request)) : same(s)
  }
}
