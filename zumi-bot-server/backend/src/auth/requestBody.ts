import type { IncomingMessage } from 'node:http'

const BODY_MAX = 4096
const BODY_TIMEOUT_MS = 5000

/**
 * The body of an unauthenticated POST (sign-in, the setup wizard), bounded in size and time.
 * Resolves null for anything unusable (too big, too slow, aborted) and never rejects, so a caller
 * that is already counting a failed attempt cannot be derailed by a broken request.
 */
export function readJsonBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > BODY_MAX) return resolve(null)
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => finish(null), BODY_TIMEOUT_MS)
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_MAX) return finish(null)
      chunks.push(c)
    })
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => finish(null))
    req.on('close', () => finish(null))
  })
}

/** A JSON object body, or null. Every field is checked by the caller: this only unwraps it. */
export function readJsonObject(body: string | null): Record<string, unknown> | null {
  if (body === null) return null
  try {
    const v: unknown = JSON.parse(body)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export const FIELD_MAX = 1024

/** A required string field, within the field limit. */
export function field(o: Record<string, unknown>, name: string): string | null {
  const v = o[name]
  return typeof v === 'string' && v.length <= FIELD_MAX ? v : null
}
