import { useEffect, useRef, useState } from 'react'
import type { AgentSummary, ChatItem } from '@zumibot/shared/types'
import type { VoiceTalk } from '@zumibot/shared/voice'
import { api } from './api'
import { errorMessage } from './errors'
import { transcribeClip } from './net/voice'
import { endpoint, endpointStart, type EndpointState } from './state/endpointer'
import { createTokens, messageInPush, sendId, sendOutcome, shouldStopOnHide, type OpKind } from './state/talkOps'
import { isNotConnected } from './state/resync'
import { contentTypeOf, micError, pickRecorderType } from './state/voice'
import { voiceErrorText } from './state/dictation'
import { routeUtterance } from './state/voiceRoute'
import { TALK_IDLE, step, type TalkEffect, type TalkEvent, type TalkState } from './state/voiceTalk'
import { DICTATION_INPUT_EVENT } from './useDictation'

// The only place a voice request does I/O: the machine (state/voiceTalk) decides, this carries its effects out over
// getUserMedia, MediaRecorder, an AnalyserNode, the transcribe route and the chat API, and feeds the results back as
// events. No router and no App state: the desk island runs the same hook, and `open` hands the chat to its host.

export interface VoiceTalkControl {
  state: TalkState
  /** Why a talk ended that the machine does not know (the mic refused, the connection lost, the server's own error); null otherwise. */
  notice: string | null
  start(): void
  stop(): void
  /** The mic's level right now (RMS, about 0..0.3 for speech), read each animation frame by the waveform; 0 when not recording. */
  level(): number
}

const SAMPLE_MS = 50
const BITS_PER_SECOND = 32_000

const quiet = (): void => {}
const stopTracks = (s: MediaStream): void => s.getTracks().forEach((t) => t.stop())
const supported = (t: string): boolean => MediaRecorder.isTypeSupported(t)

interface Host {
  render(s: TalkState): void
  notice(text: string | null): void
  clear(): void
  agents(): readonly AgentSummary[]
  talk(): Pick<VoiceTalk, 'defaultAgent' | 'aliases'>
  /** The request is in the chat: show it. The talk has already released the mic. */
  /** The request is in its chat: show it. `agent` is the agent it went to (the island opens that agent's popup). */
  open(chatId: string, agent: string | null): void
  /** The desk island's page: its window may read as hidden while it is in use, so a hide does not end the talk. */
  island(): boolean
}

/** Root mean square of the mic's last block, 0..1. */
function level(analyser: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buf)
  let sum = 0
  for (const x of buf) sum += x * x
  return Math.sqrt(sum / buf.length)
}

