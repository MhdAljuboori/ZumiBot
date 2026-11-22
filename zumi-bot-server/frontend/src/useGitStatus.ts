import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMeta, GitStatus } from '@zumibot/shared/types'
import { api } from './api'
import { shouldRefetchGit } from './state/gitStatus'

/**
 * The chat's branch and uncommitted count for its header chip: fetched when the chat opens, when its turn ends, when its
 * worktree folder is removed or added back, and on window focus (the user may commit in a terminal). null before the
 * first answer, for a chat outside a git repo, and when the call fails. `reload` reads it again (the Changes panel
 * calls it with each of its own answers, so the chip's count matches the list).
 */
export function useGitStatus(chat: ChatMeta | null): [GitStatus | null, () => void] {
  const [got, setGot] = useState<{ chatId: string; status: GitStatus | null } | null>(null)
  const seq = useRef(0)
  const prev = useRef<{ chatId: string; inFlight: boolean } | null>(null)
  const chatId = chat?.id ?? null
  const inFlight = chat?.inFlight ?? false
  const removed = chat?.worktree?.removed === true

  const load = useCallback((id: string): void => {
    const mine = ++seq.current // a slow answer for an earlier chat or an older fetch must not overwrite a newer one
    api.chats.gitStatus(id).then(
      (status) => {
        if (mine === seq.current) setGot({ chatId: id, status })
      },
      () => {
        if (mine === seq.current) setGot({ chatId: id, status: null })
      }
    )
  }, [])

  useEffect(() => {
    if (chatId === null) {
      prev.current = null
      return
    }
    const next = { chatId, inFlight }
    if (shouldRefetchGit(prev.current, next)) load(chatId)
    prev.current = next
  }, [chatId, inFlight, load])

  // Release or the next turn flips this without a turn ending here.
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (chatId !== null) load(chatId)
  }, [removed]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (chatId === null) return
    const onFocus = (): void => load(chatId)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [chatId, load])

  const reload = useCallback((): void => {
    if (chatId !== null) load(chatId)
  }, [chatId, load])
  return [got !== null && got.chatId === chatId ? got.status : null, reload]
}
