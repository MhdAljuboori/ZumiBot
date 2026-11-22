import { createHash } from 'node:crypto'
import type { NotifyPayload, NotifyPayloadKind } from '@zumibot/shared/notify'
import { encryptPayload, vapidAuthorization, type VapidKeys } from './webPush'

export type PushOutcome = 'sent' | 'gone' | 'failed'
export interface PushTarget {
  endpoint: string
  p256dh: string
  auth: string
}

const PUSH_TIMEOUT_MS = 10_000
const RETRY_CAP_MS = 60_000
const RETRY_DEFAULT_MS = 1_000

// Topic lets the push service replace a queued message for the same slot.
export function topicOf(tag: string): string {
  return createHash('sha256').update(tag).digest('base64url').slice(0, 32)
}

export function pushOptions(kind: NotifyPayloadKind): { ttl: number; urgency: 'high' | 'normal' } {
  if (kind === 'waiting') return { ttl: 43_200, urgency: 'high' }
  if (kind === 'test' || kind === 'paused') return { ttl: 60, urgency: 'normal' }
  return { ttl: 3_600, urgency: 'normal' }
}

// Seconds or an HTTP date; anything else waits the default.
function retryDelay(header: string | null, nowMs: number): number {
  let ms = RETRY_DEFAULT_MS
  if (header !== null && header.trim() !== '') {
    const secs = Number(header)
    if (Number.isFinite(secs)) ms = secs * 1000
    else {
      const at = Date.parse(header)
      if (Number.isFinite(at)) ms = at - nowMs
    }
  }
  return Math.min(Math.max(ms, 0), RETRY_CAP_MS)
}

// Never throws and never returns or raises the endpoint: it is a capability URL.
export async function sendPush(o: {
  target: PushTarget
  payload: NotifyPayload
  vapid: VapidKeys
  subject: string
  fetch: typeof fetch
  now(): number
  sleep(ms: number): Promise<void>
  timeoutMs?: number
}): Promise<{ outcome: PushOutcome; status: number | null }> {
  let body: Buffer
  let headers: Record<string, string>
  try {
    body = encryptPayload(Buffer.from(JSON.stringify(o.payload)), o.target)
    const { ttl, urgency } = pushOptions(o.payload.kind)
    headers = {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
      Topic: topicOf(o.payload.tag),
      Authorization: vapidAuthorization(o.target.endpoint, o.vapid, o.subject, o.now())
    }
  } catch {
    return { outcome: 'failed', status: null }
  }

  // One retry only: a push service that is still failing is better left to the next event.
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? PUSH_TIMEOUT_MS)
    let res: Response
    try {
      // Push services never redirect; following one would send the encrypted body to a host nothing checked.
      res = await o.fetch(o.target.endpoint, {
        method: 'POST',
        headers,
        body: new Uint8Array(body),
        signal: ctl.signal,
        redirect: 'manual'
      })
    } catch {
      return { outcome: 'failed', status: null }
    } finally {
      clearTimeout(timer)
    }
    const status = res.status
    const retryAfter = res.headers.get('Retry-After')
    // Nothing reads the body, so free the connection on every path.
    void res.body?.cancel().catch(() => {})
    if (status >= 200 && status < 300) return { outcome: 'sent', status }
    if (status === 404 || status === 410) return { outcome: 'gone', status }
    const retryable = status === 429 || status >= 500
    if (!retryable || attempt === 1) return { outcome: 'failed', status }
    try {
      await o.sleep(retryDelay(retryAfter, o.now()))
    } catch {
      return { outcome: 'failed', status }
    }
  }
  return { outcome: 'failed', status: null }
}
