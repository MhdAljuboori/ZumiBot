import { desktopPoint, desktopToolName, type DesktopStatus, type DesktopTarget } from '@zumibot/shared/desktop'
import type { ChatItem } from '@zumibot/shared/types'

export interface DesktopViewState {
  open: boolean
  visible: boolean
  target: DesktopTarget | null
  status: DesktopStatus | null
  control: boolean
  controlPending: boolean
  /** The viewer's connection leg; the panel remounts noVNC when `n` changes. */
  rfb: { generation: string; n: number } | null
  /** Where "Show on desktop" points, in desktop pixels; gone once the user takes control. */
  marker: { x: number; y: number } | null
  error: string | null
}
export const initialDesktopView: DesktopViewState = {
  open: false,
  visible: true,
  target: null,
  status: null,
  control: false,
  controlPending: false,
  rfb: null,
  marker: null,
  error: null
}

export type DesktopViewEvent =
  | { type: 'open'; target: DesktopTarget; marker?: { x: number; y: number } | null }
  | { type: 'close' | 'disconnect' | 'controlRequested' | 'controlReleased' }
  | { type: 'visible'; visible: boolean }
  | { type: 'status'; status: DesktopStatus }
  | { type: 'rfb'; state: 'open' | 'closed'; generation: string }
  | { type: 'error'; error: string }

/** Set by `disconnect` so the status line can tell a lost socket from a desktop that is still starting. */
export const DESKTOP_DISCONNECTED = 'disconnected'

const dropControl = (s: DesktopViewState): DesktopViewState => ({ ...s, control: false, controlPending: false })

export function reduceDesktopView(s: DesktopViewState, e: DesktopViewEvent): DesktopViewState {
  switch (e.type) {
    // Control is never carried to a new target; the user asks again.
    case 'open':
      return { ...initialDesktopView, open: true, visible: s.visible, target: e.target, marker: e.marker ?? null }
    case 'close':
      return { ...initialDesktopView, visible: s.visible }
    // Hidden pages stop sending input, so control ends; the status stays for when the page is seen again.
    case 'visible':
      return { ...(e.visible ? s : dropControl(s)), visible: e.visible }
    case 'disconnect':
      return { ...dropControl(s), status: null, rfb: null, error: DESKTOP_DISCONNECTED }
    case 'controlRequested':
      return { ...s, controlPending: true, control: false, marker: null, error: null }
    case 'controlReleased':
      return dropControl(s)
    case 'error':
      return { ...dropControl(s), error: e.error }
    // `n` grows on every open so each leg gets a fresh noVNC. A leg closes when its watch was replaced or ended (by this
    // client, a re-watch or the desktop stopping), and the server releases a replaced viewer's control: so does the switch.
    case 'rfb':
      return e.state === 'open' ? { ...s, rfb: { generation: e.generation, n: (s.rfb?.n ?? 0) + 1 } } : { ...dropControl(s), rfb: null }
    case 'status': {
      const holding = s.control || s.controlPending
      const newDesktop = s.status !== null && s.status.generation !== e.status.generation
      // A new desktop means the old input is meaningless; another window's control or a lost one ends ours.
      const lost = holding && (newDesktop || e.status.control === 'other' || (s.control && e.status.control !== 'you'))
      let next = lost ? dropControl(s) : s
      if (!lost && s.controlPending && e.status.state === 'ready' && e.status.control === 'you')
        next = { ...s, control: true, controlPending: false }
      else if (!lost && s.controlPending && e.status.state !== 'ready' && e.status.state !== 'starting') next = dropControl(s)
      return { ...next, status: e.status, error: e.status.error }
    }
  }
}

