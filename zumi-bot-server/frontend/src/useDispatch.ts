import { useCallback, useEffect, useState } from 'react'
import type { DispatchSummary } from '@zumibot/shared/dispatch'
import { api } from './api'

/**
 * The open chat's dispatched agents (summaries): fetched when the chat changes and when the socket comes back, and again
 * on every change event for the chat (a running turn sends one about once a second). null until the first answer.
 */
export function useDispatch(
  chatId: string | null,
  connected: boolean
): { list: DispatchSummary[] | null; failed: boolean; retry: () => void } {
  const [got, setGot] = useState<{ chatId: string; list: DispatchSummary[] } | null>(null)
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (chatId === null || !connected) return
    let live = true
    let seq = 0
    const load = (): void => {
      const mine = ++seq // a slow older answer must not overwrite a newer one
      api.dispatch.list(chatId).then(
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
    const off = api.dispatch.onChanged((id) => {
      if (id === chatId) load()
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
