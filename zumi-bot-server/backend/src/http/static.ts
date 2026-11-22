import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { streamFile } from './headers'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Length': 0 })
  res.end()
}

// Served with no session. Google's WebAPK server fetches the manifest's icons without our cookie when Chrome installs
// the app: behind the gate it got the login redirect, and the splash fell back to the small launcher icon, blurred.
export const PUBLIC_FILES: ReadonlySet<string> = new Set(['/icon-192.png', '/icon-512.png', '/badge-96.png'])

const isFile = (p: string): Promise<number | null> =>
  stat(p).then(
    (s) => (s.isFile() ? s.size : null),
    () => null
  )

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  webDir: string,
  o: { fallback?: boolean } = {}
): Promise<void> {
  // Judged on the raw request path: URL parsing would quietly fold ../ away and serve the index instead of refusing.
  let path: string
  try {
    path = decodeURIComponent((req.url ?? '/').split(/[?#]/)[0]!)
  } catch {
    return notFound(res)
  }
  if (path.includes('\0') || path.split(/[/\\]/).includes('..')) return notFound(res)

  const root = resolve(webDir)
  let file = resolve(join(root, path))
  if (file !== root && !file.startsWith(root + sep)) return notFound(res)
  let size = await isFile(file)
  if (size === null) {
    // A missing asset is a real 404; any other path is a client-side route. A public file never falls back to the app.
    if (path.startsWith('/assets/') || o.fallback === false) return notFound(res)
    file = join(root, 'index.html')
    size = await isFile(file)
    if (size === null) return notFound(res)
  }
  const hashed = file.startsWith(join(root, 'assets') + sep)
  res.writeHead(200, {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache'
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  streamFile(res, file)
}
