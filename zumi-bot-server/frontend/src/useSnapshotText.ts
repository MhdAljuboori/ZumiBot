import { useEffect, useState } from 'react'
import type { Side } from './state/filesPanel'

// Copies are content-addressed, so a cached text never goes stale; the cap only bounds memory.
const MAX_CACHED = 32 * 1024 * 1024
const texts = new Map<string, string>()
const loading = new Map<string, Promise<string>>()
let cached = 0

export const snapshotUrl = (chatId: string, id: string): string => `/api/files/${chatId}/${id}`

function remember(url: string, text: string): void {
  texts.set(url, text)
  cached += text.length
  // Oldest first, never the one just added.
  for (const [key, old] of texts) {
    if (cached <= MAX_CACHED || key === url) break
    texts.delete(key)
    cached -= old.length
  }
}

export const cachedText = (url: string): string | undefined => texts.get(url)

/** The text at a same-origin URL, fetched once and kept; calls made meanwhile share the request. */
export function loadText(url: string): Promise<string> {
  const have = texts.get(url)
  if (have !== undefined) return Promise.resolve(have)
  let pending = loading.get(url)
  if (!pending) {
    pending = fetch(url, { credentials: 'same-origin' })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      .then((t) => {
        remember(url, t)
        return t
      })
      .finally(() => loading.delete(url))
    loading.set(url, pending)
  }
  return pending
}

/** Starts loading the URLs and rerenders once they are all in. Read each text with `cachedText` when `ready`. */
export function useLoadedTexts(urls: readonly string[]): { ready: boolean; failed: boolean } {
  const key = urls.join('\n')
  const [done, setDone] = useState<{ key: string; failed: boolean } | null>(null)
  const ready = urls.every((u) => texts.has(u))
  // `ready` too: a text another view's load pushed out of the cache must be fetched again, not left loading forever.
  useEffect(() => {
    if (ready) return
    let live = true // a late answer for what is no longer shown is dropped
    Promise.all(urls.map(loadText)).then(
      () => live && setDone({ key, failed: false }),
      () => live && setDone({ key, failed: true })
    )
    return () => {
      live = false
    }
  }, [key, ready]) // urls is what key says
  return { ready, failed: !ready && done?.key === key && done.failed }
}

/** A side's text: an `{id}` is fetched from the content route, a `{text}` is as given, a miss or null has none. */
export function useSnapshotText(chatId: string, side: Side | null): { text: string | null; failed: boolean } {
  const url = side && 'id' in side ? snapshotUrl(chatId, side.id) : null
  const { ready, failed } = useLoadedTexts(url === null ? [] : [url])
  if (side && 'text' in side) return { text: side.text, failed: false }
  if (url === null) return { text: null, failed: false }
  return { text: ready ? (cachedText(url) ?? null) : null, failed }
}
