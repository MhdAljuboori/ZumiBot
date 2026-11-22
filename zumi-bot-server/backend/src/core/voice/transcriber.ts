import type { VoiceCheck, VoiceFormat, VoiceLang } from '@zumibot/shared/voice'

export const VOICE_MODEL = 'elevenlabs/scribe-v2'
export const OPENROUTER_ORIGIN = 'https://openrouter.ai'
export const VOICE_TIMEOUT_MS = 60_000

export type TranscribeResult = { ok: true; text: string } | { ok: false; error: 'off' | 'upstream' | 'timeout' }

export interface Transcriber {
  /** Never throws. The audio, the transcript and the key stay out of logs; a failure logs the status and size only. */
  transcribe(audio: Buffer, format: VoiceFormat, lang: VoiceLang, signal?: AbortSignal): Promise<TranscribeResult>
  /** One cheap GET, so the settings dialog can say whether the key works. */
  check(): Promise<VoiceCheck>
}

export interface TranscriberDeps {
  key(): Promise<string | null>
  /** Only the dev hook sets this (see testVoiceOrigin); the default is OpenRouter. */
  origin?: string
  fetch?: typeof fetch
  timeoutMs?: number
  log?(line: string): void
}

/** The dev hook's origin: loopback http with a port, no path or query. Anything else is ignored, so a stray env var can't redirect the key. */
export function testVoiceOrigin(raw: string | undefined): string | null {
  if (!raw) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port) return null
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null
  return u.origin
}

export function createTranscriber(d: TranscriberDeps): Transcriber {
  const fetchFn = d.fetch ?? fetch
  const log = d.log ?? ((l: string) => console.error(l))
  const origin = d.origin ?? OPENROUTER_ORIGIN
  const timeoutMs = d.timeoutMs ?? VOICE_TIMEOUT_MS

  return {
    transcribe: async (audio, format, lang, signal) => {
      const key = await d.key()
      if (!key) return { ok: false, error: 'off' }
      const timeout = AbortSignal.timeout(timeoutMs)
      let res: Response
      try {
        res = await fetchFn(`${origin}/api/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: VOICE_MODEL,
            input_audio: { data: audio.toString('base64'), format },
            ...(lang === 'auto' ? {} : { language: lang }),
            provider: { zdr: true }
          }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout
        })
      } catch (err) {
        if (timeout.aborted) {
          log(`voice: timed out (${audio.length} bytes)`)
          return { ok: false, error: 'timeout' }
        }
        // The name only: a message could quote the request.
        if (!signal?.aborted) log(`voice: request failed (${err instanceof Error ? err.name : 'error'}, ${audio.length} bytes)`)
        return { ok: false, error: 'upstream' }
      }
      if (!res.ok) {
        // The error body is never read; cancel it so the connection isn't held open.
        void res.body?.cancel().catch(() => {})
        log(`voice: HTTP ${res.status} (${audio.length} bytes)`)
        return { ok: false, error: 'upstream' }
      }
      // The timer still runs while the body streams in, so a stalled body is a timeout, and a client gone mid-read is silent.
      let raw: string
      try {
        raw = await res.text()
      } catch (err) {
        if (timeout.aborted) {
          log(`voice: timed out (${audio.length} bytes)`)
          return { ok: false, error: 'timeout' }
        }
        if (!signal?.aborted) log(`voice: reading the answer failed (${err instanceof Error ? err.name : 'error'}, ${audio.length} bytes)`)
        return { ok: false, error: 'upstream' }
      }
      // text() then parse: a proxy's HTML answer must be an upstream error, not a thrown one.
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        log(`voice: the answer was not JSON (${audio.length} bytes)`)
        return { ok: false, error: 'upstream' }
      }
      const t = body && typeof body === 'object' ? (body as { text?: unknown }).text : undefined
      if (typeof t !== 'string') {
        log(`voice: the answer had no text (${audio.length} bytes)`)
        return { ok: false, error: 'upstream' }
      }
      return { ok: true, text: t.trim() }
    },
    check: async () => {
      const key = await d.key()
      if (!key) return { ok: false, reason: 'nokey' }
      try {
        const res = await fetchFn(`${origin}/api/v1/key`, {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(timeoutMs)
        })
        if (res.ok) return { ok: true }
        log(`voice: key check HTTP ${res.status}`)
        return { ok: false, reason: res.status === 401 || res.status === 403 ? 'invalid' : 'unreachable' }
      } catch (err) {
        log(`voice: key check failed (${err instanceof Error ? err.name : 'error'})`)
        return { ok: false, reason: 'unreachable' }
      }
    }
  }
}
