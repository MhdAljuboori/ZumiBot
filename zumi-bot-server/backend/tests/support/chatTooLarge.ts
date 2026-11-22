import { expect } from 'vitest'

const RESETS = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED'])

/**
 * Expects an oversized request to be refused with 413. Windows and macOS reset the socket when the server answers before
 * it has read the body, so there the client may see a reset instead (install.md, "Windows: native" and Phase 0); anything
 * else still fails, and Linux must always see the 413.
 */
export async function expectTooLarge(res: Promise<Response>): Promise<void> {
  let r: Response
  try {
    r = await res
  } catch (err) {
    const code = (err as { cause?: { code?: string } }).cause?.code
    if ((process.platform === 'win32' || process.platform === 'darwin') && code && RESETS.has(code)) return
    throw err
  }
  expect(r.status).toBe(413)
}
