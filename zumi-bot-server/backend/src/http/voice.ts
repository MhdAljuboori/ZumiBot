import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  VOICE_CLEAN_HEADER,
  VOICE_CLEAN_MODES,
  VOICE_LANGS,
  VOICE_MAX_BYTES,
  VOICE_TYPES,
  type VoiceClean,
  type VoiceCleanMode,
  type VoiceLang,
  type VoiceRouteError
} from '@zumibot/shared/voice'
import { cleanTranscript, type Cleaner } from '../core/voice/cleaner'
import type { Transcriber } from '../core/voice/transcriber'
import { readBody } from './body'
import { sendJson } from './headers'

export interface VoiceLimiter {
  /** true = a slot is taken; call done() when the request ends. */
  take(): boolean
  done(): void
}

export interface VoiceRoute {
  on(): Promise<boolean>
  transcriber: Pick<Transcriber, 'transcribe'>
  limiter: VoiceLimiter
  /** The Settings switches, read per clip. */
  clean(): Promise<VoiceClean>
  cleaner: Pick<Cleaner, 'rewrite'>
}

/** At most `concurrent` in flight and `perMinute` started in any rolling minute: each clip is a paid upstream call. */
export function createVoiceLimiter(o: { now?(): number; concurrent?: number; perMinute?: number } = {}): VoiceLimiter {
  const now = o.now ?? Date.now
  const concurrent = o.concurrent ?? 2
  const perMinute = o.perMinute ?? 30
  let active = 0
  let starts: number[] = []
  return {
    take: () => {
      const t = now()
      starts = starts.filter((s) => t - s < 60_000)
      if (active >= concurrent || starts.length >= perMinute) return false
      active++
      starts.push(t)
      return true
    },
    done: () => {
      if (active > 0) active--
    }
  }
}

const STATUS: Record<VoiceRouteError, number> = {
  'bad-request': 400,
  'too-large': 413,
  'bad-type': 415,
  busy: 429,
  off: 503,
  upstream: 502,
  timeout: 504
}

export async function handleTranscribe(req: IncomingMessage, res: ServerResponse, v: VoiceRoute): Promise<void> {
  const fail = (error: VoiceRouteError, extra: Record<string, string> = {}): void => sendJson(res, STATUS[error], { error }, extra)
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' })

  // Codec parameters ride after ';'. hasOwn: the table is a plain object, so "constructor" must not match.
  const type = String(req.headers['content-type'] ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase()
  if (!Object.hasOwn(VOICE_TYPES, type)) return fail('bad-type')
  const lang = req.headers['x-zumibot-voice-lang']
  if (typeof lang !== 'string' || !(VOICE_LANGS as readonly string[]).includes(lang)) return fail('bad-request')
  // Absent is full: a page loaded before the header existed still gets what the switches say.
  const mode = req.headers[VOICE_CLEAN_HEADER.toLowerCase()] ?? 'full'
  if (typeof mode !== 'string' || !(VOICE_CLEAN_MODES as readonly string[]).includes(mode)) return fail('bad-request')
  if (!(await v.on())) return fail('off')

  // Connection: close, so the body is never read; the socket goes down after the answer.
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > VOICE_MAX_BYTES) return fail('too-large', { Connection: 'close' })

  if (!v.limiter.take()) return fail('busy')
  // A client that goes away mid-request must cancel the upstream call, not leave it running on our key.
  const abort = new AbortController()
  res.on('close', () => {
    if (!res.writableFinished) abort.abort()
  })
  try {
    let body: Buffer | null
    try {
      body = await readBody(req, VOICE_MAX_BYTES)
    } catch {
      return // the client is gone
    }
    if (body === null) return fail('too-large')
    if (body.length === 0) return fail('bad-request')
    const out = await v.transcriber.transcribe(body, VOICE_TYPES[type]!, lang as VoiceLang, abort.signal)
    if (abort.signal.aborted) return
    if (!out.ok) return fail(out.error)
    const text = await cleanTranscript(out.text, {
      switches: await v.clean(),
      mode: mode as VoiceCleanMode,
      cleaner: v.cleaner,
      signal: abort.signal
    })
    if (abort.signal.aborted) return
    sendJson(res, 200, { text })
  } finally {
    v.limiter.done()
  }
}
