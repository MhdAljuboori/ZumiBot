import { expect, it } from 'vitest'
import { xauthEntry } from '../../../src/core/desktop/xauth'

const cookie = Uint8Array.from({ length: 16 }, (_, i) => i)

it('writes one FamilyWild MIT-MAGIC-COOKIE-1 entry, every field u16 big-endian length prefixed', () => {
  const name = [...Buffer.from('MIT-MAGIC-COOKIE-1')]
  expect([...xauthEntry(90, cookie)]).toEqual([
    0xff,
    0xff, // FamilyWild
    0x00,
    0x00, // empty address
    0x00,
    0x02,
    0x39,
    0x30, // display number "90"
    0x00,
    0x12,
    ...name, // auth name
    0x00,
    0x10,
    ...cookie // 16-byte cookie
  ])
  expect(xauthEntry(90, cookie).length).toBe(46)
  expect([...xauthEntry(7, cookie).subarray(4, 7)]).toEqual([0x00, 0x01, 0x37])
})

it('refuses a cookie that is not 16 bytes and a display that is not a small integer', () => {
  expect(() => xauthEntry(90, new Uint8Array(15))).toThrow()
  expect(() => xauthEntry(-1, cookie)).toThrow()
  expect(() => xauthEntry(1.5, cookie)).toThrow()
  expect(() => xauthEntry(65536, cookie)).toThrow()
})
