import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { DesktopTarget } from '@zumibot/shared/desktop'
import { api } from './api'
import { createDesktopClient, type DesktopClient, type RfbChannel } from './net/desktop'
import { redirectToLogin } from './net/signedOut'
import { initialDesktopView, mustRelease, reduceDesktopView, type DesktopViewEvent } from './state/desktopView'
import { errorMessage } from './errors'

export type AgentDesktop = ReturnType<typeof useAgentDesktop>
export const AgentDesktopContext = createContext<AgentDesktop | null>(null)
export const useDesktop = (): AgentDesktop | null => useContext(AgentDesktopContext)
/** Show on desktop (with the point to mark) or Open Desktop on an approval card: App knows the chat on screen and brings the desktop into the panel. */
export const DesktopShowContext = createContext<((agent: string | undefined, point: { x: number; y: number } | null) => void) | null>(null)

/** One RFB leg for the panel's noVNC. `seq` is new on every leg, even when one closes and the next opens within a render. */
export interface DesktopLeg {
  seq: number
  channel: RfbChannel
}

const STOPPED = 'The desktop view stopped. Retry to reconnect.'
const sameTarget = (a: DesktopTarget, b: DesktopTarget | null): boolean =>
  !!b && a.agent === b.agent && a.chatId === b.chatId && a.requestId === b.requestId

/** Owns the only desktop viewer. Mounting never connects; a view streams only while the page and a panel show it. */
export function useAgentDesktop(scope: string) {
  const [state, setState] = useState(initialDesktopView)
  const stateRef = useRef(state)
  const [leg, setLeg] = useState<DesktopLeg | null>(null)
  const legRef = useRef<DesktopLeg | null>(null)
  const client = useRef<DesktopClient | null>(null)
  const views = useRef(0) // panels on screen that show the picture
  const request = useRef(0) // bumped by every watch and unwatch: an outcome (a refusal, a failed takeover) from before is stale
  const online = useRef(false)
  const resume = useRef(false)
  const seq = useRef(0)
  const mounted = useRef(true)
  const dispatch = (event: DesktopViewEvent): void => {
    const next = reduceDesktopView(stateRef.current, event)
    stateRef.current = next
    if (mounted.current) setState(next)
  }
  const showLeg = (next: DesktopLeg | null): void => {
    legRef.current = next
    if (mounted.current) setLeg(next)
  }
  const wanted = (): DesktopTarget | null => {
    const s = stateRef.current
    return s.open && s.visible && views.current > 0 ? s.target : null
  }
  // A new or ended watch is a new viewer at the server, which never holds control: the switch goes off at once.
  const letGo = (): void => {
    if (stateRef.current.control || stateRef.current.controlPending) dispatch({ type: 'controlReleased' })
  }
  const subscribe = (target: DesktopTarget): void => {
    const n = ++request.current
    letGo()
    void client.current?.watch(target).catch((error) => {
      // A lost socket says so itself, and the status already explains an unavailable desktop.
      if (n !== request.current || !wanted() || !online.current || stateRef.current.status?.state === 'unavailable') return
      const message = errorMessage(error)
      // A refused watch does not say why: ask, so "off" and "unavailable" read as such instead of a bare refusal.
      api.desktops.status(target.agent).then(
        (status) => {
          if (n === request.current)
            dispatch(
              status.state === 'off' || status.state === 'unavailable' ? { type: 'status', status } : { type: 'error', error: message }
            )
        },
        () => {
          if (n === request.current) dispatch({ type: 'error', error: message })
        }
      )
    })
  }
  const unwatch = (): void => {
    request.current++
    letGo()
    client.current?.unwatch()
  }
  /** Watch exactly what is wanted now. Called on every edge (open, close, visibility, a panel coming or going, reconnect). */
  const sync = (): void => {
    const c = client.current
    if (!c) return
    const want = wanted(),
      have = c.watching()
    if (want && !sameTarget(want, have)) subscribe(want)
    else if (!want && have) unwatch()
  }
  useEffect(() => {
    mounted.current = true
    const c = createDesktopClient({
      url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/desktop`,
      onSignedOut: () => redirectToLogin(),
      onConnection: (connected) => {
        online.current = connected
        if (!connected) {
          resume.current = wanted() !== null
          if (stateRef.current.open) dispatch({ type: 'disconnect' })
        } else if (resume.current) {
          resume.current = false
          sync()
        }
      }
    })
    client.current = c
    const offStatus = c.onStatus((status) => {
      if (!status) {
        if (wanted()) dispatch({ type: 'error', error: STOPPED })
        return
      }
      dispatch({ type: 'status', status })
      if (mustRelease(stateRef.current, status)) void c.takeControl(false)
    })
    const offRfb = c.onRfb((rfb, generation) => {
      const channel = rfb === 'open' ? c.channel() : null
      showLeg(channel ? { seq: ++seq.current, channel } : null)
      dispatch({ type: 'rfb', state: rfb, generation })
    })
    const visible = (): void => {
      const show = document.visibilityState !== 'hidden'
      if (show === stateRef.current.visible) return
      dispatch({ type: 'visible', visible: show })
      if (!show) resume.current = false
      sync()
    }
    visible()
    document.addEventListener('visibilitychange', visible)
    return () => {
      mounted.current = false
      document.removeEventListener('visibilitychange', visible)
      offStatus()
      offRfb()
      c.close()
      client.current = null
      legRef.current = null
    }
  }, [])
  const close = (): void => {
    resume.current = false
    dispatch({ type: 'close' })
    unwatch()
    showLeg(null)
  }
  useEffect(() => {
    close()
  }, [scope])
  return {
    state,
    leg,
    /** A panel showing the view; the returned function is its unmount. Settled after the render, so a panel moving between slots does not restart the stream. */
    attach: useCallback((): (() => void) => {
      views.current++
      queueMicrotask(sync)
      return () => {
        views.current--
        queueMicrotask(sync)
      }
    }, []),
    open(target: DesktopTarget, marker?: { x: number; y: number } | null) {
      resume.current = false
      dispatch({ type: 'open', target, marker: marker ?? null })
      // Reopening the same view starts over too: a fresh watch brings fresh statuses, with control off.
      if (wanted()) subscribe(target)
      else if (client.current?.watching()) unwatch()
    },
    close,
    retry() {
      const want = wanted()
      if (want) subscribe(want)
    },
    /** noVNC gave up on its leg (a protocol failure); a leg replaced meanwhile is not a failure. */
    failed(legSeq: number, error = STOPPED) {
      if (legRef.current?.seq === legSeq && wanted()) dispatch({ type: 'error', error })
    },
    async takeControl(on: boolean) {
      if (!on) {
        dispatch({ type: 'controlReleased' })
        await client.current?.takeControl(false)
        return
      }
      dispatch({ type: 'controlRequested' })
      const n = request.current
      try {
        await client.current?.takeControl(true)
      } catch (error) {
        if (n === request.current && stateRef.current.controlPending) dispatch({ type: 'error', error: errorMessage(error) })
      }
    },
    /** A handoff card's I'm done or Cancel. Needs no open view: the socket's answer request carries the card's own target. */
    async answer(target: DesktopTarget, decision: 'done' | 'cancel') {
      if (!target.requestId || !target.chatId || !client.current) throw new Error('Desktop request is unavailable')
      await client.current.answer(target, target.requestId, decision)
      if (stateRef.current.target?.requestId === target.requestId) close()
    },
    /** After Clear desktop data: a view of that agent's old desktop has nothing left to show. */
    forget(agent: string) {
      if (stateRef.current.target?.agent === agent) close()
    }
  }
}
