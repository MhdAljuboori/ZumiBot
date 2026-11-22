import { VOICE_CLEAN_HEADER, VOICE_LANG_HEADER, VOICE_ROUTE, type VoiceCleanMode, type VoiceLang } from '@zumibot/shared/voice'
import type { VoiceError } from '../state/dictation'
import { redirectToLogin } from './signedOut'

export type TranscribeResult = { ok: true; text: string } | { ok: false; error: VoiceError }

const BY_STATUS: Record<number, VoiceError> = { 413: 'too-large', 429: 'busy', 503: 'off', 502: 'upstream', 504: 'timeout' }

/**
 * Posts the raw clip (like uploadFile, so a proxy's HTML error needs no parsing). An abort reads as 'failed': its caller's run is already stale.
 * clean 'light' refuses the rewrite for this clip; the Settings switches decide the rest on the server.
 */
export async function transcribeClip(
  fetchImpl: typeof fetch,
  clip: Blob,
  contentType: string,
  lang: VoiceLang,
  clean: VoiceCleanMode,
  signal: AbortSignal,
  onSignedOut: () => void = redirectToLogin
): Promise<TranscribeResult> {
  let res: Response
  try {
    res = await fetchImpl(VOICE_ROUTE, {
      method: 'POST',
      headers: { 'Content-Type': contentType, [VOICE_LANG_HEADER]: lang, [VOICE_CLEAN_HEADER]: clean },
      body: clip,
      signal
    })
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.name === 'AbortError' ? 'failed' : 'network' }
  }
  if (res.status === 401) {
    onSignedOut()
    return { ok: false, error: 'failed' }
  }
  if (!res.ok) return { ok: false, error: BY_STATUS[res.status] ?? 'failed' }
  try {
    const body = (await res.json()) as { text?: unknown }
    return typeof body.text === 'string' ? { ok: true, text: body.text } : { ok: false, error: 'failed' }
  } catch {
    return { ok: false, error: 'failed' }
  }
}
