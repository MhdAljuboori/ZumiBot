import { popoutPath } from '@zumibot/shared/popout'
import type { Attachment } from '@zumibot/shared/types'

// Chat popouts: which click on a chat row opens it in a window of its own, and the header color the desktop shell
// paints its window buttons on.

/** Ctrl+click (Cmd+click on a Mac) or a middle click: the browser's own "elsewhere" gestures. Right click keeps the menu. */
export const popoutClick = (e: { button: number; ctrlKey: boolean; metaKey: boolean }): boolean =>
  e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey))

const hex2 = (n: number): string => n.toString(16).padStart(2, '0')

/** A computed CSS color as `#rrggbb`; null for a see-through or unreadable one (the shell keeps its last colors). */
export function cssColorToHex(css: string): string | null {
  const v = css.trim().toLowerCase()
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v)
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`
  if (/^#[0-9a-f]{6}$/.test(v)) return v
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v)
  if (!m) return null
  const [r, g, b] = [m[1], m[2], m[3]].map(Number) as [number, number, number]
  if (m[4] !== undefined && Number(m[4]) < 1) return null
  if ([r, g, b].some((c) => c > 255)) return null
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`
}

type WindowLike = { location: { href: string }; focus(): void }

/**
 * A browser popup for the chat: `popup` asks for a window, not a tab, and the name makes a second open of the same chat
 * find that window. It is opened blank first and given the address only when new, since `window.open(url, name)` would
 * reload a popup already showing the chat and lose its unsent draft and scroll. False when the browser blocked it.
 */
export function openPopoutWindow(open: (url: string, name: string, features: string) => WindowLike | null, chatId: string): boolean {
  const w = open('', `zumibot-chat-${chatId}`, 'popup,width=900,height=700')
  if (!w) return false
  if (w.location.href === 'about:blank') w.location.href = popoutPath(chatId)
  w.focus()
  return true
}

// A fork's editable draft, handed from a popout to the page that opens the fork (the main window or a new tab): the
// server returns it once, to the page that forked, and a popout never shows the fork itself.
const FORK_DRAFT_PREFIX = 'zumibot-fork-draft:'
export const forkDraftKey = (chatId: string): string => FORK_DRAFT_PREFIX + chatId

export function parseForkDraft(raw: string | null): { text: string; attachments: Attachment[] } | null {
  if (raw === null) return null
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  const d = v as { text?: unknown; attachments?: unknown } | null
  if (!d || typeof d.text !== 'string' || !Array.isArray(d.attachments)) return null
  const ok = d.attachments.every((a: unknown) => {
    const x = a as Partial<Record<keyof Attachment, unknown>> | null
    return (
      !!x &&
      typeof x.id === 'string' &&
      typeof x.name === 'string' &&
      typeof x.mime === 'string' &&
      typeof x.size === 'number' &&
      (x.kind === 'image' || x.kind === 'file')
    )
  })
  return ok ? { text: d.text, attachments: d.attachments as Attachment[] } : null
}

/** A popout (its chat id) shows that chat only; any other opens outside it. The main page (null) opens any. */
export const staysInPopout = (popoutChatId: string | null, chatId: string): boolean => popoutChatId === null || popoutChatId === chatId