/** `approvalPending`: a desktop action of this agent waits on an approval card in the chat on screen. */
export function desktopStatusLine(s: DesktopViewState, approvalPending = false): string {
  const st = s.status
  if (st === null) return s.error === DESKTOP_DISCONNECTED ? 'Disconnected' : 'Starting…'
  switch (st.state) {
    case 'off':
      return 'Computer use is off for this agent'
    case 'unavailable':
      return `Desktop unavailable on this server${st.missing?.length ? ` (missing: ${st.missing.join(', ')})` : ''}`
    case 'queued':
    case 'closing':
      return 'Waiting for a desktop…'
    case 'stopped':
      return approvalPending ? 'Waiting for approval' : 'Idle'
    case 'starting':
      return 'Starting…'
    case 'ready':
      if (st.control === 'other') return 'Controlled in another window'
      if (st.control === 'pausing' || (s.controlPending && st.control !== 'you')) return 'Pausing agent…'
      // A 'you' this window did not ask for (or already let go of) is being released by the hook, not held.
      if (s.control) return 'You have control'
      // No agent call runs while a handoff waits (busy is false then), so the handoff comes first.
      if (st.pendingRequestId !== null) return 'Waiting for you'
      // An earlier call may still hold the lease (busy), but nothing moves until the user answers the card.
      if (approvalPending) return 'Waiting for approval'
      return st.busy ? 'Agent working' : 'Idle'
  }
}

/**
 * The server counts this window as the controller while the window holds no control and asked for none: a release the
 * server had not seen yet, a page that hid mid-request, or a watch that was replaced. Releasing again is always safe.
 */
export function mustRelease(s: DesktopViewState, status: DesktopStatus): boolean {
  return status.control === 'you' && !s.control && !s.controlPending
}

/**
 * The Take control switch. Off until the desktop is ready, while another window holds or is taking control ('other')
 * and while this window's own release drains ('pausing'); on for this window's own control or request, so either can be
 * let go.
 */
export function takeControlEnabled(s: DesktopViewState): boolean {
  const st = s.status
  if (st?.state !== 'ready') return false
  if (s.control || s.controlPending) return true
  return st.control !== 'other' && st.control !== 'pausing'
}

const DESKTOP_TOOL = desktopToolName('')
/**
 * A desktop call of this agent waits on its approval card. Room items carry their member; a single chat's items carry no
 * agent, so `chatAgent` (the single chat's agent) signs them.
 */
export function desktopApprovalPending(items: readonly ChatItem[], agent: string, chatAgent?: string): boolean {
  return items.some(
    (i) => i.type === 'approval' && i.status === 'pending' && i.toolName.startsWith(DESKTOP_TOOL) && (i.agent ?? chatAgent) === agent
  )
}

/**
 * What a pending approval card offers for the desktop: Show on desktop marks a pointer action's point; every other
 * desktop call (typing, keys, a launch) gets Open Desktop, which only watches, so the user can see where it lands.
 */
export function desktopCardOffer(toolName: string, input: unknown): { point: { x: number; y: number } | null } | null {
  return toolName.startsWith(DESKTOP_TOOL) ? { point: desktopPoint(toolName, input) } : null
}

export const PASTE_TOO_LARGE = 'Paste too large'
/** Xvnc runs without -MaxCutText, and TigerVNC drops a cut text past its 256 KiB default silently; the margin is for framing. */
export const PASTE_MAX = 256 * 1024 - 1024
/**
 * A paste into the desktop: plain text only, refused whole past `max` UTF-8 bytes (a cut paste would type something the
 * user did not copy). Null when there is nothing to send.
 */
export function pasteText(
  clipboardData: { getData(type: string): string } | null,
  max: number
): { text: string } | { error: string } | null {
  const text = clipboardData?.getData('text/plain') ?? ''
  if (!text) return null
  // UTF-8 never takes fewer bytes than UTF-16 units, so an over-long text is refused without encoding it.
  return text.length > max || new TextEncoder().encode(text).length > max ? { error: PASTE_TOO_LARGE } : { text }
}

/** The marker in the viewer's box, letterboxed like the picture (scale to fit, centered); null when it is off the desktop. */
export function markerPosition(
  marker: { x: number; y: number },
  desktop: { width: number; height: number },
  box: { width: number; height: number }
): { left: number; top: number } | null {
  if (!(desktop.width > 0) || !(desktop.height > 0) || !(box.width > 0) || !(box.height > 0)) return null
  if (!(marker.x >= 0 && marker.x < desktop.width && marker.y >= 0 && marker.y < desktop.height)) return null
  const scale = Math.min(box.width / desktop.width, box.height / desktop.height)
  return {
    left: (box.width - desktop.width * scale) / 2 + marker.x * scale,
    top: (box.height - desktop.height * scale) / 2 + marker.y * scale
  }
}
