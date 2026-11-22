import { useCallback, useEffect, useRef, useState } from 'react'
import type { DispatchEntry } from '@zumibot/shared/dispatch'
import { api } from './api'

/**
 * One dispatched agent's whole conversation. The first fetch takes it whole; each change event then asks only for the
 * steps past the ones held (`from`) and appends them. The server answers whole (`from` 0) when indexes moved.
 */
export function useDispatchEntry(
  chatId: string | null,
  id: string | null,
  connected: boolean
): { entry: DispatchEntry | null; failed: boolean; retry: () => void } {
  const [got, setGot] = useState<{ key: string; entry: DispatchEntry } | null>(null)
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const held = useRef<{ key: string; entry: DispatchEntry } | null>(null)
  const key = chatId === null || id === null ? null : `${chatId}\n${id}`
  useEffect(() => {
    if (chatId === null || id === null || key === null || !connected) return
    let live = true
    let busy = false
    let again = false
    // One fetch at a time: an append must start from the steps the previous one left.
    const load = (): void => {
      if (busy) {
        again = true
        return
      }
      busy = true
      const have = held.current?.key === key ? held.current.entry : null
      api.dispatch
        .get(chatId, id, have?.steps.length)
        .then(
          (r) => {
            if (!live) return
            if (r !== null) {
              const entry =
                r.from === 0 || have === null ? r.entry : { ...r.entry, steps: [...have.steps.slice(0, r.from), ...r.entry.steps] }
              held.current = { key, entry }
              setGot(held.current)
            }
            setFailedFor(null)
          },
          () => {
            if (live) setFailedFor(key)
          }
        )
        .finally(() => {
          busy = false
          if (live && again) {
            again = false
            load()
          }
        })
    }
    load()
    const off = api.dispatch.onChanged((c) => {
      if (c === chatId) load()
    })
    return () => {
      live = false
      off()
    }
  }, [chatId, id, key, connected, attempt])
  const retry = useCallback((): void => {
    setFailedFor(null)
    setAttempt((n) => n + 1)
  }, [])
  return { entry: got !== null && got.key === key ? got.entry : null, failed: key !== null && failedFor === key, retry }
}
