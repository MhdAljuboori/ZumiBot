import type { IslandOpenTarget, IslandSettingsBridge } from './island'
import type { NotifyPayloadKind } from './notify'
import type { ServerMode, ThemePref } from './types'
import { visibleText } from './visibleText'

/** What the shell shows: the text is built by the page, so the shell needs no payload rules of its own. */
export interface DesktopNotification {
  tag: string
  chatId: string | null
  kind: NotifyPayloadKind
  title: string
  body: string
  /** An app path a click opens (a Notify step's Inbox message); the shell keeps it only when `safeOpenPath` accepts it. */
  open?: string
}

// An app-relative path the page navigates to itself: no scheme, host, query, space or backslash, bounded. Page input
// reaches the shell's main process, so both sides check it.
const OPEN_PATH = /^\/[A-Za-z0-9/_\-.%]{0,511}$/
export function safeOpenPath(v: unknown): string | null {
  return typeof v === 'string' && OPEN_PATH.test(v) && !v.startsWith('//') ? v : null
}

/** What a notification click hands the page: the chat it belongs to and the app path it opens, either may be null. */
export interface DesktopNotificationTarget {
  chatId: string | null
  open: string | null
}

export interface DesktopBridge {
  mode: ServerMode
  switchServer(): void
  /** Optional while a newer server UI is used with an older installed desktop app. */
  sync?(): void
  setEditorDirty(dirty: boolean): void
  onSaveBeforeClose(cb: () => Promise<boolean>): () => void
  setTheme(t: ThemePref): void
  openAttachment(url: string, name: string): Promise<boolean>
  /** Optional like sync: a shell without them gets no desktop notifications. Shows, or replaces by tag. */
  notify?(n: DesktopNotification): void
  closeNotifications?(chatId: string, waitingOnly: boolean): void
  /** Closes one notification by its tag (a workflow run's, which has no chat); older shells lack it. */
  closeNotificationTag?(tag: string): void
  onNotificationClick?(cb: (chatId: string | null) => void): () => void
  /** Optional like the rest: older shells lack it, and a page then keeps `onNotificationClick`. */
  onNotificationOpen?(cb: (t: DesktopNotificationTarget) => void): () => void
  /** Optional like sync: the island's Settings controls, absent in shells without the island. */
  island?: IslandSettingsBridge
  /** Optional like the rest: the island asks the main window to open a chat and, maybe, a live view. */
  onIslandOpen?(cb: (t: IslandOpenTarget) => void): () => void
  /** Optional like the rest: opens the chat in a popout window of its own (an older shell lacks it). */
  openChatWindow?(chatId: string): void
  /** Optional like the rest: a popout asks the main window to show an app path (another chat, Settings, a run). */
  onOpenPath?(cb: (path: string) => void): () => void
}

// Computer use: the contract between the backend's DesktopManager, the MCP bridge and the viewer.
// It shares this file with the Electron bridge above because both are imported as `@zumibot/shared/desktop`.

export type DesktopTarget = { agent: string; chatId?: string; requestId?: string }
export type DesktopOwner = { profileId: string; chatId: string; turnId: string }
export type DesktopStamp = { generation: string; epoch: number; observationId: string }
export type DesktopModifier = 'ctrl' | 'alt' | 'shift' | 'super'
export type DesktopCommand =
  | { op: 'screenshot' | 'windows' | 'apps' | 'release' }
  | { op: 'windowState'; windowId: number }
  | { op: 'zoom'; windowId: number; x1: number; y1: number; x2: number; y2: number }
  | {
      op: 'click'
      stamp: DesktopStamp
      x?: number
      y?: number
      element?: string
      button?: 'left' | 'right' | 'middle'
      count?: 1 | 2
      modifiers?: DesktopModifier[]
    }
  | { op: 'drag'; stamp: DesktopStamp; fromX: number; fromY: number; toX: number; toY: number }
  | { op: 'scroll'; stamp: DesktopStamp; x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; amount?: number }
  | { op: 'move'; stamp: DesktopStamp; x: number; y: number }
  | { op: 'type'; stamp: DesktopStamp; text: string; element?: string }
  | { op: 'key'; stamp: DesktopStamp; keys: string[] }
  | { op: 'launch'; stamp: DesktopStamp; name: string }
  | { op: 'focus'; stamp: DesktopStamp; windowId: number }
  | { op: 'requestUserAction'; reason: string }
