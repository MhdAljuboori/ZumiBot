import {
  DEFAULT_TOGGLES,
  isToggles,
  type DeviceSummary,
  type NotifyChannel,
  type NotifyState,
  type NotifyStatus,
  type NotifyToggles,
  type SubscriptionInput
} from '@zumibot/shared/notify'
import type { ServerMode } from '@zumibot/shared/types'
import type { DeviceRecord, NotifyStore } from '../core/notify/notifyStore'
import type { Presence } from '../core/notify/presence'
import { checkSubscription, DEVICE_ID_RE } from '../core/notify/subscription'
import type { ConnHandlers } from './hub'

export interface NotifyHandlerDeps {
  store: Pick<NotifyStore, 'devices' | 'get' | 'put' | 'patch' | 'remove' | 'vapid'>
  presence: Pick<Presence, 'update' | 'deviceOf'>
  notify: { test(deviceId: string): Promise<'sent' | 'none'>; state(): NotifyState }
  mode: ServerMode
  /** Dev hook: the one http://127.0.0.1:<port> origin push endpoints may use. */
  testOrigin: string | null
  now(): number
}

const LABEL_MAX = 80
const SEEN_EVERY_MS = 60_000
// A signed-in page picks its own ids; this only keeps a misbehaving one from growing the map without end.
const SEEN_KEPT = 1000

function deviceId(v: unknown): string {
  if (typeof v !== 'string' || !DEVICE_ID_RE.test(v)) throw new TypeError('deviceId is not valid')
  return v
}

function toggles(v: unknown): NotifyToggles {
  if (!isToggles(v)) throw new TypeError('toggles must be four booleans')
  return { waiting: v.waiting, replied: v.replied, error: v.error, routineFailed: v.routineFailed }
}

function label(v: unknown): string {
  // Control characters would reach the device list and the push log line.
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() : ''
  if (s === '' || s.length > LABEL_MAX) throw new TypeError(`label must be 1 to ${LABEL_MAX} characters`)
  return s
}

function channel(v: unknown): NotifyChannel {
  if (v !== 'push' && v !== 'desktop') throw new TypeError('channel must be push or desktop')
  return v
}

function chatIdOrNull(v: unknown): string | null {
  if (v !== null && typeof v !== 'string') throw new TypeError('chatId must be a string or null')
  return v
}

function boolean(v: unknown, what: string): boolean {
  if (typeof v !== 'boolean') throw new TypeError(`${what} must be a boolean`)
  return v
}

function nonNegative(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new TypeError(`${what} must be a finite number of 0 or more`)
  return v
}

// Summaries are what the UI sees: never the endpoint, its keys or the session key.
const summary = (r: DeviceRecord, currentId: string): DeviceSummary => ({
  id: r.id,
  label: r.label,
  channel: r.channel,
  toggles: r.toggles,
  lastSeenAt: r.lastSeenAt,
  subscribed: r.push !== undefined,
  paused: r.push?.paused ?? false,
  current: r.id === currentId
})

/** The notify:* RPC methods. All need the connection: presence is per socket and push follows the sign-in session. */
export function createNotifyHandlers(d: NotifyHandlerDeps): ConnHandlers {
  const seen = new Map<string, number>()

  const status = async (currentId: string): Promise<NotifyStatus> => {
    const vps = d.mode === 'vps'
    // The page needs the key before its first subscribe, so VPS mode creates it here; Local mode never has one.
    const vapidPublicKey = vps ? (await d.store.vapid()).publicKey : null
    const devices = await d.store.devices()
    return { pushAvailable: vps, vapidPublicKey, devices: devices.map((r) => summary(r, currentId)) }
  }

  const checked = (v: unknown): SubscriptionInput => {
    try {
      return checkSubscription(v, d.testOrigin)
    } catch {
      throw new TypeError('subscription is not valid')
    }
  }

  return {
    'notify:status': async (_c, id) => status(deviceId(id)),

    'notify:enable': async (c, id, o) => {
      const dev = deviceId(id)
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new TypeError('options must be an object')
      const opts = o as Record<string, unknown>
      const ch = channel(opts.channel)
      const name = label(opts.label)
      if (ch === 'push' && d.mode !== 'vps') throw new Error('Push is not available in Local mode')
      const sub = ch === 'push' ? checked(opts.subscription) : null
      if (sub) await d.store.vapid() // the page subscribes against this key, so it must exist before a record points at it
      const prev = await d.store.get(dev)
      const now = d.now()
      await d.store.put({
        id: dev,
        channel: ch,
        label: name,
        toggles: prev?.toggles ?? { ...DEFAULT_TOGGLES },
        createdAt: prev?.createdAt ?? now,
        lastSeenAt: now,
        ...(sub
          ? { push: { endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, sessionKey: c.sessionKey, paused: false } }
          : {})
      })
      return status(dev)
    },

    // Never creates a record: a device the server forgot must go through enable, which asks the user again.
    'notify:refresh': async (c, id, subscription) => {
      const dev = deviceId(id)
      const sub = subscription === null || subscription === undefined ? null : checked(subscription)
      const now = d.now()
      const rec = await d.store.patch(dev, (r) => {
        const next: DeviceRecord = { ...r, lastSeenAt: now }
        if (r.push) {
          // Signing in again rebinds the device to the new session and ends the pause.
          next.push = { ...r.push, sessionKey: c.sessionKey, paused: false }
          if (sub) next.push = { ...next.push, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth }
        }
        return next
      })
      return { known: rec !== null }
    },

    'notify:disable': async (_c, id) => {
      const dev = deviceId(id)
      await d.store.remove(dev)
      return status(dev)
    },

    'notify:remove': async (c, id) => {
      await d.store.remove(deviceId(id))
      // remove() carries no id for the asking page; its last presence report names the device it is on.
      return status(d.presence.deviceOf(c.id) ?? '')
    },

    'notify:setPrefs': async (_c, id, t) => {
      const dev = deviceId(id)
      const next = toggles(t)
      const rec = await d.store.patch(dev, (r) => ({ ...r, toggles: next }))
      if (!rec) throw new Error('Unknown device')
      return status(dev)
    },

    'notify:test': async (_c, id) => d.notify.test(deviceId(id)),

    'notify:presence': async (c, id, chatId, looking, inputAgoMs, openedAgoMs) => {
      const dev = deviceId(id)
      const chat = chatIdOrNull(chatId)
      const look = boolean(looking, 'looking')
      const ago = nonNegative(inputAgoMs, 'inputAgoMs')
      // A page loaded before the open time was sent has none; it can never end a mark then.
      const opened = openedAgoMs === undefined || openedAgoMs === null ? {} : { openedAgoMs: nonNegative(openedAgoMs, 'openedAgoMs') }
      d.presence.update(c.id, { deviceId: dev, chatId: chat, looking: look, inputAgoMs: ago, ...opened })
      const now = d.now()
      const last = seen.get(dev)
      if (last !== undefined && now - last < SEEN_EVERY_MS) return
      if (seen.size >= SEEN_KEPT) seen.clear()
      seen.set(dev, now)
      // Only a device that exists: presence from a page that never enabled notifications creates nothing.
      await d.store.patch(dev, (r) => ({ ...r, lastSeenAt: now })).catch(() => null)
    },

    'notify:state': async () => d.notify.state()
  }
}
