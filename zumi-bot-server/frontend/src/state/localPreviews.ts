import { isThumbnail } from '@zumibot/shared/attachments'
import type { Attachment } from '@zumibot/shared/types'

// Picked images by attachment id, for this page's life: a sent message shows them from memory, with no wait while
// the server files them and no reload once it has.
const previews = new Map<string, string>()

export function rememberPreview(a: Attachment, file: Blob): void {
  if (isThumbnail(a) && !previews.has(a.id)) previews.set(a.id, URL.createObjectURL(file))
}

export const previewUrl = (id: string): string | undefined => previews.get(id)

export function forgetPreview(id: string): void {
  const url = previews.get(id)
  if (url === undefined) return
  URL.revokeObjectURL(url)
  previews.delete(id)
}
