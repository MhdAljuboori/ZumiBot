import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import {
  fitBrowserViewport,
  sameBrowserViewport,
  type BrowserCommand,
  type BrowserFrame,
  type BrowserInput,
  type BrowserStatus,
  type BrowserTarget,
  type BrowserViewport
} from '@zumibot/shared/browser'
import { createBrowserClient, type BrowserClient } from './net/browser'
import { redirectToLogin } from './net/signedOut'
import { createBrowserFrames, initialBrowserView, reduceBrowserView, safeReopenOrigin, type BrowserViewEvent } from './state/browserView'
import { errorMessage } from './errors'

export type BrowserInteraction = BrowserInput extends infer I ? (I extends BrowserInput ? Omit<I, 'generation' | 'tabId'> : never) : never
export type AgentBrowser = ReturnType<typeof useAgentBrowser>
export const AgentBrowserContext = createContext<AgentBrowser | null>(null)
export const useBrowser = (): AgentBrowser | null => useContext(AgentBrowserContext)
const shortcutKey = (profileId: string): string => `zumibot.browser.origin:${location.origin}:${profileId}`
const loadOrigin = (profileId: string): string | null => {
  try {
    return safeReopenOrigin(localStorage.getItem(shortcutKey(profileId)) ?? '')
  } catch {
    return null
  }
}

