import { describe, expect, it } from 'vitest'
import type { LookupAddress } from 'node:dns'
import { AGUI_TEXT } from '@zumibot/shared/agui'
import { addressClass, allowedClass, checkUrl, pinnedLookup, redirectTarget, resolveTarget } from '../../src/core/agui/aguiEndpoint'

// A DNS answer without the network: tests never hit real DNS.
const answer =
  (...addresses: string[]) =>
  async (): Promise<LookupAddress[]> =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
const failing = async (): Promise<LookupAddress[]> => {
  throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
}

describe('addressClass', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['1.1.1.1', 'public'],
    ['0.0.0.0', 'unspecified'],
    ['0.1.2.3', 'unspecified'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['10.0.0.1', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['172.15.255.255', 'public'],
    ['172.32.0.1', 'public'],
    ['192.168.1.1', 'private'],
    ['192.169.0.1', 'public'],
    ['100.64.0.1', 'cgnat'],
    ['100.127.255.255', 'cgnat'],
    ['100.63.255.255', 'public'],
    ['100.128.0.1', 'public'],
    ['169.254.169.254', 'linkLocal'],
    ['224.0.0.1', 'multicast'],
    ['239.255.255.255', 'multicast'],
    ['255.255.255.255', 'broadcast']
  ])('classes IPv4 %s as %s', (ip, c) => {
    expect(addressClass(ip)).toBe(c)
  })

  it.each([
    ['2606:4700:4700::1111', 'public'],
    ['::', 'unspecified'],
    ['::1', 'loopback'],
    ['fc00::1', 'private'],
    ['fd12:3456::1', 'private'],
    ['fe80::1', 'linkLocal'],
    ['fe80::1%eth0', 'linkLocal'],
    ['febf::1', 'linkLocal'],
    ['ff02::1', 'multicast']
  ])('classes IPv6 %s as %s', (ip, c) => {
    expect(addressClass(ip)).toBe(c)
  })

  it.each([
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:a00:1', 'private'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:169.254.169.254', 'linkLocal'],
    ['::ffff:8.8.8.8', 'public'],
    ['::10.0.0.1', 'private'],
    ['::8.8.8.8', 'public'],
    ['64:ff9b::7f00:1', 'loopback'],
    ['64:ff9b::10.1.2.3', 'private'],
    ['64:ff9b::8.8.8.8', 'public'],
    ['::ffff:0:10.0.0.1', 'private'],
    ['::ffff:0:7f00:1', 'loopback'],
    ['::ffff:0:192.0.2.1', 'reserved'],
    ['::ffff:0:8.8.8.8', 'public'],
    ['2002:a00:1::1', 'private'],
    ['2002:7f00:1::', 'loopback'],
    ['2002:a9fe:a9fe::1', 'linkLocal'],
    ['2002:c000:201::1', 'reserved'],
    ['2002:808:808::1', 'public'],
    ['2003:a00:1::1', 'public']
  ])('classes the mapped, SIIT, NAT64 or 6to4 form %s by the IPv4 address it holds (%s)', (ip, c) => {
    expect(addressClass(ip)).toBe(c)
  })

  it.each([
    ['240.0.0.1', 'reserved'],
    ['255.255.255.254', 'reserved'],
    ['198.18.0.1', 'reserved'],
    ['198.19.255.255', 'reserved'],
    ['198.17.255.255', 'public'],
    ['198.20.0.0', 'public'],
    ['192.0.0.8', 'reserved'],
    ['192.0.1.1', 'public'],
    ['192.0.2.5', 'reserved'],
    ['192.0.3.1', 'public'],
    ['198.51.100.7', 'reserved'],
    ['198.51.101.1', 'public'],
    ['203.0.113.9', 'reserved'],
    ['203.0.114.1', 'public'],
    ['fec0::1', 'reserved'],
    ['feff::1', 'reserved'],
    ['2001:db8::1', 'reserved'],
    ['2001:db9::1', 'public'],
    ['100::1', 'reserved'],
    ['100:0:0:1::1', 'reserved'],
    ['100:0:0:2::1', 'public'],
    ['2001::1', 'reserved'],
    ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'reserved'],
    ['2001:2::1', 'reserved'],
    ['2001:2:1::1', 'public'],
    ['2001:10::1', 'reserved'],
    ['2001:1f:ffff::1', 'reserved'],
    ['2001:20::1', 'public'],
    ['192.88.99.1', 'reserved'],
    ['192.88.98.255', 'public'],
    ['192.88.100.1', 'public'],
    ['2001:4860:4860::8888', 'public'],
    ['64:ff9b:1::8.8.8.8', 'reserved'],
    ['64:ff9b:1::a9fe:a9fe', 'reserved'],
    ['3fff::1', 'reserved'],
    ['3fff:fff::1', 'reserved'],
    ['3fff:1000::1', 'public'],
    ['5f00::1', 'reserved'],
    ['5f00:ffff::1', 'reserved'],
    ['5f01::1', 'public']
  ])('classes the special-purpose address %s as %s (fail closed)', (ip, c) => {
    expect(addressClass(ip)).toBe(c)
  })

  it('gives null for anything that is not an address', () => {
    expect(addressClass('example.com')).toBeNull()
    expect(addressClass('')).toBeNull()
    expect(addressClass('1.2.3')).toBeNull()
  })
})

