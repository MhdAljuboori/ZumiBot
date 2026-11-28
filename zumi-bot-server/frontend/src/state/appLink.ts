// A link in rendered Markdown that names one of the app's own pages opens in the app, not a new tab (the desktop shell
// denies a same-origin new window, so a new tab does nothing there). The route parsers are the only rule for "ours".
import type { IslandOpenTarget } from '@zumibot/shared/island'
import {
  archivedFromPath,
  chatIdFromPath,
  inboxFromPath,
  routinesFromPath,
  settingsFromPath,
  todosFromPath,
  workflowsFromPath
} from './route'

/**
 * The in-app address (path + query + hash) a link points at, or null when it is not one: another origin, a
 * protocol-relative URL, a non-http(s) scheme, or a same-origin path no route parser accepts (`/api/…`, `/hooks/…`).
 */
export function appPath(href: string | undefined, origin: string): string | null {
  if (!href) return null
  let url: URL
  try {
    url = new URL(href, origin)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (url.origin !== new URL(origin).origin) return null
  const p = url.pathname
  const routed =
    chatIdFromPath(p) !== null ||
    routinesFromPath(p) !== null ||
    workflowsFromPath(p) !== null ||
    inboxFromPath(p) !== null ||
    todosFromPath(p) !== null ||
    archivedFromPath(p) !== null ||
    // "/settings" and any "/settings/<unknown>" are taken on purpose: settingsFromPath reads both as General, which is
    // what an old or short link wants.
    settingsFromPath(p) !== null
  return routed ? p + url.search + url.hash : null
}

/** A left click with no modifier: the only one the app takes over; the rest keep the browser's own (new tab, menu). */
export const plainClick = (e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): boolean =>
  e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey

/**
 * What the island does with an in-app link: it never moves its own address, so the main window comes forward instead,
 * on the chat when the link is a chat path, else just forward (the shell has no routes to open).
 */
export function islandLinkTarget(path: string): IslandOpenTarget {
  let pathname = path
  try {
    pathname = new URL(path, 'http://x').pathname
  } catch {
    // keep the raw path: it matches no chat
  }
  return { chatId: chatIdFromPath(pathname), live: null }
}

/**
 * What a click on an in-app link does: a context that opens links elsewhere (the island, a popout) takes every click; a
 * modified click is the browser's (a new tab); the page already shown has nothing to open; anything else moves the app.
 */
export function appLinkClick(
  e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean },
  path: string,
  here: string,
  openApp: ((path: string) => void) | null
): 'context' | 'browser' | 'same' | 'push' {
  if (openApp) return 'context'
  if (!plainClick(e)) return 'browser'
  return path === here ? 'same' : 'push'
}

/** The in-app path another window (a popout) asks this page to show, or null when it is not one or already shown. */
export function pathToOpen(path: string, origin: string, here: string): string | null {
  const p = appPath(path, origin)
  return p === null || p === here ? null : p
}
