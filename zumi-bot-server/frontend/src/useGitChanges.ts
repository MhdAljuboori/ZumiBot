import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMeta, GitChanges, GitDiffScope } from '@zumibot/shared/types'
import { api } from './api'
import { errorMessage } from './errors'
import { shouldRefetchGit } from './state/gitStatus'

export interface GitChangesState {
  /** undefined before the first answer; null when the chat's folder is not in a repo (or its worktree folder is gone). */
  changes: GitChanges | null | undefined
  error: string | null
  loading: boolean
  /** Goes up on every answer, so the preview reloads its diff too. */
  version: number
  refresh: () => void
}

/**
 * The Changes panel's list: fetched when the panel opens, when the scope switches, when a turn ends, when the worktree
 * folder is removed or added back, on window focus (the user may commit in a terminal) and on Refresh. The last list
 * stays shown while a new one loads.
 */
export function useGitChanges(chat: ChatMeta, scope: GitDiffScope = 'uncommitted'): GitChangesState {
  const [state, setState] = useState<{ changes: GitChanges | null | undefined; error: string | null; version: number }>({
    changes: undefined,
    error: null,
    version: 0
  })
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const prev = useRef<{ chatId: string; inFlight: boolean } | null>(null)
  const chatId = chat.id

  const load = useCallback((): void => {
    const mine = ++seq.current // an older answer must not overwrite a newer one
    setLoading(true)
    api.chats.gitChanges(chatId, scope).then(
      (changes) => {
        if (mine !== seq.current) return
        setState((s) => ({ changes, error: null, version: s.version + 1 }))
        setLoading(false)
      },
      (e: unknown) => {
        if (mine !== seq.current) return
        setState((s) => ({ ...s, error: errorMessage(e) }))
        setLoading(false)
      }
    )
  }, [chatId, scope])

  useEffect(() => {
    const next = { chatId, inFlight: chat.inFlight }
    if (shouldRefetchGit(prev.current, next)) load()
    prev.current = next
  }, [chatId, chat.inFlight, load])

  const removed = chat.worktree?.removed === true
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    load()
  }, [removed, scope]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [load])

  return { ...state, loading, refresh: load }
}
