// Pure helpers for dictation: where the text lands, whether the mic shows, the language toggle, the recorder type.
import { VOICE_LANGS, type VoiceLang, type VoiceStatus } from '@zumibot/shared/voice'
import type { DictationPhase, DictationState } from './dictation'

export { voiceErrorText, type VoiceError } from './dictation'

const LANG_KEY = 'zumibot.voiceLang'

/**
 * Trimmed, with a leading space only where the previous character would glue on (null = a block or line edge).
 * The trailing space is unconditional (a double space before whitespace is harmless): the caret must never land
 * right after a dictated `@ed` or `/check`, or the mention and command menus would open.
 */
export function spaceDictation(text: string, before: string | null, _after: string | null): string {
  const lead = before !== null && !/\s/.test(before) ? ' ' : ''
  return lead + text.trim() + ' '
}

/** For the textarea. A newline before counts as a line edge for the leading space only. */
export function insertIntoText(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const b = start > 0 ? value[start - 1] : null
  const a = end < value.length ? value[end] : null
  const spaced = spaceDictation(text, b === '\n' ? null : b, a)
  return { value: value.slice(0, start) + spaced + value.slice(end), caret: start + spaced.length }
}

export const nextLang = (l: VoiceLang): VoiceLang => VOICE_LANGS[(VOICE_LANGS.indexOf(l) + 1) % VOICE_LANGS.length]

/** Storage can be blocked or full: a failure is the default, never an error. */
export function loadLang(storage?: Pick<Storage, 'getItem'>): VoiceLang {
  try {
    const v = (storage ?? localStorage).getItem(LANG_KEY)
    return VOICE_LANGS.find((l) => l === v) ?? 'auto'
  } catch {
    return 'auto'
  }
}

export function saveLang(l: VoiceLang, storage?: Pick<Storage, 'setItem'>): void {
  try {
    ;(storage ?? localStorage).setItem(LANG_KEY, l)
  } catch {
    // a lost preference is harmless
  }
}

const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'] as const

export function pickRecorderType(isSupported: (t: string) => boolean): string | null {
  return RECORDER_TYPES.find(isSupported) ?? null
}

/** In the desktop shell a denied mic can never be re-asked, so the button hides; a browser keeps it to explain the block. */
export function micShown(o: {
  status: VoiceStatus | null
  canRecord: boolean
  shell: boolean
  micPermission: 'granted' | 'denied' | 'prompt' | 'unknown'
}): boolean {
  if (!o.status?.on || !o.canRecord) return false
  return !(o.shell && o.micPermission === 'denied')
}

/** The route keys on the bare type, so `;codecs=opus` goes. */
export const contentTypeOf = (recorderType: string): string => recorderType.split(';')[0].trim()

/** The listening time as m:ss. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** getUserMedia's rejection, by DOMException name (read off any object: not every engine makes DOMException an Error). */
export function micError(e: unknown): 'blocked' | 'nomic' | 'failed' {
  const name = typeof e === 'object' && e !== null && 'name' in e ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'blocked'
  return name === 'NotFoundError' ? 'nomic' : 'failed'
}

const LANG_LABEL: Record<VoiceLang, string> = { auto: 'Auto', en: 'EN', ar: 'AR' }
export const langLabel = (l: VoiceLang): string => LANG_LABEL[l]

// A tap while starting or transcribing cancels; while listening it stops and transcribes.
const MIC_LABEL: Record<DictationPhase, string> = {
  idle: 'Start dictation',
  error: 'Start dictation',
  starting: 'Cancel dictation',
  listening: 'Stop dictation',
  transcribing: 'Cancel dictation'
}
export const micLabel = (p: DictationPhase): string => MIC_LABEL[p]

export const transcribingText = (s: DictationState): string => (s.sendAfter ? 'Transcribing, then sending…' : 'Transcribing…')
