import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProcessInfo } from '@zumibot/shared/processes'
import { api } from './api'
import { countsAfter, joinLog, logBehind, type LogView } from './state/processes'

/**
 * The open chat's background processes: fetched when the chat changes and when the socket comes back, and again on every
 * `processes:changed` for the chat (never deduped). null until the first answer.
 */
export function useProcesses(
  chatId: string | null,
  connected: boolean
): { list: ProcessInfo[] | null; failed: boolean; retry: () => void } {
  const [got, setGot] = useState<{ chatId: string; list: ProcessInfo[] } | null>(null)
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (chatId === null || !connected) return
    let live = true
    let seq = 0
    const load = (): void => {
      const mine = ++seq // a slow older answer must not overwrite a newer one
      api.processes.list(chatId).then(
        (list) => {
          if (live && mine === seq) {
            setGot({ chatId, list })
            setFailedFor(null)
          }
        },
        () => {
          if (live && mine === seq) setFailedFor(chatId)
        }
      )
    }
    load()
    const off = api.processes.onChanged((e) => {
      if (e.chatId === chatId) load()
    })
    return () => {
      live = false
      off()
    }
  }, [chatId, connected, attempt])
  const retry = useCallback((): void => {
    setFailedFor(null)
    setAttempt((n) => n + 1)
  }, [])
  return { list: got !== null && got.chatId === chatId ? got.list : null, failed: chatId !== null && failedFor === chatId, retry }
}

/** Running processes per chat, for the chat header's mark: fetched on connect, then kept from each change event's count. */
export function useProcessCounts(connected: boolean): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({})
  useEffect(() => {
    if (!connected) return
    let live = true
    // Subscribed before the fetch, so a change between the two is not lost; the fetch's answer then replaces all.
    const off = api.processes.onChanged((e) => setCounts((c) => countsAfter(c, e)))
    api.processes.counts().then(
      (c) => {
        if (live) setCounts(c)
      },
      () => {}
    )
    return () => {
      live = false
      off()
    }
  }, [connected])
  return counts
}

/**
 * One process's live log: the newest part first, then every byte past it as `processes:output` says there is more. One read at a
 * time; an event during a read is caught up right after it. A read that comes back with a gap starts the view over (joinLog).
 */
export function useProcessLog(chatId: string, id: string, connected: boolean): { view: LogView | null; failed: boolean } {
  const [view, setView] = useState<LogView | null>(null)
  const [failed, setFailed] = useState(false)
  const ref = useRef<LogView | null>(null)
  useEffect(() => {
    if (!connected) return
    let live = true
    let reading = false
    let wanted = -1 // the newest `to` an event announced, past the view
    ref.current = null
    setView(null)
    setFailed(false)
    const read = (): void => {
      if (reading || !live) return
      reading = true
      const cur = ref.current
      api.processes
        .logs(chatId, id, cur === null ? undefined : cur.to)
        .then(
          (r) => {
            if (!live) return
            const next = joinLog(ref.current, id, r)
            ref.current = next
            setView(next)
            setFailed(false)
          },
          () => {
            if (live) setFailed(true)
          }
        )
        .finally(() => {
          reading = false
          // Bytes announced while this read ran, and a read that stopped short (its size cap), are fetched next.
          if (live && ref.current !== null && logBehind(ref.current, wanted)) read()
        })
    }
    read()
    const off = api.processes.onOutput((e) => {
      if (e.chatId !== chatId || e.id !== id) return
      wanted = Math.max(wanted, e.to)
      if (logBehind(ref.current, e.to)) read()
    })
    // A restart starts the stream again after a marker; a change event also covers a read missed while the socket was down.
    const offChanged = api.processes.onChanged((e) => {
      if (e.chatId === chatId) read()
    })
    return () => {
      live = false
      off()
      offChanged()
    }
  }, [chatId, id, connected])
  return { view, failed }
}
