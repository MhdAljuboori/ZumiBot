import { describe, expect, it } from 'vitest'
import type { LookupAddress } from 'node:dns'
import { checkedAddresses, publicOrLocal } from '../../src/core/addressGuard'

// A DNS answer without the network: tests never hit real DNS.
const answer =
  (...addresses: string[]) =>
  async (): Promise<LookupAddress[]> =>
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
const failing = async (): Promise<LookupAddress[]> => {
  throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
}

describe('checkedAddresses', () => {
  it('hands back every address when all pass', async () => {
    expect(await checkedAddresses('api.example.com', publicOrLocal(false), answer('8.8.8.8', '2606:4700:4700::1111'))).toEqual({
      addresses: ['8.8.8.8', '2606:4700:4700::1111']
    })
  })

  it('checks a literal as it is, brackets and all, without a lookup', async () => {
    const never = async (): Promise<LookupAddress[]> => {
      throw new Error('looked up')
    }
    expect(await checkedAddresses('8.8.8.8', publicOrLocal(false), never)).toEqual({ addresses: ['8.8.8.8'] })
    expect(await checkedAddresses('[::1]', publicOrLocal(false), never)).toEqual({ error: 'notPublic' })
  })

  it('refuses loopback, private, metadata and a mixed answer', async () => {
    for (const a of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '169.254.169.254', '::ffff:127.0.0.1', '64:ff9b::a00:1', '2002:7f00:1::']) {
      expect(await checkedAddresses('x.example.com', publicOrLocal(false), answer(a))).toEqual({ error: 'notPublic' })
    }
    expect(await checkedAddresses('x.example.com', publicOrLocal(false), answer('8.8.8.8', '10.0.0.1'))).toEqual({ error: 'notPublic' })
  })

  it('lets loopback and private through when local is allowed, never link-local or reserved', async () => {
    expect(await checkedAddresses('nas.lan', publicOrLocal(true), answer('192.168.1.10', '127.0.0.1'))).toEqual({
      addresses: ['192.168.1.10', '127.0.0.1']
    })
    expect(await checkedAddresses('meta', publicOrLocal(true), answer('169.254.169.254'))).toEqual({ error: 'notPublic' })
    expect(await checkedAddresses('x', publicOrLocal(true), answer('0.0.0.0'))).toEqual({ error: 'notPublic' })
  })

  it('a failed or empty lookup does not resolve', async () => {
    expect(await checkedAddresses('nowhere.example', publicOrLocal(false), failing)).toEqual({ error: 'resolve' })
    expect(await checkedAddresses('nowhere.example', publicOrLocal(false), answer())).toEqual({ error: 'resolve' })
  })
})
