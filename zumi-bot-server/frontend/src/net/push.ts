import { NOTIFY_KINDS, type NotifyPayloadKind, type SubscriptionInput } from '@zumibot/shared/notify'
import type { ShownNotification } from '../state/notifications'

export type PushSupport = 'ok' | 'unsupported' | 'ios-needs-install' | 'denied'

export interface SupportEnv {
  hasWorker: boolean
  hasPush: boolean
  permission: NotificationPermission | 'unavailable'
  ua: string
  maxTouchPoints: number
  standalone: boolean
}

// Shared with the server, so a new kind (spend-cap, workflow) is never dropped when shown notifications are read back.
const KINDS: readonly string[] = NOTIFY_KINDS

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(s.length / 4) * 4, '=')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// Only the three fields the server stores; anything else the browser adds is dropped.
export function subscriptionFrom(json: unknown): SubscriptionInput | null {
  if (!json || typeof json !== 'object') return null
  const { endpoint, keys } = json as { endpoint?: unknown; keys?: unknown }
  if (typeof endpoint !== 'string' || endpoint === '' || !keys || typeof keys !== 'object') return null
  const { p256dh, auth } = keys as { p256dh?: unknown; auth?: unknown }
  if (typeof p256dh !== 'string' || p256dh === '' || typeof auth !== 'string' || auth === '') return null
  return { endpoint, keys: { p256dh, auth } }
}

// A notification without our data (the worker's generic fallback) has nothing to clear by.
export function shownFrom(n: { tag: string; data?: unknown }): ShownNotification | null {
  const d = n.data
  if (n.tag === '' || !d || typeof d !== 'object') return null
  const { chatId, kind, at } = d as { chatId?: unknown; kind?: unknown; at?: unknown }
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return null
  if (typeof at !== 'number' || !Number.isFinite(at)) return null
  if (chatId !== null && typeof chatId !== 'string') return null
  return { tag: n.tag, chatId, kind: kind as NotifyPayloadKind, at }
}

export function pushSupportFrom(env: SupportEnv): PushSupport {
  // iPadOS says Macintosh, so a touch screen tells it from a Mac.
  const ios = /iPhone|iPad|iPod/.test(env.ua) || (/Macintosh/.test(env.ua) && env.maxTouchPoints > 1)
  // Checked first: Safari in a tab has no PushManager at all, and "install it" is the useful answer there.
  if (ios && !env.standalone) return 'ios-needs-install'
  if (!env.hasWorker || !env.hasPush) return 'unsupported'
  if (env.permission === 'denied') return 'denied'
  return 'ok'
}

export function pushSupport(): PushSupport {
  const nav = navigator as Navigator & { standalone?: boolean }
  return pushSupportFrom({
    hasWorker: 'serviceWorker' in navigator,
    hasPush: 'PushManager' in window,
    permission: typeof Notification === 'undefined' ? 'unavailable' : Notification.permission,
    ua: navigator.userAgent,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone: nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true
  })
}

export async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch {
    return null
  }
}

export async function currentSubscription(reg: ServiceWorkerRegistration): Promise<SubscriptionInput | null> {
  const sub = await reg.pushManager.getSubscription()
  return sub ? subscriptionFrom(sub.toJSON()) : null
}

export async function subscribe(reg: ServiceWorkerRegistration, vapidPublicKey: string): Promise<SubscriptionInput> {
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(vapidPublicKey) })
  const out = subscriptionFrom(sub.toJSON())
  if (!out) throw new Error('The browser returned an unusable push subscription')
  return out
}

interface SubscribeOps {
  subscribe(reg: ServiceWorkerRegistration, key: string): Promise<SubscriptionInput>
  unsubscribe(reg: ServiceWorkerRegistration): Promise<void>
  isInvalidState(e: unknown): boolean
}

/**
 * Drops what the browser still holds first: after the server forgets a dead endpoint, subscribe() with the same key
 * would hand the dead one back. A leftover made with an old key (InvalidStateError) is dropped and tried once more.
 */
export async function subscribeFresh(
  reg: ServiceWorkerRegistration,
  key: string,
  ops: SubscribeOps = { subscribe, unsubscribe, isInvalidState: (e) => e instanceof DOMException && e.name === 'InvalidStateError' }
): Promise<SubscriptionInput> {
  // A refusal to drop is not fatal: subscribe() below may still work.
  await ops.unsubscribe(reg).catch(() => undefined)
  try {
    return await ops.subscribe(reg, key)
  } catch (e) {
    if (!ops.isInvalidState(e)) throw e
    await ops.unsubscribe(reg)
    return ops.subscribe(reg, key)
  }
}

export async function unsubscribe(reg: ServiceWorkerRegistration): Promise<void> {
  const sub = await reg.pushManager.getSubscription()
  if (sub) await sub.unsubscribe()
}

export async function shownNotifications(reg: ServiceWorkerRegistration): Promise<ShownNotification[]> {
  const out: ShownNotification[] = []
  for (const n of await reg.getNotifications()) {
    const s = shownFrom(n)
    if (s) out.push(s)
  }
  return out
}

export async function closeTags(reg: ServiceWorkerRegistration, tags: readonly string[]): Promise<void> {
  for (const tag of tags) for (const n of await reg.getNotifications({ tag })) n.close()
}
