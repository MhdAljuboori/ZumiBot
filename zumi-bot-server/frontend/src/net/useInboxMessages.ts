import { useCallback, useEffect, useRef, useState } from 'react'
import type { InboxMessages } from '@zumibot/shared/inbox'
import { seenToSend } from '../state/inbox'
import { api } from '../api'

const DEBOUNCE_MS = 300

/**
 * The Inbox's messages, for the rail dot (always) and the page: fetched when the socket connects and after any
 * `inbox:changed` (debounced, trailing). An older answer never replaces a newer one, and a failed fetch keeps the last
 * list. `reload` fetches at once, for a change this tab just made. null until the first answer.
 */
export function useInboxMessages(connected: boolean): { data: InboxMessages | null; reload: () => void } {
  const [data, setData] = useState<InboxMessages | null>(null)
  const loadRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!connected) return
    let live = true
    let seq = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      const mine = ++seq
      api.inbox.messages().then(
        (r) => {
          if (live && mine === seq) setData(r)
        },
        () => {
          /* keep what is shown */
        }
      )
    }
    loadRef.current = load
    load()
    const off = api.inbox.onChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(load, DEBOUNCE_MS)
    })
    return () => {
      live = false
      loadRef.current = () => {}
      clearTimeout(timer)
      off()
    }
  }, [connected])
  const reload = useCallback(() => loadRef.current(), [])
  return { data, reload }
}

/**
 * Marks the Inbox seen while its Messages section shows on a visible tab and a message is behind. `inbox:seen`
 * broadcasts a change that refetches, so `seenToSend` must go quiet once seenAt has caught up, or the two would call
 * each other forever; each time is sent once a visit (`sent`, forgotten when the section is left).
 */
export function useMarkInboxSeen(data: InboxMessages | null, shown: boolean): void {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  const sent = useRef<number | null>(null)
  useEffect(() => {
    const on = (): void => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  useEffect(() => {
    if (!shown) sent.current = null
    const at = seenToSend(data, shown && visible, sent.current)
    if (at === null) return
    sent.current = at
    api.inbox.seen(at).catch(() => {
      sent.current = null
    }) // the next change or visit tries again
  }, [shown, visible, data])
}
