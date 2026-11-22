import type { BrowserTarget } from '@zumibot/shared/browser'
import type { DesktopTarget } from '@zumibot/shared/desktop'
import { engineCaps, engineOfAgent, type Engine, type EngineCaps } from '@zumibot/shared/engine'
import type { AgentSummary, ChatItem } from '@zumibot/shared/types'

/** What the right side panel holds: its launcher list, Files, git Changes, side questions, to-dos, dispatched agents, background processes, the browser or the desktop; null when closed. */
export type SideView = 'menu' | 'files' | 'changes' | 'btw' | 'todos' | 'dispatch' | 'processes' | 'browser' | 'desktop'
/** The views that keep running behind a chat view; only one is open at a time. */
export type LiveView = 'browser' | 'desktop'
export type SideState = SideView | null

/** The views that belong to the chat on screen, over a live view that may wait behind them. */
const chatViews: readonly SideState[] = ['menu', 'files', 'changes', 'btw', 'todos', 'dispatch', 'processes']

/** A chat view the panel draws over the chat on screen (not a live view): Esc closes it. */
export const isChatView = (side: SideState): boolean => chatViews.includes(side)

/** Which side question the Side questions view scrolls to; `n` makes a repeat of the same entry a new request. */
export interface SideFocus {
  chatId: string
  id: string
  n: number
}

/**
 * Opening a chat's Side questions view on an entry (null: unfocused). The view slot is shared by every chat, so
 * an ask card can open another chat and set this in the same step.
 */
export function sideFocusAfter(prev: SideFocus | null, chatId: string, entryId: string | null): SideFocus | null {
  return entryId === null ? null : { chatId, id: entryId, n: (prev?.n ?? 0) + 1 }
}

/** The panel icon above the chat: opens on the list, closes whatever shows. */
export function toggleSide(side: SideState): SideState {
  return side === null ? 'menu' : null
}

/** The git chip: opens the chat's Changes, or closes them when they show (a live view behind comes back, as with ✕). */
export function toggleChanges(shown: SideView | null, live: LiveView | null): SideState {
  return shown === 'changes' ? live : 'changes'
}

/** ✕ or Esc on a chat view. A live view left open behind it comes back, as it did when Files covered it. */
export function closeSide(side: SideState, live: LiveView | null): SideState {
  return chatViews.includes(side) ? live : null
}

/**
 * The browser or desktop opening or closing. Opening in the panel (Launch, Agent Studio, the list) takes the slot; a
 * handoff card shows it inline instead, so the panel stays as it is. The view the panel showed closing closes the panel;
 * one hidden behind a chat view closing leaves that view.
 */
export function liveMoved(side: SideState, kind: LiveView, wasOpen: boolean, open: boolean, inPanel: boolean): SideState {
  if (open && !wasOpen) return inPanel ? kind : side
  if (!open && wasOpen && side === kind) return null
  return side
}
export function browserMoved(side: SideState, wasOpen: boolean, open: boolean, inPanel: boolean): SideState {
  return liveMoved(side, 'browser', wasOpen, open, inPanel)
}

/**
 * The live view open in the panel. Opening one closes the other, so both are open only for a render; the one the slot
 * names wins then, so the panel does not blink empty.
 */
export function panelLive(side: SideState, browser: boolean, desktop: boolean): LiveView | null {
  if (side === 'desktop' && desktop) return 'desktop'
  if (side === 'browser' && browser) return 'browser'
  return browser ? 'browser' : desktop ? 'desktop' : null
}

/** A handoff card still waiting on this request shows its live view inline. Browser and desktop cards share the item type. */
export function pendingHandoff(items: readonly ChatItem[], requestId: string | undefined, surface: LiveView): boolean {
  return (
    requestId !== undefined &&
    items.some(
      (i) =>
        i.type === 'browser-action' && i.handoff.id === requestId && i.handoff.status === 'pending' && (i.surface ?? 'browser') === surface
    )
  )
}

/** What the slot draws: the chat views belong to the chat on screen; a live view shows on any view while it is in the panel. */
export function shownSide(side: SideState, onChat: boolean, liveInPanel: LiveView | null): SideView | null {
  if (side === 'browser' || side === 'desktop') return liveInPanel === side ? side : null
  return side !== null && onChat ? side : null
}

/** The list's Open Browser on the browser already open for that agent here: show it again rather than restart the view. */
export function isOpenBrowser(open: boolean, target: BrowserTarget | null | undefined, agent: string, chatId: string): boolean {
  return open && !!target && target.requestId === undefined && target.agent === agent && target.chatId === chatId
}

/** The list's Open Desktop on the desktop already open for that agent here: show it again rather than restart the view. */
export function isOpenDesktop(open: boolean, target: DesktopTarget | null | undefined, agent: string, chatId: string): boolean {
  return open && !!target && target.requestId === undefined && target.agent === agent && target.chatId === chatId
}

/** An agent that loads and has computer use on, on an engine that has a desktop (a Codex room member has none while that cap is off). */
export function hasComputerUse(name: string, agents: readonly AgentSummary[], caps: (e: Engine) => EngineCaps = engineCaps): boolean {
  return agents.some((a) => a.name === name && a.error === null && a.computerUse === true && caps(engineOfAgent(a)).desktop)
}
/** The list's Desktop row is for chats where some member (a single chat: its agent) has computer use. */
export function desktopRowShown(
  members: readonly string[],
  agents: readonly AgentSummary[],
  caps: (e: Engine) => EngineCaps = engineCaps
): boolean {
  return members.some((name) => hasComputerUse(name, agents, caps))
}
