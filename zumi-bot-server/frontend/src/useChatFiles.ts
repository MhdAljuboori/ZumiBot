import { useCallback, useEffect, useState } from 'react'
import type { ChatFileList } from '@zumibot/shared/files'
import { api } from './api'

// The server reads the whole chat for each list, so a burst of pushes costs one call.
const QUIET_MS = 500
// A reply that pushes without a pause must not hold the list back for good.
const LONGEST_WAIT_MS = 3000

/**
 * The open chat's files: fetched when the chat changes and when the socket comes back, and again shortly after its
 * item pushes settle. null until the first answer; an answer for a chat no longer shown is dropped.
 */
export function useChatFiles(chatId: string | null, connected: boolean): { list: ChatFileList | null; failed: boolean; retry: () => void } {
  const [got, setGot] = useState<{ chatId: string; list: ChatFileList } | null>(null)
  const [failedFor, setFailedFor] = useState<string | null>(null) // the chat whose latest fetch failed
  const [attempt, setAttempt] = useState(0) // bumped by Retry, which restarts the effect
  useEffect(() => {
    if (chatId === null || !connected) return
    let live = true
    let seq = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let since = 0
    const load = (): void => {
      since = 0
      const mine = ++seq // a slow older answer must not overwrite a newer one
      api.files.list(chatId).then(
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
    const off = api.chats.onPush((p) => {
      if (p.chatId !== chatId || p.kind !== 'items') return
      const now = Date.now()
      if (since === 0) since = now
      clearTimeout(timer)
      timer = setTimeout(load, Math.max(0, Math.min(QUIET_MS, since + LONGEST_WAIT_MS - now)))
    })
    return () => {
      live = false
      clearTimeout(timer)
      off()
    }
  }, [chatId, connected, attempt])
  const list = got !== null && got.chatId === chatId ? got.list : null
  const retry = useCallback((): void => {
    setFailedFor(null) // back to Loading… while it runs
    setAttempt((n) => n + 1)
  }, [])
  return { list, failed: chatId !== null && failedFor === chatId, retry }
}
