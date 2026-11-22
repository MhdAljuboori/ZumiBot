import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { checkSubscription, DEVICE_ID_RE } from '../../src/core/notify/subscription'

const p256dh = (n = 65, first = 4) => {
  const b = randomBytes(n)
  if (n > 0) b[0] = first
  return b.toString('base64url')
}
const auth = (n = 16) => randomBytes(n).toString('base64url')
const sub = (endpoint: string, o: { p256dh?: string; auth?: string } = {}) => ({
  endpoint,
  keys: { p256dh: o.p256dh ?? p256dh(), auth: o.auth ?? auth() }
})
const FCM = 'https://fcm.googleapis.com/fcm/send/abc123'

describe('checkSubscription', () => {
  it('accepts a valid push service subscription', () => {
    const s = sub(FCM)
    expect(checkSubscription(s, null)).toEqual(s)
  })

  it.each([
    ['http', 'http://fcm.googleapis.com/x'],
    ['v4 literal', 'https://127.0.0.1/x'],
    ['private v4 literal', 'https://10.0.0.1/x'],
    ['v6 literal', 'https://[::1]/x'],
    ['localhost', 'https://localhost/x'],
    ['subdomain of localhost', 'https://a.localhost/x'],
    ['decimal ip', 'https://2130706433/'],
    ['hex ip', 'https://0x7f000001/'],
    ['uppercase localhost', 'https://LOCALHOST/'],
    ['localhost with dot', 'https://localhost./'],
    ['userinfo before ip', 'https://a@127.0.0.1/'],
    ['userinfo disguising host', 'https://fcm.googleapis.com@evil/'],
    ['not a url', 'not a url'],
    ['too long', 'https://fcm.googleapis.com/' + 'a'.repeat(2048)]
  ])('rejects %s', (_n, endpoint) => {
    expect(() => checkSubscription(sub(endpoint), null)).toThrow(TypeError)
  })

  it('rejects bad keys', () => {
    expect(() => checkSubscription(sub(FCM, { p256dh: p256dh(64) }), null)).toThrow(TypeError)
    expect(() => checkSubscription(sub(FCM, { p256dh: p256dh(65, 3) }), null)).toThrow(TypeError)
    expect(() => checkSubscription(sub(FCM, { auth: auth(15) }), null)).toThrow(TypeError)
    expect(() => checkSubscription(sub(FCM, { auth: auth(17) }), null)).toThrow(TypeError)
  })

  it.each([
    ['.local host', 'https://push.local/x'],
    ['non-default port', 'https://fcm.googleapis.com:8443/x']
  ])('accepts %s', (_n, endpoint) => {
    expect(checkSubscription(sub(endpoint), null).endpoint).toBe(endpoint)
  })

  it('ignores a wrong-shaped test origin', () => {
    for (const o of [
      'https://127.0.0.1:5555',
      'http://localhost:5555',
      'http://127.0.0.1',
      'http://127.0.0.1:5555/',
      'http://10.0.0.1:5555',
      'http://127.0.0.1:1234567'
    ]) {
      expect(() => checkSubscription(sub(`${o.replace(/\/$/, '')}/x`), o)).toThrow(TypeError)
    }
  })

  it.each([
    null,
    undefined,
    'x',
    42,
    [],
    {},
    { endpoint: FCM },
    { endpoint: 1, keys: {} },
    { endpoint: FCM, keys: { p256dh: 1, auth: 2 } }
  ])('rejects non-subscription %j', (v) => {
    expect(() => checkSubscription(v, null)).toThrow(TypeError)
  })

  it('allows the dev origin only when it is the exact test origin', () => {
    const local = 'http://127.0.0.1:5555/x'
    expect(checkSubscription(sub(local), 'http://127.0.0.1:5555').endpoint).toBe(local)
    expect(() => checkSubscription(sub(local), null)).toThrow(TypeError)
    expect(() => checkSubscription(sub(local), 'http://127.0.0.1:5556')).toThrow(TypeError)
    expect(() => checkSubscription(sub('http://127.0.0.1:55550/x'), 'http://127.0.0.1:5555')).toThrow(TypeError)
    expect(() => checkSubscription(sub('http://127.0.0.1:5555@evil.example/x'), 'http://127.0.0.1:5555')).toThrow(TypeError)
  })

  it('never echoes the endpoint in an error', () => {
    const secret = 'https://127.0.0.1/secret-token-xyz'
    for (const s of [
      sub(secret),
      sub('https://fcm.googleapis.com/secret-token-xyz' + 'a'.repeat(2048)),
      sub(FCM + '/secret-token-xyz', { auth: auth(3) })
    ]) {
      try {
        checkSubscription(s, null)
        throw new Error('should throw')
      } catch (e) {
        expect(e).toBeInstanceOf(TypeError)
        expect((e as Error).message).not.toContain('secret-token-xyz')
        expect((e as Error).message).not.toContain('fcm.googleapis')
      }
    }
  })
})

describe('DEVICE_ID_RE', () => {
  it('takes 8-64 letters, digits and dashes', () => {
    expect(DEVICE_ID_RE.test('abcd-1234')).toBe(true)
    expect(DEVICE_ID_RE.test('short')).toBe(false)
    expect(DEVICE_ID_RE.test('a'.repeat(65))).toBe(false)
    expect(DEVICE_ID_RE.test('has space 1234')).toBe(false)
  })
})
