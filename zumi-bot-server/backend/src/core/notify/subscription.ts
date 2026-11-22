import { isIP } from 'node:net'
import type { SubscriptionInput } from '@zumibot/shared/notify'
import { b64url } from './webPush'

export const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/

const ENDPOINT_MAX = 2048
const TEST_ORIGIN_RE = /^http:\/\/127\.0\.0\.1:\d{1,5}$/

function bad(what: string): never {
  // Never put the value in the message: the endpoint is a secret.
  throw new TypeError(`invalid push subscription: ${what}`)
}

function keyOf(v: unknown, bytes: number): Buffer {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]+$/.test(v)) bad('bad key')
  const b = b64url.decode(v)
  if (b.length !== bytes) bad('bad key length')
  return b
}

// The server posts to this URL, so it must be a public https push service (no SSRF into the LAN).
// testOrigin is the one dev exception: an exact http://127.0.0.1:<port> origin for the e2e fake push service.
export function checkSubscription(v: unknown, testOrigin: string | null): SubscriptionInput {
  // A wrong-shaped origin must never widen what is allowed.
  if (testOrigin !== null && !TEST_ORIGIN_RE.test(testOrigin)) testOrigin = null
  if (!v || typeof v !== 'object' || Array.isArray(v)) bad('not an object')
  const o = v as { endpoint?: unknown; keys?: unknown }
  if (typeof o.endpoint !== 'string' || o.endpoint === '' || o.endpoint.length > ENDPOINT_MAX) bad('bad endpoint')
  if (!o.keys || typeof o.keys !== 'object') bad('no keys')
  const k = o.keys as { p256dh?: unknown; auth?: unknown }
  const p256dh = keyOf(k.p256dh, 65)
  if (p256dh[0] !== 0x04) bad('bad key')
  keyOf(k.auth, 16)

  // `${origin}/` also rejects http://127.0.0.1:5555@evil/ and a longer port like :55550.
  const dev = testOrigin !== null && o.endpoint.startsWith(`${testOrigin}/`)
  if (!dev) {
    let u: URL
    try {
      u = new URL(o.endpoint)
    } catch {
      bad('bad endpoint')
    }
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') bad('bad endpoint')
    const host = u.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase()
    if (isIP(host) !== 0 || host === 'localhost' || host.endsWith('.localhost')) bad('bad endpoint')
  } else if (new URL(o.endpoint).origin !== testOrigin) bad('bad endpoint')
  return { endpoint: o.endpoint, keys: { p256dh: k.p256dh as string, auth: k.auth as string } }
}
