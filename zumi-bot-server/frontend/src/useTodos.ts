import { useCallback, useEffect, useState } from 'react'
import type { TodoItem } from '@zumibot/shared/todos'
import { api } from './api'

/**
 * The to-dos made in a chat (its side panel; null fetches nothing): fetched when the chat changes and when the socket
 * comes back, and again on EVERY board change event. The server sends one after an agent turn settles with the rev
 * unchanged (the items only learn their reply id then), so the rev is never a reason to skip a fetch. null until the
 * first answer.
 */
export function useTodos(
  chatId: string | null,
  connected: boolean
): { items: TodoItem[] | null; failed: boolean; retry: () => void; refresh: () => void } {
  const [got, setGot] = useState<{ chatId: string; items: TodoItem[] } | null>(null)
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0) // bumped by Retry and by refresh, which restart the effect
  useEffect(() => {
    if (chatId === null || !connected) return
    let live = true
    let seq = 0
    const load = (): void => {
      const mine = ++seq // a slow older answer must not overwrite a newer one
      api.todos.list(chatId).then(
        (r) => {
          if (live && mine === seq) {
            setGot({ chatId, items: r.items })
            setFailedFor(null)
          }
        },
        () => {
          if (live && mine === seq) setFailedFor(chatId)
        }
      )
    }
    load()
    // One board: any change may be one of this chat's items.
    const off = api.todos.onChanged(() => load())
    return () => {
      live = false
      off()
    }
  }, [chatId, connected, attempt])
  const bump = useCallback((): void => setAttempt((n) => n + 1), [])
  const retry = useCallback((): void => {
    setFailedFor(null) // back to Loading… while it runs
    bump()
  }, [bump])
  return {
    items: got !== null && got.chatId === chatId ? got.items : null,
    failed: chatId !== null && failedFor === chatId,
    retry,
    refresh: bump
  }
}
