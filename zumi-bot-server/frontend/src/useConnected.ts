import { useEffect, useRef, useSyncExternalStore } from 'react'
import { api } from './api'

// One watcher for the page; onStatus answers at once with the current state, so `up` is right from the first read.
let up = false
let watching = false
const watchers = new Set<() => void>()

const subscribe = (cb: () => void): (() => void) => {
  if (!watching) {
    watching = true
    api.connection.onStatus((s) => {
      if ((s === 'connected') === up) return
      up = s === 'connected'
      for (const w of [...watchers]) w()
    })
  }
  watchers.add(cb)
  return () => void watchers.delete(cb)
}

/**
 * The socket is up. A page's load keyed on it waits for the socket and runs again after a reconnect: a call made while the
 * socket is down fails with NOT_CONNECTED, and a page that asked only on mount kept that error until it was opened again.
 */
export function useConnected(): boolean {
  return useSyncExternalStore(subscribe, () => up)
}

/**
 * Calls `fn` each time the socket comes back up after being down while this component was mounted, for a loader that runs
 * in an effect of its own (and clears its error when it lands). Not on mount: that load is the component's own.
 */
export function useOnReconnect(fn: () => void): void {
  const connected = useConnected()
  const was = useRef(connected)
  const latest = useRef(fn)
  latest.current = fn
  useEffect(() => {
    const before = was.current
    was.current = connected
    if (connected && !before) latest.current()
  }, [connected])
}
