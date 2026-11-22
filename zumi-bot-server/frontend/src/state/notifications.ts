import type { DesktopNotification, DesktopNotificationTarget } from '@zumibot/shared/desktop'
import { notifyText, type DeviceSummary, type NotifyPayload, type NotifyPayloadKind, type NotifyState } from '@zumibot/shared/notify'
import type { PushSupport } from '../net/push'
import { agentsFor } from '../sw/mergePlan'
import { inboxFromPath, inboxPath, workflowsFromPath, workflowsPath } from './route'

// The server drops presence older than this, so the tab must stop claiming it earlier than that.
export const LOOK_IDLE_MS = 180_000
export const INPUT_REPORT_MS = 30_000

const DEVICE_KEY = 'zumibot.deviceId'
// Same shape the server accepts; anything else would be refused and never match a device.
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,64}$/
const LABEL_MAX = 60

export function waitingChats(pendingByChat: Record<string, number>): number {
  return Object.values(pendingByChat).filter((n) => n > 0).length
}

export function badgeTitle(base: string, waiting: number): string {
  return waiting > 0 ? `(${waiting}) ${base}` : base
}

export function showDot(waiting: number): boolean {
  return waiting > 0
}

export function isLooking(s: { visible: boolean; focused: boolean; chatId: string | null; lastInputAt: number; now: number }): boolean {
  return s.visible && s.focused && s.chatId !== null && s.now - s.lastInputAt < LOOK_IDLE_MS
}

export interface SentPresence {
  chatId: string | null
  looking: boolean
  at: number
  inputAt: number
}

export function presenceToSend(
  prev: SentPresence | null,
  next: { chatId: string | null; looking: boolean; lastInputAt: number; now: number }
): boolean {
  if (!prev) return true
  // A change in either always goes out, so a stop is never held back by the input throttle.
  if (prev.chatId !== next.chatId || prev.looking !== next.looking) return true
  return next.looking && next.lastInputAt > prev.inputAt && next.now - prev.at >= INPUT_REPORT_MS
}

export interface PresenceReport {
  chatId: string | null
  looking: boolean
  inputAgoMs: number
  openedAgoMs?: number
}

// The server keeps a chat's last input only from looking reports, and input is reported at most every 30 s. So a
// tab leaving a chat (or ending looking) first tells the old chat its latest input, else a held event the user saw
// would still buzz once released.
// `openedAt` is when this page opened the chat on screen. Only that chat's report carries it: on the flush for the
// old chat it would read as a fresh open and end that chat's mark.
export function presenceReports(
  prev: SentPresence | null,
  next: { chatId: string | null; looking: boolean; lastInputAt: number; now: number; openedAt?: number }
): PresenceReport[] {
  if (!presenceToSend(prev, next)) return []
  const inputAgoMs = Math.max(0, next.now - next.lastInputAt)
  const out: PresenceReport[] = []
  const leaving = prev !== null && prev.looking && prev.chatId !== null && (prev.chatId !== next.chatId || !next.looking)
  if (leaving && next.lastInputAt > prev.inputAt) out.push({ chatId: prev.chatId, looking: true, inputAgoMs })
  const opened = next.openedAt === undefined ? {} : { openedAgoMs: Math.max(0, next.now - next.openedAt) }
  out.push({ chatId: next.chatId, looking: next.looking, inputAgoMs, ...opened })
  return out
}

// The server's counts fill chats the live approvals pushes have not set yet; a push is always newer.
export function seedFrom(pending: Record<string, number>, live: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(pending).filter(([id, n]) => n > 0 && !(id in live)))
}

export function mergePending(seed: Record<string, number>, live: Record<string, number>): Record<string, number> {
  return { ...seed, ...live }
}

export function withoutChats(seed: Record<string, number>, chatIds: readonly string[]): Record<string, number> {
  if (!chatIds.some((id) => id in seed)) return seed
  return Object.fromEntries(Object.entries(seed).filter(([id]) => !chatIds.includes(id)))
}

export type Shell = 'none' | 'old' | 'new'

export interface DeviceState {
  text: string
  canEnable: boolean
  canDisable: boolean
}

export function thisDeviceState(o: {
  shell: Shell
  pushAvailable: boolean
  support: PushSupport
  me: DeviceSummary | undefined
}): DeviceState {
  const canDisable = o.me !== undefined
  // Older shells refuse the HTML5 permission, so the bridge is the only way and there is nothing to enable.
  if (o.shell === 'old') return { text: 'Update the desktop app to get notifications', canEnable: false, canDisable }
  if (o.shell === 'new') return o.me ? { text: 'On', canEnable: false, canDisable } : { text: 'Off', canEnable: true, canDisable }
  if (!o.pushAvailable) return { text: 'Not supported', canEnable: false, canDisable }
  if (o.support === 'denied') return { text: 'Blocked by the browser', canEnable: false, canDisable }
  if (o.support === 'unsupported') return { text: 'Not supported', canEnable: false, canDisable }
  if (o.support === 'ios-needs-install') return { text: 'On iPhone, add ZumiBot to the Home Screen first', canEnable: false, canDisable }
  if (!o.me) return { text: 'Off', canEnable: true, canDisable }
  if (o.me.paused) return { text: 'Paused: signed out', canEnable: true, canDisable }
  // The push service dropped the subscription (404/410); the record and its toggles stay.
  if (!o.me.subscribed) return { text: 'Off: enable it again', canEnable: true, canDisable }
  return { text: 'On', canEnable: false, canDisable }
}