describe('allowedClass', () => {
  it('allows public always, loopback and private only with the dev hook, and nothing else', () => {
    expect(allowedClass('public', false)).toBe(true)
    expect(allowedClass('loopback', false)).toBe(false)
    expect(allowedClass('private', false)).toBe(false)
    expect(allowedClass('loopback', true)).toBe(true)
    expect(allowedClass('private', true)).toBe(true)
    for (const c of ['unspecified', 'cgnat', 'linkLocal', 'multicast', 'broadcast', 'reserved'] as const)
      expect(allowedClass(c, true)).toBe(false)
    expect(allowedClass(null, true)).toBe(false)
  })
})

describe('checkUrl', () => {
  it('takes an https address', () => {
    const r = checkUrl('https://agents.example.com/run?x=1', false)
    expect('url' in r && r.url.href).toBe('https://agents.example.com/run?x=1')
  })

  it.each([
    ['not a url'],
    ['ftp://agents.example.com/run'],
    ['https://user:pass@agents.example.com/run'],
    ['https://agents.example.com/run#frag'],
    ['https://agents.example.com/run#'],
    ['https://agents.example.com/r un'],
    ['']
  ])('refuses %j', (raw) => {
    const r = checkUrl(raw, true)
    expect('error' in r).toBe(true)
  })

  it('refuses http: without the dev hook, even to loopback', () => {
    expect(checkUrl('http://127.0.0.1:8080/run', false)).toEqual({ error: AGUI_TEXT.endpointInvalid })
    expect(checkUrl('http://localhost:8080/run', false)).toEqual({ error: AGUI_TEXT.endpointInvalid })
  })

  it('allows http: with the dev hook only to a loopback literal or localhost', () => {
    expect('url' in checkUrl('http://127.0.0.1:8080/run', true)).toBe(true)
    expect('url' in checkUrl('http://[::1]:8080/run', true)).toBe(true)
    expect('url' in checkUrl('http://localhost:8080/run', true)).toBe(true)
    expect(checkUrl('http://10.0.0.1/run', true)).toEqual({ error: AGUI_TEXT.endpointInvalid })
    expect(checkUrl('http://agents.example.com/run', true)).toEqual({ error: AGUI_TEXT.endpointInvalid })
  })
})