export type DesktopResult = { ok: true; data: unknown } | { ok: false; code: string; message: string }
export interface DesktopStatus {
  agent: string
  profileId: string
  generation: string
  state: 'off' | 'stopped' | 'queued' | 'starting' | 'ready' | 'closing' | 'unavailable'
  control: 'agent' | 'pausing' | 'you' | 'other'
  pendingRequestId: string | null
  error: string | null
  width: number
  height: number
  /** An agent turn holds the desktop or waits for it: 'Agent working' rather than 'Idle'. */
  busy: boolean
  /** Names of host programs that are not installed, so the UI can say what to install. */
  missing?: string[]
}
export type DesktopHandoff = import('./browser').BrowserHandoff
export interface DesktopConfig {
  max: number
  idleMs: number
  leaseIdleMs: number
  handoffIdleMs: number
  commandMs: number
  queueMs: number
  width: number
  height: number
}
export type DesktopRequest = { id: number } & (
  | { op: 'watch'; target: DesktopTarget }
  | { op: 'unwatch' }
  | { op: 'takeControl' }
  | { op: 'releaseControl' }
  | { op: 'answer'; target: DesktopTarget; requestId: string; decision: 'done' | 'cancel' }
)
export type DesktopServerMessage =
  | { type: 'response'; id: number; ok: true; value: unknown }
  | { type: 'response'; id: number; ok: false; error: string }
  // `watchId` is the id of the `watch` request that made the viewer: a message for any other watch is stale.
  | { type: 'status'; watchId: number; status: DesktopStatus }
  | { type: 'rfb'; watchId: number; state: 'open' | 'closed'; generation: string }

export const DESKTOP_SERVER = 'zumibot_desktop'
/** These always get an approval card, even in auto mode. */
export const DESKTOP_ACTION_TOOLS: readonly string[] = [
  'desktop_click',
  'desktop_drag',
  'desktop_scroll',
  'desktop_move',
  'desktop_type',
  'desktop_key',
  'desktop_launch',
  'desktop_focus'
]
export const DESKTOP_LOOK_TOOLS: readonly string[] = [
  'desktop_screenshot',
  'desktop_windows',
  'desktop_apps',
  'desktop_window_state',
  'desktop_zoom'
]
export const desktopToolName = (name: string): string => `mcp__${DESKTOP_SERVER}__${name}`

// The largest desktop the server will start (1920x1080), so no coordinate can fall outside it.
const DESKTOP_MAX = { x: 1920, y: 1080 }

function invalid(): never {
  throw new Error('Invalid desktop message')
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function fields(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid()
}
function string(value: unknown, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.length) || value.includes('\0')) invalid()
}
function id(value: unknown): asserts value is string {
  string(value, 128)
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) invalid()
}
function coord(value: unknown, axis: 'x' | 'y'): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= DESKTOP_MAX[axis]) invalid()
}
function stamp(value: unknown): void {
  const s = object(value)
  fields(s, ['generation', 'epoch', 'observationId'])
  id(s.generation)
  id(s.observationId)
  if (!Number.isSafeInteger(s.epoch) || (s.epoch as number) < 0) invalid()
}
/** Window ids are the integers cua-driver reports (X11 ids), as `desktop_windows` lists them. */
function windowId(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid()
}
function requestId(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid()
}
function target(value: unknown): void {
  const t = object(value)
  fields(t, ['agent', 'chatId', 'requestId'])
  string(t.agent, 128)
  if (t.chatId !== undefined) id(t.chatId)
  if (t.requestId !== undefined) id(t.requestId)
}

