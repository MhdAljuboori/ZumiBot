import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { VoiceLang, VoiceStatus } from '@zumibot/shared/voice'
import { api } from './api'
import { transcribeClip } from './net/voice'
import { IDLE, capNote, holdsSend, step, type DictationEffect, type DictationEvent, type DictationState } from './state/dictation'
import { contentTypeOf, loadLang, micError, micShown, nextLang, pickRecorderType, saveLang } from './state/voice'

/** Dispatched on `window` while dictating: useNotifications counts it as input, so a long dictation keeps "looking". */
export const DICTATION_INPUT_EVENT = 'zumibot:input'

const TICK_MS = 250
const PRESENCE_MS = 30_000
const ERROR_MS = 8_000
const CAP_NOTE_MS = 4_000
const BITS_PER_SECOND = 32_000

const quiet = (): void => {}
const signalInput = (): void => void window.dispatchEvent(new Event(DICTATION_INPUT_EVENT))
const stopTracks = (s: MediaStream): void => s.getTracks().forEach((t) => t.stop())
const supported = (t: string): boolean => MediaRecorder.isTypeSupported(t)

// ---- whether the mic shows: one watcher per page, shared by every box ----

let voiceStatus: VoiceStatus | null = null
let micPermission: 'granted' | 'denied' | 'prompt' | 'unknown' = 'unknown'
let recordable: boolean | null = null
let watching = false
const watchers = new Set<() => void>()
const changed = (): void => {
  for (const cb of [...watchers]) cb()
}

function watchVoice(): void {
  if (watching) return
  watching = true
  // A change broadcast after a status request was sent is newer than its answer.
  let asked = 0
  api.voice.onChanged((s) => {
    asked++
    voiceStatus = s
    changed()
  })
  // Asked on every connect: a call while the socket is down fails, and a change broadcast while it was down is missed.
  api.connection.onStatus((c) => {
    if (c !== 'connected') return
    const mine = ++asked
    api.voice.status().then((s) => {
      if (mine !== asked) return
      voiceStatus = s
      changed()
    }, quiet)
  })
  // Only the shell's answer matters (micShown): there, denied is an older shell that can never grant the mic.
  if (api.desktop) {
    try {
      navigator.permissions.query({ name: 'microphone' as PermissionName }).then((p) => {
        micPermission = p.state
        changed()
      }, quiet)
    } catch {
      // unknown keeps the button
    }
  }
}

const voiceShown = (): boolean => {
  recordable ??= !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined' && pickRecorderType(supported) !== null
  return micShown({ status: voiceStatus, canRecord: recordable, shell: !!api.desktop, micPermission })
}

const subscribeVoice = (cb: () => void): (() => void) => {
  watchVoice()
  watchers.add(cb)
  return () => void watchers.delete(cb)
}

/** Whether a box shows its mic: voice is on, this page can record, and (in the shell) the mic isn't refused. */
export function useVoiceOn(): boolean {
  return useSyncExternalStore(subscribeVoice, voiceShown)
}

/** The voice settings as the server last said them (null until it has); talk's page and top-bar button read them here, so the page keeps one watcher. */
export function useVoiceStatus(): VoiceStatus | null {
  return useSyncExternalStore(subscribeVoice, () => voiceStatus)
}

/** Whether the voice conversation entry shows: talk is on, and this page can record and its mic isn't refused. */
export function useTalkShown(): boolean {
  return useSyncExternalStore(subscribeVoice, () => voiceShown() && voiceStatus?.talkOn === true)
}

// ---- the dictation itself ----

export interface Dictation {
  state: DictationState
  elapsedMs: number
  lang: VoiceLang
  /** The live region's text. */
  announcement: string
  /** A recording the 5-minute cap stopped has just been inserted: the strip says so for a few seconds. */
  capNote: boolean
  tap(): void
  cycleLang(): void
  /** True when the dictation took the Send over (it sends once its text is in); false: send now yourself. */
  requestSend(): boolean
}

