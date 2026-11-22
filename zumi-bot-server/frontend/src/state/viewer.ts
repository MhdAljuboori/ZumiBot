import { attachmentUrl, isThumbnail } from '@zumibot/shared/attachments'
import type { Attachment } from '@zumibot/shared/types'
import type { DraftFile } from './draftFiles'
import { isTextAttachment } from './filesPanel'

/** How the viewer shows a file: the image itself, its text, or a card offering Open and Download. */
export type ViewerKind = 'image' | 'text' | 'file'

export interface ViewerItem {
  /** Stable within one list: the attachment id, or the image's address. */
  key: string
  kind: ViewerKind
  name: string
  /** What is shown: the image's source, or the address the text is read from. */
  url: string
  size?: number
  /** A link that saves the file; absent when there is nothing to save it from. */
  download?: string
  /** A sent attachment, which the shell can also open in the default app (the browser in a new tab). */
  external?: { chatId: string; id: string }
}

export interface ViewerState {
  items: ViewerItem[]
  index: number
}

export function attachmentKind(a: Pick<Attachment, 'mime' | 'size' | 'name'>): ViewerKind {
  return isThumbnail(a) ? 'image' : isTextAttachment(a) ? 'text' : 'file'
}

const downloadOf = (chatId: string | null, id: string): string => `${attachmentUrl(chatId, id)}?download=1`

/**
 * A sent message's files, in their order. An image picked on this page shows from memory (`localUrl`), as its
 * thumbnail does; saving it still goes to the server's copy.
 */
export function sentItems(
  chatId: string,
  attachments: Attachment[],
  localUrl: (id: string) => string | undefined = () => undefined
): ViewerItem[] {
  return attachments.map((a) => {
    const kind = attachmentKind(a)
    const url = (kind === 'image' ? localUrl(a.id) : undefined) ?? attachmentUrl(chatId, a.id)
    return { key: a.id, kind, name: a.name, url, size: a.size, download: downloadOf(chatId, a.id), external: { chatId, id: a.id } }
  })
}

/** The composer's files that are staged; one still uploading has nothing to show yet. */
export function draftItems(files: DraftFile[], localUrl: (id: string) => string | undefined = () => undefined): ViewerItem[] {
  return files.flatMap((f): ViewerItem[] => {
    if (f.status !== 'ready') return []
    const a = f.attachment
    const kind = attachmentKind(a)
    const url = (kind === 'image' ? localUrl(a.id) : undefined) ?? attachmentUrl(null, a.id)
    return [{ key: a.id, kind, name: f.name, url, size: a.size, download: downloadOf(null, a.id) }]
  })
}

/** The last part of an address's path, decoded; '' when it has none (a `data:` image). */
export function fileNameOf(src: string): string {
  if (src.startsWith('data:') || src.startsWith('blob:')) return ''
  const path = src.split(/[?#]/, 1)[0]
  const last = path.slice(path.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** Whether an anchor's `download` attribute can save from this address: browsers ignore it across origins and navigate. */
export function savable(src: string, origin: string): boolean {
  if (src.startsWith('data:image/') || src.startsWith('blob:')) return true
  try {
    return new URL(src, origin).origin === origin
  } catch {
    return false
  }
}

/** An image in a message's Markdown: named by its alt text, else its file name. Saved through the `download` attribute. */
export function imageItem(src: string, alt: string, origin: string): ViewerItem {
  const name = alt.trim() || fileNameOf(src) || 'Image'
  return { key: src, kind: 'image', name, url: src, ...(savable(src, origin) ? { download: src } : {}) }
}

/** Prev and next go round: past the last is the first. */
export function stepIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return (((index + delta) % length) + length) % length
}

export type ViewerKey = 'close' | 'prev' | 'next'

/** The keys the viewer takes for itself; anything with a modifier is left to the page. */
export function viewerKey(
  e: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean },
  rtl = false
): ViewerKey | null {
  if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return null
  if (e.key === 'Escape') return 'close'
  if (e.key === 'ArrowLeft') return rtl ? 'next' : 'prev'
  if (e.key === 'ArrowRight') return rtl ? 'prev' : 'next'
  return null
}

/** One viewer per page: anything may open it (a thumbnail, a chip, a Markdown image) and the host draws it. */
export function createViewerStore() {
  let state: ViewerState | null = null
  const listeners = new Set<() => void>()
  const set = (next: ViewerState | null): void => {
    state = next
    for (const l of listeners) l()
  }
  return {
    open(items: ViewerItem[], index: number): void {
      if (items.length === 0) return
      set({ items, index: Math.min(Math.max(0, index), items.length - 1) })
    },
    close(): void {
      if (state !== null) set(null)
    },
    move(delta: number): void {
      if (state === null || state.items.length < 2) return
      set({ ...state, index: stepIndex(state.index, delta, state.items.length) })
    },
    get: (): ViewerState | null => state,
    subscribe(l: () => void): () => void {
      listeners.add(l)
      return () => listeners.delete(l)
    }
  }
}

export const viewer = createViewerStore()
