import { describe, expect, it } from 'vitest'
import { base64UrlToBytes, pushSupportFrom, shownFrom, subscribeFresh, subscriptionFrom, type SupportEnv } from '../src/net/push'

describe('base64UrlToBytes', () => {
  it('decodes url-safe base64 without padding', () => {
    // 0xfb 0xff 0xfe is "-__-" in base64url ("+//+" in plain base64).
    expect(Array.from(base64UrlToBytes('-__-'))).toEqual([0xfb, 0xff, 0xfe])
    expect(Array.from(base64UrlToBytes('aGk'))).toEqual([104, 105])
  })
  it('decodes an empty string to no bytes', () => {
    expect(base64UrlToBytes('').length).toBe(0)
  })
})

describe('subscriptionFrom', () => {
  it('maps a subscription json to the wire shape', () => {
    expect(subscriptionFrom({ endpoint: 'https://p/x', expirationTime: null, keys: { p256dh: 'P', auth: 'A', extra: 'z' } })).toEqual({
      endpoint: 'https://p/x',
      keys: { p256dh: 'P', auth: 'A' }
    })
  })
  it('refuses a malformed one', () => {
    expect(subscriptionFrom(null)).toBeNull()
    expect(subscriptionFrom({})).toBeNull()
    expect(subscriptionFrom({ endpoint: 'https://p/x' })).toBeNull()
    expect(subscriptionFrom({ endpoint: 'https://p/x', keys: { p256dh: 'P' } })).toBeNull()
    expect(subscriptionFrom({ endpoint: '', keys: { p256dh: 'P', auth: 'A' } })).toBeNull()
    expect(subscriptionFrom({ endpoint: 1, keys: { p256dh: 'P', auth: 'A' } })).toBeNull()
  })
})

describe('shownFrom', () => {
  it('maps tag and data', () => {
    expect(shownFrom({ tag: 'chat:1', data: { chatId: 'c1', kind: 'replied', at: 5, agents: ['a'] } })).toEqual({
      tag: 'chat:1',
      chatId: 'c1',
      kind: 'replied',
      at: 5
    })
  })
  it('keeps a null chat', () => {
    expect(shownFrom({ tag: 'test', data: { chatId: null, kind: 'test', at: 1 } })).toEqual({
      tag: 'test',
      chatId: null,
      kind: 'test',
      at: 1
    })
  })
  it('skips one without usable data (the generic fallback)', () => {
    expect(shownFrom({ tag: 'unknown', data: undefined })).toBeNull()
    expect(shownFrom({ tag: 'x', data: { chatId: 'c', kind: 'bogus', at: 1 } })).toBeNull()
    expect(shownFrom({ tag: 'x', data: { chatId: 'c', kind: 'waiting', at: 'late' } })).toBeNull()
    expect(shownFrom({ tag: '', data: { chatId: 'c', kind: 'waiting', at: 1 } })).toBeNull()
  })
  // A spend-cap or workflow notice dropped here could never be cleared when its chat is opened.
  it('reads back every kind the server sends', () => {
    for (const kind of ['spend-cap', 'workflow', 'paused'] as const) {
      expect(shownFrom({ tag: `chat:${kind}`, data: { chatId: 'c1', kind, at: 2 } })).toEqual({
        tag: `chat:${kind}`,
        chatId: 'c1',
        kind,
        at: 2
      })
    }
  })
})

const base: SupportEnv = {
  hasWorker: true,
  hasPush: true,
  permission: 'default',
  ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130',
  maxTouchPoints: 0,
  standalone: false
}
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1'
const IPAD_DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15'

describe('pushSupportFrom', () => {
  it('is ok where everything exists', () => {
    expect(pushSupportFrom(base)).toBe('ok')
  })
  it('is unsupported without a worker or PushManager', () => {
    expect(pushSupportFrom({ ...base, hasWorker: false })).toBe('unsupported')
    expect(pushSupportFrom({ ...base, hasPush: false })).toBe('unsupported')
  })
  it('asks an iPhone or iPad that is not installed to install first', () => {
    expect(pushSupportFrom({ ...base, ua: IPHONE, hasPush: false })).toBe('ios-needs-install')
    expect(pushSupportFrom({ ...base, ua: IPHONE })).toBe('ios-needs-install')
    expect(pushSupportFrom({ ...base, ua: IPAD_DESKTOP_UA, maxTouchPoints: 5 })).toBe('ios-needs-install')
  })
  it('lets an installed iPhone through', () => {
    expect(pushSupportFrom({ ...base, ua: IPHONE, standalone: true })).toBe('ok')
  })
  it('does not mistake a real Mac for an iPad', () => {
    expect(pushSupportFrom({ ...base, ua: IPAD_DESKTOP_UA, maxTouchPoints: 0 })).toBe('ok')
  })
  it('reports a denied permission', () => {
    expect(pushSupportFrom({ ...base, permission: 'denied' })).toBe('denied')
  })
})

describe('subscribeFresh', () => {
  const sub = { endpoint: 'https://p.test/e', keys: { p256dh: 'a', auth: 'b' } }
  const invalidState = () => Object.assign(new Error('old key'), { name: 'InvalidStateError' })
  const reg = {} as ServiceWorkerRegistration

  it('drops any existing subscription before the first subscribe', async () => {
    const calls: string[] = []
    const out = await subscribeFresh(reg, 'k', {
      unsubscribe: async () => {
        calls.push('unsubscribe')
      },
      subscribe: async () => {
        calls.push('subscribe')
        return sub
      },
      isInvalidState: () => false
    })
    expect(calls).toEqual(['unsubscribe', 'subscribe'])
    expect(out).toBe(sub)
  })

  it('still subscribes when the first unsubscribe is refused', async () => {
    const out = await subscribeFresh(reg, 'k', {
      unsubscribe: async () => {
        throw new Error('no')
      },
      subscribe: async () => sub,
      isInvalidState: () => false
    })
    expect(out).toBe(sub)
  })

  it('retries once after an InvalidStateError, unsubscribing again first', async () => {
    const calls: string[] = []
    let n = 0
    const out = await subscribeFresh(reg, 'k', {
      unsubscribe: async () => {
        calls.push('unsubscribe')
      },
      subscribe: async () => {
        calls.push('subscribe')
        if (n++ === 0) throw invalidState()
        return sub
      },
      isInvalidState: (e) => (e as Error).name === 'InvalidStateError'
    })
    expect(calls).toEqual(['unsubscribe', 'subscribe', 'unsubscribe', 'subscribe'])
    expect(out).toBe(sub)
  })

  it('does not retry other errors', async () => {
    let n = 0
    await expect(
      subscribeFresh(reg, 'k', {
        unsubscribe: async () => {},
        subscribe: async () => {
          n++
          throw new Error('other')
        },
        isInvalidState: () => false
      })
    ).rejects.toThrow('other')
    expect(n).toBe(1)
  })
})
