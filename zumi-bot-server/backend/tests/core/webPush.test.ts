import { describe, expect, it } from 'vitest'
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto'
import { b64url, encryptPayload, generateVapidKeys, padScalar, vapidAuthorization } from '../../src/core/notify/webPush'

// RFC 8291 Appendix A, copied verbatim from the RFC text
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
}

// RFC 8291 section 3.4 in reverse, kept apart from the code under test
function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16)
  const idLen = body[20]
  const asPublic = body.subarray(21, 21 + idLen)
  const ct = body.subarray(21 + idLen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(uaPrivate)
  const uaPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(asPublic)
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const d = createDecipheriv('aes-128-gcm', cek, nonce)
  d.setAuthTag(ct.subarray(ct.length - 16))
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()])
  expect(plain[plain.length - 1]).toBe(2)
  return plain.subarray(0, plain.length - 1)
}

describe('encryptPayload', () => {
  it('encrypts the RFC 8291 Appendix A example byte for byte', () => {
    const body = encryptPayload(
      b64url.decode(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: b64url.decode(RFC.salt), serverPrivateKey: b64url.decode(RFC.asPrivate) }
    )
    expect(b64url.encode(body)).toBe(RFC.body)
    expect(b64url.encode(body.subarray(21, 86))).toBe(RFC.asPublic)
  })

  it('round-trips through a test-only decrypt', () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const auth = randomBytes(16)
    const plaintext = randomBytes(300)
    const body = encryptPayload(plaintext, { p256dh: b64url.encode(ua.getPublicKey()), auth: b64url.encode(auth) })
    expect(body[21 - 1]).toBe(65)
    expect(body.readUInt32BE(16)).toBe(4096)
    expect(decrypt(body, ua.getPrivateKey(), auth).equals(plaintext)).toBe(true)
  })

  it('rejects plaintext that cannot fit one record, without leaking content', () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const sub = { p256dh: b64url.encode(ua.getPublicKey()), auth: b64url.encode(randomBytes(16)) }
    expect(() => encryptPayload(Buffer.alloc(4079), sub)).not.toThrow()
    expect(() => encryptPayload(Buffer.alloc(4080, 0x41), sub)).toThrow(/too large/)
    try {
      encryptPayload(Buffer.alloc(4080, 0x41), sub)
    } catch (e) {
      expect((e as Error).message).not.toMatch(/AAAA|QUFB/)
    }
  })

  it('uses a fresh salt and sender key per message', () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const sub = { p256dh: b64url.encode(ua.getPublicKey()), auth: b64url.encode(randomBytes(16)) }
    const a = encryptPayload(Buffer.from('x'), sub)
    const b = encryptPayload(Buffer.from('x'), sub)
    expect(a.subarray(0, 16).equals(b.subarray(0, 16))).toBe(false)
    expect(a.subarray(21, 86).equals(b.subarray(21, 86))).toBe(false)
  })
})

describe('generateVapidKeys', () => {
  it('gives a 65-byte uncompressed public key and a 32-byte private key', () => {
    const k = generateVapidKeys()
    const pub = b64url.decode(k.publicKey)
    expect(pub.length).toBe(65)
    expect(pub[0]).toBe(0x04)
    expect(b64url.decode(k.privateKey).length).toBe(32)
  })
})

describe('private scalar length', () => {
  it('padScalar left-pads a short scalar to 32 bytes', () => {
    const short = Buffer.from([1, 2, 3])
    const p = padScalar(short)
    expect(p.length).toBe(32)
    expect(p.subarray(29).equals(short)).toBe(true)
    expect(p.subarray(0, 29).every((x) => x === 0)).toBe(true)
    expect(padScalar(Buffer.alloc(32, 7)).length).toBe(32)
  })

  it('every generated private key decodes to 32 bytes', () => {
    for (let i = 0; i < 2000; i++) expect(b64url.decode(generateVapidKeys().privateKey).length).toBe(32)
  })

  it('signs with a stored scalar that lost its leading zero byte', () => {
    let keys = generateVapidKeys()
    // ~1 in 256 keys has a zero first byte; 5000 tries make a miss astronomically unlikely
    for (let i = 0; i < 5000 && b64url.decode(keys.privateKey)[0] !== 0; i++) keys = generateVapidKeys()
    const d = b64url.decode(keys.privateKey)
    expect(d[0]).toBe(0)
    const short = { ...keys, privateKey: b64url.encode(d.subarray(1)) }
    const h = vapidAuthorization('https://x.example/p', short, 'mailto:a@example.com', 0)
    const [hp, cp, sp] = /t=([^,]+),/.exec(h)![1].split('.')
    const pub = b64url.decode(keys.publicKey)
    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64url.encode(pub.subarray(1, 33)), y: b64url.encode(pub.subarray(33, 65)) },
      format: 'jwk'
    })
    expect(verify('sha256', Buffer.from(hp + '.' + cp), { key, dsaEncoding: 'ieee-p1363' }, b64url.decode(sp))).toBe(true)
  })
})

describe('vapidAuthorization', () => {
  it('signs an ES256 JWT for the endpoint origin', () => {
    const keys = generateVapidKeys()
    const now = 1_700_000_000_123
    const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:a@example.com', now)
    expect(h).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/)
    const [, t, k] = /^vapid t=(.+), k=(.+)$/.exec(h)!
    expect(k).toBe(keys.publicKey)
    const [hp, cp, sp] = t.split('.')
    expect(JSON.parse(b64url.decode(hp).toString())).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(b64url.decode(cp).toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Math.floor(now / 1000) + 43200,
      sub: 'mailto:a@example.com'
    })
    const pub = b64url.decode(keys.publicKey)
    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: b64url.encode(pub.subarray(1, 33)), y: b64url.encode(pub.subarray(33, 65)) },
      format: 'jwk'
    })
    const ok = verify('sha256', Buffer.from(hp + '.' + cp), { key, dsaEncoding: 'ieee-p1363' }, b64url.decode(sp))
    expect(ok).toBe(true)
  })
})