describe('resolveTarget', () => {
  const url = (s: string) => new URL(s)

  it('gives the host, the port and every address of a public answer', async () => {
    expect(await resolveTarget(url('https://agents.example.com/run'), false, answer('8.8.8.8', '2606:4700:4700::1111'))).toEqual({
      host: 'agents.example.com',
      port: 443,
      addresses: ['8.8.8.8', '2606:4700:4700::1111']
    })
    expect(await resolveTarget(url('https://agents.example.com:8443/run'), false, answer('8.8.8.8'))).toEqual({
      host: 'agents.example.com',
      port: 8443,
      addresses: ['8.8.8.8']
    })
  })

  it('asks the lookup for every address', async () => {
    const calls: unknown[] = []
    await resolveTarget(url('https://agents.example.com/run'), false, async (h, o) => {
      calls.push([h, o])
      return [{ address: '8.8.8.8', family: 4 }]
    })
    expect(calls).toEqual([['agents.example.com', { all: true }]])
  })

  it('refuses a mixed answer: every address must be public', async () => {
    expect(await resolveTarget(url('https://agents.example.com/run'), false, answer('8.8.8.8', '10.0.0.1'))).toEqual({
      error: AGUI_TEXT.notPublic('agents.example.com')
    })
    expect(await resolveTarget(url('https://agents.example.com/run'), false, answer('8.8.8.8', '::ffff:10.0.0.1'))).toEqual({
      error: AGUI_TEXT.notPublic('agents.example.com')
    })
    expect(await resolveTarget(url('https://agents.example.com:8443/run'), false, answer('64:ff9b::7f00:1'))).toEqual({
      error: AGUI_TEXT.notPublic('agents.example.com:8443')
    })
  })

  it('gives resolveFailed when the lookup fails or finds nothing', async () => {
    expect(await resolveTarget(url('https://nowhere.example/run'), false, failing)).toEqual({
      error: AGUI_TEXT.resolveFailed('nowhere.example')
    })
    expect(await resolveTarget(url('https://nowhere.example/run'), false, answer())).toEqual({
      error: AGUI_TEXT.resolveFailed('nowhere.example')
    })
  })

  it('checks a literal address directly, without a lookup', async () => {
    const never = async (): Promise<LookupAddress[]> => {
      throw new Error('looked up')
    }
    expect(await resolveTarget(url('https://8.8.8.8/run'), false, never)).toEqual({ host: '8.8.8.8', port: 443, addresses: ['8.8.8.8'] })
    expect(await resolveTarget(url('https://[::ffff:10.0.0.1]/run'), false, never)).toEqual({
      error: AGUI_TEXT.notPublic('[::ffff:a00:1]')
    })
    expect(await resolveTarget(url('https://[2606:4700:4700::1111]:9000/run'), false, never)).toEqual({
      host: '2606:4700:4700::1111',
      port: 9000,
      addresses: ['2606:4700:4700::1111']
    })
  })

  it('allows loopback and private addresses only with the dev hook', async () => {
    expect(await resolveTarget(url('https://agents.lan/run'), false, answer('192.168.1.5'))).toEqual({
      error: AGUI_TEXT.notPublic('agents.lan')
    })
    expect(await resolveTarget(url('https://agents.lan/run'), true, answer('192.168.1.5'))).toEqual({
      host: 'agents.lan',
      port: 443,
      addresses: ['192.168.1.5']
    })
    expect(await resolveTarget(url('https://agents.lan/run'), true, answer('169.254.169.254'))).toEqual({
      error: AGUI_TEXT.notPublic('agents.lan')
    })
    expect(await resolveTarget(url('https://agents.lan/run'), true, answer('100.64.0.1'))).toEqual({
      error: AGUI_TEXT.notPublic('agents.lan')
    })
    expect(await resolveTarget(url('https://agents.lan/run'), true, answer('192.168.1.5', '198.18.0.1'))).toEqual({
      error: AGUI_TEXT.notPublic('agents.lan')
    })
    expect(await resolveTarget(url('https://agents.lan/run'), true, answer('2001:db8::1'))).toEqual({
      error: AGUI_TEXT.notPublic('agents.lan')
    })
  })

  it('takes plain http: only to loopback, and only with the dev hook', async () => {
    expect(await resolveTarget(url('http://localhost:8080/run'), true, answer('127.0.0.1', '::1'))).toEqual({
      host: 'localhost',
      port: 8080,
      addresses: ['127.0.0.1', '::1']
    })
    expect(await resolveTarget(url('http://localhost/run'), true, answer('127.0.0.1'))).toEqual({
      host: 'localhost',
      port: 80,
      addresses: ['127.0.0.1']
    })
    expect(await resolveTarget(url('http://localhost:8080/run'), true, answer('127.0.0.1', '192.168.1.5'))).toEqual({
      error: AGUI_TEXT.notPublic('localhost:8080')
    })
    expect(await resolveTarget(url('http://localhost:8080/run'), false, answer('127.0.0.1'))).toEqual({
      error: AGUI_TEXT.notPublic('localhost:8080')
    })
  })
})

