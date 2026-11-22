/** auto lets the model detect the language; en and ar pin it. VOICE_LANGS is the order the composer's toggle cycles. */
export type VoiceLang = 'auto' | 'en' | 'ar'
export const VOICE_LANGS: readonly VoiceLang[] = ['auto', 'en', 'ar']

/**
 * Voice conversations. defaultAgent answers when the person names none (null = ask which). aliases are spoken names per
 * agent file name: Arabic speech may spell an English agent name in Arabic script, so the file name alone would never match.
 */
export interface VoiceTalk {
  enabled: boolean
  defaultAgent: string | null
  aliases: Record<string, string[]>
}
export const DEFAULT_TALK: VoiceTalk = { enabled: true, defaultAgent: 'work-assistant', aliases: {} }

/**
 * Cleaning a transcript, both off by default. fillers cuts hums ("uh", "um", "اممم") on the server; rewrite has a small
 * model tidy the text (false starts, self-corrections) and implies the filler cut.
 */
export interface VoiceClean {
  fillers: boolean
  rewrite: boolean
}
export const DEFAULT_CLEAN: VoiceClean = { fillers: false, rewrite: false }
/** Per clip: light never rewrites, it only cuts hums. The page sends full today (absent means full too). */
export type VoiceCleanMode = 'full' | 'light'
export const VOICE_CLEAN_MODES: readonly VoiceCleanMode[] = ['full', 'light']
export const VOICE_CLEAN_HEADER = 'X-ZumiBot-Voice-Clean'

/** The key itself never leaves the server: the UI learns only whether one is saved. on = enabled and a key saved; talkOn = on and talk enabled. */
export interface VoiceStatus {
  on: boolean
  enabled: boolean
  keySaved: boolean
  talk: VoiceTalk
  talkOn: boolean
  clean: VoiceClean
}
export type VoiceCheck = { ok: true } | { ok: false; reason: 'invalid' | 'unreachable' | 'nokey' }
export type VoiceRouteError = 'bad-request' | 'too-large' | 'bad-type' | 'busy' | 'off' | 'upstream' | 'timeout'

export type VoiceFormat = 'webm' | 'ogg' | 'm4a'
/** The content types the route accepts (codec parameters are dropped before the lookup). */
export const VOICE_TYPES: Record<string, VoiceFormat> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a'
}

export const VOICE_LANG_HEADER = 'X-ZumiBot-Voice-Lang'
export const VOICE_ROUTE = '/api/voice/transcribe'

export const VOICE_MAX_BYTES = 8 * 1024 * 1024
export const VOICE_MAX_MS = 300_000
/** A shorter clip is a mis-tap: never uploaded. */
export const VOICE_MIN_MS = 600
export const VOICE_KEY_MAX = 512

export const voiceOn = (s: Pick<VoiceStatus, 'enabled' | 'keySaved'>): boolean => s.enabled && s.keySaved

export const TALK_AGENT_MAX = 100
export const TALK_AGENTS_MAX = 50
export const TALK_PHRASES_MAX = 10
export const TALK_PHRASE_MAX = 60

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const agentName = (s: unknown): s is string => typeof s === 'string' && s !== '' && s.length <= TALK_AGENT_MAX && !CONTROL.test(s)

/** One agent's phrases, trimmed; null when any is empty, too long, has a control character, or there are too many. */
function phrasesOf(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > TALK_PHRASES_MAX) return null
  const out: string[] = []
  for (const x of v) {
    if (typeof x !== 'string') return null
    const t = x.trim()
    if (t === '' || t.length > TALK_PHRASE_MAX || CONTROL.test(t)) return null
    out.push(t)
  }
  return out
}

/** Checks a talk patch from the wire (pure; the handler throws `bad talk settings` on null). Absent fields stay absent. */
export function parseTalkPatch(v: unknown): Partial<VoiceTalk> | null {
  if (!isObj(v)) return null
  const out: Partial<VoiceTalk> = {}
  for (const [k, x] of Object.entries(v)) {
    if (k === 'enabled') {
      if (typeof x !== 'boolean') return null
      out.enabled = x
    } else if (k === 'defaultAgent') {
      if (x !== null && !agentName(x)) return null
      out.defaultAgent = x
    } else if (k === 'aliases') {
      if (!isObj(x)) return null
      const entries = Object.entries(x)
      if (entries.length > TALK_AGENTS_MAX) return null
      const aliases: Record<string, string[]> = {}
      for (const [name, list] of entries) {
        if (!agentName(name) || name === '__proto__') return null // would reshape the object, not name an agent
        const phrases = phrasesOf(list)
        if (!phrases) return null
        aliases[name] = phrases
      }
      out.aliases = aliases
    } else return null
  }
  return out
}

/** Checks a clean patch from the wire (pure; the handler throws `bad clean settings` on null). Absent switches stay absent. */
export function parseCleanPatch(v: unknown): Partial<VoiceClean> | null {
  if (!isObj(v)) return null
  const out: Partial<VoiceClean> = {}
  for (const [k, x] of Object.entries(v)) {
    if ((k !== 'fillers' && k !== 'rewrite') || typeof x !== 'boolean') return null
    out[k] = x
  }
  return out
}
