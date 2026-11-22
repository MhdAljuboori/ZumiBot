import type { Attachment } from './types'

export const ATTACH_MAX_FILES = 10
export const ATTACH_MAX_BYTES = 25 * 1024 * 1024
// CLI 2.1.299 accepted far larger images in testing (it resizes them), so these stay at the API's documented limits.
export const INLINE_IMAGE_MAX_BYTES = 3_932_160 // 3.75 MiB raw, about 5 MiB once base64 encoded
export const INLINE_IMAGE_MAX_SIDE = 8000
export const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
export const THUMB_TYPES = [...INLINE_IMAGE_TYPES, 'image/bmp']

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp'
}

/** null chatId = a staged (not yet sent) attachment. */
export function attachmentUrl(chatId: string | null, id: string): string {
  return chatId === null ? `/api/attachments/staged/${id}` : `/api/attachments/chat/${chatId}/${id}`
}

export function isThumbnail(a: Pick<Attachment, 'mime'>): boolean {
  return THUMB_TYPES.includes(a.mime)
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function pastedName(now: Date, mime: string): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `pasted-${date}-${time}.${EXT[mime] ?? 'png'}`
}

export const stageErrors = {
  tooBig: (name: string): string => `${name} is over 25 MB`,
  folder: (name: string): string => `${name} is a folder. Folders can't be attached.`,
  unreadable: (name: string): string => `${name} couldn't be read`,
  TOO_MANY: 'You can attach up to 10 files per message.',
  GONE: 'An attached file is gone. Attach it again.'
}
