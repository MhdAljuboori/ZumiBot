import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto'

export interface VapidKeys {
  publicKey: string
  privateKey: string
}

// One record holds the whole payload (RFC 8188), so the size field is fixed.
const RECORD_SIZE = 4096
const JWT_TTL_S = 43_200
// the record holds plaintext + 0x02 delimiter + 16-byte GCM tag
const MAX_PLAINTEXT = RECORD_SIZE - 17

export const b64url = {
  encode: (b: Buffer): string => b.toString('base64url'),
  decode: (s: string): Buffer => Buffer.from(s, 'base64url')
}

// getPrivateKey() drops leading zero bytes (~0.4% of keys), but JWK `d` and our contract need 32.
export function padScalar(b: Buffer): Buffer {
  return b.length >= 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b])
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: b64url.encode(ecdh.getPublicKey()), privateKey: b64url.encode(padScalar(ecdh.getPrivateKey())) }
}

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer, len: number): Buffer => Buffer.from(hkdfSync('sha256', ikm, salt, info, len))

// RFC 8291 section 3.3-3.4 on top of the RFC 8188 aes128gcm coding.
export function encryptPayload(
  plaintext: Buffer,
  sub: { p256dh: string; auth: string },
  o: { salt?: Buffer; serverPrivateKey?: Buffer } = {}
): Buffer {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error('push payload too large for one record')
  const uaPublic = b64url.decode(sub.p256dh)
  const auth = b64url.decode(sub.auth)
  const salt = o.salt ?? randomBytes(16)
  const ecdh = createECDH('prime256v1')
  if (o.serverPrivateKey) ecdh.setPrivateKey(o.serverPrivateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(uaPublic)
  const ikm = hkdf(secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32)
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  // 0x02 marks the last record
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const ct = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const head = Buffer.alloc(21)
  salt.copy(head, 0)
  head.writeUInt32BE(RECORD_SIZE, 16)
  head[20] = asPublic.length
  return Buffer.concat([head, asPublic, ct])
}

// RFC 8292: ES256 JWT for the push service origin.
export function vapidAuthorization(endpoint: string, keys: VapidKeys, subject: string, nowMs: number): string {
  const enc = (v: object) => b64url.encode(Buffer.from(JSON.stringify(v)))
  const input = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + JWT_TTL_S,
    sub: subject
  })}`
  const pub = b64url.decode(keys.publicKey)
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: b64url.encode(padScalar(b64url.decode(keys.privateKey))),
      x: b64url.encode(pub.subarray(1, 33)),
      y: b64url.encode(pub.subarray(33, 65))
    },
    format: 'jwk'
  })
  const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
  return `vapid t=${input}.${b64url.encode(sig)}, k=${keys.publicKey}`
}
