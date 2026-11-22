import { safeOpenPath, type DesktopNotification, type DesktopNotificationTarget } from '@zumibot/shared/desktop'
import type { NotifyPayloadKind } from '@zumibot/shared/notify'

const MAX_TEXT = 200
const MAX_SHOWN = 100 // a bound on what a page can pile up in the OS notification list
const KINDS: readonly NotifyPayloadKind[] = ['waiting', 'replied', 'error', 'routine-failed', 'test', 'paused', 'workflow', 'spend-cap']

export interface NotificationLike {
  show(): void
  close(): void
  on(e: 'click', cb: () => void): void
}

interface Entry {
  notification: NotificationLike
  chatId: string | null
  open: string | null
  kind: NotifyPayloadKind
}

export function createDesktopNotifier(o: {
  create(opts: { title: string; body: string; silent: boolean }): NotificationLike
  onClick(chatId: string | null, open: string | null): void
}): {
  show(n: DesktopNotification): void
  close(chatId: string, waitingOnly: boolean): void
  closeTag(tag: string): void
  closeAll(): void
} {
  // Map order is insertion order, so the first key is the oldest.
  const entries = new Map<string, Entry>()

  const drop = (tag: string): void => {
    const e = entries.get(tag)
    if (!e) return
    entries.delete(tag)
    e.notification.close()
  }

  return {
    show(n) {
      drop(n.tag) // the replacement goes to the end of the order, not the old slot
      const notification = o.create({ title: n.title, body: n.body, silent: false })
      const entry: Entry = { notification, chatId: n.chatId, open: n.open ?? null, kind: n.kind }
      notification.on('click', () => {
        // A click on an already replaced notification must not drop its replacement.
        if (entries.get(n.tag) === entry) entries.delete(n.tag)
        o.onClick(n.chatId, entry.open)
      })
      entries.set(n.tag, entry)
      notification.show()
      while (entries.size > MAX_SHOWN) drop(entries.keys().next().value as string)
    },
    close(chatId, waitingOnly) {
      for (const [tag, e] of [...entries]) {
        if (e.chatId === chatId && (!waitingOnly || e.kind === 'waiting')) drop(tag)
      }
    },
    // A workflow run's notification has no chat: it is closed by its tag.
    closeTag(tag) {
      drop(tag)
    },
    closeAll() {
      for (const tag of [...entries.keys()]) {
        try {
          drop(tag)
        } catch {
          // One bad notification must not keep the rest open.
        }
      }
    }
  }
}

/** Page input is untyped: only short strings and a known kind pass, as a copy without extra fields. */
export function checkDesktopNotification(v: unknown): DesktopNotification | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  const short = (x: unknown): x is string => typeof x === 'string' && x.length <= MAX_TEXT
  const { tag, chatId, kind, title, body } = r
  if (!short(tag) || tag === '' || !short(title) || !short(body)) return null
  if (chatId !== null && !short(chatId)) return null
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null
  const out: DesktopNotification = { tag, chatId, kind: kind as NotifyPayloadKind, title, body }
  // A bad path only loses the click target, not the notification.
  const open = safeOpenPath(r.open)
  if (open !== null) out.open = open
  return out
}

/**
 * A click can arrive before the page has subscribed (the window was just restored, or is still loading):
 * the latest one is held and delivered once the page signals it is ready. `reset` on every new document.
 */
export function createClickRelay(send: (t: DesktopNotificationTarget) => void): {
  click(chatId: string | null, open?: string | null): void
  ready(): void
  reset(): void
} {
  let isReady = false
  let held: DesktopNotificationTarget | null = null
  return {
    click(chatId, open = null) {
      if (isReady) send({ chatId, open })
      else held = { chatId, open }
    },
    ready() {
      isReady = true
      const h = held
      held = null
      if (h) send(h)
    },
    reset() {
      isReady = false
    }
  }
}