export function deviceRowNote(d: DeviceSummary): string {
  if (d.channel !== 'push') return ''
  if (d.paused) return 'Paused: signed out'
  return d.subscribed ? '' : 'Needs enabling again'
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function lastSeenLabel(at: number, now: number): string {
  const ago = now - at
  if (ago < MIN) return 'just now'
  if (ago < HOUR) return `${Math.floor(ago / MIN)} min ago`
  if (ago < DAY) return `${Math.floor(ago / HOUR)} hr ago`
  const days = Math.floor(ago / DAY)
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

export interface DesktopShown {
  kind: NotifyPayloadKind
  agents: string[]
}

// The shell replaces by tag like the service worker does, so room reply names merge the same way.
export function desktopNotice(
  prev: DesktopShown | undefined,
  p: NotifyPayload
): { shown: DesktopShown; notification: DesktopNotification } {
  const agents = agentsFor(prev, p)
  const { title, body } = notifyText(p, agents)
  const notification: DesktopNotification = { tag: p.tag, chatId: p.chatId, kind: p.kind, title, body }
  // A workflow notification has no chat: a Notify message's click opens it in the Inbox, an approval's or a failed
  // run's opens the run, as the service worker's click does (clickUrl).
  if (p.kind === 'workflow' && p.message !== undefined) notification.open = inboxPath(p.message)
  // A to-do card's question is answered in the Inbox, as the service worker's click opens it.
  else if (p.inbox) notification.open = inboxPath()
  else if (p.run !== undefined) notification.open = workflowsPath(p.run.workflowId, p.run.runId)
  return { shown: { kind: p.kind, agents }, notification }
}

export type NotificationTarget =
  { kind: 'inbox'; messageId: string | null } | { kind: 'run'; workflowId: string; runId: string } | { kind: 'chat'; chatId: string }

/** Where a shell click goes, in the app: an Inbox or workflow run path the app routes to, else the chat, else nowhere. */
export function notificationTarget(t: DesktopNotificationTarget): NotificationTarget | null {
  const inbox = t.open === null ? null : inboxFromPath(t.open)
  if (inbox) return { kind: 'inbox', messageId: inbox.messageId }
  const run = t.open === null ? null : workflowsFromPath(t.open)
  if (run?.workflowId != null && run.runId !== null) return { kind: 'run', workflowId: run.workflowId, runId: run.runId }
  return t.chatId === null ? null : { kind: 'chat', chatId: t.chatId }
}

export function newDeviceId(
  c: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array<ArrayBuffer>) => unknown } | undefined
): string {
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  // randomUUID needs a secure context; the id is not a secret, so any unlikely-to-repeat value will do.
  const bytes = new Uint8Array(16)
  if (typeof c?.getRandomValues === 'function') c.getRandomValues(bytes)
  for (let i = 0; i < bytes.length; i++) bytes[i] ^= Math.floor(Math.random() * 256)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export interface ShownNotification {
  tag: string
  chatId: string | null
  kind: NotifyPayloadKind
  at: number
}

export function staleTags(shown: readonly ShownNotification[], s: NotifyState): string[] {
  const out: string[] = []
  for (const n of shown) {
    if (n.chatId === null || n.kind === 'test' || n.kind === 'paused') continue
    const looked = s.lookedAt[n.chatId] > n.at
    const settled = n.kind === 'waiting' && !(s.pending[n.chatId] > 0)
    if ((looked || settled) && !out.includes(n.tag)) out.push(n.tag)
  }
  return out
}

function browserOf(ua: string): string | null {
  // Order matters: Edge, Chrome and the iOS wrappers all also say Safari (and Edge says Chrome).
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'Edge'
  if (/FxiOS|Firefox\//.test(ua)) return 'Firefox'
  if (/CriOS|Chrome\/|Chromium\//.test(ua)) return 'Chrome'
  if (/Safari\//.test(ua)) return 'Safari'
  return null
}

function osOf(ua: string): string | null {
  // Android and iOS UAs also say Linux and Mac OS X.
  if (/Android/.test(ua)) return 'Android'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/iPad/.test(ua)) return 'iPad'
  if (/CrOS/.test(ua)) return 'ChromeOS'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac'
  if (/Linux|X11/.test(ua)) return 'Linux'
  return null
}

export function deviceLabel(ua: string, desktop: boolean): string {
  if (desktop) return 'ZumiBot desktop'
  const os = osOf(ua)
  const label = `${browserOf(ua) ?? 'Browser'}${os ? ` on ${os}` : ''}`
  return label.slice(0, LABEL_MAX)
}

export function deviceIdFrom(
  storage: { getItem(k: string): string | null; setItem(k: string, v: string): void },
  newId: () => string
): string {
  try {
    const saved = storage.getItem(DEVICE_KEY)
    if (saved !== null && DEVICE_ID_RE.test(saved)) return saved
  } catch {
    // Blocked storage: this tab just gets an id that lasts until reload.
  }
  const id = newId()
  try {
    storage.setItem(DEVICE_KEY, id)
  } catch {
    // Same: still usable for this session.
  }
  return id
}

/** Runs `fn` on the first call and not again, unless a run failed: then the next call retries. A run in flight blocks a second one. */
export function onceUntilFailure(fn: () => Promise<void>): () => void {
  let started = false
  return () => {
    if (started) return
    started = true
    fn().catch(() => {
      started = false
    })
  }
}
