import { useEffect, useRef, useState } from 'react'
import type { ZumiBotApi } from '@zumibot/shared/types'
import { setFaviconDot } from './faviconDot'
import { myDeviceId, shellOf } from './net/notifyDevice'
import { openChatBus } from './net/openChatBus'
import { closeTags, currentSubscription, registerWorker, shownNotifications, unsubscribe } from './net/push'
import { DICTATION_INPUT_EVENT } from './useDictation'
import {
  INPUT_REPORT_MS,
  LOOK_IDLE_MS,
  badgeTitle,
  desktopNotice,
  isLooking,
  mergePending,
  onceUntilFailure,
  presenceReports,
  seedFrom,
  showDot,
  notificationTarget,
  staleTags,
  waitingChats,
  withoutChats,
  type DesktopShown,
  type SentPresence
} from './state/notifications'

interface Options {
  api: ZumiBotApi
  /** The chat on screen, or null for any other view. */
  viewChatId: string | null
  /**
   * Whether showing it counts as opening it (default true). The To-dos page's exchange looks at its chat without opening
   * it, so it never ends a Mark unread.
   */
  viewOpens?: boolean
  /** Live pending counts from the approvals pushes. */
  pendingByChat: Record<string, number>
  openChatFromNotification(chatId: string): void
  /** A shell click on a Notify notification: opens that message in the Inbox (null: the Inbox itself). */
  openInboxFromNotification?(messageId: string | null): void
  /** A shell click on a workflow approval or failure: opens that run. */
  openRunFromNotification?(workflowId: string, runId: string): void
  /**
   * Only the presence reports run: no device setup, no tab title or favicon, no delivery and no click handling. The island
   * page uses it, since only the main window is the desktop notification device.
   */
  presenceOnly?: boolean
}

const quiet = (): void => {}
const BASE_TITLE = 'ZumiBot'
const SHOWN_KEPT = 200