function createTalk(host: Host) {
  let state = TALK_IDLE
  const tokens = createTokens()

  // The microphone and the screen
  let stream: MediaStream | null = null
  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  // The last mic level the endpointer saw, for the waveform; 0 whenever no clip is being recorded.
  let micLevel = 0
  let samples: Float32Array<ArrayBuffer> | null = null
  let wake: WakeLockSentinel | null = null
  let micRun: number | null = null // the run whose getUserMedia is out
  let awake = false
  let stopListeners: (() => void) | null = null

  // What each kind of operation holds while it is live
  let listening: { stop(): void } | null = null
  let waitingForMic: { tok: number; run: number } | null = null
  let clip: { blob: Blob; type: string } | null = null
  let transcribing: AbortController | null = null

  // The chat
  let stopPush: (() => void) | null = null
  let sending: { id: string; run: number } | null = null

  // ---- events: one at a time, so an effect that answers at once cannot interleave with the rest of its batch ----

  const queue: TalkEvent[] = []
  let busy = false
  const dispatch = (e: TalkEvent): void => {
    queue.push(e)
    if (busy) return
    busy = true
    try {
      for (let n = queue.shift(); n; n = queue.shift()) handle(n)
    } finally {
      busy = false
    }
  }

  const handle = (e: TalkEvent): void => {
    const next = step(state, e)
    state = next.state
    host.render(state)
    for (const f of next.effects) run(f)
  }

  // ---- effects ----

  const run = (f: TalkEffect): void => {
    switch (f.type) {
      case 'acquire':
        return acquire(f.run)
      case 'release':
        return release()
      case 'listen':
        return listen(f.run)
      case 'transcribe':
        return transcribe(f.run)
      case 'route':
        return dispatch({ type: 'routed', run: f.run, route: routeUtterance(f.text, host.agents(), host.talk()) })
      case 'createChat':
        return createChat(f.run, f.agent)
      case 'send':
        return send(f.run, f.text)
      case 'open':
        return host.open(f.chatId, state.agent)
    }
  }

  /** A request failed: the machine ends the talk; the reason shows on screen. */
  const failed = (run: number, e: unknown): void => {
    host.notice(errorMessage(e))
    dispatch({ type: 'sendFailed', run })
  }

  const cancelOp = (k: OpKind): void => {
    tokens.cancel(k)
    if (k === 'listen') {
      listening?.stop()
      listening = null
      waitingForMic = null
    } else {
      transcribing?.abort()
      transcribing = null
      clip = null
    }
  }

  // ---- the microphone and the wake lock ----

  const lockScreen = (): void => {
    try {
      void navigator.wakeLock?.request('screen').then((w) => {
        // Released before the lock arrived: give it straight back.
        if (awake && !wake) wake = w
        else w.release().catch(quiet)
      }, quiet)
    } catch {
      // no wake lock
    }
  }

  const acquire = (run: number): void => {
    if (micRun !== null || stream) return
    micRun = run
    awake = true
    lockScreen()
    // Made here, inside the tap that started the talk: a phone only lets a page listen after one.
    try {
      audioCtx = new AudioContext()
      void audioCtx.resume().catch(quiet)
    } catch {
      // no level meter: the endpointer then hears silence and the talk ends as "didn't hear anything"
    }
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible' || !awake) return
      // A hidden page loses its lock: ask again when it is back.
      if (!wake || wake.released) {
        wake = null
        lockScreen()
      }
      void audioCtx?.resume().catch(quiet)
    }
    const onHide = (): void => {
      stop()
    }
    // A locked or backgrounded phone mutes the mic: the talk ends (the island is exempt, its window is never the focused one).
    const onHidden = (): void => {
      if (shouldStopOnHide(document.visibilityState, host.island())) stop()
    }
    // A dropped socket means the request cannot be sent: the talk ends here.
    const offStatus = api.connection.onStatus((c) => {
      if (c === 'connected' || state.phase === 'idle' || state.phase === 'ended') return
      host.notice('Connection lost.')
      stop()
    })
    document.addEventListener('visibilitychange', onVisible)
    document.addEventListener('visibilitychange', onHidden)
    window.addEventListener('pagehide', onHide)
    stopListeners = () => {
      document.removeEventListener('visibilitychange', onVisible)
      document.removeEventListener('visibilitychange', onHidden)
      window.removeEventListener('pagehide', onHide)
      offStatus()
    }
    let asking: Promise<MediaStream>
    try {
      asking = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch (err) {
      asking = Promise.reject(err)
    }
    asking.then(
      (s) => {
        if (micRun === run) micRun = null
        // Stopped, or another conversation began, while the prompt was up: the stream is let go before anything records.
        if (state.run !== run || state.phase === 'idle' || state.phase === 'ended') return stopTracks(s)
        stream = s
        try {
          if (audioCtx) {
            analyser = audioCtx.createAnalyser()
            analyser.fftSize = 1024
            samples = new Float32Array(analyser.fftSize)
            audioCtx.createMediaStreamSource(s).connect(analyser)
          }
        } catch {
          analyser = null
        }
        if (waitingForMic && tokens.isCurrent('listen', waitingForMic.tok)) startRecording(waitingForMic.tok, waitingForMic.run)
        waitingForMic = null
      },
      (err) => {
        if (micRun === run) micRun = null
        if (state.run !== run) return
        host.notice(voiceErrorText(micError(err)))
        stop()
      }
    )
  }

  /** Everything the talk holds: the mic, the audio context, the wake lock, the requests in flight and the push listener. */
  const release = (): void => {
    for (const k of ['listen', 'transcribe'] as const) cancelOp(k)
    tokens.cancelAll()
    if (stream) stopTracks(stream)
    stream = null
    analyser = null
    samples = null
    waitingForMic = null
    const ctx = audioCtx
    audioCtx = null
    void ctx?.close().catch(quiet)
    awake = false
    const w = wake
    wake = null
    w?.release().catch(quiet)
    stopListeners?.()
    stopListeners = null
    stopPush?.()
    stopPush = null
    sending = null
    micRun = null
  }

  // ---- listening: one clip per `listen`, cut by the endpointer ----

  const listen = (run: number): void => {
    cancelOp('listen')
    const tok = tokens.begin('listen')
    const open = (): void => {
      // The mic is still being asked for (the first listen comes with the acquire).
      if (!stream) {
        waitingForMic = { tok, run }
        return
      }
      startRecording(tok, run)
    }
    open()
  }

  const startRecording = (tok: number, run: number): void => {
    const s = stream
    if (!s) return
    const type = pickRecorderType(supported) ?? ''
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(s, { mimeType: type, audioBitsPerSecond: BITS_PER_SECOND })
    } catch {
      host.notice(voiceErrorText('failed'))
      stop()
      return
    }
    const chunks: Blob[] = []
    rec.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data)
    }
    let ep: EndpointState = endpointStart(Date.now())
    const timer = setInterval(() => {
      micLevel = analyser && samples ? level(analyser, samples) : 0
      const r = endpoint(ep, micLevel, Date.now())
      ep = r.state
      if (r.out === null) return
      clearInterval(timer)
      micLevel = 0
      if (r.out === 'no-speech') {
        // Nothing worth sending: the recorder goes, and the machine hears that nobody spoke.
        detach(rec)
        if (tokens.end('listen', tok)) {
          listening = null
          dispatch({ type: 'noSpeech', run })
        }
        return
      }
      // clip-done or too-long: the recorder's last chunk is in at its stop, and that is when the clip is whole.
      rec.onstop = () => {
        if (!tokens.end('listen', tok)) return
        listening = null
        clip = { blob: new Blob(chunks, { type: rec.mimeType || type }), type: rec.mimeType || type }
        dispatch({ type: 'clipDone', run })
      }
      try {
        rec.stop()
      } catch {
        // an already stopped recorder (the device went away): its clip is lost
        rec.onstop = null
        if (tokens.end('listen', tok)) {
          listening = null
          dispatch({ type: 'transcribeFailed', run })
        }
      }
    }, SAMPLE_MS)
    listening = {
      stop: () => {
        clearInterval(timer)
        micLevel = 0
        detach(rec)
      }
    }
    rec.start()
  }

  /** The recorder stops without reporting: its handlers go first, so a late stop event says nothing. */
  const detach = (rec: MediaRecorder): void => {
    rec.ondataavailable = null
    rec.onstop = null
    try {
      if (rec.state !== 'inactive') rec.stop()
    } catch {
      // already stopped with its tracks
    }
  }

  // ---- transcribing ----

  const transcribe = (run: number): void => {
    // Taken before the cancel below, which drops a clip nobody asked for.
    const taken = clip
    // The clip lives only as long as its request.
    clip = null
    cancelOp('transcribe')
    const tok = tokens.begin('transcribe')
    if (!taken) {
      if (tokens.end('transcribe', tok)) dispatch({ type: 'transcribeFailed', run })
      return
    }
    const ac = new AbortController()
    transcribing = ac
    void transcribeClip((...a) => fetch(...a), taken.blob, contentTypeOf(taken.type), 'auto', 'full', ac.signal).then((r) => {
      // The talk stopped, or listened again, while this was out: its answer must not reach the next one.
      if (!tokens.end('transcribe', tok)) return
      transcribing = null
      if (!r.ok) return dispatch({ type: 'transcribeFailed', run })
      const text = r.text.trim()
      if (text !== '') window.dispatchEvent(new Event(DICTATION_INPUT_EVENT))
      dispatch({ type: 'heard', run, text: r.text })
    })
  }

  // ---- the chat ----

  const createChat = (run: number, agent: string): void => {
    void api.chats.createVoice(agent).then(
      (meta) => {
        // Stopped while it was made: the chat stays (it is the user's), but this talk is over.
        if (state.run !== run || state.phase !== 'sending') return
        dispatch({ type: 'chatReady', run, chatId: meta.id, agent: meta.agentName })
      },
      (e) => failed(run, e)
    )
  }

  const markSent = (id: string): void => {
    if (sending?.id !== id) return
    const run = sending.run
    sending = null
    dispatch({ type: 'sent', run, itemId: id })
  }

  const send = (run: number, text: string): void => {
    const chatId = state.chatId
    if (chatId === null) return dispatch({ type: 'sendFailed', run })
    const id = sendId(globalThis.crypto)
    sending = { id, run }
    // The message is in the chat as soon as its items push says so, whatever chats:send (which settles at the turn's end) does.
    stopPush?.()
    stopPush = api.chats.onPush((p) => {
      if (sending && messageInPush(p, chatId, sending.id)) markSent(sending.id)
    })
    // The promise settles at the end of the turn: it is kept for a failure, never waited on to go on.
    api.chats.send(chatId, text, undefined, undefined, id).then(
      () => markSent(id),
      (e) => {
        if (sending?.id !== id) return // the message was seen in the chat: the turn failed after it, and its error item says so
        // A dropped connection says nothing about the message: open the chat, which resyncs and shows the truth. Any other
        // rejection is a failure unless the chat already holds the message.
        const decide = (notConnected: boolean, items: ChatItem[] | null): void =>
          sendOutcome(notConnected, items, id) === 'open' ? markSent(id) : lost(run, id, e)
        if (isNotConnected(e)) return decide(true, null)
        api.chats.items(chatId).then(
          (page) => decide(false, page.items),
          (err) => decide(isNotConnected(err), null)
        )
      }
    )
  }

  const lost = (run: number, id: string, e: unknown): void => {
    if (sending?.id !== id) return
    sending = null
    failed(run, e)
  }

  // ---- the controls ----

  const stop = (): void => dispatch({ type: 'stop' })
  const start = (): void => {
    host.clear()
    dispatch({ type: 'start' })
  }

  return {
    start,
    stop,
    level: (): number => micLevel,
    /** The page is going: the machine stops, and everything is released whatever it did. */
    dispose: (): void => {
      stop()
      release()
    },
    state: () => state
  }
}

export function useVoiceTalk(o: {
  agents: AgentSummary[]
  talk: VoiceTalk
  island?: boolean
  onOpen(chatId: string, agent: string | null): void
}): VoiceTalkControl {
  const [state, setState] = useState<TalkState>(TALK_IDLE)
  const [notice, setNotice] = useState<string | null>(null)
  const opts = useRef(o)
  opts.current = o
  const [ctl] = useState(() =>
    createTalk({
      render: setState,
      notice: setNotice,
      clear: () => setNotice(null),
      agents: () => opts.current.agents,
      talk: () => opts.current.talk,
      island: () => opts.current.island === true,
      open: (chatId, agent) => opts.current.onOpen(chatId, agent)
    })
  )
  // A page left, or a chat opened from it, ends the talk: the mic and the screen lock go.
  useEffect(() => () => ctl.dispose(), [ctl])
  return { state, notice, start: ctl.start, stop: ctl.stop, level: ctl.level }
}
