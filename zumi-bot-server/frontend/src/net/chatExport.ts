import { exportUrl, type ExportFormat, type ExportOptions } from '@zumibot/shared/chatExport'

export const EXPORT_MIME: Record<ExportFormat, string> = { md: 'text/markdown;charset=utf-8', html: 'text/html;charset=utf-8' }

/** The page's own zone, so the export's times read as the chat does; null lets the server pick. */
export function pageZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null
  } catch {
    return null
  }
}

/** An export that failed for a reason the dialog shows as is. */
export class ExportError extends Error {}

/** Fixed sentences only: the server's answer never reaches the dialog. */
export function exportError(status: number | null, reply: boolean): string {
  if (status === null) return 'Export failed. Check the connection and try again.'
  if (status === 404) return reply ? 'That reply is no longer in this chat.' : 'This chat no longer exists.'
  if (status === 401) return 'Signed out. Sign in again to export.'
  return 'Export failed. Try again.'
}

/** The export's text, read whole from the server: its stored items, not only the pages loaded here. */
export async function fetchExport(chatId: string, o: ExportOptions): Promise<string> {
  let res: Response
  try {
    res = await fetch(exportUrl(chatId, o), { credentials: 'same-origin', cache: 'no-store' })
  } catch {
    throw new ExportError(exportError(null, o.item !== null))
  }
  if (!res.ok) throw new ExportError(exportError(res.status, o.item !== null))
  return res.text()
}

/** Saves text as a file the browser (or the shell's save dialog) names. */
export function saveText(name: string, text: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  // Revoked after the click is handled: some browsers start the download after this call returns.
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/**
 * Copies text that is still on its way. The clipboard item takes the pending text so Safari keeps the click's
 * permission across the fetch; where that is missing or refused, the text is written once it arrives.
 */
export async function copyPending(text: Promise<string>): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function') {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': text.then((t) => new Blob([t], { type: 'text/plain' })) })])
      return
    } catch {
      // The fetch's own error is thrown by the await below; anything else falls back to writeText.
    }
  }
  await navigator.clipboard.writeText(await text)
}
