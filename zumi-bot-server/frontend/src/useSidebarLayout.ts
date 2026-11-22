import { useEffect, useState } from 'react'
import type { SidebarLayout } from '@zumibot/shared/sidebarLayout'
import { api } from './api'

/**
 * The sidebar layout the server keeps (null until it loads), reloaded on every connect and kept in step with the other
 * tabs. A save shows at once; until the layout has loaded there is nothing to build a save on, so none is sent.
 */
export function useSidebarLayout(quiet: (e: unknown) => void): { layout: SidebarLayout | null; save: (next: SidebarLayout) => void } {
  const [layout, setLayout] = useState<SidebarLayout | null>(null)
  // Built once: they only read refs, the api and `quiet` (stable in App).
  const [io] = useState(() => {
    let loaded = false
    // While this tab's saves are on their way, any other news is older than what it shows: the last answer settles it.
    let saving = 0
    const load = (): void => {
      api.sidebar.get().then((stored) => {
        if (saving > 0) return
        loaded = true
        setLayout(stored)
      }, quiet)
    }
    const save = (next: SidebarLayout): void => {
      if (!loaded) return
      setLayout(next)
      saving++
      api.sidebar.save(next).then(
        (stored) => {
          if (--saving === 0) setLayout(stored)
        },
        (e) => {
          if (--saving === 0) load()
          quiet(e)
        }
      )
    }
    const changed = (stored: SidebarLayout): void => {
      if (saving === 0 && loaded) setLayout(stored)
    }
    return { load, save, changed }
  })

  useEffect(() => {
    const offChanged = api.sidebar.onChanged(io.changed)
    const offStatus = api.connection.onStatus((s) => {
      if (s === 'connected') io.load()
    })
    return () => {
      offChanged()
      offStatus()
    }
  }, [io])

  return { layout, save: io.save }
}