/** Validate the whole boundary, extra fields included, before anything reaches the desktop. */
export function parseDesktopCommand(value: unknown): DesktopCommand {
  const c = object(value)
  let allowed: string[] = []
  switch (c.op) {
    case 'screenshot':
    case 'windows':
    case 'apps':
    case 'release':
      break
    case 'windowState':
      windowId(c.windowId)
      allowed = ['windowId']
      break
    case 'zoom':
      windowId(c.windowId)
      coord(c.x1, 'x')
      coord(c.x2, 'x')
      coord(c.y1, 'y')
      coord(c.y2, 'y')
      allowed = ['windowId', 'x1', 'y1', 'x2', 'y2']
      // An empty or inverted region has nothing to crop.
      if ((c.x1 as number) >= (c.x2 as number) || (c.y1 as number) >= (c.y2 as number)) invalid()
      break
    case 'click': {
      stamp(c.stamp)
      allowed = ['stamp', 'x', 'y', 'element', 'button', 'count', 'modifiers']
      const point = c.x !== undefined || c.y !== undefined
      // A point and an element would let two different targets disagree about where the click lands.
      if (point === (c.element !== undefined)) invalid()
      if (point) {
        coord(c.x, 'x')
        coord(c.y, 'y')
      } else id(c.element)
      if (c.button !== undefined && !['left', 'right', 'middle'].includes(c.button as string)) invalid()
      if (c.count !== undefined && c.count !== 1 && c.count !== 2) invalid()
      if (c.modifiers !== undefined) {
        const m = c.modifiers
        if (
          !Array.isArray(m) ||
          m.length > 4 ||
          new Set(m).size !== m.length ||
          m.some((x) => !['ctrl', 'alt', 'shift', 'super'].includes(x))
        )
          invalid()
      }
      break
    }
    case 'drag':
      stamp(c.stamp)
      coord(c.fromX, 'x')
      coord(c.toX, 'x')
      coord(c.fromY, 'y')
      coord(c.toY, 'y')
      allowed = ['stamp', 'fromX', 'fromY', 'toX', 'toY']
      break
    case 'scroll':
      stamp(c.stamp)
      coord(c.x, 'x')
      coord(c.y, 'y')
      allowed = ['stamp', 'x', 'y', 'direction', 'amount']
      if (!['up', 'down', 'left', 'right'].includes(c.direction as string)) invalid()
      if (c.amount !== undefined && (!Number.isInteger(c.amount) || (c.amount as number) < 1 || (c.amount as number) > 20)) invalid()
      break
    case 'move':
      stamp(c.stamp)
      coord(c.x, 'x')
      coord(c.y, 'y')
      allowed = ['stamp', 'x', 'y']
      break
    case 'type':
      stamp(c.stamp)
      string(c.text, 16384, true)
      allowed = ['stamp', 'text', 'element']
      if (c.element !== undefined) id(c.element)
      break
    case 'key':
      stamp(c.stamp)
      allowed = ['stamp', 'keys']
      if (!Array.isArray(c.keys) || !c.keys.length || c.keys.length > 5) invalid()
      c.keys.forEach((k) => string(k, 32))
      break
    case 'launch':
      stamp(c.stamp)
      string(c.name, 256)
      allowed = ['stamp', 'name']
      break
    case 'focus':
      stamp(c.stamp)
      windowId(c.windowId)
      allowed = ['stamp', 'windowId']
      break
    case 'requestUserAction':
      string(c.reason, 500)
      allowed = ['reason']
      break
    default:
      return invalid()
  }
  fields(c, ['op', ...allowed])
  return c as DesktopCommand
}

export function parseDesktopRequest(value: unknown): DesktopRequest {
  const c = object(value)
  requestId(c.id)
  let allowed: string[] = []
  switch (c.op) {
    case 'watch':
      target(c.target)
      allowed = ['target']
      break
    case 'unwatch':
    case 'takeControl':
    case 'releaseControl':
      break
    case 'answer':
      target(c.target)
      id(c.requestId)
      if (c.decision !== 'done' && c.decision !== 'cancel') invalid()
      allowed = ['target', 'requestId', 'decision']
      break
    default:
      return invalid()
  }
  fields(c, ['id', 'op', ...allowed])
  return c as DesktopRequest
}

