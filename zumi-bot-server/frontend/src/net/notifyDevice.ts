import type { DesktopBridge } from '@zumibot/shared/desktop'
import type { NotifyStatus } from '@zumibot/shared/notify'
import type { ZumiBotApi } from '@zumibot/shared/types'
import { deviceIdFrom, deviceLabel, newDeviceId, type Shell } from '../state/notifications'
import { pushSupport, registerWorker, subscribeFresh, unsubscribe } from './push'

// Reading window.localStorage itself throws where site data is blocked, not just its methods.
const storage = {
  getItem: (k: string): string | null => window.localStorage.getItem(k),
  setItem: (k: string, v: string): void => window.localStorage.setItem(k, v)
}

let id: string | null = null

/** This browser profile's (or shell's) notification device id, the same for every tab of it. */
export function myDeviceId(): string {
  id ??= deviceIdFrom(storage, () => newDeviceId(globalThis.crypto))
  return id
}

export function shellOf(desktop: DesktopBridge | null): Shell {
  if (!desktop) return 'none'
  return typeof desktop.notify === 'function' ? 'new' : 'old'
}

/** The Enable click in a browser. Asks for permission first, while the click still counts as a user gesture. */
export async function enablePush(api: ZumiBotApi): Promise<NotifyStatus> {
  if (pushSupport() !== 'ok') throw new Error('This browser cannot show notifications from ZumiBot')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'Blocked by the browser' : 'Notifications were not allowed')
  if (!(await registerWorker())) throw new Error('The service worker could not start')
  // subscribe() needs an active worker, and a first registration is still installing.
  const reg = await navigator.serviceWorker.ready
  const dev = myDeviceId()
  const key = (await api.notify.status(dev)).vapidPublicKey
  if (!key) throw new Error('Push is not available on this server')
  const subscription = await subscribeFresh(reg, key)
  return api.notify.enable(dev, { channel: 'push', label: deviceLabel(navigator.userAgent, false), subscription })
}

/** The Enable click in the desktop shell: Electron needs no permission, so this only registers. */
export function enableDesktop(api: ZumiBotApi): Promise<NotifyStatus> {
  return api.notify.enable(myDeviceId(), { channel: 'desktop', label: deviceLabel(navigator.userAgent, true) })
}

export async function disableThisDevice(api: ZumiBotApi): Promise<NotifyStatus> {
  if (!api.desktop && 'serviceWorker' in navigator) {
    // The record goes regardless: a subscription the browser refuses to drop gets nothing once it is gone.
    const reg = await navigator.serviceWorker.getRegistration('/').catch(() => undefined)
    if (reg) await unsubscribe(reg).catch(() => undefined)
  }
  return api.notify.disable(myDeviceId())
}
