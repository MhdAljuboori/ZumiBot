import type { AguiLaunch } from '@zumibot/shared/agui'

// What ChatService builds for a remote agent's turn besides its messages: the auth header. Pure.

// Every C0 control but HTAB, DEL, and anything past Latin-1: Node refuses such a header value, and a line break or NUL would
// end the header. Refused up front, so the send fails with the fixed key sentence instead of a network error.
// eslint-disable-next-line no-control-regex
const HEADER_UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007fĀ-￿]/

/** Whether a key's value cannot be sent as a header value (`authKeyUnusable`). */
export const keyUnusable = (value: string): boolean => HEADER_UNSAFE.test(value)

/** The auth header a remote agent's run sends: `Authorization: Bearer <v>` by default, else `<authHeader>: <v>`; none without a key. */
export function aguiHeaders(launch: AguiLaunch, value: string | undefined): Record<string, string> {
  if (launch.authKey === null || value === undefined) return {}
  const name = launch.authHeader
  return name === null || name.toLowerCase() === 'authorization' ? { Authorization: `Bearer ${value}` } : { [name]: value }
}
