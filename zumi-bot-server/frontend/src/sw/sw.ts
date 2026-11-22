/// <reference lib="webworker" />
import { isPayload, notifyText } from '@zumibot/shared/notify'
import { clickUrl } from './clickTarget'
import { agentsFor } from './mergePlan'

declare const self: ServiceWorkerGlobalScope

// renotify is missing from the WebWorker lib's NotificationOptions, but browsers honour it.
type Options = NotificationOptions & { renotify?: boolean }

const ICON = '/icon-192.png'
// Android draws the badge from its alpha alone: the full-colour icon came out as a white square.
const BADGE = '/badge-96.png'

self.addEventListener('install', () => {
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

// No renotify here: it throws on an empty tag, and this is the last resort that must not.
function showGeneric(): Promise<void> {
  return self.registration.showNotification('ZumiBot', { body: 'Something needs you', tag: 'unknown', icon: ICON, badge: BADGE })
}

async function show(raw: unknown): Promise<void> {
  if (!isPayload(raw)) return showGeneric()
  // Room replies share one tag, so the names already shown are read back from that notification.
  const shown = await self.registration.getNotifications({ tag: raw.tag }).catch(() => [])
  const agents = agentsFor(shown[0]?.data as { kind?: unknown; agents?: unknown } | null | undefined, raw)
  const { title, body } = notifyText(raw, agents)
  const opts: Options = {
    body,
    tag: raw.tag,
    icon: ICON,
    badge: BADGE,
    data: {
      chatId: raw.chatId,
      kind: raw.kind,
      at: raw.at,
      agents,
      run: raw.run ?? null,
      message: raw.message ?? null,
      inbox: raw.inbox === true
    }
  }
  // Chrome throws on renotify without a tag.
  if (raw.tag !== '') opts.renotify = true
  await self.registration.showNotification(title, opts)
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let raw: unknown = null
      try {
        raw = event.data?.json()
      } catch {
        // Not JSON: falls through to the generic notification.
      }
      // A push that shows nothing gets the subscription revoked (iOS) or a generic browser notice, so always show.
      try {
        await show(raw)
      } catch {
        await showGeneric()
      }
    })()
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const chatId = (event.notification.data as { chatId?: unknown } | null)?.chatId
  const id = typeof chatId === 'string' ? chatId : null
  // A Notify message opens the Inbox; a workflow run has no chat, so its click opens the run's page.
  const runUrl = clickUrl(event.notification.data)
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const target = windows.find((c) => c.focused) ?? windows[0]
      if (runUrl) {
        if (target) {
          await target.focus().catch(() => undefined)
          // A page the worker cannot navigate (not controlled) gets a new window instead.
          if ('navigate' in target && (await target.navigate(runUrl).catch(() => null))) return
        }
        await self.clients.openWindow(runUrl)
        return
      }
      if (target) {
        // Post first: a refused focus() must not stop the page from opening the chat.
        try {
          target.postMessage({ type: 'open-chat', chatId: id })
        } catch {
          // A window that just closed.
        }
        await target.focus().catch(() => undefined)
        return
      }
      await self.clients.openWindow(id ? '/chat/' + encodeURIComponent(id) : '/')
    })()
  )
})
