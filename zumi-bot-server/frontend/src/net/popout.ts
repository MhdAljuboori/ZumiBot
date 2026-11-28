import type { DesktopBridge } from '@zumibot/shared/desktop'
import { popoutChatFrom, type PopoutBridge } from '@zumibot/shared/popout'
import { openPopoutWindow } from '../state/popout'

/** The chat this page was opened for as a popout (`/chat/<id>?popout=1`), read once at load; null in any other page. */
export const popoutChatId: string | null = popoutChatFrom(location.pathname, location.search)

/** The shell's popout bridge: only a popout window on its own page has it (a browser popup has none). */
export const popoutBridge: PopoutBridge | null =
  popoutChatId === null ? null : ((window as unknown as { zumibotPopout?: PopoutBridge }).zumibotPopout ?? null)

/**
 * Opens the chat in a window of its own. False when nothing opened, so the caller opens it in place instead: an older
 * desktop shell without popouts (its window-open handler denies a same-origin window), or a browser that blocked it.
 */
export function openChatWindow(chatId: string, desktop: DesktopBridge | null): boolean {
  if (desktop) {
    if (!desktop.openChatWindow) return false
    desktop.openChatWindow(chatId)
    return true
  }
  return openPopoutWindow((url, name, features) => window.open(url, name, features), chatId)
}
