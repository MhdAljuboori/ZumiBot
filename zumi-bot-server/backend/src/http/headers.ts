import { createReadStream } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { pipeline } from 'node:stream'

// Every response gets these, including errors and gate-handled routes.
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // Dictation needs the mic on our own origin only.
  'Permissions-Policy': 'camera=(), microphone=(self), geolocation=()'
}

export function applySecurityHeaders(res: ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)
}

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...extra })
  res.end(data)
}

// pipeline, not pipe: when the client aborts, pipe leaves the file stream (and its fd) open.
export function streamFile(res: ServerResponse, file: string): void {
  pipeline(createReadStream(file), res, () => {})
}
