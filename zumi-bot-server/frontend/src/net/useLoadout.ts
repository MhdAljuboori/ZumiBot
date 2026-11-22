import { useCallback, useEffect, useRef, useState } from 'react'
import type { DirListing } from '@zumibot/shared/types'
import type { Loadout } from '@zumibot/shared/extensions'
import { api, rpc } from '../api'
import { errorMessage } from '../errors'
import { loadoutFetches } from '../state/loadoutFetch'
import { useOnReconnect } from '../useConnected'

export interface LoadoutState {
  loadout: Loadout | null
  /** A probe is out: the first one, a Refresh or a change made elsewhere. */
  loading: boolean
  /** The whole load failed (a fixed sentence); a section the CLI could not report is in `loadout.errors` instead. */
  error: string | null
  /** Asks the CLI again, bypassing the server's cache (the Refresh button). */
  refresh: () => void
}

/**
 * What `folder` (or `agent` in it) loads, from the server's probe. Fetched when the folder or agent changes and again after every
 * `extensions:changed` (a write from any tab; the server already dropped its cache). An answer older than one already shown is
 * dropped (loadoutFetches), a failed refetch keeps the list that is shown, and another folder or agent starts from nothing.
 * An empty folder fetches nothing: the page is still finding the home folder.
 */
export function useLoadout(folder: string, agent: string | null): LoadoutState {
  const [loadout, setLoadout] = useState<Loadout | null>(null)
  const [loading, setLoading] = useState(folder !== '')
  const [error, setError] = useState<string | null>(null)
  const order = useRef(loadoutFetches())
  const alive = useRef(true)
  const keyRef = useRef({ folder, agent })
  keyRef.current = { folder, agent }

  const load = useCallback((force: boolean): void => {
    const { folder: f, agent: a } = keyRef.current
    if (f === '') return
    const mine = order.current.start()
    setLoading(true)
    // Every settled request recomputes the loading flag, a dropped one included (loadoutFetches.settle).
    api.extensions.loadout(f, a, force).then(
      (l) => {
        if (!alive.current) return
        const r = order.current.settle(mine, 'land')
        if (r.show) {
          setLoadout(l)
          setError(null)
        }
        setLoading(r.loading)
      },
      (e: unknown) => {
        if (!alive.current) return
        const r = order.current.settle(mine, 'fail')
        if (r.show) setError(errorMessage(e))
        setLoading(r.loading)
      }
    )
  }, [])

  useEffect(() => {
    alive.current = true
    // Another folder or agent: nothing of the old one may show, and its probe's answer is dropped.
    order.current.reset()
    setLoadout(null)
    setError(null)
    setLoading(folder !== '')
    load(false)
    const off = api.extensions.onChanged(() => load(false))
    return () => {
      alive.current = false
      order.current.reset()
      off()
    }
  }, [folder, agent, load])

  // A probe cut off by a drop, or an extensions:changed missed while the socket was down: asked again once it is back.
  useOnReconnect(() => load(false))

  const refresh = useCallback(() => load(true), [load])
  return { loadout, loading, error, refresh }
}

let home: Promise<string> | null = null

/** The server's home folder, where the page starts: the first folder the folder browser lists. Asked once; a failure is not kept. */
export function homeFolder(): Promise<string> {
  home ??= (rpc.call('fs:listDirs', [null]) as Promise<DirListing>).then(
    (l) => l.path,
    (e: unknown) => {
      home = null
      throw e
    }
  )
  return home
}