/** The status carries host text (errors, program names), so it is bounded before it is serialized. */
export function boundDesktopStatus(s: DesktopStatus): DesktopStatus {
  const clip = (v: string, max: number) => v.slice(0, max)
  return {
    agent: clip(s.agent, 128),
    profileId: clip(s.profileId, 128),
    generation: clip(s.generation, 128),
    state: s.state,
    control: s.control,
    pendingRequestId: s.pendingRequestId === null ? null : clip(s.pendingRequestId, 128),
    error: s.error === null ? null : clip(s.error, 512),
    width: s.width,
    height: s.height,
    busy: s.busy,
    ...(s.missing ? { missing: s.missing.slice(0, 10).map((m) => clip(m, 64)) } : {})
  }
}

const PREFIX = desktopToolName('')
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown): v is string => typeof v === 'string'
const upper = (k: string) => k.charAt(0).toUpperCase() + k.slice(1)
// Agent-supplied text goes into the approval card line, so every interpolated string is cut like typed text.
const clip = (v: string) => (v.length > 200 ? `${v.slice(0, 200)}…` : v)
// The line is a button, where HTML folds a Return into a space: each Return (a CR may press one too) and tab gets a mark,
// and every other hidden character an escape (`visibleText`), before the cut.
const visible = (v: string) => visibleText(v.replace(/[\r\n]/g, '⏎').replace(/\t/g, '⇥'))
const shown = (v: string) => clip(visible(v))
/** Counted on the whole text, so a Return past the cut is still told. */
const enters = (v: string) => {
  const n = v.match(/[\r\n]/g)?.length ?? 0
  return n ? ` · presses Enter ${n}×` : ''
}

/** One line for the approval card; null for looking tools, other tools and input too odd to describe. */
export function desktopActionSummary(toolName: string, input: unknown): string | null {
  if (!toolName.startsWith(PREFIX) || !input || typeof input !== 'object' || Array.isArray(input)) return null
  const i = input as Record<string, unknown>
  switch (toolName.slice(PREFIX.length)) {
    case 'desktop_click': {
      const extra = [i.count === 2 ? 'double' : '', i.button === 'right' || i.button === 'middle' ? `${i.button} button` : ''].filter(
        Boolean
      )
      const tail = extra.length ? ` (${extra.join(', ')})` : ''
      if (str(i.element)) return `Click element ${shown(i.element)}${tail}`
      return num(i.x) && num(i.y) ? `Click at ${i.x}, ${i.y}${tail}` : null
    }
    case 'desktop_type':
      return str(i.text) ? `Type: ${shown(i.text)}${enters(i.text)}` : null
    case 'desktop_key':
      return Array.isArray(i.keys) && i.keys.length && i.keys.every(str)
        ? `Press ${shown((i.keys as string[]).map(upper).join('+'))}`
        : null
    case 'desktop_launch':
      return str(i.name) ? `Launch ${shown(i.name)}` : null
    case 'desktop_drag':
      return num(i.fromX) && num(i.fromY) && num(i.toX) && num(i.toY) ? `Drag from ${i.fromX}, ${i.fromY} to ${i.toX}, ${i.toY}` : null
    case 'desktop_scroll':
      return str(i.direction) && num(i.x) && num(i.y)
        ? `Scroll ${shown(i.direction)} ${num(i.amount) ? i.amount : 3} at ${i.x}, ${i.y}`
        : null
    case 'desktop_move':
      return num(i.x) && num(i.y) ? `Move pointer to ${i.x}, ${i.y}` : null
    case 'desktop_focus':
      return num(i.windowId) ? `Bring window ${i.windowId} to front` : null
    default:
      return null
  }
}

/** Where "Show on desktop" marks the action; element and typing actions have no known point. */
export function desktopPoint(toolName: string, input: unknown): { x: number; y: number } | null {
  if (!toolName.startsWith(PREFIX) || !input || typeof input !== 'object' || Array.isArray(input)) return null
  const i = input as Record<string, unknown>
  switch (toolName.slice(PREFIX.length)) {
    case 'desktop_click':
    case 'desktop_move':
    case 'desktop_scroll':
      return num(i.x) && num(i.y) ? { x: i.x, y: i.y } : null
    case 'desktop_drag':
      return num(i.fromX) && num(i.fromY) ? { x: i.fromX, y: i.fromY } : null
    default:
      return null
  }
}
