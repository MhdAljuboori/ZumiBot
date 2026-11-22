import type { IncomingMessage } from 'node:http'

/** The whole body, or null once it passes `max`. A chunked body has no Content-Length, so count as it arrives and never hold more than the limit. */
export function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let over = false
    req.on('data', (c: Buffer) => {
      total += c.length
      // Once over, keep draining without storing: closing a socket with unread data resets it and the client loses the 413.
      // A client that still sends past twice the limit is cut off.
      if (over) {
        if (total > max * 2) req.destroy()
        return
      }
      if (total > max) {
        over = true
        chunks.length = 0
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}
