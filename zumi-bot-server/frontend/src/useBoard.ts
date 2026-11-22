import { useCallback, useEffect, useState } from 'react'
import type { TodoBoard } from '@zumibot/shared/todos'
import { api } from './api'

const DEBOUNCE_MS = 300

/**
 * The task board: every open item and the newest done ones, for the board page, the rail badge and the Inbox's card
 * questions. Fetched when the socket connects and after any `todos:changed` (debounced, trailing: a turn can change many
 * items at once). null until the first answer; a failed fetch keeps the last board, and the next event or reconnect tries
 * again. `refresh` fetches now (after a change made here).
 */
export function useBoard(connected: boolean): { board: TodoBoard | null; refresh: () => void } {
  const [board, setBoard] = useState<TodoBoard | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!connected) return
    let live = true
    let seq = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = (): void => {
      const mine = ++seq // a slow older answer must not overwrite a newer one
      api.todos.board().then(
        (r) => {
          if (live && mine === seq) setBoard(r)
        },
        () => {
          /* keep what is shown */
        }
      )
    }
    load()
    const off = api.todos.onChanged(() => {
      clearTimeout(timer)
      timer = setTimeout(load, DEBOUNCE_MS)
    })
    return () => {
      live = false
      clearTimeout(timer)
      off()
    }
  }, [connected, attempt])
  const refresh = useCallback((): void => setAttempt((n) => n + 1), [])
  return { board, refresh }
}
