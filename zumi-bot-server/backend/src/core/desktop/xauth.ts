const COOKIE_NAME = 'MIT-MAGIC-COOKIE-1'
const FAMILY_WILD = 0xffff

/**
 * One Xauthority entry for `:display`. FamilyWild with an empty address matches any host, so the
 * entry works on the unix socket; `xauth add` would write a FamilyLocal + hostname entry instead.
 */
export function xauthEntry(display: number, cookie: Uint8Array): Uint8Array {
  if (!Number.isInteger(display) || display < 0 || display > 65535) throw new Error('Invalid X display number')
  if (cookie.length !== 16) throw new Error('X cookie must be 16 bytes')
  const fields = [new Uint8Array(0), Buffer.from(String(display), 'ascii'), Buffer.from(COOKIE_NAME, 'ascii'), cookie]
  const out = Buffer.alloc(2 + fields.reduce((n, f) => n + 2 + f.length, 0))
  out.writeUInt16BE(FAMILY_WILD, 0)
  let at = 2
  for (const field of fields) {
    out.writeUInt16BE(field.length, at)
    out.set(field, at + 2)
    at += 2 + field.length
  }
  return new Uint8Array(out)
}
