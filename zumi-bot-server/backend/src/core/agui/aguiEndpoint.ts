import { lookup as dnsLookup } from 'node:dns/promises'
import { AGUI_TEXT, aguiLaunchError } from '@zumibot/shared/agui'
import {
  addressClass,
  allowedClass,
  checkedAddresses,
  pinnedLookup,
  unbracket,
  type AddressClass,
  type AddressLookup
} from '../addressGuard'

// The endpoint checks run at save, Test and every run (docs/architecture/protocol-engines.md, Endpoint checks). Pure apart
// from the injected lookup: a remote agent's request reaches only a public address the user picked. The address classes are
// the shared guard's (core/addressGuard.ts); local addresses pass only under the dev hook.

/** A promise-style `dns.lookup` with `{all: true}`; injected so tests never hit real DNS. */
export type AguiLookup = AddressLookup
export { addressClass, allowedClass, pinnedLookup, type AddressClass }

/**
 * The endpoint as a URL, or the sentence why it is refused. The shape is Agent Studio's own check (https, no userinfo, no
 * fragment); plain `http:` passes only under the dev hook, and only to a loopback literal or `localhost`.
 */
export function checkUrl(raw: string, allowLocal: boolean): { url: URL } | { error: string } {
  const shape = aguiLaunchError({ endpoint: raw })
  if (shape !== null) return { error: shape }
  const url = new URL(raw)
  if (url.protocol === 'http:' && !(allowLocal && (url.hostname === 'localhost' || addressClass(unbracket(url.hostname)) === 'loopback'))) {
    return { error: AGUI_TEXT.endpointInvalid }
  }
  return { url }
}

/**
 * Where to connect: the name, the port and every address it resolves to, all of them allowed (a mixed answer is refused). A
 * literal address is checked as it is. Errors name the host as `aguiHost` does, never the path or the query.
 */
export async function resolveTarget(
  url: URL,
  allowLocal: boolean,
  lookup: AguiLookup = dnsLookup
): Promise<{ host: string; port: number; addresses: string[] } | { error: string }> {
  const host = unbracket(url.hostname)
  const plain = url.protocol === 'http:'
  if (!plain && url.protocol !== 'https:') return { error: AGUI_TEXT.endpointInvalid }
  // Plain http is the dev hook's loopback only: it carries the key in the clear.
  const ok = (a: string) => (plain ? allowLocal && addressClass(a) === 'loopback' : allowedClass(addressClass(a), allowLocal))
  const checked = await checkedAddresses(host, ok, lookup)
  if ('error' in checked) return { error: checked.error === 'resolve' ? AGUI_TEXT.resolveFailed(url.host) : AGUI_TEXT.notPublic(url.host) }
  const { addresses } = checked
  return { host, port: url.port !== '' ? Number(url.port) : plain ? 80 : 443, addresses }
}

/**
 * Where a redirect may go: only a 307 or 308, to the same scheme, host and port, with no userinfo or fragment. The caller
 * checks the target again (`resolveTarget`) and counts the hops.
 */
export function redirectTarget(from: URL, status: number, location: string | undefined): URL | { error: string } {
  const refused = { error: AGUI_TEXT.redirected }
  if ((status !== 307 && status !== 308) || typeof location !== 'string' || location === '' || location.includes('#')) return refused
  let to: URL
  try {
    to = new URL(location, from)
  } catch {
    return refused
  }
  if (to.protocol !== from.protocol || to.hostname !== from.hostname || to.port !== from.port || to.username !== '' || to.password !== '')
    return refused
  return to
}