interface Host {
  render(s: DictationState): void
  announce(text: string): void
  capNote(): void
  insert(text: string): void
  send(): void
  lang(): VoiceLang
}

/** The page runs one dictation at a time: starting one drops this. */
let active: { drop(): void } | null = null

/**
 * Carries out the machine's effects over getUserMedia, MediaRecorder and the upload. Effects run synchronously
 * inside dispatch, so an unmount's drop releases the mic at once and a held send sees the text inserted before it.
 */
function createDictation(host: Host) {
  let state = IDLE
  let stream: MediaStream | null = null
  let recorder: MediaRecorder | null = null
  let recorderType = ''
  let chunks: Blob[] = []
  let clip: Blob | null = null
  let startedAt = 0
  let upload: AbortController | null = null
  let wake: WakeLockSentinel | null = null
  const me = { drop: () => dispatch({ type: 'drop' }) }

  const dispatch = (e: DictationEvent): void => {
    const prev = state
    if (e.type === 'tap' && (prev.phase === 'idle' || prev.phase === 'error') && active && active !== me) active.drop()
    const next = step(prev, e)
    state = next.state
    if (state.phase !== 'idle') active = me
    else if (active === me) active = null
    host.render(state)
    if (capNote(prev, next.effects)) host.capNote()
    for (const f of next.effects) run(f)
  }

  const run = (f: DictationEffect): void => {
    switch (f.type) {
      case 'acquire':
        return acquire(f.run)
      case 'finish':
        if (recorder && recorder.state !== 'inactive') recorder.stop()
        return
      case 'release':
        return release()
      case 'upload':
        return transcribe(f.run)
      case 'abort':
        return abort()
      case 'insert':
        host.insert(f.text)
        signalInput()
        return
      case 'send':
        return host.send()
      case 'announce':
        return host.announce(f.text)
    }
  }

  const acquire = (run: number): void => {
    let asking: Promise<MediaStream>
    try {
      asking = navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (err) {
      asking = Promise.reject(err)
    }
    asking.then(
      (s) => {
        // Cancelled, dropped or superseded while the prompt was up. The machine says nothing for an older run, so the
        // stream is let go here, before anything records.
        if (state.run !== run || state.phase !== 'starting') return stopTracks(s)
        const type = pickRecorderType(supported) ?? ''
        let rec: MediaRecorder
        try {
          rec = new MediaRecorder(s, { mimeType: type, audioBitsPerSecond: BITS_PER_SECOND })
          rec.ondataavailable = (ev) => {
            if (ev.data.size > 0) chunks.push(ev.data)
          }
          rec.onstop = () => {
            if (recorder !== rec) return
            recorder = null
            const blob = new Blob(chunks, { type: recorderType })
            chunks = []
            if (state.run !== run) return
            // Stopped by itself (the device went away), not by finish.
            if (state.phase === 'listening') dispatch({ type: 'failed', run, error: 'failed' })
            else if (state.phase === 'transcribing') {
              clip = blob
              dispatch({ type: 'recorded', run, ms: Date.now() - startedAt })
            }
          }
          rec.onerror = () => {
            if (recorder === rec) dispatch({ type: 'failed', run, error: 'failed' })
          }
          recorderType = rec.mimeType || type
          chunks = []
          clip = null
          stream = s
          recorder = rec
          rec.start()
        } catch {
          recorder = null
          stream = null
          stopTracks(s)
          return dispatch({ type: 'denied', run, error: 'failed' })
        }
        startedAt = Date.now()
        lockScreen(s)
        dispatch({ type: 'granted', run, now: startedAt })
        // A grant that lands while the page is hidden gets no visibilitychange after it: stop now, or it records unseen.
        if (document.visibilityState === 'hidden') return dispatch({ type: 'hidden' })
        signalInput()
      },
      (err) => dispatch({ type: 'denied', run, error: micError(err) })
    )
  }

  // Keeps a phone awake mid-sentence; unsupported or refused is fine.
  const lockScreen = (s: MediaStream): void => {
    try {
      navigator.wakeLock?.request('screen').then((w) => {
        // Released before the lock arrived: give it straight back.
        if (stream === s && !wake) wake = w
        else w.release().catch(quiet)
      }, quiet)
    } catch {
      // no wake lock
    }
  }

  const release = (): void => {
    if (stream) stopTracks(stream)
    stream = null
    const w = wake
    wake = null
    w?.release().catch(quiet)
  }

  const transcribe = (run: number): void => {
    const blob = clip
    // The clip lives only as long as its request.
    clip = null
    if (!blob) return dispatch({ type: 'failed', run, error: 'failed' })
    const ac = new AbortController()
    upload = ac
    void transcribeClip((...a) => fetch(...a), blob, contentTypeOf(recorderType), host.lang(), 'full', ac.signal).then((r) => {
      if (upload === ac) upload = null
      dispatch(r.ok ? { type: 'result', run, text: r.text } : { type: 'failed', run, error: r.error })
    })
  }

  const abort = (): void => {
    upload?.abort()
    upload = null
    clip = null
    chunks = []
    const rec = recorder
    recorder = null
    if (!rec) return
    // Detached first, so its late stop event reports nothing.
    rec.ondataavailable = null
    rec.onstop = null
    rec.onerror = null
    try {
      if (rec.state !== 'inactive') rec.stop()
    } catch {
      // already stopped with its tracks
    }
  }

  return { dispatch, state: () => state }
}

export function useDictation(o: { insert(text: string): void; send(): void }): Dictation {
  const [state, setState] = useState<DictationState>(IDLE)
  const [now, setNow] = useState(0)
  const [lang, setLang] = useState<VoiceLang>(() => loadLang())
  const [announcement, setAnnouncement] = useState('')
  const [capNoteOn, setCapNoteOn] = useState(false)
  const opts = useRef(o)
  opts.current = o
  const langNow = useRef(lang)
  const capTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const [ctl] = useState(() =>
    createDictation({
      render: (s) => {
        setState(s)
        setNow(Date.now())
      },
      announce: setAnnouncement,
      capNote: () => {
        setCapNoteOn(true)
        clearTimeout(capTimer.current)
        capTimer.current = setTimeout(() => setCapNoteOn(false), CAP_NOTE_MS)
      },
      insert: (text) => opts.current.insert(text),
      send: () => opts.current.send(),
      // Read at upload, so the chip can still be changed while recording.
      lang: () => langNow.current
    })
  )

  const listening = state.phase === 'listening'
  useEffect(() => {
    if (!listening) return
    const tick = setInterval(() => {
      const t = Date.now()
      setNow(t)
      ctl.dispatch({ type: 'tick', now: t })
    }, TICK_MS)
    const presence = setInterval(signalInput, PRESENCE_MS)
    return () => {
      clearInterval(tick)
      clearInterval(presence)
    }
  }, [listening, ctl])

  const errorRun = state.phase === 'error' ? state.run : null
  useEffect(() => {
    if (errorRun === null) return
    const t = setTimeout(() => ctl.dispatch({ type: 'dismiss' }), ERROR_MS)
    return () => clearTimeout(t)
  }, [errorRun, ctl])

  // An unmount (chat switch, new-chat screen left, edit box closed) drops the dictation: no insert, no send.
  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') ctl.dispatch({ type: 'hidden' })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      clearTimeout(capTimer.current)
      ctl.dispatch({ type: 'drop' })
    }
  }, [ctl])

  return {
    state,
    elapsedMs: listening && state.startedAt !== null ? Math.max(0, now - state.startedAt) : 0,
    lang,
    announcement,
    capNote: capNoteOn,
    tap: () => ctl.dispatch({ type: 'tap', now: Date.now() }),
    cycleLang: () => {
      const next = nextLang(langNow.current)
      langNow.current = next
      saveLang(next)
      setLang(next)
    },
    requestSend: () => {
      const held = holdsSend(ctl.state())
      ctl.dispatch({ type: 'send' })
      return held
    }
  }
}