/** Owns the only viewer/client. Mounting the hook never connects or subscribes. */
export function useAgentBrowser(scope: string) {
  const [state, setState] = useState(initialBrowserView)
  const stateRef = useRef(state)
  const client = useRef<BrowserClient | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const image = useRef<{ bitmap: ImageBitmap; frame: BrowserFrame } | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [reopenOrigin, setReopenOrigin] = useState<string | null>(null)
  const resume = useRef(false)
  const subscription = useRef(0)
  // The panel's surface, and what this watch last told the server (a new watch is a new server viewer).
  const surface = useRef<BrowserViewport | null>(null)
  const sized = useRef<{ watch: number; viewport: BrowserViewport } | null>(null)
  const mounted = useRef(true)
  const dispatch = (event: BrowserViewEvent): void => {
    const next = reduceBrowserView(stateRef.current, event)
    stateRef.current = next
    if (mounted.current) setState(next)
  }
  const paint = (): void => {
    const el = canvas.current,
      current = image.current
    if (!el) return
    if (!current) {
      el.getContext('2d')?.clearRect(0, 0, el.width, el.height)
      return
    }
    // Device pixels: a HiDPI frame is larger than its CSS size, and is shown 1:1 when it fits the surface.
    el.width = current.bitmap.width
    el.height = current.bitmap.height
    el.getContext('2d')?.drawImage(current.bitmap, 0, 0)
  }
  const frames = useRef<ReturnType<typeof createBrowserFrames<ImageBitmap>> | null>(null)
  if (!frames.current)
    frames.current = createBrowserFrames<ImageBitmap>({
      decode: (f) => createImageBitmap(new Blob([new Uint8Array(f.jpeg)], { type: 'image/jpeg' })),
      show: (bitmap, frame) => {
        image.current = bitmap && frame ? { bitmap, frame } : null
        paint()
        if (mounted.current) setSize(frame && bitmap ? { width: frame.width, height: frame.height } : null)
      }
    })
  const sendViewport = (): void => {
    const s = stateRef.current,
      wanted = surface.current,
      watch = subscription.current
    if (!wanted || !s.open || !s.visible || s.status?.state !== 'ready') return
    if (sized.current?.watch === watch && sameBrowserViewport(sized.current.viewport, wanted)) return
    sized.current = { watch, viewport: wanted }
    // A failure is retried by the next ready status or resize.
    void client.current?.viewport(wanted).catch(() => {
      if (sized.current?.watch === watch) sized.current = null
    })
  }
  const showStatus = (status: BrowserStatus | null): void => {
    const before = stateRef.current
    frames.current!.page(status)
    if (!status) {
      dispatch({ type: 'disconnect' })
      return
    }
    const changed = before.status && before.status.generation !== status.generation
    dispatch({ type: 'status', status })
    sendViewport()
    // A replaced page must release server ownership too; local revocation is immediate.
    if (changed && (before.control || before.controlPending) && status.state === 'ready')
      void client.current?.takeControl(false).catch(() => {})
    const tab = status.tabs.find((t) => t.id === status.activeTabId)
    const origin = tab ? safeReopenOrigin(tab.url) : null
    try {
      if (origin) localStorage.setItem(shortcutKey(status.profileId), origin)
    } catch {
      /* Storage is optional. */
    }
    setReopenOrigin(origin ?? loadOrigin(status.profileId))
  }
  const subscribe = (target: BrowserTarget): void => {
    const request = ++subscription.current
    void client.current!.watch(target).catch((error) => {
      if (request === subscription.current && stateRef.current.open && stateRef.current.visible)
        dispatch({ type: 'error', error: errorMessage(error) })
    })
  }
  useEffect(() => {
    mounted.current = true
    const c = createBrowserClient({
      url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/browser`,
      onStatus: showStatus,
      onFrame: (frame) => frames.current!.push(frame),
      onSignedOut: () => redirectToLogin(),
      onConnection: (connected) => {
        if (!connected) {
          resume.current = stateRef.current.open && stateRef.current.visible
          if (resume.current) dispatch({ type: 'error', error: 'Browser connection lost. Reconnecting…' })
        } else if (resume.current) {
          resume.current = false
          const s = stateRef.current
          if (s.open && s.visible && s.target) subscribe(s.target)
        }
      }
    })
    client.current = c
    const visible = (): void => {
      const show = document.visibilityState !== 'hidden'
      if (show === stateRef.current.visible) return
      dispatch({ type: 'visible', visible: show })
      if (!show) {
        resume.current = false
        c.unwatch()
        frames.current!.clear()
      } else if (stateRef.current.open && stateRef.current.target) subscribe(stateRef.current.target)
    }
    visible()
    document.addEventListener('visibilitychange', visible)
    return () => {
      mounted.current = false
      document.removeEventListener('visibilitychange', visible)
      c.close()
      frames.current!.clear()
      client.current = null
    }
  }, [])
  const close = (): void => {
    subscription.current++
    resume.current = false
    dispatch({ type: 'close' })
    client.current?.unwatch()
    frames.current!.clear()
    setReopenOrigin(null)
  }
  useEffect(() => {
    close()
  }, [scope])
  const failedInteraction = (error: unknown, epoch: number): void => {
    if (stateRef.current.epoch !== epoch) return
    dispatch({ type: 'error', error: errorMessage(error) })
    void client.current?.takeControl(false).catch(() => {})
  }
  return {
    state,
    size,
    reopenOrigin,
    canvasRef: useCallback((element: HTMLCanvasElement | null) => {
      canvas.current = element
      paint()
    }, []),
    open(target: BrowserTarget) {
      resume.current = false
      frames.current!.clear()
      dispatch({ type: 'open', target })
      setReopenOrigin(null)
      if (stateRef.current.visible) subscribe(target)
    },
    close,
    expand(expanded: boolean) {
      dispatch({ type: 'expanded', expanded })
    },
    /** The surface's CSS size and the screen's pixel density; the page is resized to fit it. */
    resize(width: number, height: number, density: number) {
      surface.current = fitBrowserViewport(width, height, density)
      sendViewport()
    },
    retry() {
      const s = stateRef.current
      if (s.target && s.open && s.visible) {
        dispatch({ type: 'release' })
        subscribe(s.target)
      }
    },
    async takeControl(on: boolean) {
      if (!on) {
        dispatch({ type: 'release' })
        const epoch = stateRef.current.epoch
        try {
          await client.current?.takeControl(false)
        } catch (error) {
          failedInteraction(error, epoch)
        }
        return
      }
      dispatch({ type: 'controlPending' })
      const epoch = stateRef.current.epoch
      try {
        await client.current?.takeControl(true)
        dispatch({ type: 'controlAck', epoch })
      } catch (error) {
        if (epoch === stateRef.current.epoch) dispatch({ type: 'error', error: errorMessage(error) })
      }
    },
    input(input: BrowserInteraction) {
      const s = stateRef.current
      if (!s.control || !s.visible || !s.open || !s.status?.activeTabId) return
      void client.current
        ?.input({ ...input, generation: s.status.generation, tabId: s.status.activeTabId } as BrowserInput)
        .catch((error) => failedInteraction(error, s.epoch))
    },
    async uploadFiles(files: File[]) {
      const s = stateRef.current,
        status = s.status
      if (!s.control || !s.open || !s.visible || status?.control !== 'you' || !status.uploadToken || !status.activeTabId)
        throw new Error('Take control to upload files')
      if (files.length > 10 || files.some((f) => f.size > 25 * 1024 * 1024)) throw new Error('Choose up to 10 files, at most 25 MB each')
      const current = () => {
        const now = stateRef.current
        return (
          now.epoch === s.epoch &&
          now.control &&
          now.status?.generation === status.generation &&
          now.status.activeTabId === status.activeTabId
        )
      }
      const ids: string[] = []
      for (const file of files) {
        if (!current()) throw new Error('Browser page changed; choose files again')
        const response = await fetch('/api/browser/files/stage', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'X-File-Name': encodeURIComponent(file.name),
            'X-Browser-Upload': status.uploadToken,
            'X-Browser-Generation': status.generation,
            'X-Browser-Tab': status.activeTabId
          },
          body: file
        })
        if (!response.ok) throw new Error('Browser upload denied or file limit reached')
        const staged = (await response.json()) as { id: string }
        if (typeof staged.id !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(staged.id)) throw new Error('Browser upload failed')
        ids.push(staged.id)
      }
      if (!current()) throw new Error('Browser page changed; choose files again')
      await client.current!.navigate({ op: 'chooseFiles', fileIds: ids })
    },
    navigate(command: BrowserCommand) {
      const s = stateRef.current
      if (!s.control) return
      void client.current?.navigate(command).catch((error) => failedInteraction(error, s.epoch))
    },
    async answer(target: BrowserTarget, decision: 'done' | 'cancel') {
      if (!target.requestId) throw new Error('Browser request is unavailable')
      if (stateRef.current.target?.agent === target.agent) dispatch({ type: 'release' })
      await client.current!.answer(target.requestId, decision, target)
      if (stateRef.current.target?.requestId === target.requestId) close()
    },
    forget(agent: string) {
      const s = stateRef.current
      if (s.target?.agent === agent) {
        if (s.status)
          try {
            localStorage.removeItem(shortcutKey(s.status.profileId))
          } catch {
            /* Storage is optional. */
          }
        close()
      }
    }
  }
}
