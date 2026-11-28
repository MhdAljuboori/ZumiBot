// A chat popped out into its own window: the chat's own address with a flag, read by the page and the desktop shell
// alike, so both agree on what a popout is.
import { CHAT_PREFIX, chatIdFromPath } from './appPaths'

export const POPOUT_PARAM = 'popout'

export const popoutPath = (chatId: string): string => `${CHAT_PREFIX}${encodeURIComponent(chatId)}?${POPOUT_PARAM}=1`

/** The chat a popout address shows, or null when the address is not a popout's. */
export function popoutChatFrom(pathname: string, search: string): string | null {
  if (new URLSearchParams(search).get(POPOUT_PARAM) !== '1') return null
  return chatIdFromPath(pathname)
}

const MAX_CHAT_ID = 200

/** A chat id as page input may carry it to the shell: a bounded string with no control characters. */
export function cleanChatId(v: unknown): string | null {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_CHAT_ID && !/[\u0000-\u001f\u007f]/.test(v) ? v : null
}

/** A `#rrggbb` color (the popout's title bar), lower-cased; anything else is null. */
export function cleanHexColor(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null
}

/** What the shell gives a popout window's page (never `zumibotDesktop`: a popout is no notification device or quit flow). */
export interface PopoutBridge {
  /** The chat this window was opened for. */
  chatId: string
  /** Keeps the window above others (or not); resolves to the state the window ended in. */
  pin(on: boolean): Promise<boolean>
  /** Brings the main window forward, showing this app path (`safeOpenPath`) when one is given. */
  openMain(path: string | null): void
  openAttachment(url: string, name: string): Promise<boolean>
  /** The colors the shell draws its window buttons in, so they match the page's header. */
  setTitleBarColors(background: string, symbols: string): void
}
