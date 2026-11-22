import { THUMB_TYPES } from '@zumibot/shared/attachments'

// The server's own routes (backend/src/http/attachments.ts): ids are plain tokens.
const ROUTES = [/^\/api\/attachments\/staged\/[A-Za-z0-9-]+$/, /^\/api\/attachments\/chat\/[A-Za-z0-9-]+\/[A-Za-z0-9-]+$/]

/** The absolute URL when `url` names an attachment route on exactly the connected origin, else null. */
export function attachmentTarget(url: string, origin: string): URL | null {
  let u: URL
  try {
    u = new URL(url, origin)
  } catch {
    return null
  }
  if (u.origin !== new URL(origin).origin || u.search !== '' || u.hash !== '') return null
  return ROUTES.some((re) => re.test(u.pathname)) ? u : null
}

// What the server shows inline (images, pdf, plain text). Anything else is saved and revealed, never run.
const OPENABLE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.log': 'text/plain',
  '.csv': 'text/plain'
}
const OPENABLE_MIMES = new Set([...THUMB_TYPES, 'application/pdf', 'text/plain'])

/** 'open' only when the response MIME and the extension both name an inline-safe type, and agree. */
export function openDecision(mime: string, fileName: string): 'open' | 'reveal' {
  const dot = fileName.lastIndexOf('.')
  const byExt = dot >= 0 ? OPENABLE[fileName.slice(dot).toLowerCase()] : undefined
  const byMime = mime.split(';')[0]!.trim().toLowerCase()
  return byExt !== undefined && OPENABLE_MIMES.has(byMime) && byExt === byMime ? 'open' : 'reveal'
}
