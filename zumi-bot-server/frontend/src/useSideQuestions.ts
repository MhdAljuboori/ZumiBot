import { useCallback, useEffect, useState } from 'react'
import type { SideQuestion } from '@zumibot/shared/btw'
import { api } from './api'
import { upsertSide } from './state/sideQuestions'

export function useSideQuestions(chatId: string | null, connected: boolean): { list: SideQuestion[]; failed: boolean; retry(): void } {
  const [got, setGot] = useState<{ chatId: string; list: SideQuestion[] } | null>(null)
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (chatId === null || !connected) return
    let live = true
    let loading = true
    const changed = new Map<string, SideQuestion>()
    // Subscribe first; pushes during the snapshot request must win over its older entries.
    const off = api.btw.onChanged((p) => {
      if (!live || p.chatId !== chatId) return
      if (loading) changed.set(p.entry.id, p.entry)
      setGot((prev) => ({ chatId, list: upsertSide(prev?.chatId === chatId ? prev.list : [], p.entry) }))
    })
    api.btw.list(chatId).then(
      (list) => {
        if (!live) return
        loading = false
        for (const entry of changed.values()) list = upsertSide(list, entry)
        setGot({ chatId, list })
        setFailedFor(null)
      },
      () => {
        if (!live) return
        loading = false
        setFailedFor(chatId)
      }
    )
    return () => {
      live = false
      off()
    }
  }, [chatId, connected, attempt])
  const retry = useCallback(() => {
    setFailedFor(null)
    setAttempt((n) => n + 1)
  }, [])
  return { list: got?.chatId === chatId ? got.list : [], failed: chatId !== null && failedFor === chatId, retry }
}