/** Presence, the tab's title and favicon, clearing shown notifications, and delivery in the desktop shell. */
export function useNotifications({
  api,
  viewChatId,
  viewOpens = true,
  pendingByChat,
  openChatFromNotification,
  openInboxFromNotification,
  openRunFromNotification,
  presenceOnly = false
}: Options): void {
  const open = useRef(openChatFromNotification)
  open.current = openChatFromNotification
  const openInbox = useRef(openInboxFromNotification)
  openInbox.current = openInboxFromNotification
  const openRun = useRef(openRunFromNotification)
  openRun.current = openRunFromNotification
  const live = useRef(pendingByChat)
  live.current = pendingByChat
  const presence = useRef({
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
    chatId: viewChatId,
    // When this page opened the chat on screen. A load counts, so a reload ends a mark like any other open. Undefined
    // while the chat is shown without being opened: no open time is sent then.
    openedAt: Date.now() as number | undefined,
    // A load is the user's doing (a click, a reload, a notification), so it counts as input if they can see it.
    lastInputAt: document.visibilityState === 'visible' && document.hasFocus() ? Date.now() : 0,
    sent: null as SentPresence | null,
    check: quiet
  })
  // Only the browser's worker holds push notifications; null in the shell, in Local mode, or until registered.
  const reg = useRef<ServiceWorkerRegistration | null>(null)
  const [seed, setSeed] = useState<Record<string, number>>({})

  // Presence: every change goes through one check, which sends only what presenceReports says.
  useEffect(() => {
    const p = presence.current
    const id = myDeviceId()
    let idle: ReturnType<typeof setTimeout> | undefined
    const check = (): void => {
      const now = Date.now()
      const looking = isLooking({ ...p, now })
      const reports = presenceReports(p.sent, { chatId: p.chatId, looking, lastInputAt: p.lastInputAt, now, openedAt: p.openedAt })
      if (reports.length > 0) p.sent = { chatId: p.chatId, looking, at: now, inputAt: p.lastInputAt }
      for (const r of reports) api.notify.presence(id, r.chatId, r.looking, r.inputAgoMs, r.openedAgoMs).catch(quiet)
      // Looking ends exactly at the idle limit, not at the next 30 s check.
      clearTimeout(idle)
      if (looking) idle = setTimeout(check, p.lastInputAt + LOOK_IDLE_MS - now)
    }
    p.check = check
    const onInput = (): void => {
      p.lastInputAt = Date.now()
      check()
    }
    const onVisibility = (): void => {
      p.visible = document.visibilityState === 'visible'
      check()
    }
    const onFocus = (): void => {
      p.focused = true
      check()
    }
    // Focus moving into a frame on the page blurs the window but the page still has it.
    const onBlur = (): void => {
      setTimeout(() => {
        p.focused = document.hasFocus()
        check()
      }, 0)
    }
    const inputs = ['keydown', 'pointerdown', 'touchstart', 'wheel'] as const
    for (const e of inputs) window.addEventListener(e, onInput, { passive: true, capture: true })
    // Speaking makes no DOM input events, so a dictation reports itself.
    window.addEventListener(DICTATION_INPUT_EVENT, onInput)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    const timer = setInterval(check, INPUT_REPORT_MS)
    // A reconnect is a new connection to the server, which knows nothing of this tab until told again.
    const offStatus = api.connection.onStatus((s) => {
      if (s !== 'connected') return
      p.sent = null
      check()
    })
    return () => {
      for (const e of inputs) window.removeEventListener(e, onInput, { capture: true })
      window.removeEventListener(DICTATION_INPUT_EVENT, onInput)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
      clearInterval(timer)
      clearTimeout(idle)
      offStatus()
      p.check = quiet
    }
  }, [api])

  useEffect(() => {
    const p = presence.current
    if (!viewOpens) p.openedAt = undefined
    else if (p.chatId !== viewChatId) p.openedAt = Date.now()
    else if (p.openedAt === undefined) {
      // The same chat, opened now (the To-dos page's Open chat): an open, so it is reported even with nothing else changed.
      p.openedAt = Date.now()
      p.sent = null
    }
    p.chatId = viewChatId
    p.check()
  }, [viewChatId, viewOpens])

  // Title and favicon. A pushed count makes the seeded one for that chat obsolete for good.
  useEffect(() => setSeed((s) => withoutChats(s, Object.keys(pendingByChat))), [pendingByChat])
  const waiting = waitingChats(mergePending(seed, pendingByChat))
  useEffect(() => {
    if (presenceOnly) return
    document.title = badgeTitle(BASE_TITLE, waiting)
    void setFaviconDot(showDot(waiting))
  }, [waiting, presenceOnly])

  // Setup on the first connect, the pending seed on every connect, and stale notifications on each return to the tab.
  useEffect(() => {
    if (presenceOnly) return
    let alive = true
    const id = myDeviceId()
    const desktop = api.desktop
    const closeStale = async (): Promise<void> => {
      const r = reg.current
      if (!r) return
      const shown = await shownNotifications(r)
      if (shown.length === 0) return
      await closeTags(r, staleTags(shown, await api.notify.state()))
    }
    const start = async (): Promise<void> => {
      if (desktop) {
        // The shell is a desktop device: it holds no subscription, refresh only marks it seen.
        await api.notify.refresh(id, null)
        return
      }
      const status = await api.notify.status(id)
      if (!status.pushAvailable || !alive) return
      const r = await registerWorker()
      if (!r || !alive) return
      reg.current = r
      const sub = await currentSubscription(r)
      // Never enable from here: a device removed elsewhere stays removed, so its leftover subscription goes.
      const { known } = await api.notify.refresh(id, sub)
      if (!known && sub) await unsubscribe(r)
      await closeStale()
    }
    const startOnce = onceUntilFailure(start)
    const offStatus = api.connection.onStatus((s) => {
      if (s !== 'connected') return
      api.notify.state().then((st) => {
        if (alive) setSeed(seedFrom(st.pending, live.current))
      }, quiet)
      // A failed first setup is retried by the next connect, which also gives stale-closing its worker.
      startOnce()
    })
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') closeStale().catch(quiet)
    }
    document.addEventListener('visibilitychange', onVisibility)
    const offClear = api.notify.onClear(({ chatId, waitingOnly, tag }) => {
      // A workflow run's notification has no chat: closed by its tag (a shell older than closeNotificationTag keeps it).
      if (tag !== undefined || chatId === null) {
        if (tag === undefined) return
        if (desktop) {
          desktop.closeNotificationTag?.(tag)
          return
        }
        const r = reg.current
        if (r) closeTags(r, [tag]).catch(quiet)
        return
      }
      // Pending fell to 0 for that chat.
      if (waitingOnly) setSeed((s) => withoutChats(s, [chatId]))
      if (desktop) {
        desktop.closeNotifications?.(chatId, waitingOnly)
        return
      }
      const r = reg.current
      if (!r) return
      shownNotifications(r)
        .then((shown) =>
          closeTags(
            r,
            shown.filter((n) => n.chatId === chatId && (!waitingOnly || n.kind === 'waiting')).map((n) => n.tag)
          )
        )
        .catch(quiet)
    })
    return () => {
      alive = false
      offStatus()
      offClear()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [api, presenceOnly])

  // Delivery in the shell, and clicks from either channel.
  useEffect(() => {
    if (presenceOnly) return
    const desktop = api.desktop
    const offs = [openChatBus.on((chatId) => open.current(chatId))]
    if (desktop && shellOf(desktop) === 'new') {
      const shown = new Map<string, DesktopShown>()
      offs.push(
        api.notify.onShow((p) => {
          const { shown: next, notification } = desktopNotice(shown.get(p.tag), p)
          shown.delete(p.tag)
          shown.set(p.tag, next)
          // Tags are per chat or routine; only the merge of the newest few matters.
          if (shown.size > SHOWN_KEPT) shown.delete(shown.keys().next().value as string)
          try {
            desktop.notify?.(notification)
          } catch {
            // A failed desktop notification is the device's own business.
          }
        })
      )
      // A shell that reports the open path gets it; an older one only has the chat click, as before.
      const offClick = desktop.onNotificationOpen
        ? desktop.onNotificationOpen((t) => {
            const target = notificationTarget(t)
            if (target?.kind === 'inbox') openInbox.current?.(target.messageId)
            else if (target?.kind === 'run') openRun.current?.(target.workflowId, target.runId)
            else if (target?.kind === 'chat') open.current(target.chatId)
          })
        : desktop.onNotificationClick?.((chatId) => {
            if (chatId !== null) open.current(chatId)
          })
      if (offClick) offs.push(offClick)
    }
    return () => {
      for (const off of offs) off()
    }
  }, [api, presenceOnly])
}