describe('pinnedLookup', () => {
  const call = (fn: ReturnType<typeof pinnedLookup>, options: object) =>
    new Promise<unknown[]>((resolve) => fn('agents.example.com', options, (...args: unknown[]) => resolve(args)))

  it('answers the all form with every pinned address', async () => {
    const fn = pinnedLookup(['8.8.8.8', '2606:4700:4700::1111'])
    expect(await call(fn, { all: true })).toEqual([
      null,
      [
        { address: '8.8.8.8', family: 4 },
        { address: '2606:4700:4700::1111', family: 6 }
      ]
    ])
  })

  it('answers any other call with one address and its family', async () => {
    const fn = pinnedLookup(['8.8.8.8', '2606:4700:4700::1111'])
    expect(await call(fn, {})).toEqual([null, '8.8.8.8', 4])
    expect(await call(fn, { family: 6 })).toEqual([null, '2606:4700:4700::1111', 6])
  })

  it('answers an empty list with ENOTFOUND through the callback, in both forms', async () => {
    for (const options of [{ all: true }, {}]) {
      const [err, address] = await call(pinnedLookup([]), options)
      expect(err).toMatchObject({ code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname: 'agents.example.com' })
      expect(address).toBeUndefined()
    }
  })

  it('answers asynchronously, as dns.lookup does', () => {
    let called = false
    pinnedLookup(['8.8.8.8'])('agents.example.com', {}, () => {
      called = true
    })
    expect(called).toBe(false)
  })
})

describe('redirectTarget', () => {
  const from = new URL('https://agents.example.com:8443/run?x=1')

  it('follows a 307 or 308 to the same scheme, host and port', () => {
    expect(String(redirectTarget(from, 307, '/v2/run'))).toBe('https://agents.example.com:8443/v2/run')
    expect(String(redirectTarget(from, 308, 'https://agents.example.com:8443/other'))).toBe('https://agents.example.com:8443/other')
    expect(String(redirectTarget(from, 307, 'next?y=2'))).toBe('https://agents.example.com:8443/next?y=2')
  })

  it('refuses 301, 302 and 303', () => {
    for (const s of [301, 302, 303, 300, 304, 200]) expect(redirectTarget(from, s, '/v2/run')).toEqual({ error: AGUI_TEXT.redirected })
  })

  it('refuses another host, scheme or port, userinfo, a fragment, or no location', () => {
    for (const loc of [
      'https://evil.example:8443/run',
      'http://agents.example.com:8443/run',
      'https://agents.example.com/run',
      'https://agents.example.com:9443/run',
      'https://user@agents.example.com:8443/run',
      '/run#frag',
      '//evil.example/run',
      '',
      undefined
    ])
      expect(redirectTarget(from, 307, loc)).toEqual({ error: AGUI_TEXT.redirected })
  })
})
