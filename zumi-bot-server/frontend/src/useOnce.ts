import { useCallback, useRef, useState } from 'react'

/**
 * Runs an action once per key until it settles, so a double click can't send two requests. `busy` lists the keys in
 * flight (to disable their buttons); the ref answers at once, before React has drawn the disabled button.
 */
export function useOnce(): [busy: ReadonlySet<string>, once: (key: string, run: () => Promise<void>) => void] {
  const live = useRef(new Set<string>())
  const [busy, setBusy] = useState<ReadonlySet<string>>(live.current)
  const once = useCallback((key: string, run: () => Promise<void>): void => {
    if (live.current.has(key)) return
    live.current.add(key)
    setBusy(new Set(live.current))
    void run().finally(() => {
      live.current.delete(key)
      setBusy(new Set(live.current))
    })
  }, [])
  return [busy, once]
}
