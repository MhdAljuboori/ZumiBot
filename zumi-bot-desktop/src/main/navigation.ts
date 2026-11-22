export function isWebUrl(url: string): boolean {
  try {
    const p = new URL(url).protocol
    return p === 'http:' || p === 'https:'
  } catch {
    return false
  }
}

/** True only for a URL on exactly the connected origin (scheme, host and port), never for javascript:, data: or file:. */
export function isSameOrigin(url: string, origin: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return u.origin === new URL(origin).origin
  } catch {
    return false
  }
}

const MAX_NAME_BYTES = 200 // well under the 255-byte NAME_MAX of common filesystems

/** A file name that cannot escape the temp folder it is saved into, cut by bytes (never inside a character) with its extension kept. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f]/g, '_').trim()
  if (clean === '' || clean === '.' || clean === '..') return 'attachment'
  const dot = clean.lastIndexOf('.')
  const ext = dot > 0 && Buffer.byteLength(clean.slice(dot)) <= 20 ? clean.slice(dot) : ''
  const stem = ext ? clean.slice(0, dot) : clean
  let out = ''
  let bytes = Buffer.byteLength(ext)
  for (const ch of stem) {
    bytes += Buffer.byteLength(ch)
    if (bytes > MAX_NAME_BYTES) break
    out += ch
  }
  return (out || 'attachment') + ext
}

/** What a redirect may do: same origin passes; a main frame sent elsewhere is an error page, a subframe is just blocked. */
export function redirectAction(d: { isMainFrame: boolean; url: string }, origin: string): 'allow' | 'error' | 'block' {
  if (isSameOrigin(d.url, origin)) return 'allow'
  return d.isMainFrame ? 'error' : 'block'
}

/** A reverse proxy answers 502/503 for a down VPS, and that page loads "successfully": treat 5xx as unreachable. */
export function isServerError(httpResponseCode: number, mode: 'local' | 'vps'): boolean {
  return mode === 'vps' && httpResponseCode >= 500
}

// Electron's request handler gives a list (mediaTypes), its check handler a single mediaType.
export interface MediaAsk {
  mediaTypes?: readonly string[]
  mediaType?: string
}

/**
 * The only device permissions a page gets, for the connected origin: writing sanitized text to the clipboard (the copy
 * buttons) and audio-only capture (dictation). Any video, or an ask that does not say audio, is refused.
 */
export function isPermissionAllowed(permission: string, requestingUrl: string, origin: string, media: MediaAsk = {}): boolean {
  if (!isSameOrigin(requestingUrl, origin)) return false
  if (permission === 'clipboard-sanitized-write') return true
  if (permission !== 'media') return false
  const { mediaTypes, mediaType } = media
  if (mediaTypes) return mediaTypes.length > 0 && mediaTypes.every((t) => t === 'audio')
  return mediaType === 'audio'
}
