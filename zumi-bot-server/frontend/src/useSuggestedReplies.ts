import { useSyncExternalStore } from 'react'
import { api } from './api'

// One watcher per page, shared by every chat view: the switch as the server last said it, null until it has.
let on: boolean | null = null
let watching = false
const watchers = new Set<() => void>()
const quiet = (): void => {}

const changed = (): void => {
  for (const cb of [...watchers]) cb()
}

function watch(): void {
  if (watching) return
  watching = true
  // A change broadcast after a request was sent is newer than its answer.
  let asked = 0
  api.app.onSuggestedRepliesChanged((v) => {
    asked++
    on = v
    changed()
  })
  // Asked on every connect: a call while the socket is down fails, and a change broadcast while it was down is missed.
  api.connection.onStatus((c) => {
    if (c !== 'connected') return
    const mine = ++asked
    api.app.getSuggestedReplies().then((v) => {
      if (mine !== asked) return
      on = v
      changed()
    }, quiet)
  })
}

const subscribe = (cb: () => void): (() => void) => {
  watch()
  watchers.add(cb)
  return () => void watchers.delete(cb)
}

/** Whether suggested replies show; false until the server has said the switch is on. */
export function useSuggestedRepliesOn(): boolean {
  return useSyncExternalStore(subscribe, () => on === true)
}

/** The switch as the server last said it, null until it has: Settings follows a change made in any tab. */
export function useSuggestedReplies(): boolean | null {
  return useSyncExternalStore(subscribe, () => on)
}
