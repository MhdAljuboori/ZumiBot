import { lookup as dnsLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'

// Which addresses a request the server makes for someone else may reach (AG-UI endpoints, workflow HTTP steps, a contained
// run's network proxy). Public means globally reachable unicast, so a special-purpose block that is not is `reserved` and
// refused even where local addresses are allowed (fail closed). Pure apart from the injected lookup.

export type AddressClass =
  'public' | 'loopback' | 'unspecified' | 'private' | 'cgnat' | 'linkLocal' | 'multicast' | 'broadcast' | 'reserved'

/** A promise-style `dns.lookup` with `{all: true}`; injected so tests never hit real DNS. */
export type AddressLookup = (hostname: string, options: { all: true }) => Promise<LookupAddress[]>

function v4Class([a, b, c, d]: number[]): AddressClass {
  if (a === 0) return 'unspecified'
  if (a === 127) return 'loopback'
  if (a === 10 || (a === 172 && (b & 0xf0) === 16) || (a === 192 && b === 168)) return 'private'
  if (a === 100 && (b & 0xc0) === 64) return 'cgnat'
  if (a === 169 && b === 254) return 'linkLocal'
  if ((a & 0xf0) === 224) return 'multicast'
  if (a === 255 && b === 255 && c === 255 && d === 255) return 'broadcast'
  // 240/4 (reserved), 198.18/15 (benchmarking), 192.0.0/24 (IETF protocol assignments), 192.88.99/24 (the deprecated 6to4
  // relay anycast) and the documentation blocks.
  if ((a & 0xf0) === 240 || (a === 198 && (b & 0xfe) === 18)) return 'reserved'
  if ((a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)) return 'reserved'
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return 'reserved'
  return 'public'
}

// The 16 bytes of an address `isIP` already took as IPv6. A dotted IPv4 tail becomes its two groups first.
function v6Bytes(ip: string): number[] {
  let s = ip
  const tail = s.slice(s.lastIndexOf(':') + 1)
  if (tail.includes('.')) {
    const [a, b, c, d] = tail.split('.').map(Number)
    s = s.slice(0, s.length - tail.length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head, rest] = s.split('::')
  const left = head ? head.split(':') : []
  const right = rest === undefined ? [] : rest ? rest.split(':') : []
  const groups = rest === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
  return groups.flatMap((g) => {
    const n = parseInt(g, 16)
    return [n >> 8, n & 0xff]
  })
}

const zero = (b: number[], from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0)

// Whether the address's first `bits` bits are the prefix's (eight 16-bit groups).
function within(b: number[], groups: readonly number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) if (((b[i >> 3] >> (7 - (i & 7))) & 1) !== ((groups[i >> 4] >> (15 - (i & 15))) & 1)) return false
  return true
}

// Special-purpose blocks IANA's IPv6 registry lists as not globally reachable, plus Teredo.
const V6_RESERVED: ReadonlyArray<readonly [readonly number[], number]> = [
  // Local-use NAT64 (RFC 8215): its IPv4 address may sit in several layouts, so none is guessed.
  [[0x64, 0xff9b, 1, 0, 0, 0, 0, 0], 48],
  [[0x100, 0, 0, 0, 0, 0, 0, 0], 63], // discard-only 100::/64 and the dummy prefix 100:0:0:1::/64
  // Teredo: the client address it carries is obfuscated, so it cannot be classed by it.
  [[0x2001, 0, 0, 0, 0, 0, 0, 0], 32],
  [[0x2001, 2, 0, 0, 0, 0, 0, 0], 48], // benchmarking
  [[0x2001, 0x10, 0, 0, 0, 0, 0, 0], 28], // the deprecated ORCHID
  [[0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32], // documentation
  [[0x3fff, 0, 0, 0, 0, 0, 0, 0], 20], // documentation
  [[0x5f00, 0, 0, 0, 0, 0, 0, 0], 16], // SRv6 SIDs
  [[0xfec0, 0, 0, 0, 0, 0, 0, 0], 10] // the old site-local
]

function v6Class(b: number[]): AddressClass {
  if (zero(b, 0, 16)) return 'unspecified'
  if (zero(b, 0, 15) && b[15] === 1) return 'loopback'
  // An IPv4 address carried in IPv6 reaches that IPv4 host, so it is classed as that host: IPv4-mapped (::ffff:0:0/96),
  // SIIT's IPv4-translated (::ffff:0:0:0/96), IPv4-compatible (::/96), NAT64's 64:ff9b::/96, and 6to4 (2002::/16, bits 16-47).
  if (zero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) return v4Class(b.slice(12))
  if (zero(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && zero(b, 10, 12)) return v4Class(b.slice(12))
  if (zero(b, 0, 12)) return v4Class(b.slice(12))
  if (within(b, [0x64, 0xff9b, 0, 0, 0, 0, 0, 0], 96)) return v4Class(b.slice(12))
  if (b[0] === 0x20 && b[1] === 0x02) return v4Class(b.slice(2, 6))
  if (V6_RESERVED.some(([groups, bits]) => within(b, groups, bits))) return 'reserved'
  if ((b[0] & 0xfe) === 0xfc) return 'private'
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'linkLocal'
  if (b[0] === 0xff) return 'multicast'
  return 'public'
}

/** The class of an IPv4 or IPv6 address (a zone id is ignored), or null for anything that is not one. */
export function addressClass(ip: string): AddressClass | null {
  const bare = ip.split('%')[0]
  switch (isIP(bare)) {
    case 4:
      return v4Class(bare.split('.').map(Number))
    case 6:
      return v6Class(v6Bytes(bare))
    default:
      return null
  }
}

/** Public always; loopback and private only when local is allowed. Everything else (reserved included), never. */
export const allowedClass = (c: AddressClass | null, allowLocal: boolean): boolean =>
  c === 'public' || (allowLocal && (c === 'loopback' || c === 'private'))

export const unbracket = (hostname: string): string => (hostname.startsWith('[') ? hostname.slice(1, -1) : hostname)

/** The usual rule as a check of one address: public, or loopback and private too when `allowLocal`. */
export const publicOrLocal =
  (allowLocal: boolean) =>
  (address: string): boolean =>
    allowedClass(addressClass(address), allowLocal)

/**
 * Every address a host name resolves to (a literal is taken as it is), all of them passing `ok`: a mixed answer is refused,
 * since the connection may pick any of them. Connect only through `pinnedLookup` of the result, so DNS cannot answer again.
 */
export async function checkedAddresses(
  hostname: string,
  ok: (address: string) => boolean,
  lookup: AddressLookup = dnsLookup
): Promise<{ addresses: string[] } | { error: 'resolve' | 'notPublic' }> {
  const host = unbracket(hostname)
  let addresses: string[]
  if (isIP(host) !== 0) addresses = [host]
  else {
    try {
      addresses = (await lookup(host, { all: true })).map((a) => a.address)
    } catch {
      return { error: 'resolve' }
    }
    if (addresses.length === 0) return { error: 'resolve' }
  }
  return addresses.every(ok) ? { addresses } : { error: 'notPublic' }
}

const familyOf = (f: unknown): 4 | 6 | null => (f === 4 || f === 'IPv4' ? 4 : f === 6 || f === 'IPv6' ? 6 : null)

/**
 * A `lookup` that answers only with the checked addresses, so a DNS answer cannot change between the check and the connect.
 * Node 22 asks with `{all: true}` (autoSelectFamily) and wants the list; any other call wants one address and its family.
 */
export function pinnedLookup(addresses: readonly string[]): LookupFunction {
  const all: LookupAddress[] = addresses.map((address) => ({ address, family: isIP(address) }))
  return (hostname, options, callback) => {
    // Asynchronous, as dns.lookup is: the socket's listeners are not all attached yet when it asks.
    if (all.length === 0) {
      // Nothing checked means nothing to connect to: answered as dns.lookup answers a name with no address.
      const err = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND', syscall: 'getaddrinfo', hostname })
      process.nextTick(callback, err)
      return
    }
    const family = familyOf(options?.family)
    const fitting = family === null ? all : all.filter((a) => a.family === family)
    const list = fitting.length > 0 ? fitting : all
    if (options?.all) process.nextTick(callback, null, list)
    else process.nextTick(callback, null, list[0].address, list[0].family)
  }
}
